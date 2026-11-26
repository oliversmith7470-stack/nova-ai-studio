// ============================================================================
// TEST-STUB storage runner — FOR THE §15 INSTALLED-UNIT TESTS ONLY.
// NOT the delivered storage runner (gpu-cloud/src/storage-runner.js was never
// delivered). Installed at /opt/nova-ai-studio/src/storage-runner.js SOLELY
// so the nova-storage-recovery.service ExecStart target exists for the
// installed tests. It performs NO storage work: it reads the request id +
// boot id, writes the §14 readiness record (readiness.json) and the runner
// heartbeat (runner-health.json), and exits 0. Fault modes are driven by
// marker files in /var/lib/nova-api (created by the installed tests):
//   runner-fault-fail          -> write status:"failed" + log
//                                startup-recovery-failed, exit 1
//   runner-fault-fail-once     -> fail once (marker consumed), then succeed
//   runner-fault-slow          -> sleep ~590 s, then succeed (test (u))
//   runner-fault-slow-timeout  -> sleep 610 s (exceeds the unit TimeoutSec
//                                600 -> systemd kills it; test (v))
//   runner-fault-slow-once     -> slow once (marker consumed), then succeed
//   runner-fault-slow-short    -> sleep 10 s, then succeed (test (o) race
//                                window widening; marker NOT consumed so a
//                                re-run stays slow — tests that use it stop
//                                the chain explicitly)
//   runner-fault-stale-readiness -> write readiness.json with a WRONG
//                                startupRequestId (test (p) validation race;
//                                marker consumed, one bad pass only)
// Marker files are consumed (deleted) by the fail-once / slow-once /
// stale-readiness modes so a systemd restart of the chain does not
// re-trigger the fault.
// ============================================================================
import fs from 'node:fs';

const STATE_DIR = '/var/lib/nova-api';
const REQUEST_ID_PATH = `${STATE_DIR}/startup-request-id`;
const COUNTER_PATH = `${STATE_DIR}/startup-attempts`;
const READINESS_PATH = `${STATE_DIR}/readiness.json`;
const HEALTH_PATH = `${STATE_DIR}/runner-health.json`;

function logLine(event, detail, level = 'error') {
  const line = `ts=${new Date().toISOString()} level=${level} event=${event} requestId=${readRequestId()} windowStart=${readWindowStart()} detail=${detail}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function readRequestId() {
  try { return fs.readFileSync(REQUEST_ID_PATH, 'utf8').trim() || 'none'; }
  catch { return 'none'; }
}

function readWindowStart() {
  try {
    const v = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
    return typeof v.windowStart === 'string' ? v.windowStart : 'none';
  } catch { return 'none'; }
}

function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return 'unknown'; }
}

function writeJson(path, value) {
  const tmp = `${path}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, path);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const startedAt = new Date().toISOString();
const requestId = readRequestId();
const bootId = readBootId();
const marker = (name) => `${STATE_DIR}/${name}`;
const has = (name) => fs.existsSync(marker(name));
const consume = (name) => { try { fs.unlinkSync(marker(name)); } catch { /* already gone */ } };

let status = 'ok';
let error = null;
let staleReadiness = false;

if (has('runner-fault-fail-once')) {
  consume('runner-fault-fail-once');
  status = 'failed';
  error = 'test-stub fail-once fault';
} else if (has('runner-fault-fail')) {
  status = 'failed';
  error = 'test-stub fail fault';
} else if (has('runner-fault-slow-short')) {
  await sleep(10_000);
} else if (has('runner-fault-stale-readiness')) {
  consume('runner-fault-stale-readiness');
  staleReadiness = true;
} else if (has('runner-fault-slow-once')) {
  consume('runner-fault-slow-once');
  await sleep(590_000);
} else if (has('runner-fault-slow')) {
  await sleep(590_000);
} else if (has('runner-fault-slow-timeout')) {
  await sleep(610_000);
}

const completedAt = new Date().toISOString();
const record = {
  cycleId: requestId === 'none' ? 'unknown' : requestId,
  startupRequestId: staleReadiness ? '00000000-0000-4000-8000-000000000000' : requestId,
  bootId,
  startedAt,
  completedAt,
  status,
  objectsDeleted: 0,
  objectsExpiredButMissing: 0,
  indexRebuilt: status === 'ok',
  ...(error ? { error } : {}),
};
writeJson(READINESS_PATH, record);
writeJson(HEALTH_PATH, { status, checkedAt: completedAt, requestId });

if (status === 'failed') {
  logLine('startup-recovery-failed', `test-stub-${error.replace(/\s+/g, '-')}`);
  process.exit(1);
}
logLine('startup-recovery-succeeded', 'none', 'info');
process.exit(0);
