// HMAC verification order (Rev 3 §C-1.10) + revocation override.
// Order: (1) secret present, (2) signature well-formed, (3) timestamp
// ±60 s, (4) signature verifies, (5) nonce unseen (consumed ONLY after
// step 4), (6) body parses/validates. Failure is 401 with the step
// number + request ID only — never the secret, signature, or nonce.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { signApiCall, verifyWorkerAuth, fingerprintOfSecret, sha256Hex, hmacSha256Hex } from '../auth.js';
import { ApiStateStore } from '../state-store.js';
import { revokeSecret, isRevoked } from '../revocation.js';

const SECRET = 'test-api-secret';
const PREVIOUS = 'old-api-secret';

// signApiCall is positional: (secret, method, path, bodyText). Node
// lower-cases header names on real requests; the fake request does the
// same so verifyWorkerAuth sees what it would see on the wire.
function req(method, urlPath, body) {
  const headers = signApiCall(SECRET, method, urlPath, body);
  return { headers: lower(headers), method, urlPath, body };
}

function lower(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function verify(state, r) {
  return verifyWorkerAuth(r, r.method, r.urlPath, r.body, [SECRET, PREVIOUS], state);
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-auth-'));
  const store = new ApiStateStore(path.join(dir, 'api-state.json'));
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('round-trip: a signed request verifies with the current secret', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  const out = verify(store, r);
  assert.equal(out.ok, true);
});

test('previous secret is accepted during the 1-hour rotation overlap', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const headers = lower(signApiCall(PREVIOUS, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, true);
});

test('tampered body fails verification', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  r.body = '{"jobId":"j2"}';
  const out = verify(store, r);
  assert.equal(out.ok, false);
  assert.equal(out.step, 4);
});

test('expired timestamp fails at step 3', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  // Sign with an old timestamp (the signature must cover it, so it is
  // built by hand here rather than by reusing a fresh signature).
  const oldTs = String(Math.floor(Date.now() / 1000) - 120);
  const nonce = randomBytes(16).toString('hex');
  const canonical = ['GET', '/internal/health', oldTs, nonce, sha256Hex('')].join('\n');
  const headers = lower({
    'X-NOVA-API-SECRET': SECRET,
    'X-NOVA-SIGNATURE': hmacSha256Hex(SECRET, canonical),
    'X-NOVA-TIMESTAMP': oldTs,
    'X-NOVA-NONCE': nonce,
  });
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, false);
  assert.equal(out.step, 3);
});

test('replay of the same timestamp+nonce+signature is rejected', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  assert.equal(verify(store, r).ok, true);
  const again = verify(store, r);
  assert.equal(again.ok, false);
  assert.equal(again.step, 5);
});

test('a failed signature does NOT consume the nonce (legitimate retry works)', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  // Build a request, then tamper the signature (not the body): step 4
  // must fail without consuming the nonce.
  const r = req('POST', '/internal/submit', '{"jobId":"j1"}');
  const badHeaders = { ...r.headers, 'x-nova-signature': '00'.repeat(32) };
  const bad = verifyWorkerAuth({ headers: badHeaders }, 'POST', '/internal/submit', r.body, [SECRET, PREVIOUS], store);
  assert.equal(bad.ok, false);
  assert.equal(bad.step, 4);
  // The same timestamp+nonce with the correct signature now verifies.
  assert.equal(verify(store, r).ok, true);
});

test('missing secret header fails at step 1', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const out = verifyWorkerAuth({ headers: {} }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('unknown secret fails at step 1 (hash-compared, no timing leak)', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const headers = lower(signApiCall('not-the-secret', 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('malformed signature fails at step 2', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const headers = lower(signApiCall(SECRET, 'GET', '/internal/health', ''));
  headers['x-nova-signature'] = 'not-hex';
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, false);
  assert.equal(out.step, 2);
});

test('revocation overrides the 1-hour rotation overlap', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const rec = revokeSecret({ apiState: store, secret: PREVIOUS, revokedBy: 'test', reason: 'rotation' });
  assert.equal(rec.fingerprint, fingerprintOfSecret(PREVIOUS));
  assert.equal(isRevoked(store, PREVIOUS), true);
  assert.equal(isRevoked(store, SECRET), false);
  const headers = lower(signApiCall(PREVIOUS, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], store);
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});

test('T31-08 analogue: two processes sharing one store see the revocation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-auth2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'api-state.json');
  const storeA = new ApiStateStore(file);
  const storeB = new ApiStateStore(file);
  revokeSecret({ apiState: storeA, secret: PREVIOUS, revokedBy: 'test', reason: 'multi-process' });
  // Process B has not re-read yet — reloadIfChanged picks up the mtime.
  storeB.reloadIfChanged();
  assert.equal(isRevoked(storeB, PREVIOUS), true);
  const headers = lower(signApiCall(PREVIOUS, 'GET', '/internal/health', ''));
  const out = verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', [SECRET, PREVIOUS], storeB);
  assert.equal(out.ok, false);
  assert.equal(out.step, 1);
});
