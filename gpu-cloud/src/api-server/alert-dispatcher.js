// alert-dispatcher.js — email dispatch for the startup operator-alert events.
// Six families (the Rev 4.3/4.4 verdicts' "six events" are these six families).
// ONE canonical event-name registry (Rev 4.8, F5-41): ALERT_EVENTS (TWENTY-TWO
// concrete event names — Rev 4.6 adds startup-preparation-limit-reached, Rev 4.8
// adds startup-factory-failed AND the two supervisor counter events
// startup-retry-counter-unavailable / startup-retry-counter-malformed, which
// the supervisor script logs but which were missing from the registry in
// Rev 4.7; Rev 4.9 adds startup-service-ready-notify-failed (§5) and
// storage-runner-heartbeat-outage (F-6a)) plus JOURNAL_ONLY_EVENTS (TWO names —
// startup-recovery-reset-preserved, startup-recovery-counter-unwritable),
// combined as EVENT_REGISTRY (TWENTY-FOUR names). The dispatcher keys on the concrete
// event name, so names within a family never collide. parseEventLine accepts any
// name in EVENT_REGISTRY; dispatchAlert emails ONLY ALERT_EVENTS names and
// returns { sent: false, reason: 'journal-only', pending: false } for a
// journal-only name without invoking the transport and without writing a dedup
// or pending entry; an unregistered name is rejected explicitly (parse returns
// { ok: false, reason: 'unregistered-event' }). A producer log line existing is not proof the alert system accepts it —
// test (t) proves every registered name through the actual parser and dispatcher.
// Takes a transport (default: resolveAlertTransport() — the outside SMTP
// service when configured, else host sendmail); unit tests pass a stub transport.
// Persistent state (all under /var/lib/nova-api/, all written atomically —
// temp file in the same directory + rename; see writeStateFileAtomic):
//   alert-dedup.json   { "<event>:<windowStart|requestId>": { "sentAt": "<ISO-8601 UTC>", "requestId": "<uuid>|null" } }
//   alert-pending.json { "<pending-key>": { event, windowStart, requestId, ts, detail, firstSeen, attempts, lastAttempt } }
//     — the pending key is the dedup key for dedupeable events, and
//     "<event>:unknown-scope:<uuid>" for undedupeable events (one key per
//     occurrence, F5-14), so two identifier-less occurrences never collide.
// An entry is written to the dedup state ONLY after the transport reports success.
// A failed delivery leaves NO dedup entry AND writes the event into the pending file,
// so the next health-check probe retries it (Blocker 3). Entries older than 7 days
// are pruned on each write (bounded files). Pending entries older than 7 days are
// dropped (logged as alert-pending-expired) — an alert that cannot be delivered in
// a week is stale, and the operator is told, not left guessing.
// The literal sentinel "none" is normalised to null at PARSE time (Blocker 5):
// parseEventLine maps windowStart=none / requestId=none to null, so the dedup key
// falls back correctly. An event with NEITHER identifier is undedupeable (see
// dispatchAlert): it is delivered every time, never deduped, and logged.
//
// Delivery guarantee (Rev 4.7, F5-04/F5-11, F5-05): AT-LEAST-ONCE per dedup key
// while its dedup entry is retained (7-day pruning). Email acceptance followed
// by a crash before the dedup write (or a dedup-write failure) can produce a
// duplicate on retry; duplicates are the fail-safe direction for an alert
// system. The old "one delivery per key, ever" wording is withdrawn.
//
// Concurrency (Rev 4.7, F5-27; Rev 4.8, F5-29): the per-key in-process chain
// below serialises the check-send-write sequence for ONE key inside one process.
// The per-file TRANSACTION LOCK — withStateFileLock(path, fn) — covers the COMPLETE
// load-modify-save transaction for every writer of a state file (dispatch,
// retry, requeue, the probe's scan-loop writes, the requeue CLI): the mutation
// re-loads the file FRESH inside the lock, applies, and saves, so a later
// writer can never overwrite an earlier writer's update with a stale snapshot.
// The lock serialises STATE MUTATIONS across processes and keys — NOT the send:
// the send (network I/O) stays OUTSIDE the lock, so two processes can both send
// the same alert (each saw no dedup entry); the in-lock re-check in dispatchOnce
// prevents a second dedup ENTRY, not a second send — duplicates are at-least-once.
// One mechanism, not two: a synchronous cross-process kernel flock on a
// per-file lock file (<path>.lock), held continuously from acquisition through
// the commit — a suspended holder still holds the lock, so no expired holder
// can commit after a new holder; on holder death the kernel releases the lock
// automatically; no staleness rule, no steal path, no token; fail-fast
// acquisition — a single non-blocking attempt, and if the lock is held a
// lock-failure result immediately, never a silent drop (the API event loop is
// never blocked waiting for the lock). A lock-file open failure is
// a distinct result ('state-lock-unavailable'), never mistaken for contention. The per-key chain above is SEPARATE (same-key, one process), not
// part of the lock. The probe wrapper's flock still serialises probe runs; the
// transaction lock is the common boundary that ALSO covers the requeue CLI and
// direct dispatcher invocations. dispatchAlert is therefore ASYNC; callers must
// await it. The chain entry for a key is always a settled promise, so a later
// caller never inherits an earlier caller's failure as a rejection of its own
// queue step.
//
// sendmail resolution (Rev 4.7, F5-01): ONE policy, PATH-only, implemented in
// Node itself. resolveSendmailPath() walks process.env.PATH and returns the
// first entry that is an executable file named "sendmail" (statSync + X_OK).
// No shell, no `command` builtin (it cannot be spawned), no hardcoded path.
// The install check runs THIS function against the installed module, so install
// check, runtime and tests agree by construction. A sendmail present only at
// /usr/sbin/sendmail with /usr/sbin NOT on the API unit's PATH is NOT installed:
// the operator must put the MTA's bin directory on the unit's PATH. The
// target-host PATH used by the tests is the API unit's effective PATH, recorded
// in the implementation report. The result is cached per process (the probe is
// short-lived, so the cache cannot go stale across an install).
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'; // (Rev 4.8, chunk-13 review — Gap 1, Finding 2: existsSync is gone; the read IS the existence test)
import net from 'node:net';
import tls from 'node:tls';
import { flockExNb, flockUn } from './flock-binding.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isValidCalendarDate, encodeFsDetail } from './startup-counter.mjs';

export const ALERT_EVENTS = [
  // Preparation family
  'startup-preparation-counter-unreadable', // counter unreadable (incl. lock timeout)
  'startup-preparation-counter-malformed',  // counter unparseable or invalid
  'startup-preparation-counter-unwritable', // counter write failed
  'startup-preparation-limit-reached',      // preparation refused: attempts >= 5 (Rev 4.6)
  // Recovery family
  'startup-recovery-failed',   // recovery pass failed (record status: failed)
  'startup-recovery-timeout',  // recovery exceeded 600 s (observed by the supervisor)
  // Validation family — every API-process pre-listen failure
  'startup-recovery-not-verified', // readiness record fails a condition
  'startup-sweep-failed',          // API startup sweep threw
  'startup-replay-failed',         // pending-mutation replay threw
  'startup-reconcile-failed',      // API startup reconciliation threw
  'startup-listen-failed',         // server.listen errored
  'startup-service-ready-notify-failed', // API listen succeeded but the systemd READY=1 notification failed (Rev 4.9 §5) — the listener is closed and startup fails; never mislabelled as startup-recovery-succeeded
  'startup-factory-failed',        // createApiServer() threw before start() (Rev 4.8, F5-43)
  // Limit family (grouped by operator treatment — see the counter-unavailable note below)
  'startup-retry-limit-reached',        // supervisor refused: attempts >= 5
  'startup-recovery-limit-reached',     // API exit 42 at the limit
  'startup-recovery-counter-unavailable', // API exit path: counter lost — shares the Limit family by operator treatment (exit 42, no restart, same reset procedure), not by evidence: the alert names the actual event, so it never claims the limit was reached (Rev 4.8, chunk-17 review; see §14 alert table)
  // Supervisor family
  'startup-retry-slot-reserved', // supervisor refused: reservation already held
  'startup-retry-start-failed',  // supervisor's start call failed; reservation released only if still held — step (7) releases it only when preparation never ran (start refused before any chain attempt)
  'startup-retry-counter-unavailable', // supervisor found the counter absent/unreadable (Rev 4.8, F5-41 — producer event, was missing from the registry)
  'startup-retry-counter-malformed',   // supervisor found the counter unparseable/invalid (Rev 4.8, F5-41 — producer event, was missing from the registry)
  // Recovery-success family
  'startup-recovery-succeeded', // API listening (emitted once, at listen())
  // Storage-runner health family (Rev 4.9, F-6a): the standing health
  // check's 5-minute heartbeat watch. A stale, missing, or failed runner
  // heartbeat is an outage — the operator alert fires (dedup-bounded by
  // the heartbeat's lastSuccessfulSweepAt, or one per day when missing)
  // and the API refuses new submits until a sweep succeeds.
  'storage-runner-heartbeat-outage', // runner heartbeat stale/missing/failed (probe heartbeat watch)
];
// Journal-only events (Rev 4.8, F5-41): registered in the canonical registry
// and parsed by parseEventLine, but NEVER emailed — the dispatcher returns
// { sent: false, reason: 'journal-only', pending: false } for them without
// invoking the transport and without writing a dedup or pending entry.
//   startup-recovery-reset-preserved — info: a reset was skipped because a
//     newer attempt's state survived. Self-healing (that attempt resets on its
//     own listen); no operator action exists, so emailing would alert on a
//     correct outcome.
//   startup-recovery-counter-unwritable — error: the post-listen counter reset
//     failed (lock timeout, spawn failure, unlink failure) while the API IS
//     listening. The counter is left in place conservatively; the next startup
//     failure in the same window alerts on the counter state (limit /
//     unavailable) if it matters. Operator-review signal in the journal; the
//     implementation report must show it is observable there.
export const JOURNAL_ONLY_EVENTS = [
  'startup-recovery-reset-preserved',
  'startup-recovery-counter-unwritable',
];
// THE canonical event-name registry (Rev 4.8, F5-41; Rev 4.9 adds two names):
// every event any producer can emit is exactly one of these twenty-four names. parseEventLine accepts only
// these names; anything else is rejected explicitly (parse returns { ok: false, reason: 'unregistered-event' }).
export const EVENT_REGISTRY = [...ALERT_EVENTS, ...JOURNAL_ONLY_EVENTS];
// UUID validation (Rev 4.8, chunk-11 review): RFC 4122 version 4, matching the
// generator — every UUID in this design is produced by node crypto.randomUUID().
// The third group must start with 4 (version) and the fourth with 8/9/a/b
// (variant); the all-zero value and any non-v4 version are rejected. Shape-only
// hex is NOT accepted: these identifiers are ownership tokens (reservation)
// and ABA guards (generation), and requestId is a cycle identity, so a
// hand-edited or corrupt hex-shaped value must fail validation. The same
// expression validates reservation, generation, and requestId in both modules
// that check a UUID (this module and startup-counter.mjs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEDUP_PATH = '/var/lib/nova-api/alert-dedup.json';
export const PENDING_PATH = '/var/lib/nova-api/alert-pending.json';
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ALERT_RECIPIENT = 'omoyenishina2000@gmail.com'; // owner decision 27 Nov 2026 (OQ-1 destination): alerts go to the owner's Gmail, not the business address

// The literal sentinel "none" is not an identifier. Normalise it to null at the
// single point where parsed fields are produced, so every consumer below (dedup
// key, subject, body) sees real values or null — never the string "none".
function normaliseScopeValue(v) { return (v === null || v === undefined || v === 'none') ? null : v; }

export function dedupKey(eventName, { windowStart, requestId }) {
  const scope = normaliseScopeValue(windowStart) ?? normaliseScopeValue(requestId);
  if (!scope) throw new Error(`alert-dispatcher: no dedup scope for ${eventName}`);
  return `${eventName}:${scope}`;
}

// The pending key for one occurrence (F5-14): the dedup key for dedupeable
// events; a unique key per occurrence for undedupeable events (a fresh UUID at
// queue time), so two identifier-less occurrences never overwrite each other.
export function pendingKey(parsed) {
  const windowStart = normaliseScopeValue(parsed.windowStart);
  const requestId = normaliseScopeValue(parsed.requestId);
  if (!windowStart && !requestId) return `${parsed.event}:unknown-scope:${randomUUID()}`;
  return dedupKey(parsed.event, { windowStart, requestId });
}

// Parses one canonical log line (see §10). Tokenize-first parser (Rev 4.8
// correction, chunk-3 review; classification refined in the follow-up correction):
// the stripped line is split on spaces into key=value tokens. Phase 1 tokenizes:
// a token without '=' is malformed; a duplicate key is malformed; a tab or other
// control-whitespace character anywhere in the line is malformed (ASCII space is the
// only permitted token separator). Phase 1 failures
// carry NO event name (event: null) — the line is corrupt at the token level, so
// no event identity can be established, and the probe never logs such a line as a
// malformed known event. Phase 2 establishes event identity FIRST: the event field
// must be present exactly once; an absent event field is malformed with event: null;
// a present-but-unregistered event returns { ok: false, reason: 'unregistered-event' }
// and is silently skipped. Only once the event is KNOWN (registered) does the parser
// check the other mandatory fields and validate values — so a 'malformed' result
// with a non-null event ALWAYS names a registered event, and the probe logs
// health-check-malformed-event-line only when result.event is non-null. The
// mandatory fields are ts, level, event, requestId, windowStart, detail — all six
// must be present (requestId/windowStart may be the literal 'none' — explicit,
// never inferred from a missing field). The old regexes matched `event=` embedded
// inside another token and took the first occurrence without rejecting duplicates;
// tokenization enforces complete space-delimited field boundaries. The field
// dictionary is a null-prototype object (Object.create(null)), so duplicate
// detection uses only parsed keys and '__proto__' cannot pollute a prototype.
// Unknown fields: EXTENSIBLE schema — additional key=value fields are permitted and
// ignored; exact-key matching means they cannot alter the interpretation of a
// canonical field, and a real alert is never lost because a producer added a
// diagnostic field. Empty values: only detail= may be empty (free text; the alert
// still flows — an empty detail is a producer quality issue visible in the delivered
// email, not a parse failure); an empty ts, level, requestId or windowStart fails
// that field's validation as before. The first '=' in a token separates key from
// value; values may contain '='. Returns a discriminated result: { ok: true, parsed }
// on success; { ok: false, reason: 'not-an-event-line' } when the line does not
// start with ts= (not a canonical line at all); { ok: false, reason:
// 'unregistered-event', event } when event= names an event outside EVENT_REGISTRY;
// { ok: false, reason: 'malformed', detail, event } otherwise (event non-null
// exactly when the event is registered).
// Prefix tolerance (Rev 4.8, F5-39): the API process's console logging prepends
// the shipped '[api-server] ' tag; the parser strips exactly that prefix — and
// nothing else — before tokenizing, then requires the stripped line to start with
// 'ts=' (the canonical format begins with ts=). A line with any other leading
// content is rejected. Names are accepted only from EVENT_REGISTRY (Rev 4.8,
// F5-41): an unregistered name is rejected explicitly, never silently accepted.
// Field values are validated after tokenization: ts must pass the strict calendar
// check; level must be one of info|warn|error; windowStart, when not 'none',
// must pass the strict calendar check; requestId, when not 'none', must match
// UUID_RE. Both scope fields are normalised here: windowStart=none /
// requestId=none become null.
export function parseEventLine(line) {
  const stripped = line.startsWith('[api-server] ') ? line.slice('[api-server] '.length) : line;
  if (!stripped.startsWith('ts=')) return { ok: false, reason: 'not-an-event-line' };
  if (/[\t\n\v\f\r]/.test(stripped)) return { ok: false, reason: 'malformed', detail: 'control-whitespace', event: null };
  const fields = Object.create(null);
  for (const token of stripped.split(' ')) {
    const eq = token.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed', detail: 'malformed-token', event: null };
    const key = token.slice(0, eq);
    if (key in fields) return { ok: false, reason: 'malformed', detail: 'duplicate-key', event: null };
    fields[key] = token.slice(eq + 1);
  }
  if (!('event' in fields)) return { ok: false, reason: 'malformed', detail: 'missing-event', event: null };
  if (!EVENT_REGISTRY.includes(fields.event)) return { ok: false, reason: 'unregistered-event', event: fields.event };
  const event = fields.event;
  for (const required of ['ts', 'level', 'requestId', 'windowStart', 'detail']) {
    if (!(required in fields)) return { ok: false, reason: 'malformed', detail: `missing-${required}`, event };
  }
  const ts = fields.ts;
  const level = fields.level;
  const requestId = normaliseScopeValue(fields.requestId);
  const windowStart = normaliseScopeValue(fields.windowStart);
  if (!isValidCalendarDate(ts)) return { ok: false, reason: 'malformed', detail: 'invalid-ts', event };
  if (level !== 'info' && level !== 'warn' && level !== 'error') return { ok: false, reason: 'malformed', detail: 'invalid-level', event };
  if (windowStart !== null && !isValidCalendarDate(windowStart)) return { ok: false, reason: 'malformed', detail: 'invalid-windowStart', event };
  if (requestId !== null && !UUID_RE.test(requestId)) return { ok: false, reason: 'malformed', detail: 'invalid-requestId', event };
  return { ok: true, parsed: { event, requestId, windowStart, ts, detail: fields.detail } };
}

// Atomic state write (Blocker 4): temp file in the SAME directory (same filesystem)
// with a UNIQUE name (PID + UUID — Rev 4.8, F5-29: two writers must never share
// a temp name), then rename — a reader never sees a torn file. Crash durability
// beyond atomic visibility is explicitly NOT claimed (no fsync): a power loss
// may lose the last write, which degrades to a possible duplicate alert
// (fail-safe for an alert system) or a checkpoint rewind of one scan window.
// On failure the unique temp file is removed in a finally (best-effort unlink —
// the PID+UUID name belongs to this writer alone, so cleanup can never delete
// another writer's temp file).
// Exported ONLY because the probe's checkpoint write needs it (health-check.js
// imports it for STATE_PATH — the scan cursor, not a protected state file).
// The two PROTECTED state files (DEDUP_PATH, PENDING_PATH) are written ONLY
// through updateDedupState / updatePendingState inside the lock — no caller
// may write them directly (the only call sites naming those paths are inside
// the two update functions below). The checkpoint file is written ONLY by the
// probe (a single writer, serialised by the probe wrapper's flock), so it
// needs no transaction lock; its atomic write still guarantees no torn file.
export function writeStateFileAtomic(path, value) {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) { try { unlinkSync(tmp); } catch { /* best-effort cleanup of our own temp file */ } }
  }
}

// Per-file transaction lock (Rev 4.8, F5-29; flock rework after the chunk-4 review):
// covers the COMPLETE load-modify-save transaction for one state file, for ALL
// writers (dispatch, retry, requeue, the probe's scan-loop writes, the requeue
// CLI, direct dispatcher invocations). One mechanism, not two: a kernel flock(2)
// on a per-file lock file (<path>.lock), held CONTINUOUSLY from acquisition
// through the commit (rename). The flock IS the fencing: a holder suspended
// mid-transaction still holds the lock, so no other writer can acquire it and
// no expired holder can commit after a new holder — there is NO staleness rule,
// NO steal path, NO token, and NO check-then-act gap between any ownership
// check and the rename (the earlier mkdir-based design was replaced because
// its save-time ownership check could not fence the rename: a holder suspended
// after the check could have its lock stolen under the 60 s stale rule and then
// rename over the new holder's committed state — a genuine lost update).
// On holder death the kernel releases the lock automatically. A mutation is
// synchronous, so a holder can never block the event loop while holding the
// lock; fn() MUST be synchronous and short — local file I/O only, no awaits,
// no transport calls. Acquisition is FAIL-FAST: a single non-blocking attempt
// — if the lock is held, a lock-failure result immediately. The API event loop
// is never blocked waiting for the lock (no Atomics.wait, no polling, no wait
// budget): a contended transaction fails fast and its caller handles the
// failure through the existing lock-failure results, never a silent drop.
// The flock is acquired through a native binding exposing flock(2). Required
// binding interface (the binding is a new dependency of the dispatcher module,
// `flock-binding.mjs` in the same directory — a thin native addon, not part of
// Node itself): flockExNb(fd) attempts LOCK_EX | LOCK_NB and returns true on
// success, false when the lock is held (EWOULDBLOCK), and throws on any other
// failure; flockUn(fd) releases with LOCK_UN and throws on failure. The install
// check MUST prove the binding works on the target host before the dispatcher
// is installed: acquire the lock, assert a contended acquisition returns the
// timeout result immediately (fail-fast), release, assert acquisition succeeds
// again, and kill a holder process and
// assert the lock is then acquirable (kernel release on death). If the binding
// is unavailable or any step fails, the dispatcher is NOT installed
// (fail-closed) — a dispatcher that cannot lock must never run. The lock file
// is created on first use (open with append mode — never truncated); its
// contents are irrelevant and never read. (flock(1) cannot serve here: it holds
// the lock only for the subprocess it runs, not across a synchronous in-process
// critical section — which is why this lock needs the native binding, unlike the
// counter CLI in §14, which spawns flock(1) around a whole CLI invocation.)
// withStateFileLock must never be nested on the same path: flock treats a
// second open file description (even in the same process) as a separate lock
// requester, so a nested acquisition blocks until the timeout. No caller
// nests it.
// A mutation MUST go through updateDedupState / updatePendingState (which
// re-load the file FRESH inside the lock, apply, and save) — never load once
// outside the lock and save a stale snapshot. Reads (loadDedupState /
// loadPendingState) need no lock: atomic rename gives a complete snapshot.
// The probe wrapper's flock still serialises probe runs; the transaction lock
// is the common boundary that ALSO covers the requeue CLI and direct
// dispatcher invocations.
function lockFileFor(path) { return `${path}.lock`; }

// Acquires the per-file flock with a SINGLE non-blocking attempt (fail-fast).
// Returns the open fd (the lock handle) on success, null when the lock is held
// at the instant of the attempt. There is NO wait: the acquisition never blocks
// the API event loop (no Atomics.wait, no polling loop) — a contended caller
// receives { ok: false, reason: 'state-lock-timeout' } at once and handles it
// through the existing lock-failure paths. 'state-lock-timeout' therefore means
// 'lock held at the instant of the attempt', not 'waited and gave up'. A
// lock-file OPEN failure is a distinct outcome — the caller reports
// 'state-lock-unavailable', never a timeout — so a disk-full or permission
// problem is never mistaken for contention. Any other throw (e.g. a binding
// failure) propagates: the install check proves the binding works, so this is
// a hard failure, not a lock outcome. The fd is closed whenever it was not
// acquired, so no path leaks it.
function acquireStateFileLock(path) {
  let fd;
  try { fd = openSync(lockFileFor(path), 'a'); }
  catch (e) { const err = new Error(`lock file ${lockFileFor(path)} could not be opened: ${encodeFsDetail(e)}`); err.code = 'STATE_LOCK_UNAVAILABLE'; throw err; }
  let acquired = false;
  try {
    acquired = flockExNb(fd);
  } finally {
    if (!acquired) { try { closeSync(fd); } catch { /* best-effort close of an unacquired fd */ } }
  }
  return acquired ? fd : null;
}

// Releases the lock: unlock, then close the fd (closing alone releases the
// lock). Returns true when both steps succeeded, false when either failed —
// both steps are always attempted, so a failed unlock never skips the close.
// A failed release is diagnosed by the caller: a lock that stays held until
// process exit would otherwise cause repeated timeouts with no diagnostic.
function releaseStateFileLock(fd) {
  let ok = true;
  try { flockUn(fd); } catch { ok = false; }
  try { closeSync(fd); } catch { ok = false; }
  return ok;
}

// Runs fn() with the per-file transaction lock held. fn() MUST be synchronous.
// Returns { ok: true, value }, { ok: false, reason: 'state-lock-timeout' }, or
// { ok: false, reason: 'state-lock-unavailable' } (the lock file could not be
// opened — a disk or permission failure, not contention). There is NO
// 'state-lock-lost': a live holder cannot lose the lock — the flock is held
// continuously through the commit, and only the kernel releases it (on holder
// death). A throw from fn() propagates after the lock is released. A release
// failure is logged as `alert-state-lock-release-failed` (error), best-effort —
// the emission is wrapped in try/catch so a logging failure can never replace
// the transaction's own outcome (its value, or its thrown error), which is
// preserved unchanged. The detail is the path with whitespace encoded as
// dashes (the same encoding the probe's log lines use for error details), so
// the line always parses as a single token.
export function withStateFileLock(path, fn) {
  let fd;
  try { fd = acquireStateFileLock(path); }
  catch (e) {
    if (e && e.code === 'STATE_LOCK_UNAVAILABLE') return { ok: false, reason: 'state-lock-unavailable' };
    throw e;
  }
  if (fd === null) return { ok: false, reason: 'state-lock-timeout' };
  let failed = false;
  let thrown;
  let result;
  try { result = { ok: true, value: fn() }; }
  catch (e) { failed = true; thrown = e; }
  if (!releaseStateFileLock(fd)) {
    try { console.error(`ts=${new Date().toISOString()} level=error event=alert-state-lock-release-failed requestId=none windowStart=none detail=${path.replace(/\s+/g, '-')}`); } catch { /* best-effort diagnostic: a logging failure must never alter the transaction outcome */ }
  }
  if (failed) throw thrown;
  return result;
}

// The ONLY way to mutate a state file: re-load FRESH inside the transaction
// lock, apply the mutation, prune (dedup only), and save atomically. A caller
// that loaded state before the lock must never save it afterwards. No ownership
// re-check before the write is needed or present: the held flock IS the
// guarantee — no other writer can hold the lock while this transaction runs,
// so the save cannot overwrite a newer snapshot.
export function updateDedupState(mutator) {
  return withStateFileLock(DEDUP_PATH, () => {
    const state = loadDedupState();
    mutator(state);
    const pruned = {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state)) if (Date.parse(v.sentAt) > cutoff) pruned[k] = v;
    writeStateFileAtomic(DEDUP_PATH, pruned);
    return pruned;
  });
}

export function updatePendingState(mutator) {
  return withStateFileLock(PENDING_PATH, () => {
    const state = loadPendingState();
    mutator(state);
    writeStateFileAtomic(PENDING_PATH, state);
    return state;
  });
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// State-file schema validators (Rev 4.7, F5-08). A file that parses as JSON but
// has the wrong shape is quarantined exactly like a syntax failure — never
// accepted as the fallback's shape.
export function validateDedupState(value) {
  if (!isPlainObject(value)) return false;
  for (const entry of Object.values(value)) {
    if (!isPlainObject(entry)) return false;
    // Exact schema (Rev 4.8, chunk-13 review — Gap 1, Finding 4): a dedup
    // entry is exactly { sentAt, requestId } — like validateCounter, which
    // requires exactly four keys. An entry with any extra field is malformed
    // and the file is quarantined, never silently accepted.
    if (Object.keys(entry).sort().join(',') !== 'requestId,sentAt') return false;
    if (typeof entry.sentAt !== 'string' || !isValidCalendarDate(entry.sentAt)) return false;
    if (entry.requestId !== null && (typeof entry.requestId !== 'string' || !UUID_RE.test(entry.requestId))) return false;
  }
  return true;
}

function validatePendingEntry(entry, { allowJournalOnly = false } = {}) {
  if (!isPlainObject(entry)) return false;
  // Exact schema (Rev 4.8, chunk-13 review — Gap 1, Finding 4): a pending
  // entry is exactly the eight fields below. Extra fields are malformed.
  // `attempts` is intentionally UNBOUNDED (no upper limit): a pending entry
  // is retried until it delivers or expires — the bound is the 7-day
  // retention (PENDING_MAX_AGE_MS), not an attempts ceiling — so a large
  // attempts count is valid; only a negative or non-integer one is malformed
  // (see §15 test (y)).
  // Event membership (Rev 4.9 O-1 / Defect 2): the STRICT default accepts
  // only ALERT_EVENTS — requeuePending() relies on it to reject new
  // journal-only entries. The persisted-state validator passes
  // { allowJournalOnly: true } so a legacy journal-only entry already in
  // the pending file is RECOGNISED (not a whole-file validation failure),
  // letting retryPending() remove it individually instead of the loader
  // returning the fallback empty object and the cleanup never running.
  if (Object.keys(entry).sort().join(',') !== 'attempts,detail,event,firstSeen,lastAttempt,requestId,ts,windowStart') return false;
  const allowed = allowJournalOnly
    ? [...ALERT_EVENTS, ...JOURNAL_ONLY_EVENTS]
    : ALERT_EVENTS;
  if (!allowed.includes(entry.event)) return false;
  if (entry.windowStart !== null && (typeof entry.windowStart !== 'string' || !isValidCalendarDate(entry.windowStart))) return false;
  if (entry.requestId !== null && (typeof entry.requestId !== 'string' || !UUID_RE.test(entry.requestId))) return false;
  if (entry.ts !== null && (typeof entry.ts !== 'string' || !isValidCalendarDate(entry.ts))) return false;
  if (entry.detail !== null && typeof entry.detail !== 'string') return false;
  if (typeof entry.firstSeen !== 'string' || !isValidCalendarDate(entry.firstSeen)) return false;
  if (!Number.isInteger(entry.attempts) || entry.attempts < 0) return false;
  if (entry.lastAttempt !== null && (typeof entry.lastAttempt !== 'string' || !isValidCalendarDate(entry.lastAttempt))) return false;
  return true;
}

export function validatePendingState(value) {
  if (!isPlainObject(value)) return false;
  for (const entry of Object.values(value)) if (!validatePendingEntry(entry, { allowJournalOnly: true })) return false;
  return true;
}

export function validateCheckpointState(value) {
  if (!isPlainObject(value)) return false;
  // Exact schema (Rev 4.8, chunk-13 review — Gap 1, Finding 4): the
  // checkpoint is exactly { lastScan } — any extra top-level field is malformed.
  if (Object.keys(value).sort().join(',') !== 'lastScan') return false;
  if (value.lastScan !== null && (typeof value.lastScan !== 'string' || !isValidCalendarDate(value.lastScan))) return false;
  return true;
}

// Load a JSON state file. Read and parse are classified SEPARATELY (Rev 4.8,
// chunk-13 review — Gap 1, Findings 2–3):
// - Missing file (ENOENT — including a file that vanishes between any check
//   and the read; there is NO existsSync pre-check, the read IS the
//   existence test, so the check-then-read race is gone) → the fallback.
// - Any OTHER read error (permission, I/O) → THROW. A read failure is not
//   corruption: the file may be perfectly valid but unreadable, and it must
//   never be misclassified as corrupt and silently replaced by the fallback.
// - Parse failure, or — when a validator is given — a valid JSON value with
//   the wrong shape → corrupt: QUARANTINED (renamed to
//   <path>.corrupt-<ISO timestamp>, never deleted) and logged as
//   alert-state-corrupt, and the fallback is returned — state is never
//   silently reset without a log line. For the dedup state the fallback is
//   {} (fail-open toward alerting: duplicates possible, loss impossible).
// Quarantine is a MUTATION (it renames the file) and runs ONLY when the
// caller holds the per-file transaction lock (withStateFileLock) —
// `quarantine: true` (the default), used by updateDedupState /
// updatePendingState, which load FRESH inside the lock. An UNLOCKED reader
// loads with `{ quarantine: false }` (the dedup lookup in dispatchOnce, the
// retryPending snapshot loads): a corrupt file is then returned as the
// fallback with the alert-state-corrupt log line but the file is LEFT IN
// PLACE — an unlocked reader can never rename a NEWER valid file that the
// atomic writer wrote after the corrupt read. The next locked load
// quarantines the file it actually read. (loadCheckpoint does NOT use this
// loader at all: it has its own read/parse split and quarantineCheckpoint —
// the chunk-7 correction — so the checkpoint path was never exposed to the
// generic loader's swallow; see health-check.js.)
export function loadStateFile(path, fallback, validate, { quarantine = true } = {}) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw e; // read failure (permission, I/O) — not corruption, never the fallback
  }
  let value;
  try { value = JSON.parse(raw); }
  catch {
    if (!quarantine) { logCorrupt(path); return fallback; }
    return quarantineStateFile(path, fallback);
  }
  if (validate && !validate(value)) {
    if (!quarantine) { logCorrupt(path); return fallback; }
    return quarantineStateFile(path, fallback);
  }
  return value;
}

function logCorrupt(path) {
  console.error(`ts=${new Date().toISOString()} level=error event=alert-state-corrupt requestId=none windowStart=none detail=${path.replace(/\s+/g, '-')}-corrupt-left-in-place`);
}

// Quarantine a corrupt state file (Rev 4.8, chunk-13 review — Gap 1,
// Finding 1): the rename failure is distinguished, exactly like
// quarantineCheckpoint (chunk-7 correction). ENOENT — the file already
// disappeared (a concurrent quarantine, or it vanished between the read and
// the rename) — is already-gone: log alert-state-corrupt and return the
// fallback. ANY other rename failure (permission, I/O) is NOT swallowed:
// the distinct failure is logged as alert-state-quarantine-failed (a
// diagnostic line, NOT emailed — see the §10 diagnostic-lines list, like
// alert-state-lock-release-failed) and the error is THROWN. The caller is
// inside withStateFileLock, so the throw propagates out of the transaction
// (updateDedupState / updatePendingState callers normalise it — dispatchOnce
// reports 'dedup-load-failed', retryPending's cleanup branches report
// 'alert-pending-cleanup-deferred'); the corrupt file stays for the operator
// and the probe never continues as if the quarantine had succeeded.
// Paths in the diagnostic details are encoded to a single token (whitespace
// → '-') — state-file paths are operator-configured under /var/lib/nova-api
// AND encoded as defence in depth (Rev 4.8, chunk-14 review); the rename
// itself always uses the real path. The error detail is extracted via the
// shared guarded encodeFsDetail (Rev 4.8, chunk-15 review), so a throwing
// message getter cannot defeat the diagnostic emission either.
function quarantineStateFile(path, fallback) {
  const quarantine = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { renameSync(path, quarantine); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      console.error(`ts=${new Date().toISOString()} level=error event=alert-state-corrupt requestId=none windowStart=none detail=${path.replace(/\s+/g, '-')}-already-gone`);
      return fallback;
    }
    console.error(`ts=${new Date().toISOString()} level=error event=alert-state-quarantine-failed requestId=none windowStart=none detail=${path.replace(/\s+/g, '-')}-quarantine-failed-${encodeFsDetail(e)}`);
    throw new Error(`alert-dispatcher: state quarantine failed for ${path} — inspect by hand; the corrupt file was NOT moved`);
  }
  console.error(`ts=${new Date().toISOString()} level=error event=alert-state-corrupt requestId=none windowStart=none detail=${path.replace(/\s+/g, '-')}-quarantined-to-${quarantine.replace(/\s+/g, '-')}`);
  return fallback;
}

export function loadDedupState(options) { return loadStateFile(DEDUP_PATH, {}, validateDedupState, options); }

export function loadPendingState(options) { return loadStateFile(PENDING_PATH, {}, validatePendingState, options); }
// (No saveDedupState / savePendingState: every mutation goes through
// updateDedupState / updatePendingState — the transaction lock, Rev 4.8 F5-29.)

// Operator recovery for a quarantined pending file (Rev 4.7, F5-03). Reads the
// quarantined file, validates each entry against the pending-entry schema
// (invalid entries are skipped and logged as alert-pending-invalid-entry),
// merges valid entries into the live pending file (a live entry for the same
// key wins — the quarantined duplicate is dropped with a log line), and renames
// the quarantined file to <path>.recovered-<timestamp> (never deleted silently).
// A quarantined file that is not valid JSON, or not a pending-state object,
// cannot be requeued: the function throws and NOTHING is changed — the operator
// repairs it by hand (see the §14 operator procedure). Returns
// { requeued, skipped, duplicates, recovered } — or, when the quarantine file
// was already recovered by a concurrent invocation, { requeued, skipped,
// duplicates, recovered: null, alreadyRecovered: true } (no throw — see the
// rename note below).
export function requeuePending(quarantinePath) {
  let value;
  try { value = JSON.parse(readFileSync(quarantinePath, 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { requeued: 0, skipped: 0, duplicates: 0, recovered: null, alreadyRecovered: true };
    throw new Error(`requeuePending: ${quarantinePath} is not valid JSON — inspect and repair by hand; nothing was changed`);
  }
  if (!isPlainObject(value)) throw new Error(`requeuePending: ${quarantinePath} is not a pending-state object — inspect by hand; nothing was changed`);
  // The merge runs inside the transaction lock (Rev 4.8, F5-29): the live
  // pending state is re-loaded FRESH inside the lock, so a concurrent probe
  // run's entries cannot be lost to this write. The quarantine rename follows
  // the save and happens exactly once; if the merge fails (lock timeout) the
  // rename does NOT happen and the quarantined file stays for a later retry.
  // The merge is idempotent — re-running it after a rename failure drops the
  // same entries as duplicates (a live entry for the same key wins).
  // Concurrent requeue of the SAME quarantine file: two invocations can both
  // read the file before either merges; they then merge sequentially (the
  // second counts the first's entries as duplicates) and both attempt the
  // rename — the second finds no file and returns the already-recovered
  // result instead of throwing (see below).
  let requeued = 0, skipped = 0, duplicates = 0;
  const merged = updatePendingState((pending) => {
    for (const [key, entry] of Object.entries(value)) {
      if (!validatePendingEntry(entry)) {
        skipped++;
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-invalid-entry requestId=none windowStart=none detail=${key}-skipped-in-requeue`);
        continue;
      }
      if (pending[key]) {
        duplicates++;
        console.log(`ts=${new Date().toISOString()} level=info event=alert-pending-requeue-duplicate requestId=none windowStart=none detail=${key}-live-entry-wins`);
        continue;
      }
      pending[key] = entry;
      requeued++;
    }
  });
  if (!merged.ok) throw new Error(`requeuePending: pending-state lock ${merged.reason === 'state-lock-unavailable' ? 'unavailable' : 'timeout'} — nothing was changed; retry the requeue`);
  const recovered = `${quarantinePath}.recovered-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { renameSync(quarantinePath, recovered); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { requeued, skipped, duplicates, recovered: null, alreadyRecovered: true };
    throw e;
  }
  return { requeued, skipped, duplicates, recovered };
}

// Identity guard for retry outcome writes (Rev 4.8, F5-29; chunk-5 review):
// a retry's outcome must apply only to the pending item it actually retried.
// The mutator re-loads the entry FRESH inside the lock and compares every
// IMMUTABLE identity field of the pending-entry schema (event, windowStart,
// requestId, ts, detail, firstSeen — validatePendingEntry) with the snapshot
// entry; attempts and lastAttempt are EXCLUDED (the retry itself mutates them).
// If the current entry has disappeared or been replaced by a different item
// under the same key, the mutator leaves the current state untouched (no
// delete, no attempts increment) — a stale outcome must never overwrite or
// delete a different item, and must never resurrect an entry another operation
// already removed. A skipped outcome is silent: the fresh stillPending count
// and the next probe make it observable (a replaced entry is retried on its
// own terms; a removed entry is cleaned up by the next probe's `duplicate`
// result when the dedup entry is durable).
export function isSamePendingEntry(current, entry) {
  if (!isPlainObject(current)) return false;
  return current.event === entry.event
    && current.windowStart === entry.windowStart
    && current.requestId === entry.requestId
    && current.ts === entry.ts
    && current.detail === entry.detail
    && current.firstSeen === entry.firstSeen;
}

// Retry every pending event (called by the probe BEFORE the journal scan, so an old
// undelivered event is retried before new ones are discovered). On success the
// dedup entry is written and the pending entry removed; a `duplicate` result
// ALSO removes the pending entry (F5-10 — an existing dedup key is completed
// delivery for pending cleanup). On failure the entry stays (attempts
// incremented) for the next probe. Entries older than 7 days are dropped and
// logged as alert-pending-expired. An entry whose firstSeen is not a valid
// calendar date is dropped and logged as alert-pending-invalid-entry (F5-09 —
// defence in depth; the schema validator already rejects it at load).
// ORDERING (F5-06): the dedup entry is written by dispatchAlert BEFORE this
// function removes the pending entry — a crash between the two leaves the
// dedup entry durable and the pending entry to be cleaned up by the next
// probe's `duplicate` result, never a lost delivery. Returns
// { retried, delivered, stillPending }. A dispatch that THROWS is treated as a
// failed delivery for that entry (it stays pending) and cannot abort the retry
// loop (F5-13). Outcome writes are guarded by isSamePendingEntry (above): the
// mutator verifies the current entry is still the same item before deleting it
// or incrementing its attempts, and the failure path increments the CURRENT
// attempts (not the snapshot's) — a stale outcome never overwrites a newer
// entry or resurrects a removed one.
export async function retryPending(transport = resolveAlertTransport()) {
  // Unlocked snapshot load (Rev 4.8, chunk-13 review — Gap 1, Finding 3):
  // quarantine DISABLED — this read runs outside the transaction lock, so a
  // corrupt file is returned as the fallback with the file left in place;
  // every outcome below is applied through updatePendingState (locked).
  const pending = loadPendingState({ quarantine: false });
  const now = Date.now();
  let retried = 0, delivered = 0;
  for (const [key, entry] of Object.entries(pending)) {
    // Rev 4.9 O-1: a pre-existing journal-only pending entry (written
    // before the Rev 4.9 probe skip) is dropped, never retried to the
    // 7-day expiry. The persisted-state validator recognises legacy
    // journal-only entries (validatePendingState passes
    // { allowJournalOnly: true }), so the snapshot load above returns
    // them and this branch can remove them individually; the detail
    // names the reason explicitly. The drop goes through the same
    // locked, identity-guarded outcome write as every other cleanup.
    if (JOURNAL_ONLY_EVENTS.includes(entry.event)) {
      let removed = false;
      const cleaned = updatePendingState((state) => { if (isSamePendingEntry(state[key], entry)) { delete state[key]; removed = true; } });
      if (!cleaned.ok) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-cleanup-deferred requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-cleanup-deferred-${cleaned.reason}`);
      } else if (removed) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-invalid-entry requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-journal-only-dropped`);
      }
      // else: the entry was replaced by a different item under the same key — leave it; the next probe handles it on its own terms.
      continue;
    }
    const firstSeenMs = Date.parse(entry.firstSeen);
    if (!Number.isFinite(firstSeenMs)) {
      let removed = false;
      const cleaned = updatePendingState((state) => { if (isSamePendingEntry(state[key], entry)) { delete state[key]; removed = true; } });
      if (!cleaned.ok) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-cleanup-deferred requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-cleanup-deferred-${cleaned.reason}`);
      } else if (removed) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-invalid-entry requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-invalid-firstSeen`);
      }
      // else: the entry was replaced by a different item under the same key —
      // leave it; the next probe handles it on its own terms.
      continue;
    }
    if (now - firstSeenMs > PENDING_MAX_AGE_MS) {
      let removed = false;
      const cleaned = updatePendingState((state) => { if (isSamePendingEntry(state[key], entry)) { delete state[key]; removed = true; } });
      if (!cleaned.ok) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-cleanup-deferred requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-cleanup-deferred-${cleaned.reason}`);
      } else if (removed) {
        console.error(`ts=${new Date().toISOString()} level=warn event=alert-pending-expired requestId=${entry.requestId ?? 'none'} windowStart=${entry.windowStart ?? 'none'} detail=${key}-undelivered-for-7-days`);
      }
      // else: replaced under the same key — leave the current entry untouched.
      continue;
    }
    retried++;
    let result;
    try {
      result = await dispatchAlert({ event: entry.event, windowStart: entry.windowStart, requestId: entry.requestId, ts: entry.ts, detail: entry.detail }, transport);
    } catch (e) {
      result = { sent: false, reason: `dispatch-threw: ${encodeFsDetail(e)}`, pending: true };
    }
    // Each outcome is applied through the transaction lock (Rev 4.8, F5-29)
    // against the FRESH pending state — a concurrent probe run's new entries
    // are never overwritten by a stale snapshot saved at the end of the loop.
    // (A lock timeout or lock-file-open failure on an outcome write returns
    // { ok: false } and writes nothing — the entry stays as it was, the loop
    // continues, and it is retried on the next probe.)
    if (result.sent || result.reason === 'duplicate') {
      let deleted = false;
      const outcome = updatePendingState((state) => { if (isSamePendingEntry(state[key], entry)) { delete state[key]; deleted = true; } });
      if (outcome.ok && deleted) delivered++;
      // else: lock failure (the entry stays, retried next probe — a later
      // `duplicate` result cleans it up once the dedup entry is durable) or
      // identity mismatch (the entry was replaced or removed — leave the
      // current state untouched; delivered is not counted).
    } else {
      updatePendingState((state) => {
        const cur = state[key];
        if (!isSamePendingEntry(cur, entry)) return;
        state[key] = { ...cur, attempts: (cur.attempts ?? 0) + 1, lastAttempt: new Date().toISOString() };
      });
    }
  }
  // stillPending is read FRESH after the loop — the snapshot above is stale by
  // construction (a concurrent probe run may have added entries during it).
  // Unlocked read — quarantine disabled, same rule as the snapshot load above.
  return { retried, delivered, stillPending: Object.keys(loadPendingState({ quarantine: false })).length };
}

// Resolves the sendmail binary (Rev 4.7, F5-01 — ONE policy, PATH-only,
// implemented in Node itself): walk process.env.PATH and return the first
// entry that is an executable file named "sendmail". No shell, no `command`
// builtin (it cannot be spawned), no hardcoded path. The install check runs
// THIS function against the installed module, so install check, runtime and
// tests agree by construction. A sendmail present only at /usr/sbin/sendmail
// with /usr/sbin NOT on the API unit's PATH is NOT installed. When nothing
// resolves, the transport reports sendmail-not-installed without attempting a
// spawn. Cached per process (the probe is short-lived).
let sendmailPathCache = undefined;
export function resolveSendmailPath() {
  if (sendmailPathCache !== undefined) return sendmailPathCache;
  let found = null;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = `${dir}/sendmail`;
    try {
      if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); found = candidate; break; }
    } catch { /* not usable — keep walking */ }
  }
  sendmailPathCache = found;
  return sendmailPathCache;
}

// Default transport: host MTA via the resolved sendmail interface. The operator
// installs and configures the MTA at host setup (msmtp providing the sendmail
// interface, relaying through the owner's SMTP account; install.sh fails if
// resolveSendmailPath() returns null — the same function this transport uses).
// No npm dependency. sendmail exit 0 = accepted by the relay (NOT proof of mailbox
// delivery — see §10 delivery evidence, which keeps the four artefacts distinct).
export function sendmailTransport({ to, subject, body }) {
  const sendmail = resolveSendmailPath();
  if (!sendmail) return { ok: false, reason: 'sendmail-not-installed' };
  const r = spawnSync(sendmail, ['-t'], { input: `To: ${to}\nSubject: ${subject}\n\n${body}\n`, encoding: 'utf8', timeout: 30000 });
  // Failure reasons are normalised AT THE SOURCE (Rev 4.8, chunk-13 review —
  // Gap 2): a spawn error message or sendmail's stderr can contain
  // whitespace and line breaks, and the reason is written into the canonical
  // one-token `detail=` field — so it is encoded to a single token here
  // (whitespace → '-'). The emission-side encoding in dispatchOnce stays as
  // defence in depth; the numeric exit status stays authoritative.
  if (r.error) return { ok: false, reason: `sendmail-spawn-failed: ${String(r.error.message ?? r.error).replace(/\s+/g, '-')}` };
  if (r.status !== 0) return { ok: false, reason: `sendmail-exit-${r.status}: ${(r.stderr || '').trim().replace(/\s+/g, '-')}` };
  return { ok: true };
}

// SMTP transport (OQ-1, owner decision 28 Nov 2026: alerts go through an
// OUTSIDE mail service, not an MTA on the host). No npm dependency:
// minimal SMTP client over node:net / node:tls. Config comes from the API
// unit's EnvironmentFile (/etc/nova-api/api.env):
//   NOVA_ALERT_SMTP_HOST — relay hostname (e.g. smtp.gmail.com). Unset =
//     no SMTP configured; the dispatcher falls back to sendmail.
//   NOVA_ALERT_SMTP_PORT — port (default 587, or 465 when SECURE=true).
//   NOVA_ALERT_SMTP_USER — SMTP username (the Gmail address).
//   NOVA_ALERT_SMTP_PASS — SMTP password (Gmail app password). Never
//     logged, never echoed in any reason string.
//   NOVA_ALERT_SMTP_FROM — envelope/header From (defaults to USER).
//   NOVA_ALERT_SMTP_SECURE — 'true' = implicit TLS on connect (port 465);
//     default false = plain connect + STARTTLS (port 587).
//   NOVA_ALERT_SMTP_CA_FILE — optional path to a PEM CA bundle used to
//     verify the relay's certificate (private CA / test certs). Unset =
//     the platform default CA store.
//   NOVA_ALERT_SMTP_TIMEOUT_MS — per-operation socket timeout (default
//     30000).
// Fail-closed: a host set without a usable user/password never sends and
// never falls back to sendmail — the misconfiguration is loud
// ('smtp-not-configured'), not silently rerouted. Credentials are NEVER
// sent on a plain connection: when SECURE is false the client requires
// the server to advertise STARTTLS and upgrades before AUTH; a relay
// that does not offer STARTTLS fails with 'smtp-starttls-unavailable'.
// Failure reasons are normalised to single tokens (whitespace -> '-'),
// the same convention as the sendmail transport, and never contain the
// password or any credential material.
function singleToken(v) { return typeof v === 'string' && v.length > 0 && !/\s/.test(v); }
function emailShape(v) { return singleToken(v) && /^[^@\s]+@[^@\s]+$/.test(v); }

export function smtpConfig() {
  const host = process.env.NOVA_ALERT_SMTP_HOST ?? '';
  if (!singleToken(host)) return null; // no SMTP configured
  const user = process.env.NOVA_ALERT_SMTP_USER ?? '';
  const pass = process.env.NOVA_ALERT_SMTP_PASS ?? '';
  const from = process.env.NOVA_ALERT_SMTP_FROM ?? '';
  const secure = (process.env.NOVA_ALERT_SMTP_SECURE ?? '').toLowerCase() === 'true';
  const portRaw = process.env.NOVA_ALERT_SMTP_PORT ?? '';
  const port = portRaw === '' ? (secure ? 465 : 587) : Number.parseInt(portRaw, 10);
  const timeoutRaw = process.env.NOVA_ALERT_SMTP_TIMEOUT_MS ?? '';
  const timeoutMs = timeoutRaw === '' ? 30000 : Number.parseInt(timeoutRaw, 10);
  const caFile = process.env.NOVA_ALERT_SMTP_CA_FILE ?? '';
  if (!emailShape(user) || !singleToken(pass)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || (from !== '' && !emailShape(from))
    || (caFile !== '' && /\s/.test(caFile))) {
    return { ok: false, reason: 'smtp-not-configured' };
  }
  return { ok: true, host, port, user, pass, from: from === '' ? user : from, secure, timeoutMs, caFile: caFile === '' ? null : caFile };
}

// The transport the dispatcher uses when no explicit transport is passed:
// the outside SMTP service when configured, else host sendmail. Evaluated
// per call (env is fixed at process start, but tests set it per child).
export function resolveAlertTransport() {
  return smtpConfig() ? smtpTransport : sendmailTransport;
}

// Install/host-readiness gate (used by install.sh): the mail path is ready
// when EITHER the SMTP service is fully configured OR a sendmail resolves.
// Anything else is not ready — never a silent pass.
export function mailTransportReady() {
  const c = smtpConfig();
  if (c) return c.ok ? { ok: true, via: 'smtp', detail: c.host } : { ok: false, reason: c.reason };
  const p = resolveSendmailPath();
  return p ? { ok: true, via: 'sendmail', detail: p } : { ok: false, reason: 'no-mail-transport' };
}

function smtpReason(stage, detail) {
  const suffix = detail === undefined || detail === null || `${detail}` === '' ? '' : `:${`${detail}`.replace(/\s+/g, '-')}`;
  return `smtp-${stage}${suffix}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// One SMTP connection: sequential command/response. The reader buffers
// socket data and resolves complete replies — a reply is complete on a
// line matching /^\d{3} / (code + space); lines matching /^\d{3}-/
// continue it; any other line ends the reply. Callers must not issue two
// reads concurrently. detach() removes the reader's socket listeners —
// it MUST be called before the socket is upgraded to TLS (a 'data'
// listener left on the underlying socket could steal encrypted bytes
// from the TLS layer).
function makeSmtpReader(socket) {
  let buffer = '';
  let lines = [];
  let waiter = null;
  let closed = false;
  const pump = () => {
    if (!waiter) return;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      lines.push(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
      const last = lines[lines.length - 1];
      if (/^\d{3} /.test(last) || !/^\d{3}-/.test(last)) {
        const done = lines; lines = [];
        const w = waiter; waiter = null; w(done); return;
      }
    }
    if (closed) {
      const done = lines.length > 0 ? lines : null; lines = [];
      const w = waiter; waiter = null; w(done);
    }
  };
  const onData = (chunk) => { buffer += chunk.toString('utf8'); pump(); };
  const onClosed = () => { closed = true; pump(); };
  socket.on('data', onData);
  socket.on('close', onClosed);
  socket.on('error', onClosed);
  return {
    readReply() {
      if (waiter) throw new Error('smtp reader: concurrent read');
      return new Promise((resolve) => { waiter = resolve; pump(); });
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('close', onClosed);
      socket.removeListener('error', onClosed);
    },
  };
}

function smtpStepError(stage, detail) {
  const e = new Error(String(detail ?? stage));
  e.smtpStage = stage;
  return e;
}

async function sendViaSmtp(cfg, { to, subject, body }) {
  let socket = null;
  const destroy = () => { try { socket?.destroy(); } catch { /* best-effort */ } };
  try {
    let ca;
    if (cfg.caFile) {
      try { ca = readFileSync(cfg.caFile); }
      catch (e) { throw smtpStepError('ca-unreadable', encodeFsDetail(e)); }
    }
    // Connect (the socket is assigned to the outer variable BEFORE the
    // connect settles, so a timeout still destroys it).
    const raw = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, ...(ca ? { ca } : {}) })
      : net.connect({ host: cfg.host, port: cfg.port });
    socket = raw;
    await withTimeout(new Promise((resolve, reject) => {
      raw.once('error', reject);
      raw.once(cfg.secure ? 'secureConnect' : 'connect', resolve);
    }), cfg.timeoutMs, 'connect-timeout').catch((e) => { throw smtpStepError('connect-failed', e.message ?? e); });

    let reader = makeSmtpReader(socket);
    const send = (line) => new Promise((resolve, reject) => {
      socket.write(`${line}\r\n`, (e) => (e ? reject(e) : resolve()));
    });
    const expect = async (codes, stage) => {
      const lines = await withTimeout(reader.readReply(), cfg.timeoutMs, `${stage}-timeout`)
        .catch((e) => { throw smtpStepError(stage, e.message ?? e); });
      if (!lines || lines.length === 0) throw smtpStepError(stage, 'connection-closed');
      const code = Number.parseInt(lines[0].slice(0, 3), 10);
      if (!codes.includes(code)) throw smtpStepError(stage, `${code}-${lines.join(' ')}`);
      return lines;
    };

    await expect([220], 'greeting');
    await send('EHLO localhost');
    let ehloLines = await expect([250], 'ehlo');
    let caps = ehloLines.join(' ');
    if (!cfg.secure) {
      if (!/STARTTLS/i.test(caps)) throw smtpStepError('starttls-unavailable', 'server-does-not-offer-starttls');
      await send('STARTTLS');
      await expect([220], 'starttls');
      // Upgrade in place: detach the plain reader first (see
      // makeSmtpReader), then wrap the socket in TLS.
      reader.detach();
      const upgraded = tls.connect({ socket, servername: cfg.host, ...(ca ? { ca } : {}) });
      socket = upgraded;
      await withTimeout(new Promise((resolve, reject) => {
        upgraded.once('error', reject);
        upgraded.once('secureConnect', resolve);
      }), cfg.timeoutMs, 'tls-upgrade-timeout').catch((e) => { throw smtpStepError('tls-upgrade-failed', e.message ?? e); });
      reader = makeSmtpReader(socket);
      await send('EHLO localhost');
      ehloLines = await expect([250], 'ehlo');
      caps = ehloLines.join(' ');
    }
    if (!/AUTH[^\n]*LOGIN/i.test(caps)) throw smtpStepError('auth-unavailable', 'server-does-not-offer-auth-login');
    await send('AUTH LOGIN');
    await expect([334], 'auth');
    await send(Buffer.from(cfg.user, 'utf8').toString('base64'));
    await expect([334], 'auth');
    await send(Buffer.from(cfg.pass, 'utf8').toString('base64'));
    await expect([235], 'auth');
    await send(`MAIL FROM:<${cfg.from}>`);
    await expect([250], 'mail-from');
    await send(`RCPT TO:<${to}>`);
    await expect([250], 'rcpt-to');
    await send('DATA');
    await expect([354], 'data');
    // Dot-stuff lines starting with '.'; CRLF line endings (RFC 5321).
    const message = [`From: ${cfg.from}`, `To: ${to}`, `Subject: ${subject}`, '', ...body.split('\n')]
      .map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    await send(`${message}\r\n.`);
    await expect([250], 'send');
    try { await send('QUIT'); } catch { /* best-effort goodbye */ }
    destroy();
    return { ok: true };
  } catch (e) {
    destroy();
    const stage = e?.smtpStage ?? 'failed';
    const detail = e?.smtpStage ? (e.message ?? '') : (e?.message ?? e);
    return { ok: false, reason: smtpReason(stage, detail) };
  }
}

// Outside-service transport: same { to, subject, body } -> { ok, reason }
// contract as sendmailTransport. Unconfigured (no host) or misconfigured
// (host without usable credentials) never sends and never falls back.
export async function smtpTransport({ to, subject, body }) {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, reason: 'smtp-not-configured' };
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  return sendViaSmtp(cfg, { to, subject, body });
}

// Dispatches one parsed event. Returns a Promise of { sent, reason, pending }.
// sent=true: delivered AND the dedup entry written. sent=false with
// reason 'duplicate': an email was already sent for this key. sent=false with
// pending=true: delivery failed and the CALLER must retain the event for retry
// (the probe writes it into the pending file BEFORE dispatching — see
// health-check.js — so a dispatch failure can never lose it). A transport that
// THROWS is treated exactly like { ok: false } (reason 'transport-threw:
// <message>'); a transport returning a malformed result (not an object, or no
// boolean `ok`) is treated as { ok: false, reason: 'transport-malformed-result' };
// a transport returning { ok: false } with no usable reason is normalised to
// 'transport-unspecified-failure' (F5-12). If the transport accepts the email
// but the dedup write then fails, the result is { sent: false, reason:
// 'dedup-write-failed', pending: true } — the event is retried and may
// duplicate (at-least-once, F5-04/F5-11); the failure is logged. If the dedup
// state cannot be loaded at all, the result is { sent: false, reason:
// 'dedup-load-failed', pending: true } — the event stays pending and is retried;
// a duplicate is possible if the email was already sent (at-least-once),
// because the load failure means the dedup state is unknown.
// An event with NEITHER identifier is undedupeable: it is delivered every time it
// is seen, no dedup entry is ever written for it (no key exists), and
// alert-undedupeable-event is logged — such an event can only arise from a
// malformed log line, and suppressing it would hide the defect.
// Per-key in-process serialisation (F5-27): calls for the same key are chained
// behind the previous call for that key, so the check-send-write sequence runs
// without interleaving inside one process. A later caller re-reads the dedup
// state after the earlier call settles and sees the key. The transaction lock
// (F5-29, withStateFileLock) serialises load-modify-save state mutations across
// processes and keys — the per-key chain is the same-key rule within one process;
// neither serialises the SEND across processes: two processes can both send one
// alert (at-least-once); the in-lock re-check blocks only a second dedup entry.
const inFlight = new Map();
export async function dispatchAlert(parsed, transport = resolveAlertTransport()) {
  // Rev 4.9 §2 — the policy boundary, BEFORE any normalisation,
  // undedupeable handling, serialisation, or transport: a journal-only
  // name returns exactly { sent: false, reason: 'journal-only',
  // pending: false } with no transport call and no dedup/pending
  // mutation; any other non-ALERT_EVENTS name is never emailed.
  const eventName = parsed?.event;
  if (JOURNAL_ONLY_EVENTS.includes(eventName)) {
    return { sent: false, reason: 'journal-only', pending: false };
  }
  if (!ALERT_EVENTS.includes(eventName)) {
    return { sent: false, reason: 'unregistered-event', pending: false };
  }
  const windowStart = normaliseScopeValue(parsed.windowStart);
  const requestId = normaliseScopeValue(parsed.requestId);
  if (!windowStart && !requestId) {
    console.error(`ts=${new Date().toISOString()} level=warn event=alert-undedupeable-event requestId=none windowStart=none detail=${parsed.event}-no-identifier`);
    const result = await sendAlertEmail(parsed, transport);
    return result.ok ? { sent: true, reason: 'sent-undedupeable', pending: false } : { sent: false, reason: result.reason, pending: true };
  }
  const key = dedupKey(parsed.event, { windowStart, requestId });
  const prior = inFlight.get(key) ?? Promise.resolve();
  const run = prior.then(() => dispatchOnce(parsed, key, transport));
  // The chain entry is always a settled promise: a later caller never inherits
  // an earlier caller's failure as a rejection of its own queue step.
  // dispatchOnce never throws for a state or transport failure (the dedup load
  // is guarded, the dedup write is guarded, sendAlertEmail normalises transport
  // throws and malformed results — see its definition). An unexpected
  // programming/runtime exception can still reject the current caller's promise
  // (the settled chain absorbs it for later callers); both callers handle
  // rejection — retryPending's per-entry catch (F5-13) and the probe scan
  // loop's dispatch catch — so no caller relies on an absolute no-throw
  // guarantee.
  const chain = run.then(() => undefined, () => undefined);
  inFlight.set(key, chain);
  // Cleanup: remove the settled entry so the map cannot grow without bound
  // over a long-running process. The identity check matters — a later dispatch
  // may already have replaced the entry for the same key, and must not be
  // removed by this chain's settlement.
  chain.then(() => { if (inFlight.get(key) === chain) inFlight.delete(key); });
  return run;
}

async function dispatchOnce(parsed, key, transport) {
  // Rev 4.9 §2 — defence in depth: the allowlist guard repeats here so
  // no internal caller can bypass the event policy by calling dispatchOnce
  // directly. (The direct dispatchAlert guard above is essential — the
  // undedupeable path sends without calling dispatchOnce.)
  if (JOURNAL_ONLY_EVENTS.includes(parsed?.event)) {
    return { sent: false, reason: 'journal-only', pending: false };
  }
  if (!ALERT_EVENTS.includes(parsed?.event)) {
    return { sent: false, reason: 'unregistered-event', pending: false };
  }
  const windowStart = normaliseScopeValue(parsed.windowStart);
  const requestId = normaliseScopeValue(parsed.requestId);
  let state;
  // Unlocked read (Rev 4.8, chunk-13 review — Gap 1, Finding 3): the dedup
  // lookup runs OUTSIDE the transaction lock, so it loads with quarantine
  // DISABLED — a corrupt file is returned as the fallback with the file left
  // in place, never renamed; only a locked load quarantines. A non-ENOENT
  // read error still throws and is reported as 'dedup-load-failed' below.
  try { state = loadDedupState({ quarantine: false }); }
  catch (e) {
    console.error(`ts=${new Date().toISOString()} level=error event=alert-delivery-failed requestId=${requestId ?? 'none'} windowStart=${windowStart ?? 'none'} detail=dedup-load-failed-${encodeFsDetail(e)}`);
    return { sent: false, reason: 'dedup-load-failed', pending: true };
  }
  if (state[key]) return { sent: false, reason: 'duplicate', pending: false };
  const result = await sendAlertEmail(parsed, transport);
  if (!result.ok) { console.error(`ts=${new Date().toISOString()} level=error event=alert-delivery-failed requestId=${requestId ?? 'none'} windowStart=${windowStart ?? 'none'} detail=${String(result.reason).replace(/\s+/g, '-')}`); return { sent: false, reason: result.reason, pending: true }; }
  // The dedup write goes through the transaction lock (Rev 4.8, F5-29): the
  // file is re-loaded FRESH inside the lock, so a concurrent dispatch of a
  // DIFFERENT key cannot lose its entry to this write, and if another writer
  // delivered this same key while this send was in flight, the re-check inside
  // the lock returns 'duplicate' instead of writing a second entry. A lock
  // timeout, a lock-file-open failure, or any write failure, is 'dedup-write-failed' with pending: true
  // — the event is retried and may duplicate (at-least-once, F5-04/F5-11).
  let wrote = false;
  let saved;
  try {
    saved = updateDedupState((s) => {
      if (s[key]) return;
      s[key] = { sentAt: new Date().toISOString(), requestId: requestId ?? null };
      wrote = true;
    });
  } catch (e) {
    console.error(`ts=${new Date().toISOString()} level=error event=alert-delivery-failed requestId=${requestId ?? 'none'} windowStart=${windowStart ?? 'none'} detail=dedup-write-failed-${encodeFsDetail(e)}`);
    return { sent: false, reason: 'dedup-write-failed', pending: true };
  }
  if (!saved.ok) {
    console.error(`ts=${new Date().toISOString()} level=error event=alert-delivery-failed requestId=${requestId ?? 'none'} windowStart=${windowStart ?? 'none'} detail=dedup-write-failed-${String(saved.reason).replace(/\s+/g, '-')}`);
    return { sent: false, reason: 'dedup-write-failed', pending: true };
  }
  if (!wrote) return { sent: false, reason: 'duplicate', pending: false };
  return { sent: true, reason: 'sent', pending: false };
}

// Header-injection safety BY CONSTRUCTION (Rev 4.8, chunk-13 review —
// Gap 2): no caller-supplied free text ever reaches a message header. The
// subject is built ONLY from (a) `parsed.event` — a REGISTERED token:
// parseEventLine rejects any unregistered name before dispatch, so the event
// can never carry injected text; (b) `windowStart` — a validated ISO-8601
// date (normaliseScopeValue maps anything else to null) — or the requestId —
// a validated UUID — or the literal 'unknown-scope'. `to` is the configured
// ALERT_RECIPIENT (operator configuration), never event-derived. The only
// free-form value, `parsed.detail`, goes in the BODY, never in a header.
// §15 test (y) proves it with a capturing transport: the headers contain
// only the registered event token, the validated scope, and ALERT_RECIPIENT,
// with no CR/LF anywhere.
async function sendAlertEmail(parsed, transport) {
  const windowStart = normaliseScopeValue(parsed.windowStart);
  const requestId = normaliseScopeValue(parsed.requestId);
  const subject = `[NOVA] ${parsed.event} — ${windowStart ?? requestId ?? 'unknown-scope'}`;
  const body = [
    `Event: ${parsed.event}`,
    `Time: ${parsed.ts ?? 'unknown'}`,
    `Window start: ${windowStart ?? 'unknown (counter unreadable)'}`,
    `Startup request id: ${requestId ?? 'none'}`,
    `Detail: ${parsed.detail ?? 'none'}`,
    ``,
    `Operator action: see Phase 5 design §14 (operator reset procedure).`,
    `This is a one-time alert for this window/request while its dedup entry is retained (7 days); repeated identical events are not re-emailed while retained.`,
  ].join('\n');
  let result;
  try { result = await transport({ to: ALERT_RECIPIENT, subject, body }); }
  catch (e) { return { ok: false, reason: `transport-threw: ${encodeFsDetail(e)}` }; }
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return { ok: false, reason: 'transport-malformed-result' };
  if (!result.ok) {
    const reason = (typeof result.reason === 'string' && result.reason.length > 0) ? result.reason : 'transport-unspecified-failure';
    return { ok: false, reason };
  }
  return result;
}

// CLI (operator use only): node alert-dispatcher.js requeue <quarantined-file>
// Prints RESULT <code> <json>. Exits 0 on success, 1 when the file cannot be
// requeued (not valid JSON, not a pending-state object, or an I/O failure) —
// in every failure case NOTHING is changed. The probe never invokes this.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [,, op, ...args] = process.argv;
  if (op === 'requeue') {
    try {
      const result = requeuePending(args[0] ?? '');
      console.log(`RESULT 0 ${JSON.stringify(result)}`);
    } catch (e) {
      console.error(`RESULT 1 ${JSON.stringify({ error: encodeFsDetail(e) })}`);
      process.exit(1);
    }
  } else {
    console.error(`RESULT 1 ${JSON.stringify({ error: `unknown-op: ${op ?? ''}` })}`);
    process.exit(1);
  }
}
