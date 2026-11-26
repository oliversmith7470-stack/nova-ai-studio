// phase5-installed.test.mjs — §15 installed-unit tests (w), (aa), (ab), (m),
// (n), (o), (p), (q), (l), (ac), (s), (r), (z), (t) against the installed
// units in /etc/systemd/system + /opt/nova-ai-studio.
//
// GATED: every test skips unless NOVA_PHASE5_INSTALLED_TESTS=1. ONE file,
// sequential (all tests share the units/counter) — NEVER run concurrently
// with any other phase5 test file. Run alone:
//   NOVA_PHASE5_INSTALLED_TESTS=1 node --test test/phase5-installed.test.mjs
//
// SCOPE NOTE (Rev 4.9 — defect #4 FIXED): the production executor
// registration factory is implemented, so the API now listens via its
// shipped CLI/systemd path (empty production allowlist -> no-capacity
// state, personal kaggle-t4 only with a credential). The "API listens"
// legs of (aa)/(ab)/(s)/(u)/(v) are therefore demonstrable through
// systemd and are asserted here, not marked BLOCKED. What the installed
// tests still depend on (host config, not code):
//   - /etc/nova-api/api.env must carry NOVA_WORKER_ORIGIN (the §15
//     test-stub Worker on 127.0.0.1:18099 on this dev VM; the real Pages
//     Worker origin on a production host). The shipped unit carries no
//     Worker origin — without it the factory fails (HttpD1Client
//     requires a resolvable origin).
//   - The staged repo tree (/opt/nova-ai-studio/gpu-cloud) must be
//     readable by User=nova-api (0644 files / 0755 dirs), the
//     startup-request-id file must be 0644 (prepare-startup-id.sh
//     chmods it — mktemp creates 0600), and the counter lock file must
//     be 0660 root:nova-api (install.sh + both root scripts normalise
//     it). A permission failure on any of these surfaces as
//     startup-factory-failed (EACCES) or startup-recovery-counter-
//     unwritable (lock) or a 'none' request id in the readiness record.
// The listening legs are also asserted at unit level in
// phase5-startup.test.mjs (in-process start() listens).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ENABLED = process.env.NOVA_PHASE5_INSTALLED_TESTS === '1';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const STATE_DIR = '/var/lib/nova-api';
const COUNTER_PATH = `${STATE_DIR}/startup-attempts`;
const REQUEST_ID_PATH = `${STATE_DIR}/startup-request-id`;
const READINESS_PATH = `${STATE_DIR}/readiness.json`;
const DEDUP_PATH = `${STATE_DIR}/alert-dedup.json`;
const PENDING_PATH = `${STATE_DIR}/alert-pending.json`;
const CHECKPOINT_PATH = `${STATE_DIR}/health-check-state.json`;
const COUNTER_CLI = '/opt/nova-ai-studio/bin/startup-counter.mjs';
const PREPARE_SH = '/opt/nova-ai-studio/bin/prepare-startup-id.sh';
const RETRY_SH = '/opt/nova-ai-studio/bin/retry-startup.sh';
const INSTALLED_WRAPPER = '/opt/nova-ai-studio/bin/run-health-check.sh';
const STAGED_DISPATCH = '/opt/nova-ai-studio/gpu-cloud/src/api-server/dispatch.js';
const STUB_WORKER = path.join(import.meta.dirname, 'phase5-stub-worker.mjs');
const WORKER_PORT = 18099;

const skip = { skip: !ENABLED };

// --- shell helpers -----------------------------------------------------------
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 30000, ...opts });
}
function sysctl(...args) { return sh('systemctl', args, { timeout: 60000 }); }
function sysctlOk(...args) {
  const r = sysctl(...args);
  assert.equal(r.status, 0, `systemctl ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
function unitShow(unit, props) {
  const out = sysctlOk('show', unit, '-p', props.join(','));
  const obj = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
  }
  return obj;
}
function journalSince(sinceIso, extraArgs = []) {
  const r = sh('journalctl', ['--since', sinceIso, '--no-pager', ...extraArgs], { timeout: 60000 });
  assert.equal(r.status, 0, `journalctl failed: ${r.stderr}`);
  return r.stdout ?? '';
}
function journalUnits(sinceIso, units) {
  const args = [];
  for (const u of units) args.push('-u', u);
  return journalSince(sinceIso, args);
}
function journalTag(sinceIso, tag) {
  return journalSince(sinceIso, ['-t', tag]);
}
async function waitFor(fn, { timeoutMs = 60000, intervalMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms); last=${JSON.stringify(last)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- counter / state helpers -------------------------------------------------
function readCounter() {
  try { return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8')); }
  catch { return null; }
}
function readCounterRaw() {
  try { return fs.readFileSync(COUNTER_PATH, 'utf8'); }
  catch { return null; }
}
function writeCounter(obj) {
  fs.writeFileSync(COUNTER_PATH, typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n');
}
function readRequestId() {
  try { return fs.readFileSync(REQUEST_ID_PATH, 'utf8').trim() || null; }
  catch { return null; }
}
function readReadiness() {
  try { return JSON.parse(fs.readFileSync(READINESS_PATH, 'utf8')); }
  catch { return null; }
}
function sha256(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function setMarker(name) { fs.writeFileSync(`${STATE_DIR}/${name}`, ''); }
function clearMarkers() {
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (f.startsWith('runner-fault-')) fs.rmSync(path.join(STATE_DIR, f), { force: true });
  }
}
function cleanState() {
  for (const f of ['startup-attempts', 'startup-request-id', 'readiness.json', 'runner-health.json', 'api-state.json', 'gpu-manager.json']) {
    fs.rmSync(path.join(STATE_DIR, f), { force: true });
  }
  fs.rmSync(path.join(STATE_DIR, 'store'), { recursive: true, force: true });
  clearMarkers();
}
function stopChain() {
  sysctl('stop', 'nova-api-server.service');
  sysctl('stop', 'nova-storage-recovery.service');
  sysctl('stop', 'nova-startup-retry.service');
  sysctl('reset-failed', 'nova-api-server.service', 'nova-startup-id.service', 'nova-storage-recovery.service', 'nova-startup-retry.service');
}
function cancelRearmTimers() {
  // Transient re-arm timers (nova-startup-rearm-<token>.timer/.service)
  // survive a unit stop: cancel them, or one fires mid-test and starts a
  // supervisor that starts a chain.
  const list = sh('systemctl', ['list-units', '--all', '--no-legend', 'nova-startup-rearm-*'], { timeout: 15000 }).stdout ?? '';
  for (const line of list.split('\n')) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit && unit.startsWith('nova-startup-rearm-')) sysctl('stop', unit);
  }
}

async function quiesce() {
  // A pending auto-restart can re-create the counter after the first
  // stop+clean, so loop until it stays absent — and cancel any re-arm
  // timer left by an earlier test before declaring the state clean.
  for (let attempt = 0; attempt < 3; attempt++) {
    stopChain();
    cancelRearmTimers();
    cleanState();
    await sleep(5000);
    const retryState = sysctl('is-active', 'nova-startup-retry.service').stdout.trim();
    if (readCounter() === null && retryState === 'inactive') return;
  }
  assert.equal(readCounter(), null, 'counter stays absent after quiesce');
  assert.equal(sysctl('is-active', 'nova-startup-retry.service').stdout.trim(), 'inactive', 'supervisor quiesced');
}

// Isolation: quiesce after EVERY test, even one that throws mid-way, so a
// failed test's restart loop can never pollute the next test.
test.afterEach(async () => {
  if (!ENABLED) return;
  try { await quiesce(); } catch { /* best-effort: the next test's quiesce retries */ }
});


// Collect distinct request ids seen while polling (the id file holds only
// the latest id, so poll frequently during a restart loop). Stops on the
// flag OR after maxMs (safety net: a test that throws must never leave this
// loop polling forever and hang the runner).
async function collectRequestIds(stopFn, intervalMs = 2000, maxMs = 900000) {
  const ids = new Set();
  const deadline = Date.now() + maxMs;
  while (!stopFn() && Date.now() < deadline) {
    const id = readRequestId();
    if (id) ids.add(id);
    await sleep(intervalMs);
  }
  const id = readRequestId();
  if (id) ids.add(id);
  return ids;
}

// Main-process exit statuses from the API unit journal, in order.
function apiExitStatuses(sinceIso) {
  const lines = journalUnits(sinceIso, ['nova-api-server.service']).split('\n');
  return lines
    .filter((l) => l.includes('Main process exited, code=exited, status='))
    .map((l) => Number(/status=(\d+)/.exec(l)?.[1]));
}

// --- stub Worker lifecycle (file level) --------------------------------------
let workerProc = null;
test.before(async () => {
  if (!ENABLED) return;
  await quiesce();
  workerProc = spawn(process.execPath, [STUB_WORKER, String(WORKER_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  workerProc.stdout.on('data', (d) => { out += d; });
  workerProc.stderr.on('data', (d) => { err += d; });
  try {
    await waitFor(() => out.includes(`listening on 127.0.0.1:${WORKER_PORT}`), { timeoutMs: 10000, label: 'stub worker listening' });
  } catch (e) {
    throw new Error(`stub worker did not start (port ${WORKER_PORT} may be held by a stale worker): stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`);
  }
});
test.after(async () => {
  if (workerProc) { workerProc.kill('SIGTERM'); workerProc = null; }
  if (!ENABLED) return;
  await quiesce();
});

// =============================================================================
// (w) Installed copies byte-identical + single shared module
// =============================================================================
test('(w) installed copies byte-identical to canonical; single shared module', skip, (t) => {
  const pairs = [
    ['gpu-cloud/systemd/nova-api-server.service', '/etc/systemd/system/nova-api-server.service'],
    ['gpu-cloud/systemd/nova-storage-recovery.service', '/etc/systemd/system/nova-storage-recovery.service'],
    ['gpu-cloud/systemd/nova-storage-runner.service', '/etc/systemd/system/nova-storage-runner.service'],
    ['gpu-cloud/systemd/nova-startup-id.service', '/etc/systemd/system/nova-startup-id.service'],
    ['gpu-cloud/systemd/nova-startup-retry.service', '/etc/systemd/system/nova-startup-retry.service'],
    ['gpu-cloud/systemd/nova-health-check.service', '/etc/systemd/system/nova-health-check.service'],
    ['gpu-cloud/systemd/nova-health-check.timer', '/etc/systemd/system/nova-health-check.timer'],
    ['gpu-cloud/src/storage-runner.js', '/opt/nova-ai-studio/src/storage-runner.js'],
    ['gpu-cloud/systemd/prepare-startup-id.sh', '/opt/nova-ai-studio/bin/prepare-startup-id.sh'],
    ['gpu-cloud/systemd/retry-startup.sh', '/opt/nova-ai-studio/bin/retry-startup.sh'],
    ['gpu-cloud/src/api-server/run-health-check.sh', '/opt/nova-ai-studio/bin/run-health-check.sh'],
    ['gpu-cloud/src/api-server/startup-counter.mjs', '/opt/nova-ai-studio/bin/startup-counter.mjs'],
    ['gpu-cloud/src/api-server/startup-counter.mjs', '/opt/nova-ai-studio/src/api-server/startup-counter.mjs'],
    ['gpu-cloud/src/api-server/startup-attempts.js', '/opt/nova-ai-studio/src/api-server/startup-attempts.js'],
    ['gpu-cloud/src/api-server/alert-dispatcher.js', '/opt/nova-ai-studio/src/api-server/alert-dispatcher.js'],
    ['gpu-cloud/src/api-server/health-check.js', '/opt/nova-ai-studio/src/api-server/health-check.js'],
    ['gpu-cloud/src/api-server/flock-binding.mjs', '/opt/nova-ai-studio/src/api-server/flock-binding.mjs'],
    ['gpu-cloud/src/api-server/flock-binding.node', '/opt/nova-ai-studio/src/api-server/flock-binding.node'],
  ];
  for (const [canonical, installed] of pairs) {
    assert.equal(sha256(path.join(REPO_ROOT, canonical)), sha256(installed), `${installed} byte-identical to ${canonical}`);
  }
  // The storage package (imported by the runner at the install path):
  // every gpu-cloud/src/storage/*.js file is installed byte-identical.
  const storageFiles = fs.readdirSync(path.join(REPO_ROOT, 'gpu-cloud/src/storage')).filter((f) => f.endsWith('.js')).sort();
  assert.ok(storageFiles.length > 0, 'storage package has files to check');
  for (const f of storageFiles) {
    assert.equal(
      sha256(path.join(REPO_ROOT, 'gpu-cloud/src/storage', f)),
      sha256(path.join('/opt/nova-ai-studio/src/storage', f)),
      `/opt/nova-ai-studio/src/storage/${f} byte-identical to gpu-cloud/src/storage/${f}`,
    );
  }
  // Single shared module: the counter module is the SAME bytes in bin/,
  // src/api-server/ AND the staged repo tree (three copies, one module).
  const binHash = sha256('/opt/nova-ai-studio/bin/startup-counter.mjs');
  assert.equal(binHash, sha256('/opt/nova-ai-studio/src/api-server/startup-counter.mjs'));
  assert.equal(binHash, sha256('/opt/nova-ai-studio/gpu-cloud/src/api-server/startup-counter.mjs'));
  assert.equal(binHash, sha256(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-counter.mjs')));
  // Staged repo tree identical to the canonical gpu-cloud/src tree.
  const diff = sh('diff', ['-rq', path.join(REPO_ROOT, 'gpu-cloud/src'), '/opt/nova-ai-studio/gpu-cloud/src']);
  assert.equal(diff.status, 0, `staged tree identical to canonical src: ${diff.stdout}`);
  // systemd-analyze verify passes on all 7 units (exit code only; unrelated
  // system timers warn on stderr — ignored).
  for (const unit of ['nova-api-server', 'nova-storage-recovery', 'nova-startup-id', 'nova-startup-retry', 'nova-storage-runner', 'nova-health-check.service', 'nova-health-check.timer']) {
    const r = sh('systemd-analyze', ['verify', `/etc/systemd/system/${unit}${unit.endsWith('.service') || unit.endsWith('.timer') ? '' : '.service'}`], { timeout: 60000 });
    assert.equal(r.status, 0, `systemd-analyze verify ${unit}: ${r.stderr.slice(0, 500)}`);
  }
});

// =============================================================================
// (ab) Installed wrapper: free lock runs the real probe, held lock skips
// =============================================================================
test('(ab) installed wrapper: free lock exit 0 + checkpoint; held lock exit 0 + skip', skip, async (t) => {
  const snapshot = new Map();
  for (const p of [DEDUP_PATH, PENDING_PATH, CHECKPOINT_PATH]) {
    try { snapshot.set(p, fs.readFileSync(p)); } catch { snapshot.set(p, null); }
  }
  t.after(() => {
    for (const [p, bytes] of snapshot) {
      if (bytes === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, bytes);
    }
  });
  assert.equal(fs.existsSync(INSTALLED_WRAPPER), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-wrapper-inst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = new Date(Date.now() - 2000).toISOString();
  const r1 = sh('sh', [INSTALLED_WRAPPER], { timeout: 60000, cwd: dir });
  assert.equal(r1.status, 0, `installed wrapper free lock -> exit 0, stderr: ${r1.stderr}`);
  assert.equal(fs.existsSync(path.join(dir, '9')), false, 'no file named 9 in the cwd');
  const checkpoint = (() => { try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')); } catch { return null; } })();
  assert.ok(checkpoint && typeof checkpoint.lastScan === 'string', `installed probe advanced the checkpoint: ${JSON.stringify(checkpoint)}`);
  const { flockExNb, flockUn } = await import('../src/api-server/flock-binding.mjs');
  const lockPath = `${STATE_DIR}/health-check.lock`;
  const fd = fs.openSync(lockPath, 'a');
  assert.equal(flockExNb(fd), true);
  try {
    const r2 = sh('sh', [INSTALLED_WRAPPER], { timeout: 15000, cwd: dir });
    assert.equal(r2.status, 0, `installed wrapper held lock -> exit 0, got ${r2.status}`);
  } finally { flockUn(fd); fs.closeSync(fd); }
  let journal = '';
  for (let i = 0; i < 5 && !journal.includes('health-check-skipped-overlap'); i++) {
    await sleep(1000);
    journal = journalTag(before, 'nova-health-check');
  }
  assert.ok(journal.includes('health-check-skipped-overlap'), `journal shows the skip since ${before}:\n${journal.slice(-2000)}`);
});

// =============================================================================
// (aa) Four-mode demonstration (Rev 4.9 — defect #4 FIXED, API listens)
// (i) explicit start -> active after READY=1, counter reset (absent),
//     readiness ok. (ii) explicit restart -> fresh chain, new request id,
//     active again. (iii) automatic Restart=on-failure (kill -9 the API
//     process) -> restarts, active again, new request id, counter reset.
// (iv) supervisor-initiated start -> fail-once marker makes the first
//     chain fail; OnFailure fires the supervisor once; its chain succeeds
//     and step (8) correctly sees active and exits 0 WITHOUT re-arming
//     (Rev 4.9 §5: under Type=notify `systemctl start` returns only after
//     READY=1, so 'active' now means the chain really succeeded — the old
//     defect #5 race is gone, and no re-arm is the CORRECT outcome here).
// The to-42 startup-failure loop is covered by (ab) (import failure) +
// the (aa) CLI test (start limiter at 5, exit 42) + (ac) (limit respected).
// =============================================================================
test('(aa) four-mode: explicit start, explicit restart, automatic restart, supervisor-initiated start', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  const ids = new Set();
  const stopCollect = { v: false };
  const collector = collectRequestIds(() => stopCollect.v, 2000);
  // Stop the collector even if this test throws mid-way (otherwise its
  // polling loop keeps the runner process alive forever).
  t.after(() => { stopCollect.v = true; });

  // (i) Explicit start with dependencies inactive. Type=notify: the
  // start job blocks until READY=1, so a 0 exit already means the API
  // listened. Assert the rest independently.
  let r = sysctl('start', 'nova-api-server.service');
  assert.equal(r.status, 0, `explicit start -> 0: ${r.stderr}`);
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 30000, label: 'API active after explicit start' });
  const id1 = readRequestId();
  assert.ok(id1, 'request id written by preparation');
  ids.add(id1);
  const readiness1 = await waitFor(() => readReadiness(), { timeoutMs: 30000, label: 'readiness written' });
  assert.equal(readiness1.status, 'ok');
  assert.equal(readiness1.startupRequestId, id1, 'readiness echoes the fresh request id');
  // The journal is read through journald, which flushes asynchronously:
  // the API's log line can lag the counter reset by a fraction of a
  // second, so wait for the lines instead of asserting them immediately.
  const journal1 = await waitFor(() => {
    const j = journalUnits(since, ['nova-api-server.service']);
    return j.includes('startup-recovery-succeeded') ? j : null;
  }, { timeoutMs: 30000, label: 'startup-recovery-succeeded logged' });
  assert.ok(journal1.includes('listening on 127.0.0.1:8788'), 'API logged its listen line');
  const health = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8788/health'], { timeout: 10000 });
  assert.equal(health.stdout.trim(), '401', 'API answers on 8788 (401 = listening, auth enforced)');
  // READY=1 is sent before the counter reset runs, so the reset may still
  // be in flight when `systemctl start` returns — wait for it.
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after a successful listen' });

  // (ii) Explicit restart: fresh chain attempt, new request id, active again.
  r = sysctl('restart', 'nova-api-server.service');
  assert.equal(r.status, 0, `explicit restart -> 0: ${r.stderr}`);
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 30000, label: 'API active after explicit restart' });
  const id2 = readRequestId();
  assert.ok(id2 && id2 !== id1, 'restart re-ran preparation with a fresh request id');
  ids.add(id2);
  const readiness2 = readReadiness();
  assert.equal(readiness2?.status, 'ok');
  assert.equal(readiness2?.startupRequestId, id2, 'readiness echoes the restart request id');
  // READY=1 precedes the reset — wait for it (see (i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the restart listen' });

  // (iii) Automatic Restart=on-failure: kill -9 the API main process;
  // systemd restarts it after RestartSec=30, a fresh chain runs, and the
  // API is active again with a new request id and the counter reset.
  const pidOut = sysctl('show', 'nova-api-server.service', '-p', 'MainPID');
  const mainPid = Number.parseInt(pidOut.stdout.replace('MainPID=', '').trim(), 10);
  assert.ok(Number.isFinite(mainPid) && mainPid > 0, `API MainPID readable: ${pidOut.stdout}`);
  spawnSync('kill', ['-9', String(mainPid)], { timeout: 10000 });
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 120000, label: 'API active again after kill -9 + Restart=on-failure' });
  const id3 = readRequestId();
  assert.ok(id3 && id3 !== id2, 'auto-restart re-ran preparation with a fresh request id');
  ids.add(id3);
  const readiness3 = readReadiness();
  assert.equal(readiness3?.status, 'ok');
  assert.equal(readiness3?.startupRequestId, id3, 'readiness echoes the auto-restart request id');
  // READY=1 precedes the reset — wait for it (see (i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the auto-restart listen' });

  // (iv) Supervisor-initiated start: operator reset, then a recovery
  // failure fires OnFailure -> the supervisor reserves + starts the chain.
  await quiesce();
  setMarker('runner-fault-fail-once');
  // The first chain's recovery FAILS (fail-once marker), so the start job
  // itself fails with 'dependency' — that failure is what fires OnFailure.
  // Count supervisor starts only from here: a supervisor triggered by
  // an earlier leg and killed by this (iv) quiesce must not count.
  const sinceIv = new Date().toISOString();
  r = sysctl('start', 'nova-api-server.service');
  assert.notEqual(r.status, 0, 'first chain start fails (recovery fails)');
  assert.ok(r.stderr.includes('dependency') || r.stderr.includes('Dependency'), `start failed with dependency: ${r.stderr}`);
  await waitFor(() => readCounter()?.attempts === 1, { timeoutMs: 30000, label: 'supervisor-test attempt 1' });
  const idA1 = readRequestId();
  await waitFor(() => {
    const rec = readReadiness();
    return rec && rec.status === 'failed' ? rec : null;
  }, { timeoutMs: 30000, label: 'recovery fails (fail-once marker)' });
  // OnFailure fires the supervisor exactly once for this failure.
  const retryStarts = await waitFor(() => {
    const n = journalUnits(sinceIv, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
    return n >= 1 ? n : null;
  }, { timeoutMs: 60000, label: 'supervisor triggered by OnFailure' });
  assert.equal(retryStarts, 1, 'exactly one supervisor run for the recovery failure');
  // The supervisor (30 s sleep) reserves and starts the chain: preparation
  // consumes the reservation -> counter 2, fresh request id. The marker was
  // consumed, so this chain's recovery succeeds and the API listens — and
  // the listen RESETS the counter (absent) ~1 s after it becomes 2. So do
  // NOT waitFor the counter to BE 2: a 1 s poll can miss the transient
  // state entirely (that is what the first Rev 4.9 run did — the chain ran
  // and listened at 18:31:06 while the waitFor timed out). Instead wait
  // for the chain's OUTCOME: the API active with a FRESH request id (a
  // second preparation ran) and the counter reset (absent).
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 120000, label: 'supervisor chain API active' });
  const idA2 = readRequestId();
  assert.ok(idA2 && idA2 !== idA1, 'supervisor-initiated chain re-ran preparation with a fresh request id');
  ids.add(idA2);
  const readinessA2 = readReadiness();
  assert.equal(readinessA2?.status, 'ok');
  assert.equal(readinessA2?.startupRequestId, idA2, 'readiness echoes the supervisor-chain request id');
  // READY=1 precedes the reset — wait for it (see (i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the supervisor-chain listen' });
  // Step (8) now correctly sees active (the chain really succeeded) and
  // exits 0 WITHOUT re-arming (step 9). Assert the observable effect:
  // no re-arm timer appears within 20 s, and no second supervisor run.
  await sleep(20000);
  assert.ok(!journalSince(since).includes('nova-startup-rearm-'), 'no re-arm timer: step (8) correctly saw the succeeded chain as active');
  const retryStartsAfter = journalUnits(sinceIv, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
  assert.equal(retryStartsAfter, 1, 'no second supervisor run (no re-arm)');
  stopCollect.v = true;
  const allIds = await collector;
  for (const id of allIds) ids.add(id);
  assert.ok(ids.size >= 4, `at least 4 distinct request ids across the four modes, got ${ids.size}`);
  await quiesce();
});

// =============================================================================
// F-7a (Rev 4.9): hand-start while the API is still activating.
// A second start issued while the first chain is still running must not
// be misclassified. MEASURED 26 Nov 2026: the second start does NOT join
// the in-flight job and does NOT run a second API process — it supersedes
// the first pending start job. Two preparations run (two request ids, two
// attempts counted) and two recoveries run, but only the LATEST chain's
// API process starts and listens (exactly one `startup-recovery-
// succeeded`, carrying the latest id; the first chain is superseded
// cleanly — not reported as a failure, not double-counted as a listen).
// So the test verifies: two starts -> two preparations (two distinct
// request ids), exactly one listen (the latest chain), the API ends up
// active, the readiness echoes the latest id, the counter ends up reset
// (absent), and nothing failed (no supervisor run, no re-arm, no limit
// event). The running window is widened deterministically with the
// runner-fault-slow-short marker (recovery sleeps ~10 s).
// NOTE: while the chain waits on its dependencies (preparation +
// recovery), the API unit reads `inactive` (SubState=dead), NOT
// `activating` — systemd only shows `activating` once the unit's own
// ExecStart begins (after the dependencies complete), and that window is
// ~0.3 s. So the in-flight signal is the start JOB (list-jobs), not
// is-active; the test asserts the unit is NOT `active` before a READY,
// never that it is `activating`.
// =============================================================================
test('(aa) F-7a hand-start while activating: second start is a second chain, counted honestly, final state consistent', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  setMarker('runner-fault-slow-short');
  // First start, non-blocking: returns immediately after queueing the job.
  const r1 = sysctl('start', '--no-block', 'nova-api-server.service');
  assert.equal(r1.status, 0, `--no-block start -> 0: ${r1.stderr}`);
  // While the first chain is still running (the recovery is sleeping
  // ~10 s): the in-flight start job is listed; the unit is NOT `active`;
  // exactly one attempt is counted so far; a request id is written.
  const jobSeen = await waitFor(() => {
    const jobs = sysctl('list-jobs', '--no-legend').stdout;
    return jobs.includes('nova-api-server.service') && jobs.includes('start') ? jobs : null;
  }, { timeoutMs: 10000, label: 'in-flight start job listed' });
  assert.ok(jobSeen.includes('nova-api-server.service'), 'in-flight start job listed');
  assert.notEqual(sysctl('is-active', 'nova-api-server.service').stdout.trim(), 'active', 'unit is not active while the chain runs (not misclassified as active)');
  // The counter is written by preparation, which runs as a dependency
  // AFTER the start job is listed — so wait for it to appear (a plain
  // assert here races preparation and reads it absent).
  await waitFor(() => readCounter()?.attempts === 1 ? true : null, { timeoutMs: 30000, label: 'first chain attempt counted while the chain runs' });
  const id1 = readRequestId();
  assert.ok(id1, 'request id written while the chain runs');
  // Second start, in a CHILD PROCESS while the first is still running:
  // it returns 0 (after a chain reaches READY=1) AND it starts a second
  // chain — a second preparation with a fresh request id, a second
  // attempt counted. A child process (not a blocking spawnSync) lets
  // this test observe the counter WHILE the second chain runs: attempts
  // === 2 must be visible before the final listen resets it. (The old
  // blocking form could only assert the request-id change, because the
  // start could return after the final listen already reset the
  // counter.)
  const child = spawn('systemctl', ['start', 'nova-api-server.service'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d; });
  const childDone = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  // The second preparation runs while the child start is in flight: the
  // counter reaches 2 attempts (visible through the ~10 s recovery
  // sleep, before the final listen resets it).
  await waitFor(() => readCounter()?.attempts === 2 ? true : null, { timeoutMs: 30000, label: 'second chain attempt counted (counter at 2) while the second start runs' });
  // The second chain ran: a fresh request id.
  const id2 = await waitFor(() => {
    const id = readRequestId();
    return id && id !== id1 ? id : null;
  }, { timeoutMs: 30000, label: 'second chain wrote a fresh request id' });
  assert.ok(id2 && id2 !== id1, 'second start ran a second chain (fresh request id)');
  // The child start exits 0 once a chain reaches READY=1.
  const childCode = await childDone;
  assert.equal(childCode, 0, `second (child) start -> exit 0: ${childErr}`);
  // Final state: the API is active (a real READY was reached), the
  // readiness echoes the LATEST chain's request id, and the counter is
  // reset (absent) after the final listen.
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 30000, label: 'API active after the chains complete' });
  const readiness = readReadiness();
  assert.equal(readiness?.status, 'ok');
  assert.equal(readiness?.startupRequestId, id2, 'readiness echoes the latest chain request id');
  // READY=1 precedes the reset — wait for it (see (aa)(i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the final listen' });
  // Exactly ONE API process listened: the second start superseded the
  // first pending start job (measured 26 Nov 2026 — the single
  // `startup-recovery-succeeded` in the API journal carries the LATEST
  // chain's id). The first chain was superseded cleanly, not reported as
  // a failure and not double-counted as a listen: one listen, one reset.
  const apiJournal = await waitFor(() => {
    const j = journalUnits(since, ['nova-api-server.service']);
    return j.includes('startup-recovery-succeeded') ? j : null;
  }, { timeoutMs: 30000, label: 'startup-recovery-succeeded logged' });
  const ids = new Set([...apiJournal.matchAll(/startup-recovery-succeeded requestId=([0-9a-f-]+)/g)].map((m) => m[1]));
  assert.equal(ids.size, 1, `exactly one successful listen (the latest chain), got ${[...ids].join(', ')}`);
  assert.ok(ids.has(id2), 'the single listen is the latest chain');
  assert.ok(!ids.has(id1), 'the superseded first chain never listened');
  // Preparation count (F-7a, ChatGPT Rev 4.9 review): the preparation
  // unit started exactly twice — one per chain. The counter-at-2 wait
  // above proves the second preparation ran while the second start was
  // in flight; this journal count is the durable proof after the fact.
  const prepStarts = journalUnits(since, ['nova-startup-id.service']).split('\n').filter((l) => l.includes('Starting nova-startup-id.service')).length;
  assert.equal(prepStarts, 2, `preparation unit started exactly twice (one per chain), got ${prepStarts}`);
  // Nothing failed: no supervisor run, no re-arm timer, no limit event.
  assert.ok(!journalSince(since).includes('nova-startup-rearm-'), 'no re-arm timer: neither chain failed');
  const retryStarts = journalUnits(since, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
  assert.equal(retryStarts, 0, 'no supervisor run: neither chain failed');
  await quiesce();
});

// =============================================================================
// (ab) Import-time failure: the API cannot even load (dispatch.js renamed)
// =============================================================================
test('(ab) import-time failure: exit 1 at attempts 1-5, no 42 (CLI never runs), no sixth start', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  const bak = `${STAGED_DISPATCH}.test-bak`;
  assert.equal(fs.existsSync(STAGED_DISPATCH), true, 'staged dispatch.js exists before the fault');
  fs.renameSync(STAGED_DISPATCH, bak);
  // The rename is restored in a finally AND by the file-level after hook
  // below (via t.after) so a failure here can never leave the staged tree broken.
  t.after(() => {
    if (fs.existsSync(bak) && !fs.existsSync(STAGED_DISPATCH)) fs.renameSync(bak, STAGED_DISPATCH);
  });
  try {
    // --no-block: under Type=notify a blocking start on a FAILING chain
    // returns non-zero (the start job fails when the API exits 1), which
    // would fail the start assertion before the loop is even observed.
    // The loop is observed by polling (counter + exit statuses), exactly
    // as (u)/(v) do for their long start jobs.
    const r = sysctl('start', '--no-block', 'nova-api-server.service');
    assert.equal(r.status, 0, `start --no-block -> 0: ${r.stderr}`);
    await waitFor(() => readCounter()?.attempts === 5, { timeoutMs: 300000, label: 'counter reaches 5 on import failures' });
    const statuses = await waitFor(() => {
      const s = apiExitStatuses(since);
      return s.length === 5 ? s : null;
    }, { timeoutMs: 120000, label: 'five import-failure exits observed' });
    // Every exit is 1: the CLI entry never runs, so decideStartupFailureExit
    // never runs and no 42 is possible on this path. (The design's "42 at
    // 5" applies to the CLI-run failure path — see the (aa) test — not to
    // an import failure; the limit here is enforced by preparation refusing
    // the sixth chain and by the start limiter.)
    assert.deepEqual(statuses, [1, 1, 1, 1, 1], `import failures exit 1 at every attempt: ${JSON.stringify(statuses)}`);
    assert.equal(readCounter()?.attempts, 5);
    // No restart within 60 s at the limit.
    await sleep(60000);
    assert.equal(readCounter()?.attempts, 5, 'counter stays at 5');
    assert.deepEqual(apiExitStatuses(since), [1, 1, 1, 1, 1], 'no sixth API exit');
    const start6 = sysctl('start', 'nova-api-server.service');
    assert.notEqual(start6.status, 0, 'sixth start refused');
    assert.equal(readCounter()?.attempts, 5, 'counter still 5 after the refused start');
  } finally {
    if (fs.existsSync(bak)) fs.renameSync(bak, STAGED_DISPATCH);
  }
  // The staged tree is whole again (byte-identical to canonical).
  assert.equal(sha256(STAGED_DISPATCH), sha256(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/dispatch.js')));
  await quiesce();
});

// =============================================================================
// (m) OnFailure timing: fail preparation -> dependency failure, exactly one
// supervisor run; re-arm is NOT created on this path
// =============================================================================
test('(m) OnFailure timing: malformed counter -> dependency failure, exactly one supervisor run, no re-arm', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  writeCounter('{bad');
  const r = sysctl('start', 'nova-api-server.service');
  assert.notEqual(r.status, 0, 'start fails when preparation fails');
  const journal = journalUnits(since, ['nova-api-server.service', 'nova-startup-id.service']);
  assert.ok(journal.includes("failed with result 'dependency'") || journal.includes('Dependency failed'), `start job failed with dependency:\n${journal.slice(-1500)}`);
  const prepLog = journalTag(since, 'nova-startup-preparation');
  assert.ok(prepLog.includes('startup-preparation-counter-malformed'), `preparation logged malformed:\n${prepLog.slice(-1000)}`);
  // The supervisor fires exactly once (OnFailure), reads the malformed
  // counter, logs counter-malformed, exits 0 without retrying.
  const retryStarts = await waitFor(() => {
    const n = journalUnits(since, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
    return n >= 1 ? n : null;
  }, { timeoutMs: 90000, label: 'supervisor triggered once' });
  assert.equal(retryStarts, 1, 'exactly one supervisor run for the preparation failure');
  await sleep(45000); // let the supervisor finish (30 s sleep + reserve attempt)
  const retryStarts2 = journalUnits(since, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
  assert.equal(retryStarts2, 1, 'still exactly one supervisor run (no re-arm on this path)');
  const retryLog = journalTag(since, 'nova-startup-retry');
  assert.ok(retryLog.includes('startup-retry-counter-malformed'), `supervisor logged counter-malformed:\n${retryLog.slice(-1000)}`);
  assert.ok(!journalSince(since).includes('nova-startup-rearm-'), 'no re-arm timer on the malformed-counter path');
  assert.equal(readCounterRaw(), '{bad', 'counter bytes unchanged by the supervisor');
  // The API never ran on this path: no recovery success, never active.
  assert.ok(!journalUnits(since, ['nova-api-server.service']).includes('startup-recovery-succeeded'), 'the API never recovered on the malformed-counter path');
  assert.notEqual(sysctl('is-active', 'nova-api-server.service').stdout.trim(), 'active', 'the API never became active on the malformed-counter path');
  await quiesce();
});

// =============================================================================
// (n) Two supervisors concurrently: exactly one token, one chain start
// =============================================================================
test('(n) two supervisors concurrently: exactly one reserves, the other logs slot-reserved', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  // Known counter state: attempts 2, fresh window, no reservation.
  const ws = new Date().toISOString();
  writeCounter({ attempts: 2, windowStart: ws, reservation: null, generation: '11111111-1111-4111-8111-111111111111' });
  const runSupervisor = () => new Promise((resolveRun) => {
    const p = spawn('sh', [RETRY_SH], { stdio: 'ignore' });
    p.on('close', (code) => resolveRun(code));
  });
  const [c1, c2] = await Promise.all([runSupervisor(), runSupervisor()]);
  assert.equal(c1, 0, 'supervisor 1 exits 0');
  assert.equal(c2, 0, 'supervisor 2 exits 0');
  // Exactly one chain start. Rev 4.9: the winner's chain LISTENS (the
  // factory works now), so the counter is RESET (absent) after that one
  // successful listen — the old `attempts === 3` assertion is wrong now
  // (it assumed the chain always failed and the counter survived). The
  // proof of exactly-one is now: the API is active after exactly one
  // listen (exactly one startup-recovery-succeeded in the API journal),
  // the counter is absent (reset), and exactly one slot-reserved log.
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 60000, label: 'winner chain API active' });
  // READY=1 precedes the counter reset and the startup-recovery-succeeded
  // log (the reset spawns the node counter CLI, ~100-150 ms), so a single
  // journal read right after is-active can race the log line — the read
  // wins, finds 0, and the test fails even though the chain listened.
  // (Proven 26 Nov 2026: three full-file/prefix runs failed with 0 while
  // the journal showed the listen + log 149 ms after Started; (n) alone
  // and (m)+(n) passed because the reset won the race there.) Wait for
  // the line to appear before counting — same pattern as the F-7a test.
  const apiJournal = await waitFor(() => {
    const j = journalUnits(since, ['nova-api-server.service']);
    return j.includes('startup-recovery-succeeded') ? j : null;
  }, { timeoutMs: 30000, label: 'startup-recovery-succeeded logged' });
  const succeeded = (apiJournal.match(/startup-recovery-succeeded/g) || []).length;
  assert.equal(succeeded, 1, `exactly one successful listen (one chain), got ${succeeded}`);
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the single listen' });
  const retryLog = journalTag(since, 'nova-startup-retry');
  const slotReserved = (retryLog.match(/startup-retry-slot-reserved/g) || []).length;
  assert.equal(slotReserved, 1, `exactly one slot-reserved log, got ${slotReserved}:\n${retryLog.slice(-1500)}`);
  // The winner's chain ran preparation with a fresh request id.
  assert.ok(readRequestId(), 'winner chain wrote a request id');
  await quiesce();
});

// =============================================================================
// (o) Start-fails-after-consumption race: reserve token B after A is consumed
// =============================================================================
test('(o) start-fails-after-consumption: A consumed by preparation, B reserved, A logs not-owner', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  // The supervisor's reserve needs an EXISTING counter (absent ->
  // counter-unavailable, no reservation): seed attempts 2, fresh window.
  writeCounter({ attempts: 2, windowStart: new Date().toISOString(), reservation: null, generation: '77777777-7777-4777-8777-777777777777' });
  // Slow-short recovery widens the window between "preparation consumed A"
  // and "A's release check" from ~1 s to ~10 s, so the race is deterministic.
  setMarker('runner-fault-slow-short');
  const supDone = new Promise((resolveSup) => {
    const p = spawn('sh', [RETRY_SH], { stdio: 'ignore' });
    p.on('close', (code) => resolveSup(code));
  });
  // Wait for supervisor A to reserve (reservation appears, attempts unchanged).
  const reserved = await waitFor(() => {
    const c = readCounter();
    return c && c.reservation ? c : null;
  }, { timeoutMs: 120000, intervalMs: 100, label: 'supervisor A reserves' });
  const tokenA = reserved.reservation;
  const attemptsBefore = reserved.attempts;
  // Wait for preparation to consume A (reservation null, attempts +1), then
  // immediately reserve token B the way a second supervisor would.
  await waitFor(() => {
    const c = readCounter();
    return c && c.reservation === null && c.attempts === attemptsBefore + 1 ? c : null;
  }, { timeoutMs: 60000, label: 'preparation consumes A' });
  const reserveB = sh('flock', ['--verbose', '--exclusive', '--timeout', '10', `${STATE_DIR}/startup-attempts.lock`, 'node', COUNTER_CLI, 'reserve'], { timeout: 30000 });
  assert.equal(reserveB.status, 0, `reserve B flock -> 0: ${reserveB.stderr}`);
  const tokenB = JSON.parse(/RESULT 0 (.*)/.exec(reserveB.stdout)?.[1] ?? '{}').token;
  assert.ok(tokenB && tokenB !== tokenA, `token B reserved (${tokenB}), distinct from A`);
  // Supervisor A finishes: its release check finds B, logs not-owner, releases nothing.
  const codeA = await supDone;
  assert.equal(codeA, 0, 'supervisor A exits 0');
  const retryLog = journalTag(since, 'nova-startup-retry');
  assert.ok(retryLog.includes('startup-retry-start-failed') && retryLog.includes('not-owner'), `A logged not-owner:\n${retryLog.slice(-1500)}`);
  assert.equal(readCounter()?.reservation, tokenB, 'token B survives (A released nothing)');
  await quiesce();
});

// =============================================================================
// (p) Validation race: stale readiness -> validation failure, next restart ok
// =============================================================================
test('(p) validation race: stale readiness -> verification failure (exit 1, counter not reset), next restart listens', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  setMarker('runner-fault-stale-readiness');
  // The recovery writes the stale readiness (wrong startupRequestId).
  // start() then fails verification: wrong-startup-request-id, exit 1.
  // (Rev 4.9: defect #4 is fixed, so start() runs and the validation
  // failure IS observable through systemd now.)
  const r = sysctl('start', 'nova-api-server.service');
  assert.notEqual(r.status, 0, 'start fails: the API exits 1 on the stale readiness');
  await waitFor(() => {
    const rec = readReadiness();
    return rec && rec.status === 'ok' && rec.startupRequestId === '00000000-0000-4000-8000-000000000000' ? rec : null;
  }, { timeoutMs: 30000, label: 'stale readiness written' });
  const apiJournal = await waitFor(() => {
    const j = journalUnits(since, ['nova-api-server.service']);
    return j.includes('startup-recovery-not-verified') ? j : null;
  }, { timeoutMs: 30000, label: 'verification failure logged' });
  assert.ok(apiJournal.includes('wrong-startup-request-id'), 'verification failed on the wrong request id');
  await waitFor(() => apiExitStatuses(since).length >= 1, { timeoutMs: 30000, label: 'API exit observed' });
  assert.deepEqual(apiExitStatuses(since), [1], 'attempt 1 exits 1 (verification failure, not 42)');
  // The counter is NOT reset by a pre-listen failure — the reset runs only
  // after a successful listen.
  assert.equal(readCounter()?.attempts, 1, 'counter stays at 1 (attempt counted, not reset)');
  // The marker was consumed, so Restart=on-failure's fresh chain writes a
  // GOOD readiness and the API listens: active, counter reset (absent).
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 120000, label: 'API active after the auto-restart' });
  const id2 = readRequestId();
  assert.ok(id2 && id2 !== '00000000-0000-4000-8000-000000000000', 'restart re-ran preparation with a fresh request id');
  const readiness2 = readReadiness();
  assert.equal(readiness2?.status, 'ok');
  assert.equal(readiness2?.startupRequestId, id2, 'readiness echoes the restart request id');
  // READY=1 precedes the reset — wait for it (see (aa)(i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the restart listen' });
  await quiesce();
});

// =============================================================================
test('(q) expired window + reservation: reserve rewrites the window, preparation -> attempts 1', skip, async (t) => {
  await quiesce();
  const oldWs = new Date(Date.now() - 400_000).toISOString(); // 400 s ago (> 300 s window)
  const oldToken = '22222222-2222-4222-8222-222222222222';
  writeCounter({ attempts: 3, windowStart: oldWs, reservation: oldToken, generation: '33333333-3333-4333-8333-333333333333' });
  // The supervisor's reserve step, invoked exactly as retry-startup.sh does it.
  const reserve = sh('flock', ['--verbose', '--exclusive', '--timeout', '10', `${STATE_DIR}/startup-attempts.lock`, 'node', COUNTER_CLI, 'reserve'], { timeout: 30000 });
  assert.equal(reserve.status, 0, `reserve flock -> 0: ${reserve.stderr}`);
  const m = /RESULT 0 (.*)/.exec(reserve.stdout);
  assert.ok(m, `reserve returns RESULT 0: ${reserve.stdout}`);
  const body = JSON.parse(m[1]);
  const token = body.token;
  assert.ok(token && token !== oldToken, 'a fresh reservation token was written');
  const after = readCounter();
  assert.equal(after.attempts, 0, 'expired window: reserve resets attempts to 0');
  assert.equal(after.reservation, token, 'the new reservation is held');
  assert.ok(Date.parse(after.windowStart) > Date.now() - 60_000, 'the window is coherent and new');
  assert.notEqual(after.generation, '33333333-3333-4333-8333-333333333333', 'a new generation was assigned');
  // Preparation consumes the reservation and counts attempt 1.
  const prep = sh('sh', [PREPARE_SH], { timeout: 30000 });
  assert.equal(prep.status, 0, `prepare -> 0: ${prep.stderr}`);
  const counted = readCounter();
  assert.equal(counted.attempts, 1, 'preparation -> attempts 1');
  assert.equal(counted.reservation, null, 'the reservation was consumed');
  assert.equal(counted.windowStart, after.windowStart, 'same (new) window');
  assert.ok(readRequestId(), 'a fresh request id was written');
  await quiesce();
});

// =============================================================================
// (l) Operator reset after the limit (stranded reservation simulated)
// =============================================================================
test('(l) operator reset after limit: delete counter, verify absent, restart -> attempts 1', skip, async (t) => {
  await quiesce();
  // Simulate the stranded state: at the limit with a reservation held.
  const ws = new Date().toISOString();
  const stranded = '44444444-4444-4444-8444-444444444444';
  writeCounter({ attempts: 5, windowStart: ws, reservation: stranded, generation: '55555555-5555-4555-8555-555555555555' });
  // Operator procedure: (1) delete the counter.
  fs.rmSync(COUNTER_PATH, { force: true });
  // (2) Confirm absent (CLI read -> code 6).
  const read = sh('node', [COUNTER_CLI, 'read'], { timeout: 15000 });
  assert.equal(read.status, 0);
  assert.match(read.stdout, /^RESULT 6 /);
  // (3) reset on the absent counter with a VALID identity: the identity is
  // validated first (an invalid one is code 2, never silently accepted),
  // and an absent counter returns code 0 'already-absent' — the operator
  // verifies the counter is gone before restarting.
  const reset = sh('node', [COUNTER_CLI, 'reset', '44444444-4444-4444-8444-444444444444', ws, '5', '55555555-5555-4555-8555-555555555555'], { timeout: 15000 });
  assert.match(reset.stdout, /^RESULT 0 /, `reset on absent counter: ${reset.stdout}`);
  assert.ok(reset.stdout.includes('already-absent'), `reset reports already-absent: ${reset.stdout}`);
  // (4) Verify still absent, then (5) restart -> preparation initialises attempts 1.
  assert.equal(readCounter(), null, 'counter still absent after the failed reset');
  const r = sysctl('start', 'nova-api-server.service');
  assert.equal(r.status, 0, `restart -> 0: ${r.stderr}`);
  await waitFor(() => readCounter()?.attempts === 1, { timeoutMs: 30000, label: 'attempts 1 after operator reset' });
  const c = readCounter();
  assert.equal(c.reservation, null, 'the stranded reservation is gone');
  assert.ok(readRequestId(), 'a fresh request id was written');
  await quiesce();
});

// =============================================================================
// (ac) Re-arm self-reactivation: counter at 2, recovery fails on a
// supervisor-initiated retry, re-arm -> supervisor B, limit respected at 5
// =============================================================================
test('(ac) re-arm self-reactivation: counter at 2, persistent recovery failure, supervisor A -> re-arm -> supervisor B, limit respected at 5', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  // Counter at 2 (as the test specifies).
  writeCounter({ attempts: 2, windowStart: new Date().toISOString(), reservation: null, generation: '66666666-6666-4666-8666-666666666666' });
  // PERSISTENT failure: every recovery fails (not fail-once).
  setMarker('runner-fault-fail');
  // The first chain's recovery FAILS (fail-once marker), so the start job
  // fails with 'dependency' — that failure fires OnFailure.
  const sinceChain = new Date().toISOString();
  const r = sysctl('start', 'nova-api-server.service');
  assert.notEqual(r.status, 0, 'first chain start fails (recovery fails)');
  // Chain attempt 3: preparation (counter 3) -> recovery FAILS -> OnFailure.
  await waitFor(() => readCounter()?.attempts === 3, { timeoutMs: 30000, label: 'attempt 3 counted' });
  await waitFor(() => {
    const rec = readReadiness();
    return rec && rec.status === 'failed' ? rec : null;
  }, { timeoutMs: 30000, label: 'recovery fails on attempt 3' });
  // Supervisor A: 30 s sleep, reserve, start chain (attempt 4, recovery
  // FAILS again — persistent marker). Step (8) sees not-active, step (9)
  // re-reads the counter (attempts 4 < 5, no reservation) and schedules a
  // re-arm timer.
  await waitFor(() => readCounter()?.attempts === 4, { timeoutMs: 120000, label: 'supervisor A chain counted (attempt 4)' });
  await waitFor(() => {
    const rec = readReadiness();
    return rec && rec.status === 'failed' ? rec : null;
  }, { timeoutMs: 30000, label: 'recovery fails on attempt 4' });
  const retryStarts = await waitFor(() => {
    const n = journalUnits(sinceChain, ['nova-startup-retry.service']).split('\n').filter((l) => l.includes('Starting nova-startup-retry.service')).length;
    return n >= 1 ? n : null;
  }, { timeoutMs: 60000, label: 'supervisor A ran' });
  assert.ok(retryStarts >= 1, 'supervisor A ran for the attempt-3 failure');
  // Step (9) scheduled a re-arm timer (transient unit
  // nova-startup-rearm-<token>): the journal records its creation, and it
  // is listable while pending (5 s). Accept either observation.
  const rearmSeen = await waitFor(() => {
    if (journalSince(since).includes('nova-startup-rearm-')) return true;
    const units = sysctl('list-units', '--all', '--no-legend', 'nova-startup-rearm-*');
    return units.stdout.trim().length > 0 ? true : null;
  }, { timeoutMs: 90000, label: 're-arm timer scheduled after attempt 4' });
  assert.ok(rearmSeen, 'step (9) scheduled a re-arm timer after the attempt-4 failure');
  // Supervisor B (re-armed, and/or the OnFailure-fired supervisor for the
  // attempt-4 failure — the reserve is single-token, exactly one chain
  // runs): attempt 5, recovery FAILS again.
  await waitFor(() => readCounter()?.attempts === 5, { timeoutMs: 120000, label: 'supervisor B chain counted (attempt 5)' });
  await waitFor(() => {
    const rec = readReadiness();
    return rec && rec.status === 'failed' ? rec : null;
  }, { timeoutMs: 30000, label: 'recovery fails on attempt 5' });
  // Limit respected: step (9) of the attempt-5 supervisor logs
  // startup-retry-limit-reached and schedules NO re-arm timer. Give the
  // supervisor time to reach step (9) (its chain just failed) and then
  // observe 60 s with no new re-arm and no attempt 6.
  await waitFor(() => journalTag(since, 'nova-startup-retry').includes('startup-retry-limit-reached'), { timeoutMs: 120000, label: 'limit-reached logged after attempt 5' });
  const rearmCountAtLimit = journalSince(since).split('nova-startup-rearm-').length - 1;
  await sleep(60000);
  assert.equal(readCounter()?.attempts, 5, 'counter stays at 5 after the limit');
  assert.equal(readCounter()?.reservation, null, 'no stranded reservation');
  const rearmCountAfter = journalSince(since).split('nova-startup-rearm-').length - 1;
  assert.equal(rearmCountAfter, rearmCountAtLimit, 'no new re-arm timer scheduled after the limit was reached');
  await quiesce();
});

// Small live proof that the supervisor DOES log limit-reached when it runs
// with the counter at the limit (direct unit-level proof, alongside the
// end-to-end (ac) proof above).
test('(m2) supervisor at the limit logs startup-retry-limit-reached', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  writeCounter({ attempts: 5, windowStart: new Date().toISOString(), reservation: null, generation: '99999999-9999-4999-8999-999999999999' });
  const code = await new Promise((resolveRun) => {
    const p = spawn('sh', [RETRY_SH], { stdio: 'ignore' });
    p.on('close', (c) => resolveRun(c));
  });
  assert.equal(code, 0, 'supervisor exits 0 at the limit');
  const log = journalTag(since, 'nova-startup-retry');
  assert.ok(log.includes('startup-retry-limit-reached'), `supervisor logged limit-reached:\n${log.slice(-800)}`);
  assert.equal(readCounter()?.attempts, 5, 'counter stays at 5');
  await quiesce();
});


// =============================================================================
test('(s) listen failure: EADDRINUSE -> startup-listen-failed, exit 1, counter NOT reset; free the port + restart -> active', skip, async (t) => {
  const since = new Date().toISOString();
  await quiesce();
  // Occupy the API port first: a dummy TCP listener on 127.0.0.1:8788.
  const dummy = spawn('node', ['-e', "require('net').createServer().listen(8788,'127.0.0.1',()=>console.log('HELD'))"], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { dummy.kill('SIGKILL'); } catch { /* already dead */ } });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('dummy listener did not bind in 10 s')), 10000);
    dummy.stdout.on('data', (d) => { if (String(d).includes('HELD')) { clearTimeout(to); resolve(); } });
    dummy.on('close', (c) => { clearTimeout(to); reject(new Error(`dummy listener exited early (${c})`)); });
  });
  // The chain runs, but listen() fails EADDRINUSE: startup-listen-failed,
  // exit 1, counter NOT reset (the reset runs only after a successful
  // listen). (Rev 4.9: defect #4 is fixed, so the listen leg IS reachable
  // through systemd now.)
  const r = sysctl('start', 'nova-api-server.service');
  assert.notEqual(r.status, 0, 'start fails: the API exits 1 on the listen failure');
  const apiJournal = await waitFor(() => {
    const j = journalUnits(since, ['nova-api-server.service']);
    return j.includes('startup-listen-failed') ? j : null;
  }, { timeoutMs: 30000, label: 'listen failure logged' });
  assert.ok(apiJournal.includes('EADDRINUSE') || apiJournal.includes('address in use'), `listen failure names the cause:\n${apiJournal.slice(-800)}`);
  await waitFor(() => apiExitStatuses(since).length >= 1, { timeoutMs: 30000, label: 'API exit observed' });
  assert.deepEqual(apiExitStatuses(since), [1], 'attempt 1 exits 1 (listen failure, not 42)');
  const c = readCounter();
  assert.ok(c, 'counter file survives the pre-listen failure (no reset)');
  assert.equal(c.attempts, 1, 'attempt stays counted');
  assert.equal(c.reservation, null, 'no reservation left behind');
  assert.notEqual(sysctl('is-active', 'nova-api-server.service').stdout.trim(), 'active', 'the API never became active with the port occupied');
  // Stop the unit before Restart=on-failure retries (30 s), free the port,
  // then start again: the API listens, the counter resets.
  sysctl('stop', 'nova-api-server.service');
  dummy.kill('SIGKILL');
  await new Promise((resolve) => dummy.on('close', resolve));
  const r2 = sysctl('start', 'nova-api-server.service');
  assert.equal(r2.status, 0, `restart after freeing the port -> 0: ${r2.stderr}`);
  await waitFor(() => sysctl('is-active', 'nova-api-server.service').stdout.trim() === 'active', { timeoutMs: 30000, label: 'API active after the port is freed' });
  // READY=1 precedes the reset — wait for it (see (aa)(i)).
  await waitFor(() => !fs.existsSync(COUNTER_PATH) ? true : null, { timeoutMs: 30000, label: 'counter reset (absent) after the successful listen' });
  await quiesce();
});

// =============================================================================
// (z)/(t) Live call-site spot checks: every journal event line from the
// installed runs parses, and its event is registered
// =============================================================================
test('(z)/(t) live spot checks: journal event lines from the installed runs parse + are registered', skip, async (t) => {
  const { parseEventLine, EVENT_REGISTRY } = await import('../src/api-server/alert-dispatcher.js');
  const since = new Date(Date.now() - 3600_000).toISOString();
  const journal = journalSince(since);
  const DIAGNOSTICS_21 = new Set([
    'alert-delivery-failed', 'alert-pending-cleanup-deferred', 'alert-pending-expired',
    'alert-pending-invalid-entry', 'alert-pending-requeue-duplicate', 'alert-state-corrupt',
    'alert-state-lock-release-failed', 'alert-state-quarantine-failed', 'alert-undedupeable-event',
    'alert-pending-retained', 'alert-pending-unwritable', 'alert-dispatch-failed',
    'alert-checkpoint-unreadable', 'alert-checkpoint-unwritable',
    'health-check-malformed-event-line', 'health-check-journal-failed', 'health-check-systemctl-failed',
    'health-check-unit-anomaly', 'health-check-probe-failed',
    'health-check-skipped-overlap', 'health-check-wrapper-failed',
  ]);
  const lines = journal.split('\n').filter((l) => l.includes(' event=startup-') || l.includes(' event=alert-') || l.includes(' event=health-check-'));
  assert.ok(lines.length > 0, 'installed runs produced canonical event lines');
  const seen = new Set();
  for (const line of lines) {
    // Journal lines carry a syslog prefix ("Nov 26 13:56:24 host tag: ");
    // the canonical line starts at 'ts='.
    const i = line.indexOf('ts=');
    assert.ok(i >= 0, `line contains a canonical ts=: ${line}`);
    const canonical = line.slice(i);
    const event = / event=([a-z][a-z0-9-]*)/.exec(canonical)?.[1];
    assert.ok(event, `line names an event: ${canonical}`);
    if (EVENT_REGISTRY.includes(event)) {
      const r = parseEventLine(canonical);
      assert.equal(r.ok, true, `registered line parses: ${canonical} -> ${JSON.stringify(r)}`);
      seen.add(event);
    } else {
      // Deliberately unregistered diagnostics: the parser MUST reject them
      // (unregistered-event) — they are journal-only by design, never emailed.
      assert.ok(DIAGNOSTICS_21.has(event), `unregistered line is an enumerated diagnostic: ${event}`);
      const r = parseEventLine(canonical);
      assert.equal(r.reason, 'unregistered-event', `diagnostic line rejected by the parser: ${canonical}`);
      seen.add(event);
    }
  }
  // The key installed-run events were observed live. (startup-factory-failed
  // is NOT in this list: the factory works now, so no installed run fails
  // there — it is covered by the fast (t) tests, which fail the factory
  // in-process. An import failure (the (ab) test) is a different path: the
  // CLI entry never runs, so no factory event is logged for it either.)
  for (const name of ['startup-preparation-limit-reached', 'startup-retry-limit-reached', 'startup-retry-slot-reserved', 'startup-recovery-failed']) {
    assert.ok(seen.has(name), `observed live: ${name} (seen: ${[...seen].sort().join(', ')})`);
  }
});
