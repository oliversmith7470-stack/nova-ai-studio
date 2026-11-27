// NOVA AI Studio — Phase 3 API process: HMAC signing / verification.
//
// TWO-SECRET request authentication (Rev 4.8 §8 — the intended scheme,
// implemented here; the earlier single-secret mechanism is NOT a
// conforming implementation and must not be described as one):
//   NOVA_API_SECRET — authenticates the TRANSPORT. Presented in the
//     X-NOVA-API-SECRET header (current or previous, 1-hour rotation
//     overlap); compared by SHA-256 hash so the comparison is
//     constant-time; a fingerprint present in the revocation record
//     rejects the secret even inside the overlap window (revocation
//     overrides overlap).
//   NOVA_SIGNING_SECRET — signs the CANONICAL REQUEST. The HMAC-SHA-256
//     is computed over METHOD + "\n" + PATH (incl. query) + "\n" +
//     TIMESTAMP (unix seconds) + "\n" + NONCE (128-bit hex) + "\n" +
//     SHA256_HEX(BODY), keyed by the SIGNING secret (current or previous
//     during rotation). The transport secret NEVER signs anything.
// A single compromised secret cannot forge a job: the transport secret
// alone cannot produce a valid signature, and the signing secret alone
// cannot pass step 1 (it is not a transport secret). Full compromise of
// BOTH secrets + the signing code path CAN forge a job — that is the
// design's honest threat model (Rev 4.8 §8 S4), not a defect to hide.
//
// Verification order (Rev 4.8 §8, Worker→API direction; the Worker side
// mirrors it in _worker.js verifyInternalAuth):
//   (1) transport secret present (current or previous), hash-compared,
//       and not revoked; AND signing secrets configured (a process
//       without a signing secret authenticates nothing — fail closed);
//   (2) signature present and well-formed (64 hex), nonce present and
//       well-formed (32 hex);
//   (3) timestamp within ±60 s;
//   (3b) MILLISECOND process-start rule (Rev 4.8 §15 as corrected by
//         the reviewer): timestampSeconds * 1000 <= processStartMs
//         rejects — equality AND earlier. A timestamp is second
//         granularity, so the call's whole second at or before the
//         process-start second is rejected; the first acceptable second
//         is the second after start, and a legitimate caller re-signs.
//         (The earlier seconds-only rule — "the start second itself is
//         allowed" — was wrong: a nonce issued before this process
//         started could be replayed into it in the same second, and a
//         restart would otherwise share a nonce era with the process
//         it replaced.)
//   (4) signature verifies against a configured SIGNING secret
//       (constant-time comparison; a revoked signing secret is skipped
//       — revocation overrides the rotation overlap for both secrets);
//   (5) nonce unseen — consumed ONLY now, after step 4 passes, by a
//       single atomic statement in the API process's own local SQLite
//       nonce store (nonce-store.js, <dataDir>/nonces.db); a failed
//       request can never burn a nonce, and two concurrent consumers
//       of the same nonce admit exactly one;
//   (6) body parses and validates (caller's job).
// Any failure returns 401 with { error: "unauthorised" } and no detail.
// Only the step number and request ID are logged.
//
// The nonce store is SQLite (nonce-store.js). ApiStateStore keeps its own
// roles (kill-switch, activation flags, revocation record) and is NOT a
// nonce store — its mutate() reload+save is not atomic across processes,
// so two concurrent consumers could both see a nonce absent. There is no
// fallback to the JSON store: verifyWorkerAuth requires a nonce store.
//
// Revocation is checked against the revocation list re-read from disk
// when it changed (≤ 5 s specified maximum propagation, Rev 3.2
// §B-3.2.4.2 — this implementation re-reads on mtime change, which is
// immediate in practice; the 5-second figure is the specified maximum,
// not a measured figure).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HMAC_TIMESTAMP_WINDOW_S } from './constants.js';
import { NONCE_VALIDITY_SECONDS } from './nonce-store.js';

// Process-start boundary (Rev 4.8 §15, millisecond rule): a nonce issued
// before this process started can never be replayed into it, even within
// the ±60 s freshness window. A restart starts a fresh nonce era. The
// comparison is in MILLISECONDS against the actual process-start instant:
// ts * 1000 <= processStartMs rejects. The value is captured at module
// load (process start) and is injectable for tests via the
// opts.processStartMs parameter.
const PROCESS_START_MS = Date.now();

export function processStartMs() {
  return PROCESS_START_MS;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hmacSha256Hex(keyText, message) {
  return createHmac('sha256', keyText).update(message, 'utf8').digest('hex');
}

export function fingerprintOfSecret(secret) {
  return sha256Hex(secret);
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function isRevoked(apiState, fingerprint) {
  apiState.reloadIfChanged();
  return (apiState.state.revocations || []).some(
    (r) => r.fingerprint === fingerprint,
  );
}

// Sign an outgoing call (API process -> Worker, /internal/d1-*).
// Two-secret: the TRANSPORT secret is presented in X-NOVA-API-SECRET;
// the SIGNING secret keys the HMAC. Both are required — a missing
// signing secret throws instead of silently falling back to the
// transport secret (the single-secret fallback is not a conforming
// implementation). Returns the headers to send.
export function signApiCall(transportSecret, signingSecret, method, path, bodyText) {
  if (typeof transportSecret !== 'string' || transportSecret.length === 0) {
    throw new Error('signApiCall requires the transport secret (NOVA_API_SECRET)');
  }
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    throw new Error('signApiCall requires the signing secret (NOVA_SIGNING_SECRET)');
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = hmacSha256Hex(signingSecret, canonical);
  return {
    'X-NOVA-API-SECRET': transportSecret,
    'X-NOVA-SIGNATURE': signature,
    'X-NOVA-TIMESTAMP': timestamp,
    'X-NOVA-NONCE': nonce,
    'Content-Type': 'application/json',
  };
}

// Verify an incoming call (Worker -> API process, /internal/*).
// `req` is a Node http IncomingMessage (headers lower-cased by Node).
// `auth` is { transportSecrets, signingSecrets, apiState, nonceStore }:
//   transportSecrets — [current, previous?] (empty strings filtered);
//   signingSecrets   — [current, previous?] (empty strings filtered);
//   apiState         — an ApiStateStore (revocation record only);
//   nonceStore       — a SqliteNonceStore (REQUIRED; no JSON fallback).
// `opts.processStartMs` injects the process-start boundary for tests.
// Returns { ok: true } or { ok: false, step }.
export function verifyWorkerAuth(req, method, path, bodyText, auth, opts = {}) {
  const processStartMsBoundary = opts.processStartMs ?? PROCESS_START_MS;
  const { apiState, nonceStore } = auth || {};
  if (!apiState || typeof apiState.reloadIfChanged !== 'function') {
    throw new Error('verifyWorkerAuth requires apiState (revocation record)');
  }
  if (!nonceStore || typeof nonceStore.consume !== 'function') {
    throw new Error('verifyWorkerAuth requires a SqliteNonceStore');
  }
  const transportConfigured = (auth.transportSecrets || [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  const signingConfigured = (auth.signingSecrets || [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  // (1) A process without a signing secret authenticates nothing.
  if (transportConfigured.length === 0 || signingConfigured.length === 0) {
    return { ok: false, step: 1 };
  }

  // (1) transport secret present: must match a configured secret
  // (hash-compared).
  const presented = req.headers['x-nova-api-secret'] || '';
  if (typeof presented !== 'string' || presented.length === 0) {
    return { ok: false, step: 1 };
  }
  let presentedMatches = false;
  for (const s of transportConfigured) {
    if (constantTimeHexEqual(sha256Hex(presented), sha256Hex(s))) {
      presentedMatches = true;
    }
  }
  if (!presentedMatches) return { ok: false, step: 1 };

  // (1b) revocation overrides the rotation overlap (Rev 3.2 §B-3.2.4.2).
  // The fingerprint of the presented transport secret is checked against
  // the revocation record (re-read from disk if another process
  // changed it).
  if (isRevoked(apiState, fingerprintOfSecret(presented))) {
    return { ok: false, step: 1 };
  }

  // (2) signature + nonce well-formed.
  const signature = req.headers['x-nova-signature'] || '';
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, step: 2 };
  const nonce = req.headers['x-nova-nonce'] || '';
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, step: 2 };

  // (3) timestamp within ±60 s.
  const timestamp = req.headers['x-nova-timestamp'] || '';
  if (!/^[0-9]+$/.test(timestamp)) return { ok: false, step: 3 };
  const ts = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > HMAC_TIMESTAMP_WINDOW_S) return { ok: false, step: 3 };

  // (3a) The timestamp must be a finite, correctly typed integer before
  // any arithmetic on it (reviewer condition 5(a)): a digit string
  // longer than the safe-integer range would make ts * 1000 meaningless.
  // The ±60 s freshness check above already bounds ts in practice, so
  // this is defence in depth, placed before the multiplication.
  if (!Number.isSafeInteger(ts)) return { ok: false, step: 3 };

  // (3b) Millisecond process-start rule (reviewer correction): the
  // call's whole second at or before the process-start second is
  // rejected — timestampSeconds * 1000 <= processStartMs. A timestamp
  // is second granularity, so equality is a replay from the previous
  // process era (or from before this process existed). The first
  // acceptable second is the second after start; a legitimate caller
  // re-signs.
  if (ts * 1000 <= processStartMsBoundary) return { ok: false, step: 3 };

  // (4) signature verifies against a configured SIGNING secret
  // (constant-time). A revoked signing secret is skipped — revocation
  // overrides the rotation overlap for both secrets.
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
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
  // by one atomic INSERT OR IGNORE in the SQLite nonce store. A failed
  // request can never burn a nonce; two concurrent consumers of the
  // same nonce admit exactly one.
  const expiryMs = (ts + NONCE_VALIDITY_SECONDS) * 1000;
  if (!nonceStore.consume('worker', nonce, expiryMs)) return { ok: false, step: 5 };

  return { ok: true };
}
