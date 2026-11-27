// NOVA AI Studio — NEXORA client authentication (Kaggle design v4,
// §3 D-2.3, §5.8).
//
// A SECOND canonical contract coexists with the Worker contract
// (api-server/auth.js, Rev 4.8 §8). The two are distinguished by key id
// / header prefix and must NEVER be mixed:
//   Worker: X-NOVA-API-SECRET + X-NOVA-SIGNATURE over
//     METHOD\nPATH\nTIMESTAMP(unix)\nNONCE(32hex)\nSHA256_HEX(BODY),
//     keyed by NOVA_SIGNING_SECRET.
//   NEXORA: X-NEXORA-Key-Id: nexora-v1 + Authorization: Bearer
//     NOVA_API_SECRET_NEXORA + X-NEXORA-Signature over
//     METHOD\nPATH\nSHA256_HEX(BODY)\nTIMESTAMP(ISO 8601)\nNONCE,
//     keyed by NOVA_SIGNING_SECRET_NEXORA.
//
// Verification order (mirrors verifyWorkerAuth, adapted to the NEXORA
// shape — the landed NEXORA client, nexora/gpu_jobs/signing.py, is the
// authority for the wire form):
//   (1) key id is exactly `nexora-v1`; client id is exactly
//       `nexora-service`; transport secret (Bearer) present, hash-compared
//       against a configured NEXORA API secret (current or previous,
//       rotation overlap), and not revoked; signing secrets configured
//       (a process without one authenticates nothing — fail closed);
//   (2) signature present and well-formed (64 hex), nonce present and
//       well-formed (32 hex — the SQLite nonce store requires it; a
//       non-32-hex nonce is refused here, before consume is called);
//   (3) timestamp parses as ISO 8601 and is within ±60 s of the API
//       clock. There is NO millisecond process-start rule here (that rule
//       belongs to the Worker's unix-second timestamps; NEXORA timestamps
//       are ISO strings and the ±60 s window is the contract);
//   (4) signature verifies against a configured NEXORA signing secret
//       (constant-time; a revoked signing secret is skipped — revocation
//       overrides the rotation overlap for both secrets, as in
//       verifyWorkerAuth step 4);
//   (5) nonce unseen — consumed ONLY now, after the signature verified,
//       by one atomic INSERT OR IGNORE in the SAME SqliteNonceStore the
//       Worker path uses (expiry = parsed timestamp + 360 s); a failed
//       request can never burn a nonce, and two concurrent consumers of
//       the same nonce admit exactly one.
// Any failure returns 401 { error: 'unauthorised' } with no detail at
// the HTTP layer (only the step number is logged). Origin is derived
// from the verified key id (`nexora`); a payload `origin` that disagrees
// is refused by the submit handler, not here.

import { createHash, randomBytes, timingSafeEqual as _timingSafeEqual } from 'node:crypto';

import { HMAC_TIMESTAMP_WINDOW_S } from './constants.js';
import { NONCE_VALIDITY_SECONDS } from './nonce-store.js';
import {
  sha256Hex,
  hmacSha256Hex,
  fingerprintOfSecret,
} from './auth.js';

export const NEXORA_KEY_ID = 'nexora-v1';
export const NEXORA_CLIENT_ID = 'nexora-service';
export const NEXORA_ORIGIN = 'nexora';

// JobId namespaces (Kaggle design v13 §3 D-2.3): UUIDv4, lowercase hex
// only — version digit 4, variant [89ab]. A key may submit only jobIds
// in its own namespace; anything outside it returns 400 invalid-job-id.
export const NEXORA_JOB_ID_RE = /^nexora:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const WORKER_JOB_ID_RE = /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Fullmatch, never `$`: JavaScript `$` matches before a trailing
// newline, so `nexora:<uuid>\n` would pass the regex alone. The
// namespaces have a fixed length (`nexora:` + 36, `worker:` + 36), so
// the length check closes the hole (design §3 D-2.3: "matched against
// the whole string (Python fullmatch, never match or $)").
export function isNexoraJobId(value) {
  return typeof value === 'string' && value.length === 43 && NEXORA_JOB_ID_RE.test(value);
}

export function isWorkerJobId(value) {
  return typeof value === 'string' && value.length === 43 && WORKER_JOB_ID_RE.test(value);
}

// Canonical JSON (Python json.dumps compatible for the values this
// contract carries: sorted keys, compact separators, UTF-8). Numbers
// serialise as JSON numbers; note that JavaScript cannot distinguish
// the float 1.0 from the integer 1, while Python's canonicalisation
// writes 1.0 as "1.0" — so a payload re-canonicalised here from parsed
// JSON is NOT guaranteed byte-identical to the client's canonical form
// when it carries integral floats (guidance 1.0). The §5.8 hash below
// therefore hashes the RAW REQUEST BODY as received (the client sends
// canonical JSON as the wire body — see client.py::_signed), never a
// re-canonicalisation. This function is kept for building request
// bodies in tests and for the commissioning hash (Worker-path bodies
// carry integers only).
export function canonicaliseJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicaliseJson(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicaliseJson(value[k])}`).join(',')}}`;
}

// The canonical-request-v1 string that gets signed (v4 §3 D-2.3 text
// order — identical to signing.py::build_canonical_request).
export function buildCanonicalRequest({ method, path, body, timestamp, nonce }) {
  return [method, path, sha256Hex(body ?? ''), timestamp, nonce].join('\n');
}

// HMAC-SHA-256 signature for a canonical request (signing.py::sign_request).
export function signNexoraRequest({ signingSecret, method, path, body, timestamp, nonce }) {
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    throw new Error('signNexoraRequest requires the NEXORA signing secret (NOVA_SIGNING_SECRET_NEXORA)');
  }
  return hmacSha256Hex(
    signingSecret,
    buildCanonicalRequest({ method, path, body, timestamp, nonce }),
  );
}

// The signed-request headers (signing.py::signing_headers). `body` is the
// exact wire bytes (a string; the client sends canonical JSON).
export function nexoraSigningHeaders({ signingSecret, apiSecret, method, path, body, timestamp, nonce }) {
  if (typeof apiSecret !== 'string' || apiSecret.length === 0) {
    throw new Error('nexoraSigningHeaders requires the NEXORA API secret (NOVA_API_SECRET_NEXORA)');
  }
  return {
    'X-NEXORA-Key-Id': NEXORA_KEY_ID,
    'X-NEXORA-Client-Id': NEXORA_CLIENT_ID,
    'X-NEXORA-Timestamp': timestamp,
    'X-NEXORA-Nonce': nonce,
    'X-NEXORA-Signature': signNexoraRequest({ signingSecret, method, path, body, timestamp, nonce }),
    Authorization: `Bearer ${apiSecret}`,
  };
}

// The §5.8 canonical request hash: SHA-256 over the canonicalised submit
// payload INCLUDING attestation_id (v4 rule — do NOT apply the v5
// narrowing). The client sends canonical JSON as the wire body, so the
// hash of the raw request body IS the canonical request hash — computed
// here from the exact bytes received, never from a re-canonicalisation
// (see the canonicaliseJson note above).
export function canonicalRequestHash(bodyText) {
  return sha256Hex(bodyText ?? '');
}

// SHA-256 hex of raw bytes (staging fetch verification, §5.7).
export function sha256HexBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Sign a capacity response body for a NEXORA request
// (signing.py::sign_response_body): HMAC-SHA-256 over
// `sha256Hex(body) + "\n" + timestamp + "\n" + nonce`, keyed by the
// NEXORA signing secret. Timestamp is ISO 8601; nonce echoes the
// REQUEST's nonce.
export function signNexoraResponse({ signingSecret, bodyText, timestamp, nonce }) {
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    throw new Error('signNexoraResponse requires the NEXORA signing secret (NOVA_SIGNING_SECRET_NEXORA)');
  }
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('signNexoraResponse requires an ISO 8601 timestamp');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('signNexoraResponse requires the request nonce to echo');
  }
  const canonical = [sha256Hex(bodyText ?? ''), timestamp, nonce].join('\n');
  return hmacSha256Hex(signingSecret, canonical);
}

// Verify a NEXORA-form capacity response signature (the check the NEXORA
// client performs in _verify_capacity_response). Used by tests; never
// throws on a bad signature (returns false).
export function verifyNexoraResponseSignature({ signingSecret, bodyText, timestamp, nonce, signature }) {
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature ?? '')) return false;
  let expected;
  try {
    expected = signNexoraResponse({ signingSecret, bodyText, timestamp, nonce });
  } catch {
    return false;
  }
  return constantTimeHexEqual(expected, signature);
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let ba;
  let bb;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ba.length !== bb.length) return false;
  return _timingSafeEqual(ba, bb);
}

function isRevoked(apiState, fingerprint) {
  apiState.reloadIfChanged();
  return (apiState.state.revocations || []).some(
    (r) => r.fingerprint === fingerprint,
  );
}

// ISO 8601 timestamps only: the shape the NEXORA client sends
// (datetime.isoformat(), e.g. 2026-11-27T16:00:00+00:00). A bare unix
// number is NOT an ISO timestamp and is refused — the two contracts
// must never be confused.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseNexoraTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Verify an incoming NEXORA call. `req` is a Node http IncomingMessage
// (headers lower-cased by Node). `auth` is
// { apiSecrets, signingSecrets, apiState, nonceStore }:
//   apiSecrets     — [current, previous?] NOVA_API_SECRET_NEXORA values
//                    (empty strings filtered);
//   signingSecrets — [current, previous?] NOVA_SIGNING_SECRET_NEXORA
//                    values (empty strings filtered);
//   apiState       — an ApiStateStore (revocation record only);
//   nonceStore     — a SqliteNonceStore (REQUIRED; no JSON fallback).
// `opts.nowMs` injects the clock for tests.
// Returns { ok: true, keyId, clientId } or { ok: false, step }.
export function verifyNexoraAuth(req, method, path, bodyText, auth, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const { apiState, nonceStore } = auth || {};
  if (!apiState || typeof apiState.reloadIfChanged !== 'function') {
    throw new Error('verifyNexoraAuth requires apiState (revocation record)');
  }
  if (!nonceStore || typeof nonceStore.consume !== 'function') {
    throw new Error('verifyNexoraAuth requires a SqliteNonceStore');
  }
  const apiConfigured = (auth.apiSecrets || [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  const signingConfigured = (auth.signingSecrets || [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  // (1) A process without the per-client secrets authenticates nothing.
  if (apiConfigured.length === 0 || signingConfigured.length === 0) {
    return { ok: false, step: 1 };
  }

  // (1) key id exactly `nexora-v1`; client id exactly `nexora-service`.
  const keyId = req.headers['x-nexora-key-id'] || '';
  if (keyId !== NEXORA_KEY_ID) return { ok: false, step: 1 };
  const clientId = req.headers['x-nexora-client-id'] || '';
  if (clientId !== NEXORA_CLIENT_ID) return { ok: false, step: 1 };

  // (1) transport secret: `Authorization: Bearer <secret>`, hash-compared.
  const authorization = req.headers.authorization || '';
  const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (bearer.length === 0) return { ok: false, step: 1 };
  let presentedMatches = false;
  for (const s of apiConfigured) {
    if (constantTimeHexEqual(sha256Hex(bearer), sha256Hex(s))) {
      presentedMatches = true;
    }
  }
  if (!presentedMatches) return { ok: false, step: 1 };

  // (1b) revocation overrides the rotation overlap.
  if (isRevoked(apiState, fingerprintOfSecret(bearer))) {
    return { ok: false, step: 1 };
  }

  // (2) signature + nonce well-formed. The nonce must be 32 hex: the
  // SQLite nonce store requires it, so a non-32-hex nonce is refused
  // here, before consume is ever called. (The client sends 32 hex in
  // production; the design's "free-form" is not an invitation to accept
  // a nonce the store cannot record.)
  const signature = req.headers['x-nexora-signature'] || '';
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, step: 2 };
  const nonce = req.headers['x-nexora-nonce'] || '';
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, step: 2 };

  // (3) timestamp parses as ISO 8601 and is within ±60 s of the API clock.
  const timestamp = req.headers['x-nexora-timestamp'] || '';
  const timestampMs = parseNexoraTimestamp(timestamp);
  if (timestampMs === null) return { ok: false, step: 3 };
  if (Math.abs(nowMs - timestampMs) > HMAC_TIMESTAMP_WINDOW_S * 1000) {
    return { ok: false, step: 3 };
  }

  // (4) signature verifies against a configured NEXORA signing secret
  // (constant-time). A revoked signing secret is skipped.
  const canonical = buildCanonicalRequest({
    method, path, body: bodyText, timestamp, nonce,
  });
  let signatureOk = false;
  for (const signingSecret of signingConfigured) {
    if (isRevoked(apiState, fingerprintOfSecret(signingSecret))) continue;
    const expected = hmacSha256Hex(signingSecret, canonical);
    if (constantTimeHexEqual(expected, signature)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return { ok: false, step: 4 };

  // (5) nonce unseen — consumed ONLY now, after the signature verified,
  // by one atomic INSERT OR IGNORE in the SQLite nonce store, under this
  // client's key id (v13 §3 D-2.3: (key_id, nonce) composite — the same
  // nonce under a different key id is a different row). A failed
  // request can never burn a nonce; two concurrent consumers of the
  // same nonce admit exactly one.
  const expiryMs = timestampMs + NONCE_VALIDITY_SECONDS * 1000;
  if (!nonceStore.consume(NEXORA_KEY_ID, nonce, expiryMs)) return { ok: false, step: 5 };

  return { ok: true, keyId, clientId };
}

// Fresh timestamp + nonce for an outgoing NEXORA-signed call (the staging
// fetch). The caller signs with nexoraSigningHeaders.
export function freshNexoraNonce() {
  return randomBytes(16).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}
