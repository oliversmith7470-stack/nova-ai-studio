// phase5-storage-runner.test.mjs — §15 tests for the Rev 4.9 §6 storage
// runner (gpu-cloud/src/storage-runner.js): the single production
// implementation behind both the hourly runner service and the startup
// catch-up recovery unit.
//
// These tests drive the REAL runner (in-process via runPassLocked /
// runCatchUp, and as a child process for the CLI entry points) against a
// REAL store built with the same storage engine the API uses
// (NovaStorage/MetadataIndex). No mocks: the only fixtures are the §15
// fault-marker files in the temp state dir, which the runner honours in
// --catch-up mode exactly as the installed-unit tests use them.
//
// The runner's data dir is a temp directory per test (NOVA_API_DATA_DIR is
// NOT used here — the runner is invoked with an explicit --data-dir /
// dataDir option). The API's data dir in these tests is the same temp
// directory, proving the shared-root identity.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { createStorage, indexKey } from '../src/storage/index.js';
import {
  runPassLocked, runCatchUp, runDaemon, SWEEP_LOCK_TIMEOUT_MS, HOURLY_INTERVAL_MS,
} from '../src/storage-runner.js';
import { isRunnerHeartbeatHealthy, RUNNER_HEARTBEAT_MAX_AGE_MS } from '../src/api-server/runner-heartbeat.js';
import { flockExNb, flockUn } from '../src/api-server/flock-binding.mjs';
import { COUNTER_PATH } from '../src/api-server/startup-counter.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = path.join(REPO_ROOT, 'gpu-cloud/src/storage-runner.js');
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeRequestId(dataDir, requestId = '33333333-3333-4333-8333-333333333333') {
  fs.writeFileSync(path.join(dataDir, 'startup-request-id'), requestId);
  return requestId;
}

// Put one object into the store and return its record. Each call writes
// DISTINCT bytes (a per-call fill byte): the storage engine deduplicates
// identical content to one object id, so identical puts would silently
// share a single record.
let putCounter = 0;
async function putObject(dataDir, { namespace = 'outputs', jobId = null, bytes = 64 } = {}) {
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  const src = path.join(dataDir, `src-${Math.random().toString(36).slice(2)}.bin`);
  putCounter += 1;
  fs.writeFileSync(src, Buffer.alloc(bytes, putCounter % 251));
  // The job link goes through put() (as the API's storeJobOutput does),
  // so the per-object manifest carries it too — a manifest rebuild
  // restores the link instead of losing it.
  const record = await storage.put({ namespace, source: src, contentType: 'video/mp4', jobId });
  return record;
}

function expireObject(dataDir, namespace, objectId) {
  const indexPath = path.join(dataDir, 'store', 'index.json');
  const index = readJson(indexPath);
  const key = indexKey(namespace, objectId);
  assert.ok(index.objects[key], `index record exists for ${key}`);
  index.objects[key].expiresAt = Date.now() - 1000;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function deletionLog(dataDir) {
  const p = path.join(dataDir, 'deletion-log.jsonl');
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('runner: catch-up on an empty store succeeds, writes readiness + heartbeat', async (t) => {
  const dataDir = tempDataDir(t);
  const requestId = writeRequestId(dataDir);
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true, `catch-up ok: ${r.error?.message ?? ''}`);
  const readiness = readJson(path.join(dataDir, 'readiness.json'));
  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.startupRequestId, requestId);
  assert.equal(readiness.cycleId, requestId);
  assert.equal(readiness.bootId, BOOT_ID);
  assert.equal(readiness.objectsDeleted, 0);
  // Finding 10B: indexRebuilt is true ONLY when manifest reconstruction
  // actually restored at least one object. An empty store has nothing
  // to reconstruct, so this is false — a normal validation pass is not
  // a rebuild.
  assert.equal(readiness.indexRebuilt, false);
  assert.equal(readiness.indexRestored, 0);
  assert.deepEqual(readiness.unrecoverableOrphans, []);
  const heartbeat = readJson(path.join(dataDir, 'runner-health.json'));
  assert.equal(heartbeat.status, 'ok');
  assert.equal(heartbeat.error, null);
  assert.equal(heartbeat.objectsDeleted, 0);
  assert.ok(Date.parse(heartbeat.lastSuccessfulSweepAt) > Date.now() - 60_000, 'heartbeat is fresh');
  assert.ok(Date.parse(heartbeat.lastAttemptAt) >= Date.parse(heartbeat.lastSuccessfulSweepAt), 'lastAttemptAt is at least the last success');
});

test('runner: shared store root — the API store and the runner see the same objects', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  // The API's storage engine writes an object; the runner's catch-up pass
  // reads the same store root (<dataDir>/store) and leaves it alone.
  const record = await putObject(dataDir, { jobId: 'job-shared-1' });
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  assert.equal(r.report.objectsDeleted, 0, 'a live object is not deleted');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.ok(storage.index.getObject('outputs', record.objectId), 'object still indexed after the pass');
  assert.equal(storage.index.listObjects().length, 1);
});

test('runner: expired objects are physically removed and logged', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, { jobId: 'job-expired-1' });
  expireObject(dataDir, 'outputs', record.objectId);
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  assert.equal(r.report.objectsDeleted, 1);
  assert.equal(r.report.objectsExpiredButMissing, 0);
  const chunksDir = path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId);
  assert.equal(fs.existsSync(chunksDir), false, 'chunks physically removed');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.equal(storage.index.getObject('outputs', record.objectId), null, 'index record dropped');
  const log = deletionLog(dataDir);
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'expired');
  assert.equal(log[0].objectId, record.objectId);
  assert.equal(log[0].namespace, 'outputs');
  assert.equal(log[0].jobId, 'job-expired-1');
  assert.ok(typeof log[0].ts === 'string' && log[0].ts.length > 0, 'log line carries a timestamp');
});

test('runner: repeated catch-up is idempotent', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, {});
  expireObject(dataDir, 'outputs', record.objectId);
  const r1 = await runCatchUp({ dataDir });
  assert.equal(r1.ok, true);
  assert.equal(r1.report.objectsDeleted, 1);
  const r2 = await runCatchUp({ dataDir });
  assert.equal(r2.ok, true, 'second pass succeeds on the swept store');
  assert.equal(r2.report.objectsDeleted, 0, 'nothing left to delete');
  assert.equal(deletionLog(dataDir).length, 1, 'no duplicate log line');
  const heartbeat = readJson(path.join(dataDir, 'runner-health.json'));
  assert.equal(heartbeat.status, 'ok');
});

test('runner: index rebuild drops damaged records and deletes orphan chunks', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  // A damaged record: chunks deleted from disk, index record kept.
  const damaged = await putObject(dataDir, {});
  fs.rmSync(path.join(dataDir, 'store', 'chunks', 'outputs', damaged.objectId), { recursive: true, force: true });
  // An orphan chunk dir: present on disk, no index record.
  const orphanId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const orphanDir = path.join(dataDir, 'store', 'chunks', 'outputs', orphanId);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, '0.chunk'), Buffer.alloc(16, 0x42));
  // Age the orphan past the 60 s orphan grace (Finding 10C): a
  // freshly-created chunk dir may be a put in flight and must never be
  // deleted. A genuine crash orphan is old.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(orphanDir, '0.chunk'), old, old);
  fs.utimesSync(orphanDir, old, old);
  // A healthy object, untouched by the rebuild.
  const healthy = await putObject(dataDir, {});
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.equal(storage.index.getObject('outputs', damaged.objectId), null, 'damaged record dropped');
  assert.equal(fs.existsSync(orphanDir), false, 'orphan chunks deleted');
  assert.ok(storage.index.getObject('outputs', healthy.objectId), 'healthy object survives');
  const reasons = deletionLog(dataDir).map((e) => e.reason).sort();
  assert.ok(reasons.includes('missing'), `damaged record logged as missing: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.includes('orphan'), `orphan logged: ${JSON.stringify(reasons)}`);
});

test('runner: ledger reconciliation marks expired jobs and deletes ledger-less objects (catch-up only)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  // A job whose MP4 is gone (its object was expired and swept).
  const gone = await putObject(dataDir, { jobId: 'job-gone' });
  expireObject(dataDir, 'outputs', gone.objectId);
  // A store object that claims a ledger row that does not exist.
  const orphanJob = await putObject(dataDir, { jobId: 'job-never-existed' });
  // A job whose MP4 survives: untouched.
  const kept = await putObject(dataDir, { jobId: 'job-kept' });
  const ledger = {
    version: 1,
    state: {
      jobs: {
        'job-gone': { id: 'job-gone', status: 'succeeded', outputRef: { namespace: 'outputs', objectId: gone.objectId } },
        'job-kept': { id: 'job-kept', status: 'succeeded', outputRef: { namespace: 'outputs', objectId: kept.objectId } },
      },
    },
  };
  fs.writeFileSync(path.join(dataDir, 'gpu-manager.json'), JSON.stringify(ledger, null, 2));
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  assert.equal(r.report.jobsExpired, 1, 'exactly the job whose MP4 is gone is expired');
  const after = readJson(path.join(dataDir, 'gpu-manager.json'));
  assert.equal(after.state.jobs['job-gone'].status, 'expired');
  assert.equal(after.state.jobs['job-gone'].error, 'output-expired');
  assert.equal(after.state.jobs['job-kept'].status, 'succeeded', 'surviving job untouched');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.equal(storage.index.getObject('outputs', orphanJob.objectId), null, 'ledger-less object deleted');
  assert.ok(deletionLog(dataDir).some((e) => e.reason === 'no-ledger-row' && e.objectId === orphanJob.objectId));
});

test('runner: sweep.lock serialises passes — a contended lock waits, then the pass runs', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const fd = fs.openSync(path.join(dataDir, 'sweep.lock'), 'w');
  assert.equal(flockExNb(fd), true, 'test holds the sweep lock');
  try {
    // A pass started while the lock is held must NOT complete (and must
    // not touch the store) until the holder releases it.
    let settled = false;
    const pending = runPassLocked({ dataDir, catchUp: true }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(settled, false, 'pass waits while the lock is held');
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')), null, 'no heartbeat written while waiting');
    flockUn(fd);
    fs.closeSync(fd);
    const outcome = await pending;
    assert.equal(outcome.ok, true, 'pass runs once the lock is released');
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')).status, 'ok');
  } finally {
    try { flockUn(fd); } catch { /* already released */ }
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
});

test('runner: contended lock past the timeout fails the catch-up (no silent skip)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const fd = fs.openSync(path.join(dataDir, 'sweep.lock'), 'w');
  assert.equal(flockExNb(fd), true);
  try {
    const outcome = await runPassLocked({ dataDir, catchUp: true, lockTimeoutMs: 500 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.lockContended, true);
  } finally {
    flockUn(fd);
    fs.closeSync(fd);
  }
  // The production default timeout is the 60 s bound in the §14 contract.
  assert.equal(SWEEP_LOCK_TIMEOUT_MS, 60_000);
});

test('runner: fault markers — fail, fail-once, stale-readiness (catch-up only)', async (t) => {
  const dataDir = tempDataDir(t);
  const requestId = writeRequestId(dataDir);
  // (i) runner-fault-fail: failed readiness + failed heartbeat, exit 1.
  fs.writeFileSync(path.join(dataDir, 'runner-fault-fail'), '');
  const r1 = await runCatchUp({ dataDir });
  assert.equal(r1.ok, false, 'fail marker fails the catch-up');
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'failed');
  assert.equal(readJson(path.join(dataDir, 'runner-health.json')).status, 'failed');
  assert.ok(readJson(path.join(dataDir, 'runner-health.json')).error, 'failed heartbeat carries the error');
  assert.ok(fs.existsSync(path.join(dataDir, 'runner-fault-fail')), 'fail marker is NOT consumed');
  fs.rmSync(path.join(dataDir, 'runner-fault-fail'));
  // (ii) runner-fault-fail-once: fails once (marker consumed), then succeeds.
  fs.writeFileSync(path.join(dataDir, 'runner-fault-fail-once'), '');
  const r2 = await runCatchUp({ dataDir });
  assert.equal(r2.ok, false, 'fail-once fails the first pass');
  assert.equal(fs.existsSync(path.join(dataDir, 'runner-fault-fail-once')), false, 'fail-once marker consumed');
  const r3 = await runCatchUp({ dataDir });
  assert.equal(r3.ok, true, 'next pass succeeds after the marker is consumed');
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'ok');
  // (iii) runner-fault-stale-readiness: the pass succeeds but the
  // readiness record carries the WRONG startup request id (consumed).
  fs.writeFileSync(path.join(dataDir, 'runner-fault-stale-readiness'), '');
  const r4 = await runCatchUp({ dataDir });
  assert.equal(r4.ok, true, 'stale-readiness pass itself succeeds');
  const readiness = readJson(path.join(dataDir, 'readiness.json'));
  assert.notEqual(readiness.startupRequestId, requestId, 'readiness carries the wrong request id');
  assert.equal(readiness.startupRequestId, '00000000-0000-4000-8000-000000000000');
  assert.equal(fs.existsSync(path.join(dataDir, 'runner-fault-stale-readiness')), false, 'stale marker consumed');
});

test('runner: CLI --catch-up exits 0 on success, 1 on a fault, and the API refuses a failed readiness', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const runCli = (extraEnv = {}) => spawnSync(process.execPath, [RUNNER, '--catch-up', '--data-dir', dataDir], {
    encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 30000,
  });
  const ok = runCli();
  assert.equal(ok.status, 0, `CLI catch-up exit 0: ${ok.stderr}`);
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'ok');
  // Fault: the CLI exits 1 and the readiness record is failed — and the
  // API's verifyStartupReadiness rejects it (readiness-status-not-ok),
  // so the API never listens on an unreconciled store.
  fs.writeFileSync(path.join(dataDir, 'runner-fault-fail'), '');
  const bad = runCli();
  assert.equal(bad.status, 1, `CLI catch-up exit 1 on fault: ${bad.stderr}`);
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'failed');
  assert.ok(bad.stderr.includes('startup-recovery-failed'), 'failure logged as startup-recovery-failed');
  fs.rmSync(path.join(dataDir, 'runner-fault-fail'));
  // ...and the API's verifyStartupReadiness rejects the failed record
  // (readiness-status-not-ok), so the API never listens on an
  // unreconciled store. verifyStartupReadiness reads the counter file
  // (the shared /var/lib/nova-api path) and the state dir at import
  // time, so the test sets both up and restores them afterwards.
  const GEN_A = '11111111-1111-4111-8111-111111111111';
  let counterBefore = null;
  try { counterBefore = fs.readFileSync(COUNTER_PATH); } catch { counterBefore = null; }
  t.after(() => {
    if (counterBefore === null) { try { fs.unlinkSync(COUNTER_PATH); } catch { /* gone */ } }
    else fs.writeFileSync(COUNTER_PATH, counterBefore);
    delete process.env.NOVA_STARTUP_STATE_DIR;
  });
  fs.writeFileSync(COUNTER_PATH, JSON.stringify({
    attempts: 1, windowStart: new Date().toISOString(), reservation: null, generation: GEN_A,
  }) + '\n');
  process.env.NOVA_STARTUP_STATE_DIR = dataDir;
  const attempts = await import('../src/api-server/startup-attempts.js');
  assert.throws(
    () => attempts.verifyStartupReadiness(),
    (e) => e.condition === 'readiness-status-not-ok',
    'API refuses a failed readiness record',
  );
});

test('runner: CLI daemon runs an immediate pass on the same root, then stays up', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, {});
  expireObject(dataDir, 'outputs', record.objectId);
  const proc = spawn(process.execPath, [RUNNER, '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  // The daemon's immediate pass sweeps the same store root.
  let heartbeat = null;
  for (let i = 0; i < 100 && !heartbeat; i++) {
    await new Promise((r) => setTimeout(r, 100));
    heartbeat = readJson(path.join(dataDir, 'runner-health.json'));
  }
  assert.ok(heartbeat, 'daemon wrote a heartbeat');
  assert.equal(heartbeat.status, 'ok');
  assert.equal(heartbeat.objectsDeleted, 1, 'daemon pass deleted the expired object from the shared root');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.equal(storage.index.getObject('outputs', record.objectId), null);
  // The daemon ignores fault markers (they are a --catch-up-only test
  // hook): a fail marker left in the state dir must not stop it.
  fs.writeFileSync(path.join(dataDir, 'runner-fault-fail'), '');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(proc.exitCode, null, 'daemon still running with a fail marker present');
  fs.rmSync(path.join(dataDir, 'runner-fault-fail'));
  // SIGTERM is a clean shutdown (exit 0).
  proc.kill('SIGTERM');
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.equal(code, 0, 'daemon exits 0 on SIGTERM');
});

test('runner: heartbeat gate — missing/stale heartbeat blocks new submits, fresh heartbeat lets them through', async (t) => {
  const { DispatchManager } = await import('../src/api-server/dispatch.js');
  const { GpuManager } = await import('../src/gpu-manager.js');
  const { ApiStateStore } = await import('../src/api-server/state-store.js');
  const { PROVEN_MODEL, PROVEN_FRAMES, PROVEN_RESOLUTION, PROVEN_FPS } =
    await import('../src/api-server/constants.js');
  const dir = tempDataDir(t);
  const healthPath = path.join(dir, 'runner-health.json');
  const calls = [];
  const exec = {
    id: 'provider-a',
    submissions: new Map(),
    start(job) { calls.push(['start', job.id]); return new Promise(() => {}); },
    getExecutionState() { return { state: 'unknown', evidence: { raw: null } }; },
  };
  const manager = new GpuManager({
    storePath: path.join(dir, 'gpu-manager.json'),
    now: () => Date.now(),
    config: { maxQueueDepth: 100 },
  });
  manager.attachStorage(createStorage({ rootDir: path.join(dir, 'store') }));
  manager.registerProvider({
    id: 'provider-a', kind: 'kaggle', label: 'Test provider A', gpuType: 'NVIDIA T4',
    vramGb: 16, models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test only.' },
    maxConcurrentJobs: 1, connected: true, status: 'available',
  });
  manager.registerExecutor('provider-a', exec);
  const dispatch = new DispatchManager({
    manager,
    productionExecutors: new Map([['provider-a', exec]]),
    d1Client: {
      async d1Apply() { return {}; }, async d1Read() { return {}; },
      async getJob() { return null; }, async listScenes() { return []; },
      async listExpiredScenes() { return []; }, async listPendingJobs() { return []; },
      async listTerminalJobs() { return []; }, async listExpiredRateLimits() { return []; },
    },
    apiState: new ApiStateStore(path.join(dir, 'api-state.json')),
    mode: 'production',
    runnerHealthPath: healthPath,
  });
  t.after(() => dispatch.stop());
  const body = (jobId) => {
    const execId = `${jobId}:scene-0:attempt-1`;
    return {
      jobId, mode: 'single', model: PROVEN_MODEL, frames: PROVEN_FRAMES,
      resolution: PROVEN_RESOLUTION, fps: PROVEN_FPS, prompt: 'heartbeat gate test',
      sceneExecutions: [{ sceneIndex: 0, attempt: 1, executionId: execId, idempotencyKey: execId }],
    };
  };
  // (i) Missing heartbeat: 503 storage-full, nothing reserved.
  const r1 = await dispatch.submitExecutions(body(`nova-job-${'11111111-1111-4111-8111-111111111111'}`));
  assert.deepEqual(r1, { status: 503, body: { error: 'storage-full' } });
  assert.equal(calls.length, 0, 'no executor started while the heartbeat is missing');
  // (ii) Stale heartbeat (3 h old): same refusal.
  fs.writeFileSync(healthPath, JSON.stringify({
    lastSuccessfulSweepAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date().toISOString(), status: 'ok', objectsDeleted: 0, error: null,
  }));
  const r2 = await dispatch.submitExecutions(body(`nova-job-${'22222222-2222-4222-8222-222222222222'}`));
  assert.deepEqual(r2, { status: 503, body: { error: 'storage-full' } });
  assert.equal(calls.length, 0, 'no executor started while the heartbeat is stale');
  // (iii) Failed heartbeat: same refusal.
  fs.writeFileSync(healthPath, JSON.stringify({
    lastSuccessfulSweepAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date().toISOString(), status: 'failed', objectsDeleted: 0, error: 'test fault',
  }));
  const r3 = await dispatch.submitExecutions(body(`nova-job-${'33333333-3333-4333-8333-333333333333'}`));
  assert.deepEqual(r3, { status: 503, body: { error: 'storage-full' } });
  // (iv) Fresh healthy heartbeat: the submit proceeds to the provider.
  fs.writeFileSync(healthPath, JSON.stringify({
    lastSuccessfulSweepAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(), status: 'ok', objectsDeleted: 0, error: null,
  }));
  const jobId = `nova-job-${'44444444-4444-4444-8444-444444444444'}`;
  const r4 = await dispatch.submitExecutions(body(jobId));
  assert.equal(r4.status, 202, JSON.stringify(r4));
  assert.equal(calls.filter((c) => c[0] === 'start').length, 1, 'provider executor started once the heartbeat is healthy');
  assert.equal(dispatch.journalEntry(`${jobId}:scene-0:attempt-1`).executorId, 'provider-a');
});

// =============================================================================
// ChatGPT Rev 4.9 review corrections (Finding 8A, 10A–10E).
// =============================================================================

function indexObjectCount(dataDir) {
  const index = readJson(path.join(dataDir, 'store', 'index.json'));
  return index ? Object.keys(index.objects).length : 0;
}

test('runner: 8A — a future-dated heartbeat is stale (two-sided age check)', async () => {
  const now = Date.now();
  const at = (iso) => ({ present: true, parseable: true, status: 'ok', lastSuccessfulSweepAt: iso });
  // Fresh (1 min ago): healthy.
  assert.deepEqual(isRunnerHeartbeatHealthy(at(new Date(now - 60_000).toISOString()), now), { healthy: true, reason: 'ok' });
  // Exactly 2 h old: healthy (the bound is inclusive — older than 2 h is stale).
  assert.deepEqual(isRunnerHeartbeatHealthy(at(new Date(now - RUNNER_HEARTBEAT_MAX_AGE_MS).toISOString()), now), { healthy: true, reason: 'ok' });
  // Just over 2 h old: stale.
  assert.deepEqual(isRunnerHeartbeatHealthy(at(new Date(now - RUNNER_HEARTBEAT_MAX_AGE_MS - 1000).toISOString()), now), { healthy: false, reason: 'stale' });
  // Future-dated (1 h ahead): stale — a jumped clock must not make an old heartbeat look fresh.
  assert.deepEqual(isRunnerHeartbeatHealthy(at(new Date(now + 60 * 60 * 1000).toISOString()), now), { healthy: false, reason: 'stale' });
  // Missing / failed stay unhealthy.
  assert.deepEqual(isRunnerHeartbeatHealthy({ present: false, parseable: false, reason: 'missing' }, now), { healthy: false, reason: 'missing' });
  assert.deepEqual(isRunnerHeartbeatHealthy({ present: true, parseable: true, status: 'failed', lastSuccessfulSweepAt: new Date(now).toISOString() }, now), { healthy: false, reason: 'failed' });
});

test('runner: 10A — expired objects are unavailable on read but NOT physically deleted (the sweep deletes)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, {});
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  const ref = await storage.issueDeliveryRef({ namespace: 'outputs', objectId: record.objectId });
  expireObject(dataDir, 'outputs', record.objectId);
  // NOTE: expireObject edits index.json directly; the storage instance
  // reloads it on read (Finding 10C), so the reads below see the expiry.
  const chunksDir = path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId);
  assert.throws(
    () => storage.resolveForRead('outputs', record.objectId),
    (e) => e.code === 'object_not_found' && e.reason === 'expired',
    'resolveForRead reports an expired object as missing',
  );
  assert.throws(
    () => storage.get({ namespace: 'outputs', objectId: record.objectId }),
    (e) => e.code === 'object_not_found',
    'get reports an expired object as missing',
  );
  assert.equal(storage.head({ namespace: 'outputs', objectId: record.objectId }), null, 'head returns null for an expired object');
  await assert.rejects(
    () => storage.redeemDeliveryRef(ref.ref),
    (e) => e.code === 'object_not_found' && e.reason === 'expired',
    'a delivery ref to an expired object fails',
  );
  // ...but nothing was physically deleted by any of those reads: the
  // chunks and the index record are still there for the sweep.
  assert.ok(fs.existsSync(path.join(chunksDir, '0.chunk')), 'chunks still on disk after expired reads');
  const after = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.ok(after.index.getObject('outputs', record.objectId), 'index record still present after expired reads');
  // The runner's sweep is the sole deleter: it removes the object.
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(chunksDir), false, 'sweep physically deleted the expired object');
  assert.equal(after.index.getObject('outputs', record.objectId), null, 'index record dropped by the sweep');
});

test('runner: 10B — missing index.json is rebuilt from per-object manifests (objects survive)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, { jobId: 'job-manifest-1' });
  const manifestPath = path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'put wrote a manifest next to the chunks');
  const manifest = readJson(manifestPath);
  assert.equal(manifest.objectId, record.objectId);
  assert.equal(manifest.jobId, 'job-manifest-1', 'the manifest carries the job link');
  assert.equal(manifest.chunkCount, record.chunkCount);
  // Lose the index entirely, as a disk fault would.
  fs.rmSync(path.join(dataDir, 'store', 'index.json'));
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true, `catch-up ok after index loss: ${r.error?.message ?? ''}`);
  assert.equal(r.report.indexRebuilt, true, 'indexRebuilt is true — reconstruction actually happened');
  assert.equal(r.report.indexRestored, 1);
  assert.deepEqual(r.report.unrecoverableOrphans, []);
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.ok(storage.index.getObject('outputs', record.objectId), 'object re-indexed from its manifest');
  assert.equal(storage.index.getObject('outputs', record.objectId).jobId, 'job-manifest-1', 'job link restored');
  const buf = await storage.getBuffer({ namespace: 'outputs', objectId: record.objectId });
  assert.equal(buf.length, record.sizeBytes, 'restored object bytes are readable and hash-verified');
  assert.equal(deletionLog(dataDir).filter((e) => e.reason === 'orphan').length, 0, 'no surviving object was deleted as an orphan');
  const readiness = readJson(path.join(dataDir, 'readiness.json'));
  assert.equal(readiness.indexRebuilt, true);
  assert.equal(readiness.indexRestored, 1);
});

test('runner: 10B — missing index + no manifests fails closed (surviving chunks are NOT deleted)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, {});
  // Simulate a pre-manifest store: strip the manifest, then lose the index.
  fs.rmSync(path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId, 'manifest.json'));
  fs.rmSync(path.join(dataDir, 'store', 'index.json'));
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, false, 'catch-up fails rather than deleting the surviving chunks');
  assert.match(r.error.message, /refusing to delete orphan chunks/, 'fail-closed error names the refusal');
  assert.ok(fs.existsSync(path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId, '0.chunk')), 'surviving chunks preserved on disk');
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'failed');
  assert.equal(readJson(path.join(dataDir, 'runner-health.json')).status, 'failed');
  assert.equal(deletionLog(dataDir).length, 0, 'nothing logged as deleted');
});

test('runner: 10B — partial manifest loss restores what it can and preserves the rest', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const good = await putObject(dataDir, {});
  const bad = await putObject(dataDir, {});
  // Tamper with one manifest (valid JSON, a chunk hash that no longer
  // matches the bytes on disk): it cannot prove the object's integrity,
  // so the object is unrecoverable.
  const badManifestPath = path.join(dataDir, 'store', 'chunks', 'outputs', bad.objectId, 'manifest.json');
  const badManifest = readJson(badManifestPath);
  badManifest.chunkHashes[0] = '0'.repeat(64);
  fs.writeFileSync(badManifestPath, JSON.stringify(badManifest, null, 2));
  fs.rmSync(path.join(dataDir, 'store', 'index.json'));
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true, `catch-up ok with one unrecoverable object: ${r.error?.message ?? ''}`);
  assert.equal(r.report.indexRebuilt, true);
  assert.equal(r.report.indexRestored, 1);
  assert.equal(r.report.unrecoverableOrphans.length, 1);
  assert.equal(r.report.unrecoverableOrphans[0].objectId, bad.objectId);
  assert.equal(r.report.unrecoverableOrphans[0].reason, 'manifest-chunk-hash-mismatch');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.ok(storage.index.getObject('outputs', good.objectId), 'restorable object re-indexed');
  assert.equal(storage.index.getObject('outputs', bad.objectId), null, 'unrecoverable object not indexed');
  assert.ok(fs.existsSync(path.join(dataDir, 'store', 'chunks', 'outputs', bad.objectId, '0.chunk')), 'unrecoverable chunks preserved on disk, not deleted');
  assert.equal(deletionLog(dataDir).filter((e) => e.objectId === bad.objectId).length, 0, 'unrecoverable object never logged as deleted');
  const readiness = readJson(path.join(dataDir, 'readiness.json'));
  assert.equal(readiness.unrecoverableOrphans.length, 1);
  assert.equal(readiness.unrecoverableOrphans[0].objectId, bad.objectId);
});

test('runner: malformed index.json fails the catch-up (no deletion, failed readiness + heartbeat)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const record = await putObject(dataDir, {});
  fs.writeFileSync(path.join(dataDir, 'store', 'index.json'), '{ not json');
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, false, 'catch-up fails on a malformed index');
  assert.match(r.error.message, /unusable/, 'fail-closed error names the unusable index');
  assert.ok(fs.existsSync(path.join(dataDir, 'store', 'chunks', 'outputs', record.objectId, '0.chunk')), 'chunks untouched by a failed pass');
  assert.equal(readJson(path.join(dataDir, 'readiness.json')).status, 'failed');
  assert.equal(readJson(path.join(dataDir, 'runner-health.json')).status, 'failed');
});

test('runner: 10C — a fresh orphan chunk dir is preserved (a put in flight is not a crash leftover)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  // A chunk dir created moments ago with no index record: exactly what
  // a put looks like between finalising its chunks and writing the
  // index record. The sweep must leave it alone.
  const orphanId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const orphanDir = path.join(dataDir, 'store', 'chunks', 'outputs', orphanId);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, '0.chunk'), Buffer.alloc(16, 0x42));
  const healthy = await putObject(dataDir, {});
  const r = await runCatchUp({ dataDir });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(orphanDir, '0.chunk')), 'fresh orphan chunk dir preserved');
  assert.equal(deletionLog(dataDir).filter((e) => e.objectId === orphanId).length, 0, 'fresh orphan never logged as deleted');
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  assert.ok(storage.index.getObject('outputs', healthy.objectId), 'healthy object untouched');
});

test('runner: 10C — repeated API writes during a runner sweep: every accepted object stays readable', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const outPath = path.join(dataDir, 'worker-result.json');
  const workerPath = path.join(import.meta.dirname, 'phase5-index-concurrency-worker.mjs');
  const worker = spawn(process.execPath, [workerPath, '--data-dir', dataDir, '--count', '20', '--out', outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let workerErr = '';
  worker.stderr.on('data', (d) => { workerErr += d.toString(); });
  let workerDone = false;
  const workerExit = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', (code) => {
      workerDone = true;
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${workerErr}`));
    });
  });
  // Run sweeps in a loop while the worker writes: the sweeps must never
  // clobber a put or a delivery-ref mutation.
  let sweeps = 0;
  while (!workerDone) {
    const outcome = await runPassLocked({ dataDir, catchUp: false });
    assert.equal(outcome.ok, true, `sweep ok: ${outcome.error?.message ?? ''}`);
    sweeps += 1;
    await new Promise((r) => setTimeout(r, 10));
  }
  await workerExit;
  assert.ok(sweeps >= 2, `at least 2 sweeps ran during the worker's writes (ran ${sweeps})`);
  const { accepted } = readJson(outPath);
  assert.equal(accepted.length, 20);
  const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
  for (const a of accepted) {
    const head = storage.head({ namespace: a.namespace, objectId: a.objectId });
    assert.ok(head, `object ${a.objectId} still indexed with metadata`);
    assert.equal(head.sizeBytes, a.sizeBytes);
    const buf = await storage.getBuffer({ namespace: a.namespace, objectId: a.objectId });
    assert.equal(buf.length, a.sizeBytes, 'object bytes readable');
    // The delivery ref issued by the worker still redeems (redemptions
    // continue from the worker's redeem, not reset by a sweep).
    const again = await storage.redeemDeliveryRef(a.ref);
    assert.equal(again.redemptions, a.redemptions + 1, 'delivery ref survived the sweeps');
  }
  assert.equal(storage.index.listObjects().length, 20, 'no object lost, none duplicated');
});

test('runner: 10D — daemon with a malformed index fails the pass, records a failed heartbeat, and stays alive', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  fs.mkdirSync(path.join(dataDir, 'store'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'store', 'index.json'), '{ not json');
  const lines = [];
  const origError = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  t.after(() => { console.error = origError; });
  const daemon = runDaemon({ dataDir, intervalMs: 60_000 });
  t.after(() => daemon.stop().catch(() => {}));
  await daemon.started;
  const hb = readJson(path.join(dataDir, 'runner-health.json'));
  assert.equal(hb.status, 'failed');
  assert.ok(hb.error && hb.error.length > 0, 'failed heartbeat carries the error');
  assert.match(hb.error, /unusable/, 'failed heartbeat names the unusable index');
  assert.match(lines.join('\n'), /hourly pass failed/, 'failure logged as an hourly pass failure');
  assert.ok(daemon.timer, 'daemon timer armed after a failed pass (stays alive for the next hourly pass)');
  await daemon.stop();
});

test('runner: 10E — stop during the initial pass waits for it (queued pass skips, nothing runs)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const N = 5;
  for (let i = 0; i < N; i++) {
    const rec = await putObject(dataDir, {});
    expireObject(dataDir, 'outputs', rec.objectId);
  }
  // Hold the sweep lock so the daemon's initial pass cannot start: it
  // queues on the lock, active but not running. (Lock-controlled timing
  // — no wall-clock race: on tmpfs a 200-object sweep finishes in
  // milliseconds, faster than any poll could observe.)
  const sweepLockPath = path.join(dataDir, 'sweep.lock');
  const lockFd = fs.openSync(sweepLockPath, 'w');
  assert.equal(flockExNb(lockFd), true, 'test holds the sweep lock');
  try {
    const daemon = runDaemon({ dataDir, intervalMs: 60_000 });
    t.after(() => daemon.stop().catch(() => {}));
    // Give the initial pass a moment to reach the lock wait.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')), null, 'no heartbeat while the pass is queued');
    assert.equal(indexObjectCount(dataDir), N, 'nothing deleted while the pass is queued');
    // Stop while the pass is queued: stop() must wait for it.
    let stopResolved = false;
    const stopping = daemon.stop().then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stopResolved, false, 'stop() waits while the pass is queued');
    // Release the lock: the queued pass acquires it, sees shutdown, and
    // skips — so nothing is deleted and no heartbeat is written.
    flockUn(lockFd);
    fs.closeSync(lockFd);
    await stopping;
    assert.equal(daemon.timer, null, 'interval cleared by stop()');
    assert.equal(indexObjectCount(dataDir), N, 'the skipped pass deleted nothing');
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')), null, 'the skipped pass wrote no heartbeat');
  } finally {
    try { flockUn(lockFd); } catch { /* already released */ }
    try { fs.closeSync(lockFd); } catch { /* already closed */ }
  }
});

test('runner: 10E — stop during a running sweep waits for it to finish (and repeated stop is idempotent)', async (t) => {
  const dataDir = tempDataDir(t);
  writeRequestId(dataDir);
  const N = 5;
  for (let i = 0; i < N; i++) {
    const rec = await putObject(dataDir, {});
    expireObject(dataDir, 'outputs', rec.objectId);
  }
  // Hold the INDEX lock: the daemon's sweep blocks on its first
  // deletion, genuinely mid-sweep (it already holds the sweep lock and
  // has passed every lock-free phase — the index lock is the only wait
  // point left in the deletion loop).
  const indexLockPath = path.join(dataDir, 'store', 'index.lock');
  const lockFd = fs.openSync(indexLockPath, 'w');
  assert.equal(flockExNb(lockFd), true, 'test holds the index lock');
  try {
    const daemon = runDaemon({ dataDir, intervalMs: 60_000 });
    t.after(() => daemon.stop().catch(() => {}));
    // Wait until the pass is blocked mid-sweep: no heartbeat after a
    // generous wait, and nothing deleted.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')), null, 'no heartbeat while the pass is blocked mid-sweep');
    assert.equal(indexObjectCount(dataDir), N, 'nothing deleted while the pass is blocked mid-sweep');
    // Stop while the pass is mid-sweep: stop() must wait for it.
    let stopResolved = false;
    const stopping = daemon.stop().then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stopResolved, false, 'stop() waits while the pass is mid-sweep');
    // Repeated stop is idempotent: a second call waits on the same pass
    // and resolves with the first.
    const stopping2 = daemon.stop().then(() => {});
    // Release the index lock: the pass finishes its deletions.
    flockUn(lockFd);
    fs.closeSync(lockFd);
    await stopping;
    await stopping2;
    assert.equal(daemon.timer, null, 'interval cleared by stop()');
    assert.equal(indexObjectCount(dataDir), 0, 'the pass finished deleting after stop() began');
    const hb = readJson(path.join(dataDir, 'runner-health.json'));
    assert.equal(hb.status, 'ok');
    assert.equal(hb.objectsDeleted, N, 'heartbeat records the full pass');
    const lastAttempt = hb.lastAttemptAt;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readJson(path.join(dataDir, 'runner-health.json')).lastAttemptAt, lastAttempt, 'no pass started after stop()');
  } finally {
    try { flockUn(lockFd); } catch { /* already released */ }
    try { fs.closeSync(lockFd); } catch { /* already closed */ }
  }
});
