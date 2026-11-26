// NOVA Personal GPU Cloud — Stage 2: shared test support (not a test file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGpuCloud } from '../src/setup.js';

export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cloud-s2-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A full wired cloud (manager + hours tracker + all three executors)
// with its store, package dir AND object store in a temp directory.
// The object store MUST be temp here: createGpuCloud() defaults it to
// the live gpu-cloud/data/store/, and tests must never write there.
export function makeCloud(t, opts = {}) {
  const dir = tempDir(t);
  const packageDir = path.join(dir, 'packages');
  const storePath = path.join(dir, 'gpu-manager.json');
  const storageRootDir = path.join(dir, 'store');
  const cloud = createGpuCloud({ storePath, packageDir, storageRootDir, ...opts });
  return { ...cloud, dir, packageDir, storePath, storageRootDir };
}

// Simulate Part B's live connection check: mark a real provider
// connected + available so the dispatcher can use it.
export function connectProvider(cloud, providerId) {
  cloud.registry.setConnected(providerId, true);
  cloud.registry.setStatus(providerId, 'available');
}

// Take the mock out of the dispatchable set (it supports wan2.2-ti2v-5b
// and would otherwise win the cheapest-first sort).
export function disableMock(cloud) {
  cloud.registry.setConnected('mock-t4', false);
  cloud.registry.setStatus('mock-t4', 'unavailable');
}

// Submit a Stage 2-safe video job (synthetic prompt + synthetic test
// image, marked stage2Test). Extra params override the defaults.
export function submitStage2Job(manager, key, extra = {}) {
  const { params = {}, ...rest } = extra;
  return manager.submit({
    idempotencyKey: key,
    type: 'video',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a synthetic test dragon flies over a test valley',
    params: { stage2Test: true, testImage: 'synthetic', ...params },
    ...rest,
  });
}

// A completion report in the notebook's shape (what the human files).
export function completionReport(jobId, providerId, overrides = {}) {
  return {
    jobId,
    providerId,
    status: 'succeeded',
    secondsUsed: 600,
    costUsd: 0,
    completedAt: Date.now(),
    resultRef: `manual-download:${jobId}.mp4`,
    error: null,
    ...overrides,
  };
}
