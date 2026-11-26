// startup-counter.mjs — the ONE implementation of the startup-attempt counter.
// Schema: {"attempts": N, "windowStart": "<ISO-8601 UTC>", "reservation": "<uuid>" | null, "generation": "<uuid>"}
// Strict validation, identical in all three call sites. A missing `reservation`
// or `generation` key is MALFORMED everywhere (no legacy population exists —
// Phase 5 is design-only). `generation` is the ownership token (Rev 4.7,
// F5-20): a UUID assigned when the counter file is created (absent -> create;
// expired window -> new window) and preserved by ordinary mutations
// (reserve/release/consume). Any delete+recreate produces a new generation, so
// a stale reset identity can never match a recreated counter. Every creation
// happens under the shared lock, so no stale writer can resurrect a deleted
// file with an old generation.
// Every mutation MUST be called with /var/lib/nova-api/startup-attempts.lock held
// (flock). Reads need no lock (writes are atomic temp-file + rename).
// UUIDs: node crypto.randomUUID(). uuidgen is NOT used (absent from the dev VM,
// verified 26 Nov 2026; node is already a host dependency).
// CLI: node startup-counter.mjs <op> [args] — MUST be called with the lock held.
// Prints exactly one line: RESULT <code> [json]. Always exits 0, so flock's exit
// code is unambiguous: flock non-zero = the lock was not acquired (bounded wait
// expired), never a counter result. Codes: 0 ok, 2 malformed, 3 unwritable,
// 4 internal-error (the CLI caught an unexpected exception — the shell scripts
// classify it as a counter-unreadable condition), 5 unreadable, 6 absent,
// 7 slot-reserved, 8 limit-reached, 9 reset-preserved.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Single shared module (Rev 4.8, chunk-11 review): this is the ONLY counter
// implementation. All three call sites consume it and nothing else validates
// or mutates the counter: the API process imports it directly (readCounter,
// LIMIT, isValidCalendarDate); the preparation and retry shell scripts call
// the counter CLI, which is a thin wrapper over this module; and
// alert-dispatcher.js imports isValidCalendarDate from it for the probe's
// checkpoint validation. LIMIT and FUTURE_TOLERANCE_MS are defined exactly
// once, here, and every enforcement point reads them through this module
// (validateCounter, prepareAttempt, reserveAttempt, resetCounter, and the API
// process's exit decision). The shell scripts never enforce the limit
// themselves — they read the counter through the CLI and decide on its RESULT
// codes (8 = limit-reached, 7 = slot-reserved), so no second copy of the
// limit exists anywhere in code. readCounter keeps the three read outcomes
// distinct: absent (code 6), unreadable (code 5, `read-failed: <encoded-message>`),
// unparseable JSON (code 2, `unparseable-json`), schema-invalid (code 2, the
// validateCounter reason) — a parse failure, a read failure, and a validation
// failure are never collapsed into one outcome. §15 test (w) proves the
// sharing: the CLI, the API import, and the dispatcher import all resolve to
// this one file, and a changed LIMIT in this module changes all three
// behaviors.
// Two paths, ONE source (Rev 4.8, chunk-12 review): the source module and
// the installed CLI are different PATHS, not one runtime file — install.sh
// COPIES this canonical source file verbatim to
// /opt/nova-ai-studio/bin/startup-counter.mjs (no transformation, no second
// implementation), and §15 test (w) proves the deployed copy is
// byte-identical (sha256) to the canonical source, so the "one
// implementation" claim is a proven deployment relationship, not a file
// identity. Error details in read/write/unlink reasons are encoded to a
// single token at the source (see encodeFsDetail below) so the CLI's
// exactly-one RESULT line can never be broken by a multi-line filesystem
// message.

export const COUNTER_PATH = '/var/lib/nova-api/startup-attempts';
export const WINDOW_MS = 300_000;
export const LIMIT = 5;
// A future windowStart more than this far ahead is impossible from a trusted
// write (writers write `now` from the same host clock) and is malformed
// (Rev 4.7, F5-22). Within the tolerance (a clock step mid-write) it is
// accepted and treated as a live window.
export const FUTURE_TOLERANCE_MS = 60_000;
const WINDOW_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// UUID validation (Rev 4.8, chunk-11 review): RFC 4122 version 4, matching the
// generator (node crypto.randomUUID() — newToken() and every other token in this
// design). The third group must start with 4 (version) and the fourth with
// 8/9/a/b (variant); the all-zero value and any non-v4 version are rejected.
// The same expression validates reservation, generation, and requestId in both
// modules that check a UUID (this module and alert-dispatcher.js). It is
// exported for startup-attempts.js (Rev 4.8, chunk-14 review), which validates
// the startup request id against the same rule — one canonical UUID rule for
// the startup side, not a second copy of the expression.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Strict calendar validation (Rev 4.6 — the regex + finite Date.parse() check of
// Rev 4.5 is insufficient: Date.parse() NORMALISES impossible dates, e.g.
// '2026-02-30T00:00:00Z' parses to 2026-03-02 (verified on node 24, 26 Nov 2026),
// and the regex alone accepts '2026-13-40T99:99:99Z'. This function validates the
// actual calendar components — year >= 1 (Rev 4.8, F5-36: year 0000 is rejected;
// the design's timestamps are operational wall-clock times and year 0 can only
// arise from a corrupt or hand-edited value; ISO 8601 permits year 0000, this
// design deliberately does not), month 1–12, day within the month (incl.
// leap-year February), hour 0–23, minute/second 0–59 (leap second 60 rejected)
// — and accepts the documented UTC format with 1–3 fractional digits or none
// (Rev 4.8, F5-34: millisecond precision, matching Date.prototype.toISOString(),
// which always emits exactly 3 fractional digits; four or more digits are
// malformed).
export function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !WINDOW_START_RE.test(value)) return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return false;
  return Number.isFinite(Date.parse(value));
}

export function validateCounter(value, now = Date.now()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-an-object' };
  if (Object.keys(value).sort().join(',') !== 'attempts,generation,reservation,windowStart') return { ok: false, reason: 'unexpected-keys' };
  if (!Number.isInteger(value.attempts) || value.attempts < 0) return { ok: false, reason: 'attempts-not-non-negative-integer' };
  if (value.attempts > LIMIT) return { ok: false, reason: 'attempts-above-limit' };
  if (!isValidCalendarDate(value.windowStart)) return { ok: false, reason: 'windowStart-not-ISO-8601-UTC' };
  if (Date.parse(value.windowStart) > now + FUTURE_TOLERANCE_MS) return { ok: false, reason: 'windowStart-in-future' };
  if (value.reservation !== null && (typeof value.reservation !== 'string' || !UUID_RE.test(value.reservation))) return { ok: false, reason: 'reservation-not-null-or-uuid' };
  if (typeof value.generation !== 'string' || !UUID_RE.test(value.generation)) return { ok: false, reason: 'generation-not-uuid' };
  return { ok: true };
}

// CLI one-line output (Rev 4.8, chunk-12 review — Finding 1): filesystem
// error messages are NOT guaranteed single-line, and the CLI prints exactly
// one `RESULT <code> [json]` line. Every filesystem error detail
// incorporated into a reason is encoded to a single token AT THE SOURCE
// (whitespace → '-'); the numeric result code stays authoritative, and the
// full message is never needed to classify the failure. (JSON.stringify
// would escape a newline, but the reason must still be a single token by
// construction: shell consumers and log lines treat the reason as one token,
// so the encoding happens here, not at the consumer.)
// Guarded extraction (Rev 4.8, chunk-14 review — Gap F caveat): reading
// `e.message` can itself throw (a throwing getter or Proxy), and String(e)
// can throw too, so each step is independently guarded and a failure at any
// step falls back to the fixed 'unknown'. encodeFsDetail never throws, so
// the CLI catch that builds code 4 can never throw while building the
// RESULT line.
// Shared guarded error detail (Rev 4.8, chunk-15 review): this is the ONE
// guarded extraction in the design — the dispatcher (alert-dispatcher.js) and
// the probe (health-check.js) import it for every diagnostic that interpolates
// an error message, so no diagnostic emission can throw while reporting a
// failure (a throwing message getter falls back to 'unknown', exactly as in
// the CLI path). The name is historical (it was introduced for the CLI
// one-line output); the function itself is error-shape agnostic.
// All three importers (alert-dispatcher.js, health-check.js,
// startup-attempts.js) live in the same directory as this module
// (gpu-cloud/src/api-server/) in both the canonical tree and the installed
// tree — install.sh installs the four modules together to
// /opt/nova-ai-studio/src/api-server/ (the path the probe wrapper already
// runs from) — so './startup-counter.mjs' resolves to the same file for
// each; the bin/ CLI copy is the same file, byte-identical (test (w)).
export function encodeFsDetail(e) {
  let s;
  try { s = (e instanceof Error ? e.message : null) ?? String(e ?? 'unknown'); }
  catch { return 'unknown'; }
  if (typeof s !== 'string' || s === '') {
    try { s = String(e ?? 'unknown'); } catch { return 'unknown'; }
  }
  const encoded = s.replace(/\s+/g, '-');
  return encoded === '' ? 'unknown' : encoded;
}

export function readCounter() {
  let raw;
  try { raw = readFileSync(COUNTER_PATH, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { code: 6, reason: 'absent' } : { code: 5, reason: `read-failed: ${encodeFsDetail(e)}` }; }
  let value;
  try { value = JSON.parse(raw); } catch { return { code: 2, reason: 'unparseable-json' }; }
  const v = validateCounter(value);
  return v.ok ? { code: 0, value } : { code: 2, reason: v.reason };
}

function writeCounter(value) {
  const tmp = `${COUNTER_PATH}.tmp.${process.pid}`;
  try { writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'w' }); renameSync(tmp, COUNTER_PATH); return { code: 0 }; }
  catch (e) {
    // A failed write or rename must not leave the PID-specific temp file
    // behind (Rev 4.8, chunk-12 review): best-effort cleanup — the unlink is
    // ignored when the rename already moved the file (ENOENT).
    try { unlinkSync(tmp); } catch { /* already gone — nothing to clean */ }
    return { code: 3, reason: `write-failed: ${encodeFsDetail(e)}` };
  }
}

export function newToken() { return randomUUID(); }
export function windowExpired(value, now = Date.now()) { return now - Date.parse(value.windowStart) >= WINDOW_MS; }

// Preparation: the single counting point. Called with the lock held.
// Consumes any outstanding reservation (attempts += 1, reservation -> null).
// A fresh generation is assigned when the counter is created (absent or expired
// window); an ordinary consume preserves the generation. The five-attempt limit
// is enforced HERE, at the preparation mutation boundary (Blocker 2): a live
// window already at attempts >= LIMIT is refused with code 8, the counter bytes
// are UNCHANGED and a held reservation is NOT consumed — preparation is the
// single counting point for every path (supervisor start, operator start,
// API-unit restart), so no path can write a sixth attempt.
export function prepareAttempt(now = new Date()) {
  const read = readCounter();
  if (read.code === 6) { const value = { attempts: 1, windowStart: now.toISOString(), reservation: null, generation: newToken() }; const w = writeCounter(value); return w.code === 0 ? { code: 0, value } : w; }
  if (read.code !== 0) return read; // unreadable (5) or malformed (2) — fail closed, bytes untouched
  if (windowExpired(read.value, now.getTime())) { const value = { attempts: 1, windowStart: now.toISOString(), reservation: null, generation: newToken() }; const w = writeCounter(value); return w.code === 0 ? { code: 0, value } : w; }
  if (read.value.attempts >= LIMIT) return { code: 8, reason: 'limit-reached', value: read.value };
  const value = { attempts: read.value.attempts + 1, windowStart: read.value.windowStart, reservation: null, generation: read.value.generation };
  const w = writeCounter(value);
  return w.code === 0 ? { code: 0, value } : w;
}

// Supervisor: reserve the next attempt slot. Called with the lock held.
// Refuses when a reservation is already held (7) or attempts >= LIMIT (8).
// An expired window is written as a coherent new window WITH the reservation
// AND a new generation (the old generation dies with the old window).
export function reserveAttempt(now = new Date()) {
  const read = readCounter();
  if (read.code === 6) return { code: 6, reason: 'absent' };
  if (read.code !== 0) return read;
  if (windowExpired(read.value, now.getTime())) { const token = newToken(); const value = { attempts: 0, windowStart: now.toISOString(), reservation: token, generation: newToken() }; const w = writeCounter(value); return w.code === 0 ? { code: 0, value, token } : w; }
  if (read.value.reservation !== null) return { code: 7, reason: 'slot-reserved', value: read.value };
  if (read.value.attempts >= LIMIT) return { code: 8, reason: 'limit-reached', value: read.value };
  const token = newToken();
  const value = { attempts: read.value.attempts, windowStart: read.value.windowStart, reservation: token, generation: read.value.generation };
  const w = writeCounter(value);
  return w.code === 0 ? { code: 0, value, token } : w;
}

// Supervisor cleanup: release ONLY the caller's own reservation. Called with the lock held.
// The release token is validated as a UUID before comparison (a non-UUID token
// can never equal a stored UUID, so it is `not-owner` — never an error).
// The generation is preserved (a release is an ordinary mutation).
export function releaseReservation(token, now = new Date()) {
  if (typeof token !== 'string' || !UUID_RE.test(token)) return { code: 0, released: false, reason: 'not-owner' };
  const read = readCounter();
  if (read.code !== 0) return read;
  if (windowExpired(read.value, now.getTime())) return { code: 0, value: read.value, released: false, reason: 'window-expired' };
  if (read.value.reservation !== token) return { code: 0, value: read.value, released: false, reason: 'not-owner' };
  const value = { attempts: read.value.attempts, windowStart: read.value.windowStart, reservation: null, generation: read.value.generation };
  const w = writeCounter(value);
  return w.code === 0 ? { code: 0, value, released: true } : w;
}

// API process: identity-checked reset after a successful listen(). Called with
// the lock held (the API module spawns the CLI under flock — Node has no flock
// binding). The reset deletes the file ONLY when the stored state still belongs
// to the startup being completed (Blocker 1 + Rev 4.7 F5-20): stored windowStart,
// attempts AND generation equal the identity's, AND no reservation is held.
// Any mismatch PRESERVES the counter (code 9, `reset-preserved`) — a newer
// reservation, a newer counted attempt, a new window, or a recreated counter
// with a new generation all survive. The identity's requestId is carried for
// logging/correlation only: the stored counter holds no request id, so there is
// nothing to compare it against. The identity is FULLY validated before any
// comparison (Rev 4.8, F5-37) — and BEFORE the counter is even read (Rev 4.8,
// chunk-12 review — Finding 2): requestId must be a UUID string, windowStart must
// pass isValidCalendarDate(), attempts must be an integer in the permitted range
// [0, LIMIT], generation must be a UUID string — any failure is code 2
// (`reset-identity-invalid`), and a reset with no verifiable identity never
// deletes anything — including when the counter file is absent, where an
// invalid identity still returns code 2 and only a VALID identity returns
// code 0 (`already-absent`). An unreadable or malformed stored counter is likewise never deleted
// (codes 5 / 2).
export function resetCounter(identity) {
  // Validation order (Rev 4.8, chunk-12 review — Finding 2): the identity is
  // validated FIRST, before the counter is read — the absent-file return
  // below applies only to a VALID identity, so callers can rely on a
  // malformed reset identity always being rejected (code 2), never silently
  // accepted as code 0.
  if (!identity || typeof identity !== 'object'
      || typeof identity.requestId !== 'string' || !UUID_RE.test(identity.requestId)
      || typeof identity.windowStart !== 'string' || !isValidCalendarDate(identity.windowStart)
      || !Number.isInteger(identity.attempts) || identity.attempts < 0 || identity.attempts > LIMIT
      || typeof identity.generation !== 'string' || !UUID_RE.test(identity.generation)) {
    return { code: 2, reason: 'reset-identity-invalid' };
  }
  const read = readCounter();
  if (read.code === 6) return { code: 0, preserved: false, reason: 'already-absent' };
  if (read.code !== 0) return read; // unreadable (5) or malformed (2) — never delete unverifiable state
  if (read.value.windowStart !== identity.windowStart || read.value.attempts !== identity.attempts || read.value.generation !== identity.generation) {
    return { code: 9, reason: 'reset-preserved', preserved: true, value: read.value };
  }
  if (read.value.reservation !== null) {
    return { code: 9, reason: 'reset-preserved', preserved: true, value: read.value };
  }
  try { unlinkSync(COUNTER_PATH); return { code: 0, preserved: false }; }
  catch (e) { return e.code === 'ENOENT' ? { code: 0, preserved: false, reason: 'already-absent' } : { code: 3, reason: `unlink-failed: ${encodeFsDetail(e)}` }; }
}

function parseResetIdentity(args) {
  const [requestId, windowStart, attemptsRaw, generation] = args;
  // Canonical decimal parsing (Rev 4.8, F5-37): only an unsigned decimal
  // integer string parses. Number() would also accept '1e0', whitespace-padded
  // numbers, and '' as 0 — all rejected here. A non-canonical value is NaN,
  // and resetCounter returns code 2 (reset-identity-invalid).
  const attempts = /^(0|[1-9]\d*)$/.test(attemptsRaw ?? '') ? Number(attemptsRaw) : NaN;
  return { requestId: requestId || null, windowStart: windowStart || null, attempts, generation: generation || null };
}

// CLI dispatch (ops: prepare | reserve | release <token> | reset <requestId> <windowStart> <attempts> <generation> | read).
// `read` is lock-free (reads need no lock) and is used by the shell scripts only
// for diagnostics; the API process reads via import. The dispatch is wrapped in
// try/catch so an unexpected exception can never kill the CLI before it prints
// RESULT: it prints RESULT 4 (internal-error) and exits 0, and the shell scripts
// classify code 4 as a counter-unreadable condition (fail closed).
// MAIN-ENTRY GUARD (Rev 4.8, §15 test (w) fix, 26 Nov 2026): the dispatch runs
// ONLY when this module is the main entry (node startup-counter.mjs ...).
// Unconditional top-level dispatch printed a spurious
// `RESULT 2 {"code":2,"reason":"unknown-op"}` on every import — including
// every API process start via api-server.js — because an import has no op.
// The guard compares the resolved argv[1] against this module's own path;
// an import (argv[1] absent or another file) skips the dispatch entirely.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [,, op, ...args] = process.argv;
  let result;
  try {
    result = op === 'prepare' ? prepareAttempt()
      : op === 'reserve' ? reserveAttempt()
      : op === 'release' ? releaseReservation(args[0] ?? '')
      : op === 'reset' ? resetCounter(parseResetIdentity(args))
      : op === 'read' ? readCounter()
      : { code: 2, reason: 'unknown-op' };
  } catch (e) {
    // Encoded at the source like every other CLI reason (Rev 4.8, chunk-12
    // review — Finding 1): the RESULT line stays exactly one line with a
    // single-token reason, whatever the thrown value carries.
    result = { code: 4, reason: `internal-error: ${encodeFsDetail(e)}` };
  }
  console.log(`RESULT ${result.code} ${JSON.stringify(result)}`);
}
