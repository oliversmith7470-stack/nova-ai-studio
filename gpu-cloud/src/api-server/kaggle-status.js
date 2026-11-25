// NOVA AI Studio — Phase 3 API process: authoritative Kaggle status mapping.
//
// Rev 3.2 §B-3.2.3.3 defines getExecutionState with exactly six states:
// never-received, accepted, running, completed, failed, unknown.
// The wire vocabulary was verified live by the proofs workstream (Kaggle
// CLI, 25 Nov 2026): the prefixed enum `KernelWorkerStatus.*` with SEVEN
// members — QUEUED, RUNNING, COMPLETE, ERROR, CANCEL_REQUESTED,
// CANCEL_ACKNOWLEDGED, NEW_SCRIPT. The design assumes bare
// QUEUED/RUNNING/COMPLETE/ERROR; this module is the AUTHORITATIVE mapping
// at the source (where the Kaggle query executes). The Worker carries a
// defence-in-depth copy (normalizeExecutorState + KAGGLE_STATUS_MAP in
// _worker.js); the two tables MUST agree. Any change here must be mirrored
// there, and vice versa.
//
// Mapping (fail-closed — an unknown or cancel state is never treated as
// accepted, and never treated as failed unless it is definitively
// terminal):
//   QUEUED             -> accepted   (capacity committed, queued)
//   RUNNING            -> running
//   COMPLETE           -> completed (finished; still awaits its fileReport
//                          to finalise — a completed status NEVER finalises
//                          a job on its own)
//   ERROR              -> failed
//   CANCEL_REQUESTED   -> unknown    (cancel in flight; execution may still
//                          run — NOT failed, NOT accepted)
//   CANCEL_ACKNOWLEDGED -> failed   (reason: executor-cancelled — the
//                          platform acknowledged the cancellation, so the
//                          execution will not run; definitive terminal
//                          non-success)
//   NEW_SCRIPT         -> unknown    (received, not yet queued; mapping it
//                          to never-received would wrongly fail a job that
//                          may still queue)
//   anything else / absent -> unknown (fail-closed default)

export const KAGGLE_STATUS_MAP = Object.freeze({
  QUEUED: 'accepted',
  RUNNING: 'running',
  COMPLETE: 'completed',
  ERROR: 'failed',
  CANCEL_REQUESTED: 'unknown',
  CANCEL_ACKNOWLEDGED: 'failed',
  NEW_SCRIPT: 'unknown',
});

export const EXECUTION_STATES = Object.freeze([
  'never-received',
  'accepted',
  'running',
  'completed',
  'failed',
  'unknown',
]);

const PREFIX = 'KernelWorkerStatus.';

// Strip the prefix (if present) and normalise. Returns one of the six
// getExecutionState states. Never throws; unparseable input is unknown.
export function normalizeExecutorState(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  let value = raw;
  if (value.startsWith(PREFIX)) value = value.slice(PREFIX.length);
  value = value.toUpperCase();
  return KAGGLE_STATUS_MAP[value] || 'unknown';
}

// The failure reason for a definitively-cancelled execution, or null.
// Only CANCEL_ACKNOWLEDGED carries it — CANCEL_REQUESTED is unknown, not
// a failure.
export function kaggleCancelReason(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw;
  if (value.startsWith(PREFIX)) value = value.slice(PREFIX.length);
  return value.toUpperCase() === 'CANCEL_ACKNOWLEDGED'
    ? 'executor-cancelled'
    : null;
}

// Map one status-query result onto a getExecutionState answer.
// `query` is the raw wire value (or null/absent when the executor reports
// no such execution), `queryError` is set when the query itself could not
// be performed (network, CLI unavailable, API error).
//   - queryError            -> { state: 'unknown' } (never guessed)
//   - query === null/absent -> { state: 'never-received' }
//   - otherwise             -> mapped state, with the raw wire value kept
//                              as evidence.
// A `completed` state is returned as-is: the caller must NOT finalise on
// it — the job stays awaiting its fileReport until the report is filed or
// the job timeout fires (Rev 3.2 §B-3.2.3.2).
export function mapStatusQuery({ raw = null, queryError = null } = {}) {
  if (queryError !== null && queryError !== undefined) {
    return {
      state: 'unknown',
      evidence: { raw: raw ?? null, queryError: String(queryError) },
    };
  }
  if (raw === null || raw === undefined || raw === '') {
    return { state: 'never-received', evidence: { raw: null } };
  }
  const state = normalizeExecutorState(raw);
  return { state, evidence: { raw } };
}

// Adapter for a status-query function: statusFn(executionId) resolves to
// the raw wire value (a `KernelWorkerStatus.*` string), null when the
// executor knows no such execution, or rejects when the query itself
// fails. Returns the six-state answer. The fileReport channel is NEVER
// a status source — it is not consulted here.
export async function queryExecutionState(statusFn, executionId) {
  try {
    const raw = await statusFn(executionId);
    return mapStatusQuery({ raw: raw ?? null });
  } catch (err) {
    return mapStatusQuery({ queryError: err });
  }
}
