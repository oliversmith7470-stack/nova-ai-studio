// startup-attempts.js — API-process side of the Phase 5 startup protocol.
// Active only when NOVA_STARTUP_STATE_DIR is set (the systemd unit sets it).
// When unset, api-server.js behaves exactly as Phase 3 shipped — PROVIDED the
// new modules are present and load successfully (Rev 4.7, F5-26): the startup
// dependency chain is not unchanged — api-server.js statically imports this
// module, which statically imports startup-counter.mjs, so a missing/broken new
// module fails the process at import time (correction (l)).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readCounter, LIMIT, isValidCalendarDate, UUID_RE, encodeFsDetail } from './startup-counter.mjs';

export const STARTUP_STATE_DIR = process.env.NOVA_STARTUP_STATE_DIR || null;
export const STARTUP_RETRY_LIMIT_EXIT = 42; // new constant (not in constants.js)
const LOCK_PATH = '/var/lib/nova-api/startup-attempts.lock';
const COUNTER_CLI = '/opt/nova-ai-studio/bin/startup-counter.mjs'; // install.sh path

// Logs one canonical event line (§10): the message IS the key=value line, so the
// journal carries it verbatim. `detail` is sanitised (whitespace -> '-', max 120 chars)
// so the line stays parseable. There is no logger module in the shipped code.
// FIELD PROVENANCE (Rev 4.8, chunk-14 review — Gap F / chunk-13 replies):
// logStartupEvent does NOT validate its arguments — it is the last-resort
// logger, called on failure paths where the identity may be null — so the
// guarantee is established at the producers and at every call site, and is
// stated here so it can be checked by grep: (a) `event` is always a string
// literal drawn from the registered set (ALERT_EVENTS + JOURNAL_ONLY_EVENTS
// in §10) — no call site passes a variable event name; (b) `level` is the
// default 'error' or the literal 'info' — no other level is passed anywhere;
// (c) `requestId` is null or a value validated as an RFC 4122 v4 UUID —
// verifyStartupReadiness validates the file's id before any use, and every
// other value reaching a call site is either the verifyStartupReadiness
// return (start()'s locals), a StartupFailureError field (set in
// verifyStartupReadiness), or null (the CLI factory path, where readiness
// never ran); (d) `windowStart` is null or a counter-derived ISO date
// validated by readCounter / validateCounter. Call sites (§14, enumerated):
// verifyStartupReadiness (unreadable/missing/invalid-startup-request-id,
// readiness-counter-unavailable, and every `fail()` condition);
// decideStartupFailureExit (startup-recovery-counter-unavailable,
// startup-recovery-limit-reached); start()'s failStep
// (startup-sweep-failed, startup-replay-failed, startup-reconcile-failed)
// and listen catch (startup-listen-failed), the post-listen reset
// (startup-recovery-reset-preserved, startup-recovery-counter-unwritable,
// startup-recovery-succeeded); the CLI entry (startup-factory-failed).
// `detail` is the only free-form field and is sanitised here.
export function logStartupEvent(event, { requestId = null, windowStart = null, detail = '', level = 'error' } = {}) {
  const clean = String(detail).replace(/\s+/g, '-').slice(0, 120) || 'none';
  const line = `ts=${new Date().toISOString()} level=${level} event=${event} requestId=${requestId ?? 'none'} windowStart=${windowStart ?? 'none'} detail=${clean}`;
  if (level === 'error') console.error(`[api-server] ${line}`);
  else console.log(`[api-server] ${line}`);
}

class StartupFailureError extends Error {
  constructor(condition, requestId, windowStart) {
    super(condition);
    this.name = 'StartupFailureError';
    this.condition = condition;
    this.startupRequestId = requestId ?? null;
    this.startupWindowStart = windowStart ?? null;
  }
}

// Safe rejection formatter (Rev 4.7, F5-25): JSON.stringify can itself throw
// (BigInt, circular structures, a throwing toJSON). formatRejectionValue never
// throws: it tries JSON.stringify, falls back to String(err), and finally to a
// fixed placeholder. normaliseError wraps a non-Error rejection in an Error
// carrying the original value as `cause`; an Error input passes through
// unchanged (no cause added).
export function formatRejectionValue(err) {
  if (typeof err === 'string') return err;
  try { const s = JSON.stringify(err); if (typeof s === 'string') return s; } catch { /* fall through to String */ }
  try { return String(err); } catch { return '<unprintable-rejection>'; }
}

export function normaliseError(err) {
  if (err instanceof Error) return err;
  const error = new Error(`non-error-rejection: ${formatRejectionValue(err)}`);
  error.cause = err;
  return error;
}

// Attaches the startup identity to an error WITHOUT ever replacing the original
// failure (Rev 4.8, F5-42): assigning properties to the original Error can
// throw if the Error is frozen or non-extensible (in ES modules a failed
// assignment to a frozen object throws), which would replace the original
// failure and lose the canonical event log. This helper tries the direct
// assignment first; if it throws, it returns a NEW wrapper Error (message =
// the guarded extraction of the original message, `cause` = the original
// error) carrying the identity. It never throws itself — the wrapper-message
// extraction is independently guarded (Rev 4.8, chunk-14 review): reading
// `err.message` can itself throw (a throwing getter or Proxy) and String(err)
// can throw too, so each step has its own try/catch and a fixed fallback
// message ('<unreadable-error>') is used if both fail; the original value is
// preserved in `cause` regardless. (A fresh Error is always extensible, so
// assigning `cause` and the identity to the wrapper cannot throw.)
export function attachStartupIdentity(err, requestId, windowStart) {
  try {
    err.startupRequestId = requestId;
    err.startupWindowStart = windowStart;
    return err;
  } catch {
    let message;
    try { message = err && err.message ? err.message : String(err); }
    catch { message = '<unreadable-error>'; }
    if (typeof message !== 'string' || message === '') {
      try { message = String(err); } catch { message = '<unreadable-error>'; }
    }
    const wrapper = new Error(typeof message === 'string' && message !== '' ? message : '<unreadable-error>');
    wrapper.cause = err;
    wrapper.startupRequestId = requestId;
    wrapper.startupWindowStart = windowStart;
    return wrapper;
  }
}

// The six-condition readiness verification (§14, cycle binding). Returns
// { requestId, windowStart, attempts, generation } on success; throws
// StartupFailureError (already logged) on any failed condition. The counter is
// read ONCE here: the returned windowStart + attempts + generation ARE the
// identity the post-listen reset is checked against, so the reset can never be
// authorised on a stale observation. A counter that cannot be read is a
// readiness failure, not a null identity (Rev 4.7, F5-23): verifyStartupReadiness
// fails immediately with `readiness-counter-unavailable` on any non-zero
// readCounter() — start() never proceeds to listen() without a readable counter.
// The thrown error carries startupRequestId + startupWindowStart into
// decideStartupFailureExit (correction (d)) — the diagnostic chain is complete.
// completedAt must be a valid calendar timestamp, not in the future, and no
// older than 10 minutes: the acceptable age range is [0 s, 600 s] (correction (b)).
// The record is structurally validated BEFORE any property is read (correction
// (c)): a parsed JSON value that is not a plain object, or that lacks the
// required string fields, is classified `readiness-not-an-object` /
// `readiness-missing-fields` — never a TypeError from property access.
// Reads a readiness file and PRESERVES the missing/unreadable distinction
// (Rev 4.8, F5-40): { ok: true, value } on success, { ok: false, kind:
// 'missing' } on ENOENT, { ok: false, kind: 'unreadable', error } on any other
// read error (permission, I/O). verifyStartupReadiness maps the kinds to
// distinct conditions, so an infrastructure read failure is never misdiagnosed
// as a missing field. The startup request id is validated as an RFC 4122 v4
// UUID before any use (Rev 4.8, chunk-14 review — condition (vi)): both the
// value read from the startup-request-id file and the record's
// startupRequestId must pass UUID_RE — the id is interpolated into the
// canonical log line, so an unvalidated file value could break the line
// format, and equality between two untrusted strings proves nothing. The
// file's id is validated BEFORE the counter is read, so no log line ever
// carries an unvalidated id; a missing id therefore fails before a counter
// failure is considered (precedence change vs Rev 4.7, stated explicitly).
// The record's four required fields must be strings; additional fields are
// permitted and ignored — the producer's documented field set is cycleId,
// startedAt, objectsDeleted, objectsExpiredButMissing, indexRebuilt, and
// error on a failed pass (§14 recovery bullet) — documented extensibility,
// not an exact-key schema.
export function readTextFile(p) {
  try { return { ok: true, value: readFileSync(p, 'utf8').trim() }; }
  catch (e) { return e.code === 'ENOENT' ? { ok: false, kind: 'missing' } : { ok: false, kind: 'unreadable', error: encodeFsDetail(e) }; }
}

export function verifyStartupReadiness() {
  const dir = STARTUP_STATE_DIR;
  const requestIdRead = readTextFile(`${dir}/startup-request-id`);
  if (!requestIdRead.ok && requestIdRead.kind === 'unreadable') {
    logStartupEvent('startup-recovery-not-verified', { requestId: null, windowStart: null, detail: `unreadable-startup-request-id: ${requestIdRead.error}` });
    throw new StartupFailureError('unreadable-startup-request-id', null, null);
  }
  const requestId = requestIdRead.ok ? requestIdRead.value : null;
  // UUID validation BEFORE any use (Rev 4.8, chunk-14 review): the id is
  // interpolated into the canonical log line, so a file value containing
  // whitespace or a newline would break the line format — and equality with
  // the record's id proves nothing if both are malformed. A missing id fails
  // here, before the counter is read (precedence change vs Rev 4.7: a missing
  // id now fails before a counter failure is considered); an invalid id fails
  // with its own condition. Each failure is logged with requestId null — the
  // unvalidated value is never interpolated into a log line.
  if (requestId === null) {
    logStartupEvent('startup-recovery-not-verified', { requestId: null, windowStart: null, detail: 'missing-startup-request-id' });
    throw new StartupFailureError('missing-startup-request-id', null, null);
  }
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    logStartupEvent('startup-recovery-not-verified', { requestId: null, windowStart: null, detail: 'invalid-startup-request-id' });
    throw new StartupFailureError('invalid-startup-request-id', null, null);
  }
  const counter = readCounter();
  if (counter.code !== 0) {
    logStartupEvent('startup-recovery-not-verified', { requestId, windowStart: null, detail: `readiness-counter-unavailable-code-${counter.code}` });
    throw new StartupFailureError('readiness-counter-unavailable', requestId, null);
  }
  const { windowStart, attempts, generation } = counter.value;
  const fail = (condition) => { logStartupEvent('startup-recovery-not-verified', { requestId, windowStart, detail: condition }); throw new StartupFailureError(condition, requestId, windowStart); };
  const rawRead = readTextFile(`${dir}/readiness.json`);
  if (!rawRead.ok && rawRead.kind === 'unreadable') fail('unreadable-readiness-record');
  if (!rawRead.ok) fail('missing-readiness-record');
  const raw = rawRead.value;
  let record;
  try { record = JSON.parse(raw); } catch { fail('readiness-unparseable'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('readiness-not-an-object');
  if (typeof record.startupRequestId !== 'string' || typeof record.status !== 'string' || typeof record.bootId !== 'string' || typeof record.completedAt !== 'string') fail('readiness-missing-fields');
  // The record's id is validated under the same UUID rule before the equality
  // check (Rev 4.8, chunk-14 review): two equal but malformed ids must not
  // pass. Additional record fields are permitted and ignored (see the header
  // comment — the producer's documented field set).
  if (!UUID_RE.test(record.startupRequestId)) fail('readiness-startupRequestId-invalid');
  if (record.startupRequestId !== requestId) fail('wrong-startup-request-id');
  if (record.status !== 'ok') fail('readiness-status-not-ok');
  if (!isValidCalendarDate(record.completedAt)) fail('readiness-completedAt-invalid');
  const ageMs = Date.now() - Date.parse(record.completedAt);
  if (ageMs < 0) fail('readiness-completedAt-in-future');
  if (ageMs > 10 * 60 * 1000) fail('readiness-completedAt-stale');
  const bootIdRead = readTextFile('/proc/sys/kernel/random/boot_id');
  if (!bootIdRead.ok) fail('unreadable-boot-id');
  const bootId = bootIdRead.value;
  if (record.bootId !== bootId) fail('wrong-boot-id');
  return { requestId, windowStart, attempts, generation };
}

// The single exit-decision rule for EVERY startup failure (readiness, sweep, replay,
// reconcile, listen, factory). Renamed from Rev 4.4's decideValidationFailureExit because its
// scope is all startup failures, not only validation. The fresh counter read supplies
// the ATTEMPTS COUNT only; the event identity is ALWAYS the failing attempt's own
// identity (requestId/windowStart from the error — set by verifyStartupReadiness or
// attachStartupIdentity), never a field of the fresh read. Never throws: on any
// counter-read failure it logs startup-recovery-counter-unavailable and returns 42
// (fail-closed — no restart without accounting).
// Identity-pair proof — CORRECTED (Rev 4.8, chunk-16 review): the chunk-15
// claim that a window change is IMPOSSIBLE on this path was overstated, and
// is withdrawn. The event identity does NOT depend on it: the limit-reached
// event carries the failing attempt's own identity pair (requestId/windowStart
// from the error — set by verifyStartupReadiness or attachStartupIdentity),
// never a field of the fresh read, so the correlation is the failing
// attempt's by construction. What the proof DOES establish is stated in
// three parts:
//   (A) No NEW supervisor activation can be TRIGGERED while this API process
//   is active. The supervisor has exactly four activation routes, and every
//   one runs the same script (retry-startup.sh), whose step-(2) is-active
//   check precedes any counter access: (1) OnFailure= on
//   nova-startup-id.service — fires only when the preparation unit fails,
//   and preparation runs only as part of a chain start job, which does not
//   run while the API unit is active (a start request for an already-active
//   unit is a no-op — the same systemd singleton rule the design states for
//   the retry unit, §14 case (i)); (2) OnFailure= on
//   nova-storage-recovery.service — the same, for the recovery unit,
//   including its dependency failure when preparation fails (the two-trigger
//   case, §14 gap (a)); the API unit itself carries NO OnFailure=, so no
//   API failure can trigger the supervisor; (3) the re-arm transient timer
//   (systemd-run --on-active=5s), scheduled by a supervisor in its step (9)
//   after its own exit; (4) a manual `systemctl start
//   nova-startup-retry.service` (operator). The retry unit has no Restart=,
//   no OnFailure= of its own, and no timer of its own. A supervisor
//   triggered by an earlier chain's failure sleeps 30 s (step (1)) before
//   its step-(2) check, so it normally observes whether a newer chain has
//   already succeeded. A supervisor invocation can therefore only be IN
//   FLIGHT while this process is active if it was triggered before the
//   process started.
//   (B) The ONE residual route, stated honestly: a supervisor that passed
//   its step-(2) is-active check before this process started — e.g. during
//   the recovery phase of this chain, when the API process does not exist
//   yet (the unit is still starting, so the is-active check passes) — can
//   reach its step-(4) new-window write after the process started, IF the
//   300 s window expired in between. That expiry is possible because the
//   window is 300 s while recovery alone may take up to 600 s: preparation
//   may count this attempt in a window already 299 s old, and the window
//   then expires during recovery. The gap between the step-(2) check and
//   the step-(4) write is bounded by the 10 s lock wait, so the write can
//   land at most ~10 s after the process started — inside this interval,
//   whose start (verifyStartupReadiness) runs milliseconds after process
//   start.
//   (C) Even on that route, the LIMIT event cannot mix identities, for two
//   independent reasons. First, the event carries the snapshot pair (above),
//   so a rolled window cannot change what the event correlates. Second, the
//   fresh read cannot show attempts >= 5 in a window that rolled during
//   this interval: a freshly written window starts at attempts 0, and
//   attempts grow ONLY via preparation (reserve writes a token only;
//   release does not increment; reset deletes the file) — and preparation
//   runs only as part of a chain start, which cannot occur while this unit
//   is active (the singleton rule in (A): a start request for an
//   already-active unit is a no-op, and a restart stops this process first,
//   ending the interval). So if the fresh read shows attempts >= 5, the
//   fresh window is the snapshot's window, and the count belongs to it.
//   The limit branch therefore fires only for the window the snapshot
//   already describes. (An operator hand-deletion mid-flight cannot produce
//   a mixed pair either: the fresh read then returns absent → the
//   counter-unavailable branch, not limit-reached.)
export function decideStartupFailureExit(error) {
  const requestId = error?.startupRequestId ?? null;
  const windowStart = error?.startupWindowStart ?? null;
  const read = readCounter();
  if (read.code !== 0) {
    logStartupEvent('startup-recovery-counter-unavailable', { requestId, windowStart, detail: `counter-code-${read.code}` });
    return STARTUP_RETRY_LIMIT_EXIT;
  }
  if (read.value.attempts >= LIMIT) {
    logStartupEvent('startup-recovery-limit-reached', { requestId, windowStart, detail: `attempts-${read.value.attempts}` });
    return STARTUP_RETRY_LIMIT_EXIT;
  }
  return 1;
}

// Identity-checked reset after a successful listen(). Takes the completing
// attempt's identity { requestId, windowStart, attempts, generation } — obtained
// once by verifyStartupReadiness() — and passes it to the counter CLI, which
// deletes the file ONLY when the stored state still belongs to that attempt
// (code 9, `reset-preserved`, otherwise). Spawns the counter CLI under flock —
// Node has no flock binding, so the lock is acquired by flock(1) (bounded wait,
// 10 s). Returns { ok: true } or { ok: false, reason, preserved? }. Never throws:
// a failure leaves the counter in place (conservative) and the caller logs it.
// The never-throws guarantee is established by the outer try/catch (Rev 4.8,
// chunk-15 review — Gap G Issue 2): argument construction and the spawnSync call
// are inside the try, and ANY throw — including a throw from reading a property
// of an exotic object (e.g. a throwing `flock.error.message` getter) — is caught
// and returned as { ok: false, reason: 'reset-attempt-counter-threw' }. That
// reason name is new: it is the only reason that means "the reset helper itself
// threw", distinct from every spawnSync-reported failure below.
// Result classification (correction (h), as corrected in Rev 4.7, F5-24,
// and Rev 4.9 §1; factored into the exported classifyFlockResult below,
// ChatGPT correction Defect 1): flock.error is checked FIRST — a spawn failure
// (`flock-spawn-failed`) and a spawn timeout (`flock-spawn-timeout`, the
// 15 s process timeout, ETIMEDOUT) are distinguished before any status
// check; the status-null check remains only as a defensive fallback. The
// reset invocation uses `flock --exclusive --timeout 10` WITHOUT
// `--verbose` (Rev 4.9 §1): on util-linux 2.39.3 `--verbose` writes its
// progress lines to STDOUT, which breaks the strict one-RESULT-line
// protocol below — so it stays off. Measured on this VM: without
// --verbose, flock(1) is SILENT on a --timeout expiry (exit 1, nothing on
// either stream). The counter CLI prints exactly one RESULT line on every
// path and always exits 0, so a non-zero flock exit with BOTH streams
// empty proves flock never ran the child — the lock was never acquired
// within the --timeout window — and that, and only that, is
// `lock-timeout`. The diagnostic-substring check
// (`timeout while waiting to get lock`, searched in both streams) is kept
// as a defence for flock versions that do print the timeout line. Any
// other non-zero flock exit is `flock-failed: <diagnostic>` with a
// bounded, whitespace-normalised diagnostic from both streams. The CLI's
// own RESULT codes (0 ok, 9 preserved, 4 `counter-internal-error`, any
// other non-zero `counter-reset-code-<n>`, no RESULT line
// `counter-no-result`). A non-zero flock exit is NEVER labelled
// `lock-timeout` unless the empty-streams proof or the diagnostic
// substring proves it, and a RESULT payload is NEVER parsed after a
// non-zero flock exit.
// RESULT protocol (Rev 4.8, chunk-15 review — Gap G Issue 1): the CLI contract
// promises exactly one physical `RESULT <code> <json>` line, so the consumer
// enforces it — stdout, after trimming trailing line terminators, must contain
// EXACTLY one line, that line must match `RESULT <code> <json>`, the JSON
// payload must parse, and the payload's `code` must equal the numeric prefix.
// Extra output, a missing line, a malformed line, malformed JSON, or a code
// mismatch are all `counter-no-result`: the producer/consumer contract is
// symmetrical — a producer that cannot produce exactly one valid RESULT line
// is indistinguishable, to this consumer, from a producer that produced none.
export function resetAttemptCounter(identity) {
  try {
    return resetAttemptCounterInner(identity);
  } catch {
    return { ok: false, reason: 'reset-attempt-counter-threw' };
  }
}

// Classify one spawnSync('flock', ...) result (Rev 4.9, ChatGPT correction
// Defect 1 — factored out of resetAttemptCounterInner so the classification
// is unit-testable without spawning flock). flock.error is checked FIRST —
// a spawn failure (`flock-spawn-failed`) and a spawn timeout
// (`flock-spawn-timeout`, the 15 s process timeout, ETIMEDOUT) are
// distinguished before any status check; the status-null check remains only
// as a defensive fallback (a null status with no error object means the
// flock child died by signal — name the signal, do not mislabel it a spawn
// timeout). A non-zero flock exit with BOTH streams empty proves flock
// never ran the child — the lock was never acquired within the --timeout
// window — and that, and only that, is `lock-timeout` (measured on this
// VM, util-linux 2.39.3: WITHOUT --verbose, flock(1) is SILENT on a
// --timeout expiry). The diagnostic-substring check (`timeout while waiting
// to get lock`, searched in both streams) is kept as a defence for flock
// versions that do print the timeout line. Any other non-zero flock exit
// is `flock-failed: <diagnostic>` with a bounded, whitespace-normalised
// diagnostic from both streams. Returns { ok: false, reason } on any
// flock-level failure, or null when flock exited 0 — the caller then
// parses the counter CLI's RESULT line. Never throws for a plain result
// object; a throwing property getter is caught by the resetAttemptCounter
// wrapper as `reset-attempt-counter-threw`, exactly as before.
export function classifyFlockResult(flock) {
  if (flock.error) {
    if (flock.error.code === 'ETIMEDOUT') return { ok: false, reason: 'flock-spawn-timeout' };
    return { ok: false, reason: `flock-spawn-failed: ${flock.error.message}` };
  }
  if (flock.status === null) {
    // Defensive: a null status with no error object. A genuine spawn
    // timeout is reported as ETIMEDOUT above, so a null status here means
    // the flock child died by signal (e.g. the unit's cgroup was stopped
    // mid-reset — READY=1 is sent before the reset runs, so a stop issued
    // the instant `systemctl start` returns can kill the flock child).
    // Name the signal; do not mislabel it a spawn timeout.
    return { ok: false, reason: flock.signal ? `flock-killed-by-signal-${flock.signal}` : 'flock-spawn-timeout' };
  }
  if (flock.status !== 0) {
    // Rev 4.9 §1 (measured on this VM, util-linux 2.39.3): WITHOUT
    // --verbose, flock(1) is SILENT on a --timeout expiry — it exits 1
    // with nothing on either stream. (With --verbose the diagnostic
    // `flock: timeout while waiting to get lock` appears on stderr, but
    // --verbose also writes progress lines to STDOUT on the success path,
    // which breaks the strict one-RESULT-line protocol below — so it stays
    // off.) The counter CLI prints exactly one RESULT line on every path
    // and always exits 0, so a non-zero flock exit with BOTH streams empty
    // proves flock never ran the child: the lock was never acquired within
    // the --timeout window. That, and only that, is `lock-timeout`. The
    // diagnostic-substring check is kept as a defence for flock versions
    // that do print the timeout line. Any other non-zero flock exit is
    // `flock-failed: <diagnostic>` with a bounded, whitespace-normalised
    // diagnostic from both streams.
    const diagnostic = `${String(flock.stdout ?? '')}\n${String(flock.stderr ?? '')}`;
    if (diagnostic.trim() === '') return { ok: false, reason: 'lock-timeout' };
    if (/timeout while waiting to get lock/i.test(diagnostic)) return { ok: false, reason: 'lock-timeout' };
    const detail = diagnostic.replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: false, reason: `flock-failed: ${detail || `exit-${flock.status}`}` };
  }
  return null;
}

function resetAttemptCounterInner(identity) {
  const args = ['--exclusive', '--timeout', '10', LOCK_PATH, 'node', COUNTER_CLI, 'reset',
    identity?.requestId ?? '', identity?.windowStart ?? '', String(identity?.attempts ?? ''), identity?.generation ?? ''];
  const flock = spawnSync('flock', args, { encoding: 'utf8', timeout: 15000 });
  const classified = classifyFlockResult(flock);
  if (classified) return classified;
  const text = String(flock.stdout || '').trimEnd();
  if (text === '' || text.includes('\n') || text.includes('\r')) return { ok: false, reason: 'counter-no-result' };
  const m = text.match(/^RESULT (\d+) (.*)$/);
  if (!m) return { ok: false, reason: 'counter-no-result' };
  let payload;
  try { payload = JSON.parse(m[2]); } catch { return { ok: false, reason: 'counter-no-result' }; }
  if (!payload || typeof payload !== 'object' || payload.code !== Number(m[1])) return { ok: false, reason: 'counter-no-result' };
  if (m[1] === '0') return { ok: true };
  if (m[1] === '9') return { ok: false, reason: 'reset-preserved', preserved: true };
  if (m[1] === '4') return { ok: false, reason: 'counter-internal-error' };
  return { ok: false, reason: `counter-reset-code-${m[1]}` };
}
