// NOVA Personal GPU Cloud — Phase 6 §18: feature flags and rollback config.
//
// Every candidate change behind a flag, ALL default OFF. The FP16
// single-pass baseline is the only proven configuration; a flag may be
// turned on only by an explicit owner decision, and rollback returns
// every flag to OFF. Pure functions, no I/O, no mutation of inputs.

export const CHECKPOINT_SHA256 =
  '76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f';

// The proven FP16 baseline configuration (Run 10). Any flagged change
// is measured against this, and rollback restores it.
export const BASELINE_CONFIG = Object.freeze({
  model: 'ltx-video-2b',
  checkpointSha256: CHECKPOINT_SHA256,
  precision: 'fp16',
  steps: 8,
  frames: 121,
  resolution: '1024x576',
  fps: 24,
  decoder: 'single-pass',
  attention: 'default',
});

export const FLAG_NAMES = Object.freeze([
  'persistentWorker',
  'framewiseDecode',
  'attentionOptimisation',
  'quantisation',
]);

export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  persistentWorker: false,
  framewiseDecode: false,
  attentionOptimisation: false,
  quantisation: false,
});

export const FEATURE_FLAGS_VERSION = 1;

// Validate a flags map: unknown flag names throw; values must be boolean.
export function validateFeatureFlags(flags) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error('feature flags must be an object');
  }
  for (const name of Object.keys(flags)) {
    if (!FLAG_NAMES.includes(name)) {
      throw new Error(`unknown feature flag: ${name}`);
    }
    if (typeof flags[name] !== 'boolean') {
      throw new Error(`feature flag ${name} must be a boolean`);
    }
  }
  return true;
}

// A fresh versioned flags object. Overrides must name known flags with
// boolean values; anything else throws. The returned object is a new
// object every call — mutating it never touches the defaults.
export function createFeatureFlags(overrides = {}) {
  validateFeatureFlags(overrides);
  return {
    version: FEATURE_FLAGS_VERSION,
    flags: { ...FEATURE_FLAG_DEFAULTS, ...overrides },
  };
}

// Roll back to the baseline: a FRESH flags object with every candidate
// flag false, recording when it rolled back and what it rolled back
// from. Pure: the input is never mutated, and `from` is a copy of the
// input flags as they were. `nowMs` is injectable for tests; it defaults
// to Date.now().
export function rollbackToBaseline(flags, nowMs = Date.now()) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error('rollbackToBaseline requires a feature flags object');
  }
  const inputFlags = flags.flags ?? flags;
  validateFeatureFlags(inputFlags);
  return {
    version: FEATURE_FLAGS_VERSION,
    flags: { ...FEATURE_FLAG_DEFAULTS },
    rolledBackAt: new Date(nowMs).toISOString(),
    from: { ...inputFlags },
  };
}
