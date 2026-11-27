// NOVA AI Studio — Phase 5 Rev 4.8 §15, legs (u) M2-P and (v) M2-P install.
//
// The M2-P (personal production) machinery: activation.conf reader with
// strict boolean parsing, the §4.2 authorisation calculation with the
// seven-word reason vocabulary, the signed GET /internal/capacity
// contract (§4.3), the audit-log append, the §6 submit-time gates
// (audience validation, non-commercial attestation, activation-flag
// revalidation), the audience routing at dispatcher / executor /
// transport, the §15 process-start rule, and the install.sh top-dir
// chmod fix.
//
// NOTE on scope: the personal-path proof run (gate item 3) is NOT in
// this file — it needs a real LTX executor, a Kaggle transport, and a
// Kaggle credential on the host, none of which exists yet (see
// ~/workspace/your_files/nova-m2p-proof-run-gaps.md). These tests prove
// the machinery up to the proof run; they never fake the run itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';

import {
  parseActivationConfigText,
  readActivationConfig,
  parseKaggleFloorHours,
  appendActivationAuditLog,
  computeAuthorisation,
  signCapacityResponse,
  verifyCapacityResponse,
  storageHealth,
  CAPACITY_REASONS,
  NON_COMMERCIAL_PURPOSES,
} from '../src/api-server/activation.js';
import { verifyWorkerAuth, processStartMs, signApiCall } from '../src/api-server/auth.js';
import { ApiStateStore } from '../src/api-server/state-store.js';
import { SqliteNonceStore } from '../src/api-server/nonce-store.js';
import { createApiServer } from '../src/api-server.js';
import { createStorage } from '../src/storage/index.js';
import {
  makeApi,
  submitBody,
  seedJobForSubmit,
  canonicalJobId,
} from '../src/api-server/test/support.mjs';

const TEST_SIGNING_SECRET = 'test-signing-secret-not-a-real-secret';
const TEST_OWNER_TOKEN_ID = 'owner-token-v1';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-m2p-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The millisecond process-start rule rejects a request signed in the
// module-load second (ts*1000 <= processStartMs). A live-server test
// that fetches within that second would flake with a 401. Wait until
// the wall-clock second has advanced past the module-load second
// (at most ~1 s) before the first signed fetch in a (u6) test.
async function awaitPastStartSecond() {
  const boundary = (Math.floor(processStartMs() / 1000) + 1) * 1000;
  const wait = boundary - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 5));
}

function writeActivationConf(dir, text) {
  const p = path.join(dir, 'activation.conf');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// A valid capacity response for one audience, signed with the test secret.
function signedCapacity({ signingSecret = TEST_SIGNING_SECRET, audience = 'personal', nonce = randomBytes(16).toString('hex'), timestamp = null, mutate = null } = {}) {
  const body = computeAuthorisation({
    mode: 'production',
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    killSwitchEngaged: false,
    storage: { headroomBytes: 10 * 1024 * 1024 * 1024, reservedBytes: 0, ok: true },
    productionExecutorIds: [],
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 25, total: 30, floor: 5 },
    personalDispatchable: true,
    personalTokenId: TEST_OWNER_TOKEN_ID,
    queueDepth: 0,
    requestedAudience: audience,
    requestNonce: nonce,
  });
  if (mutate) mutate(body);
  const bodyText = JSON.stringify(body);
  const { timestamp: ts, signature } = signCapacityResponse({ signingSecret, requestNonce: nonce, bodyText, timestamp });
  return { body, bodyText, timestamp: ts, signature, nonce };
}

// -- (u1) activation.conf parsing -------------------------------------------

test('(u1) activation config: missing keys default false, true/false parse strictly', () => {
  assert.deepEqual(parseActivationConfigText(''), { publicProductionActivated: false, personalProductionActivated: false });
  assert.deepEqual(parseActivationConfigText('# comment\n'), { publicProductionActivated: false, personalProductionActivated: false });
  assert.deepEqual(
    parseActivationConfigText('NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=true\n'),
    { publicProductionActivated: false, personalProductionActivated: true },
  );
  // Whitespace around key/value is tolerated; anything else is not.
  assert.deepEqual(
    parseActivationConfigText('NOVA_PERSONAL_PRODUCTION_ACTIVATED = true'),
    { publicProductionActivated: false, personalProductionActivated: true },
  );
});

test('(u1) activation config: malformed values, unknown keys, duplicates are startup failures', () => {
  assert.throws(() => parseActivationConfigText('NOVA_PERSONAL_PRODUCTION_ACTIVATED=yes'), /must be exactly "true" or "false"/);
  assert.throws(() => parseActivationConfigText('NOVA_PERSONAL_PRODUCTION_ACTIVATED=1'), /must be exactly "true" or "false"/);
  assert.throws(() => parseActivationConfigText('NOVA_PERSONAL_PRODUCTION_ACTIVATED=TRUE'), /must be exactly "true" or "false"/);
  assert.throws(() => parseActivationConfigText('NOVA_PUBLIC_PRODUCTION_ACTIVE=true'), /unknown key/);
  assert.throws(() => parseActivationConfigText('NOVA_PERSONAL_PRODUCTION_ACTIVATED=true\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false'), /duplicate key/);
  assert.throws(() => parseActivationConfigText('not a key value line'), /malformed line/);
});

test('(u1) activation config: missing file means both flags false; malformed file throws', (t) => {
  const dir = tempDir(t);
  const missing = readActivationConfig(path.join(dir, 'does-not-exist.conf'));
  assert.deepEqual(missing, { publicProductionActivated: false, personalProductionActivated: false });
  const bad = writeActivationConf(dir, 'NOVA_PERSONAL_PRODUCTION_ACTIVATED=maybe\n');
  assert.throws(() => readActivationConfig(bad), /must be exactly "true" or "false"/);
});

test('(u1) Kaggle floor: default 5, valid values pass, invalid values are startup failures', () => {
  assert.equal(parseKaggleFloorHours(undefined), 5);
  assert.equal(parseKaggleFloorHours(''), 5);
  assert.equal(parseKaggleFloorHours('0'), 0);
  assert.equal(parseKaggleFloorHours('5'), 5);
  assert.equal(parseKaggleFloorHours('12.5'), 12.5);
  assert.throws(() => parseKaggleFloorHours('abc'), /must be a finite number/);
  assert.throws(() => parseKaggleFloorHours('-1'), /must be a finite number/);
  assert.throws(() => parseKaggleFloorHours('NaN'), /must be a finite number/);
});

// -- (u2) authorisation calculation (§4.2, §9) -------------------------------

function baseInputs(overrides = {}) {
  return {
    mode: 'production',
    flags: { publicProductionActivated: false, personalProductionActivated: false },
    killSwitchEngaged: false,
    storage: { headroomBytes: 10 * 1024 * 1024 * 1024, reservedBytes: 0, ok: true },
    productionExecutorIds: [],
    personalExecutorRegistered: false,
    kaggleCredentialPresent: false,
    ownerTokenConfigured: false,
    kaggleQuota: null,
    providerQuotas: new Map(),
    providerDetails: [],
    personalTokenId: null,
    queueDepth: 0,
    requestedAudience: 'personal',
    requestNonce: 'a'.repeat(32),
    ...overrides,
  };
}

test('(u2) authorisation: both modes unauthorised with not-activated when flags are off', () => {
  const body = computeAuthorisation(baseInputs());
  assert.equal(body.publicProductionAuthorised, false);
  assert.equal(body.reason, 'not-activated');
  assert.equal(body.personalProductionAuthorised, false);
  assert.equal(body.personalReason, 'not-activated');
  // A reason is present exactly when its mode is unauthorised.
  assert.equal('reason' in body, true);
  assert.equal('personalReason' in body, true);
  assert.equal(body.publicProductionActivated, false);
  assert.equal(body.personalProductionActivated, false);
});

test('(u2) authorisation: kill-switch beats not-activated (§9 precedence)', () => {
  const body = computeAuthorisation(baseInputs({ killSwitchEngaged: true }));
  assert.equal(body.reason, 'kill-switch-engaged');
  assert.equal(body.personalReason, 'kill-switch-engaged');
});

test('(u2) authorisation: personal authorised when flag on, executor registered, credential + token present, quota above floor, storage ok', () => {
  const body = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 25, total: 30, floor: 5 },
    personalDispatchable: true,
    personalTokenId: TEST_OWNER_TOKEN_ID,
  }));
  assert.equal(body.personalProductionAuthorised, true);
  assert.equal('personalReason' in body, false);
  assert.equal(body.personalTokenId, TEST_OWNER_TOKEN_ID);
  // Public stays unauthorised: no production executor registered.
  assert.equal(body.publicProductionAuthorised, false);
  assert.equal(body.reason, 'not-activated');
});

test('(u2) authorisation: personal no-production-executor when any of executor/credential/token is missing', () => {
  const variants = [
    { personalExecutorRegistered: false, kaggleCredentialPresent: true, ownerTokenConfigured: true },
    { personalExecutorRegistered: true, kaggleCredentialPresent: false, ownerTokenConfigured: true },
    { personalExecutorRegistered: true, kaggleCredentialPresent: true, ownerTokenConfigured: false },
  ];
  for (const v of variants) {
    const body = computeAuthorisation(baseInputs({
      flags: { publicProductionActivated: false, personalProductionActivated: true },
      kaggleQuota: { remaining: 25, total: 30, floor: 5 },
      personalDispatchable: true,
      ...v,
    }));
    assert.equal(body.personalProductionAuthorised, false, JSON.stringify(v));
    assert.equal(body.personalReason, 'no-production-executor', JSON.stringify(v));
  }
});

test('(u2) authorisation: personal quota floor is a strict boundary (remaining == floor stops dispatch)', () => {
  const atFloor = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 5, total: 30, floor: 5 },
    personalDispatchable: true,
  }));
  assert.equal(atFloor.personalProductionAuthorised, false);
  assert.equal(atFloor.personalReason, 'quota-exhausted');
  // The 5 h floor and the 30 h weekly window are separate concepts:
  // the floor is the stop line, the window is the budget. 5.5 h
  // remaining authorises ONLY when every other §4.2 condition also
  // holds — it is not unconditional authorisation.
  const aboveFloor = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 5.5, total: 30, floor: 5 },
    personalDispatchable: true,
  }));
  assert.equal(aboveFloor.personalProductionAuthorised, true);
  const aboveFloorStorageFull = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 5.5, total: 30, floor: 5 },
    personalDispatchable: true,
    storage: { headroomBytes: 0, reservedBytes: 0, ok: false },
  }));
  assert.equal(aboveFloorStorageFull.personalProductionAuthorised, false);
  assert.equal(aboveFloorStorageFull.personalReason, 'storage-full');
  const aboveFloorFlagOff = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: false },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 5.5, total: 30, floor: 5 },
    personalDispatchable: true,
  }));
  assert.equal(aboveFloorFlagOff.personalProductionAuthorised, false);
  assert.equal(aboveFloorFlagOff.personalReason, 'not-activated');
  // An invalid quota model cannot authorise (fail closed).
  const invalid = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: NaN, total: 30, floor: 5 },
    personalDispatchable: true,
  }));
  assert.equal(invalid.personalProductionAuthorised, false);
  assert.equal(invalid.personalReason, 'quota-exhausted');
});

test('(u2) authorisation: storage-full and no-worker reasons, in precedence order', () => {
  const full = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 25, total: 30, floor: 5 },
    personalDispatchable: true,
    storage: { headroomBytes: 0, reservedBytes: 0, ok: false },
  }));
  assert.equal(full.personalReason, 'storage-full');
  const noWorker = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: false, personalProductionActivated: true },
    personalExecutorRegistered: true,
    kaggleCredentialPresent: true,
    ownerTokenConfigured: true,
    kaggleQuota: { remaining: 25, total: 30, floor: 5 },
    personalDispatchable: false,
  }));
  assert.equal(noWorker.personalReason, 'no-worker');
});

test('(u2) authorisation: public ceiling blocks a registered paid provider at ceiling 0; a paid provider above floor authorises', () => {
  const ceiling = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: true, personalProductionActivated: false },
    productionExecutorIds: ['mock-paid'],
    paidProductionExecutorIds: ['mock-paid'],
    ceilingUsd: 0,
    committedUsd: 0,
    providerQuotas: new Map([['mock-paid', { remaining: 10, total: 10, floor: 0 }]]),
  }));
  assert.equal(ceiling.publicProductionAuthorised, false);
  assert.equal(ceiling.reason, 'ceiling');
  const ok = computeAuthorisation(baseInputs({
    flags: { publicProductionActivated: true, personalProductionActivated: false },
    productionExecutorIds: ['mock-paid'],
    paidProductionExecutorIds: ['mock-paid'],
    ceilingUsd: 100,
    committedUsd: 0,
    providerQuotas: new Map([['mock-paid', { remaining: 10, total: 10, floor: 0 }]]),
    productionDispatchableIds: ['mock-paid'],
  }));
  assert.equal(ok.publicProductionAuthorised, true);
  assert.equal('reason' in ok, false);
});

test('(u2) authorisation: every reason word is from the seven-word vocabulary', () => {
  assert.deepEqual(CAPACITY_REASONS, [
    'kill-switch-engaged', 'not-activated', 'no-production-executor',
    'ceiling', 'quota-exhausted', 'storage-full', 'no-worker',
  ]);
  assert.equal(CAPACITY_REASONS.includes('api-unreachable'), false);
});

test('(u2) storage health: 500 MB margin, writable, and a fresh sweep are all required', () => {
  assert.equal(storageHealth({ headroomBytes: 500 * 1024 * 1024, writable: true, sweepHealthy: true }).ok, true);
  assert.equal(storageHealth({ headroomBytes: 500 * 1024 * 1024 - 1, writable: true, sweepHealthy: true }).ok, false);
  assert.equal(storageHealth({ headroomBytes: 10 ** 12, writable: false, sweepHealthy: true }).ok, false);
  assert.equal(storageHealth({ headroomBytes: 10 ** 12, writable: true, sweepHealthy: false }).ok, false);
});

// -- (u3) signed capacity contract (§4.3) ------------------------------------

test('(u3) capacity signing: round trip verifies; tampered body, stale timestamp, wrong nonce, wrong audience all reject', () => {
  const good = signedCapacity();
  assert.deepEqual(verifyCapacityResponse({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp: good.timestamp,
    signature: good.signature,
    requestNonce: good.nonce,
    expectedAudience: 'personal',
    bodyText: good.bodyText,
  }), { ok: true, body: good.body });

  // Tampered body.
  const tampered = signedCapacity({ mutate: (b) => { b.personalProductionAuthorised = false; } });
  assert.equal(verifyCapacityResponse({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp: tampered.timestamp,
    signature: tampered.signature,
    requestNonce: tampered.nonce,
    expectedAudience: 'personal',
    bodyText: JSON.stringify({ ...tampered.body, personalProductionAuthorised: true }),
  }).ok, false);

  // Stale timestamp (10 s old, outside ±5 s).
  const stale = signedCapacity({ timestamp: (Math.floor(Date.now() / 1000) - 10).toString() });
  assert.deepEqual(verifyCapacityResponse({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp: stale.timestamp,
    signature: stale.signature,
    requestNonce: stale.nonce,
    expectedAudience: 'personal',
    bodyText: stale.bodyText,
  }).reason, 'stale-timestamp');

  // Wrong nonce (signature is over a different nonce).
  const wrongNonce = signedCapacity();
  assert.equal(verifyCapacityResponse({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp: wrongNonce.timestamp,
    signature: wrongNonce.signature,
    requestNonce: randomBytes(16).toString('hex'),
    expectedAudience: 'personal',
    bodyText: wrongNonce.bodyText,
  }).ok, false);

  // Wrong audience.
  const wrongAudience = signedCapacity({ audience: 'personal' });
  assert.equal(verifyCapacityResponse({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp: wrongAudience.timestamp,
    signature: wrongAudience.signature,
    requestNonce: wrongAudience.nonce,
    expectedAudience: 'public',
    bodyText: wrongAudience.bodyText,
  }).ok, false);

  // Wrong signing secret.
  const wrongSecret = signedCapacity();
  assert.equal(verifyCapacityResponse({
    signingSecret: 'a-different-secret',
    timestamp: wrongSecret.timestamp,
    signature: wrongSecret.signature,
    requestNonce: wrongSecret.nonce,
    expectedAudience: 'personal',
    bodyText: wrongSecret.bodyText,
  }).ok, false);
});

test('(u3) capacity signing: signCapacityResponse requires the signing secret and a 32-hex nonce', () => {
  assert.throws(() => signCapacityResponse({ signingSecret: '', requestNonce: 'a'.repeat(32), bodyText: '{}' }), /NOVA_SIGNING_SECRET/);
  assert.throws(() => signCapacityResponse({ signingSecret: TEST_SIGNING_SECRET, requestNonce: 'not-hex', bodyText: '{}' }), /requestNonce/);
});

// -- (u4) audit log -----------------------------------------------------------

test('(u4) activation audit log: one JSON line per change; bad flag or missing reference throws', (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'activation-audit.log');
  const entry = appendActivationAuditLog({
    logPath,
    operator: 'shina',
    flag: 'personalProductionActivated',
    oldValue: false,
    newValue: true,
    authorisationRef: 'M2-P sign-off 2026-11-27',
    at: '2026-11-27T10:00:00.000Z',
  });
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: '2026-11-27T10:00:00.000Z',
    operator: 'shina',
    flag: 'personalProductionActivated',
    oldValue: false,
    newValue: true,
    authorisationRef: 'M2-P sign-off 2026-11-27',
  });
  assert.equal(entry.flag, 'personalProductionActivated');
  assert.throws(() => appendActivationAuditLog({ logPath, operator: 'x', flag: 'activated', oldValue: false, newValue: true, authorisationRef: 'r' }), /unknown flag/);
  assert.throws(() => appendActivationAuditLog({ logPath, operator: 'x', flag: 'personalProductionActivated', oldValue: false, newValue: true }), /authorisationRef is required/);
});

// -- (u5) process-start rule (§15, millisecond rule) -----------------------
// Reviewer correction: timestampSeconds * 1000 <= processStartMs rejects
// (equality AND earlier). A timestamp is second granularity, so the
// call's whole second at or before the process-start second is rejected;
// the first acceptable second is the second after start, and a
// legitimate caller re-signs. The six reviewer tests:
//   1. timestamp before the process start -> step 3;
//   2. timestamp exactly equal to the process start -> step 3;
//   3. timestamp in the same second but before the actual start -> step 3;
//   4. timestamp in the next second -> ok;
//   5. fresh request after process start -> ok;
//   6. nonce replay -> step 5.
// The HMAC is keyed by the SIGNING secret; the TRANSPORT secret is only
// presented. The nonce store is the local SQLite store, not ApiStateStore.

function signedRequestHeaders({ transport, signing, method, path: p, bodyText, timestamp, nonce }) {
  const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('hex');
  const canonical = [method, p, timestamp, nonce, bodyHash].join('\n');
  const signature = createHmac('sha256', signing).update(canonical, 'utf8').digest('hex');
  return {
    'x-nova-api-secret': transport,
    'x-nova-signature': signature,
    'x-nova-timestamp': timestamp,
    'x-nova-nonce': nonce,
  };
}

function u5Auth(ctx, headers, opts) {
  return verifyWorkerAuth({ headers }, 'GET', '/internal/health', '', {
    transportSecrets: ['test-secret'],
    signingSecrets: [TEST_SIGNING_SECRET],
    apiState: ctx.apiState,
    nonceStore: ctx.nonceStore,
  }, opts);
}

test('(u5) process-start rule (millisecond): the reviewer six tests', (t) => {
  const dir = tempDir(t);
  const apiState = new ApiStateStore(path.join(dir, 'api-state.json'));
  const nonceStore = new SqliteNonceStore(path.join(dir, 'nonces.db'));
  t.after(() => { try { nonceStore.close(); } catch { /* ignore */ } });
  const ctx = { apiState, nonceStore };
  const nowSec = Math.floor(Date.now() / 1000);
  // A deterministic boundary: the process "started" at nowSec-30 plus
  // 700 ms into that second (N.700). The boundary is injectable, so the
  // test is deterministic no matter when the suite reaches it.
  const boundaryMs = (nowSec - 30) * 1000 + 700;

  // 1. A timestamp before the process start is rejected at step 3 —
  // even though it is inside the ±60 s freshness window (31 s ago vs a
  // 30 s old process): the rule, not the window, rejects it.
  const beforeStart = signedRequestHeaders({
    transport: 'test-secret', signing: TEST_SIGNING_SECRET,
    method: 'GET', path: '/internal/health', bodyText: '',
    timestamp: String(nowSec - 31), nonce: randomBytes(16).toString('hex'),
  });
  assert.deepEqual(u5Auth(ctx, beforeStart, { processStartMs: boundaryMs }), { ok: false, step: 3 });

  // 2. A timestamp exactly equal to the process start (ts*1000 ==
  // processStartMs) is rejected: equality is a replay from the previous
  // process era (or from before this process existed).
  const exactStart = signedRequestHeaders({
    transport: 'test-secret', signing: TEST_SIGNING_SECRET,
    method: 'GET', path: '/internal/health', bodyText: '',
    timestamp: String(nowSec - 30), nonce: randomBytes(16).toString('hex'),
  });
  // boundaryMs is (nowSec-30)*1000 + 700, so ts*1000 < boundaryMs —
  // this is case 3's shape too; for the exact-equality case use a
  // boundary exactly on the second.
  assert.deepEqual(
    u5Auth(ctx, exactStart, { processStartMs: (nowSec - 30) * 1000 }),
    { ok: false, step: 3 },
  );

  // 3. A timestamp in the same second but before the actual start
  // (start at N.700, timestamp N) is rejected: the call's whole second
  // at or before the process-start second is rejected.
  assert.deepEqual(u5Auth(ctx, exactStart, { processStartMs: boundaryMs }), { ok: false, step: 3 });

  // 4. A timestamp in the next second (N+1, start N.700) is accepted:
  // the first acceptable second is the second after start.
  const nextSecond = signedRequestHeaders({
    transport: 'test-secret', signing: TEST_SIGNING_SECRET,
    method: 'GET', path: '/internal/health', bodyText: '',
    timestamp: String(nowSec - 29), nonce: randomBytes(16).toString('hex'),
  });
  assert.deepEqual(u5Auth(ctx, nextSecond, { processStartMs: boundaryMs }), { ok: true });

  // 5. A fresh request after process start passes — against an injected
  // boundary 5 s in the past (the real module-load boundary would make
  // this test timing-dependent: a request signed in the module-load
  // second is rejected by design, and this test runs in that second).
  const freshNonce = randomBytes(16).toString('hex');
  const fresh = signedRequestHeaders({
    transport: 'test-secret', signing: TEST_SIGNING_SECRET,
    method: 'GET', path: '/internal/health', bodyText: '',
    timestamp: String(nowSec), nonce: freshNonce,
  });
  assert.deepEqual(u5Auth(ctx, fresh, { processStartMs: (nowSec - 5) * 1000 }), { ok: true });

  // 6. A second identical request fails at step 5 (nonce consumed),
  // not step 3 — the nonce store, not the start rule, rejects it.
  assert.deepEqual(u5Auth(ctx, fresh, { processStartMs: (nowSec - 5) * 1000 }), { ok: false, step: 5 });

  // processStartMs() is a real module-load timestamp, not zero.
  assert.ok(processStartMs() > 0 && processStartMs() <= Date.now());
});

// -- (u6) live server: capacity route -----------------------------------------

test('(u6) capacity route: signed GET returns a verifiable response; flags are NOT in api.config', async (t) => {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  const { api, cleanup } = await makeApi({
    mode: 'production',
    executor: false,
    activationConfigPath: confPath,
    signingSecret: TEST_SIGNING_SECRET,
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    kaggleCredentialPresent: false,
    personalExecutor: '',
  });
  try {
    assert.equal('publicProductionActivated' in api.config, false);
    assert.equal('personalProductionActivated' in api.config, false);
    assert.deepEqual(api.activation.flags, { publicProductionActivated: false, personalProductionActivated: false });
    assert.equal(api.activation.ownerTokenConfigured, true);
    assert.equal(api.activation.personalTokenId, TEST_OWNER_TOKEN_ID);
    assert.equal(api.activation.kaggleFloorHours, 5);
    assert.equal(api.activation.signingSecretPresent, true);

    const { port } = await api.start();
    await awaitPastStartSecond();
    const nonce = randomBytes(16).toString('hex');
    const pathWithQuery = `/internal/capacity?audience=personal&requestNonce=${nonce}`;
    const headers = signApiCall('test-secret', TEST_SIGNING_SECRET, 'GET', pathWithQuery, '');
    const res = await fetch(`http://127.0.0.1:${port}${pathWithQuery}`, { headers });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);
    assert.equal(body.publicProductionAuthorised, false);
    assert.equal(body.reason, 'not-activated');
    assert.equal(body.personalProductionAuthorised, false);
    assert.equal(body.personalReason, 'not-activated');
    assert.equal(body.requestedAudience, 'personal');
    assert.equal(body.requestNonce, nonce);
    const timestamp = res.headers.get('x-nova-capacity-timestamp');
    const signature = res.headers.get('x-nova-capacity-signature');
    assert.match(timestamp ?? '', /^[0-9]+$/);
    assert.match(signature ?? '', /^[0-9a-f]{64}$/i);
    const verified = verifyCapacityResponse({
      signingSecret: TEST_SIGNING_SECRET,
      timestamp,
      signature,
      requestNonce: nonce,
      expectedAudience: 'personal',
      bodyText,
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.body, body);
  } finally {
    await cleanup();
  }
});

test('(u6) capacity route: unsigned request is 401; bad audience and bad nonce are 400', async (t) => {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  const { api, cleanup } = await makeApi({
    mode: 'production',
    executor: false,
    activationConfigPath: confPath,
    signingSecret: TEST_SIGNING_SECRET,
  });
  try {
    const { port } = await api.start();
    await awaitPastStartSecond();
    const nonce = randomBytes(16).toString('hex');
    const unauth = await fetch(`http://127.0.0.1:${port}/internal/capacity?audience=personal&requestNonce=${nonce}`);
    assert.equal(unauth.status, 401);
    const badAudiencePath = `/internal/capacity?audience=owner&requestNonce=${nonce}`;
    const badAudience = await fetch(`http://127.0.0.1:${port}${badAudiencePath}`, {
      headers: signApiCall('test-secret', TEST_SIGNING_SECRET, 'GET', badAudiencePath, ''),
    });
    assert.equal(badAudience.status, 400);
    const badNoncePath = '/internal/capacity?audience=personal&requestNonce=xyz';
    const badNonce = await fetch(`http://127.0.0.1:${port}${badNoncePath}`, {
      headers: signApiCall('test-secret', TEST_SIGNING_SECRET, 'GET', badNoncePath, ''),
    });
    assert.equal(badNonce.status, 400);
  } finally {
    await cleanup();
  }
});

test('(u6) capacity route: a process without a signing secret authenticates nothing (401), never unsigned', async (t) => {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  const { api, cleanup } = await makeApi({
    mode: 'controlled-test',
    activationConfigPath: confPath,
    // No signingSecret: controlled-test mode may start without one.
  });
  try {
    const { port } = await api.start();
    const nonce = randomBytes(16).toString('hex');
    const pathWithQuery = `/internal/capacity?audience=public&requestNonce=${nonce}`;
    // The request is signed by hand in the legacy single-secret shape
    // (HMAC keyed by the transport secret): signApiCall would throw
    // without a signing secret, and the legacy shape must NOT verify.
    // Request auth fails closed with 401 before the route is reached —
    // the route-level 503 (capacity-unavailable) is defence in depth
    // for a process without a signing secret, unreachable while request
    // auth requires one. Either way the process serves nothing unsigned.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = createHash('sha256').update('', 'utf8').digest('hex');
    const canonical = ['GET', pathWithQuery, timestamp, nonce, bodyHash].join('\n');
    const signature = createHmac('sha256', 'test-secret').update(canonical, 'utf8').digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}${pathWithQuery}`, {
      headers: {
        'X-NOVA-API-SECRET': 'test-secret',
        'X-NOVA-SIGNATURE': signature,
        'X-NOVA-TIMESTAMP': timestamp,
        'X-NOVA-NONCE': nonce,
        'Content-Type': 'application/json',
      },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorised' });
  } finally {
    await cleanup();
  }
});

test('(u6) production mode without a signing secret fails at startup', async (t) => {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  assert.throws(() => createApiServer({
    mode: 'production',
    secret: 'test-secret',
    dataDir: dir,
    activationConfigPath: confPath,
    d1Client: { d1Apply: async () => ({}), d1Read: async () => null },
  }), /NOVA_SIGNING_SECRET is required in production mode/);
});

test('(u6) malformed activation config fails at startup', async (t) => {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir, 'NOVA_PERSONAL_PRODUCTION_ACTIVATED=yes\n');
  assert.throws(() => createApiServer({
    mode: 'controlled-test',
    secret: 'test-secret',
    dataDir: dir,
    activationConfigPath: confPath,
    executor: null,
    d1Client: { d1Apply: async () => ({}), d1Read: async () => null },
  }), /must be exactly "true" or "false"/);
});

// -- (u7) submit-time gates (§6) ----------------------------------------------

function personalApi(t, { personalFlag = true, seedHeartbeat = true } = {}) {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir,
    `NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=${personalFlag}\n`);
  // The test data dir lives on /tmp (a 512 MB tmpfs, ~485 MB free) —
  // below the 500 MB storage safety margin, so the real capacity probe
  // would honestly report storage-full and no personal submit could
  // authorise. The engine's own capacityProbe injection (documented in
  // engine.js: injectable so tests can simulate disk states without
  // filling one) reports ample space; the storage-full path itself is
  // covered by the storageHealth unit tests above. The store root is
  // created up front so the writability check reads a real directory.
  const storeRoot = path.join(dir, 'store');
  fs.mkdirSync(storeRoot, { recursive: true });
  const storage = createStorage({
    rootDir: storeRoot,
    capacityProbe: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
  });
  return makeApi({
    mode: 'production',
    executor: false,
    activationConfigPath: confPath,
    signingSecret: TEST_SIGNING_SECRET,
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    kaggleCredentialPresent: true,
    personalExecutor: 'kaggle-t4',
    seedHeartbeat,
    storage,
  });
}

function personalBody(label, overrides = {}) {
  const body = submitBody(label);
  return {
    ...body,
    deploymentMode: 'production',
    audience: 'personal',
    // Round 2: no nonCommercialAttested boolean is sent — the API never
    // trusts one and generates its own signed attestation server-side.
    // The explicit purpose + the Worker-asserted ownerTokenId are what
    // the submit carries.
    nonCommercialPurpose: 'proof',
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    ...overrides,
  };
}

test('(u7) an incoming boolean is not an attestation: purpose and token id are what matter', async (t) => {
  const { api, d1, cleanup } = await personalApi(t);
  try {
    // A nonCommercialAttested boolean — true or false — is ignored
    // outright: with a valid purpose + token id the submit is accepted
    // (the server generates its own attestation), and without a purpose
    // it is refused even when the boolean claims attestation.
    const booleanFalse = personalBody('m2p-bool-false', { nonCommercialAttested: false });
    seedJobForSubmit(d1, booleanFalse);
    const r0 = await api.dispatch.submitExecutions(booleanFalse);
    assert.equal(r0.status, 202);

    const booleanTrueNoPurpose = personalBody('m2p-bool-no-purpose', { nonCommercialAttested: true });
    delete booleanTrueNoPurpose.nonCommercialPurpose;
    seedJobForSubmit(d1, booleanTrueNoPurpose);
    const r1 = await api.dispatch.submitExecutions(booleanTrueNoPurpose);
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'invalid-submit');

    const noPurpose = personalBody('m2p-no-purpose', { nonCommercialPurpose: 'monetised-film' });
    seedJobForSubmit(d1, noPurpose);
    const r2 = await api.dispatch.submitExecutions(noPurpose);
    assert.equal(r2.status, 400);

    const noToken = personalBody('m2p-no-token', { ownerTokenId: '' });
    seedJobForSubmit(d1, noToken);
    const r3 = await api.dispatch.submitExecutions(noToken);
    assert.equal(r3.status, 400);

    const wrongToken = personalBody('m2p-wrong-token', { ownerTokenId: 'owner-token-v2' });
    seedJobForSubmit(d1, wrongToken);
    const r4 = await api.dispatch.submitExecutions(wrongToken);
    assert.equal(r4.status, 400);
  } finally {
    await cleanup();
  }
});

test('(u7) personal submit in production mode without an audience is refused 400', async (t) => {
  const { api, d1, cleanup } = await personalApi(t);
  try {
    const body = personalBody('m2p-no-audience');
    delete body.audience;
    seedJobForSubmit(d1, body);
    const r = await api.dispatch.submitExecutions(body);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /audience is required/);
  } finally {
    await cleanup();
  }
});

test('(u7) personal submit with an explicit purpose is accepted (202) and the job + journal carry the server-generated signed attestation', async (t) => {
  const { api, d1, cleanup } = await personalApi(t);
  try {
    const body = personalBody('m2p-attested');
    seedJobForSubmit(d1, body);
    const r = await api.dispatch.submitExecutions(body);
    assert.equal(r.status, 202);
    // The manager job carries the audience and the SERVER-GENERATED
    // signed attestation in params — never an incoming boolean.
    const jobs = api.manager.store.state.jobs ?? {};
    const stored = Object.values(jobs).find((j) => j.params?.executionId === `${body.jobId}:scene-0:attempt-1`);
    assert.ok(stored, 'manager job exists');
    assert.equal(stored.params.audience, 'personal');
    assert.equal(stored.params.nonCommercialAttested, undefined);
    assert.equal(stored.params.nonCommercialPurpose, 'proof');
    assert.equal(stored.params.ownerTokenId, TEST_OWNER_TOKEN_ID);
    const attestation = stored.params.personalAttestation;
    assert.ok(attestation, 'signed attestation exists on the job');
    assert.equal(attestation.version, 1);
    assert.equal(attestation.audience, 'personal');
    assert.equal(attestation.purpose, 'proof');
    assert.equal(attestation.jobId, body.jobId);
    assert.equal(attestation.ownerTokenId, TEST_OWNER_TOKEN_ID);
    assert.equal(attestation.nonCommercial, true);
    assert.match(attestation.signature, /^[0-9a-f]{64}$/);
    // The attestation verifies under the API host's signing secret.
    const { verifyPersonalAttestation } = await import('../src/api-server/attestation.js');
    assert.equal(verifyPersonalAttestation(attestation, {
      ownerTokenId: TEST_OWNER_TOKEN_ID,
      purpose: ['test', 'proof', 'benchmark', 'experiment', 'own-non-monetised-film'],
      recordedPurpose: 'proof',
      jobId: body.jobId,
    }, [TEST_SIGNING_SECRET]), true);
    // The journal entry records the same attestation (§12 audit record).
    const entry = api.dispatch.journalEntry(`${body.jobId}:scene-0:attempt-1`);
    assert.ok(entry, 'journal entry exists');
    assert.equal(entry.audience, 'personal');
    assert.equal(entry.nonCommercialAttested, undefined);
    assert.deepEqual(entry.personalAttestation, attestation);
    assert.equal(entry.nonCommercialPurpose, 'proof');
    assert.equal(entry.ownerTokenId, TEST_OWNER_TOKEN_ID);
  } finally {
    await cleanup();
  }
});

test('(u7) personal submit while the personal flag is off is refused 503 no-capacity (flag revalidated at acceptance)', async (t) => {
  const { api, d1, cleanup } = await personalApi(t, { personalFlag: false });
  try {
    const body = personalBody('m2p-flag-off');
    seedJobForSubmit(d1, body);
    const r = await api.dispatch.submitExecutions(body);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-capacity');
  } finally {
    await cleanup();
  }
});

test('(u7) public submit in production mode is refused 503 no-capacity — no permitted provider is registered, and public never reaches the personal executor', async (t) => {
  const { api, d1, cleanup } = await personalApi(t);
  try {
    const body = personalBody('m2p-public', { audience: 'public' });
    delete body.nonCommercialPurpose;
    delete body.ownerTokenId;
    seedJobForSubmit(d1, body);
    const r = await api.dispatch.submitExecutions(body);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-capacity');
    // No job was created for the public submit: nothing reached the
    // personal executor through the public path.
    const jobs = api.manager.store.state.jobs ?? {};
    assert.equal(Object.keys(jobs).length, 0);
  } finally {
    await cleanup();
  }
});

test('(u7) kill-switch engaged: capacity reports kill-switch-engaged for both modes and personal submit is refused', async (t) => {
  const { api, d1, cleanup } = await personalApi(t);
  try {
    const { engageKillSwitch, disengageKillSwitch } = await import('../src/kill-switch.js');
    engageKillSwitch(api.manager.store.state, 'test', Date.now());
    const body = await api.activation.computeCapacity({ audience: 'personal', requestNonce: 'b'.repeat(32) });
    assert.equal(body.personalReason, 'kill-switch-engaged');
    assert.equal(body.reason, 'kill-switch-engaged');
    const submit = personalBody('m2p-kill-switch');
    seedJobForSubmit(d1, submit);
    const r = await api.dispatch.submitExecutions(submit);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-capacity');
    disengageKillSwitch(api.manager.store.state, 'test', Date.now());
    const after = await api.activation.computeCapacity({ audience: 'personal', requestNonce: 'b'.repeat(32) });
    assert.equal(after.personalProductionAuthorised, true);
  } finally {
    await cleanup();
  }
});

// -- (v) install leg ----------------------------------------------------------

test('(v) install.sh chmods the two top install dirs after the staged-tree sync', () => {
  const script = fs.readFileSync(new URL('../systemd/install.sh', import.meta.url), 'utf8');
  const syncAt = script.indexOf('staged tree synced');
  assert.ok(syncAt > 0, 'staged-tree sync marker exists');
  const chmodAt = script.indexOf('chmod 0755 /opt/nova-ai-studio /opt/nova-ai-studio/gpu-cloud');
  assert.ok(chmodAt > syncAt, 'explicit chmod of the two top dirs follows the staged-tree sync');
});

test('(v) install.sh still ends with the sendmail check (exit 1 solely on sendmail = expected success)', () => {
  const script = fs.readFileSync(new URL('../systemd/install.sh', import.meta.url), 'utf8');
  assert.match(script, /sendmail check/);
  assert.match(script, /systemctl daemon-reload/);
});
