// NOVA Personal GPU Cloud — Stage 1: timeouts.
//
// A job past its max generation time is marked timed-out, its reservation
// is released, and it is flagged for reconciliation (the provider may
// still charge for the run NOVA gave up on). A late provider report for a
// timed-out job is kept in lateReports, not dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, submitVideo, fakeClock, sleep } from './support.mjs';

test('running job past its timeout is marked timed-out', async (t) => {
  const clock = fakeClock();
  const m = makeManager(t, {
    now: clock.now,
    mockOptions: { latencyMs: 60_000 }, // never completes in real time
  });
  const { job } = submitVideo(m, 'to-run', { params: { timeoutMs: 1000 } });
  m.dispatchNext();
  assert.equal(m.getJob(job.id).status, 'running');

  clock.advance(999);
  assert.deepEqual(m.checkTimeouts(), []); // still inside the window
  assert.equal(m.getJob(job.id).status, 'running');

  clock.advance(2); // 1001ms total — past the timeout
  assert.deepEqual(m.checkTimeouts(), [job.id]);
  const final = m.getJob(job.id);
  assert.equal(final.status, 'timed-out');
  assert.equal(final.reconciliationNeeded, true);
  assert.ok(final.completedAt !== null);
  await sleep(10);
});

test('dispatched-but-not-running jobs time out from dispatch', (t) => {
  const clock = fakeClock();
  const m = makeManager(t, { now: clock.now });
  const { job } = submitVideo(m, 'to-disp', { params: { timeoutMs: 1000 } });
  // Setup-only direct state edit: put the job in 'dispatched' as a real
  // provider acknowledgement delay would (the mock moves straight to
  // running, so the dispatched state is staged by hand here).
  m.store.mutate((s) => {
    const j = s.jobs[job.id];
    j.status = 'dispatched';
    j.dispatchedAt = clock.now();
    j.providerId = 'mock-t4';
  });

  clock.advance(1001);
  assert.deepEqual(m.checkTimeouts(), [job.id]);
  assert.equal(m.getJob(job.id).status, 'timed-out');
});

test('queued jobs never time out', (t) => {
  const clock = fakeClock();
  const m = makeManager(t, { now: clock.now });
  const { job } = submitVideo(m, 'to-queued', { params: { timeoutMs: 1 } });
  clock.advance(1_000_000);
  assert.deepEqual(m.checkTimeouts(), []);
  assert.equal(m.getJob(job.id).status, 'queued');
});

test('a late provider report after timeout is kept for reconciliation', async (t) => {
  const clock = fakeClock();
  const m = makeManager(t, {
    now: clock.now,
    mockOptions: { latencyMs: 30, secondsUsed: 45 },
  });
  const { job } = submitVideo(m, 'to-late', { params: { timeoutMs: 1000 } });
  m.dispatchNext();
  clock.advance(1001);
  m.checkTimeouts();
  assert.equal(m.getJob(job.id).status, 'timed-out');

  // The mock's report arrives ~30ms later (real time). The job stays
  // timed-out, but the report is kept — the provider may have charged.
  await sleep(80);
  assert.equal(m.getJob(job.id).status, 'timed-out');
  assert.equal(m.store.state.lateReports.length, 1);
  assert.equal(m.store.state.lateReports[0].jobId, job.id);
  assert.equal(m.store.state.lateReports[0].secondsUsed, 45);
  const events = m.events.map((e) => e.name);
  assert.ok(events.includes('report-after-terminal'));
});

test('default timeouts apply per type', (t) => {
  const m = makeManager(t);
  const video = submitVideo(m, 'to-default-v');
  const image = m.submit({
    idempotencyKey: 'to-default-i',
    type: 'image',
    modelId: 'mock-image-v1',
    prompt: 'x',
  });
  assert.equal(video.job.timeoutMs, 30 * 60 * 1000);
  assert.equal(image.job.timeoutMs, 5 * 60 * 1000);
});
