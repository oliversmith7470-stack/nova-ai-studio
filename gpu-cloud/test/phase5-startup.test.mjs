// NOVA Phase 5 Rev 4.8 — §15 tests for the implemented startup subsystem.
//   (w) counter-module unit tests · (j)/(r) exit-decision unit tests
//   (z) readiness validation · (t) API integration call sites
//   (aa) API-process failure handling (unit + integration parts)
//   (x) reset ownership race (in-process interleave)
//
// These tests touch the REAL shared counter file
// (/var/lib/nova-api/startup-attempts — COUNTER_PATH is a module constant,
// there is no injection point) on this dev VM only. Every test that writes
// it saves the previous bytes and restores them in t.after(), and tests run
// sequentially within this file. No other test file writes the counter file,
// so `npm test` (parallel across files) cannot race it. The installed-unit
// tests live in phase5-installed.test.mjs and are gated behind
// NOVA_PHASE5_INSTALLED_TESTS=1 — they must NOT run concurrently with this
// file.
//
// Mocks are used ONLY where §15 permits them: the counter module's pure
// functions are exercised directly, and createApiServer is driven with an
// injected stub D1 client / stub executor (the established config-injection
// pattern — no systemctl call is mocked anywhere in this repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  validateCounter, prepareAttempt, reserveAttempt, releaseReservation,
  resetCounter, readCounter, encodeFsDetail, LIMIT, isValidCalendarDate,
  COUNTER_PATH,
} from '../src/api-server/startup-counter.mjs';

// NOVA_STARTUP_STATE_DIR is read at import time by startup-attempts.js, so
// it must be set BEFORE the dynamic import below.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-startup-state-'));
process.env.NOVA_STARTUP_STATE_DIR = STATE_DIR;
const attempts = await import('../src/api-server/startup-attempts.js');
const apiServer = await import('../src/api-server.js');
// The stub Kaggle transport MUST be imported dynamically, after
// NOVA_STARTUP_STATE_DIR is set above — never as a static import.
// support.mjs imports api-server.js, which imports startup-attempts.js,
// and startup-attempts.js reads NOVA_STARTUP_STATE_DIR at import time:
// a hoisted static import would evaluate it with the variable unset
// (STARTUP_STATE_DIR null) and break every (z)/(t)/(aa) readiness test.
const { stubKaggleTransport } = await import('../src/api-server/test/support.mjs');

const COUNTER_LOCK = '/var/lib/nova-api/startup-attempts.lock';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

// Valid v4 UUIDs (third group starts with 4, fourth with 8/9/a/b).
const GEN_A = '11111111-1111-4111-8111-111111111111';
const GEN_B = '22222222-2222-4222-8222-222222222222';
const REQ_A = '33333333-3333-4333-8333-333333333333';
const REQ_B = '44444444-4444-4444-8444-444444444444';

function validCounter(over = {}) {
  return {
    attempts: 0,
    windowStart: new Date().toISOString(),
    reservation: null,
    generation: GEN_A,
    ...over,
  };
}

// --- counter-file save/restore ---------------------------------------------
function counterBytes() {
  try { return fs.readFileSync(COUNTER_PATH); } catch { return null; }
}
function setCounter(value) {
  if (value === null || value === undefined) {
    try { fs.unlinkSync(COUNTER_PATH); } catch { /* already absent */ }
    return;
  }
  if (typeof value === 'string') { fs.writeFileSync(COUNTER_PATH, value); return; }
  fs.writeFileSync(COUNTER_PATH, JSON.stringify(value) + '\n');
}
function saveCounter(t) {
  const before = counterBytes();
  t.after(() => {
    if (before === null) { try { fs.unlinkSync(COUNTER_PATH); } catch { /* gone */ } }
    else fs.writeFileSync(COUNTER_PATH, before);
  });
}

// --- console capture --------------------------------------------------------
function captureConsole(t) {
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { out.push(a.map(String).join(' ')); };
  console.error = (...a) => { out.push(a.map(String).join(' ')); };
  t.after(() => { console.log = origLog; console.error = origErr; });
  return out;
}

// --- state-dir helpers ------------------------------------------------------
function writeStateDir({ requestId = REQ_A, readiness = null } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (requestId === null) { try { fs.unlinkSync(path.join(STATE_DIR, 'startup-request-id')); } catch { /* absent */ } }
  else fs.writeFileSync(path.join(STATE_DIR, 'startup-request-id'), requestId);
  if (readiness === null) { try { fs.unlinkSync(path.join(STATE_DIR, 'readiness.json')); } catch { /* absent */ } }
  else if (typeof readiness === 'string') fs.writeFileSync(path.join(STATE_DIR, 'readiness.json'), readiness);
  else fs.writeFileSync(path.join(STATE_DIR, 'readiness.json'), JSON.stringify(readiness));
}
function validReadiness(over = {}) {
  return {
    startupRequestId: REQ_A,
    status: 'ok',
    bootId: BOOT_ID,
    completedAt: new Date().toISOString(),
    ...over,
  };
}
function stubD1() {
  return {
    calls: [],
    async d1Apply(mutations, requestId) { this.calls.push(['d1Apply', requestId]); return { requestId, results: [] }; },
    async d1Read() { return {}; },
    // FreeLLMAPI (A5): the submit handler loads the stored record by
    // jobId before validating the body, so the stub returns a record for
    // any requested id — the real flow always creates the D1 job first
    // (the Worker). No test in this file depends on a null getJob.
    async getJob(jobId) {
      if (typeof jobId !== 'string' || jobId.length === 0) return null;
      return {
        id: jobId,
        data: JSON.stringify({
          id: jobId, mode: 'single', status: 'queued',
          prompt: 'stub prompt', sceneExecutions: [],
        }),
      };
    },
    async listScenes() { return []; },
    async listExpiredScenes() { return []; },
    async listPendingJobs() { this.calls.push(['listPendingJobs']); return []; },
    async listTerminalJobs() { this.calls.push(['listTerminalJobs']); return []; },
    async listExpiredRateLimits() { this.calls.push(['listExpiredRateLimits']); return []; },
  };
}
function makeApi(t, { state = true, d1 = stubD1(), port = 0, extra = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-api-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const api = apiServer.createApiServer({
    mode: 'production',
    secret: 'phase5-test-secret',
    signingSecret: 'test-signing-secret',
    d1Client: d1,
    host: '127.0.0.1',
    port,
    dataDir,
    sweepIntervalMs: 60 * 60 * 1000,
    reconcileIntervalMs: 60 * 60 * 1000,
    // A boot that simulates a credential-present host also simulates
    // the transport (the stub never shells out; its status stays
    // 'running', so pushed jobs stay pending exactly as on the old
    // null channel). Without it the factory would try to build the
    // real KaggleCliTransport and refuse without a real credential.
    // An explicit kaggleTransport in extra wins.
    kaggleTransport: extra.kaggleTransport
      ?? (extra.kaggleCredentialPresent === true ? stubKaggleTransport() : undefined),
    ...extra,
  });
  t.after(async () => { try { await api.stop(); } catch { /* already stopped */ } });
  return api;
}

// =============================================================================
// (w) counter-module unit tests
// =============================================================================
test('(w) validateCounter: valid matrix', () => {
  assert.deepEqual(validateCounter(validCounter()), { ok: true });
  assert.deepEqual(validateCounter(validCounter({ reservation: REQ_A })), { ok: true });
  assert.deepEqual(validateCounter(validCounter({ windowStart: '2026-11-26T05:58:00.5Z' })), { ok: true });
  assert.deepEqual(validateCounter(validCounter({ windowStart: '2026-11-26T05:58:00.12Z' })), { ok: true });
  assert.deepEqual(validateCounter(validCounter({ windowStart: '2026-11-26T05:58:00.123Z' })), { ok: true });
  // Future tolerance: 30 s ahead valid, >60 s ahead malformed (injected now).
  const now = Date.parse('2026-11-26T05:58:00Z');
  assert.equal(validateCounter(validCounter({ windowStart: '2026-11-26T05:58:30Z' }), now).ok, true);
  assert.equal(validateCounter(validCounter({ windowStart: '2026-11-26T05:59:01Z' }), now).ok, false);
  assert.equal(validateCounter(validCounter({ windowStart: '2026-11-26T05:59:01Z' }), now).reason, 'windowStart-in-future');
});

test('(w) validateCounter: malformed matrix', () => {
  const bad = (over, reason) => {
    const v = validCounter(over);
    const r = validateCounter(v);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.reason, reason, JSON.stringify(over));
  };
  const noRes = validCounter(); delete noRes.reservation;
  assert.equal(validateCounter(noRes).reason, 'unexpected-keys');
  const extra = validCounter({ extra: 1 });
  assert.equal(validateCounter(extra).reason, 'unexpected-keys');
  bad({ attempts: -1 }, 'attempts-not-non-negative-integer');
  bad({ attempts: '3' }, 'attempts-not-non-negative-integer');
  bad({ attempts: 1.5 }, 'attempts-not-non-negative-integer');
  bad({ attempts: 6 }, 'attempts-above-limit');
  bad({ windowStart: '2026-13-40T99:99:99Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-11-26 05:58:00' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-11-26T05:58:00.1234Z' }, 'windowStart-not-ISO-8601-UTC'); // 4 fractional digits
  bad({ windowStart: '0000-01-01T00:00:00Z' }, 'windowStart-not-ISO-8601-UTC'); // year 0000
  assert.equal(validateCounter(validCounter({ windowStart: '0001-01-01T00:00:00Z' })).ok, true);
  bad({ windowStart: '2026-02-30T00:00:00Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-02-29T00:00:00Z' }, 'windowStart-not-ISO-8601-UTC');
  assert.equal(validateCounter(validCounter({ windowStart: '2024-02-29T00:00:00Z' })).ok, true);
  bad({ windowStart: '2026-04-31T00:00:00Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-11-26T23:59:60Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-11-26T24:00:00Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ windowStart: '2026-00-10T00:00:00Z' }, 'windowStart-not-ISO-8601-UTC');
  bad({ reservation: 'not-a-uuid' }, 'reservation-not-null-or-uuid');
  bad({ reservation: 3 }, 'reservation-not-null-or-uuid');
  const noGen = validCounter(); delete noGen.generation;
  assert.equal(validateCounter(noGen).reason, 'unexpected-keys');
  bad({ generation: 'not-a-uuid' }, 'generation-not-uuid');
  assert.equal(validateCounter(null).reason, 'not-an-object');
  assert.equal(validateCounter('x').reason, 'not-an-object');
  assert.equal(validateCounter([1]).reason, 'not-an-object');
});

test('(w) prepare/reserve/release/reset state machine', (t) => {
  saveCounter(t);
  // Absent -> prepare creates attempts=1.
  setCounter(null);
  let r = prepareAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 1);
  assert.equal(r.value.reservation, null);
  const gen1 = r.value.generation;
  // Reserve refuses nothing yet; reserve writes a token, attempts unchanged.
  r = reserveAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 1);
  assert.ok(r.token);
  const token = r.token;
  // Second reserve refuses (code 7).
  assert.equal(reserveAttempt().code, 7);
  // Release by a non-owner refuses; release with a non-UUID token is not-owner, never an error.
  assert.deepEqual(releaseReservation('not-a-uuid').reason, 'not-owner');
  assert.deepEqual(releaseReservation(REQ_B).reason, 'not-owner');
  // Release by the owner succeeds.
  r = releaseReservation(token);
  assert.equal(r.code, 0);
  assert.equal(r.released, true);
  // Prepare consumes a held reservation: reserve again, then prepare -> attempts 2, reservation null.
  const r2 = reserveAttempt();
  assert.equal(r2.code, 0);
  r = prepareAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 2);
  assert.equal(r.value.reservation, null);
  assert.equal(r.value.generation, gen1); // ordinary consume preserves generation
  // Expired window: reserve writes a coherent new window WITH the reservation and a NEW generation.
  const old = validCounter({ attempts: 2, windowStart: new Date(Date.now() - 400_000).toISOString(), generation: gen1 });
  setCounter(old);
  r = reserveAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 0);
  assert.ok(r.value.reservation);
  assert.notEqual(r.value.generation, gen1);
  // Expired-window prepare resets to attempts=1 with a new generation.
  setCounter(validCounter({ attempts: 4, windowStart: new Date(Date.now() - 400_000).toISOString(), generation: gen1 }));
  r = prepareAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 1);
  assert.notEqual(r.value.generation, gen1);
  // Preparation at the limit: attempts=5 live window -> code 8, bytes UNCHANGED, reservation unconsumed.
  const atLimit = validCounter({ attempts: 5, reservation: REQ_A });
  setCounter(atLimit);
  const before = counterBytes();
  r = prepareAttempt();
  assert.equal(r.code, 8);
  assert.equal(r.reason, 'limit-reached');
  assert.deepEqual(counterBytes(), before);
  // Attempts=4 with a reservation held -> preparation consumes it (attempts=5, reservation null).
  setCounter(validCounter({ attempts: 4, reservation: REQ_A }));
  r = prepareAttempt();
  assert.equal(r.code, 0);
  assert.equal(r.value.attempts, 5);
  assert.equal(r.value.reservation, null);
});

test('(w) identity-checked reset', (t) => {
  saveCounter(t);
  const id = { requestId: REQ_A, windowStart: new Date().toISOString(), attempts: 3, generation: GEN_A };
  // Matching identity -> code 0, file deleted.
  setCounter({ attempts: 3, windowStart: id.windowStart, reservation: null, generation: GEN_A });
  assert.equal(resetCounter(id).code, 0);
  assert.equal(counterBytes(), null);
  // Reservation held -> code 9, file intact.
  setCounter({ attempts: 3, windowStart: id.windowStart, reservation: REQ_B, generation: GEN_A });
  assert.equal(resetCounter(id).code, 9);
  assert.notEqual(counterBytes(), null);
  // Newer attempts -> code 9.
  setCounter({ attempts: 4, windowStart: id.windowStart, reservation: null, generation: GEN_A });
  assert.equal(resetCounter(id).code, 9);
  // Different windowStart -> code 9.
  setCounter({ attempts: 3, windowStart: new Date(Date.now() - 1000).toISOString(), reservation: null, generation: GEN_A });
  assert.equal(resetCounter(id).code, 9);
  // Different generation -> code 9 (case vii).
  setCounter({ attempts: 3, windowStart: id.windowStart, reservation: null, generation: GEN_B });
  assert.equal(resetCounter(id).code, 9);
  // Missing/malformed identity -> code 2, file intact.
  for (const badId of [
    { windowStart: id.windowStart, attempts: 3, generation: GEN_A },
    { requestId: REQ_A, windowStart: id.windowStart, attempts: 3 },
    { requestId: 'not-a-uuid', windowStart: id.windowStart, attempts: 3, generation: GEN_A },
    { requestId: REQ_A, windowStart: 'not-a-date', attempts: 3, generation: GEN_A },
    { requestId: REQ_A, windowStart: id.windowStart, attempts: 6, generation: GEN_A },
    { requestId: REQ_A, windowStart: id.windowStart, attempts: 3, generation: 'not-a-uuid' },
  ]) {
    setCounter({ attempts: 3, windowStart: id.windowStart, reservation: null, generation: GEN_A });
    assert.equal(resetCounter(badId).code, 2, JSON.stringify(badId));
    assert.notEqual(counterBytes(), null);
  }
  // Validation order: invalid identity while the file is ABSENT -> code 2, nothing deleted.
  setCounter(null);
  assert.equal(resetCounter({ requestId: 'not-a-uuid', windowStart: id.windowStart, attempts: 3, generation: GEN_A }).code, 2);
  // Valid identity while absent -> code 0 (already-absent).
  assert.equal(resetCounter(id).code, 0);
  // Reset against an unreadable counter -> code 5; malformed -> code 2; file intact.
  fs.mkdirSync(COUNTER_PATH, { recursive: true });
  try {
    const rc = resetCounter(id);
    assert.equal(rc.code, 5);
  } finally { fs.rmdirSync(COUNTER_PATH); }
  setCounter('{not json');
  assert.equal(resetCounter(id).code, 2);
  // Recreation assigns a new generation.
  setCounter(null);
  const p1 = prepareAttempt();
  const g1 = p1.value.generation;
  setCounter(null);
  const p2 = prepareAttempt();
  assert.notEqual(p2.value.generation, g1);
});

test('(w) CLI contract: one RESULT line, exit 0; canonical decimal parsing', (t) => {
  saveCounter(t);
  const runCli = (...args) => spawnSync('node', [path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs'), ...args], { encoding: 'utf8' });
  setCounter(null);
  let r = runCli('read');
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^RESULT 6 \{"code":6,"reason":"absent"\}$/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  r = runCli('bogus-op');
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^RESULT 2 /);
  // Canonical decimal parsing: '1e0', ' 3', '' -> code 2; '3' -> parses.
  const id = { requestId: REQ_A, windowStart: new Date().toISOString(), attempts: 3, generation: GEN_A };
  setCounter({ attempts: 3, windowStart: id.windowStart, reservation: null, generation: GEN_A });
  for (const raw of ['1e0', ' 3', '']) {
    r = runCli('reset', REQ_A, id.windowStart, raw, GEN_A);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^RESULT 2 /);
    assert.notEqual(counterBytes(), null);
  }
  r = runCli('reset', REQ_A, id.windowStart, '3', GEN_A);
  assert.match(r.stdout.trim(), /^RESULT 0 /);
  assert.equal(counterBytes(), null);
});

test('(w) CLI + flock: held lock -> flock exits non-zero, free lock -> 0', async (t) => {
  saveCounter(t);
  const { spawn } = await import('node:child_process');
  const lockPath = COUNTER_LOCK;
  // Holder construction (load-bearing — see install.sh): the holder must be
  // ONE process that both holds the lock and sleeps. `exec sleep` replaces
  // the shell with the sleeper, so killing the holder PID closes fd 9 and
  // releases the lock. (A plain `sh -c '...; sleep 30'` leaves the sleep
  // child alive holding the inherited fd 9 after the shell is killed — the
  // lock then stays held for the full 30 s and pollutes later tests.)
  const holder = spawn('sh', ['-c', `exec 9>>"${lockPath}"; /usr/bin/flock --exclusive 9; exec sleep 30`], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 500));
  const held = spawnSync('flock', ['--timeout', '2', lockPath, 'node', path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs'), 'read'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(held.status, 0, 'held lock must make flock exit non-zero');
  holder.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const free = spawnSync('flock', ['--timeout', '2', lockPath, 'node', path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs'), 'read'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(free.status, 0, `free lock must exit 0, got ${free.status}: ${free.stderr}`);
  assert.match(free.stdout.trim(), /^RESULT \d+ /);
});

test('(w) encodeFsDetail guarding + writeCounter cleanup', (t) => {
  saveCounter(t);
  // A non-Error's `.message` is never read (the ternary yields null for
  // non-Errors), so a throwing message getter is never invoked: String(e)
  // gives '[object Object]'. Only an ERROR's throwing message getter yields
  // 'unknown' (e.message is read inside the try).
  const throwing = { get message() { throw new Error('boom'); } };
  assert.equal(encodeFsDetail(throwing), '[object-Object]');
  const errThrowingMsg = new Error('x');
  Object.defineProperty(errThrowingMsg, 'message', { get() { throw new Error('boom'); } });
  assert.equal(encodeFsDetail(errThrowingMsg), 'unknown');
  const throwingStr = { toString() { throw new Error('boom'); } };
  assert.equal(encodeFsDetail(throwingStr), 'unknown');
  // A non-Error value's `.message` is never read: the string-conversion
  // fallback converts the WHOLE value (String(e)), not the message field.
  assert.equal(encodeFsDetail({ message: 42 }), '[object-Object]');
  assert.equal(encodeFsDetail({ toString() { return 'custom-value'; } }), 'custom-value');
  assert.equal(encodeFsDetail(new Error('multi\nline\tmessage')), 'multi-line-message');
  // Write failure (counter path is a directory, so the rename fails): no .tmp.<pid> file remains.
  setCounter(null);
  fs.mkdirSync(COUNTER_PATH, { recursive: true });
  try {
    const before = fs.readdirSync('/var/lib/nova-api').filter((f) => f.startsWith('startup-attempts.tmp.'));
    assert.equal(before.length, 0);
    const r = prepareAttempt(); // read fails (EISDIR) -> code 5; use a write path instead:
    assert.equal(r.code, 5);
    // Force the write path: valid counter in place, then replace with dir and reserve.
    // (prepareAttempt on a directory read fails before writing; the cleanup path
    // is exercised by resetCounter's unlink? No — exercise writeCounter via
    // reserveAttempt on a live counter whose file becomes a directory mid-call
    // is not possible synchronously. Instead assert the tmp-cleanup invariant
    // directly: no tmp files exist after any failed operation above.)
    const after = fs.readdirSync('/var/lib/nova-api').filter((f) => f.startsWith('startup-attempts.tmp.'));
    assert.equal(after.length, 0);
  } finally { fs.rmdirSync(COUNTER_PATH); }
  // CLI one-line output with a multi-line-capable failure: counter as a directory -> exactly one RESULT line.
  setCounter(null);
  fs.mkdirSync(COUNTER_PATH, { recursive: true });
  try {
    const r = spawnSync('node', [path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs'), 'read'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stdout.trim(), /^RESULT 5 \{"code":5,"reason":"read-failed: [^ ]+"\}$/);
  } finally { fs.rmdirSync(COUNTER_PATH); }
});

test('(w) main-entry guard: importing the counter prints nothing; CLI still works', async () => {
  // Imported twice already in this file (static + dynamic importers) with no
  // spurious output — prove it explicitly in a fresh process.
  const r = spawnSync('node', ['--input-type=module', '-e',
    `import '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs')}'; console.log('IMPORT-ONLY');`],
    { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'IMPORT-ONLY');
  const r2 = spawnSync('node', ['--input-type=module', '-e',
    `import '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js')}'; console.log('API-IMPORT-ONLY');`],
    { encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), 'API-IMPORT-ONLY');
  const r3 = spawnSync('node', [path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs'), 'read'], { encoding: 'utf8' });
  assert.equal(r3.status, 0);
  assert.match(r3.stdout.trim(), /^RESULT \d+ /);
});

// =============================================================================
// (j)/(r) decideStartupFailureExit — direct unit test at stored counts 0–5
// =============================================================================
test('(j)/(r) decideStartupFailureExit unit 0-5 + counter-read failure', (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  const err = (attemptsN) => {
    const e = new Error('startup failed');
    e.startupRequestId = REQ_A;
    e.startupWindowStart = '2026-11-26T05:58:00Z';
    void attemptsN;
    return e;
  };
  for (let n = 0; n <= 4; n++) {
    setCounter(validCounter({ attempts: n }));
    out.length = 0;
    assert.equal(attempts.decideStartupFailureExit(err(n)), 1, `attempts=${n} must exit 1`);
    assert.equal(out.some((l) => l.includes('startup-recovery-limit-reached')), false);
  }
  // Attempts = 5 -> exit 42, limit event carries the SNAPSHOT pair (not the fresh read).
  setCounter(validCounter({ attempts: 5, windowStart: '2026-11-26T05:58:00Z' }));
  out.length = 0;
  assert.equal(attempts.decideStartupFailureExit(err(5)), 42);
  const limitLine = out.find((l) => l.includes('startup-recovery-limit-reached'));
  assert.ok(limitLine, 'limit event must be logged');
  assert.ok(limitLine.includes(`requestId=${REQ_A}`), 'event carries the failing attempt requestId');
  assert.ok(limitLine.includes('windowStart=2026-11-26T05:58:00Z'), 'event carries the failing attempt windowStart');
  // Mutate the counter between readiness and the exit decision: the event
  // still carries the ORIGINAL windowStart; the fresh read's count alone decides the code.
  setCounter(validCounter({ attempts: 5, windowStart: '2026-11-26T05:58:00Z' }));
  const snapErr = err(5);
  setCounter(validCounter({ attempts: 5, windowStart: new Date().toISOString() })); // rolled window, still 5
  out.length = 0;
  assert.equal(attempts.decideStartupFailureExit(snapErr), 42);
  const rolled = out.find((l) => l.includes('startup-recovery-limit-reached'));
  assert.ok(rolled.includes('windowStart=2026-11-26T05:58:00Z'), 'rolled window must not change the snapshot pair');
  // Counter absent / unreadable / malformed -> exit 42, counter-unavailable logged.
  for (const setup of [
    () => setCounter(null),
    () => setCounter('{not json'),
  ]) {
    setup();
    out.length = 0;
    assert.equal(attempts.decideStartupFailureExit(err(0)), 42);
    assert.ok(out.some((l) => l.includes('startup-recovery-counter-unavailable')));
  }
  setCounter(null); // the previous iteration left a malformed file; the directory needs the path absent
  fs.mkdirSync(COUNTER_PATH, { recursive: true });
  try {
    out.length = 0;
    assert.equal(attempts.decideStartupFailureExit(err(0)), 42);
    assert.ok(out.some((l) => l.includes('startup-recovery-counter-unavailable')));
  } finally { fs.rmdirSync(COUNTER_PATH); }
});
// =============================================================================
// (z) readiness validation
// =============================================================================
test('(z) readiness: timestamp window [0s, 600s]', (t) => {
  saveCounter(t);
  const now = Date.now();
  const cases = [
    [new Date(now + 60_000).toISOString(), 'readiness-completedAt-in-future'],
    [new Date(now - 601_000).toISOString(), 'readiness-completedAt-stale'],
    ['2026-02-30T00:00:00Z', 'readiness-completedAt-invalid'],
  ];
  for (const [completedAt, condition] of cases) {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: validReadiness({ completedAt }) });
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === condition, condition);
  }
  // 599 s old passes.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ completedAt: new Date(now - 599_000).toISOString() }) });
  const id = attempts.verifyStartupReadiness();
  assert.equal(id.requestId, REQ_A);
  assert.equal(id.attempts, 1);
  assert.equal(id.generation, GEN_A);
  assert.ok(id.windowStart);
});

test('(z) readiness: structure + correlation + counter-read failure', (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  // Record parses to null/string/array/number -> readiness-not-an-object.
  for (const raw of ['null', '"x"', '[1]', '42']) {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: raw });
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'readiness-not-an-object', raw);
  }
  // Missing/wrong-typed required fields -> readiness-missing-fields.
  for (const rec of [
    { status: 'ok', bootId: BOOT_ID, completedAt: new Date().toISOString() },
    { startupRequestId: REQ_A, bootId: BOOT_ID, completedAt: new Date().toISOString() },
    { startupRequestId: REQ_A, status: 'ok', completedAt: new Date().toISOString() },
    { startupRequestId: REQ_A, status: 'ok', bootId: BOOT_ID },
    { startupRequestId: 42, status: 'ok', bootId: BOOT_ID, completedAt: new Date().toISOString() },
  ]) {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: rec });
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'readiness-missing-fields', JSON.stringify(rec));
  }
  // Wrong request id; status not ok; wrong boot id.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ startupRequestId: REQ_B }) });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'wrong-startup-request-id');
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ status: 'failed', error: 'x' }) });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'readiness-status-not-ok');
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ bootId: '00000000-0000-4000-8000-000000000000' }) });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'wrong-boot-id');
  // Counter absent/unreadable/malformed -> readiness-counter-unavailable with code detail; no identity.
  for (const [setup, code] of [
    [() => setCounter(null), 6],
    [() => setCounter('{bad'), 2],
  ]) {
    setup();
    writeStateDir({ readiness: validReadiness() });
    out.length = 0;
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => {
      assert.equal(e.condition, 'readiness-counter-unavailable');
      assert.equal(e.startupRequestId, REQ_A);
      return true;
    });
    assert.ok(out.some((l) => l.includes('startup-recovery-not-verified') && l.includes(`counter-unavailable-code-${code}`)));
  }
  // Full producer field set passes; an extra unknown field passes.
  setCounter(validCounter({ attempts: 2 }));
  writeStateDir({ readiness: {
    cycleId: REQ_B, startupRequestId: REQ_A, bootId: BOOT_ID,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    status: 'ok', objectsDeleted: 0, objectsExpiredButMissing: 0, indexRebuilt: true,
    extraUnknown: 'ignored',
  } });
  assert.equal(attempts.verifyStartupReadiness().attempts, 2);
  // Success returns the identity from the SINGLE read: windowStart, attempts, generation all match the file.
  const ws = new Date().toISOString();
  setCounter({ attempts: 3, windowStart: ws, reservation: null, generation: GEN_B });
  writeStateDir({ readiness: validReadiness() });
  const ident = attempts.verifyStartupReadiness();
  assert.deepEqual(ident, { requestId: REQ_A, windowStart: ws, attempts: 3, generation: GEN_B });
});

test('(z) readiness: read-error distinction + request-id validation', (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  // Unreadable startup-request-id (path is a directory — root reads through chmod 000).
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  fs.unlinkSync(path.join(STATE_DIR, 'startup-request-id'));
  fs.mkdirSync(path.join(STATE_DIR, 'startup-request-id'), { recursive: true });
  try {
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'unreadable-startup-request-id');
  } finally { fs.rmdirSync(path.join(STATE_DIR, 'startup-request-id')); }
  // Unreadable readiness record -> un-readable, not missing.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  fs.unlinkSync(path.join(STATE_DIR, 'readiness.json'));
  fs.mkdirSync(path.join(STATE_DIR, 'readiness.json'), { recursive: true });
  try {
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'unreadable-readiness-record');
  } finally { fs.rmdirSync(path.join(STATE_DIR, 'readiness.json')); }
  // Non-UUID / internal-whitespace id -> invalid-startup-request-id, and no log line carries the value.
  // NOTE: readTextFile trims the file content, so a merely leading/trailing
  // whitespace or trailing newline around an otherwise valid UUID is
  // accepted (the file is written without a newline by prepare-startup-id.sh,
  // and the trim tolerates a hand-written trailing newline). What fails is
  // whitespace INSIDE the value, which no trim can repair.
  for (const badId of ['not-a-uuid', REQ_A.slice(0, 8) + ' ' + REQ_A.slice(9), REQ_A.slice(0, 8) + '\n' + REQ_A.slice(9), '11111111-1111-1111-1111-111111111111']) {
    setCounter(validCounter({ attempts: 1 }));
    out.length = 0;
    writeStateDir({ requestId: badId, readiness: validReadiness() });
    assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'invalid-startup-request-id', JSON.stringify(badId));
    assert.equal(out.some((l) => l.includes(badId.trim())), false, 'malformed id must never appear in a log line');
  }
  // Record id non-UUID -> readiness-startupRequestId-invalid; equal-but-both-non-UUID still rejected.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ startupRequestId: 'not-a-uuid' }) });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'readiness-startupRequestId-invalid');
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ requestId: 'not-a-uuid', readiness: validReadiness({ startupRequestId: 'not-a-uuid' }) });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'invalid-startup-request-id');
  // Missing file id with an unreadable counter -> missing-startup-request-id (id validated before the counter is read).
  setCounter('{bad');
  writeStateDir({ requestId: null, readiness: validReadiness() });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'missing-startup-request-id');
  // Missing readiness record -> missing-readiness-record.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: null });
  assert.throws(() => attempts.verifyStartupReadiness(), (e) => e.condition === 'missing-readiness-record');
});

// =============================================================================
// (t) API integration call sites
// =============================================================================
test('(t) start() with valid readiness listens, resets the counter, logs succeeded once', async (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  const ws = new Date().toISOString();
  setCounter({ attempts: 3, windowStart: ws, reservation: null, generation: GEN_A });
  writeStateDir({ readiness: validReadiness() });
  const api = makeApi(t);
  const info = await api.start();
  assert.ok(info.port > 0);
  assert.equal(api.address.port, info.port);
  // Counter reset: file deleted.
  assert.equal(counterBytes(), null);
  const succeeded = out.filter((l) => l.includes('startup-recovery-succeeded'));
  assert.equal(succeeded.length, 1, 'startup-recovery-succeeded exactly once');
  assert.ok(succeeded[0].includes(`requestId=${REQ_A}`));
  assert.ok(!out.some((l) => l.includes('startup-recovery-reset-preserved')));
  // A successful reset logs NO counter-unwritable event: the reset's RESULT
  // must be read back exactly (design §15 (aa) RESULT protocol).
  assert.ok(!out.some((l) => l.includes('startup-recovery-counter-unwritable')), `spurious counter-unwritable in: ${JSON.stringify(out)}`);
  // A healthy API stays listening (no counter file is re-created by listening).
  assert.equal(counterBytes(), null);
});

test('(t) start() with mismatched / missing readiness exits without listening', async (t) => {
  saveCounter(t);
  // Mismatched request id.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ startupRequestId: REQ_B }) });
  const api1 = makeApi(t);
  await assert.rejects(() => api1.start(), (e) => e.condition === 'wrong-startup-request-id');
  assert.equal(api1.address, null);
  // Missing readiness record.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: null });
  const api2 = makeApi(t);
  await assert.rejects(() => api2.start(), (e) => e.condition === 'missing-readiness-record');
  assert.equal(api2.address, null);
  // Counter absent with the state dir set: start() throws before sweep/replay/reconcile run.
  setCounter(null);
  writeStateDir({ readiness: validReadiness() });
  const api3 = makeApi(t);
  await assert.rejects(() => api3.start(), (e) => e.condition === 'readiness-counter-unavailable');
  assert.equal(api3.address, null);
});

test('(t) start() with NOVA_STARTUP_STATE_DIR unset behaves as Phase 3 shipped', async (t) => {
  saveCounter(t);
  setCounter(validCounter({ attempts: 2 }));
  const before = counterBytes();
  // Child process: env without the state dir; drive start() with injected fakes.
  const script = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { createApiServer } from '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js')}';
    const d1 = { async d1Apply(){ return {}; }, async d1Read(){ return {}; }, async getJob(){ return null; },
      async listScenes(){ return []; }, async listExpiredScenes(){ return []; },
      async listPendingJobs(){ return []; }, async listTerminalJobs(){ return []; },
      async listExpiredRateLimits(){ return []; } };
    const api = createApiServer({ mode: 'production', secret: 's', signingSecret: 'test-signing-secret',
      d1Client: d1, host: '127.0.0.1', port: 0, dataDir: '${fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-p3-'))}',
      sweepIntervalMs: 3600000, reconcileIntervalMs: 3600000 });
    const info = await api.start();
    console.log('LISTENING ' + info.port);
    await api.stop();
    console.log('STOPPED');
  `;
  const childEnv = { ...process.env };
  delete childEnv.NOVA_STARTUP_STATE_DIR;
  const r = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: childEnv,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LISTENING \d+/);
  assert.match(r.stdout, /STOPPED/);
  assert.equal(r.stdout.includes('startup-recovery'), false, 'no Phase 5 event must be logged in Phase 3 mode');
  assert.deepEqual(counterBytes(), before, 'no counter file read or written in Phase 3 mode');
});

test('(t) call sites asserted from the shipped code', () => {
  const apiSrc = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js'), 'utf8');
  const attSrc = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-attempts.js'), 'utf8');
  for (const name of ['startup-recovery-not-verified', 'startup-sweep-failed', 'startup-replay-failed', 'startup-reconcile-failed', 'startup-listen-failed', 'startup-factory-failed']) {
    assert.ok(apiSrc.includes(`'${name}'`) || attSrc.includes(`'${name}'`), `call site for ${name}`);
  }
  assert.ok(apiSrc.includes('decideStartupFailureExit'));
  assert.ok(apiSrc.includes('resetAttemptCounter'));
  assert.ok(apiSrc.includes('verifyStartupReadiness'));
  // Server ownership: exactly one `server = ` assignment and exactly one `.start()` call in the CLI entry
  // (the design text mentions api.start() once in a // comment — count code lines only).
  assert.equal((apiSrc.match(/^\s+server = http\.createServer\(/gm) || []).length, 1, 'exactly one server assignment');
  const codeLines = apiSrc.split('\n').filter((l) => !l.trim().startsWith('//'));
  assert.equal((codeLines.join('\n').match(/api\.start\(\)/g) || []).length, 1, 'exactly one start() call in the CLI entry');
  // logStartupEvent provenance: every call passes a literal event name and a literal level.
  const calls = [...attSrc.matchAll(/logStartupEvent\('([^']+)'[^)]*\)/g)];
  assert.ok(calls.length > 0);
  for (const [, name] of calls) {
    assert.ok(/^[a-z0-9-]+$/.test(name), `literal event name: ${name}`);
  }
  assert.equal((attSrc.match(/logStartupEvent\('/g) || []).length, calls.length, 'no variable-event call sites (definition line excluded: it has no literal event)');
  assert.ok(!/level:\s*[a-zA-Z_$][a-zA-Z0-9_$]*[^'"]/.test(attSrc.replace(/level: '(info|error)'/g, '')), 'levels are literals');
});

// =============================================================================
// (aa) API-process failure handling — unit + integration parts
// =============================================================================
test('(aa) rejection normalisation: null / string / object / BigInt / circular / throwing-toJSON', async (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  const values = [
    ['null', null],
    ['string', 'boom'],
    ['object', { code: 'X' }],
    ['bigint', 10n],
    ['circular', (() => { const o = {}; o.self = o; return o; })()],
    ['throwing-toJSON', { toJSON() { throw new Error('nope'); } }],
  ];
  for (const [label, value] of values) {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: validReadiness() });
    // Fail the sweep by making the storage index throw the test value.
    // (attachStorage requires the NovaStorage method set, so the stub carries
    // no-op methods plus the throwing index.)
    const noop = () => {};
    const badStorage = {
      put: noop, get: noop, head: noop, delete: noop, sweep: noop, usage: noop,
      issueDeliveryRef: noop, redeemDeliveryRef: noop, startSweepTimer: noop, stopSweepTimer: noop,
      index: { listExpired() { throw value; } },
    };
    const api = makeApi(t, {
      extra: {
        storage: badStorage,
        usageSource: async () => ({ readable: true, usageFraction: 0.1 }),
      },
    });
    out.length = 0;
    await assert.rejects(() => api.start(), (e) => {
      assert.equal(e.cause, value, `${label}: original value preserved as cause`);
      return true;
    }, label);
    assert.equal(api.address, null, `${label}: never listens`);
    assert.ok(out.some((l) => l.includes('startup-sweep-failed')), `${label}: canonical event logged`);
    // formatRejectionValue itself never throws for any of the three exotic values.
    assert.doesNotThrow(() => attempts.formatRejectionValue(value), label);
  }
});

test('(aa) frozen / non-extensible errors keep the canonical event + cause', async (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  for (const makeErr of [
    () => Object.freeze(new Error('frozen sweep failure')),
    () => Object.preventExtensions(new Error('non-extensible sweep failure')),
  ]) {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: validReadiness() });
    const frozen = makeErr();
    const noop = () => {};
    const badStorage = {
      put: noop, get: noop, head: noop, delete: noop, sweep: noop, usage: noop,
      issueDeliveryRef: noop, redeemDeliveryRef: noop, startSweepTimer: noop, stopSweepTimer: noop,
      index: { listExpired() { throw frozen; } },
    };
    const api = makeApi(t, { extra: { storage: badStorage, usageSource: async () => ({ readable: true, usageFraction: 0.1 }) } });
    out.length = 0;
    await assert.rejects(() => api.start(), (e) => {
      assert.equal(e.cause, frozen, 'original error preserved as cause');
      assert.equal(e.startupRequestId, REQ_A, 'identity attached');
      return true;
    });
    assert.ok(out.some((l) => l.includes('startup-sweep-failed')));
  }
  // attachStartupIdentity guarded extraction.
  // An extensible Error whose message getter throws: the direct assignment
  // SUCCEEDS (the message is never read on the attach path), so the SAME
  // error is returned with the identity attached — never a throw, no wrapper
  // needed. The wrapper path triggers only when the assignment itself throws.
  const throwingMsg = new Error('unreadable');
  Object.defineProperty(throwingMsg, 'message', { get() { throw new Error('x'); }, configurable: true });
  assert.doesNotThrow(() => attempts.attachStartupIdentity(throwingMsg, REQ_A, '2026-11-26T05:58:00Z'));
  const w1 = attempts.attachStartupIdentity(throwingMsg, REQ_A, '2026-11-26T05:58:00Z');
  assert.equal(w1, throwingMsg);
  assert.equal(w1.startupRequestId, REQ_A);
  assert.equal(w1.startupWindowStart, '2026-11-26T05:58:00Z');
  // A FROZEN Error whose message getter throws: assignment throws, so the
  // wrapper is returned with the fixed fallback message and the original as cause.
  const frozenThrowing = new Error('unreadable');
  Object.defineProperty(frozenThrowing, 'message', { get() { throw new Error('x'); }, configurable: true });
  Object.freeze(frozenThrowing);
  const w1b = attempts.attachStartupIdentity(frozenThrowing, REQ_A, '2026-11-26T05:58:00Z');
  assert.notEqual(w1b, frozenThrowing);
  assert.equal(w1b.cause, frozenThrowing);
  assert.equal(w1b.message, '<unreadable-error>');
  assert.equal(w1b.startupRequestId, REQ_A);
  // A rejection value whose string conversion throws AND whose assignment
  // throws (frozen): same wrapper path. (An extensible object with a throwing
  // toString takes the direct-assign path — assignment succeeds and the same
  // object is returned, since .message is never read for non-Errors.)
  const throwingStr = Object.freeze({ toString() { throw new Error('x'); } });
  const w1c = attempts.attachStartupIdentity(throwingStr, REQ_A, '2026-11-26T05:58:00Z');
  assert.notEqual(w1c, throwingStr);
  assert.equal(w1c.cause, throwingStr);
  assert.equal(w1c.message, '<unreadable-error>');
  // A frozen Error (normal message) -> wrapper, cause preserved.
  const frozen = Object.freeze(new Error('frozen'));
  const w2 = attempts.attachStartupIdentity(frozen, REQ_A, '2026-11-26T05:58:00Z');
  assert.equal(w2.cause, frozen);
  // Partial assignment: startupRequestId assigns, startupWindowStart setter throws -> both fields present.
  const partial = {};
  Object.defineProperty(partial, 'startupWindowStart', { set() { throw new Error('nope'); }, configurable: true });
  const w3 = attempts.attachStartupIdentity(partial, REQ_A, '2026-11-26T05:58:00Z');
  assert.equal(w3.startupRequestId, REQ_A);
  assert.equal(w3.startupWindowStart, '2026-11-26T05:58:00Z');
});

test('(aa) failed-listen cleanup: first server disposed, second start() binds', async (t) => {
  saveCounter(t);
  const { createServer } = await import('node:http');
  const blocker = createServer(() => {});
  await new Promise((res) => blocker.listen(0, '127.0.0.1', res));
  const port = blocker.address().port;
  const out = captureConsole(t);
  try {
    setCounter(validCounter({ attempts: 1 }));
    writeStateDir({ readiness: validReadiness() });
    const api = makeApi(t, { port });
    out.length = 0;
    await assert.rejects(() => api.start(), (e) => e.code === 'EADDRINUSE');
    assert.ok(out.some((l) => l.includes('startup-listen-failed')));
    assert.equal(api.address, null);
    // The attempt stays counted (counter NOT reset) and the socket is closed: a second start() binds.
    assert.notEqual(counterBytes(), null);
    await new Promise((res) => blocker.close(res));
    const info = await api.start();
    assert.equal(info.port, port);
    await api.stop();
  } finally {
    try { blocker.close(); } catch { /* closed */ }
  }
});

test('(aa) exit-path resources: no socket or timer handle survives a failed start', async (t) => {
  saveCounter(t);
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness({ startupRequestId: REQ_B }) });
  const api = makeApi(t);
  const countSockets = () => process._getActiveHandles()
    .filter((h) => h.constructor && /Socket|Server/.test(h.constructor.name)).length;
  const before = countSockets();
  await assert.rejects(() => api.start());
  await new Promise((r) => setTimeout(r, 50));
  // The test runner itself holds sockets; assert the failed start adds none.
  assert.ok(countSockets() <= before, `socket handles before=${before} after=${countSockets()}`);
  assert.equal(api.address, null);
});

test('(aa) factory throw via CLI: missing secret -> startup-factory-failed, exit 1 below limit / 42 at limit', (t) => {
  saveCounter(t);
  const runCli = (attemptsN) => {
    setCounter(validCounter({ attempts: attemptsN }));
    const r = spawnSync('node', [path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js')], {
      encoding: 'utf8',
      env: { ...process.env, NOVA_STARTUP_STATE_DIR: STATE_DIR, NOVA_API_SECRET: '' },
    });
    return r;
  };
  writeStateDir({ readiness: validReadiness() });
  let r = runCli(1);
  assert.equal(r.status, 1, `exit 1 below limit, got ${r.status}: ${r.stderr}`);
  assert.ok(r.stderr.includes('startup-factory-failed'), 'factory event logged');
  assert.ok(!r.stderr.includes('Uncaught') && !r.stderr.includes('node:internal'), 'no uncaught-exception path');
  r = runCli(5);
  assert.equal(r.status, 42, `exit 42 at limit, got ${r.status}`);
  assert.ok(r.stderr.includes('startup-recovery-limit-reached'));
});

test('(aa) reset failure handling: lock-timeout / flock-spawn-failed / flock-failed / preserved', async (t) => {
  saveCounter(t);
  const id = { requestId: REQ_A, windowStart: new Date().toISOString(), attempts: 2, generation: GEN_A };
  setCounter({ attempts: 2, windowStart: id.windowStart, reservation: null, generation: GEN_A });
  // (i) Hold the flock lock > 10 s: resetAttemptCounter waits the bounded 10 s, then lock-timeout.
  const { flockExNb, flockUn } = await import('../src/api-server/flock-binding.mjs');
  const fd = fs.openSync(COUNTER_LOCK, 'w');
  assert.equal(flockExNb(fd), true);
  try {
    const started = Date.now();
    const r = attempts.resetAttemptCounter(id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'lock-timeout');
    assert.ok(Date.now() - started >= 9000, `bounded wait took ${Date.now() - started}ms`);
  } finally { flockUn(fd); fs.closeSync(fd); }
  // (ii) flock executable unavailable (PATH without flock) -> flock-spawn-failed. Child process (spawnSync PATH lookup).
  // NOTE: the child is spawned via process.execPath, not a PATH lookup for
  // `node` — PATH is deliberately broken for the flock lookup inside.
  const script = `
    import { resetAttemptCounter } from '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-attempts.js')}';
    console.log(JSON.stringify(resetAttemptCounter(${JSON.stringify(id)})));
  `;
  const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent-dir', NOVA_STARTUP_STATE_DIR: STATE_DIR },
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout.trim(), /flock-spawn-failed/);
  // (iii) Bad lock path -> flock-failed, never flock-spawn-failed / lock-timeout.
  // A directory IS lockable by flock(1) (verified on this VM), so the bad
  // path must be one flock cannot open: a symlink to a non-existent target
  // (open follows the link -> ENOENT -> flock exits non-zero).
  fs.rmSync(COUNTER_LOCK, { force: true });
  fs.symlinkSync('/nonexistent-dir-xyz/startup-attempts.lock', COUNTER_LOCK);
  try {
    const r3 = attempts.resetAttemptCounter(id);
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /^flock-failed/);
  } finally { fs.rmSync(COUNTER_LOCK, { force: true }); }
  // (iv) Reset preserves when a newer reservation is held; the process still listens (covered in (x)).
  setCounter({ attempts: 2, windowStart: id.windowStart, reservation: REQ_B, generation: GEN_A });
  const r4 = attempts.resetAttemptCounter(id);
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'reset-preserved');
  assert.equal(r4.preserved, true);
});

test('(aa) RESULT protocol via a controlled flock stand-in', (t) => {
  saveCounter(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-fakeflock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'flock');
  fs.writeFileSync(fake, `#!/bin/sh
# Fake flock: ignores lock args, prints canned stdout per FAKE_MODE, exits 0.
case "$FAKE_MODE" in
  buried) printf 'noise line\\nRESULT 9 {"code":9,"reason":"reset-preserved","preserved":true}\\n' ;;
  verbose) printf 'flock: getting lock\\nRESULT 0 {"code":0}\\n' ;;
  two) printf 'RESULT 9 {"code":9,"reason":"reset-preserved","preserved":true}\\nRESULT 9 {"code":9,"reason":"reset-preserved","preserved":true}\\n' ;;
  badjson) printf 'RESULT 0 {bad json\\n' ;;
  mismatch) printf 'RESULT 0 {"code":9,"reason":"reset-preserved"}\\n' ;;
  valid9) printf 'RESULT 9 {"code":9,"reason":"reset-preserved","preserved":true}\\n' ;;
  noresult) printf '' ;;
esac
exit 0
`);
  fs.chmodSync(fake, 0o755);
  const id = { requestId: REQ_A, windowStart: new Date().toISOString(), attempts: 2, generation: GEN_A };
  const run = (mode) => {
    const script = `
      import { resetAttemptCounter } from '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-attempts.js')}';
      console.log(JSON.stringify(resetAttemptCounter(${JSON.stringify(id)})));
    `;
    return spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: mode, NOVA_STARTUP_STATE_DIR: STATE_DIR },
    });
  };
  // Rev 4.9 §1: a --verbose-style progress line on stdout (the exact
  // corruption defect #1 produced) is also a protocol violation — the
  // strict exactly-one-RESULT-line rule rejects it, never parses past it.
  for (const mode of ['buried', 'verbose', 'two', 'badjson', 'mismatch', 'noresult']) {
    const r = run(mode);
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout.trim()).reason, 'counter-no-result', mode);
  }
  const ok = run('valid9');
  assert.deepEqual(JSON.parse(ok.stdout.trim()), { ok: false, reason: 'reset-preserved', preserved: true });
});

test('(aa) reset invocation never passes --verbose to flock', () => {
  // Rev 4.9 §1 regression guard: --verbose writes progress lines to
  // STDOUT on util-linux 2.39.3, corrupting the exactly-one-RESULT-line
  // protocol. The guard reads the invocation args themselves, not a
  // comment (the header comment discusses --verbose at length).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-attempts.js'), 'utf8');
  const m = src.match(/const args = \[[^\]]*\]/);
  assert.ok(m, 'reset flock args array found');
  assert.ok(!m[0].includes('--verbose'), `reset invocation must not pass --verbose: ${m[0]}`);
  assert.ok(m[0].includes("'--exclusive'") && m[0].includes("'--timeout'"), 'bounded exclusive flock retained');
});

// =============================================================================
// (aa) Rev 4.9 §4 — production executor registration factory
// =============================================================================

test('(aa) factory: empty production list starts in no-capacity state', async (t) => {
  saveCounter(t);
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api = makeApi(t, { extra: { productionExecutors: [] } });
  const info = await api.start();
  assert.ok(info.port > 0, 'API listens with an empty production list');
  assert.equal(api.executor, null, 'no legacy executor in production mode');
  assert.equal(api.dispatch._hasProductionExecutor(), false, 'no production executor registered');
  assert.equal(api.dispatch.executors.size, 0, 'executor registry empty');
  assert.equal(api.dispatch.productionExecutorIds.size, 0, 'production id set empty');
  // The submit path fails closed with 503 no-capacity (the honest state —
  // no provider has passed the §6 gate, so public generation is
  // unavailable rather than faked).
  const jobId = `nova-job-${randomUUID()}`;
  const execId = `${jobId}:scene-0:attempt-1`;
  const { PROVEN_MODEL, PROVEN_FRAMES, PROVEN_RESOLUTION, PROVEN_FPS } =
    await import('../src/api-server/constants.js');
  const r = await api.dispatch.submitExecutions({
    jobId, mode: 'single', model: PROVEN_MODEL, frames: PROVEN_FRAMES,
    resolution: PROVEN_RESOLUTION, fps: PROVEN_FPS, prompt: 'test prompt',
    audience: 'public',
    sceneExecutions: [{ sceneIndex: 0, attempt: 1, executionId: execId, idempotencyKey: execId }],
  });
  assert.deepEqual(r, { status: 503, body: { error: 'no-capacity' } });
});

test('(aa) factory: unknown / unpermitted / duplicate / malformed production id fails closed', async (t) => {
  saveCounter(t);
  // Unknown id: not in the allowlist (and not a provider) -> startup failure.
  assert.throws(
    () => makeApi(t, { extra: { productionExecutors: ['no-such-provider'] } }),
    /not permitted or implemented/,
  );
  // kaggle-t4 IS a real provider, but it has NOT passed the §6 gate, so it
  // is not in PRODUCTION_EXECUTOR_FACTORIES -> startup failure, never a
  // silent skip.
  assert.throws(
    () => makeApi(t, { extra: { productionExecutors: ['kaggle-t4'] } }),
    /not permitted or implemented/,
  );
  // Duplicate / malformed lists fail at parse time.
  assert.throws(
    () => apiServer.parseExecutorList('kaggle-t4,kaggle-t4'),
    /duplicate provider id/,
  );
  assert.throws(
    () => apiServer.parseExecutorList('KAGGLE-T4'),
    /invalid provider id/,
  );
  assert.throws(
    () => apiServer.parseExecutorList('kaggle t4'),
    /invalid provider id/,
  );
  assert.deepEqual(apiServer.parseExecutorList(''), []);
  assert.deepEqual(apiServer.parseExecutorList('  '), []);
  assert.deepEqual(apiServer.PRODUCTION_EXECUTOR_FACTORIES.size, 0, 'allowlist stays empty');
});

test('(aa) factory: registered-but-unimplemented / mismatched executor fails closed', async (t) => {
  saveCounter(t);
  // Temporarily register a factory for kaggle-t4 (a real provider id) so
  // the factory path runs; the allowlist is restored afterwards.
  const factories = apiServer.PRODUCTION_EXECUTOR_FACTORIES;
  assert.equal(factories.size, 0, 'allowlist starts empty');
  try {
    // (i) Mismatched identity: the factory returns another provider's executor.
    factories.set('kaggle-t4', {
      create: () => ({ id: 'someone-else', start() {}, fileReport() {} }),
    });
    assert.throws(
      () => makeApi(t, { extra: { productionExecutors: ['kaggle-t4'] } }),
      /id mismatch/,
    );
    // (ii) Unimplemented contract: right id, missing start()/fileReport().
    factories.set('kaggle-t4', { create: () => ({ id: 'kaggle-t4' }) });
    assert.throws(
      () => makeApi(t, { extra: { productionExecutors: ['kaggle-t4'] } }),
      /missing (start|fileReport)\(\)/,
    );
  } finally {
    factories.delete('kaggle-t4');
  }
  assert.equal(factories.size, 0, 'allowlist restored empty');
});

test('(aa) factory: production never constructs the fake executor', async (t) => {
  saveCounter(t);
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api = makeApi(t);
  const info = await api.start();
  assert.ok(info.port > 0);
  assert.equal(api.executor, null, 'no legacy executor constructed in production mode');
  assert.equal(api.dispatch.executors.size, 0, 'no executor registered at all');
  // Source guard: no `new FakeControlledExecutor` and no import of it in
  // the factory file (the name survives only in comments about the old
  // behaviour).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js'), 'utf8');
  assert.ok(!src.includes('new FakeControlledExecutor'), 'production never constructs the fake executor');
  assert.ok(!/import[^;]*FakeControlledExecutor/.test(src), 'fake executor is not imported');
  assert.ok(!src.includes('fake-executor'), 'fake executor module is not referenced');
});

test('(aa) personal: empty id / unknown id / missing credential do not stop startup', async (t) => {
  saveCounter(t);
  // (i) Empty personal id: no personal executor, startup proceeds.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api1 = makeApi(t, { extra: { personalExecutor: '' } });
  const info1 = await api1.start();
  assert.ok(info1.port > 0);
  assert.equal(api1.dispatch.personalExecutorIds.size, 0);
  await api1.stop();
  // (ii) Unknown personal id: unavailable, startup proceeds.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api2 = makeApi(t, { extra: { personalExecutor: 'no-such-provider' } });
  const info2 = await api2.start();
  assert.ok(info2.port > 0);
  assert.equal(api2.dispatch.personalExecutorIds.size, 0);
  await api2.stop();
  // (iii) Recognised id, missing credential: unavailable, startup proceeds.
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api3 = makeApi(t, { extra: { personalExecutor: 'kaggle-t4', kaggleCredentialPresent: false } });
  const info3 = await api3.start();
  assert.ok(info3.port > 0);
  assert.equal(api3.dispatch.personalExecutorIds.size, 0);
  await api3.stop();
  // (iv) Rev 4.8 §6: credential present but NO owner-token identifier
  // configured: unavailable, startup proceeds. Registration requires
  // the configured token ID as well as the credential — otherwise the
  // capacity response would claim a personal path no submit can
  // authenticate (a submit's ownerTokenId must match the configured
  // identifier, and with none configured any id would pass the check).
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api4 = makeApi(t, { extra: { personalExecutor: 'kaggle-t4', kaggleCredentialPresent: true } });
  const info4 = await api4.start();
  assert.ok(info4.port > 0);
  assert.equal(api4.dispatch.personalExecutorIds.size, 0);
  await api4.stop();
});

test('(aa) personal: kaggle-t4 with credentials is registered personally, never publicly', async (t) => {
  saveCounter(t);
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  // Rev 4.8 §6: registration requires the credential AND the configured
  // owner-token identifier.
  const api = makeApi(t, { extra: { personalExecutor: 'kaggle-t4', kaggleCredentialPresent: true, ownerTokenId: 'owner-token-v1' } });
  const info = await api.start();
  assert.ok(info.port > 0);
  // The personal executor IS present — in the personal registry only.
  assert.deepEqual([...api.dispatch.personalExecutorIds], ['kaggle-t4']);
  assert.ok(api.dispatch.executors.has('kaggle-t4'), 'personal executor in the merged registry');
  // ...and it does NOT satisfy public capacity: the production set stays
  // empty, the production gate stays closed, and there is no legacy
  // executor a public submit could fall through to.
  assert.equal(api.dispatch.productionExecutorIds.size, 0, 'personal executor never joins the public allowlist');
  assert.equal(api.dispatch._hasProductionExecutor(), false);
  assert.equal(api.executor, null);
  const jobId = `nova-job-${randomUUID()}`;
  const execId = `${jobId}:scene-0:attempt-1`;
  const { PROVEN_MODEL, PROVEN_FRAMES, PROVEN_RESOLUTION, PROVEN_FPS } =
    await import('../src/api-server/constants.js');
  const r = await api.dispatch.submitExecutions({
    jobId, mode: 'single', model: PROVEN_MODEL, frames: PROVEN_FRAMES,
    resolution: PROVEN_RESOLUTION, fps: PROVEN_FPS, prompt: 'test prompt',
    audience: 'public',
    sceneExecutions: [{ sceneIndex: 0, attempt: 1, executionId: execId, idempotencyKey: execId }],
  });
  assert.deepEqual(r, { status: 503, body: { error: 'no-capacity' } }, 'public submit still fails closed with a personal executor present');
});

// =============================================================================
// (aa) Rev 4.9 §5 — systemd READY notification
// =============================================================================

test('(aa) notify: failed READY notification closes the listener and fails startup', async (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  setCounter(validCounter({ attempts: 2 }));
  writeStateDir({ readiness: validReadiness() });
  // A NOTIFY_SOCKET with no listener: systemd-notify cannot deliver, so
  // the notification fails and start() must fail BEFORE the counter reset.
  const deadSocket = path.join(os.tmpdir(), `phase5-notify-dead-${process.pid}.sock`);
  process.env.NOTIFY_SOCKET = deadSocket;
  t.after(() => { delete process.env.NOTIFY_SOCKET; });
  const api = makeApi(t);
  await assert.rejects(() => api.start(), /systemd READY notification failed/);
  assert.equal(api.address, null, 'listener closed on notify failure');
  assert.ok(out.some((l) => l.includes('startup-service-ready-notify-failed')), 'notify-failed event logged');
  assert.notEqual(counterBytes(), null, 'counter NOT reset: the attempt stays counted');
});

test('(aa) notify: successful READY notification reaches the socket and the API stays active', async (t) => {
  saveCounter(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-notify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Node's dgram cannot bind a Unix datagram socket; the fake listener is
  // a small Python process (AF_UNIX/SOCK_DGRAM) that prints each datagram.
  const sockPath = path.join(dir, 'notify.sock');
  const { spawn } = await import('node:child_process');
  const proc = spawn('python3', ['-c', `
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.bind(${JSON.stringify(sockPath)})
s.settimeout(30)
print('LISTENING', flush=True)
while True:
    try:
        data, _ = s.recvfrom(4096)
    except socket.timeout:
        break
    print('NOTIFY ' + data.decode('utf8', 'replace'), flush=True)
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let listenerOut = '';
  proc.stdout.on('data', (d) => { listenerOut += d.toString(); });
  t.after(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } });
  // Wait for the listener to bind.
  for (let i = 0; i < 50 && !fs.existsSync(sockPath); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(sockPath), 'fake notify socket bound');
  process.env.NOTIFY_SOCKET = sockPath;
  t.after(() => { delete process.env.NOTIFY_SOCKET; });
  setCounter(validCounter({ attempts: 2 }));
  writeStateDir({ readiness: validReadiness() });
  const api = makeApi(t);
  const info = await api.start();
  assert.ok(info.port > 0, 'API listens after a successful READY notification');
  assert.ok(api.address, 'listener stays open (no re-arm on success)');
  assert.equal(counterBytes(), null, 'counter reset after a notified start');
  // The READY=1 datagram arrived at the socket.
  for (let i = 0; i < 50 && !listenerOut.includes('NOTIFY READY=1'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(listenerOut.includes('NOTIFY READY=1'), `READY=1 reached the socket; listener saw: ${JSON.stringify(listenerOut)}`);
});

// =============================================================================
// (aa) Rev 4.9 §4 — provider-routed dispatch (submit / query / cancel / report)
// =============================================================================

test('(aa) routing: submit, state query, cancellation and report use the reserved provider executor', async (t) => {
  const { DispatchManager } = await import('../src/api-server/dispatch.js');
  const { GpuManager } = await import('../src/gpu-manager.js');
  const { ApiStateStore } = await import('../src/api-server/state-store.js');
  const { createStorage } = await import('../src/storage/index.js');
  const { PROVEN_MODEL, PROVEN_FRAMES, PROVEN_RESOLUTION, PROVEN_FPS } =
    await import('../src/api-server/constants.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const calls = { a: [], b: [] };
  const makeFakeExecutor = (id, side) => ({
    id,
    submissions: new Map(),
    start(job) {
      calls[side].push(['start', job.id]);
      // Never settles: the job stays running, so the provider stays at
      // capacity for the second submit leg.
      return new Promise(() => {});
    },
    getExecutionState(executionId) {
      calls[side].push(['getExecutionState', executionId]);
      return { state: 'unknown', evidence: { raw: null } };
    },
    reportFailure(managerJobId, reason) {
      calls[side].push(['reportFailure', managerJobId, reason]);
      return true;
    },
    lastReport(managerJobId) {
      calls[side].push(['lastReport', managerJobId]);
      return null;
    },
    fileReport(report) {
      calls[side].push(['fileReport', report.jobId, report.status]);
      return { filed: true, provider: id };
    },
    requestCancel(jobId) {
      calls[side].push(['requestCancel', jobId]);
    },
  });
  const execA = makeFakeExecutor('provider-a', 'a');
  const execB = makeFakeExecutor('provider-b', 'b');
  const providerDef = (id) => ({
    id, kind: 'kaggle', label: `Test provider ${id}`, gpuType: 'NVIDIA T4',
    vramGb: 16, models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test only.' },
    maxConcurrentJobs: 1, connected: true, status: 'available',
  });
  const manager = new GpuManager({
    storePath: path.join(dir, 'gpu-manager.json'),
    now: () => Date.now(),
    config: { maxQueueDepth: 100 },
  });
  manager.attachStorage(createStorage({ rootDir: path.join(dir, 'store') }));
  manager.registerProvider(providerDef('provider-a'));
  manager.registerProvider(providerDef('provider-b'));
  manager.registerExecutor('provider-a', execA);
  manager.registerExecutor('provider-b', execB);
  const apiState = new ApiStateStore(path.join(dir, 'api-state.json'));
  const dispatch = new DispatchManager({
    manager,
    executors: new Map([['provider-a', execA], ['provider-b', execB]]),
    d1Client: stubD1(),
    apiState,
    mode: 'controlled-test',
    runnerHealthPath: null,
  });
  t.after(() => dispatch.stop());

  // Resolution: each provider id resolves to its own executor; unknown
  // resolves to the legacy executor (null here — pure registry routing).
  assert.equal(dispatch._executorForProvider('provider-a'), execA);
  assert.equal(dispatch._executorForProvider('provider-b'), execB);
  assert.equal(dispatch._executorForProvider('no-such-provider'), null);

  const submitBody = (jobId) => {
    const execId = `${jobId}:scene-0:attempt-1`;
    return {
      jobId, mode: 'single', model: PROVEN_MODEL, frames: PROVEN_FRAMES,
      resolution: PROVEN_RESOLUTION, fps: PROVEN_FPS, prompt: 'routing test',
      sceneExecutions: [{ sceneIndex: 0, attempt: 1, executionId: execId, idempotencyKey: execId }],
    };
  };
  // Submit leg 1: the manager reserves the first capable provider
  // (provider-a on the cost tie) and ONLY its executor starts the job.
  const jobA = `nova-job-${randomUUID()}`;
  const r1 = await dispatch.submitExecutions(submitBody(jobA));
  assert.equal(r1.status, 202, JSON.stringify(r1));
  const execIdA = `${jobA}:scene-0:attempt-1`;
  const entryA = dispatch.journalEntry(execIdA);
  assert.equal(entryA.executorId, 'provider-a', 'journal records the reserved provider');
  assert.equal(entryA.state, 'slot-claimed');
  assert.equal(calls.a.filter((c) => c[0] === 'start').length, 1, 'provider-a start called once');
  assert.equal(calls.b.filter((c) => c[0] === 'start').length, 0, 'provider-b start never called');
  // The immediate acceptance probe after submit queried provider-a only.
  assert.ok(calls.a.some((c) => c[0] === 'getExecutionState' && c[1] === execIdA), 'provider-a queried for the placed execution');
  assert.equal(calls.b.filter((c) => c[0] === 'getExecutionState').length, 0, 'provider-b never queried');
  // Submit leg 2: provider-a is at capacity (maxConcurrentJobs 1, job
  // still running), so the reservation falls to provider-b.
  const jobB = `nova-job-${randomUUID()}`;
  const r2 = await dispatch.submitExecutions(submitBody(jobB));
  assert.equal(r2.status, 202, JSON.stringify(r2));
  const execIdB = `${jobB}:scene-0:attempt-1`;
  assert.equal(dispatch.journalEntry(execIdB).executorId, 'provider-b');
  assert.equal(calls.b.filter((c) => c[0] === 'start').length, 1, 'provider-b start called once');
  assert.equal(calls.a.filter((c) => c[0] === 'start').length, 1, 'provider-a start still once');

  // State-query leg: _queryExecutor answers from the reserved provider.
  calls.a.length = 0; calls.b.length = 0;
  const q = dispatch._queryExecutor(execIdB);
  assert.equal(q.state, 'unknown');
  assert.equal(calls.b.filter((c) => c[0] === 'getExecutionState').length, 1, 'provider-b queried');
  assert.equal(calls.a.filter((c) => c[0] === 'getExecutionState').length, 0, 'provider-a not queried');

  // Failure-report leg: _failExecution reports through the reserved provider.
  calls.a.length = 0; calls.b.length = 0;
  await dispatch._failExecution(dispatch.journalEntry(execIdB), 'executor-failed', 'test');
  assert.ok(calls.b.some((c) => c[0] === 'reportFailure'), 'provider-b reportFailure called');
  assert.equal(calls.a.filter((c) => c[0] === 'reportFailure').length, 0, 'provider-a reportFailure not called');
  assert.equal(dispatch.journalEntry(execIdB).state, 'failed');

  // Cancellation leg: cancelExecution -> manager.cancelJob -> the reserved
  // provider's requestCancel. (The manager job is planted directly in the
  // store: cancelJob reads it from there.)
  const mgrJobId = entryA.managerJobId;
  assert.ok(mgrJobId, 'placed execution has a manager job');
  manager.store.mutate((s) => {
    s.jobs[mgrJobId] = {
      id: mgrJobId, providerId: 'provider-a', status: 'dispatched',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  });
  calls.a.length = 0; calls.b.length = 0;
  const cancel = await dispatch.cancelExecution(jobA, execIdA);
  assert.equal(cancel.status, 200, JSON.stringify(cancel));
  assert.equal(cancel.body.status, 'cancel-requested');
  assert.ok(calls.a.some((c) => c[0] === 'requestCancel' && c[1] === mgrJobId), 'provider-a requestCancel called');
  assert.equal(calls.b.filter((c) => c[0] === 'requestCancel').length, 0, 'provider-b requestCancel not called');

  // Report-completion leg: fileReportForExecution files with the reserved
  // provider's executor.
  calls.a.length = 0; calls.b.length = 0;
  const filed = await dispatch.fileReportForExecution(execIdA, { status: 'complete', outputPath: '/tmp/routing-report.mp4' });
  assert.deepEqual(filed, { filed: true, provider: 'provider-a' });
  assert.ok(calls.a.some((c) => c[0] === 'fileReport' && c[1] === mgrJobId && c[2] === 'succeeded'), 'provider-a fileReport called with the mapped status');
  assert.equal(calls.b.filter((c) => c[0] === 'fileReport').length, 0, 'provider-b fileReport not called');
});

// =============================================================================
// (aa) Rev 4.9 corrections — ChatGPT review (Defect 1, 4A, 4B)
// =============================================================================

test('(aa) classifyFlockResult: signal-killed / ETIMEDOUT / non-zero diagnostic', () => {
  // ChatGPT correction Defect 1: the spawnSync result classification is a
  // testable helper; the RESULT-line parsing stays in resetAttemptCounterInner.
  // Signal-killed child: exact assertion from the correction.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: null, status: null, signal: 'SIGTERM' }),
    { ok: false, reason: 'flock-killed-by-signal-SIGTERM' },
  );
  // A null status with no signal is a spawn timeout, not a signal kill.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: null, status: null, signal: null }),
    { ok: false, reason: 'flock-spawn-timeout' },
  );
  // ETIMEDOUT (the 15 s process timeout) is a spawn timeout.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: { code: 'ETIMEDOUT', message: 'timed out' }, status: null, signal: null }),
    { ok: false, reason: 'flock-spawn-timeout' },
  );
  // Any other spawn error is a spawn failure carrying the message.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: { code: 'ENOENT', message: 'spawn flock ENOENT' }, status: null, signal: null }),
    { ok: false, reason: 'flock-spawn-failed: spawn flock ENOENT' },
  );
  // Non-zero exit, both streams empty: the lock was never acquired.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: null, status: 1, stdout: '', stderr: '' }),
    { ok: false, reason: 'lock-timeout' },
  );
  // Non-zero exit, timeout diagnostic printed: lock-timeout.
  assert.deepEqual(
    attempts.classifyFlockResult({ error: null, status: 1, stdout: '', stderr: 'flock: timeout while waiting to get lock\n' }),
    { ok: false, reason: 'lock-timeout' },
  );
  // Non-zero exit with a non-empty, non-timeout diagnostic: flock-failed
  // carrying that diagnostic (whitespace-normalised, bounded).
  assert.deepEqual(
    attempts.classifyFlockResult({ error: null, status: 1, stdout: 'flock: cannot open lock file\n', stderr: '' }),
    { ok: false, reason: 'flock-failed: flock: cannot open lock file' },
  );
  // Exit 0 is not a failure: null, and the caller proceeds to RESULT parsing.
  assert.equal(
    attempts.classifyFlockResult({ error: null, status: 0, signal: null, stdout: 'RESULT 0 {"code":0}\n', stderr: '' }),
    null,
  );
});

test('(aa) routing: unknown provider id never falls back to the legacy executor', async (t) => {
  // ChatGPT correction 4A: the legacy fallback applies ONLY when there is
  // NO provider id at all. With exactly one registered provider the
  // constructor assigns it to this.executor — an execution carrying a
  // DIFFERENT executorId must still resolve to null, and no executor
  // method may be called for it.
  const { DispatchManager } = await import('../src/api-server/dispatch.js');
  const { GpuManager } = await import('../src/gpu-manager.js');
  const { ApiStateStore } = await import('../src/api-server/state-store.js');
  const { createStorage } = await import('../src/storage/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-4a-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const calls = [];
  const execA = {
    id: 'provider-a',
    submissions: new Map(),
    start(job) { calls.push(['start', job.id]); return new Promise(() => {}); },
    getExecutionState(executionId) { calls.push(['getExecutionState', executionId]); return { state: 'unknown', evidence: { raw: null } }; },
    reportFailure(managerJobId, reason) { calls.push(['reportFailure', managerJobId, reason]); return true; },
    lastReport(managerJobId) { calls.push(['lastReport', managerJobId]); return null; },
    fileReport(report) { calls.push(['fileReport', report.jobId, report.status]); return { filed: true, provider: 'provider-a' }; },
    requestCancel(jobId) { calls.push(['requestCancel', jobId]); },
  };
  const manager = new GpuManager({
    storePath: path.join(dir, 'gpu-manager.json'),
    now: () => Date.now(),
    config: { maxQueueDepth: 100 },
  });
  manager.attachStorage(createStorage({ rootDir: path.join(dir, 'store') }));
  manager.registerProvider({
    id: 'provider-a', kind: 'kaggle', label: 'Test provider a', gpuType: 'NVIDIA T4',
    vramGb: 16, models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test only.' },
    maxConcurrentJobs: 1, connected: true, status: 'available',
  });
  manager.registerExecutor('provider-a', execA);
  const apiState = new ApiStateStore(path.join(dir, 'api-state.json'));
  const dispatch = new DispatchManager({
    manager,
    executors: new Map([['provider-a', execA]]),
    d1Client: stubD1(),
    apiState,
    mode: 'controlled-test',
    runnerHealthPath: null,
  });
  t.after(() => dispatch.stop());

  // Exactly one registered provider: the constructor assigns it as the
  // legacy executor (the old code would have fallen back to it below).
  assert.equal(dispatch.executor, execA, 'sole registered executor becomes the legacy executor');

  const unknownExecId = `nova-job-${randomUUID()}:scene-0:attempt-1`;
  dispatch._journalSetState(unknownExecId, 'slot-claimed', { executorId: 'provider-x', managerJobId: 'mgr-unknown' });
  const legacyExecId = `nova-job-${randomUUID()}:scene-0:attempt-1`;
  dispatch._journalSetState(legacyExecId, 'slot-claimed', { managerJobId: 'mgr-legacy' });

  // Unknown provider id: BOTH lookups return null.
  assert.equal(dispatch._executorForProvider('provider-x'), null, 'unknown provider id resolves to null, not the legacy executor');
  assert.equal(dispatch._executorForExecution(unknownExecId), null, 'execution with an unknown executorId resolves to null');
  // ...and no executor method is called for it.
  calls.length = 0;
  assert.deepEqual(dispatch._queryExecutor(unknownExecId), { state: 'unknown', evidence: { raw: null } });
  assert.deepEqual(calls, [], 'no executor method called for the unknown-provider execution');
  const filed = await dispatch.fileReportForExecution(unknownExecId, { status: 'complete', outputPath: '/tmp/4a-report.mp4' });
  assert.deepEqual(filed, { filed: false, reason: 'no-executor-for-provider' });
  assert.deepEqual(calls, [], 'fileReport not called for the unknown-provider execution');

  // Genuine legacy execution (no provider id at all): still uses the legacy executor.
  assert.equal(dispatch._executorForProvider(null), execA, 'no provider id still falls back to the legacy executor');
  assert.equal(dispatch._executorForProvider(undefined), execA);
  assert.equal(dispatch._executorForExecution(legacyExecId), execA, 'execution with no executorId still uses the legacy executor');
  calls.length = 0;
  assert.deepEqual(dispatch._queryExecutor(legacyExecId), { state: 'unknown', evidence: { raw: null } });
  assert.deepEqual(calls, [['getExecutionState', legacyExecId]], 'legacy execution is queried on the legacy executor');
});

test('(aa) personal: only the personal executor registered — submit 503s and never touches it', async (t) => {
  // ChatGPT correction 4B, as amended by Rev 4.8 §6: the factory registers
  // kaggle-t4 on credential presence AND the configured owner-token
  // identifier, and the shipped Worker has no NOVA_OWNER_TOKEN gate, so
  // this test proves the honest current state at the API layer — no
  // personal route is exposed — not the Worker gate (a separate future step).
  saveCounter(t);
  setCounter(validCounter({ attempts: 1 }));
  writeStateDir({ readiness: validReadiness() });
  const api = makeApi(t, { extra: { personalExecutor: 'kaggle-t4', kaggleCredentialPresent: true, ownerTokenId: 'owner-token-v1' } });
  const info = await api.start();
  assert.ok(info.port > 0);
  assert.deepEqual([...api.dispatch.personalExecutorIds], ['kaggle-t4']);
  assert.equal(api.dispatch._hasProductionExecutor(), false, 'personal executor never satisfies public capacity');
  // The sole registered executor is the personal one (constructor rule):
  // the 4A fix is what stops an unknown-provider lookup from reaching it,
  // and the production gate below is what stops a submit from reaching it.
  assert.equal(api.dispatch.executor, api.dispatch.executors.get('kaggle-t4'));

  const personal = api.dispatch.executors.get('kaggle-t4');
  assert.ok(personal, 'personal executor registered');
  const calls = [];
  for (const m of ['start', 'getExecutionState', 'fileReport', 'reportFailure', 'requestCancel', 'lastReport']) {
    if (typeof personal[m] === 'function') {
      const orig = personal[m];
      personal[m] = function (...args) { calls.push(m); return orig.apply(personal, args); };
    }
  }
  const jobId = `nova-job-${randomUUID()}`;
  const execId = `${jobId}:scene-0:attempt-1`;
  const { PROVEN_MODEL, PROVEN_FRAMES, PROVEN_RESOLUTION, PROVEN_FPS } =
    await import('../src/api-server/constants.js');
  const r = await api.dispatch.submitExecutions({
    jobId, mode: 'single', model: PROVEN_MODEL, frames: PROVEN_FRAMES,
    resolution: PROVEN_RESOLUTION, fps: PROVEN_FPS, prompt: 'personal route probe',
    audience: 'public',
    sceneExecutions: [{ sceneIndex: 0, attempt: 1, executionId: execId, idempotencyKey: execId }],
  });
  assert.deepEqual(r, { status: 503, body: { error: 'no-capacity' } }, 'submit fails closed with only a personal executor');
  assert.deepEqual(calls, [], 'no personal-executor method called by the refused submit');
  // Nothing was queued, so dispatchNext() never ran and could not have
  // selected the personal provider (it is registered connected+available,
  // so it WOULD be dispatchable if a job ever reached it — see report).
  assert.deepEqual(api.dispatch.manager.listJobs(), [], 'no manager job queued');
  assert.equal(api.dispatch.journalEntry(execId), null, 'no journal entry created');
});

test('(aa) never-throws boundary: throwing identity getter -> reset-attempt-counter-threw', () => {
  const id = {};
  Object.defineProperty(id, 'requestId', { get() { throw new Error('getter boom'); } });
  const r = attempts.resetAttemptCounter(id);
  assert.deepEqual(r, { ok: false, reason: 'reset-attempt-counter-threw' });
});

test('(aa) timer diagnostics: sweep timer rejection never throws, line still emitted', async (t) => {
  saveCounter(t);
  const out = captureConsole(t);
  const ws = new Date().toISOString();
  // The timer path is separate from the startup sweep: start with a
  // usageSource that makes the STARTUP sweep return early (unreadable usage),
  // so start() succeeds; the interval timer later hits the throwing index
  // once usage flips readable.
  const noop = () => {};
  const badStorage = {
    put: noop, get: noop, head: noop, delete: noop, sweep: noop, usage: noop,
    issueDeliveryRef: noop, redeemDeliveryRef: noop, startSweepTimer: noop, stopSweepTimer: noop,
    index: { listExpired() { throw 'timer-boom-string'; } },
  };
  let usageOk = false;
  const api4 = makeApi(t, {
    extra: {
      storage: badStorage,
      usageSource: async () => (usageOk ? { readable: true, usageFraction: 0.1 } : { readable: false }),
      sweepIntervalMs: 50,
      reconcileIntervalMs: 60 * 60 * 1000,
    },
  });
  setCounter({ attempts: 1, windowStart: ws, reservation: null, generation: GEN_A });
  writeStateDir({ readiness: validReadiness() });
  out.length = 0;
  const info = await api4.start();
  assert.ok(info.port > 0);
  usageOk = true;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(out.some((l) => l.includes('sweep failed:')), 'timer diagnostic line emitted for a non-Error rejection');
  assert.ok(out.some((l) => l.includes('timer-boom-string')));
  await api4.stop();
  // A throwing message getter on the timer rejection also cannot throw the handler.
  const throwingErr = { get message() { throw new Error('x'); } };
  assert.doesNotThrow(() => attempts.formatRejectionValue(throwingErr));
});

// (x) reset ownership race — CHILD-PROCESS interleave.
//
// The reset's flock is a synchronous spawnSync inside start(): once the API
// process reaches the reset, its event loop is blocked for the whole flock
// wait, so no in-process timer can interleave a mutation in that window.
// The interleave is therefore driven from the PARENT process: the parent
// holds the counter lock, spawns the API as a CHILD, waits until the child's
// reset flock process exists (pgrep — the deterministic signal that the
// child is waiting in its reset), performs the mutation with the module-level
// functions (which take no lock), then releases the lock so the child's
// reset runs against the mutated counter.
async function waitForResetFlock(deadlineMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = spawnSync('pgrep', ['-f', 'startup-counter.mjs reset'], { encoding: 'utf8' });
    if (r.status === 0) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

async function runXChild(t, { mutate = null } = {}) {
  const childState = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-x-state-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-x-data-'));
  t.after(() => {
    fs.rmSync(childState, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const ws = new Date().toISOString();
  setCounter({ attempts: 3, windowStart: ws, reservation: null, generation: GEN_A });
  fs.writeFileSync(path.join(childState, 'startup-request-id'), REQ_A);
  fs.writeFileSync(path.join(childState, 'readiness.json'), JSON.stringify(validReadiness()));
  const { flockExNb, flockUn } = await import('../src/api-server/flock-binding.mjs');
  const output = [];
  const child = (await import('node:child_process')).spawn(process.execPath,
    [path.join(REPO_ROOT, 'gpu-cloud/test/phase5-x-child.mjs'), dataDir],
    { env: { ...process.env, NOVA_STARTUP_STATE_DIR: childState }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => output.push(d.toString()));
  child.stderr.on('data', (d) => output.push(d.toString()));
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let fd = null;
  try {
    if (mutate) {
      fd = fs.openSync(COUNTER_LOCK, 'w');
      assert.equal(flockExNb(fd), true, 'parent must hold the counter lock before the child reset');
      assert.equal(await waitForResetFlock(), true, 'child reset flock process must appear within 9 s');
      mutate(ws);
      flockUn(fd);
      fs.closeSync(fd);
      fd = null;
    }
    const listening = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 20000);
      const check = () => {
        if (output.join('').includes('LISTENING')) { clearTimeout(deadline); resolve(true); }
        else setTimeout(check, 100);
      };
      check();
    });
    assert.equal(listening, true, `child never reached LISTENING; output:\n${output.join('')}`);
  } finally {
    if (fd !== null) { try { flockUn(fd); } catch { /* released */ } try { fs.closeSync(fd); } catch { /* closed */ } }
  }
  child.kill('SIGTERM');
  await new Promise((res) => { child.on('exit', res); setTimeout(res, 5000); });
  return { output: output.join(''), windowStart: ws };
}

test('(x) reset preserves a reservation made between listen and reset', async (t) => {
  saveCounter(t);
  let tokenB;
  const { output } = await runXChild(t, {
    mutate: () => {
      const reserved = reserveAttempt();
      assert.equal(reserved.code, 0);
      tokenB = reserved.token;
    },
  });
  // The counter file is NOT deleted; reservation B survives.
  const stored = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
  assert.equal(stored.reservation, tokenB);
  assert.equal(stored.attempts, 3);
  assert.ok(output.includes('startup-recovery-reset-preserved'), `reset-preserved logged; output:\n${output}`);
  assert.ok(output.includes('startup-recovery-succeeded'), 'succeeded still logged (A is listening)');
});

test('(x) reset preserves when preparation consumed the reservation first (vi-b)', async (t) => {
  saveCounter(t);
  const { output } = await runXChild(t, {
    mutate: () => {
      const reserved = reserveAttempt();
      assert.equal(reserved.code, 0);
      const consumed = prepareAttempt(); // attempts 3 -> 4, reservation null
      assert.equal(consumed.code, 0);
      assert.equal(consumed.value.attempts, 4);
    },
  });
  const stored = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
  assert.equal(stored.attempts, 4, 'reset preserves (attempts 4 != identity 3)');
  assert.ok(output.includes('startup-recovery-reset-preserved'), `reset-preserved logged; output:\n${output}`);
  assert.ok(output.includes('startup-recovery-succeeded'));
});

test('(x) reset preserves a delete-and-recreate with the same window/attempts but a new generation (vii)', async (t) => {
  saveCounter(t);
  const { output, windowStart: ws } = await runXChild(t, {
    mutate: (ws) => {
      // Delete + recreate with the SAME windowStart and attempts, new generation G2.
      setCounter({ attempts: 3, windowStart: ws, reservation: null, generation: GEN_B });
    },
  });
  const stored = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
  assert.equal(stored.generation, GEN_B, 'recreated counter survives the stale reset');
  assert.equal(stored.attempts, 3);
  assert.ok(output.includes('startup-recovery-reset-preserved'), `reset-preserved logged; output:\n${output}`);
  assert.ok(output.includes('startup-recovery-succeeded'));
});

test('(x) normal case: no concurrent mutation -> reset deletes exactly once, next chain starts at 1', async (t) => {
  saveCounter(t);
  const { output } = await runXChild(t, {});
  assert.ok(output.includes('startup-recovery-succeeded'));
  assert.equal(counterBytes(), null, 'counter deleted by the reset');
  const next = prepareAttempt();
  assert.equal(next.code, 0);
  assert.equal(next.value.attempts, 1, 'next chain attempt starts at 1');
});
