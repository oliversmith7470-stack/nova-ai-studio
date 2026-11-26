// NOVA Personal GPU Cloud — Stage 1: kill-switch semantics (VDP-02).
//
// Engaging the kill-switch:
//   - stops NEW dispatches,
//   - cancels queued jobs,
//   - marks running/dispatched jobs "cancellation requested" — it does NOT
//     guarantee they stop. A provider that completes anyway has its outcome
//     recorded (cancelOutcome) and its cost kept for reconciliation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, submitImage, submitVideo, sleep } from './support.mjs';

test('engaging cancels queued jobs and blocks new dispatch', (t) => {
  const m = makeManager(t);
  const a = submitImage(m, 'kill-q1');
  const b = submitImage(m, 'kill-q2');

  const result = m.engageKillSwitch('test stop');
  assert.equal(m.killSwitchEngaged(), true);
  assert.deepEqual(result.cancelled.sort(), [a.job.id, b.job.id].sort());
  assert.deepEqual(result.cancelRequested, []);
  assert.equal(m.getJob(a.job.id).status, 'cancelled');
  assert.equal(m.getJob(b.job.id).status, 'cancelled');

  const c = submitImage(m, 'kill-q3'); // submit still works; dispatch does not
  assert.equal(c.job.status, 'queued');
  assert.equal(m.dispatchNext().reason, 'kill-switch-engaged');
  assert.equal(m.getJob(c.job.id).status, 'queued');
});

test('running job gets a cancellation request, not a forced stop', async (t) => {
  const m = makeManager(t, { mockOptions: { latencyMs: 50 } });
  const { job } = submitVideo(m, 'kill-run');
  m.dispatchNext();
  assert.equal(m.getJob(job.id).status, 'running');

  const result = m.engageKillSwitch('test stop');
  assert.deepEqual(result.cancelRequested, [job.id]);
  const after = m.getJob(job.id);
  assert.equal(after.status, 'running'); // still running — the kill cannot force it
  assert.equal(after.cancellationRequested, true);
  assert.ok(after.cancellationRequestedAt !== null);
  assert.ok(m.mock.cancelRequests.has(job.id));

  // The mock completes anyway (honest VDP-02 behaviour). NOVA records the
  // provider's outcome, marks the job cancelled, keeps the cost.
  await m.waitFor(job.id);
  const final = m.getJob(job.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.cancelOutcome, 'provider-completed');
  assert.equal(final.cost.providerReportedUsd, 0);
  assert.ok(final.cost.providerReportedSeconds !== null);
  assert.ok(final.cost.novaSeconds !== null);
  assert.equal(final.resultRef, `mock://transient/${job.id}`);
});

test('a failing run after a cancel request records provider-failed', async (t) => {
  const m = makeManager(t);
  m.mock.failNext();
  const { job } = submitImage(m, 'kill-fail');
  m.dispatchNext();
  m.engageKillSwitch('test stop');
  await m.waitFor(job.id);

  const final = m.getJob(job.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.cancelOutcome, 'provider-failed');
  assert.equal(final.error, 'mock simulated failure');
});

test('disengaging resumes dispatch', (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'kill-resume');
  m.engageKillSwitch('test stop');
  assert.equal(m.dispatchNext().reason, 'kill-switch-engaged');

  m.disengageKillSwitch('test resume');
  assert.equal(m.killSwitchEngaged(), false);
  // The job was cancelled while the switch was engaged; a NEW job dispatches.
  assert.equal(m.getJob(job.id).status, 'cancelled');
  const next = submitImage(m, 'kill-resume-2');
  assert.equal(m.dispatchNext().jobId, next.job.id);
});

test('kill-switch actions are logged with reasons', (t) => {
  const m = makeManager(t);
  m.engageKillSwitch('owner stop: runaway test');
  m.disengageKillSwitch('owner resume');
  const log = m.store.state.killSwitch.log;
  assert.equal(log.length, 2);
  assert.equal(log[0].action, 'engaged');
  assert.equal(log[0].reason, 'owner stop: runaway test');
  assert.equal(log[1].action, 'disengaged');
  assert.equal(log[1].reason, 'owner resume');
});

test('cancelJob: queued job cancels immediately', (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'cancel-q');
  m.cancelJob(job.id, 'changed my mind');
  assert.equal(m.getJob(job.id).status, 'cancelled');
  assert.equal(m.getJob(job.id).cancellationRequested, false);
});

test('cancelJob: terminal jobs are untouched', async (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'cancel-term');
  m.dispatchNext();
  await m.waitFor(job.id);
  assert.equal(m.getJob(job.id).status, 'succeeded');
  m.cancelJob(job.id);
  assert.equal(m.getJob(job.id).status, 'succeeded');
  assert.equal(m.cancelJob('job_does-not-exist'), null);
  await sleep(5);
});
