// Phase 6 Workstream G — measured resource profiles + admission.
//
// Admission is measured, never estimated: only the three LTX points
// proven on a Kaggle T4 admit; anything unmeasured refuses fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_PROFILES,
  CHECKPOINT_SHA256,
  DEFAULT_SAFETY_MARGIN_GIB,
  getProfile,
  requiredVramGb,
  admitJob,
  gibToGb,
  gbToGib,
} from '../src/phase6/resource-profiles.js';

const KEY_121 = {
  model: 'ltx-video-2b',
  resolution: '1024x576',
  frames: 121,
  steps: 8,
  decoderMode: 'single-pass',
  attentionBackend: 'default',
};
const KEY_49 = { ...KEY_121, frames: 49 };
const KEY_17 = { ...KEY_121, frames: 17 };

test('three measured LTX profiles exist, frozen, basis measured', () => {
  assert.equal(RESOURCE_PROFILES.length, 3);
  assert.ok(Object.isFrozen(RESOURCE_PROFILES));
  for (const p of RESOURCE_PROFILES) {
    assert.ok(Object.isFrozen(p), 'profile must be frozen');
    assert.equal(p.basis, 'measured');
    assert.equal(p.model, 'ltx-video-2b');
    assert.equal(p.resolution, '1024x576');
    assert.equal(p.steps, 8);
    assert.equal(p.decoderMode, 'single-pass');
    assert.equal(p.attentionBackend, 'default');
    assert.equal(p.checkpointSha256, CHECKPOINT_SHA256);
    assert.equal(
      p.source,
      'gpu-cloud/packages/ltx-proof-20261124-01/output/run10/ltx-proof-report.json',
    );
  }
});

test('measured peaks: 6.92 @ 17f, 8.68 @ 49f, 12.64 @ 121f', () => {
  assert.equal(getProfile(KEY_17).peakGib, 6.92);
  assert.equal(getProfile(KEY_49).peakGib, 8.68);
  assert.equal(getProfile(KEY_121).peakGib, 12.64);
});

test('121f records sampling, decode peak and headroom; shorter runs do not invent them', () => {
  const p121 = getProfile(KEY_121);
  assert.equal(p121.samplingGib, 5.94);
  assert.equal(p121.decodeGib, 12.64);
  assert.equal(p121.headroomGib, 1.92);
  for (const key of [KEY_17, KEY_49]) {
    const p = getProfile(key);
    assert.equal(p.samplingGib, null);
    assert.equal(p.decodeGib, null);
    assert.equal(p.headroomGib, null);
  }
});

test('getProfile returns null for unmeasured configs — never interpolates', () => {
  assert.equal(getProfile({ ...KEY_121, frames: 60 }), null);
  assert.equal(getProfile({ ...KEY_121, frames: 24 }), null);
  assert.equal(getProfile({ ...KEY_121, steps: 4 }), null);
  assert.equal(getProfile({ ...KEY_121, resolution: '1280x720' }), null);
  assert.equal(getProfile({ ...KEY_121, decoderMode: 'framewise' }), null);
  assert.equal(getProfile({ ...KEY_121, attentionBackend: 'flash' }), null);
  assert.equal(getProfile({ ...KEY_121, model: 'wan2.1-fun-inp-1.3b' }), null);
  assert.equal(getProfile(null), null);
  assert.equal(getProfile({}), null);
});

test('requiredVramGb: 121f is 15.64 GB with the default margin', () => {
  // (12.64 + 1.92) GiB = 14.56 GiB = 15.6336.. GB, rounded UP to 15.64.
  assert.equal(requiredVramGb(KEY_121), 15.64);
  assert.equal(requiredVramGb(KEY_49), 11.39);
  assert.equal(requiredVramGb(KEY_17), 9.5);
});

test('requiredVramGb returns null for an unmeasured config', () => {
  assert.equal(requiredVramGb({ ...KEY_121, frames: 60 }), null);
});

test('admission boundaries for the 121f profile: 16 admits, 15 and 12 refuse', () => {
  assert.equal(admitJob(KEY_121, 16).admitted, true);
  assert.equal(admitJob(KEY_121, 16).requiredGb, 15.64);
  assert.equal(admitJob(KEY_121, 16).reason, 'ok');
  const refuse15 = admitJob(KEY_121, 15);
  assert.equal(refuse15.admitted, false);
  assert.equal(refuse15.reason, 'insufficient-vram');
  assert.equal(refuse15.requiredGb, 15.64);
  const refuse12 = admitJob(KEY_121, 12);
  assert.equal(refuse12.admitted, false);
  assert.equal(refuse12.reason, 'insufficient-vram');
  // Exact boundary admits: a device at exactly the requirement clears it.
  assert.equal(admitJob(KEY_121, 15.64).admitted, true);
  assert.equal(admitJob(KEY_121, 15.63).admitted, false);
});

test('admission boundaries for shorter runs', () => {
  assert.equal(admitJob(KEY_49, 12).admitted, true);
  assert.equal(admitJob(KEY_49, 11).admitted, false);
  assert.equal(admitJob(KEY_17, 10).admitted, true);
  assert.equal(admitJob(KEY_17, 9).admitted, false);
});

test('unmeasured config refuses fail-closed with no-measured-profile', () => {
  const r = admitJob({ ...KEY_121, frames: 60 }, 16);
  assert.equal(r.admitted, false);
  assert.equal(r.reason, 'no-measured-profile');
  assert.equal(r.requiredGb, null);
  assert.equal(r.requiredGib, null);
  // Even an infinitely large device does not admit an unmeasured config.
  assert.equal(admitJob({ ...KEY_121, frames: 60 }, 1000).admitted, false);
});

test('safety margin is an explicit parameter; default is the proven 1.92 GiB headroom', () => {
  assert.equal(DEFAULT_SAFETY_MARGIN_GIB, 1.92);
  // Default == explicit 1.92.
  assert.deepEqual(admitJob(KEY_121, 16), admitJob(KEY_121, 16, { safetyMarginGib: 1.92 }));
  assert.equal(requiredVramGb(KEY_121), requiredVramGb(KEY_121, { safetyMarginGib: 1.92 }));
  // No margin: (12.64 GiB) = 13.58 GB — a 14 GB device would admit, 13 would not.
  assert.equal(requiredVramGb(KEY_121, { safetyMarginGib: 0 }), 13.58);
  assert.equal(admitJob(KEY_121, 14, { safetyMarginGib: 0 }).admitted, true);
  assert.equal(admitJob(KEY_121, 13, { safetyMarginGib: 0 }).admitted, false);
  // Larger margin tightens admission: margin 3 GiB needs 16.80 GB, so 16 refuses.
  assert.equal(requiredVramGb(KEY_121, { safetyMarginGib: 3 }), 16.8);
  assert.equal(admitJob(KEY_121, 16, { safetyMarginGib: 3 }).admitted, false);
  assert.equal(admitJob(KEY_121, 17, { safetyMarginGib: 3 }).admitted, true);
});

test('negative or non-finite safety margin throws', () => {
  assert.throws(() => admitJob(KEY_121, 16, { safetyMarginGib: -1 }), /safetyMarginGib/);
  assert.throws(() => requiredVramGb(KEY_121, { safetyMarginGib: -1 }), /safetyMarginGib/);
  assert.throws(() => admitJob(KEY_121, 16, { safetyMarginGib: Number.NaN }), /safetyMarginGib/);
});

test('invalid device VRAM refuses fail-closed, never admits', () => {
  for (const bad of [0, -1, Number.NaN, Infinity, '16', null, undefined]) {
    const r = admitJob(KEY_121, bad);
    assert.equal(r.admitted, false, `deviceVramGb ${String(bad)} must not admit`);
    assert.equal(r.reason, 'invalid-device-vram');
  }
});

test('unit conversion: 1 GiB = 1.073741824 GB, round-trip', () => {
  assert.equal(gibToGb(1), 1.073741824);
  assert.equal(gibToGb(14.56), 15.633680957440001);
  assert.equal(gbToGib(16), 16 / 1.073741824);
  assert.ok(Math.abs(gbToGib(gibToGb(12.64)) - 12.64) < 1e-9);
  // A "12 GB" card is ~11.18 GiB — below the 12.64 GiB peak (the O-1 trap).
  assert.ok(gbToGib(12) < 12.64);
  assert.ok(Math.abs(gbToGib(12) - 11.18) < 0.01);
});

test('frozen profiles cannot be mutated', () => {
  const p = getProfile(KEY_121);
  assert.ok(Object.isFrozen(p));
  assert.throws(() => { p.peakGib = 1; }, TypeError);
  assert.equal(getProfile(KEY_121).peakGib, 12.64);
  assert.throws(() => { RESOURCE_PROFILES.push({}); }, TypeError);
});
