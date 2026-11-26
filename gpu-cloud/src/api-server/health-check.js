// health-check.js — the health-check probe (systemd timer, every 5 min).
// Scans the journal since its last scan for the twenty-four registered startup event
// names (twenty-two emailed, two journal-only — see EVENT_REGISTRY) and invokes
// the dispatcher for each new event. Pending (previously undelivered)
// events are retried BEFORE the journal scan. It also reads the storage-runner
// heartbeat every run (Rev 4.9, F-6a) and alerts on a stale/missing/failed
// heartbeat (storage-runner-heartbeat-outage). Never calls the API's HTTP
// endpoints (no secret needed). Runs as root (journal read + /var/lib/nova-api write).
// Runs under the run-health-check.sh wrapper, which holds the probe lock — the
// probe script itself assumes it is the only probe process running.
// Durable-pending-first (Rev 4.7, F5-13): the scan loop writes each parsed
// event to the pending file BEFORE calling dispatchAlert, so a dispatch
// exception can never lose an event. If the pending write itself throws, the
// probe fails WITHOUT advancing the checkpoint (exit 1). dispatchAlert is
// async (per-key in-process serialisation, F5-27) and is awaited.
// Fixed scan boundary (Rev 4.8, F5-30): scanUntil is captured before the
// journalctl call, passed as --until, and persisted as the checkpoint
// EXACTLY (lastScan = scanUntil) — the next query starts 60 s before the
// persisted checkpoint (SCAN_OVERLAP_MS), so the overlap is in the query, never in the checkpoint.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { parseEventLine, dispatchAlert, retryPending, updatePendingState, writeStateFileAtomic, pendingKey, validateCheckpointState, isSamePendingEntry, JOURNAL_ONLY_EVENTS, ALERT_EVENTS } from './alert-dispatcher.js';
import { checkRunnerHeartbeat } from './runner-heartbeat.js';
import { encodeFsDetail } from './startup-counter.mjs'; // shared guarded error-detail encoder (Rev 4.8, chunk-15 review) — every diagnostic below that interpolates an error message goes through it, so a throwing message getter can never defeat a diagnostic emission

const STATE_PATH = '/var/lib/nova-api/health-check-state.json';
// Runner heartbeat path (Rev 4.9, F-6a): overridable for tests via env;
// the production path is the shared /var/lib/nova-api root.
const RUNNER_HEALTH_PATH = process.env.NOVA_RUNNER_HEALTH_PATH ?? '/var/lib/nova-api/runner-health.json';
const SCAN_OVERLAP_MS = 60_000; // Consecutive scans overlap by 60 s: the next query starts 60 s before the persisted checkpoint (lastScan = scanUntil), so a late-visible journal entry timestamped within the 60 s overlap is still inside the next interval (F5-30).
const UNITS = ['nova-api-server.service', 'nova-startup-id.service', 'nova-storage-recovery.service', 'nova-startup-retry.service'];

function logLine(event, detail, level = 'error') {
  const line = `ts=${new Date().toISOString()} level=${level} event=${event} requestId=none windowStart=none detail=${detail}`;
  if (level === 'error') console.error(line); else console.log(line);
}

// Checkpoint load: missing file -> scan the last 5 min (first run). Corrupt file
// (unparseable JSON, or a valid JSON value with the wrong shape — F5-08/F5-15)
// -> quarantine + rewind the scan to 24 h ago (bounded re-scan; dedup suppresses
// already-sent events, pending retries the rest) + log alert-state-corrupt.
// A file that cannot be READ (permission, I/O) is NOT corruption: log
// alert-checkpoint-unreadable and fail the run (exit 1 via main()'s top-level
// handler) — never quarantine a file that was never shown to be corrupt, and
// never rewind 24 h on a failure that says nothing about its contents.
function loadCheckpoint() {
  if (!existsSync(STATE_PATH)) return { lastScan: null };
  let raw;
  try { raw = readFileSync(STATE_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { lastScan: null }; // vanished between the check and the read
    // A read failure is NOT corruption: the file may be perfectly valid but
    // unreadable (permission, I/O). Report it and stop — do NOT quarantine a
    // file that was never shown to be corrupt, and do NOT rewind 24 h on a
    // failure that says nothing about the checkpoint's contents.
    logLine('alert-checkpoint-unreadable', `${STATE_PATH.replace(/\s+/g, '-')}-read-failed-${encodeFsDetail(e)}`);
    throw new Error(`health-check: checkpoint read failed for ${STATE_PATH} — inspect by hand; the probe run fails without scanning`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { return quarantineCheckpoint(); }
  if (!validateCheckpointState(value)) return quarantineCheckpoint();
  return value;
}

function quarantineCheckpoint() {
  const quarantine = `${STATE_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { renameSync(STATE_PATH, quarantine); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      // Race: the file disappeared between the read and the rename — nothing
      // to quarantine. The checkpoint is effectively missing, but the file was
      // corrupt when read, so the bounded 24 h rewind still applies.
      logLine('alert-state-corrupt', `${STATE_PATH.replace(/\s+/g, '-')}-already-gone`);
      return { lastScan: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
    }
    // Any other rename failure (permission, I/O): do NOT claim the quarantine
    // succeeded. Log the distinct failure and fail the probe run — the corrupt
    // file stays for the operator; the timer retries in 5 min. (The throw is
    // caught by main()'s top-level handler, which logs health-check-probe-failed
    // and exits 1.) Paths in the diagnostic details are encoded to a single
    // token (whitespace → '-') — STATE_PATH is a module constant under
    // /var/lib/nova-api AND encoded as defence in depth (Rev 4.8, chunk-14
    // review); the rename itself always uses the real path. The error detail
    // is extracted via the shared guarded encodeFsDetail (Rev 4.8, chunk-15
    // review), so a throwing message getter cannot defeat the diagnostic
    // emission either.
    logLine('alert-state-quarantine-failed', `${STATE_PATH.replace(/\s+/g, '-')}-quarantine-failed-${encodeFsDetail(e)}`);
    throw new Error(`health-check: checkpoint quarantine failed for ${STATE_PATH} — inspect by hand; the probe run fails without scanning`);
  }
  logLine('alert-state-corrupt', `${STATE_PATH.replace(/\s+/g, '-')}-quarantined-to-${quarantine.replace(/\s+/g, '-')}`);
  return { lastScan: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
}

async function main() {
  const state = loadCheckpoint();
  const since = state.lastScan ? new Date(new Date(state.lastScan).getTime() - SCAN_OVERLAP_MS).toISOString() : new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // (2) Retry pending events FIRST — before the journal scan.
  const pendingResult = await retryPending();
  if (pendingResult.stillPending > 0) logLine('alert-pending-retained', `${pendingResult.stillPending}-events-still-pending`, 'warn');
  // (3) Journal scan — FIXED scan boundary (Rev 4.8, F5-30). scanUntil is
  // captured BEFORE invoking journalctl and passed as --until alongside
  // --since, so the query covers exactly [since, scanUntil]. Events timestamped
  // after scanUntil fall into a later scan; events timestamped within the overlap
  // may be recovered on the next run if late-visible; events timestamped before
  // lastScan − 60 s are outside the overlap and are not guaranteed to be recovered.
  // Consecutive scans overlap by 60 s (SCAN_OVERLAP_MS): the next query starts
  // 60 s before the persisted checkpoint (lastScan = scanUntil), so an entry that
  // became visible only after a query — but is timestamped within the 60 s
  // overlap — is still inside the next interval; dedup suppresses the re-scan
  // duplicates. journalctl --output=json gives one JSON object per line; the
  // MESSAGE field carries the canonical key=value line. A journal failure is
  // fatal for THIS run: log, do NOT advance the cursor, exit 1 (the timer
  // retries in 5 min). One bad event never aborts the scan of the rest.
  const scanUntil = new Date().toISOString();
  let journal;
  try {
    journal = execFileSync('journalctl', ['--since', since, '--until', scanUntil, '--output=json', ...UNITS.flatMap((u) => ['-u', u])], { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    logLine('health-check-journal-failed', `journalctl-failed-${encodeFsDetail(e)}`);
    process.exit(1);
  }
  // Units that produced at least one parsed startup event line in this scan
  // window (F5-16): a failed unit WITH an event line is already explained by
  // the event — only a failed unit with NO event line is an anomaly.
  const unitsWithEvents = new Set();
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.MESSAGE;
    if (typeof message !== 'string') continue;
    const result = parseEventLine(message);
    if (!result.ok) {
      // The parser's discriminated result tells the probe exactly which case
      // this is (Rev 4.8 correction, chunk-3 review; classification refined in
      // the follow-up correction): the parser guarantees result.event is
      // non-null exactly when the line's event is registered, so the probe logs
      // health-check-malformed-event-line ONLY when reason is 'malformed' AND
      // result.event is non-null — a malformed line whose event identity could
      // not be established (tokenization failure, missing event field) is never
      // reported as a malformed known event. 'not-an-event-line' and
      // 'unregistered-event' are silently skipped. The probe no longer
      // re-matches the line with its own regex: the old fallback used the same
      // unanchored event= pattern the parser has now abandoned.
      if (result.reason === 'malformed' && result.event !== null) logLine('health-check-malformed-event-line', `${result.event}-${result.detail}`, 'warn');
      continue;
    }
    const parsed = result.parsed;
    if (typeof entry._SYSTEMD_UNIT === 'string') unitsWithEvents.add(entry._SYSTEMD_UNIT);
    // Rev 4.9 §3: a journal-only event is evidence its unit emitted its
    // expected diagnostic (hence the unitsWithEvents update above), but it
    // is NEVER an email candidate — skip it BEFORE pendingKey(),
    // updatePendingState(), or dispatchAlert(), so it never enters durable
    // pending state. (A journal-only entry that DID reach the pending
    // file — e.g. written by an older build — is no longer fatal:
    // validatePendingState loads with allowJournalOnly, removes it, and
    // keeps the emailed entries; see alert-dispatcher.js, O-1.)
    if (JOURNAL_ONLY_EVENTS.includes(parsed.event)) {
      continue;
    }
    // Durable-pending-first (F5-13): persist the event BEFORE dispatching.
    // The pending key is the dedup key for dedupeable events and a unique
    // per-occurrence key for undedupeable events (F5-14). The write goes
    // through the transaction lock (F5-29) against the FRESH pending state, so
    // a concurrent retryPending run's entries are never lost. If this write
    // fails (lock timeout or write error), the probe fails WITHOUT advancing
    // the checkpoint (exit 1) — the event is not lost, the next probe
    // re-scans the same window.
    const key = pendingKey(parsed);
    let persisted;
    let writtenFirstSeen;
    try {
      persisted = updatePendingState((pending) => {
        writtenFirstSeen = pending[key]?.firstSeen ?? new Date().toISOString();
        pending[key] = { event: parsed.event, windowStart: parsed.windowStart ?? null, requestId: parsed.requestId ?? null, ts: parsed.ts ?? null, detail: parsed.detail ?? null, firstSeen: writtenFirstSeen, attempts: (pending[key]?.attempts ?? 0), lastAttempt: new Date().toISOString() };
      });
    } catch (e) {
      logLine('alert-pending-unwritable', `pending-write-failed-${encodeFsDetail(e)}`);
      process.exit(1);
    }
    if (!persisted.ok) {
      logLine('alert-pending-unwritable', `pending-write-failed-${String(persisted.reason).replace(/\s+/g, '-')}`);
      process.exit(1);
    }
    let dispatchResult;
    try {
      dispatchResult = await dispatchAlert(parsed);
    } catch (e) {
      logLine('alert-dispatch-failed', `${parsed.event}-dispatch-threw-${encodeFsDetail(e)}`);
      continue;
    }
    // The dispatch outcome decides the pending entry's fate. sent or duplicate
    // (F5-10) removes it; a failed delivery leaves it for the next probe
    // (attempts incremented). The outcome write goes through the transaction
    // lock (F5-29) against the FRESH pending state and is best-effort: if it
    // fails, the entry stays in the pending file and the next probe's
    // retryPending cleans it up via `duplicate` (the dedup entry is already
    // durable).
    try {
      const outcome = updatePendingState((after) => {
        // Identity guard (F5-29; chunk-5 review, applied here to the probe's
        // own outcome write): the outcome applies only to the entry this scan
        // loop just wrote. firstSeen is the value that write recorded
        // (preserved from an earlier entry, or now). If the entry was replaced
        // or removed under the same key in between, leave the current state
        // untouched — a stale outcome never deletes or increments a different
        // item, and never resurrects a removed one.
        const expected = { event: parsed.event, windowStart: parsed.windowStart ?? null, requestId: parsed.requestId ?? null, ts: parsed.ts ?? null, detail: parsed.detail ?? null, firstSeen: writtenFirstSeen };
        if (!isSamePendingEntry(after[key], expected)) return;
        if (dispatchResult.sent || dispatchResult.reason === 'duplicate') { delete after[key]; }
        else { after[key] = { ...after[key], attempts: (after[key].attempts ?? 0) + 1, lastAttempt: new Date().toISOString() }; }
      });
      if (!outcome.ok) logLine('alert-pending-unwritable', `pending-outcome-write-failed-${String(outcome.reason).replace(/\s+/g, '-')}`);
    } catch (e) {
      logLine('alert-pending-unwritable', `pending-outcome-write-failed-${encodeFsDetail(e)}`);
    }
  }
  // (3b) Runner heartbeat watch (Rev 4.9, F-6a): the standing health check
  // reads the runner heartbeat every 5 minutes. A stale, missing, or failed
  // heartbeat is an outage — the operator alert fires
  // (storage-runner-heartbeat-outage, dedup-bounded: one per distinct
  // lastSuccessfulSweepAt, or one per UTC day when the heartbeat carries no
  // successful timestamp) and the API refuses new submits (§14 Stage 2). A
  // failed delivery is NOT written to pending: the watch re-fires on every
  // probe run while the outage persists, so the next run retries it; the
  // failure is logged as alert-delivery-failed. A healthy heartbeat logs
  // nothing and sends nothing.
  const heartbeat = checkRunnerHeartbeat(RUNNER_HEALTH_PATH);
  if (!heartbeat.healthy) {
    const scope = typeof heartbeat.lastSuccessfulSweepAt === 'string' && heartbeat.lastSuccessfulSweepAt
      ? heartbeat.lastSuccessfulSweepAt
      : new Date().toISOString().slice(0, 10);
    let heartbeatDispatch = null;
    try {
      heartbeatDispatch = await dispatchAlert({
        event: 'storage-runner-heartbeat-outage',
        windowStart: scope,
        requestId: null,
        ts: new Date().toISOString(),
        detail: `runner-heartbeat-${heartbeat.reason}`,
      });
    } catch (e) {
      logLine('alert-dispatch-failed', `storage-runner-heartbeat-outage-dispatch-threw-${encodeFsDetail(e)}`);
    }
    if (heartbeatDispatch && !heartbeatDispatch.sent && heartbeatDispatch.reason !== 'duplicate' && heartbeatDispatch.reason !== 'journal-only') {
      logLine('alert-delivery-failed', `storage-runner-heartbeat-outage-${String(heartbeatDispatch.reason).replace(/\s+/g, '-')}`);
    }
  }
  // (4) Unit states: a unit in failed state with no corresponding event in this
  // scan window is an anomaly for operator review — NOT emailed (the six
  // families are the contract). A systemctl failure here is advisory only: log
  // and continue (the journal scan above is the alert path and is unaffected).
  for (const unit of UNITS) {
    const out = spawnSync('systemctl', ['show', unit, '-p', 'ActiveState,SubState,Result'], { encoding: 'utf8', timeout: 10000 });
    if (out.error || out.status !== 0) { logLine('health-check-systemctl-failed', `${unit}-show-failed`, 'warn'); continue; }
    const show = String(out.stdout || '');
    if (/ActiveState=failed/.test(show) && !unitsWithEvents.has(unit)) logLine('health-check-unit-anomaly', `${unit}-failed-no-event-in-scan-window`, 'warn');
  }
  // (6) Persist the checkpoint as scanUntil EXACTLY (Rev 4.8, F5-30): the
  // checkpoint written by the probe equals the captured scanUntil. The next run
  // queries from lastScan − 60 s (SCAN_OVERLAP_MS), so it re-covers the last
  // 60 s of this interval — an entry that became visible only after this run's
  // query, but is timestamped within the 60 s overlap, is still inside the next
  // interval; dedup suppresses the re-scan duplicates. The overlap covers visibility lag up to 60 s; longer lag is outside this guarantee. A write
  // failure here does NOT lose any delivery: the old checkpoint file is
  // untouched (atomic write), so the next probe re-scans the same window and
  // dedup suppresses re-sends — but the run EXITS 1 (the throw below is caught
  // by main()'s top-level handler), so a successful systemd result is never
  // recorded for a run whose checkpoint did not advance.
  try { writeStateFileAtomic(STATE_PATH, { lastScan: scanUntil }); }
  catch (e) { logLine('alert-checkpoint-unwritable', `checkpoint-write-failed-${encodeFsDetail(e)}`); throw e; }
}

main().catch((e) => {
  // Exit contract: the probe exits ONLY 0 (success) or 1 (any failure — every
  // failure path ends in process.exit(1) or throws into this handler, which
  // exits 1). Exit 99 is RESERVED for lock contention and exit 2 is RESERVED
  // for wrapper infrastructure failures — the probe never exits either
  // (enforced by §15 test (y), which scans this file's process.exit calls).
  logLine('health-check-probe-failed', `probe-threw-${encodeFsDetail(e)}`);
  process.exit(1);
});
