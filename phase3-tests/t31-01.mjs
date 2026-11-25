// T31-01 — Concurrent duplicate creation never produces two D1 jobs.
// Rev 3.2 §B-3.2.13 + §B-3.2.1.3 (three-way disambiguation), as amended
// by Rev 3.3 §C-3.3.1.3 (footprint) and Rev 3.4 §C-3.4.1 (marker gate).
// Two concurrent requests, same new jobId, identical credentials and
// content: exactly one job record, one created-job response, one
// existing-job (200) response, no second manager job, one dispatch-
// journal submission. Runs against actual D1 semantics, not mocked
// affected-row counts (§A-3.1.5.3).
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, creationBatch, jobRow, sceneRows, retainedTotal,
  diagnoseLimit, seedJob, seedFiller, Recorder, runMain, sha256Hex,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Concurrent duplicate creation never produces two D1 jobs';

export async function run(rec, ctx) {
  // ---- S-layer: two concurrent creation batches, same jobId (DB truth).
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId();
  const token = newToken();
  const plan = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }];
  const [a, b] = await Promise.all([
    creationBatch(db, { jobId, token, n: 2, planScenes: plan }),
    creationBatch(db, { jobId, token, n: 2, planScenes: plan }),
  ]);
  const created = [a, b].filter((r) => r.ok && r.parentChanges === 1);
  const dupes = [a, b].filter((r) => r.ok && r.parentChanges === 0 && r.row);
  rec.check('S1', 'S: exactly one batch inserted the parent row', created.length === 1, 1, created.length);
  rec.check('S2', 'S: the other batch found the existing row (no-op)', dupes.length === 1, 1, dupes.length);
  rec.check('S3', 'S: both batches completed without a statement error', a.ok && b.ok, true, { a: a.ok, b: b.ok, aErr: a.error, bErr: b.error });
  const rows = await sceneRows(db, jobId);
  rec.check('S4', 'S: exactly one job record exists', (await jobRow(db, jobId)) !== null, true, await retainedTotal(db));
  rec.check('S5', 'S: exactly the 2 scene rows exist, no duplicates', rows.length === 2, 2, rows.length);
  rec.check('S6', 'S: the two batches used different creationTokens (per-attempt marker)', a.creationToken !== b.creationToken, 'different', `${a.creationToken} vs ${b.creationToken}`);
  rec.check('S7', 'S: stored parent carries the winning batch token only', (await jobRow(db, jobId)) && JSON.parse((await jobRow(db, jobId)).data).creationToken === created[0]?.creationToken, created[0]?.creationToken, JSON.parse((await jobRow(db, jobId)).data).creationToken);
  await mf.dispose(); ctx.setMf(null);

  // ---- S-layer: three-way disambiguation (§B-3.2.1.3, footprint-amended).
  ({ mf, db } = await boot({ probe: true })); ctx.setMf(mf);
  // (a) fresh jobId under both limits -> created.
  const jA = newJobId(); const tA = newToken();
  const rA = await creationBatch(db, { jobId: jA, token: tA, n: 1, prompt: 'hello' });
  rec.check('D-a', 'disambiguation (a): fresh jobId under both limits is created', rA.ok && rA.parentChanges === 1 && rA.sceneChanges[0] === 1, 'parent 1, scene 1', rA);
  // (b) duplicate jobId -> existing job, no new row.
  const before = await retainedTotal(db);
  const rB = await creationBatch(db, { jobId: jA, token: tA, n: 1, prompt: 'hello' });
  const after = await retainedTotal(db);
  rec.check('D-b', 'disambiguation (b): duplicate returns existing, no new row', rB.ok && rB.parentChanges === 0 && !!rB.row && after === before, `total ${before}`, `total ${after}, parentChanges ${rB.parentChanges}`);
  // (c) fresh jobId with the active cap reached -> 429, no row.
  const tC = newToken();
  for (let i = 0; i < 3; i++) {
    const r = await creationBatch(db, { jobId: newJobId(), token: tC, n: 1, prompt: `cap ${i}` });
    if (!(r.ok && r.parentChanges === 1)) rec.note(`cap seed ${i} unexpected: ${JSON.stringify(r)}`);
  }
  const jC = newJobId();
  const rC = await creationBatch(db, { jobId: jC, token: tC, n: 1, prompt: 'over cap' });
  const diagC = await diagnoseLimit(db, sha256Hex(tC), 1);
  rec.check('D-c', 'disambiguation (c): 4th active job for a token is refused, no row, limit diagnosed as cap', rC.ok && rC.parentChanges === 0 && !rC.row && diagC === 'cap' && (await jobRow(db, jC)) === null, 'refused + cap', { parentChanges: rC.parentChanges, row: !!rC.row, diag: diagC });
  // (d) fresh jobId at 100,000 retained -> 503 retention-backlog, no row.
  // Seed to exactly 100,000 first (current total is small).
  const cur = await retainedTotal(db);
  await seedFiller(db, 100000 - cur, 0);
  const totalNow = await retainedTotal(db);
  const jD = newJobId();
  const rD = await creationBatch(db, { jobId: jD, token: newToken(), n: 1, prompt: 'at ceiling' });
  const diagD = await diagnoseLimit(db, sha256Hex(newToken()), 1);
  rec.check('D-d', 'disambiguation (d): fresh jobId at 100,000 retained is refused, no row, limit diagnosed as retention', totalNow === 100000 && rD.ok && rD.parentChanges === 0 && !rD.row && diagD === 'retention', 'total 100000, refused, retention', { totalNow, parentChanges: rD.parentChanges, row: !!rD.row, diag: diagD });
  // (e) a batch in which a statement fails -> whole batch rolls back.
  await mf.dispose(); ctx.setMf(null);
  ({ mf, db } = await boot({ probe: true })); ctx.setMf(mf);
  const jE = newJobId();
  let rollbackErr = null;
  try {
    await db.batch([
      db.prepare('INSERT INTO jobs (id, data) VALUES (?, ?)').bind(jE, '{"status":"queued"}'),
      db.prepare('THIS IS NOT VALID SQL'),
    ]);
  } catch (e) { rollbackErr = String(e?.message ?? e); }
  rec.check('D-e', 'disambiguation (e): failed statement rolls the whole batch back (no parent row)', rollbackErr !== null && (await jobRow(db, jE)) === null, 'error + no row', { rollbackErr, row: await jobRow(db, jE) });
  // Duplicate at the retention ceiling still returns the existing job (200-path at DB level).
  const jF = newJobId(); const tF = newToken();
  await seedJob(db, { jobId: jF, token: tF, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const totF = await retainedTotal(db);
  await seedFiller(db, 100000 - totF, 0);
  const rF = await creationBatch(db, { jobId: jF, token: tF, n: 2, planScenes: [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }] });
  rec.check('D-f', 'duplicate at the ceiling: existing job returned, no new row, ceiling does not apply to duplicates', rF.ok && rF.parentChanges === 0 && !!rF.row && (await retainedTotal(db)) === 100000, 'no-op, total 100000', { parentChanges: rF.parentChanges, total: await retainedTotal(db) });
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer: two concurrent POST /api/generate, same jobId,
  // through the controlled-test gate (test key) with the stub API
  // process answering /internal/submit.
  const stub = createStubApi();
  await stub.start();
  try {
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
    const wJob = newJobId(); const wTok = newToken();
    const wBody = generateBodyPlan(wJob, 2);
    const headers = { ...authHeaders(wTok), ...testKeyHeaders() };
    const [w1, w2] = await Promise.all([
      http(mf, 'POST', '/api/generate', { body: wBody, headers }),
      http(mf, 'POST', '/api/generate', { body: wBody, headers }),
    ]);
    const statuses = [w1.status, w2.status].sort();
    const wParent = await jobRow(db, wJob);
    const wScenes = await sceneRows(db, wJob);
    // Core invariants (strict): one D1 job, one scene set, exactly one
    // stub submission per execution, no second manager job.
    const submissions = [0, 1].map((i) => stub.submissionsFor(`${wJob}:scene-${i}:attempt-1`).length);
    rec.check('W1a', 'W: exactly one job record and its 2 scene rows exist in D1 after the race', wParent !== null && wScenes.length === 2, '1 parent, 2 scenes', `parent=${wParent ? 'yes' : 'no'} scenes=${wScenes.length}`);
    rec.check('W1b', 'W: the dispatch journal records exactly one submission per execution (no second manager job)', submissions.join() === '1,1', '1,1', submissions);
    rec.check('W1c', 'W: both requests succeed (202 created and/or 200 existing)', statuses.every((x) => x === 200 || x === 202), 'both 200/202', statuses);
    // Literal T31-01 pair: one 202 + one 200. NOTE — this is in tension
    // with the Rev 3.2 §B-3.2.2.2 recovery path: a concurrent duplicate
    // that reads dispatchState "intent-recorded" is re-submitted and
    // returns 202 (the dispatched job), not 200. The 200 arises only
    // when the winner has already completed mark-submitted before the
    // loser's duplicate path reads the record. The pair is therefore
    // TIMING-DEPENDENT, not deterministic: this check passed [200, 202]
    // in the final suite run and in 6 repeat runs, but failed once
    // earlier the same day with [202, 202] (identical code, all core
    // invariants holding). A [202, 202] outcome with W1a/W1b passing
    // satisfies every no-duplicate invariant but not the literal pair
    // — recorded as a failure of the literal wording when observed,
    // for reviewer clarification, not as a duplicate bug.
    rec.check('W1d', 'W: one request receives the created-job response (202) and the other the existing-job response (200)', statuses[0] === 200 && statuses[1] === 202, '[200, 202]', statuses);
    await mf.dispose(); ctx.setMf(null);
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-01', TITLE, run);
}
