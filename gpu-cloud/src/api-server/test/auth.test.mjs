// Two-secret HMAC verification (Rev 4.8 §8) + revocation override.
// Order: (1) transport secret present (current or previous) AND signing
// secrets configured, (1b) revocation overrides the overlap for BOTH
// secrets, (2) signature + nonce well-formed, (3) timestamp ±60 s,
// (3b) millisecond process-start rule (timestampSeconds*1000 <=
// processStartMs rejects), (4) signature verifies against a SIGNING
// secret (constant-time), (5) nonce unseen — consumed ONLY after step 4,
// by one atomic INSERT OR IGNORE in the local SQLite nonce store,
// (6) body parses/validates. Failure is 401 with the step number +
// request ID only — never the secret, signature, or nonce.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { signApiCall, verifyWorkerAuth, fingerprintOfSecret, sha256Hex, hmacSha256Hex } from '../auth.js';
import { ApiStateStore } from '../state-store.js';
import { SqliteNonceStore } from '../nonce-store.js';
import { revokeSecret, isRevoked } from '../revocation.js';

const SECRET = 'test-api-secret'; // transport secret
const PREVIOUS = 'old-api-secret';
const SIGNING = 'test-signing-secret';
const SIGNING_PREVIOUS = 'old-signing-secret';

// signApiCall is positional: (transportSecret, signingSecret, method,
// path, bodyText). Node lower-cases header names on real requests; the
// fake request does the same so verifyWorkerAuth sees what it would see
// on the wire.
function req(method, urlPath, body) {
  const headers = signApiCall(SECRET, SIGNING, method, urlPath, body);
  return { headers: lower(headers), method, urlPath, body };
}

function lower(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

// The millisecond process-start rule is tested in (u5) with injected
// boundaries; every other test injects a boundary of 0 (process started
// at epoch) so the rule under test is isolated from the module-load
// second — a request signed in the module-load second would otherwise
// fail at step 3 by design (the caller re-signs).
function verify(ctx, r, opts) {
  return verifyWorkerAuth(r, r.method, r.urlPath, r.body, {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0, ...(opts ?? {}) });
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-auth-'));
  const store = new ApiStateStore(path.join(dir, 'api-state.json'));
  const nonceStore = new SqliteNonceStore(path.join(dir, 'nonces.db'));
  return {
    store,
    nonceStore,
    dir,
    cleanup: () => {
      try { nonceStore.close(); } catch { /* ignore */ }
      return rm(dir, { recursive: true, force: true });
    },
  };
}

test('round-trip: a signed request verifies with the current secrets', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  const out = verify(ctx, r);
  assert.equal(out.ok, true);
});

test('previous transport secret is accepted during the 1-hour rotation overlap', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(PREVIOUS, SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, true);
});

test('previous signing secret is accepted during the rotation overlap', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(SECRET, SIGNING_PREVIOUS, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, true);
});

test('wrong transport secret fails at step 1', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // Signed correctly with the signing secret, but the presented
  // transport secret is unknown — step 1, before any signature work.
  const headers = lower(signApiCall('not-the-secret', SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('wrong signing secret fails at step 4 (transport secret alone cannot sign)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // The transport secret is correct, but the HMAC was keyed by a wrong
  // signing secret — step 4. A single compromised secret cannot forge.
  const headers = lower(signApiCall(SECRET, 'not-the-signing-secret', 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 4);
});

test('a signature made with the transport secret fails at step 4', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // The old single-secret shape: the HMAC keyed by the transport secret
  // itself. The transport secret is a configured secret, so step 1
  // passes — but it must never verify as a signing secret.
  const headers = lower(signApiCall(SECRET, SECRET, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 4);
});

test('a process without a signing secret authenticates nothing (step 1)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(SECRET, SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('signApiCall throws without a signing secret (no single-secret fallback)', async () => {
  assert.throws(
    () => signApiCall(SECRET, '', 'GET', '/internal/health', ''),
    /signing secret/,
  );
  assert.throws(
    () => signApiCall(SECRET, undefined, 'GET', '/internal/health', ''),
    /signing secret/,
  );
});

test('tampered body fails verification', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  r.body = '{"jobId":"j2"}';
  const out = verify(ctx, r);
  assert.equal(out.ok, false);
  assert.equal(out.step, 4);
});

test('expired timestamp fails at step 3', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // Sign with an old timestamp (the signature must cover it, so it is
  // built by hand here rather than by reusing a fresh signature).
  // The HMAC is keyed by the SIGNING secret.
  const oldTs = String(Math.floor(Date.now() / 1000) - 120);
  const nonce = randomBytes(16).toString('hex');
  const canonical = ['GET', '/internal/health', oldTs, nonce, sha256Hex('')].join('\n');
  const headers = lower({
    'X-NOVA-API-SECRET': SECRET,
    'X-NOVA-SIGNATURE': hmacSha256Hex(SIGNING, canonical),
    'X-NOVA-TIMESTAMP': oldTs,
    'X-NOVA-NONCE': nonce,
  });
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 3);
});

test('replay of the same timestamp+nonce+signature is rejected', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  assert.equal(verify(ctx, r).ok, true);
  const again = verify(ctx, r);
  assert.equal(again.ok, false);
  assert.equal(again.step, 5);
});

test('a failed signature does NOT consume the nonce (legitimate retry works)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // Build a request, then tamper the signature (not the body): step 4
  // must fail without consuming the nonce.
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  const badHeaders = { ...r.headers, 'x-nova-signature': '00'.repeat(32) };
  const bad = verifyWorkerAuth({ headers: badHeaders }, 'POST', '/internal/submit', r.body, {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.step, 4);
  // The same timestamp+nonce with the correct signature now verifies.
  assert.equal(verify(ctx, r).ok, true);
});

test('missing secret header fails at step 1', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const out = verifyWorkerAuth({ headers: {} }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('unknown secret fails at step 1 (hash-compared, no timing leak)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall('not-the-secret', SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('malformed signature fails at step 2', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(SECRET, SIGNING, 'GET', '/internal/health', ''));
  headers['x-nova-signature'] = 'not-hex';
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 2);
});

test('malformed nonce fails at step 2', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(SECRET, SIGNING, 'GET', '/internal/health', ''));
  headers['x-nova-nonce'] = 'too-short';
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 2);
});

test('stale request (timestamp outside the freshness window) fails at step 3', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  // A well-signed request timestamped 61 s in the past: the signature
  // is valid, but the request is stale.
  const staleTs = String(Math.floor(Date.now() / 1000) - 61);
  const nonce = randomBytes(16).toString('hex');
  const canonical = ['GET', '/internal/health', staleTs, nonce, sha256Hex('')].join('\n');
  const headers = lower({
    'X-NOVA-API-SECRET': SECRET,
    'X-NOVA-SIGNATURE': hmacSha256Hex(SIGNING, canonical),
    'X-NOVA-TIMESTAMP': staleTs,
    'X-NOVA-NONCE': nonce,
  });
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 3);
});

test('revocation overrides the 1-hour rotation overlap (transport secret)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const rec = revokeSecret({ apiState: ctx.store, secret: PREVIOUS, revokedBy: 'test', reason: 'rotation' });
  assert.equal(rec.fingerprint, fingerprintOfSecret(PREVIOUS));
  assert.equal(isRevoked(ctx.store, PREVIOUS), true);
  assert.equal(isRevoked(ctx.store, SECRET), false);
  const headers = lower(signApiCall(PREVIOUS, SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('revocation overrides the rotation overlap (signing secret)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const rec = revokeSecret({ apiState: ctx.store, secret: SIGNING, revokedBy: 'test', reason: 'rotation' });
  assert.equal(rec.fingerprint, fingerprintOfSecret(SIGNING));
  // The transport secret is fine (step 1 passes), but the signing
  // secret that verifies the signature is revoked — step 4.
  const headers = lower(signApiCall(SECRET, SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: ctx.store,
    nonceStore: ctx.nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 4);
});

test('T31-08 analogue: two processes sharing one store see the revocation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-auth2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'api-state.json');
  const storeA = new ApiStateStore(file);
  const storeB = new ApiStateStore(file);
  const nonceStore = new SqliteNonceStore(path.join(dir, 'nonces.db'));
  t.after(() => { try { nonceStore.close(); } catch { /* ignore */ } });
  revokeSecret({ apiState: storeA, secret: PREVIOUS, revokedBy: 'test', reason: 'multi-process' });
  // Process B has not re-read yet — reloadIfChanged picks up the mtime.
  storeB.reloadIfChanged();
  assert.equal(isRevoked(storeB, PREVIOUS), true);
  const headers = lower(signApiCall(PREVIOUS, SIGNING, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: [SECRET, PREVIOUS],
    signingSecrets: [SIGNING, SIGNING_PREVIOUS],
    apiState: storeB,
    nonceStore,
  }, { processStartMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('verifyWorkerAuth requires a nonce store (no JSON fallback)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const headers = lower(signApiCall(SECRET, SIGNING, 'GET', '/internal/health', ''));
  assert.throws(
    () => verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
      transportSecrets: [SECRET, PREVIOUS],
      signingSecrets: [SIGNING, SIGNING_PREVIOUS],
      apiState: ctx.store,
      nonceStore: null,
    }),
    /SqliteNonceStore/,
  );
});
