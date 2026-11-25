// Dispatch lifecycle (Rev 2 §6.1, Rev 3.2 §B-3.2.8):
// spending-reserved → slot-claimed → executor-accepted → dispatched,
// with 202 only after the slot claim, and acceptance confirmed
// asynchronously via the executor status query — never by push alone.
// Ack timeout (60 s, controlled-test value in the harness): reconcile
// first, never blindly redispatch.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApi, submitBody, seedJobForSubmit, execIdFor } from './support.mjs';

test('happy path: reserve → claim → accept → dispatched, 202 with slot-claimed', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-happy');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 202);
  // The fake executor accepts instantly (QUEUED), so the immediate
  // acceptance probe already recorded executor-accepted before the
  // response — the documented alternative to slot-claimed (§B-3.2.8).
  assert.equal(res.body.dispatchState, 'executor-accepted');
  assert.equal(res.body.managerJobIds.length, 1);
  const entry = api.dispatch.journalEntry(execIdFor(body));
  // The immediate acceptance probe already moved it to dispatched.
  assert.equal(entry.state, 'dispatched');
  // Acceptance arrives asynchronously via the status query (the fake
  // executor defaults to QUEUED = accepted).
  await new Promise((r) => setTimeout(r, 600));
  const after = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(after.state, 'dispatched');
  const status = api.dispatch.executionStatus(execIdFor(body));
  assert.equal(status.state, 'dispatched');
});

test('duplicate submit is idempotent (same manager job, no second dispatch)', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-dup');
  seedJobForSubmit(d1, body);
  const r1 = await api.dispatch.submitExecutions(body);
  const r2 = await api.dispatch.submitExecutions(body);
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  assert.deepEqual(r2.body.managerJobIds, r1.body.managerJobIds);
  assert.equal(api.manager.listJobs().length, 1);
});

test('production mode refuses every submit with no-capacity', async (t) => {
  const { api, cleanup } = await makeApi({ mode: 'production', executor: false });
  t.after(cleanup);
  const res = await api.dispatch.submitExecutions(submitBody('job-prod'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no-capacity');
  assert.equal(api.manager.listJobs().length, 0);
});

test('no executor wired: reservation created then released, 503 no-executor', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  // White-box: the provider stays dispatchable, but no executor is
  // wired — dispatchNext creates the reservation, then releases it at
  // step 5 (manager's own compensation) and the API process fails the
  // execution in D1 without dispatching anything.
  api.manager.executors.delete('controlled-test-ltx');
  const body = submitBody('job-noexec');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no-executor');
  // Headroom released, spending reservation released, job still queued.
  assert.deepEqual(api.apiState.state.headroomReservations, {});
  const reservations = Object.values(api.manager.store.state.reservations);
  assert.ok(reservations.length >= 1, 'a reservation was created');
  assert.ok(reservations.every((r) => r.status === 'released'), 'every reservation released');
  const jobs = api.manager.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'queued');
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'failed');
  assert.equal(scene.error, 'no-executor');
});

test('ack-timeout, never-received: fail executor-ack-timeout, no second dispatch', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  const body = submitBody('job-lost');
  seedJobForSubmit(d1, body);
  // Simulate the push being lost: the executor never sees the execution.
  executor.dropSubmissions = true;
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 900));
  const entry = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(entry.state, 'failed');
  assert.equal(entry.error, 'executor-ack-timeout');
  assert.equal(api.manager.listJobs().length, 1, 'no second dispatch occurred');
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'failed');
  assert.equal(scene.error, 'executor-ack-timeout');
});

test('ack-timeout, executor unreachable: reconciliation-needed, reservations held', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  executor.setDefaultWireState('KernelWorkerStatus.NEW_SCRIPT'); // unknown → hold
  const body = submitBody('job-unreach');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 900));
  const entry = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(entry.state, 'reconciliation-needed');
  assert.equal(api.manager.listJobs().length, 1, 'no second dispatch occurred');
  // The executor becomes reachable: reconciliation resolves it.
  executor.setWireState(execIdFor(body), 'KernelWorkerStatus.RUNNING');
  const action = api.dispatch.reconcileExecution(execIdFor(body), 'test');
  assert.equal(action, 'accepted');
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'dispatched');
});

test('late acknowledgement after a terminal decision is recorded, never reverses it', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  const body = submitBody('job-late');
  seedJobForSubmit(d1, body);
  // Simulate the push being lost, so the job fails at the ack timeout.
  executor.dropSubmissions = true;
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'failed');
  // The acknowledgement arrives late, after the legitimate decision.
  executor.injectExecution(execIdFor(body), 'KernelWorkerStatus.RUNNING');
  const action = api.dispatch.reconcileExecution(execIdFor(body), 'test');
  assert.equal(action, 'late-ignored');
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'failed');
  // Late reports live in the MANAGER store (array, one per late event).
  const late = (api.manager.store.state.lateReports || [])
    .find((r) => r.executionId === execIdFor(body));
  assert.ok(late, 'late acknowledgement recorded');
  assert.equal(late.state, 'running');
});

test('completion: fileReport validates, stores output, marks the scene succeeded', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-done');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 600));
  const out = await api.dispatch.fileReportForExecution(execIdFor(body), {
    status: 'complete',
    output: Buffer.from('fake-mp4-bytes'),
    outputName: 'scene-0.mp4',
  });
  assert.equal(out.filed, true, JSON.stringify(out));
  // The finaliser is asynchronous (validate → store → D1): poll.
  // The retention candidate is recorded by the finaliser wrapper AFTER
  // the scene update, so poll for both.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = async () => {
      const scene = (await d1.listScenes(body.jobId))[0];
      if (scene.status === 'succeeded' && api.apiState.state.retentionCandidates[body.jobId]) return resolve();
      if (Date.now() > deadline) return reject(new Error(`scene stuck at ${scene.status}`));
      setTimeout(poll, 50);
    };
    poll();
  });
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'succeeded');
  assert.ok(scene.output_ref, 'output reference recorded');
  const job = await d1.getJob(body.jobId);
  assert.equal(JSON.parse(job.data).status, 'succeeded');
  // Rev 2 §16.1 (Q3 approved): the terminal parent is a retention
  // candidate — the 30-day clock starts at the parent's terminal
  // transition, not the scene's.
  const cand = api.apiState.state.retentionCandidates[body.jobId];
  assert.ok(cand, 'retention candidate recorded on completion');
  assert.equal(typeof cand.terminalAt, 'number');
});

test('cancel: a running execution is cancel-requested (Kaggle has no CLI cancel); executor-cancelled then fails it', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-cancel');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 600));
  const out = await api.dispatch.cancelExecution(body.jobId, execIdFor(body));
  assert.equal(out.status, 200);
  // Honest outcome (VDP-02): the request is recorded, the job keeps
  // running — the fake executor (like Kaggle) cannot cancel it.
  assert.equal(out.body.status, 'cancel-requested');
  assert.ok(api.dispatch.journalEntry(execIdFor(body)).cancelRequestedAt);
  const sceneBefore = (await d1.listScenes(body.jobId))[0];
  assert.equal(sceneBefore.status, 'queued', 'scene stays non-terminal while the executor runs');
  // The executor then reports the cancellation through its own channel
  // (the status query is not a failure channel once dispatched): the
  // wire state is the evidence, reportFailure is the mechanism.
  executor.setWireState(execIdFor(body), 'KernelWorkerStatus.CANCEL_ACKNOWLEDGED');
  const entry = api.dispatch.journalEntry(execIdFor(body));
  const reported = executor.reportFailure(entry.managerJobId, 'executor-cancelled');
  assert.equal(reported, true);
  // The manager finaliser mirrors the failure to D1 asynchronously.
  // VDP-02 outcome: the job is 'cancelled' (the owner cancelled it) and
  // the executor's failure is the cancel outcome ('provider-failed');
  // the journal records the execution failed with error 'cancelled'.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = async () => {
      const scene = (await d1.listScenes(body.jobId))[0];
      if (scene.status === 'cancelled') return resolve();
      if (Date.now() > deadline) return reject(new Error(`scene stuck at ${scene.status}`));
      setTimeout(poll, 50);
    };
    poll();
  });
  const after = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(after.state, 'failed');
  assert.equal(after.error, 'cancelled');
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'cancelled');
  assert.equal(scene.error, 'provider-failed');
});

test('cancel: a still-queued manager job is cancelled immediately with its D1 scene updated', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  // White-box: a manager job created directly (queued, never dispatched)
  // with a journal entry pointing at it, as the submit flow would leave
  // it before the dispatch loop runs.
  const body = submitBody('job-qcancel');
  seedJobForSubmit(d1, body);
  const { job: managerJob } = await api.manager.submit({
    idempotencyKey: execIdFor(body),
    type: 'video',
    modelId: 'ltx-video-2b',
    prompt: 'A dragon on a ridge at dawn.',
    params: {},
  });
  api.apiState.mutate((s) => {
    s.dispatchJournal[execIdFor(body)] = {
      executionId: execIdFor(body),
      jobId: body.jobId,
      sceneIndex: 0,
      attempt: 1,
      state: 'slot-claimed',
      managerJobId: managerJob.id,
      timestamps: {},
    };
  });
  api.dispatch.stop(); // keep the ack watcher out of this white-box setup
  const out = await api.dispatch.cancelExecution(body.jobId, execIdFor(body));
  assert.equal(out.status, 200);
  assert.equal(out.body.status, 'cancelled');
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'cancelled');
});
