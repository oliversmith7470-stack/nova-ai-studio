// T31-02 — Crash after D1 insertion is recovered.
// Rev 3.2 §B-3.2.2.2/§B-3.2.2.3: the Worker creates the D1 record, the
// submit never happens (simulated crash); the client retries with the
// same jobId; the job is dispatched exactly once, the D1 record ends
// dispatchState "submitted" with provider_job_id set, and the client
// receives the dispatched job — not a dead record.
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, creationBatch, markSubmitted, jobData, sceneRows,
  jobRow, seedJob, Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Crash after D1 insertion is recovered';

export async function run(rec, ctx) {
  // ---- S-layer: the D1 state machine for crash + retry recovery.
  let { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  const jobId = newJobId(); const token = newToken();
  const plan = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }];
  // Step 1 — creation succeeds, submit never happens (simulated crash).
  const created = await creationBatch(db, { jobId, token, n: 2, planScenes: plan });
  rec.check('S1', 'S: creation batch inserted parent + 2 scenes', created.ok && created.parentChanges === 1 && created.sceneChanges.join() === '1,1', created);
  let data = await jobData(db, jobId);
  rec.check('S2', 'S: record is intent-recorded with no provider_job_id (submit never happened)', data?.dispatchState === 'intent-recorded' && (await sceneRows(db, jobId)).every((r) => r.provider_job_id === null), { dispatchState: data?.dispatchState, scenes: await sceneRows(db, jobId) });
  // Step 2 — client retry with the same jobId: duplicate path must NOT
  // return the record as dispatched and must NOT modify it.
  const retry = await creationBatch(db, { jobId, token, n: 2, planScenes: plan });
  data = await jobData(db, jobId);
  rec.check('S3', 'S: duplicate path is a no-op — record still intent-recorded, scene set untouched', retry.ok && retry.parentChanges === 0 && retry.sceneChanges.join() === '0,0' && data?.dispatchState === 'intent-recorded' && (await sceneRows(db, jobId)).length === 2, { parentChanges: retry.parentChanges, sceneChanges: retry.sceneChanges, dispatchState: data?.dispatchState });
  // Step 3 — recovery completes the submit: mark-submitted transitions
  // one-way and sets provider_job_id idempotently.
  const marked = await markSubmitted(db, jobId, [
    { sceneIndex: 0, attempt: 1, providerJobId: 'mgr-job-0' },
    { sceneIndex: 1, attempt: 1, providerJobId: 'mgr-job-1' },
  ]);
  data = await jobData(db, jobId);
  const scenes = await sceneRows(db, jobId);
  rec.check('S4', 'S: mark-submitted moves intent-recorded -> submitted and sets provider_job_id', marked.jobChanges === 1 && data?.dispatchState === 'submitted' && scenes.map((r) => r.provider_job_id).join() === 'mgr-job-0,mgr-job-1', { marked, dispatchState: data?.dispatchState, providerJobIds: scenes.map((r) => r.provider_job_id) });
  const marked2 = await markSubmitted(db, jobId, [
    { sceneIndex: 0, attempt: 1, providerJobId: 'mgr-job-0' },
    { sceneIndex: 1, attempt: 1, providerJobId: 'mgr-job-1' },
  ]);
  rec.check('S5', 'S: second mark-submitted is a no-op (dispatchState guard + provider_job_id IS NULL guard)', marked2.jobChanges === 0 && marked2.sceneChanges.join() === '0,0', marked2);
  // mark-submitted with an unknown job ID is rejected and touches nothing.
  const totalBefore = (await sceneRows(db, jobId)).length;
  const unknown = await markSubmitted(db, newJobId(), [{ sceneIndex: 0, attempt: 1, providerJobId: 'mgr-x' }]);
  rec.check('S6', 'S: mark-submitted for an unknown job ID touches nothing', unknown.jobChanges === 0 && unknown.sceneChanges[0] === 0 && (await sceneRows(db, jobId)).length === totalBefore, unknown);
  await mf.dispose(); ctx.setMf(null);

  // ---- W-layer: seed an intent-recorded job, retry via HTTP with
  // the stub API process answering /internal/submit (recovery path 1).
  const wPlan = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }];
  const stub = createStubApi();
  await stub.start();
  try {
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
    const wJob = newJobId(); const wTok = newToken();
    await seedJob(db, { jobId: wJob, token: wTok, plan: wPlan, dispatchState: 'intent-recorded', scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
    const headers = { ...authHeaders(wTok), ...testKeyHeaders() };
    const w = await http(mf, 'POST', '/api/generate', { body: generateBodyPlan(wJob, 2), headers });
    const wData = await jobData(db, wJob);
    const wScenes = await sceneRows(db, wJob);
    rec.check('W1', 'W: client retry of an intent-recorded job returns the dispatched job (202, slot-claimed)', w.status === 202 && (w.json?.dispatchState === 'slot-claimed' || w.json?.dispatchState === 'executor-accepted'), { status: 202, dispatchState: 'slot-claimed' }, { status: w.status, body: w.text.slice(0, 300) });
    rec.check('W2', 'W: after recovery the D1 record is submitted with provider_job_id set on both scenes', wData?.dispatchState === 'submitted' && wScenes.every((r) => r.provider_job_id !== null), { dispatchState: 'submitted', providerJobIds: 'both set' }, { dispatchState: wData?.dispatchState, providerJobIds: wScenes.map((r) => r.provider_job_id) });
    rec.check('W3', 'W: the job was dispatched exactly once (one stub submission per execution)', [0, 1].every((i) => stub.submissionsFor(`${wJob}:scene-${i}:attempt-1`).length === 1), '1 submission per execution', [0, 1].map((i) => stub.submissionsFor(`${wJob}:scene-${i}:attempt-1`).length));
    await mf.dispose(); ctx.setMf(null);

    // Lost-response case (§A-3.1.2.3): the submit's response is dropped
    // AFTER the stub created the manager jobs. The Worker must resolve
    // via the execution-level status lookup — never blindly re-submit.
    stub.setFailMode('drop');
    ({ mf, db } = await boot({ api: stub })); ctx.setMf(mf);
    const wJob2 = newJobId(); const wTok2 = newToken();
    await seedJob(db, { jobId: wJob2, token: wTok2, plan: wPlan, dispatchState: 'intent-recorded', scenes: [{ index: 0, attempt: 1 }, { index: 1, attempt: 1 }] });
    const w2 = await http(mf, 'POST', '/api/generate', { body: generateBodyPlan(wJob2, 2), headers: { ...authHeaders(wTok2), ...testKeyHeaders() } });
    const wData2 = await jobData(db, wJob2);
    rec.check('W4', 'W: lost submit response still resolves to 202 via the status lookup (no blind re-submit)', w2.status === 202, 202, { status: w2.status, body: w2.text.slice(0, 300) });
    rec.check('W5', 'W: lost-response job ends submitted with provider_job_id set, exactly one submission per execution', wData2?.dispatchState === 'submitted' && [0, 1].every((i) => stub.submissionsFor(`${wJob2}:scene-${i}:attempt-1`).length === 1), 'submitted, 1 submission each', { dispatchState: wData2?.dispatchState, submissions: [0, 1].map((i) => stub.submissionsFor(`${wJob2}:scene-${i}:attempt-1`).length) });
    await mf.dispose(); ctx.setMf(null);
  } finally {
    await stub.stop();
  }
  rec.note('The aged-job rule (intent-recorded older than the 30-min job timeout fails with dispatch-interrupted at reconciliation) needs the reconciliation timer — no seam; see T31-10.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-02', TITLE, run);
}
