// phase5-alert.test.mjs — §15 tests (k), (y), (t) for the alert dispatcher + probe.
// Mocks: ONLY the dispatcher's email transport (stub transport). No mocked
// systemctl/journalctl for behaviour assertions EXCEPT the probe scan-boundary
// case, which uses fake journalctl/systemctl binaries earlier in PATH to
// capture the probe's --since/--until arguments (the probe's own behaviour
// under test, not a mock of the units it inspects).
// State files: /var/lib/nova-api/alert-dedup.json, alert-pending.json,
// health-check-state.json — saved/restored per test at file level. These
// tests never touch the counter file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DISPATCHER = path.join(REPO_ROOT, 'gpu-cloud/src/api-server/alert-dispatcher.js');
const PROBE = path.join(REPO_ROOT, 'gpu-cloud/src/api-server/health-check.js');
const ALERT_CHILD = path.join(import.meta.dirname, 'phase5-alert-child.mjs');
const DEDUP_PATH = '/var/lib/nova-api/alert-dedup.json';
const PENDING_PATH = '/var/lib/nova-api/alert-pending.json';
const CHECKPOINT_PATH = '/var/lib/nova-api/health-check-state.json';
const STATE_DIR = '/var/lib/nova-api';

const REQ_A = '33333333-3333-4333-8333-333333333333';
const REQ_B = '44444444-4444-4444-8444-444444444444';
const WS_A = '2026-11-26T05:58:00Z';
const WS_B = '2026-11-26T06:58:00Z';
const TS_A = '2026-11-26T05:58:10Z';

const {
  ALERT_EVENTS, JOURNAL_ONLY_EVENTS, EVENT_REGISTRY, DEDUP_PATH: DEDUP_CONST,
  PENDING_PATH: PENDING_CONST, PENDING_MAX_AGE_MS, ALERT_RECIPIENT, dedupKey,
  pendingKey, parseEventLine, writeStateFileAtomic, withStateFileLock,
  updateDedupState, updatePendingState, validateDedupState, validatePendingState,
  validateCheckpointState, loadStateFile, loadDedupState, loadPendingState,
  requeuePending, isSamePendingEntry, retryPending, resolveSendmailPath,
  sendmailTransport, dispatchAlert,
} = await import(DISPATCHER);

// --- state helpers -----------------------------------------------------------
function readBytes(p) { try { return fs.readFileSync(p); } catch { return null; } }
function readJson(p) { const b = readBytes(p); return b ? JSON.parse(b.toString('utf8')) : null; }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

// Snapshot the three state files + remove any stray quarantine/recovery/temp
// artefacts for them created during the test.
function saveAlertState(t) {
  const saved = new Map([[DEDUP_PATH, readBytes(DEDUP_PATH)], [PENDING_PATH, readBytes(PENDING_PATH)], [CHECKPOINT_PATH, readBytes(CHECKPOINT_PATH)]]);
  t.after(() => {
    for (const [p, bytes] of saved) {
      if (bytes === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, bytes);
    }
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (/^(alert-dedup|alert-pending|health-check-state)\.json\.(corrupt|recovered)-/.test(f)
        || /^(alert-dedup|alert-pending|health-check-state)\.json\.tmp\./.test(f)) {
        fs.rmSync(path.join(STATE_DIR, f), { force: true });
      }
    }
    for (const f of ['alert-dedup.json.lock', 'alert-pending.json.lock', 'health-check-state.json.lock']) fs.rmSync(path.join(STATE_DIR, f), { force: true });
  });
  return saved;
}

function clearAlertState() {
  for (const p of [DEDUP_PATH, PENDING_PATH]) fs.rmSync(p, { force: true });
}

function canonicalLine(event, { requestId = REQ_A, windowStart = WS_A, ts = TS_A, detail = 'none', level = 'error', prefix = '' } = {}) {
  return `${prefix}ts=${ts} level=${level} event=${event} requestId=${requestId} windowStart=${windowStart} detail=${detail}`;
}

function parsedOf(event, overrides = {}) {
  const r = parseEventLine(canonicalLine(event, overrides));
  assert.equal(r.ok, true, `line must parse: ${JSON.stringify(r)}`);
  return r.parsed;
}

// Recording stub transport: {ok:true} and every invocation captured.
function stubTransport() {
  const sent = [];
  const transport = async ({ to, subject, body }) => {
    sent.push({ to, subject, body });
    return { ok: true };
  };
  transport.sent = sent;
  return transport;
}

function captureConsole(t) {
  const out = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { out.push(a.join(' ')); };
  console.log = (...a) => { out.push(a.join(' ')); };
  t.after(() => { console.error = origErr; console.log = origLog; });
  return out;
}

// =============================================================================
// (k) Delivery evidence — all twenty-two emailed names, four artefacts each
// =============================================================================
test('(k) all twenty-two emailed events: canonical line + dedup entry + stub invocation + received email', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const stub = stubTransport();
  const artefacts = [];
  for (const name of ALERT_EVENTS) {
    assert.equal(ALERT_EVENTS.length, 22, 'registry has exactly twenty-two emailed names');
    const line = canonicalLine(name, { detail: `detail-for-${name}` });
    const r = parseEventLine(line);
    assert.equal(r.ok, true, `${name}: canonical line parses`);
    assert.equal(r.parsed.event, name);
    // Artefact 1: the canonical journal line (exact key=value format, all six fields present).
    assert.match(line, new RegExp(`^ts=\\S+ level=\\S+ event=${name} requestId=${REQ_A} windowStart=${WS_A} detail=detail-for-${name}$`));
    const before = stub.sent.length;
    const result = await dispatchAlert(r.parsed, stub);
    assert.deepEqual(result, { sent: true, reason: 'sent', pending: false }, `${name}: dispatch result`);
    // Artefact 3: the stub transport invocation (exit 0 analogue — {ok:true}).
    assert.equal(stub.sent.length, before + 1, `${name}: exactly one transport invocation`);
    // Artefact 4: the received email via the stub.
    const mail = stub.sent[stub.sent.length - 1];
    assert.equal(mail.to, ALERT_RECIPIENT, `${name}: recipient`);
    assert.ok(mail.subject.includes(name), `${name}: subject carries the event token`);
    assert.ok(mail.subject.includes(WS_A), `${name}: subject carries the scope`);
    assert.ok(mail.body.includes(`detail-for-${name}`), `${name}: body carries the detail`);
    // Artefact 2: the dedup entry.
    const dedup = readJson(DEDUP_PATH) ?? {};
    const key = dedupKey(name, { windowStart: WS_A, requestId: REQ_A });
    assert.ok(dedup[key], `${name}: dedup entry present for ${key}`);
    assert.equal(dedup[key].requestId, REQ_A);
    assert.match(dedup[key].sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    artefacts.push(name);
    // Re-dispatch: duplicate, no second email.
    const dup = await dispatchAlert(r.parsed, stub);
    assert.deepEqual(dup, { sent: false, reason: 'duplicate', pending: false }, `${name}: second dispatch is a duplicate`);
    assert.equal(stub.sent.length, before + 1, `${name}: duplicate sends no second email`);
  }
  assert.equal(artefacts.length, 22);
  // No pending entries were created by successful deliveries.
  assert.equal(readJson(PENDING_PATH), null);
});

test('(k) journal-only names: parse, no email, no dedup, no pending', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const stub = stubTransport();
  const out = captureConsole(t);
  for (const name of JOURNAL_ONLY_EVENTS) {
    assert.equal(JOURNAL_ONLY_EVENTS.length, 2);
    const parsed = parsedOf(name);
    const result = await dispatchAlert(parsed, stub);
    assert.deepEqual(result, { sent: false, reason: 'journal-only', pending: false }, `${name}: journal-only result`);
    assert.equal(stub.sent.length, 0, `${name}: transport never invoked`);
    assert.equal(readJson(DEDUP_PATH), null, `${name}: no dedup entry`);
    assert.equal(readJson(PENDING_PATH), null, `${name}: no pending entry`);
  }
  void out;
});

// =============================================================================
// (y) Parser matrix
// =============================================================================
test('(y) parser matrix: malformed / duplicate-key / missing-field / embedded event= / unregistered / prefix / __proto__ / tab', (t) => {
  saveAlertState(t);
  const base = (over = {}) => canonicalLine('startup-listen-failed', over);
  const cases = [
    // [line, ok, reason, event]
    [base(), true, undefined, 'startup-listen-failed'],
    ['[api-server] ' + base(), true, undefined, 'startup-listen-failed'], // exact prefix tolerated, same parse
    ['[other] ' + base(), false, 'not-an-event-line', undefined], // any other prefix rejected
    ['something else entirely', false, 'not-an-event-line', undefined],
    [base().replace('event=startup-listen-failed', 'event=startup-nope'), false, 'unregistered-event', 'startup-nope'],
    [base().replace(' detail=none', ''), false, 'malformed', 'startup-listen-failed'], // missing detail
    [base().replace(' requestId=33333333-3333-4333-8333-333333333333', ''), false, 'malformed', 'startup-listen-failed'], // missing requestId
    [base().replace(' windowStart=2026-11-26T05:58:00Z', ''), false, 'malformed', 'startup-listen-failed'], // missing windowStart
    [base().replace('ts=2026-11-26T05:58:10Z ', ''), false, 'not-an-event-line', undefined], // missing ts: the line no longer starts with ts=, so it is not a canonical line at all
    [base().replace(' level=error', ''), false, 'malformed', 'startup-listen-failed'], // missing level
    [base() + ' event=startup-listen-failed', false, 'malformed', null], // duplicate key -> event null (token-level)
    [base().replace('detail=none', 'detail=none event=startup-listen-failed'), false, 'malformed', null], // duplicate key via detail
    [base().replace('detail=none', 'detail=x-event=startup-listen-failed'), true, undefined, 'startup-listen-failed'], // event= inside a VALUE is not a field
    [base().replace('detail=none', 'detail='), true, undefined, 'startup-listen-failed'], // empty detail permitted
    [base().replace('requestId=33333333-3333-4333-8333-333333333333', 'requestId='), false, 'malformed', 'startup-listen-failed'], // empty requestId
    [base().replace('requestId=33333333-3333-4333-8333-333333333333', 'requestId=not-a-uuid'), false, 'malformed', 'startup-listen-failed'],
    [base().replace('requestId=33333333-3333-4333-8333-333333333333', 'requestId=33333333-3333-3333-8333-333333333333'), false, 'malformed', 'startup-listen-failed'], // non-v4 UUID rejected
    [base().replace('windowStart=2026-11-26T05:58:00Z', 'windowStart=2026-02-30T05:58:00Z'), false, 'malformed', 'startup-listen-failed'], // invalid calendar date
    [base().replace('ts=2026-11-26T05:58:10Z', 'ts=2026-11-26T25:58:10Z'), false, 'malformed', 'startup-listen-failed'],
    [base().replace('level=error', 'level=critical'), false, 'malformed', 'startup-listen-failed'],
    [base().replace(' ', '\t'), false, 'malformed', null], // tab anywhere -> control-whitespace, event null
    [base() + ' __proto__=polluted', true, undefined, 'startup-listen-failed'], // __proto__ field ignored, no pollution
    [base() + ' extra-field=anything', true, undefined, 'startup-listen-failed'], // extensible schema: unknown fields ignored
    [base().replace('event=startup-listen-failed', ''), false, 'malformed', null], // missing event -> event null
    [base().replace('event=startup-listen-failed', 'event=startup-listen-failed event=startup-sweep-failed'), false, 'malformed', null],
    ['ts=2026-11-26T05:58:10Z level=error event=startup-listen-failed requestId=none windowStart=none detail=none', true, undefined, 'startup-listen-failed'], // none sentinels parse
    [base().replace(' detail=none', ' detail'), false, 'malformed', null], // token without '='
    [base().replace('detail=none', 'detail=a=b=c'), true, undefined, 'startup-listen-failed'], // values may contain '='
  ];
  for (const [line, ok, reason, event] of cases) {
    const r = parseEventLine(line);
    assert.equal(r.ok, ok, `line: ${line} -> ${JSON.stringify(r)}`);
    if (!ok) {
      assert.equal(r.reason, reason, `line: ${line}`);
      if (event === undefined) assert.equal(r.event, undefined, `line: ${line}`);
      else assert.equal(r.event, event, `line: ${line}`);
    } else {
      assert.equal(r.parsed.event, event, `line: ${line}`);
    }
  }
  assert.equal({}.polluted, undefined, '__proto__ field must not pollute Object.prototype');
  // Sentinel normalisation: none -> null; dedup key falls back to the other identifier.
  const p = parseEventLine('ts=2026-11-26T05:58:10Z level=error event=startup-listen-failed requestId=none windowStart=2026-11-26T05:58:00Z detail=none').parsed;
  assert.equal(p.requestId, null);
  assert.equal(p.windowStart, WS_A);
  assert.equal(dedupKey(p.event, p), `startup-listen-failed:${WS_A}`);
  const p2 = parseEventLine('ts=2026-11-26T05:58:10Z level=error event=startup-listen-failed requestId=33333333-3333-4333-8333-333333333333 windowStart=none detail=none').parsed;
  assert.equal(p2.windowStart, null);
  assert.equal(dedupKey(p2.event, p2), `startup-listen-failed:${REQ_A}`);
  // Required fields PRESENT but none: the line is valid; the fields are not required non-null.
  const p3 = parseEventLine('ts=2026-11-26T05:58:10Z level=error event=startup-listen-failed requestId=none windowStart=none detail=none').parsed;
  assert.equal(p3.requestId, null);
  assert.equal(p3.windowStart, null);
  assert.throws(() => dedupKey(p3.event, p3), /no dedup scope/);
});

test('(y) undedupeable events: delivered every time, never deduped, logged', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const stub = stubTransport();
  const out = captureConsole(t);
  const parsed = parsedOf('startup-listen-failed', { requestId: 'none', windowStart: 'none' });
  const r1 = await dispatchAlert(parsed, stub);
  assert.deepEqual(r1, { sent: true, reason: 'sent-undedupeable', pending: false });
  const r2 = await dispatchAlert(parsed, stub);
  assert.deepEqual(r2, { sent: true, reason: 'sent-undedupeable', pending: false }, 'undedupeable: second delivery is NOT a duplicate');
  assert.equal(stub.sent.length, 2);
  assert.equal(readJson(DEDUP_PATH), null, 'undedupeable: no dedup entry ever written');
  assert.ok(out.some((l) => l.includes('alert-undedupeable-event')), 'undedupeable event logged');
});

test('(y) dedup + re-arm: fail-then-succeed via retryPending', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const failStub = async () => ({ ok: false, reason: 'relay-down' });
  const parsed = parsedOf('startup-sweep-failed');
  const r1 = await dispatchAlert(parsed, failStub);
  assert.deepEqual(r1, { sent: false, reason: 'relay-down', pending: true });
  assert.equal(readJson(DEDUP_PATH), null, 'failed delivery writes no dedup entry');
  // The probe writes pending BEFORE dispatch; simulate that write, then retry.
  const key = pendingKey(parsed);
  const okPending = updatePendingState((s) => {
    s[key] = { event: parsed.event, windowStart: parsed.windowStart, requestId: parsed.requestId, ts: parsed.ts, detail: parsed.detail, firstSeen: new Date().toISOString(), attempts: 0, lastAttempt: null };
  });
  assert.equal(okPending.ok, true);
  const good = stubTransport();
  const retried = await retryPending(good);
  assert.equal(retried.retried, 1);
  assert.equal(retried.delivered, 1);
  assert.equal(retried.stillPending, 0);
  assert.equal(good.sent.length, 1);
  assert.deepEqual(readJson(PENDING_PATH), {}, 'pending entry removed after delivery');
  const dedup = readJson(DEDUP_PATH);
  assert.ok(dedup[key], 'dedup entry written by the retry');
});

test('(y) concurrent dispatch: same key serialised (one send), different keys both sent', async (t) => {
  saveAlertState(t);
  clearAlertState();
  // Same key: the per-key chain serialises the check-send-write sequence, so
  // the second call never enters the transport while the first is in flight —
  // it waits, then sees the dedup entry and returns 'duplicate'. A deferred
  // transport proves the serialisation: the transport is invoked exactly once.
  let inFlight = 0;
  const deferred = async () => {
    inFlight++;
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  };
  const parsed = parsedOf('startup-replay-failed');
  const [a, b] = await Promise.all([dispatchAlert(parsed, deferred), dispatchAlert(parsed, deferred)]);
  assert.equal(inFlight, 1, 'same key: transport invoked exactly once (chain serialised the second call)');
  const sent = [a, b].filter((r) => r.sent);
  const dups = [a, b].filter((r) => r.reason === 'duplicate');
  assert.equal(sent.length, 1, 'same key: exactly one send');
  assert.equal(dups.length, 1, 'same key: the other is a duplicate');
  const dedup = readJson(DEDUP_PATH);
  assert.equal(Object.keys(dedup).length, 1, 'same key: exactly one dedup entry');
  // Different keys concurrently: both sent, both entries present, neither lost.
  const p1 = parsedOf('startup-reconcile-failed', { requestId: REQ_A, windowStart: WS_A });
  const p2 = parsedOf('startup-listen-failed', { requestId: REQ_B, windowStart: WS_B });
  const stub = stubTransport();
  const [r1, r2] = await Promise.all([dispatchAlert(p1, stub), dispatchAlert(p2, stub)]);
  assert.equal(r1.sent, true);
  assert.equal(r2.sent, true);
  const dedup2 = readJson(DEDUP_PATH);
  assert.ok(dedup2[dedupKey(p1.event, p1)]);
  assert.ok(dedup2[dedupKey(p2.event, p2)]);
  assert.equal(Object.keys(dedup2).length, 3, 'no entry lost to a concurrent write');
});

test('(y) concurrent dispatch across two processes: one dedup entry, at-least-once sends', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const recordFile = path.join(os.tmpdir(), `phase5-alert-record-${process.pid}.log`);
  fs.rmSync(recordFile, { force: true });
  t.after(() => fs.rmSync(recordFile, { force: true }));
  const spawnChild = () => new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [ALERT_CHILD, 'startup-listen-failed', WS_A, REQ_A, recordFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', rejectChild);
    child.on('close', (code) => resolveChild({ code, out, err }));
  });
  const [c1, c2] = await Promise.all([spawnChild(), spawnChild()]);
  assert.equal(c1.code, 0, c1.err);
  assert.equal(c2.code, 0, c2.err);
  const dedup = readJson(DEDUP_PATH);
  const keys = Object.keys(dedup ?? {});
  assert.equal(keys.length, 1, `exactly one dedup entry, got ${JSON.stringify(dedup)}`);
  assert.equal(keys[0], `startup-listen-failed:${WS_A}`);
  const lines = fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `at-least-once: 1-2 sends recorded, got ${lines.length}`);
});

// =============================================================================
// (y) State-file corruption, schemas, loader classification, requeue
// =============================================================================
test('(y) dedup corruption: locked load quarantines, unlocked load leaves the file', (t) => {
  saveAlertState(t);
  clearAlertState();
  const out = captureConsole(t);
  fs.writeFileSync(DEDUP_PATH, '{not json');
  // Unlocked read: fallback, file LEFT IN PLACE.
  assert.deepEqual(loadDedupState({ quarantine: false }), {});
  assert.equal(fs.readFileSync(DEDUP_PATH, 'utf8'), '{not json', 'unlocked load never renames');
  assert.ok(out.some((l) => l.includes('alert-state-corrupt') && l.includes('corrupt-left-in-place')));
  // Locked load (via updateDedupState): quarantined to .corrupt-<ts>, fallback used, mutation applied.
  const before = out.length;
  const res = updateDedupState((s) => { s['startup-listen-failed:2026-11-26T05:58:00Z'] = { sentAt: '2026-11-26T05:58:10Z', requestId: REQ_A }; });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(DEDUP_PATH));
  const quarantined = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-dedup.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'exactly one quarantine file');
  assert.equal(fs.readFileSync(path.join(STATE_DIR, quarantined[0]), 'utf8'), '{not json', 'quarantine preserves the corrupt bytes');
  assert.ok(out.slice(before).some((l) => l.includes('alert-state-corrupt') && l.includes('quarantined-to-')));
  assert.deepEqual(Object.keys(readJson(DEDUP_PATH)), ['startup-listen-failed:2026-11-26T05:58:00Z']);
});

test('(y) invalid-but-valid-JSON schemas are quarantined; unbounded attempts is valid', (t) => {
  saveAlertState(t);
  clearAlertState();
  // Dedup entry with an extra field -> quarantined.
  writeJson(DEDUP_PATH, { 'startup-listen-failed:2026-11-26T05:58:00Z': { sentAt: TS_A, requestId: REQ_A, extra: 1 } });
  assert.equal(validateDedupState(readJson(DEDUP_PATH)), false);
  assert.deepEqual(updateDedupState((s) => { s['x:y'] = { sentAt: TS_A, requestId: null }; }).value, { 'x:y': { sentAt: TS_A, requestId: null } });
  assert.equal(fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-dedup.json.corrupt-')).length, 1);
  // Pending entry with attempts -1 -> quarantined; attempts 999999 -> valid.
  const badPending = { 'k': { event: 'startup-listen-failed', windowStart: WS_A, requestId: REQ_A, ts: TS_A, detail: 'none', firstSeen: TS_A, attempts: -1, lastAttempt: null } };
  assert.equal(validatePendingState(badPending), false);
  writeJson(PENDING_PATH, badPending);
  assert.deepEqual(loadPendingState({ quarantine: false }), {});
  const goodPending = { 'k': { event: 'startup-listen-failed', windowStart: WS_A, requestId: REQ_A, ts: TS_A, detail: 'none', firstSeen: TS_A, attempts: 999999, lastAttempt: null } };
  assert.equal(validatePendingState(goodPending), true, 'attempts is unbounded by design');
  writeJson(PENDING_PATH, goodPending);
  assert.deepEqual(loadPendingState({ quarantine: false }), goodPending);
  // Dedup entry with a non-UUID requestId -> quarantined; entry missing a key -> quarantined.
  assert.equal(validateDedupState({ k: { sentAt: TS_A, requestId: 'nope' } }), false);
  assert.equal(validateDedupState({ k: { sentAt: TS_A } }), false);
  assert.equal(validateDedupState({ k: { sentAt: '2026-02-30T00:00:00Z', requestId: null } }), false);
  assert.equal(validateDedupState({}), true);
  assert.equal(validateDedupState([]), false);
  // Checkpoint: exactly { lastScan }; extra field / bad date -> invalid.
  assert.equal(validateCheckpointState({ lastScan: TS_A }), true);
  assert.equal(validateCheckpointState({ lastScan: null }), true);
  assert.equal(validateCheckpointState({ lastScan: TS_A, extra: 1 }), false);
  assert.equal(validateCheckpointState({ lastScan: 'nope' }), false);
  assert.equal(validateCheckpointState({}), false);
});

test('(y) loader classification: missing -> fallback; other read error -> throw; parse failure -> quarantine', (t) => {
  saveAlertState(t);
  clearAlertState();
  assert.deepEqual(loadStateFile(DEDUP_PATH, {}, validateDedupState), {}, 'missing file -> fallback, no throw');
  // Read error (not ENOENT): the path is a directory -> EISDIR -> THROW, never the fallback.
  fs.mkdirSync(DEDUP_PATH);
  try {
    assert.throws(() => loadDedupState(), (e) => e.code === 'EISDIR');
  } finally { fs.rmdirSync(DEDUP_PATH); }
  // Parse failure with quarantine enabled -> quarantine + fallback.
  fs.writeFileSync(DEDUP_PATH, '[1,2');
  const out = captureConsole(t);
  assert.deepEqual(loadDedupState(), {});
  assert.equal(fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-dedup.json.corrupt-')).length, 1);
  assert.ok(out.some((l) => l.includes('alert-state-corrupt')));
});

test('(y) requeue: valid + invalid + duplicate merged; file renamed, never deleted', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-requeue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const liveKey = 'startup-listen-failed:2026-11-26T05:58:00Z';
  const liveEntry = { event: 'startup-listen-failed', windowStart: WS_A, requestId: REQ_A, ts: TS_A, detail: 'live', firstSeen: TS_A, attempts: 0, lastAttempt: null };
  writeJson(PENDING_PATH, { [liveKey]: liveEntry });
  const quarantinePath = path.join(dir, 'alert-pending.json.corrupt-2026-11-26T00-00-00-000Z');
  const validEntry = { event: 'startup-sweep-failed', windowStart: WS_B, requestId: REQ_B, ts: TS_A, detail: 'valid', firstSeen: TS_A, attempts: 2, lastAttempt: null };
  const invalidEntry = { event: 'startup-sweep-failed', windowStart: WS_B, requestId: REQ_B, ts: TS_A, detail: 'bad', firstSeen: TS_A, attempts: -1, lastAttempt: null };
  writeJson(quarantinePath, {
    [liveKey]: { ...liveEntry, detail: 'quarantined-duplicate' },
    'startup-sweep-failed:2026-11-26T06:58:00Z': validEntry,
    'bad-key': invalidEntry,
  });
  const out = captureConsole(t);
  const res = requeuePending(quarantinePath);
  assert.equal(res.requeued, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.duplicates, 1);
  assert.ok(res.recovered && res.recovered.startsWith(`${quarantinePath}.recovered-`), `recovered path: ${res.recovered}`);
  assert.equal(fs.existsSync(quarantinePath), false, 'quarantine file renamed, not deleted');
  assert.equal(fs.existsSync(res.recovered), true, 'recovered file exists');
  const pending = readJson(PENDING_PATH);
  assert.deepEqual(pending[liveKey], liveEntry, 'live entry wins over the quarantined duplicate');
  assert.deepEqual(pending['startup-sweep-failed:2026-11-26T06:58:00Z'], validEntry);
  assert.equal(pending['bad-key'], undefined);
  assert.ok(out.some((l) => l.includes('alert-pending-invalid-entry')));
  assert.ok(out.some((l) => l.includes('alert-pending-requeue-duplicate')));
  // Non-JSON -> throws, NOTHING changed.
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{nope');
  const beforePending = readJson(PENDING_PATH);
  assert.throws(() => requeuePending(badPath), /not valid JSON/);
  assert.deepEqual(readJson(PENDING_PATH), beforePending);
  assert.equal(fs.existsSync(badPath), true);
  // Non-object JSON -> throws, nothing changed.
  const arrPath = path.join(dir, 'arr.json');
  fs.writeFileSync(arrPath, '[1,2,3]');
  assert.throws(() => requeuePending(arrPath), /not a pending-state object/);
  // Missing file -> alreadyRecovered, no throw.
  assert.deepEqual(requeuePending(path.join(dir, 'missing.json')), { requeued: 0, skipped: 0, duplicates: 0, recovered: null, alreadyRecovered: true });
  // Concurrent requeue of the same file: second returns alreadyRecovered.
  const q2 = path.join(dir, 'q2.json');
  writeJson(q2, { 'startup-listen-failed:2026-11-26T05:58:00Z': liveEntry });
  const r1 = requeuePending(q2);
  assert.equal(r1.requeued, 0, 'live entry wins, counted as duplicate');
  assert.equal(r1.duplicates, 1);
  const r2 = requeuePending(q2);
  assert.equal(r2.alreadyRecovered, true);
  // CLI: requeue via the module's main entry.
  const q3 = path.join(dir, 'q3.json');
  writeJson(q3, { 'startup-replay-failed:2026-11-26T05:58:00Z': { event: 'startup-replay-failed', windowStart: WS_A, requestId: REQ_A, ts: TS_A, detail: 'cli', firstSeen: TS_A, attempts: 0, lastAttempt: null } });
  const cli = spawnSync(process.execPath, [DISPATCHER, 'requeue', q3], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^RESULT 0 /);
  assert.match(cli.stdout, /"requeued":1/);
  const cliBad = spawnSync(process.execPath, [DISPATCHER, 'requeue', badPath], { encoding: 'utf8' });
  assert.equal(cliBad.status, 1);
  assert.match(cliBad.stderr, /^RESULT 1 /);
  const cliUnknown = spawnSync(process.execPath, [DISPATCHER, 'bogus-op'], { encoding: 'utf8' });
  assert.equal(cliUnknown.status, 1);
});

test('(y) header injection: free-form detail never reaches a header', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const stub = stubTransport();
  // A CR/LF detail can never arrive through a canonical log line — the
  // parser rejects control whitespace anywhere in the line — so the injection
  // case builds the parsed object directly (the shape retryPending hands to
  // dispatchAlert from a pending entry, or any direct caller).
  const evilDetail = 'x\r\nBcc: victim@example.com\r\nSubject: pwned';
  const parsed = { event: 'startup-listen-failed', requestId: REQ_A, windowStart: WS_A, ts: TS_A, detail: evilDetail };
  const r = await dispatchAlert(parsed, stub);
  assert.equal(r.sent, true);
  assert.equal(stub.sent.length, 1);
  const mail = stub.sent[0];
  assert.equal(mail.to, ALERT_RECIPIENT);
  assert.ok(!/[\r\n]/.test(mail.subject), 'subject has no CR/LF');
  assert.ok(!/[\r\n]/.test(mail.to), 'recipient has no CR/LF');
  assert.equal(mail.subject, `[NOVA] startup-listen-failed — ${WS_A}`);
  assert.ok(mail.body.includes(evilDetail), 'detail goes in the BODY only');
});

test('(y) transport failures: throw / malformed / no-reason normalised, then re-arm succeeds', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const parsed = parsedOf('startup-sweep-failed');
  const out = captureConsole(t);
  const throwing = async () => { throw new Error('multi\nline boom'); };
  const r1 = await dispatchAlert(parsed, throwing);
  assert.equal(r1.sent, false);
  assert.equal(r1.pending, true);
  assert.equal(r1.reason, 'transport-threw: multi-line-boom', `reason: ${r1.reason}`);
  // The reason string itself carries the 'transport-threw: ' prefix (with a
  // space); the SINGLE-TOKEN requirement applies to the log-line detail,
  // which re-encodes whitespace to dashes at emission.
  const failedLine = out.find((l) => l.includes('alert-delivery-failed'));
  assert.ok(failedLine, 'delivery-failed diagnostic emitted');
  const failedDetail = failedLine.split('detail=')[1];
  assert.ok(failedDetail && !/\s/.test(failedDetail.trim()), `detail single token: ${failedDetail}`);
  const malformed = async () => null;
  const r2 = await dispatchAlert(parsed, malformed);
  assert.deepEqual(r2, { sent: false, reason: 'transport-malformed-result', pending: true });
  const noReason = async () => ({ ok: false });
  const r3 = await dispatchAlert(parsed, noReason);
  assert.deepEqual(r3, { sent: false, reason: 'transport-unspecified-failure', pending: true });
  const emptyReason = async () => ({ ok: false, reason: '' });
  const r4 = await dispatchAlert(parsed, emptyReason);
  assert.deepEqual(r4, { sent: false, reason: 'transport-unspecified-failure', pending: true });
  assert.equal(readJson(DEDUP_PATH), null, 'no dedup entry after any failure');
  // Re-arm: a good transport now delivers exactly once.
  const good = stubTransport();
  const r5 = await dispatchAlert(parsed, good);
  assert.equal(r5.sent, true);
  assert.equal(good.sent.length, 1);
});

test('(y) duplicate-cleans-pending: an already-deduped pending entry is removed by retry', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const parsed = parsedOf('startup-reconcile-failed');
  const key = dedupKey(parsed.event, parsed);
  const good = stubTransport();
  const first = await dispatchAlert(parsed, good);
  assert.equal(first.sent, true);
  // Simulate the probe's pending-first write for an event that was already
  // delivered (crash between dedup write and pending removal).
  updatePendingState((s) => {
    s[key] = { event: parsed.event, windowStart: parsed.windowStart, requestId: parsed.requestId, ts: parsed.ts, detail: parsed.detail, firstSeen: new Date().toISOString(), attempts: 0, lastAttempt: null };
  });
  const retried = await retryPending(good);
  assert.equal(retried.retried, 1);
  assert.equal(retried.delivered, 1, 'duplicate result counts as delivered for cleanup');
  assert.equal(retried.stillPending, 0);
  assert.equal(good.sent.length, 1, 'no second email for the duplicate');
  assert.deepEqual(readJson(PENDING_PATH), {});
});

test('(y) O-1: retryPending drops a legacy journal-only entry without quarantining the pending file', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const out = captureConsole(t);
  const emailedKey = 'startup-listen-failed:2026-11-26T05:58:00Z';
  const journalKey = 'startup-recovery-reset-preserved:2026-11-26T06:58:00Z';
  const now = new Date().toISOString();
  const emailedEntry = { event: 'startup-listen-failed', windowStart: WS_A, requestId: REQ_A, ts: TS_A, detail: 'emailed-still-pending', firstSeen: now, attempts: 0, lastAttempt: null };
  const journalEntry = { event: 'startup-recovery-reset-preserved', windowStart: WS_B, requestId: REQ_B, ts: TS_A, detail: 'journal-only-legacy', firstSeen: now, attempts: 0, lastAttempt: null };
  writeJson(PENDING_PATH, { [emailedKey]: emailedEntry, [journalKey]: journalEntry });
  // The persisted-state validator recognises the legacy journal-only entry,
  // so the loader returns the whole file instead of the fallback empty object
  // (the pre-fix behaviour, which made the cleanup below unreachable).
  assert.equal(validatePendingState({ [journalKey]: journalEntry }), true, 'persisted state accepts a legacy journal-only entry');
  assert.deepEqual(loadPendingState({ quarantine: false }), { [emailedKey]: emailedEntry, [journalKey]: journalEntry });
  // Recording transport that FAILS, so the emailed entry stays pending and
  // any call for the journal-only event would be visible in `calls`.
  const calls = [];
  const failing = async ({ to, subject, body }) => { calls.push({ to, subject, body }); return { ok: false, reason: 'relay-down' }; };
  const result = await retryPending(failing);
  assert.deepEqual(result, { retried: 1, delivered: 0, stillPending: 1 });
  const pending = readJson(PENDING_PATH) ?? {};
  // (1) the journal-only entry is removed.
  assert.equal(pending[journalKey], undefined, 'journal-only entry dropped');
  assert.deepEqual(Object.keys(pending), [emailedKey]);
  // (2) the emailed entry remains pending (its failed retry increments attempts).
  assert.equal(pending[emailedKey].event, 'startup-listen-failed');
  assert.equal(pending[emailedKey].detail, 'emailed-still-pending');
  assert.equal(pending[emailedKey].attempts, 1, 'failed retry increments attempts');
  assert.match(pending[emailedKey].lastAttempt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'failed retry stamps lastAttempt');
  // (3) the transport was called exactly once, for the emailed event only.
  assert.equal(calls.length, 1, 'transport called once');
  assert.ok(calls[0].subject.includes('startup-listen-failed'), 'the one call is the emailed event');
  assert.ok(!calls[0].subject.includes('startup-recovery-reset-preserved'), 'no call for the journal-only event');
  // (4) the pending file is not quarantined.
  assert.equal(fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-pending.json.corrupt-')).length, 0, 'no quarantine');
  assert.ok(fs.existsSync(PENDING_PATH), 'pending file still in place');
  // (5) the cleanup diagnostic names the journal-only entry and reason.
  const line = out.find((l) => l.includes('alert-pending-invalid-entry'));
  assert.ok(line, 'alert-pending-invalid-entry logged');
  assert.ok(line.includes(journalKey), `diagnostic names the journal-only key: ${line}`);
  assert.ok(line.includes('journal-only-dropped'), `diagnostic names the reason: ${line}`);
});

test('(y) O-1: requeuePending still rejects a journal-only entry (strict validator)', (t) => {
  saveAlertState(t);
  clearAlertState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-requeue-journal-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quarantinePath = path.join(dir, 'alert-pending.json.corrupt-2026-11-26T00-00-00-000Z');
  const journalEntry = { event: 'startup-recovery-counter-unwritable', windowStart: WS_B, requestId: REQ_B, ts: TS_A, detail: 'journal-only-in-quarantine', firstSeen: TS_A, attempts: 0, lastAttempt: null };
  writeJson(quarantinePath, { 'startup-recovery-counter-unwritable:2026-11-26T06:58:00Z': journalEntry });
  const out = captureConsole(t);
  const res = requeuePending(quarantinePath);
  assert.equal(res.requeued, 0, 'journal-only entry is not requeued');
  assert.equal(res.skipped, 1, 'journal-only entry is skipped');
  assert.equal(res.duplicates, 0);
  assert.ok(res.recovered && res.recovered.startsWith(`${quarantinePath}.recovered-`), `recovered path: ${res.recovered}`);
  assert.deepEqual(readJson(PENDING_PATH), {}, 'nothing merged into the live pending file');
  assert.ok(out.some((l) => l.includes('alert-pending-invalid-entry')), 'skip logged as alert-pending-invalid-entry');
});

test('(y) path encoding with whitespace + atomic-write temp cleanup', (t) => {
  saveAlertState(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-path with space-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spaced = path.join(dir, 'state file.json');
  const res = withStateFileLock(spaced, () => { writeStateFileAtomic(spaced, { a: 1 }); return 'ok'; });
  assert.deepEqual(res, { ok: true, value: 'ok' });
  assert.deepEqual(readJson(spaced), { a: 1 });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')).length, 0, 'no temp file remains after a successful write');
  // Quarantine diagnostic for a path with spaces: the detail is one token.
  const out = captureConsole(t);
  const corruptSpaced = path.join(dir, 'corrupt file.json');
  fs.writeFileSync(corruptSpaced, '{bad');
  assert.deepEqual(loadStateFile(corruptSpaced, {}, null, { quarantine: true }), {});
  const line = out.find((l) => l.includes('alert-state-corrupt'));
  assert.ok(line, 'corrupt line logged');
  const detail = line.split('detail=')[1];
  assert.ok(detail && !/\s/.test(detail), `detail is a single token: ${detail}`);
});

test('(y) diagnostic guarding: a throwing message getter cannot defeat a diagnostic', async (t) => {
  saveAlertState(t);
  clearAlertState();
  const out = captureConsole(t);
  const err = new Error('x');
  Object.defineProperty(err, 'message', { get() { throw new Error('boom'); } });
  const throwing = async () => { throw err; };
  const parsed = parsedOf('startup-sweep-failed');
  const r = await dispatchAlert(parsed, throwing);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'transport-threw: unknown', `reason: ${r.reason}`);
  const line = out.find((l) => l.includes('alert-delivery-failed'));
  assert.ok(line, 'delivery-failed diagnostic emitted');
  const detail = line.split('detail=')[1];
  assert.ok(detail && !/\s/.test(detail.trim()), `detail single token: ${detail}`);
});

// =============================================================================
// (y) Transaction-lock (flock) cases (a)–(g)
// =============================================================================
test('(y) withStateFileLock: fail-fast contention, release, kill-holder, pause-holder, open failure', async (t) => {
  saveAlertState(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'state.json');
  const { flockExNb, flockUn } = await import('../src/api-server/flock-binding.mjs');
  // (a) Contended: a held lock returns state-lock-timeout IMMEDIATELY (fail-fast, <1 s).
  const fd = fs.openSync(`${p}.lock`, 'a');
  assert.equal(flockExNb(fd), true);
  try {
    const started = Date.now();
    const res = withStateFileLock(p, () => 'never');
    assert.deepEqual(res, { ok: false, reason: 'state-lock-timeout' });
    assert.ok(Date.now() - started < 1000, `fail-fast took ${Date.now() - started}ms`);
  } finally { flockUn(fd); fs.closeSync(fd); }
  // (b) After release the lock is acquirable and the mutation runs.
  assert.deepEqual(withStateFileLock(p, () => 42), { ok: true, value: 42 });
  // (c) Kill the holder: the kernel releases the lock, then acquisition succeeds.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { flockExNb } from '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server/flock-binding.mjs')}';
    const fd = fs.openSync('${`${p}.lock`}', 'a');
    if (!flockExNb(fd)) process.exit(3);
    console.log('HOLDING');
    setTimeout(() => {}, 30000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveHold, rejectHold) => {
    holder.stdout.on('data', (d) => { if (d.toString().includes('HOLDING')) resolveHold(); });
    holder.on('error', rejectHold);
  });
  assert.deepEqual(withStateFileLock(p, () => 'x'), { ok: false, reason: 'state-lock-timeout' });
  holder.kill('SIGKILL');
  await new Promise((r) => holder.on('close', r));
  assert.deepEqual(withStateFileLock(p, () => 'after-kill'), { ok: true, value: 'after-kill' });
  // (d) Pause the holder mid-transaction (SIGSTOP): second writer fails at
  // once (no steal), holder resumed commits, second writer then commits on top.
  const holder2 = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { flockExNb, flockUn } from '${path.join(REPO_ROOT, 'gpu-cloud/src/api-server/flock-binding.mjs')}';
    const fd = fs.openSync('${`${p}.lock`}', 'a');
    if (!flockExNb(fd)) process.exit(3);
    console.log('HOLDING2');
    setTimeout(() => { flockUn(fd); fs.closeSync(fd); }, 3000);
    setTimeout(() => {}, 30000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveHold, rejectHold) => {
    holder2.stdout.on('data', (d) => { if (d.toString().includes('HOLDING2')) resolveHold(); });
    holder2.on('error', rejectHold);
  });
  holder2.kill('SIGSTOP');
  assert.deepEqual(withStateFileLock(p, () => 'stolen?'), { ok: false, reason: 'state-lock-timeout' }, 'a paused holder is never stolen from');
  holder2.kill('SIGCONT');
  await new Promise((r) => setTimeout(r, 3500));
  assert.deepEqual(withStateFileLock(p, () => 'after-resume'), { ok: true, value: 'after-resume' });
  holder2.kill('SIGKILL');
  await new Promise((r) => holder2.on('close', r));
  // (e) Lock-file open failure: distinct result, never mistaken for contention.
  assert.deepEqual(withStateFileLock(path.join(dir, 'no-such-dir', 'state.json'), () => 'x'), { ok: false, reason: 'state-lock-unavailable' });
  // (f) Release-failure diagnostic exists in the source (not directly forcible
  // without breaking the binding: the fd is opened inside the lock).
  const dispSrc = fs.readFileSync(DISPATCHER, 'utf8');
  assert.ok(dispSrc.includes('alert-state-lock-release-failed'), 'release-failure diagnostic emission present');
  // (g) Export boundary: the protected files are written ONLY through the two
  // update functions inside the lock; plain loads never create the files.
  assert.equal(readBytes(DEDUP_PATH), null);
  assert.deepEqual(loadDedupState(), {});
  assert.equal(readBytes(DEDUP_PATH), null, 'a load never creates the file');
  assert.ok(dispSrc.includes('export function updateDedupState'));
  assert.ok(dispSrc.includes('export function updatePendingState'));
});

test('(y) probe exits only 0/1: static scan of health-check.js process.exit calls', (t) => {
  const src = fs.readFileSync(PROBE, 'utf8');
  const exits = [...src.matchAll(/process\.exit\((\d+)\)/g)].map((m) => m[1]);
  assert.ok(exits.length > 0, 'probe has explicit exit calls');
  for (const code of exits) assert.ok(code === '0' || code === '1', `probe exit code ${code} is not 0/1`);
  assert.ok(!src.includes('process.exit(2)'), 'probe never exits 2');
  assert.ok(!src.includes('process.exit(99)'), 'probe never exits 99');
  assert.ok(src.includes("lastScan: scanUntil"), 'checkpoint is persisted as scanUntil exactly');
  assert.ok(src.includes("'--until', scanUntil"), '--until is passed the captured scanUntil');
});

// =============================================================================
// (y) Probe run with fake journalctl/systemctl: scan boundary + pending-first
// =============================================================================
test('(y) installed-probe run: fixed scan boundary, pending-first, checkpoint advance', async (t) => {
  saveAlertState(t);
  clearAlertState();
  fs.rmSync(CHECKPOINT_PATH, { force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(dir, 'journalctl-args.txt');
  const eventsFile = path.join(dir, 'events.jsonl');
  // Fake journalctl: records its args, prints the JSON lines from $EVENTS_FILE.
  // Fake systemctl: always reports the unit active (no anomaly path).
  const eventLine = canonicalLine('startup-listen-failed', { detail: 'probe-boundary-test' });
  const journalOnlyLine = canonicalLine('startup-recovery-reset-preserved', { detail: 'probe-journal-only-test' });
  const eventJson = JSON.stringify({ MESSAGE: eventLine, _SYSTEMD_UNIT: 'nova-api-server.service' });
  const journalOnlyJson = JSON.stringify({ MESSAGE: journalOnlyLine, _SYSTEMD_UNIT: 'nova-api-server.service' });
  fs.writeFileSync(path.join(bin, 'journalctl'), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat "$EVENTS_FILE"
`);
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
printf 'ActiveState=active\\nSubState=running\\nResult=success\\n'
`);
  fs.chmodSync(path.join(bin, 'journalctl'), 0o755);
  fs.chmodSync(path.join(bin, 'systemctl'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const runProbe = (events) => {
    fs.writeFileSync(eventsFile, events.join('\n') + '\n');
    return spawnSync(process.execPath, [PROBE], { encoding: 'utf8', env: { ...env, EVENTS_FILE: eventsFile }, timeout: 30000 });
  };
  // Run 1: emailed event only — pending-first works, checkpoint advances.
  const r1 = runProbe([eventJson]);
  assert.equal(r1.status, 0, `probe run 1 exit 0, stderr: ${r1.stderr}`);
  const args1 = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  const since1 = args1[args1.indexOf('--since') + 1];
  const until1 = args1[args1.indexOf('--until') + 1];
  assert.ok(since1 && until1, `journalctl got --since/--until: ${JSON.stringify(args1)}`);
  // Checkpoint advanced to scanUntil EXACTLY.
  const checkpoint1 = readJson(CHECKPOINT_PATH);
  assert.equal(checkpoint1.lastScan, until1, 'checkpoint lastScan == --until');
  // No MTA on this dev VM: delivery fails (sendmail-not-installed) -> the
  // event stays pending, NO dedup entry (Blocker-3 first half, unit-level).
  const pending1 = readJson(PENDING_PATH) ?? {};
  assert.ok(pending1['startup-listen-failed:2026-11-26T05:58:00Z'], 'failed delivery leaves a pending entry');
  assert.equal(readJson(DEDUP_PATH), null, 'no dedup entry without a delivery');
  assert.equal(fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-pending.json.corrupt-')).length, 0, 'no quarantine on an emailed-only scan');
  // Run 2: the same emailed event PLUS a journal-only line. --since must be
  // exactly the first checkpoint - 60 s (the overlap is in the query, never
  // the checkpoint).
  const r2 = runProbe([eventJson, journalOnlyJson]);
  assert.equal(r2.status, 0, `probe run 2 exit 0, stderr: ${r2.stderr}`);
  const args2 = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  const since2 = args2[args2.indexOf('--since') + 1];
  const until2 = args2[args2.indexOf('--until') + 1];
  assert.equal(Date.parse(since2), Date.parse(checkpoint1.lastScan) - 60_000, '--since is exactly lastScan - 60s');
  assert.equal(readJson(CHECKPOINT_PATH).lastScan, until2, 'checkpoint advanced to the second scanUntil');
  // DEFECT #3 (see report): the probe writes the journal-only line to pending
  // (pending-first, for every parsed event), but validatePendingEntry rejects
  // journal-only events (ALERT_EVENTS only) — so the next locked pending load
  // quarantines the WHOLE pending file and the emailed entry is LOST with it.
  // The assertions below state the design's intended behaviour: no quarantine,
  // the emailed entry survives. They fail until the probe skips journal-only
  // lines before the pending-first write (the defect #2 fix direction).
  // (Rev 4.9 O-1 note: the persisted-state validator now recognises legacy
  // journal-only entries, so even a stray one would be dropped individually
  // by retryPending instead of quarantining the file; the §3 probe skip
  // above still keeps them out of pending in the first place.)
  assert.equal(fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('alert-pending.json.corrupt-')).length, 0, 'journal-only line must not quarantine the pending file');
  const pending2 = readJson(PENDING_PATH) ?? {};
  assert.ok(pending2['startup-listen-failed:2026-11-26T05:58:00Z'], 'emailed pending entry survives a scan that also sees a journal-only line');
});

// =============================================================================
// (y) Probe heartbeat watch (Rev 4.9, F-6a / Finding 8B): the standing probe
// reads the runner heartbeat every run and dispatches
// storage-runner-heartbeat-outage directly via dispatchAlert — no pending
// write, dedup-bounded by scope = lastSuccessfulSweepAt. This test drives the
// REAL probe code path (child process, fake journalctl/systemctl/sendmail in
// PATH, NOVA_RUNNER_HEALTH_PATH at a temp heartbeat file) with a fake
// sendmail that records every invocation.
// =============================================================================
test('(y) probe heartbeat watch: missing/failed/stale alert, healthy silent, failed delivery leaves no pending, dedup by lastSuccessfulSweepAt', async (t) => {
  saveAlertState(t);
  clearAlertState();
  fs.rmSync(CHECKPOINT_PATH, { force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-heartbeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const eventsFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsFile, ''); // empty journal: no startup events in any run
  const recordFile = path.join(dir, 'sendmail-record.txt');
  const heartbeatPath = path.join(dir, 'runner-health.json');
  // Fake journalctl: no events. Fake systemctl: unit active. Fake sendmail:
  // records the whole message per invocation; exit code from $SENDMAIL_EXIT.
  fs.writeFileSync(path.join(bin, 'journalctl'), `#!/bin/sh\ncat "$EVENTS_FILE"\n`);
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf 'ActiveState=active\\nSubState=running\\nResult=success\\n'\n`);
  fs.writeFileSync(path.join(bin, 'sendmail'), `#!/bin/sh\ninput=$(cat)\n{ printf '===SENDMAIL-INVOCATION===\\n'; printf '%s\\n' "$input"; } >> "$SENDMAIL_RECORD"\nexit \${SENDMAIL_EXIT:-0}\n`);
  for (const f of ['journalctl', 'systemctl', 'sendmail']) fs.chmodSync(path.join(bin, f), 0o755);
  const runProbe = (sendmailExit = '0') => spawnSync(process.execPath, [PROBE], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVENTS_FILE: eventsFile, SENDMAIL_RECORD: recordFile, SENDMAIL_EXIT: sendmailExit, NOVA_RUNNER_HEALTH_PATH: heartbeatPath },
    timeout: 30000,
  });
  const dispatchCount = () => {
    if (!fs.existsSync(recordFile)) return 0;
    return fs.readFileSync(recordFile, 'utf8').split('===SENDMAIL-INVOCATION===').length - 1;
  };
  const recordText = () => (fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : '');
  const pendingEntries = () => readJson(PENDING_PATH) ?? {};
  const dedupEntries = () => readJson(DEDUP_PATH) ?? {};
  const writeHeartbeat = (value) => writeJson(heartbeatPath, value);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const staleA = iso(now - 3 * 60 * 60 * 1000); // 3 h ago: stale, scope A
  const staleB = iso(now - 4 * 60 * 60 * 1000); // 4 h ago: stale, scope B
  const staleC = iso(now - 5 * 60 * 60 * 1000); // 5 h ago: stale, scope C
  const staleD = iso(now - 6 * 60 * 60 * 1000); // 6 h ago: stale, scope D
  const healthyTs = iso(now - 10 * 60 * 1000); // 10 min ago: healthy
  const today = new Date().toISOString().slice(0, 10);

  // (1) Missing heartbeat -> alert dispatch attempted (scope = today, UTC date).
  fs.rmSync(heartbeatPath, { force: true });
  const r1 = runProbe();
  assert.equal(r1.status, 0, `missing-heartbeat probe exit 0, stderr: ${r1.stderr}`);
  assert.equal(dispatchCount(), 1, 'missing heartbeat: exactly one dispatch attempted');
  assert.ok(recordText().includes('Subject: [NOVA] storage-runner-heartbeat-outage'), 'missing heartbeat: outage subject sent');
  assert.ok(recordText().includes('Detail: runner-heartbeat-missing'), 'missing heartbeat: reason in the body');
  assert.ok(dedupEntries()[`storage-runner-heartbeat-outage:${today}`], 'missing heartbeat: dedup entry written for the date scope');
  assert.deepEqual(pendingEntries(), {}, 'missing heartbeat: no pending entry');

  // (2) Failed heartbeat -> alert dispatch attempted (scope = its lastSuccessfulSweepAt).
  writeHeartbeat({ status: 'failed', lastSuccessfulSweepAt: staleA, lastAttemptAt: iso(now), objectsDeleted: 0, error: 'sweep boom' });
  const r2 = runProbe();
  assert.equal(r2.status, 0, `failed-heartbeat probe exit 0, stderr: ${r2.stderr}`);
  assert.equal(dispatchCount(), 2, 'failed heartbeat: a second dispatch attempted');
  assert.ok(recordText().includes('Detail: runner-heartbeat-failed'), 'failed heartbeat: reason in the body');
  assert.ok(dedupEntries()[`storage-runner-heartbeat-outage:${staleA}`], 'failed heartbeat: dedup entry written for scope A');
  assert.deepEqual(pendingEntries(), {}, 'failed heartbeat: no pending entry');

  // (3) Stale heartbeat -> alert dispatch attempted (distinct scope B, so not deduped by case 2).
  writeHeartbeat({ status: 'ok', lastSuccessfulSweepAt: staleB, lastAttemptAt: iso(now), objectsDeleted: 5, error: null });
  const r3 = runProbe();
  assert.equal(r3.status, 0, `stale-heartbeat probe exit 0, stderr: ${r3.stderr}`);
  assert.equal(dispatchCount(), 3, 'stale heartbeat: a third dispatch attempted');
  assert.ok(recordText().includes('Detail: runner-heartbeat-stale'), 'stale heartbeat: reason in the body');
  assert.ok(dedupEntries()[`storage-runner-heartbeat-outage:${staleB}`], 'stale heartbeat: dedup entry written for scope B');
  assert.deepEqual(pendingEntries(), {}, 'stale heartbeat: no pending entry');

  // (4) Healthy heartbeat -> no alert.
  writeHeartbeat({ status: 'ok', lastSuccessfulSweepAt: healthyTs, lastAttemptAt: iso(now), objectsDeleted: 5, error: null });
  const r4 = runProbe();
  assert.equal(r4.status, 0, `healthy-heartbeat probe exit 0, stderr: ${r4.stderr}`);
  assert.equal(dispatchCount(), 3, 'healthy heartbeat: no dispatch attempted');
  assert.deepEqual(pendingEntries(), {}, 'healthy heartbeat: no pending entry');

  // (5) Failed delivery -> no pending entry is created; the failure is logged.
  writeHeartbeat({ status: 'ok', lastSuccessfulSweepAt: staleC, lastAttemptAt: iso(now), objectsDeleted: 0, error: null });
  const r5 = runProbe('1');
  assert.equal(r5.status, 0, `failed-delivery probe exit 0, stderr: ${r5.stderr}`);
  assert.equal(dispatchCount(), 4, 'failed delivery: the dispatch was still attempted');
  assert.ok(r5.stderr.includes('alert-delivery-failed'), 'failed delivery: alert-delivery-failed logged');
  assert.deepEqual(pendingEntries(), {}, 'failed delivery: NO pending entry is created');
  assert.equal(dedupEntries()[`storage-runner-heartbeat-outage:${staleC}`], undefined, 'failed delivery: no dedup entry without a delivery');
  // The watch re-fires on the next probe run while the outage persists: the
  // same scope now delivers (no dedup entry blocks it).
  const r5b = runProbe();
  assert.equal(r5b.status, 0, `re-fire probe exit 0, stderr: ${r5b.stderr}`);
  assert.equal(dispatchCount(), 5, 'failed delivery: next probe re-attempts the same scope');
  assert.ok(dedupEntries()[`storage-runner-heartbeat-outage:${staleC}`], 're-fire: dedup entry written once delivered');
  assert.deepEqual(pendingEntries(), {}, 're-fire: still no pending entry');

  // (6) Repeated probe with the same lastSuccessfulSweepAt -> deduplicated.
  writeHeartbeat({ status: 'ok', lastSuccessfulSweepAt: staleB, lastAttemptAt: iso(now), objectsDeleted: 5, error: null });
  const r6 = runProbe();
  assert.equal(r6.status, 0, `repeat-scope probe exit 0, stderr: ${r6.stderr}`);
  assert.equal(dispatchCount(), 5, 'same lastSuccessfulSweepAt: second probe does not re-dispatch');
  assert.deepEqual(pendingEntries(), {}, 'repeat scope: no pending entry');

  // (7) New successful-sweep timestamp -> a new outage scope can alert.
  writeHeartbeat({ status: 'ok', lastSuccessfulSweepAt: staleD, lastAttemptAt: iso(now), objectsDeleted: 0, error: null });
  const r7 = runProbe();
  assert.equal(r7.status, 0, `new-scope probe exit 0, stderr: ${r7.stderr}`);
  assert.equal(dispatchCount(), 6, 'new lastSuccessfulSweepAt: a new outage scope alerts');
  assert.ok(dedupEntries()[`storage-runner-heartbeat-outage:${staleD}`], 'new scope: dedup entry written for scope D');
  assert.deepEqual(pendingEntries(), {}, 'new scope: no pending entry');
});

// =============================================================================
// (t) Canonical registry: every producer call site vs EVENT_REGISTRY
// =============================================================================
test('(t) canonical registry: producer call sites match EVENT_REGISTRY; 21 diagnostics excluded', (t) => {
  const apiSrc = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server.js'), 'utf8');
  const attSrc = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/startup-attempts.js'), 'utf8');
  const dispSrc = fs.readFileSync(DISPATCHER, 'utf8');
  const probeSrc = fs.readFileSync(PROBE, 'utf8');
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/storage-runner.js'), 'utf8');
  const prepSh = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/systemd/prepare-startup-id.sh'), 'utf8');
  const retrySh = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/systemd/retry-startup.sh'), 'utf8');
  const wrapperSh = fs.readFileSync(path.join(REPO_ROOT, 'gpu-cloud/src/api-server/run-health-check.sh'), 'utf8');
  const allSrc = [apiSrc, attSrc, dispSrc, probeSrc, runnerSrc, prepSh, retrySh, wrapperSh].join('\n');
  // The twenty-one deliberately unregistered diagnostics (design F5-41,
  // chunk-18): emitted by the code, never in EVENT_REGISTRY.
  const UNREGISTERED_DIAGNOSTICS = [
    'alert-delivery-failed', 'alert-pending-cleanup-deferred', 'alert-pending-expired',
    'alert-pending-invalid-entry', 'alert-pending-requeue-duplicate', 'alert-state-corrupt',
    'alert-state-lock-release-failed', 'alert-state-quarantine-failed', 'alert-undedupeable-event',
    'alert-pending-retained', 'alert-pending-unwritable', 'alert-dispatch-failed',
    'alert-checkpoint-unreadable', 'alert-checkpoint-unwritable',
    'health-check-malformed-event-line', 'health-check-journal-failed', 'health-check-systemctl-failed',
    'health-check-unit-anomaly', 'health-check-probe-failed',
    'health-check-skipped-overlap', 'health-check-wrapper-failed',
  ];
  assert.equal(UNREGISTERED_DIAGNOSTICS.length, 21);
  for (const name of UNREGISTERED_DIAGNOSTICS) {
    assert.ok(!EVENT_REGISTRY.includes(name), `${name} must NOT be registered`);
    assert.ok(allSrc.includes(name), `${name} is emitted by the shipped code`);
  }
  // Every emitted event-like name is either registered or one of the 21.
  const emitted = new Set();
  for (const m of allSrc.matchAll(/event=['"]([a-z][a-z0-9-]*)['"]/g)) emitted.add(m[1]);
  for (const m of allSrc.matchAll(/logStartupEvent\('([a-z][a-z0-9-]*)'/g)) emitted.add(m[1]);
  for (const m of allSrc.matchAll(/logLine\('([a-z][a-z0-9-]*)'/g)) emitted.add(m[1]);
  for (const m of allSrc.matchAll(/event=([a-z][a-z0-9-]*)/g)) emitted.add(m[1]);
  for (const name of emitted) {
    assert.ok(EVENT_REGISTRY.includes(name) || UNREGISTERED_DIAGNOSTICS.includes(name), `emitted name ${name} is neither registered nor an enumerated diagnostic`);
  }
  // Every registered name has a producer call site. The former exception
  // for startup-recovery-failed is closed by the Rev 4.9 §6 delivery: the
  // real storage runner (gpu-cloud/src/storage-runner.js) is now its
  // producer (it logs startup-recovery-failed on a failed catch-up pass,
  // and startup-recovery-succeeded on success).
  assert.equal(EVENT_REGISTRY.length, 24);
  for (const name of EVENT_REGISTRY) {
    assert.ok(allSrc.includes(name), `${name}: producer call site exists`);
  }
  // The registry is exactly ALERT_EVENTS (22) + JOURNAL_ONLY_EVENTS (2), no overlap.
  assert.equal(ALERT_EVENTS.length, 22);
  assert.equal(JOURNAL_ONLY_EVENTS.length, 2);
  assert.equal(new Set([...ALERT_EVENTS, ...JOURNAL_ONLY_EVENTS]).size, 24);
  // parseEventLine accepts every registered name and rejects unregistered ones.
  for (const name of EVENT_REGISTRY) {
    assert.equal(parseEventLine(canonicalLine(name)).ok, true, `${name} parses`);
  }
  assert.equal(parseEventLine(canonicalLine('startup-nope')).reason, 'unregistered-event');
});
