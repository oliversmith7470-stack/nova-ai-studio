// NOVA Personal GPU Cloud — Phase 6 Workstream G: measured resource profiles.
//
// Admission is MEASURED, never estimated. A profile records what a real
// proof run actually used on one Kaggle T4 (LTX-Video 2B distilled
// 0.9.8, diffusers 0.40.0, 1024x576, 24fps, 8 steps, seed 42), and
// admission refuses any config with no measured profile — fail closed.
// Never interpolate between measured points, never invent a threshold.
//
// Source: gpu-cloud/packages/ltx-proof-20261124-01/output/run10/ltx-proof-report.json
// (Run 10; the 17- and 49-frame points are the earlier runs recorded in
// src/engines.js). Checkpoint sha256 below is the checkpoint the runs used.
//
// Units: 1 GiB = 2^30 bytes; 1 GB = 10^9 bytes; 1 GiB = 1.073741824 GB.
// A T4 advertised as "16 GB" exposes 14.56 GiB usable per torch; a
// "12 GB" card exposes ~11.18 GiB. Provider vramGb is in GB (see
// src/providers.js providerSupports), so admission converts the measured
// GiB requirement to GB and rounds UP — a device must clear the
// requirement with nothing shaved off by rounding.
//
// Safety margin: the default margin is the headroom observed in the
// proven Run 10 run (14.56 GiB usable - 12.64 GiB peak = 1.92 GiB).
// It is an INTERIM default = headroom observed in the proven run;
// lowering it needs owner approval. Callers may pass an explicit
// safetyMarginGib, but the default must not be lowered silently.

export const CHECKPOINT_SHA256 =
  '76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f';

export const CHECKPOINT = 'ltxv-2b-0.9.8-distilled.safetensors';

export const PROFILE_SOURCE =
  'gpu-cloud/packages/ltx-proof-20261124-01/output/run10/ltx-proof-report.json';

// Interim default safety margin (GiB) = headroom observed in the proven
// Run 10 run. Lowering it needs owner approval.
export const DEFAULT_SAFETY_MARGIN_GIB = 1.92;

export const GIB_TO_GB = 1.073741824;

export function gibToGb(gib) {
  return gib * GIB_TO_GB;
}

export function gbToGib(gb) {
  return gb / GIB_TO_GB;
}

// Round a GB figure UP to 2 decimal places. Admission must never round
// a requirement DOWN onto a device that cannot actually hold it.
function ceilTo2dp(gb) {
  return Math.ceil(gb * 100) / 100;
}

// One profile per measured config. Fields recorded only where measured:
// samplingGib is the flat sampling-phase figure (5.94 GiB, Run 10);
// decodeGib is the VAE-decode peak (the 121-frame peak occurs during
// decode, so decodeGib = peakGib there); headroomGib is recorded only
// for the 121-frame run. Unmeasured fields are null, never estimated.
export const RESOURCE_PROFILES = Object.freeze([
  Object.freeze({
    model: 'ltx-video-2b',
    resolution: '1024x576',
    frames: 17,
    steps: 8,
    decoderMode: 'single-pass',
    attentionBackend: 'default',
    basis: 'measured',
    source: PROFILE_SOURCE,
    checkpointSha256: CHECKPOINT_SHA256,
    peakGib: 6.92,
    samplingGib: null,
    decodeGib: null,
    headroomGib: null,
  }),
  Object.freeze({
    model: 'ltx-video-2b',
    resolution: '1024x576',
    frames: 49,
    steps: 8,
    decoderMode: 'single-pass',
    attentionBackend: 'default',
    basis: 'measured',
    source: PROFILE_SOURCE,
    checkpointSha256: CHECKPOINT_SHA256,
    peakGib: 8.68,
    samplingGib: null,
    decodeGib: null,
    headroomGib: null,
  }),
  Object.freeze({
    model: 'ltx-video-2b',
    resolution: '1024x576',
    frames: 121,
    steps: 8,
    decoderMode: 'single-pass',
    attentionBackend: 'default',
    basis: 'measured',
    source: PROFILE_SOURCE,
    checkpointSha256: CHECKPOINT_SHA256,
    peakGib: 12.64,
    samplingGib: 5.94,
    decodeGib: 12.64,
    headroomGib: 1.92,
  }),
]);

// Canonical key for a profile lookup. Only the six config fields count;
// anything else on the key object is ignored.
export function profileKey(key) {
  if (!key || typeof key !== 'object') return null;
  const { model, resolution, frames, steps, decoderMode, attentionBackend } = key;
  if (
    typeof model !== 'string'
    || typeof resolution !== 'string'
    || !Number.isInteger(frames)
    || !Number.isInteger(steps)
    || typeof decoderMode !== 'string'
    || typeof attentionBackend !== 'string'
  ) {
    return null;
  }
  return JSON.stringify([model, resolution, frames, steps, decoderMode, attentionBackend]);
}

const BY_KEY = new Map(RESOURCE_PROFILES.map((p) => [profileKey(p), p]));

// The measured profile for a config, or null when no measured profile
// covers it. Null means "unmeasured" — the caller must refuse, never
// interpolate. The returned profile is frozen; callers cannot mutate
// the measured record.
export function getProfile(key) {
  const k = profileKey(key);
  if (k === null) return null;
  return BY_KEY.get(k) ?? null;
}

// Required per-card VRAM in GB for a config: (peakGib + safetyMarginGib)
// converted to GB and rounded UP to 2 decimals. Returns null when no
// measured profile covers the config (fail closed — the caller keeps
// its previous behaviour or refuses, it never invents a number).
export function requiredVramGb(key, { safetyMarginGib = DEFAULT_SAFETY_MARGIN_GIB } = {}) {
  const profile = getProfile(key);
  if (!profile) return null;
  if (typeof safetyMarginGib !== 'number' || !Number.isFinite(safetyMarginGib) || safetyMarginGib < 0) {
    throw new Error('safetyMarginGib must be a finite number >= 0');
  }
  return ceilTo2dp(gibToGb(profile.peakGib + safetyMarginGib));
}

// Admit a job onto a device with deviceVramGb GB per card.
// Returns { admitted, reason, requiredGib, requiredGb, deviceVramGb,
// safetyMarginGib }. Refusals are fail-closed:
//   'no-measured-profile' — no profile covers the config; never guess.
//   'insufficient-vram'   — deviceVramGb < requiredGb.
//   'invalid-device-vram' — deviceVramGb is not a finite number > 0.
export function admitJob(key, deviceVramGb, { safetyMarginGib = DEFAULT_SAFETY_MARGIN_GIB } = {}) {
  if (typeof safetyMarginGib !== 'number' || !Number.isFinite(safetyMarginGib) || safetyMarginGib < 0) {
    throw new Error('safetyMarginGib must be a finite number >= 0');
  }
  const profile = getProfile(key);
  if (!profile) {
    return {
      admitted: false,
      reason: 'no-measured-profile',
      requiredGib: null,
      requiredGb: null,
      deviceVramGb,
      safetyMarginGib,
    };
  }
  const requiredGib = profile.peakGib + safetyMarginGib;
  const requiredGb = ceilTo2dp(gibToGb(requiredGib));
  if (typeof deviceVramGb !== 'number' || !Number.isFinite(deviceVramGb) || deviceVramGb <= 0) {
    return {
      admitted: false,
      reason: 'invalid-device-vram',
      requiredGib,
      requiredGb,
      deviceVramGb,
      safetyMarginGib,
    };
  }
  if (deviceVramGb < requiredGb) {
    return {
      admitted: false,
      reason: 'insufficient-vram',
      requiredGib,
      requiredGb,
      deviceVramGb,
      safetyMarginGib,
    };
  }
  return {
    admitted: true,
    reason: 'ok',
    requiredGib,
    requiredGb,
    deviceVramGb,
    safetyMarginGib,
  };
}
