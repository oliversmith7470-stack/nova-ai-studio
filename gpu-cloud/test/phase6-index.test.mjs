import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 6 entry point: every module re-exports cleanly, no side effects
// (no executor registration, no worker start, no I/O at import time).
import * as phase6 from '../src/phase6/index.js';

test('phase6 index re-exports all modules', () => {
  // Resource profiles (Workstream G).
  assert.equal(typeof phase6.getProfile, 'function');
  assert.equal(typeof phase6.requiredVramGb, 'function');
  assert.equal(typeof phase6.admitJob, 'function');
  // Feature flags / rollback (§18).
  assert.equal(typeof phase6.createFeatureFlags, 'function');
  assert.equal(typeof phase6.rollbackToBaseline, 'function');
  assert.equal(phase6.BASELINE_CONFIG.precision, 'fp16');
  // Persistent worker (Workstream A).
  assert.equal(typeof phase6.PersistentWorker, 'function');
  assert.deepEqual(phase6.HEALTH_STATES, ['starting', 'ready', 'busy', 'draining', 'failed', 'unavailable']);
  // Chunked decode (Workstream B).
  assert.equal(typeof phase6.assembleTiles, 'function');
  assert.equal(typeof phase6.planTiles, 'function');
  assert.equal(phase6.FRAMEWISE_DECODE_CONFIG.method, 'native-framewise');
  assert.equal(phase6.SINGLE_PASS_DECODE_CONFIG.method, 'single-pass');
  // Throughput (Workstream F).
  assert.equal(typeof phase6.reliabilityAdjustedThroughput, 'function');
  assert.equal(typeof phase6.warmGenerationThroughput, 'function');
  // Benchmark (§16/§17).
  assert.equal(typeof phase6.validateBenchmarkReport, 'function');
  assert.equal(typeof phase6.probeVideo, 'function');
  // Importing the entry point must not start anything: flags stay off.
  const flags = phase6.createFeatureFlags();
  assert.deepEqual(flags.flags, {
    persistentWorker: false,
    framewiseDecode: false,
    attentionOptimisation: false,
    quantisation: false,
  });
});
