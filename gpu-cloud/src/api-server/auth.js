// NOVA AI Studio — Phase 3 API process: HMAC signing / verification.
//
// Canonical request (Rev 2 §11.2, unchanged by Rev 3):
//   METHOD + "\n" + PATH (incl. query) + "\n" + TIMESTAMP (unix seconds)
//   + "\n" + NONCE (128-bit hex) + "\n" + SHA256_HEX(BODY)
// Algorithm: HMAC-SHA-256 with the shared secret.
//
// Verification order (Rev 3 §C-1.10, as amended by Rev 3.2 §B-3.2.4.2):
//   (1) secret present (current or previous — 1-hour rotation overlap),
//       compared by SHA-256 hash so the comparison is constant-time;
//       a fingerprint present in the revocation record rejects the secret
//       even inside the overlap window (revocation overrides overlap);
//   (2) signature present and well-formed (64 hex), nonce present and
//       well-formed (32 hex);
//   (3) timestamp within ±60 s;
//   (3b) timestamp after process start (Rev 4.8 §15 process-start rule:
//         a timestamp from a second before the process-start second is
//         a replay from a previous process era — rejected even within
//         the window; the comparison is in seconds because timestamps
//         have second granularity);
//   (4) signature verifies (constant-time comparison);
//   (5) nonce unseen — recorded as used ONLY now, after step 4 passes,
//       so a failed request can never burn a nonce;
//   (6) body parses and validates (caller's job).
// Any failure returns 401 with { error: "unauthorised" } and no detail.
// Only the step number and request ID are logged.
//
// The nonce store lives in ApiStateStore (persisted across restarts, so
// a restart cannot resurrect a consumed nonce). Revocation is checked
// against the revocation list re-read from disk when it changed (≤ 5 s
// specified maximum propagation, Rev 3.2 §B-3.2.4.2 — this implementation
// re-reads on mtime change, which is immediate in practice; the 5-second
// figure is the specified maximum, not a measured figure).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HMAC_TIMESTAMP_WINDOW_S } from './constants.js';

// Process-start boundary (Rev 4.8 §15): a nonce issued before this
// process started can never be replayed into it, even within the ±60 s
// freshness window. A restart starts a fresh nonce era; a timestamp
// from a second before the process-start second is rejected as stale.
// The comparison is in SECONDS, not milliseconds, because request
// timestamps have second granularity: a timestamp in the same second
// the process started may have been created after start (the process
// loaded at N.215, a legitimate request timestamped N was created at
// N.500), so comparing ts*1000 against the millisecond start would
// reject legitimate first-second requests. The persisted nonce store
// (ApiStateStore, shared across restarts) covers the ambiguous same
// second: a consumed nonce stays consumed. The value is captured at
// module load (process start) and is injectable for tests via the
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

// Sign an outgoing call (API process -> Worker, /internal/d1-*).
// Returns the headers to send.
export function signApiCall(secret, method, path, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = hmacSha256Hex(secret, canonical);
  return {
    'X-NOVA-API-SECRET': secret,
    'X-NOVA-SIGNATURE': signature,
    'X-NOVA-TIMESTAMP': timestamp,
    'X-NOVA-NONCE': nonce,
    'Content-Type': 'application/json',
  };
}

// Verify an incoming call (Worker -> API process, /internal/*).
// `req` is a Node http IncomingMessage (headers lower-cased by Node).
// `secrets` is [current, previous?] (empty strings filtered).
// `apiState` is an ApiStateStore (nonce + revocation persistence).
// Returns { ok: true } or { ok: false, step }.
export function verifyWorkerAuth(req, method, path, bodyText, secrets, apiState, opts = {}) {
  const processStartMsBoundary = opts.processStartMs ?? PROCESS_START_MS;
  const configured = (secrets || []).filter((s) => typeof s === 'string' && s.length > 0);
  if (configured.length === 0) return { ok: false, step: 1 };

  // (1) secret present: must match a configured secret (hash-compared).
  const presented = req.headers['x-nova-api-secret'] || '';
  if (typeof presented !== 'string' || presented.length === 0) {
    return { ok: false, step: 1 };
  }
  let presentedMatches = false;
  for (const s of configured) {
    if (constantTimeHexEqual(sha256Hex(presented), sha256Hex(s))) {
      presentedMatches = true;
    }
  }
  if (!presentedMatches) return { ok: false, step: 1 };

  // (1b) revocation overrides the rotation overlap (Rev 3.2 §B-3.2.4.2).
  // The fingerprint of the presented secret is checked against the
  // revocation record (re-read from disk if another process changed it).
  apiState.reloadIfChanged();
  const fp = fingerprintOfSecret(presented);
  const revoked = (apiState.state.revocations || []).some((r) => r.fingerprint === fp);
  if (revoked) return { ok: false, step: 1 };

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

  // (3b) Rev 4.8 §15 process-start rule: a timestamp from a second
  // before the process-start second is a replay from a previous process
  // era — rejected even though it is within the freshness window. The
  // comparison is in seconds (see the module header): the process-start
  // second itself is allowed, because a request timestamped in that
  // second may have been created after the process started.
  if (ts < Math.floor(processStartMsBoundary / 1000)) return { ok: false, step: 3 };

  // (4) signature verifies (constant-time).
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const expected = hmacSha256Hex(presented, canonical);
  if (!constantTimeHexEqual(expected, signature)) return { ok: false, step: 4 };

  // (5) nonce unseen — consumed ONLY now, after the signature verified.
  // Expired nonces are pruned first (validity window + 5 minutes).
  const nowMs = Date.now();
  const expiryMs = (ts + 360) * 1000;
  let consumed = false;
  apiState.mutate((s) => {
    for (const [n, exp] of Object.entries(s.nonces)) {
      if (exp < nowMs) delete s.nonces[n];
    }
    if (!(nonce in s.nonces)) {
      s.nonces[nonce] = expiryMs;
      consumed = true;
    }
  });
  if (!consumed) return { ok: false, step: 5 };

  return { ok: true };
}
