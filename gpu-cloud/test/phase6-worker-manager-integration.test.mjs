// NOVA Personal GPU Cloud — Phase 6 Workstream A: persistent worker wired
// as the executor for a test provider on a real GpuManager.
//
// Two video jobs go through manager.submit + dispatchNext. Both must
// succeed with ONE model load, and the manager must finalise both as
// succeeded. Fake modelRunner only — no GPU, no network, no production
// registration (the provider exists only inside this test's manager).

import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuManager } from '../src/gpu-manager.js';
import {
  PersistentWorker,
  PINNED_BASELINE,
} from '../src/phase6/persistent-worker.js';
import { tempStorePath } from './support.mjs';

const BASELINE_PARAMS = Object.freeze({
  frames: 121,
  width: 1024,
  height: 576,
  steps: 8,
  fps: 24,
  seed: 42,
  guidance: 1.0,
});

function makeRunner() {
  const calls = { load: 0, warmup: 0, runJob: 0, unload: 0 };
  const seenModels = [];
  return {
    calls,
    seenModels,
    async load(spec) {
      calls.load += 1;
      return { checkpointSha256: spec.checkpointSha256, precision: 'fp16' };
    },
    async warmup() {
      calls.warmup += 1;
    },
    async runJob(model, job, ctx) {
      calls.runJob += 1;
      seenModels.push(model);
      return {
        resultRef: `phase6://output/${job.id}`,
        measurements: {
          generationMs: 32600,
          decodeMs: 13100,
          exportMs: 3700,
          peakMemoryGib: 12.64,
        },
      };
    },
    async unload() {
      calls.unload += 1;
    },
  };
}

test('worker as manager executor: two video jobs succeed with one model load', async (t) => {
  const runner = makeRunner();
  const worker = new PersistentWorker({
    providerId: 'phase6-test-ltx',
    modelRunner: runner,
    modelSpec: { ...PINNED_BASELINE },
    flags: {},
  });
  assert.equal(await worker.startWorker(), true);
  assert.equal(worker.state, 'ready');

  const manager = new GpuManager({ storePath: tempStorePath(t) });
  const def = manager.registerProvider({
    id: 'phase6-test-ltx',
    kind: 'mock',
    label: 'Phase 6 persistent-worker test provider',
    gpuType: 'Test T4',
    vramGb: 16,
    models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test provider.' },
    maxConcurrentJobs: 1,
    connected: true,
    status: 'available',
  });
  manager.registerExecutor(def.id, worker);

  const { job: job1 } = manager.submit({
    idempotencyKey: 'phase6-job-1',
    type: 'video',
    modelId: 'ltx-video-2b',
    prompt: 'a dragon over the sea',
    params: { ...BASELINE_PARAMS },
  });
  const { job: job2 } = manager.submit({
    idempotencyKey: 'phase6-job-2',
    type: 'video',
    modelId: 'ltx-video-2b',
    prompt: 'a dragon over the mountain',
    params: { ...BASELINE_PARAMS },
  });

  // Job 1: dispatch, then wait for the manager to finalise it.
  const dispatched1 = manager.dispatchNext();
  assert.equal(dispatched1.dispatched, true);
  assert.equal(dispatched1.providerId, 'phase6-test-ltx');
  const final1 = await manager.waitFor(job1.id);
  assert.equal(final1.status, 'succeeded');
  assert.equal(final1.resultRef, `phase6://output/${job1.id}`);
  assert.equal(final1.providerId, 'phase6-test-ltx');

  // Job 2 only dispatches once the worker is free (single-job worker:
  // the manager finalises from the worker's start() promise).
  const dispatched2 = manager.dispatchNext();
  assert.equal(dispatched2.dispatched, true);
  const final2 = await manager.waitFor(job2.id);
  assert.equal(final2.status, 'succeeded');
  assert.equal(final2.resultRef, `phase6://output/${job2.id}`);

  // One model load served both jobs; the same loaded model did the work.
  assert.equal(runner.calls.load, 1);
  assert.equal(runner.calls.warmup, 1);
  assert.equal(runner.calls.runJob, 2);
  assert.equal(runner.seenModels[0], runner.seenModels[1]);
  assert.equal(worker.jobsCompleted, 2);
  assert.equal(worker.jobsFailed, 0);
  assert.equal(worker.state, 'ready');
  assert.equal(manager.listJobs('succeeded').length, 2);
});

test('manager refuses a mismatched config through the worker (failed, not run)', async (t) => {
  const runner = makeRunner();
  const worker = new PersistentWorker({
    providerId: 'phase6-test-ltx',
    modelRunner: runner,
    modelSpec: { ...PINNED_BASELINE },
    flags: {},
  });
  assert.equal(await worker.startWorker(), true);

  const manager = new GpuManager({ storePath: tempStorePath(t) });
  const def = manager.registerProvider({
    id: 'phase6-test-ltx',
    kind: 'mock',
    label: 'Phase 6 persistent-worker test provider',
    gpuType: 'Test T4',
    vramGb: 16,
    models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Test provider.' },
    maxConcurrentJobs: 1,
    connected: true,
    status: 'available',
  });
  manager.registerExecutor(def.id, worker);

  const { job } = manager.submit({
    idempotencyKey: 'phase6-job-mismatch',
    type: 'video',
    modelId: 'ltx-video-2b',
    prompt: 'a dragon over the sea',
    params: { ...BASELINE_PARAMS, frames: 49 },
  });
  const dispatched = manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  const final = await manager.waitFor(job.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /config-mismatch: frames 49 != pinned 121/);
  assert.equal(runner.calls.runJob, 0, 'the mismatched job never ran');
  assert.equal(worker.state, 'ready', 'the worker stays ready after a refusal');
});
