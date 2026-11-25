// T31-15 — Duplicate submission with a complete scene set.
// Rev 3.4 §C-3.4.3: seed a complete job (parent + all 4 scene rows).
// Submit the duplicate creation request (same jobId, same credentials,
// same plan). Assert: response 200 with the existing job; the scene set
// is byte-identical before/after (same rows, same values); retained
// total unchanged; no new rows; the stored parent's creationToken
// differs from the duplicate attempt's token.
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, creationBatch, seedJob, retainedTotal, sceneRows,
  jobData, Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Duplicate submission with a complete scene set';

export async function run(rec, ctx) {
  const plan = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }, { index: 2, prompt: 'Scene 2 prompt' }, { index: 3, prompt: 'Scene 3 prompt' }];
  // ---- S-layer.
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  await seedJob(db, { jobId, token, plan, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }, { index: 2, attempt: 1 }, { index: 3, attempt: 1 }] });
  const totalBefore = await retainedTotal(db);
  const rowsBefore = JSON.stringify(await sceneRows(db, jobId));
  const parentBefore = JSON.stringify(await jobData(db, jobId));
  const dup = await creationBatch(db, { jobId, token, n: 4, planScenes: plan });
  rec.check('S1', 'S: duplicate batch is a complete no-op (parent 0, all scenes 0)', dup.ok && dup.parentChanges === 0 && dup.sceneChanges.join() === '0,0,0,0', '0 / 0,0,0,0', { parentChanges: dup.parentChanges, sceneChanges: dup.sceneChanges });
  rec.check('S2', 'S: scene set is byte-identical before/after', JSON.stringify(await sceneRows(db, jobId)) === rowsBefore, rowsBefore, JSON.stringify(await sceneRows(db, jobId)));
  rec.check('S3', 'S: parent record is byte-identical before/after', JSON.stringify(await jobData(db, jobId)) === parentBefore, 'identical', JSON.stringify(await jobData(db, jobId)) === parentBefore ? 'identical' : 'changed');
  rec.check('S4', 'S: retained total unchanged, no new rows', (await retainedTotal(db)) === totalBefore, totalBefore, await retainedTotal(db));
  rec.check('S5', 'S: stored creationToken differs from the duplicate attempt token', JSON.parse(parentBefore).creationToken !== dup.creationToken, 'different', `${JSON.parse(parentBefore).creationToken} vs ${dup.creationToken}`);
  rec.check('S6', 'S: the read-back row exists (duplicate path returns the existing job)', !!dup.row, 'row present', !!dup.row);
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer. The seeded job is dispatchState "submitted" (already
  // dispatched): the duplicate path returns 200 directly, with no
  // re-submit (Rev 3.2 §B-3.2.2.2 — recovery applies to
  // intent-recorded jobs only).
  const stub = createStubApi();
  await stub.start();
  try {
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
    const wJob = newJobId(); const wTok = newToken();
    await seedJob(db, { jobId: wJob, token: wTok, plan, dispatchState: 'submitted', scenes: [
      { index: 0, attempt: 1, providerJobId: 'mgr-0' }, { index: 1, attempt: 1, providerJobId: 'mgr-1' },
      { index: 2, attempt: 1, providerJobId: 'mgr-2' }, { index: 3, attempt: 1, providerJobId: 'mgr-3' },
    ] });
  const wRowsBefore = JSON.stringify(await sceneRows(db, wJob));
  const wTotalBefore = await retainedTotal(db);
  const w = await http(mf, 'POST', '/api/generate', { body: generateBodyPlan(wJob, 4), headers: { ...authHeaders(wTok), ...testKeyHeaders() } });
  if (w.status === 404) {
    rec.blocked('W1', 'W: duplicate with a complete scene set returns 200 with the existing job, set unchanged', `POST /api/generate is not implemented (HTTP 404 ${w.text.slice(0, 120)})`);
  } else {
    rec.check('W1', 'W: duplicate with a complete scene set returns 200', w.status === 200, 200, { status: w.status, body: w.text.slice(0, 200) });
    rec.check('W2', 'W: scene set is byte-identical before/after', JSON.stringify(await sceneRows(db, wJob)) === wRowsBefore, wRowsBefore, JSON.stringify(await sceneRows(db, wJob)));
    rec.check('W3', 'W: retained total unchanged', (await retainedTotal(db)) === wTotalBefore, wTotalBefore, await retainedTotal(db));
    rec.check('W4', 'W: no re-submit was attempted for the already-submitted job (stub journal empty)', stub.journal.length === 0, '0 submissions', stub.journal.length);
  }
    await mf.dispose(); ctx.setMf(null);
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-15', TITLE, run);
}
