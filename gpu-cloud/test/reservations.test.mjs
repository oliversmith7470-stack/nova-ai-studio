// NOVA Personal GPU Cloud — Stage 1: quota reservations.
//
// A reservation is created BEFORE any dispatch and released on EVERY
// terminal state (succeeded / failed / cancelled / timed-out). The event
// log proves the ordering; the store proves the release.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  submitImage,
  submitVideo,
  fakeClock,
  sleep,
} from './support.mjs';

function reservationFor(m, jobId) {
  return Object.values(m.store.state.reservations).find(
    (r) => r.jobId === jobId,
  );
}

test('reservation is created BEFORE the dispatch (event order)', (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'res-order');
  m.dispatchNext();

  const names = m.events.map((e) => e.name);
  const resIdx = names.indexOf('reservation-created');
  const dispIdx = names.indexOf('job-dispatched');
  assert.notEqual(resIdx, -1);
  assert.notEqual(dispIdx, -1);
  assert.ok(resIdx < dispIdx, 'reservation-created must precede job-dispatched');

  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'active');
  assert.equal(res.providerId, 'mock-t4');
  assert.equal(res.estimatedUsd, 0);
  assert.equal(m.getJob(job.id).reservationId, res.id);
});

test('reservation released on success', async (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'res-ok');
  m.dispatchNext();
  await m.waitFor(job.id);

  assert.equal(m.getJob(job.id).status, 'succeeded');
  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'released');
  assert.equal(res.releaseReason, 'job-succeeded');
  assert.ok(res.releasedAt !== null);
  assert.equal(m.committedUsd(), 0);
});

test('reservation released on provider failure', async (t) => {
  const m = makeManager(t);
  m.mock.failNext();
  const { job } = submitImage(m, 'res-fail');
  m.dispatchNext();
  await m.waitFor(job.id);

  assert.equal(m.getJob(job.id).status, 'failed');
  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'released');
  assert.equal(res.releaseReason, 'job-failed');
  assert.equal(m.committedUsd(), 0);
});

test('reservation released on cancel-after-dispatch', async (t) => {
  const m = makeManager(t);
  const { job } = submitVideo(m, 'res-cancel');
  m.dispatchNext();
  m.cancelJob(job.id, 'test-cancel');
  await m.waitFor(job.id);

  // The mock completes after the cancel request; the job is cancelled
  // (VDP-02) and the reservation is released either way.
  assert.equal(m.getJob(job.id).status, 'cancelled');
  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'released');
  assert.equal(res.releaseReason, 'job-cancelled');
  assert.equal(m.committedUsd(), 0);
});

test('reservation released on timeout', async (t) => {
  const clock = fakeClock();
  const m = makeManager(t, {
    now: clock.now,
    mockOptions: { latencyMs: 60_000 }, // never completes in real time
  });
  const { job } = submitVideo(m, 'res-timeout', {
    params: { timeoutMs: 1000 },
  });
  m.dispatchNext();
  assert.equal(m.getJob(job.id).status, 'running');

  clock.advance(1001);
  const timedOut = m.checkTimeouts();
  assert.deepEqual(timedOut, [job.id]);
  assert.equal(m.getJob(job.id).status, 'timed-out');
  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'released');
  assert.equal(res.releaseReason, 'job-timed-out');
  assert.equal(m.committedUsd(), 0);
  await sleep(10); // let the (now irrelevant) mock promise settle
});

test('reservation released when no executor is wired (job stays queued)', (t) => {
  const m = makeManager(t);
  // A dispatchable definition with NO executor registered.
  m.registerProvider({
    id: 'mock-orphan',
    kind: 'mock',
    label: 'Mock orphan (tests only)',
    gpuType: 'Mock Orphan',
    vramGb: 16,
    models: ['orphan-model-v1'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test provider.' },
    maxConcurrentJobs: 1,
    connected: true,
    status: 'available',
  });
  const { job } = m.submit({
    idempotencyKey: 'res-orphan',
    type: 'image',
    modelId: 'orphan-model-v1',
    prompt: 'x',
  });
  const r = m.dispatchNext();
  assert.equal(r.dispatched, false);
  assert.equal(r.reason, 'no-executor');
  assert.equal(m.getJob(job.id).status, 'queued');
  const res = reservationFor(m, job.id);
  assert.equal(res.status, 'released');
  assert.equal(res.releaseReason, 'no-executor');
});
