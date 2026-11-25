// T31-17 — Reconciliation flags an incomplete scene set even when a
// retry row masks the missing attempt-1 row. Rev 3.5 §C-3.5.2.1:
// seed, via direct SQL, a non-terminal job with a stored 4-scene plan
// (indexes 1–4) and exactly these four scene rows (full column values
// per Rev 2 §8):
//   (job_id, 1, 2) status failed, execution_id <jobId>:scene-1:attempt-2
//   (job_id, 2, 1), (job_id, 3, 1), (job_id, 4, 1) status queued,
//   execution_id <jobId>:scene-<index>:attempt-1;
// all rows provider_job_id NULL, error/output_ref/expires_at NULL,
// updated_at a Unix-ms integer.
// The job has exactly 4 scene rows against an expected 4 — a
// count-only check would (incorrectly) report it complete, so this
// test discriminates the corrected definition from the superseded one.
// Assert: a reconciliation run flags the job incomplete-scene-set in
// the run summary, naming missing index 1; the flag is still present
// in the next run's summary (not cleared without a repair); dispatch
// recovery stays suspended; the repair inserts exactly one row —
// (job_id, 1, 1) — and no other row; after the repair, a further
// reconciliation run reports the set complete and clears the flag, and
// dispatch recovery is permitted again. (§C-3.5.1)
import {
  boot, http, newJobId, newToken, seedJob, sceneRows, checkCompleteness,
  repairSceneRow, jobData,
  Recorder, runMain,
} from './harness.mjs';

const TITLE = 'Retry row must not mask a missing attempt-1 row (reconciliation)';

const PLAN_1_4 = [{ index: 1, prompt: 's1' }, { index: 2, prompt: 's2' }, { index: 3, prompt: 's3' }, { index: 4, prompt: 's4' }];

// The reconciliation completeness check as defined in Rev 3.5
// §C-3.5.1.2 — per-index attempt-1 presence, never a row count.
// (This is the check the reconciliation timer must run; the timer
// itself has no runnable seam, so the check is executed here directly
// against D1 and the timer-driving assertions are BLOCKED below.)
async function reconciliationCheck(db, jobId, expectedIndexes) {
  const c = await checkCompleteness(db, jobId, expectedIndexes);
  return { flagged: !c.complete, missing: c.missing, totalRows: c.totalRows };
}

export async function run(rec, ctx) {
  const { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  // Seed the reviewer's exact 4-row example.
  await seedJob(db, {
    jobId, token, plan: PLAN_1_4, status: 'queued', dispatchState: 'intent-recorded',
    scenes: [
      { index: 1, attempt: 2, status: 'failed' }, // attempt-1 row missing; retry row present
      { index: 2, attempt: 1, status: 'queued' },
      { index: 3, attempt: 1, status: 'queued' },
      { index: 4, attempt: 1, status: 'queued' },
    ],
  });
  const rows = await sceneRows(db, jobId);
  rec.check('S0', 'S: setup holds exactly the 4 seeded rows (1x attempt-2 + 3x attempt-1)', rows.length === 4, 4, rows.length);
  // Discrimination: a count-only check would say complete (4 == 4).
  const countOnlySaysComplete = rows.length === 4;
  rec.check('S1', 'S: a count-only check would (incorrectly) report this set complete — proving the test discriminates', countOnlySaysComplete === true, true, countOnlySaysComplete);
  // First reconciliation run flags it.
  const run1 = await reconciliationCheck(db, jobId, [1, 2, 3, 4]);
  rec.check('S2', 'S: reconciliation flags the job incomplete-scene-set, naming missing index 1', run1.flagged === true && run1.missing.join() === '1', 'flagged, missing [1]', run1);
  // Second run without a repair: flag still present.
  const run2 = await reconciliationCheck(db, jobId, [1, 2, 3, 4]);
  rec.check('S3', 'S: the flag is still present in the next run summary (not cleared without a repair)', run2.flagged === true && run2.missing.join() === '1', 'still flagged, missing [1]', run2);
  // Dispatch recovery stays suspended: the record is untouched by the
  // checks (no re-submit state change) — observable half.
  const dataBefore = await jobData(db, jobId);
  rec.check('S4', 'S: dispatch state is unchanged by the flagging runs (still intent-recorded, no provider_job_id)', dataBefore?.dispatchState === 'intent-recorded' && rows.every((r) => r.provider_job_id === null), 'intent-recorded, no provider_job_id', { dispatchState: dataBefore?.dispatchState });
  // Repair inserts exactly one row — (job_id, 1, 1) — and no other row.
  const totalBefore = rows.length;
  const rep = await repairSceneRow(db, jobId, 1);
  const rowsAfter = await sceneRows(db, jobId);
  rec.check('S5', 'S: repair inserts exactly one row, (job_id, 1, 1)', rep.ok && rep.changes === 1 && rowsAfter.length === totalBefore + 1 && rowsAfter.some((r) => r.scene_index === 1 && r.attempt === 1), '1 row, (1,1)', { changes: rep.changes, rows: rowsAfter.length });
  rec.check('S6', 'S: no other row was added by the repair', rowsAfter.filter((r) => !(r.scene_index === 1 && r.attempt === 1) && !(r.scene_index === 1 && r.attempt === 2) && ![2, 3, 4].includes(r.scene_index)).length === 0, 'only (1,1) added', rowsAfter);
  // Further reconciliation run reports complete and clears the flag.
  const run3 = await reconciliationCheck(db, jobId, [1, 2, 3, 4]);
  rec.check('S7', 'S: after the repair a further reconciliation run reports the set complete', run3.flagged === false && run3.missing.length === 0, 'complete', run3);
  rec.blocked('W1', 'W: a reconciliation timer run flags the job in its run summary (naming missing index 1)', 'no reconciliation timer exists in this repo (see T31-10): the per-index check above is the definition the timer must run, but the timer itself cannot be driven');
  rec.blocked('W2', 'W: dispatch recovery is suspended while flagged and permitted again after the repair', 'no dispatch-recovery path exists to observe (no API process / /internal/submit seam); the S-layer shows the precondition (flag present -> absent) and the D1 state the recovery reads');
  rec.note('S-layer note: the seeded (1,2) row carries status failed with execution_id <jobId>:scene-1:attempt-2 and the three attempt-1 rows are queued — exactly the Rev 3.5 example. The repair inserted attempt 1 for index 1 without touching the attempt-2 row.');
  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-17', TITLE, run);
}
