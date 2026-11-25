// 15-minute reconciliation timer (Rev 3.2 §B-3.2.7.2), per-index
// attempt-1 completeness (Rev 3.5 §C-3.5.1), manual resolution
// (Rev 3.2 §B-3.2.7.3), and operator scene-set repair (Rev 3.4 §C-3.4.2.2).
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApi, submitBody, seedJobForSubmit, execIdFor } from './support.mjs';
import { findMissingAttempt1Indexes } from '../reconcile.js';

test('per-index completeness: a retry row never substitutes for a missing attempt-1 row', () => {
  const rows = [
    { scene_index: 0, attempt: 1 },
    { scene_index: 1, attempt: 2 }, // retry only — attempt 1 missing
    { scene_index: 2, attempt: 1 },
  ];
  assert.deepEqual(findMissingAttempt1Indexes([0, 1, 2], rows), [1]);
  assert.deepEqual(findMissingAttempt1Indexes([0, 1, 2], [
    { scene_index: 0, attempt: 1 },
    { scene_index: 1, attempt: 1 },
    { scene_index: 2, attempt: 1 },
  ]), []);
});

test('timer without restart resolves unreachable→reachable (T31-10 analogue)', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  executor.setDefaultWireState('KernelWorkerStatus.NEW_SCRIPT');
  const body = submitBody('job-recon');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'reconciliation-needed');
  // Executor becomes reachable — the timer (not a restart) resolves it.
  executor.setWireState(execIdFor(body), 'KernelWorkerStatus.RUNNING');
  const summary = await api.runReconciliation({ source: 'timer' });
  assert.equal(summary.resolved, 1);
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'dispatched');
  assert.equal(api.apiState.state.reconciliation[execIdFor(body)], undefined);
});

test('24-hour escalation is visibility only: state and reservations unchanged', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  executor.setDefaultWireState('KernelWorkerStatus.NEW_SCRIPT');
  const body = submitBody('job-escal');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'reconciliation-needed');
  // Age the reconciliation entry past 24 hours.
  api.apiState.mutate((s) => {
    s.reconciliation[execIdFor(body)].firstAt = Date.now() - 25 * 60 * 60 * 1000;
  });
  const before = api.dispatch.journalEntry(execIdFor(body));
  const summary = await api.runReconciliation({ source: 'timer' });
  assert.deepEqual(summary.escalated, [execIdFor(body)]);
  const after = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(after.state, before.state, 'escalation does not change state');
  assert.equal(api.manager.listJobs().length, 1, 'reservations not released by elapsed time');
  assert.ok(api.apiState.state.operatorLog.some((e) => e.event === 'reconciliation-escalated'));
});

test('intent-recorded recovery re-submits with identical idempotency keys', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-intent');
  seedJobForSubmit(d1, body, { dispatchState: 'intent-recorded' });
  const summary = await api.runReconciliation({ source: 'startup' });
  assert.deepEqual(summary.recovered, [body.jobId]);
  const entry = api.dispatch.journalEntry(execIdFor(body));
  assert.ok(entry, 'journal created by recovery');
  assert.equal(api.manager.listJobs().length, 1, 'exactly one manager job');
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.ok(scene.provider_job_id, 'mark-submitted applied the provider job id');
  // A second recovery attempt is a no-op: the journal already holds it.
  const summary2 = await api.runReconciliation({ source: 'timer' });
  assert.deepEqual(summary2.recovered, []);
});

test('T31-17 analogue: a job with a missing attempt-1 row is flagged, recovery suspended', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-incomplete', { scenes: 2, mode: 'plan' });
  // Seed only scene 0 at attempt 1; scene 1 exists only as a retry.
  const data = {
    id: body.jobId,
    mode: 'plan',
    status: 'queued',
    createdAtMs: Date.now(),
    dispatchState: 'intent-recorded',
    scenes: body.scenes,
    sceneExecutions: body.sceneExecutions,
  };
  d1.seedJob(data, [
    { scene_index: 0, attempt: 1, execution_id: execIdFor(body), status: 'queued' },
    { scene_index: 1, attempt: 2, execution_id: `${body.jobId}:scene-1:attempt-2`, status: 'queued' },
  ]);
  const summary = await api.runReconciliation({ source: 'startup' });
  assert.equal(summary.incomplete.length, 1);
  assert.deepEqual(summary.incomplete[0].missingIndexes, [1]);
  assert.deepEqual(summary.recovered, [], 'recovery suspended while the set is incomplete');
  assert.equal(api.manager.listJobs().length, 0);
  assert.ok(api.apiState.state.incompleteSceneSets[body.jobId]);
});

test('operator repair inserts the missing attempt-1 row and clears the flag', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('job-repair', { scenes: 2, mode: 'plan' });
  const data = {
    id: body.jobId,
    mode: 'plan',
    status: 'queued',
    createdAtMs: Date.now(),
    dispatchState: 'intent-recorded',
    scenes: body.scenes,
    sceneExecutions: body.sceneExecutions,
  };
  d1.seedJob(data, [
    { scene_index: 0, attempt: 1, execution_id: execIdFor(body), status: 'queued' },
    { scene_index: 1, attempt: 2, execution_id: `${body.jobId}:scene-1:attempt-2`, status: 'queued' },
  ]);
  await api.runReconciliation({ source: 'startup' });
  const out = await api.repairSceneSet(body.jobId, { operator: 'test' });
  assert.equal(out.status, 'repaired');
  assert.deepEqual(out.repairedIndexes, [1]);
  assert.equal(api.apiState.state.incompleteSceneSets[body.jobId], undefined);
  const rows = await d1.listScenes(body.jobId);
  assert.ok(rows.some((r) => r.scene_index === 1 && r.attempt === 1));
  // Recovery is now permitted.
  const summary = await api.runReconciliation({ source: 'timer' });
  assert.deepEqual(summary.recovered, [body.jobId]);
});

test('manual resolve: confirm-accepted refused without executor evidence', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  executor.setDefaultWireState('KernelWorkerStatus.NEW_SCRIPT');
  const body = submitBody('job-manual');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 900));
  await assert.rejects(
    () => api.manualResolve({ executionId: execIdFor(body), decision: 'confirm-accepted', evidence: {} }),
    /requires executor evidence/,
  );
  const out = await api.manualResolve({
    executionId: execIdFor(body),
    decision: 'confirm-accepted',
    evidence: { executorState: 'running', detail: 'operator queried the kernel, RUNNING' },
    operator: 'test',
  });
  assert.equal(out.state, 'dispatched');
  assert.equal(api.dispatch.journalEntry(execIdFor(body)).state, 'dispatched');
});

test('manual resolve: fail is idempotent and requires evidence', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ ackWindowMs: 300, ackPollMs: 25 });
  t.after(cleanup);
  executor.setDefaultWireState('KernelWorkerStatus.NEW_SCRIPT');
  const body = submitBody('job-manualfail');
  seedJobForSubmit(d1, body);
  await api.dispatch.submitExecutions(body);
  await new Promise((r) => setTimeout(r, 900));
  await assert.rejects(
    () => api.manualResolve({ executionId: execIdFor(body), decision: 'fail', evidence: {} }),
    /requires evidence/,
  );
  const out = await api.manualResolve({
    executionId: execIdFor(body),
    decision: 'fail',
    evidence: { executorState: 'never-received' },
    operator: 'test',
  });
  assert.equal(out.state, 'failed');
  // Repeating the fail is a no-op, not an error and not a second release.
  const again = await api.manualResolve({
    executionId: execIdFor(body),
    decision: 'fail',
    evidence: { executorState: 'never-received' },
    operator: 'test',
  });
  assert.equal(again.state, 'failed');
  assert.equal(api.manager.listJobs().length, 1);
});
