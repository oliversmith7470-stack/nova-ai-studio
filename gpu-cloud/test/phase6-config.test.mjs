// Phase 6 §18 — feature flags and rollback config.
//
// All candidate flags default OFF; rollback restores the FP16 baseline.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_CONFIG,
  FLAG_NAMES,
  FEATURE_FLAG_DEFAULTS,
  FEATURE_FLAGS_VERSION,
  createFeatureFlags,
  validateFeatureFlags,
  rollbackToBaseline,
} from '../src/phase6/config.js';

test('defaults: version 1, every candidate flag OFF', () => {
  assert.equal(FEATURE_FLAGS_VERSION, 1);
  const flags = createFeatureFlags();
  assert.equal(flags.version, 1);
  assert.deepEqual(flags.flags, {
    persistentWorker: false,
    framewiseDecode: false,
    attentionOptimisation: false,
    quantisation: false,
  });
  for (const name of FLAG_NAMES) {
    assert.equal(flags.flags[name], false, `${name} must default off`);
  }
});

test('createFeatureFlags accepts a known boolean override', () => {
  const flags = createFeatureFlags({ framewiseDecode: true });
  assert.equal(flags.flags.framewiseDecode, true);
  assert.equal(flags.flags.persistentWorker, false);
});

test('unknown flag names throw', () => {
  assert.throws(() => createFeatureFlags({ turboMode: true }), /unknown feature flag: turboMode/);
  assert.throws(() => validateFeatureFlags({ turboMode: true }), /unknown feature flag/);
  assert.throws(() => validateFeatureFlags({ persistentWorker: false, nope: false }), /unknown feature flag: nope/);
});

test('non-boolean flag values throw', () => {
  assert.throws(() => createFeatureFlags({ persistentWorker: 1 }), /must be a boolean/);
  assert.throws(() => createFeatureFlags({ persistentWorker: 'yes' }), /must be a boolean/);
  assert.throws(() => createFeatureFlags({ quantisation: null }), /must be a boolean/);
  assert.throws(() => validateFeatureFlags({ framewiseDecode: 0 }), /must be a boolean/);
  assert.throws(() => validateFeatureFlags(null), /must be an object/);
});

test('rollback restores the baseline: every flag false', () => {
  const on = createFeatureFlags({
    persistentWorker: true,
    framewiseDecode: true,
    attentionOptimisation: true,
    quantisation: true,
  });
  const rolled = rollbackToBaseline(on, Date.parse('2026-11-27T00:00:00.000Z'));
  assert.equal(rolled.version, 1);
  assert.deepEqual(rolled.flags, {
    persistentWorker: false,
    framewiseDecode: false,
    attentionOptimisation: false,
    quantisation: false,
  });
  assert.equal(rolled.rolledBackAt, '2026-11-27T00:00:00.000Z');
  assert.deepEqual(rolled.from, {
    persistentWorker: true,
    framewiseDecode: true,
    attentionOptimisation: true,
    quantisation: true,
  });
});

test('rollback does not mutate its input, and returns a fresh object each time', () => {
  const on = createFeatureFlags({ persistentWorker: true, quantisation: true });
  const before = structuredClone(on);
  const a = rollbackToBaseline(on);
  const b = rollbackToBaseline(on);
  assert.deepEqual(on, before, 'input must be unchanged');
  assert.notEqual(a, b);
  assert.notEqual(a.flags, b.flags);
  assert.notEqual(a.flags, on.flags);
  a.flags.persistentWorker = true;
  assert.equal(b.flags.persistentWorker, false);
  assert.equal(on.flags.persistentWorker, true);
});

test('rollback accepts a bare flags map as well as a versioned object', () => {
  const rolled = rollbackToBaseline({ framewiseDecode: true });
  assert.deepEqual(rolled.flags, FEATURE_FLAG_DEFAULTS);
  assert.deepEqual(rolled.from, { framewiseDecode: true });
});

test('rollback rejects unknown flags and non-boolean values', () => {
  assert.throws(() => rollbackToBaseline({ turboMode: true }), /unknown feature flag/);
  assert.throws(() => rollbackToBaseline({ persistentWorker: 'on' }), /must be a boolean/);
  assert.throws(() => rollbackToBaseline(null), /requires a feature flags object/);
});

test('createFeatureFlags returns independent objects; defaults stay frozen', () => {
  assert.ok(Object.isFrozen(FEATURE_FLAG_DEFAULTS));
  const a = createFeatureFlags();
  const b = createFeatureFlags();
  a.flags.persistentWorker = true;
  assert.equal(b.flags.persistentWorker, false);
  assert.equal(FEATURE_FLAG_DEFAULTS.persistentWorker, false);
});

test('BASELINE_CONFIG is the proven FP16 baseline, frozen', () => {
  assert.ok(Object.isFrozen(BASELINE_CONFIG));
  assert.deepEqual(BASELINE_CONFIG, {
    model: 'ltx-video-2b',
    checkpointSha256: '76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f',
    precision: 'fp16',
    steps: 8,
    frames: 121,
    resolution: '1024x576',
    fps: 24,
    decoder: 'single-pass',
    attention: 'default',
  });
  assert.throws(() => { BASELINE_CONFIG.steps = 4; }, TypeError);
});
