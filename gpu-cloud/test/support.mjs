// NOVA Personal GPU Cloud — Stage 1: shared test support (not a test file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GpuManager } from '../src/gpu-manager.js';
import { MockProvider } from '../src/mock-provider.js';

export function tempStorePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cloud-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gpu-manager.json');
}

export function makeManager(t, opts = {}) {
  return new GpuManager({ storePath: tempStorePath(t), ...opts });
}

// Controllable clock (same idea as the A2 coordinator's test clock hook):
// tests advance time deterministically instead of sleeping.
export function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

export function submitImage(manager, key, extra = {}) {
  return manager.submit({
    idempotencyKey: key,
    type: 'image',
    modelId: 'mock-image-v1',
    prompt: 'test image',
    ...extra,
  });
}

export function submitVideo(manager, key, extra = {}) {
  return manager.submit({
    idempotencyKey: key,
    type: 'video',
    modelId: 'mock-video-v1',
    prompt: 'test video',
    ...extra,
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Register a PAID test provider (free mock-t4 does not support its model,
// so it is the only capable provider for 'paid-video-v1' jobs) with a
// working mock executor. Rate $0.01/s: a 300s video estimates $3.00.
export function registerPaidTestProvider(manager, { ratePerSecond = 0.01 } = {}) {
  const def = manager.registerProvider({
    id: 'mock-paid',
    kind: 'mock',
    label: 'Mock paid provider (tests only)',
    gpuType: 'Mock Paid GPU',
    vramGb: 24,
    models: ['paid-video-v1', 'paid-image-v1'],
    costModel: { type: 'paid', perSecondUsd: ratePerSecond },
    availabilityWindow: { type: 'always', description: 'Test provider.' },
    maxConcurrentJobs: 10,
    connected: true,
    status: 'available',
  });
  const executor = new MockProvider(def, { latencyMs: 5 });
  manager.registerExecutor(def.id, executor);
  return { def, executor };
}
