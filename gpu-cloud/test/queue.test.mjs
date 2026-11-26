// NOVA Personal GPU Cloud — Stage 1: queue ordering, max depth,
// capability matching (model + VRAM) and provider capacity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueFullError } from '../src/gpu-manager.js';
import { MockProvider } from '../src/mock-provider.js';
import { makeManager, submitImage, submitVideo, sleep } from './support.mjs';

test('FIFO: same priority dispatches in submission order', (t) => {
  const m = makeManager(t);
  const a = submitImage(m, 'q-a');
  const b = submitImage(m, 'q-b');
  const c = submitImage(m, 'q-c');

  assert.equal(m.dispatchNext().jobId, a.job.id);
  assert.equal(m.dispatchNext().jobId, b.job.id);
  assert.equal(m.dispatchNext().jobId, c.job.id);
  assert.equal(m.dispatchNext().reason, 'queue-empty');
});

test('priority: higher priority jumps the FIFO order', (t) => {
  const m = makeManager(t);
  const low1 = submitImage(m, 'q-low1', { priority: 0 });
  const low2 = submitImage(m, 'q-low2', { priority: 0 });
  const high = submitImage(m, 'q-high', { priority: 10 });
  const mid = submitImage(m, 'q-mid', { priority: 5 });

  assert.equal(m.dispatchNext().jobId, high.job.id);
  assert.equal(m.dispatchNext().jobId, mid.job.id);
  assert.equal(m.dispatchNext().jobId, low1.job.id);
  assert.equal(m.dispatchNext().jobId, low2.job.id);
});

test('max queue depth: submitting past the limit throws QueueFullError', (t) => {
  const m = makeManager(t, { config: { maxQueueDepth: 2 } });
  submitImage(m, 'd-1');
  submitImage(m, 'd-2');
  assert.throws(() => submitImage(m, 'd-3'), QueueFullError);
  assert.equal(m.listJobs('queued').length, 2);

  // Depth frees up once a job leaves the queue.
  m.dispatchNext();
  submitImage(m, 'd-3');
  assert.equal(m.listJobs('queued').length, 2);
});

test('capability: unsupported model is never dispatched', (t) => {
  const m = makeManager(t);
  const { job } = m.submit({
    idempotencyKey: 'cap-model',
    type: 'video',
    modelId: 'no-such-model-v9',
    prompt: 'x',
  });
  const r = m.dispatchNext();
  assert.equal(r.dispatched, false);
  assert.equal(r.reason, 'no-provider');
  assert.equal(m.getJob(job.id).status, 'queued');
});

test('capability: VRAM above every card is never dispatched', (t) => {
  const m = makeManager(t);
  const { job } = submitVideo(m, 'cap-vram', {
    params: { minVramGb: 80 }, // no Stage 1 provider has an 80 GB card
  });
  const r = m.dispatchNext();
  assert.equal(r.dispatched, false);
  assert.equal(r.reason, 'no-provider');
  assert.equal(m.getJob(job.id).status, 'queued');
});

test('capability: not-connected providers never receive jobs', (t) => {
  const m = makeManager(t);
  // wan2.2-ti2v-5b is on the Kaggle/Colab definitions AND the mock. Only
  // the mock is connected, so the job must land on the mock.
  const { job } = m.submit({
    idempotencyKey: 'cap-conn',
    type: 'video',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'x',
  });
  const r = m.dispatchNext();
  assert.equal(r.dispatched, true);
  assert.equal(r.providerId, 'mock-t4');

  const status = Object.fromEntries(
    m.providerStatus().map((p) => [p.id, p]),
  );
  assert.equal(status['kaggle-t4'].dispatchable, false);
  assert.equal(status['colab-t4'].dispatchable, false);
  assert.equal(status['runpod-4090'].dispatchable, false);
  assert.equal(status['mock-t4'].dispatchable, true);
  assert.equal(m.getJob(job.id).providerId, 'mock-t4');
});

test('capacity: a provider at maxConcurrentJobs takes no more until one finishes', async (t) => {
  const m = makeManager(t);
  // A solo provider: max 1 concurrent job, slow mock (100ms).
  const def = m.registerProvider({
    id: 'mock-solo',
    kind: 'mock',
    label: 'Mock solo (tests only)',
    gpuType: 'Mock Solo',
    vramGb: 16,
    models: ['solo-model-v1'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test provider.' },
    maxConcurrentJobs: 1,
    connected: true,
    status: 'available',
  });
  m.registerExecutor(def.id, new MockProvider(def, { latencyMs: 100 }));

  const a = m.submit({
    idempotencyKey: 'solo-a',
    type: 'image',
    modelId: 'solo-model-v1',
    prompt: 'a',
  });
  const b = m.submit({
    idempotencyKey: 'solo-b',
    type: 'image',
    modelId: 'solo-model-v1',
    prompt: 'b',
  });

  assert.equal(m.dispatchNext().jobId, a.job.id);
  const blocked = m.dispatchNext();
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.reason, 'no-provider');
  assert.equal(m.getJob(b.job.id).status, 'queued');

  await m.waitFor(a.job.id);
  await sleep(10);
  assert.equal(m.dispatchNext().jobId, b.job.id);
  await m.waitFor(b.job.id);
});

test('dispatchAll drains the queue', async (t) => {
  const m = makeManager(t);
  submitImage(m, 'all-1');
  submitImage(m, 'all-2');
  submitImage(m, 'all-3');
  const results = m.dispatchAll();
  // 3 dispatches + 1 terminal queue-empty result.
  assert.equal(results.filter((r) => r.dispatched).length, 3);
  assert.equal(results.at(-1).reason, 'queue-empty');
  assert.equal(m.listJobs('queued').length, 0);
  for (const job of m.listJobs()) await m.waitFor(job.id);
  assert.equal(m.listJobs('succeeded').length, 3);
});
