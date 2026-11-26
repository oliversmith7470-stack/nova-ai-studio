// NOVA Personal GPU Cloud — Stage 1: idempotency + duplicate protection.
//
// One idempotency key maps to exactly one job. A repeat submission returns
// the existing job (created: false) — never a second job, never a second
// dispatch, even after the first job has already been dispatched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, submitImage } from './support.mjs';

test('same key twice returns the same job, creates only one', (t) => {
  const m = makeManager(t);
  const first = submitImage(m, 'key-abc');
  assert.equal(first.created, true);

  const second = submitImage(m, 'key-abc');
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(m.listJobs().length, 1);
  assert.equal(m.getJobByKey('key-abc').id, first.job.id);
});

test('different keys create different jobs', (t) => {
  const m = makeManager(t);
  const a = submitImage(m, 'key-a');
  const b = submitImage(m, 'key-b');
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(m.listJobs().length, 2);
});

test('duplicate submit after dispatch returns the same job, no second dispatch', async (t) => {
  const m = makeManager(t);
  const first = submitImage(m, 'key-dup');
  const d = m.dispatchNext();
  assert.equal(d.dispatched, true);
  assert.equal(d.jobId, first.job.id);

  // The duplicate arrives while the job is running.
  const dup = submitImage(m, 'key-dup');
  assert.equal(dup.created, false);
  assert.equal(dup.job.id, first.job.id);
  assert.equal(dup.job.status, 'running');

  // Exactly one provider start happened.
  assert.equal(m.mock.startedJobs.length, 1);
  assert.equal(m.mock.startedJobs[0], first.job.id);

  await m.waitFor(first.job.id);
  assert.equal(m.getJob(first.job.id).status, 'succeeded');
  assert.equal(m.listJobs().length, 1);
});

test('duplicate submit after completion returns the completed job', async (t) => {
  const m = makeManager(t);
  const first = submitImage(m, 'key-done');
  m.dispatchNext();
  await m.waitFor(first.job.id);

  const dup = submitImage(m, 'key-done');
  assert.equal(dup.created, false);
  assert.equal(dup.job.status, 'succeeded');
  assert.equal(m.listJobs().length, 1);
});

test('duplicate submit with different payload still returns the original job', (t) => {
  const m = makeManager(t);
  const first = submitImage(m, 'key-same', { prompt: 'first prompt' });
  const dup = m.submit({
    idempotencyKey: 'key-same',
    type: 'video',
    modelId: 'mock-video-v1',
    prompt: 'a DIFFERENT prompt',
  });
  assert.equal(dup.created, false);
  assert.equal(dup.job.id, first.job.id);
  assert.equal(dup.job.prompt, 'first prompt');
  assert.equal(dup.job.type, 'image');
});
