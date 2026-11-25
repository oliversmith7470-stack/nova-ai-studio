// T31-04 — Late acknowledgement handled idempotently.
// Rev 3.2 §B-3.2.8.2: the executor acknowledges after the 60-second
// window and after reconciliation has marked the job failed
// (no-such-job): the late acknowledgement does not change the job's
// state, is recorded in lateReports with its execution ID, and does not
// cause a second execution.
//
// The executor-acknowledgement path (getExecutionState, reconciliation
// timer, lateReports for executor acks) has NO runnable implementation
// in this repo, so the end-to-end assertions are BLOCKED with evidence.
// What CAN run is the D1 half: the §C-1.3 terminal-state guard, which
// is the mechanism that stops a late report overwriting a terminal
// scene state.
import {
  boot, newJobId, newToken, seedJob, sceneRows, jobData,
  Recorder, runMain, seamPresent,
} from './harness.mjs';

const TITLE = 'Late acknowledgement handled idempotently';

export async function run(rec, ctx) {
  // ---- Evidence: no late-acknowledgement seam exists.
  // (The Worker now contains the string "executor-accepted" as a
  // dispatchState value and a normalizeExecutorState() mapping table,
  // but no getExecutionState function and no late-ack handler: the
  // executor-acknowledgement path itself is still unimplemented.)
  const seam = seamPresent(/function getExecutionState|lateReports/);
  rec.note(`seam probe: getExecutionState/lateReports implementation in ${seam ?? 'nothing in _worker.js or gpu-cloud/src (manager lateReports is for cancel reports, not executor acks)'}`);
  rec.blocked('W1', 'W: late acknowledgement after a terminal failed decision leaves the job failed and is recorded in lateReports', 'no executor acknowledgement path exists in this repo: no getExecutionState, no reconciliation timer, no /internal/submit; the late-ack case cannot be driven');
  rec.blocked('W2', 'W: late acknowledgement causes no second execution', 'same missing seam as W1');

  // ---- S-layer: the terminal-state guard (§C-1.3) at the D1 level.
  const { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  await seedJob(db, {
    jobId, token, status: 'failed', dispatchState: 'submitted',
    scenes: [{ index: 0, attempt: 1, status: 'failed' }],
  });
  const before = await sceneRows(db, jobId);
  const beforeParent = await jobData(db, jobId);
  // A late "succeeded" report for the terminal scene, via the exact
  // §C-1.3 conditional update: must change nothing.
  const res = await db.batch([
    db.prepare(`UPDATE scenes SET status = ?, error = ?, output_ref = ?, expires_at = ?, updated_at = ? WHERE job_id = ? AND scene_index = ? AND attempt = ? AND status NOT IN ('succeeded','failed','timed-out','cancelled')`)
      .bind('succeeded', null, 'late-output-ref', Date.now() + 86400000, Date.now(), jobId, 0, 1),
  ]);
  const after = await sceneRows(db, jobId);
  const afterParent = await jobData(db, jobId);
  rec.check('S1', 'S: late report against a terminal scene row changes nothing (guard blocks it)', (res[0]?.meta?.changes ?? null) === 0 && JSON.stringify(after) === JSON.stringify(before), 'changes 0, row identical', { changes: res[0]?.meta?.changes, identical: JSON.stringify(after) === JSON.stringify(before) });
  rec.check('S2', 'S: parent aggregate is unchanged by the late report', afterParent?.status === beforeParent?.status, beforeParent?.status, afterParent?.status);
  rec.note('S1–S2 prove the D1 guard only. The lateReports recording and the no-second-execution guarantee at the manager level need the executor-ack path (T31-03/T31-05 seams) and stay BLOCKED.');
  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-04', TITLE, run);
}
