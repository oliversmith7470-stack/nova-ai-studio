// T31-14 — Fresh creation where an expected scene insertion conflicts:
// the entire creation rolls back. Rev 3.4 §C-3.4.3 as amended by Rev 3.5
// §C-3.5.3.2: pre-seed one orphan scene row via direct SQL (full row
// per Rev 2 §8: job_id = a fresh jobId with no parent row, scene_index
// 1, attempt 1, execution_id <jobId>:scene-1:attempt-1, provider_job_id
// NULL, status queued, error/output_ref/expires_at NULL, updated_at a
// Unix-ms integer; retained total well below 100,000, cap not reached).
// Submit a fresh 4-scene creation for that jobId. Assert: the batch
// fails with a statement error (PRIMARY KEY violation on scenes); no
// parent row exists afterwards; no NEW scene rows were created (the
// pre-seeded orphan remains exactly as seeded); response 500; no
// manager job created; no dispatch; retained total unchanged apart
// from the pre-seeded row.
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, creationBatch, retainedTotal, sceneRows, jobRow,
  Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Fresh creation with a conflicting scene insert rolls back entirely';

export async function run(rec, ctx) {
  // ---- S-layer.
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  const now = Date.now();
  const orphan = { job_id: jobId, scene_index: 1, attempt: 1, execution_id: `${jobId}:scene-1:attempt-1`, provider_job_id: null, status: 'queued', error: null, output_ref: null, expires_at: null, updated_at: now };
  await db.prepare('INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(orphan.job_id, orphan.scene_index, orphan.attempt, orphan.execution_id, orphan.provider_job_id, orphan.status, orphan.error, orphan.output_ref, orphan.expires_at, orphan.updated_at).run();
  const totalBefore = await retainedTotal(db);
  const orphanBefore = JSON.stringify(await sceneRows(db, jobId));
  const plan = [{ index: 0, prompt: 's0' }, { index: 1, prompt: 's1' }, { index: 2, prompt: 's2' }, { index: 3, prompt: 's3' }];
  const result = await creationBatch(db, { jobId, token, n: 4, planScenes: plan });
  rec.check('S1', 'S: the creation batch fails with a statement error', result.ok === false && /PRIMARY KEY|UNIQUE constraint/i.test(result.error ?? ''), 'PRIMARY KEY / UNIQUE violation', result.error);
  rec.check('S2', 'S: no parent row exists afterwards', (await jobRow(db, jobId)) === null, 'no parent', await jobRow(db, jobId));
  rec.check('S3', 'S: no NEW scene rows were created (pre-seeded orphan remains exactly as seeded)', JSON.stringify(await sceneRows(db, jobId)) === orphanBefore, orphanBefore, JSON.stringify(await sceneRows(db, jobId)));
  rec.check('S4', 'S: retained total is unchanged apart from the pre-seeded row', (await retainedTotal(db)) === totalBefore, totalBefore, await retainedTotal(db));
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer (stub API configured so the gate + origin checks pass;
  // the batch itself throws before any submit is attempted).
  const stub = createStubApi();
  await stub.start();
  try {
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
  const wJob = newJobId(); const wTok = newToken();
  await db.prepare('INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(wJob, 1, 1, `${wJob}:scene-1:attempt-1`, null, 'queued', null, null, null, Date.now()).run();
  const wTotalBefore = await retainedTotal(db);
  const w = await http(mf, 'POST', '/api/generate', { body: generateBodyPlan(wJob, 4), headers: { ...authHeaders(wTok), ...testKeyHeaders() } });
  if (w.status === 404) {
    rec.blocked('W1', 'W: fresh creation with a conflicting scene insert returns 500, no parent, no new scenes, no dispatch', `POST /api/generate is not implemented (HTTP 404 ${w.text.slice(0, 120)})`);
  } else {
    rec.check('W1', 'W: conflicting fresh creation returns 500', w.status === 500, 500, { status: w.status, body: w.text.slice(0, 200) });
    rec.check('W2', 'W: no parent row exists afterwards', (await jobRow(db, wJob)) === null, 'no parent', await jobRow(db, wJob));
    rec.check('W3', 'W: no new scene rows were created', (await sceneRows(db, wJob)).length === 1, 1, (await sceneRows(db, wJob)).length);
    rec.check('W4', 'W: retained total unchanged apart from the pre-seeded row', (await retainedTotal(db)) === wTotalBefore, wTotalBefore, await retainedTotal(db));
  }
  rec.check('W5', 'W: no manager job was created (stub journal is empty — no submit was attempted)', stub.journal.length === 0, '0 submissions', stub.journal.length);
    await mf.dispose(); ctx.setMf(null);
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-14', TITLE, run);
}
