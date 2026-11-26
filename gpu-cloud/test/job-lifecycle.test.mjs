// NOVA Personal GPU Cloud — Stage 1: job model + lifecycle transitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJob,
  transition,
  isTerminal,
  startedClockAt,
  DEFAULT_TIMEOUTS_MS,
  DEFAULT_MIN_VRAM_GB,
  DEFAULT_ESTIMATED_SECONDS,
  JobValidationError,
  JobTransitionError,
} from '../src/job.js';

const NOW = 1_800_000_000_000;

function base(over = {}) {
  return {
    idempotencyKey: 'key-1',
    type: 'video',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a dragon over the sea',
    seq: 1,
    now: NOW,
    ...over,
  };
}

test('createJob: defaults per type', () => {
  const video = createJob(base());
  assert.equal(video.status, 'queued');
  assert.equal(video.timeoutMs, DEFAULT_TIMEOUTS_MS.video);
  assert.equal(video.minVramGb, DEFAULT_MIN_VRAM_GB.video);
  assert.equal(video.estimatedSeconds, DEFAULT_ESTIMATED_SECONDS.video);
  assert.equal(video.createdAt, NOW);
  assert.equal(video.updatedAt, NOW);
  assert.equal(video.providerId, null);
  assert.equal(video.reservationId, null);
  assert.equal(video.cancellationRequested, false);
  assert.equal(video.resultRef, null);
  assert.match(video.id, /^job_[0-9a-f-]{36}$/);

  const image = createJob(base({ type: 'image', idempotencyKey: 'key-2', seq: 2 }));
  assert.equal(image.timeoutMs, DEFAULT_TIMEOUTS_MS.image);
  assert.equal(image.minVramGb, DEFAULT_MIN_VRAM_GB.image);
  assert.equal(image.estimatedSeconds, DEFAULT_ESTIMATED_SECONDS.image);
});

test('createJob: per-job param overrides', () => {
  const job = createJob(
    base({
      params: { timeoutMs: 1234, minVramGb: 20, estimatedSeconds: 42 },
    }),
  );
  assert.equal(job.timeoutMs, 1234);
  assert.equal(job.minVramGb, 20);
  assert.equal(job.estimatedSeconds, 42);
});

test('createJob: validation rejects bad input', () => {
  assert.throws(() => createJob(base({ idempotencyKey: '' })), JobValidationError);
  assert.throws(() => createJob(base({ idempotencyKey: 7 })), JobValidationError);
  assert.throws(() => createJob(base({ type: 'audio' })), JobValidationError);
  assert.throws(() => createJob(base({ modelId: '' })), JobValidationError);
  assert.throws(() => createJob(base({ prompt: 42 })), JobValidationError);
  assert.throws(() => createJob(base({ priority: Number.NaN })), JobValidationError);
});

test('lifecycle: queued -> dispatched -> running -> succeeded, timestamps set', () => {
  const job = createJob(base());
  transition(job, 'dispatched', NOW + 1000);
  assert.equal(job.status, 'dispatched');
  assert.equal(job.dispatchedAt, NOW + 1000);
  assert.equal(job.startedAt, null);

  transition(job, 'running', NOW + 2000);
  assert.equal(job.status, 'running');
  assert.equal(job.startedAt, NOW + 2000);
  assert.equal(job.completedAt, null);

  transition(job, 'succeeded', NOW + 5000);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.completedAt, NOW + 5000);
  assert.equal(job.updatedAt, NOW + 5000);
  assert.equal(isTerminal(job), true);
});

test('lifecycle: every terminal state is reachable', () => {
  const failed = createJob(base({ idempotencyKey: 'k-f', seq: 2 }));
  transition(failed, 'dispatched', NOW);
  transition(failed, 'running', NOW);
  transition(failed, 'failed', NOW);
  assert.equal(isTerminal(failed), true);

  const cancelled = createJob(base({ idempotencyKey: 'k-c', seq: 3 }));
  transition(cancelled, 'cancelled', NOW);
  assert.equal(isTerminal(cancelled), true);

  const timedOut = createJob(base({ idempotencyKey: 'k-t', seq: 4 }));
  transition(timedOut, 'dispatched', NOW);
  transition(timedOut, 'timed-out', NOW);
  assert.equal(isTerminal(timedOut), true);
});

test('lifecycle: illegal transitions throw and leave the job unchanged', () => {
  const job = createJob(base());
  assert.throws(() => transition(job, 'succeeded', NOW), JobTransitionError);
  assert.throws(() => transition(job, 'running', NOW), JobTransitionError);
  assert.equal(job.status, 'queued');

  transition(job, 'dispatched', NOW);
  assert.throws(() => transition(job, 'queued', NOW), JobTransitionError);
  assert.throws(() => transition(job, 'succeeded', NOW), JobTransitionError);
  assert.equal(job.status, 'dispatched');
});

test('lifecycle: terminal states have no exit', () => {
  for (const terminal of ['succeeded', 'failed', 'cancelled', 'timed-out']) {
    const job = createJob(base({ idempotencyKey: `k-${terminal}`, seq: 1 }));
    if (terminal === 'cancelled') {
      transition(job, 'cancelled', NOW);
    } else {
      transition(job, 'dispatched', NOW);
      transition(job, 'running', NOW);
      transition(job, terminal, NOW);
    }
    for (const target of ['queued', 'dispatched', 'running', 'succeeded']) {
      assert.throws(() => transition(job, target, NOW), JobTransitionError);
    }
    assert.equal(job.status, terminal);
  }
});

test('startedClockAt: running counts from start, dispatched from dispatch', () => {
  const running = createJob(base({ idempotencyKey: 'k-r', seq: 1 }));
  transition(running, 'dispatched', NOW + 100);
  transition(running, 'running', NOW + 200);
  assert.equal(startedClockAt(running), NOW + 200);

  const dispatched = createJob(base({ idempotencyKey: 'k-d', seq: 2 }));
  transition(dispatched, 'dispatched', NOW + 100);
  assert.equal(startedClockAt(dispatched), NOW + 100);

  const queued = createJob(base({ idempotencyKey: 'k-q', seq: 3 }));
  assert.equal(startedClockAt(queued), null);
});
