// T31-13 — Duplicate jobId with an incomplete scene set at the
// retention ceiling. Rev 3.4 §C-3.4.3: seed the tables to 100,000
// retained rows including a job with only 2 of its 4 scene rows.
// Submit the duplicate creation request (same jobId, same credentials,
// same plan). Assert: response 200 with the existing job; retained
// total still exactly 100,000; the job's scene set is exactly the
// original 2 rows (byte-identical before/after); an
// incomplete-scene-set alert is recorded; the stored parent's
// creationToken differs from the duplicate attempt's token (the marker
// gate is what made the scene inserts no-ops); no dispatch recovery is
// attempted for the job.
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, creationBatch, seedFiller, seedJob, retainedTotal,
  sceneRows, jobData, Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Duplicate jobId with an incomplete scene set at the retention ceiling';

export async function run(rec, ctx) {
  // ---- S-layer.
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  const plan = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }, { index: 2, prompt: 'Scene 2 prompt' }, { index: 3, prompt: 'Scene 3 prompt' }];
  // Seed filler to 99,997, then the incomplete job (1 parent + 2 scenes)
  // brings the total to exactly 100,000.
  await seedFiller(db, 50000, 49997);
  const seeded = await seedJob(db, { jobId, token, plan, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const totalSeeded = await retainedTotal(db);
  rec.check('S0', 'S: setup total is exactly 100,000 with the job holding 2 of 4 scenes', totalSeeded === 100000 && (await sceneRows(db, jobId)).length === 2, '100000, 2 scenes', { totalSeeded, scenes: (await sceneRows(db, jobId)).length });
  const beforeRows = JSON.stringify(await sceneRows(db, jobId));
  const beforeParent = JSON.stringify(await jobData(db, jobId));
  const dup = await creationBatch(db, { jobId, token, n: 4, planScenes: plan });
  const afterRows = JSON.stringify(await sceneRows(db, jobId));
  const afterParent = JSON.stringify(await jobData(db, jobId));
  rec.check('S1', 'S: duplicate batch is a complete no-op (parent 0, all scenes 0)', dup.ok && dup.parentChanges === 0 && dup.sceneChanges.join() === '0,0,0,0', '0 / 0,0,0,0', { parentChanges: dup.parentChanges, sceneChanges: dup.sceneChanges });
  rec.check('S2', 'S: retained total is still exactly 100,000', (await retainedTotal(db)) === 100000, 100000, await retainedTotal(db));
  rec.check('S3', 'S: scene set is byte-identical before/after (same rows, same values, no new rows)', afterRows === beforeRows, beforeRows, afterRows);
  rec.check('S4', 'S: parent record is byte-identical before/after (no modification)', afterParent === beforeParent, 'identical', afterParent === beforeParent ? 'identical' : `${beforeParent} -> ${afterParent}`);
  rec.check('S5', 'S: stored creationToken differs from the duplicate attempt token (marker gate did the work)', JSON.parse(beforeParent).creationToken !== dup.creationToken, 'different', `${JSON.parse(beforeParent).creationToken} vs ${dup.creationToken}`);
  rec.check('S6', 'S: the read-back row exists (duplicate path returns the existing job)', !!dup.row, 'row present', !!dup.row);
  rec.note('S: the incomplete-scene-set alert is an operator-log entry — no operator log exists in this harness, so the alert itself cannot be observed; the no-modification assertions above are the observable half. Dispatch recovery suspension (no re-submit) needs the API process; see T31-16 note.');
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer (stub API configured so the gate + origin checks pass;
  // the duplicate returns 200 from the incomplete-set branch, before
  // any submit is attempted).
  const stub = createStubApi();
  await stub.start();
  try {
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
  const wJob = newJobId(); const wTok = newToken();
  await seedFiller(db, 50000, 49997);
  await seedJob(db, { jobId: wJob, token: wTok, plan, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const wBefore = JSON.stringify(await sceneRows(db, wJob));
  const w = await http(mf, 'POST', '/api/generate', { body: generateBodyPlan(wJob, 4), headers: { ...authHeaders(wTok), ...testKeyHeaders() } });
  if (w.status === 404) {
    rec.blocked('W1', 'W: duplicate at the ceiling returns 200 with the existing job, scene set unchanged', `POST /api/generate is not implemented (HTTP 404 ${w.text.slice(0, 120)})`);
  } else {
    rec.check('W1', 'W: duplicate at the ceiling returns 200 with the existing job', w.status === 200, 200, { status: w.status, body: w.text.slice(0, 200) });
    rec.check('W2', 'W: scene set is byte-identical before/after the duplicate', JSON.stringify(await sceneRows(db, wJob)) === wBefore, wBefore, JSON.stringify(await sceneRows(db, wJob)));
    rec.check('W3', 'W: retained total is still exactly 100,000', (await retainedTotal(db)) === 100000, 100000, await retainedTotal(db));
  }
    await mf.dispose(); ctx.setMf(null);
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-13', TITLE, run);
}
