// T31-16 — Scene-set repair preserves the ceiling.
// Rev 3.4 §C-3.4.3 + §C-3.4.2.2 (repair-scene-row mutation, one guarded
// row per batch, in ascending index order, with verification):
//   (i) incomplete job below the ceiling (2 of 4 rows): repair inserts
//       exactly the 2 missing rows, set complete, total +2,
//       scene-set-repaired entry, dispatch recovery permitted again.
//   (ii) incomplete job at the ceiling (100,000, 2 rows missing):
//       repair inserts nothing, job stays flagged incomplete,
//       scene-set-repair-refused entry, total still 100,000.
//   (iii) repair idempotence: run twice; missing rows inserted once.
import {
  boot, http, newJobId, newToken, authHeaders, generateBodyPlan,
  seedFiller, seedJob, retainedTotal, sceneRows, checkCompleteness,
  repairSceneRow, jobData, signInternalCall, TEST_API_SECRET,
  Recorder, runMain,
} from './harness.mjs';

const TITLE = 'Scene-set repair preserves the ceiling';

const PLAN = [{ index: 0, prompt: 's0' }, { index: 1, prompt: 's1' }, { index: 2, prompt: 's2' }, { index: 3, prompt: 's3' }];

async function repairProcedure(db, jobId, expectedIndexes) {
  // The operator procedure (§C-3.4.2.2): fresh read, one guarded row
  // per missing index ascending, stop at the first refusal, verify.
  const before = await checkCompleteness(db, jobId, expectedIndexes);
  const inserted = [];
  let refused = false;
  for (const idx of before.missing) {
    const r = await repairSceneRow(db, jobId, idx);
    if (!r.ok) { refused = true; break; }
    if (r.changes === 0) { refused = true; break; } // ceiling or already present
    inserted.push(idx);
  }
  const after = await checkCompleteness(db, jobId, expectedIndexes);
  return { before, inserted, refused, after };
}

export async function run(rec, ctx) {
  // ---- (i) below the ceiling.
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobA = newJobId(); const tokA = newToken();
  await seedJob(db, { jobId: jobA, token: tokA, plan: PLAN, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const totalA0 = await retainedTotal(db);
  const repA = await repairProcedure(db, jobA, [0, 1, 2, 3]);
  rec.check('i-S1', 'S-(i): repair inserts exactly the 2 missing rows (indexes 2, 3)', repA.inserted.join() === '2,3', '2,3', repA.inserted);
  rec.check('i-S2', 'S-(i): scene set is complete after repair', repA.after.complete === true && repA.after.missing.length === 0, 'complete', repA.after);
  rec.check('i-S3', 'S-(i): retained total increased by exactly 2', (await retainedTotal(db)) === totalA0 + 2, totalA0 + 2, await retainedTotal(db));
  rec.check('i-S4', 'S-(i): exactly 4 scene rows exist, no duplicates', (await sceneRows(db, jobA)).length === 4, 4, (await sceneRows(db, jobA)).length);
  // (iii) idempotence: run the repair again on the now-complete job,
  // and run it twice on a still-incomplete job.
  const repA2 = await repairProcedure(db, jobA, [0, 1, 2, 3]);
  rec.check('iii-S1', 'S-(iii): re-running repair on a complete job inserts nothing', repA2.inserted.length === 0 && repA2.after.complete, 'nothing inserted', repA2.inserted);
  const jobB = newJobId(); const tokB = newToken();
  await seedJob(db, { jobId: jobB, token: tokB, plan: PLAN, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const repB1 = await repairProcedure(db, jobB, [0, 1, 2, 3]);
  const repB2 = await repairProcedure(db, jobB, [0, 1, 2, 3]);
  rec.check('iii-S2', 'S-(iii): running repair twice inserts the missing rows exactly once', repB1.inserted.join() === '2,3' && repB2.inserted.length === 0 && (await sceneRows(db, jobB)).length === 4, '2,3 then none; 4 rows', { first: repB1.inserted, second: repB2.inserted, rows: (await sceneRows(db, jobB)).length });
  await mf.dispose(); ctx.setMf(null);

  // ---- (ii) at the ceiling.
  ({ mf, db } = await boot({ probe: true })); ctx.setMf(mf);
  const jobC = newJobId(); const tokC = newToken();
  await seedFiller(db, 50000, 49997); // 99,997
  await seedJob(db, { jobId: jobC, token: tokC, plan: PLAN, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] }); // +3 = 100,000
  const totalC0 = await retainedTotal(db);
  rec.check('ii-S0', 'S-(ii): setup total is exactly 100,000 with 2 rows missing', totalC0 === 100000, 100000, totalC0);
  const repC = await repairProcedure(db, jobC, [0, 1, 2, 3]);
  rec.check('ii-S1', 'S-(ii): repair at the ceiling inserts no new rows', repC.inserted.length === 0 && repC.refused === true, 'refused, none inserted', repC.inserted);
  rec.check('ii-S2', 'S-(ii): job stays flagged incomplete (missing indexes 2, 3)', repC.after.complete === false && repC.after.missing.join() === '2,3', 'missing 2,3', repC.after.missing);
  rec.check('ii-S3', 'S-(ii): retained total is still exactly 100,000', (await retainedTotal(db)) === 100000, 100000, await retainedTotal(db));
  rec.check('ii-S4', 'S-(ii): scene set is exactly the original 2 rows', (await sceneRows(db, jobC)).length === 2, 2, (await sceneRows(db, jobC)).length);
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer: /internal/d1-apply repair-scene-row mutation, signed
  // per §11 (X-NOVA-API-SECRET + HMAC signature + timestamp + nonce).
  // The Worker is bound with the test secret so verification can pass.
  ({ mf, db } = await boot({ bindings: { NOVA_API_SECRET: TEST_API_SECRET } })); ctx.setMf(mf);
  const jobD = newJobId(); const tokD = newToken();
  await seedJob(db, { jobId: jobD, token: tokD, plan: PLAN, scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
  const applyBody = { requestId: 'test-repair-1', mutations: [{ type: 'repair-scene-row', jobId: jobD, sceneIndex: 2 }] };
  const applyText = JSON.stringify(applyBody);
  // Unsigned call first: must be 401 and touch nothing (§C-1.1).
  const wUnsigned = await http(mf, 'POST', '/internal/d1-apply', { rawBody: applyText, contentType: 'application/json' });
  rec.check('W0', 'W: unsigned /internal/d1-apply is rejected with 401 and touches nothing', wUnsigned.status === 401 && (await sceneRows(db, jobD)).length === 2, '401, 2 rows', { status: wUnsigned.status, rows: (await sceneRows(db, jobD)).length });
  const w = await http(mf, 'POST', '/internal/d1-apply', { rawBody: applyText, contentType: 'application/json', headers: signInternalCall(TEST_API_SECRET, 'POST', '/internal/d1-apply', applyText) });
  if (w.status === 404) {
    rec.blocked('W1', 'W: repair-scene-row mutation via /internal/d1-apply inserts the missing row', `POST /internal/d1-apply is not implemented (HTTP 404 ${w.text.slice(0, 120)})`);
  } else {
    rec.check('W1', 'W: signed repair-scene-row mutation inserts exactly the named row', (await sceneRows(db, jobD)).some((r) => r.scene_index === 2 && r.attempt === 1), 'row (2,1) present', await sceneRows(db, jobD));
    rec.check('W2', 'W: the signed call itself succeeds (2xx)', w.status >= 200 && w.status < 300, '2xx', { status: w.status, body: w.text.slice(0, 200) });
  }
  rec.note('W: the scene-set-repaired / scene-set-repair-refused operator-log entries need the operator log (no seam in this harness); "dispatch recovery is permitted again" needs the API process re-submit path (see T31-02/T31-16(i) S-layer: after the repair the set verifies complete, which is the precondition for recovery resuming).');
  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-16', TITLE, run);
}
