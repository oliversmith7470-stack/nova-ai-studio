// NOVA Personal GPU Cloud — Phase 6 Gate 2: benchmark harness tests.
//
// CPU fixtures only: synthetic frame arrays plus a tiny MP4 generated
// with ffmpeg (lavfi testsrc, 8 frames) in a temp dir. No GPU, no
// provider, no network, no dependency on the 190 MB proof packages dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boundaryDiscontinuity,
  configHash,
  consecutiveFrameMad,
  findDuplicatesOrMissing,
  keyframeFidelity,
  meanAbsoluteDifference,
  probeVideo,
  sha256File,
  stableStringify,
  validateBenchmarkReport,
  validateVideoFile,
} from '../src/phase6/benchmark.js';

const BASELINE_URL = new URL('../src/phase6/run10-baseline.json', import.meta.url);
const REPORT_URL = new URL(
  '../packages/ltx-proof-20261124-01/output/run10/ltx-proof-report.json',
  import.meta.url,
);
const EVIDENCE_URL = new URL('../docs/ltx-proof-evidence-2026-11-24.md', import.meta.url);

function loadBaseline() {
  return JSON.parse(readFileSync(fileURLToPath(BASELINE_URL), 'utf8'));
}

// Generate a tiny fixture MP4 (8 frames, 64x36, 24 fps, h264, yuv420p)
// with ffmpeg; register cleanup on the test context.
function makeFixtureMp4(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phase6-benchmark-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=64x36:rate=24',
    '-frames:v', '8',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', '24',
    file,
  ]);
  return file;
}

test('run10-baseline.json validates against the benchmark report schema', () => {
  const manifest = loadBaseline();
  const result = validateBenchmarkReport(manifest);
  assert.deepEqual(result, { ok: true, missing: [], invalid: [] });
});

test('run10-baseline.json matches the Run 10 report JSON values', () => {
  const manifest = loadBaseline();
  const report = JSON.parse(readFileSync(fileURLToPath(REPORT_URL), 'utf8'));
  assert.equal(manifest.model, report.model);
  assert.equal(manifest.checkpoint.sha256, report.ltx_checkpoint.sha256);
  assert.equal(manifest.checkpoint.sizeBytes, report.ltx_checkpoint.size_bytes);
  assert.equal(manifest.checkpoint.path, report.ltx_checkpoint.path);
  assert.equal(manifest.implementation, report.implementation);
  assert.equal(manifest.versions.diffusers, report.packages_post_install.diffusers);
  assert.equal(manifest.versions.transformers, report.packages_post_install.transformers);
  assert.equal(manifest.versions.torch, report.torch_version);
  assert.equal(manifest.versions.cuda, report.cuda_version);
  assert.equal(manifest.config.prompt, report.prompt);
  assert.equal(manifest.config.seed, report.generation.seed);
  assert.equal(manifest.config.frames, report.generation.num_frames);
  assert.equal(manifest.config.width, report.generation.width);
  assert.equal(manifest.config.height, report.generation.height);
  assert.equal(manifest.config.fps, report.output.fps);
  assert.equal(manifest.config.steps, report.generation.num_inference_steps);
  assert.equal(manifest.config.guidanceScale, report.generation.guidance_scale);
  assert.equal(manifest.config.decodeTimestep, report.generation.decode_timestep);
  assert.equal(manifest.config.imageCondNoiseScale, report.generation.image_cond_noise_scale);
  assert.equal(manifest.config.maxSequenceLength, report.max_sequence_length);
  assert.equal(manifest.measured.samplingS, report.generation.sampling_s);
  assert.equal(manifest.measured.decodeS, report.generation.decode_s);
  assert.equal(manifest.measured.totalGenerateS, report.generation.total_generate_s);
  assert.equal(manifest.measured.exportS, report.export_s);
  assert.equal(manifest.measured.notebookElapsedS, report.total_elapsed_s);
  assert.equal(manifest.measured.peakVramGib, report.generation.peak_vram_gib);
  assert.equal(manifest.measured.samplingVramGib, report.generation.per_step_vram_gib[0]);
  assert.equal(manifest.measured.hostRamPeakGib, report.rss_gib_after_generation);
  assert.equal(manifest.output.frames, report.output.frames_decoded);
  assert.equal(manifest.output.codec, report.output.codec);
  assert.equal(manifest.output.pixFmt, report.output.pix_fmt);
  assert.equal(manifest.output.resolution, report.output.resolution);
  assert.equal(manifest.output.durationS, Number.parseFloat(report.output.reader_meta.duration));
  assert.equal(manifest.output.sizeBytes, report.output.size_bytes);
  assert.equal(manifest.output.sha256, report.output.sha256);
  assert.equal(manifest.gpu.name, report.gpu[0].name);
  assert.equal(manifest.gpu.computeCapability, report.gpu[0].cc);
  assert.equal(manifest.gpu.totalGib, report.gpu[0].total_gib);
  // Reference MADs are the evidence doc's values, not thresholds.
  assert.equal(manifest.qualityReference.madFirst, 4.08);
  assert.equal(manifest.qualityReference.madLast, 7.34);
  assert.match(manifest.qualityReference.note, /NOT pass thresholds/);
  assert.equal(manifest.benchmark, 'run10-baseline');
  assert.equal(manifest.runId, 'run10');
});

test('run10-baseline.json evidence-only values appear in the evidence doc', () => {
  const manifest = loadBaseline();
  const evidence = readFileSync(fileURLToPath(EVIDENCE_URL), 'utf8');
  assert.ok(evidence.includes(manifest.config.keyframes.first.sha256));
  assert.ok(evidence.includes(manifest.config.keyframes.last.sha256));
  assert.ok(evidence.includes(manifest.storage.ref));
  assert.ok(evidence.includes(manifest.storage.expiresAt));
  assert.ok(evidence.includes(manifest.workerId));
  assert.ok(evidence.includes(String(manifest.qualityReference.firstFrameVsLastKeyframeMad)));
  assert.ok(evidence.includes(String(manifest.qualityReference.lastFrameVsFirstKeyframeMad)));
});

test('schema validation fails closed: missing field, wrong type, bad hash', () => {
  const missingSha = loadBaseline();
  delete missingSha.output.sha256;
  const r1 = validateBenchmarkReport(missingSha);
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.missing, ['output.sha256']);
  assert.deepEqual(r1.invalid, []);

  const missingPrompt = loadBaseline();
  delete missingPrompt.config.prompt;
  assert.deepEqual(validateBenchmarkReport(missingPrompt).missing, ['config.prompt']);

  const wrongType = loadBaseline();
  wrongType.output.frames = '121';
  const r3 = validateBenchmarkReport(wrongType);
  assert.equal(r3.ok, false);
  assert.ok(r3.invalid.some((m) => m.includes('output.frames')));

  const badHash = loadBaseline();
  badHash.output.sha256 = 'not-a-hash';
  const r4 = validateBenchmarkReport(badHash);
  assert.equal(r4.ok, false);
  assert.ok(r4.invalid.some((m) => m.includes('output.sha256')));

  const negative = loadBaseline();
  negative.measured.samplingS = -1;
  assert.equal(validateBenchmarkReport(negative).ok, false);

  const badTimestamp = loadBaseline();
  badTimestamp.timestamp = '24 Nov 2026';
  assert.equal(validateBenchmarkReport(badTimestamp).ok, false);

  assert.deepEqual(validateBenchmarkReport(null), {
    ok: false,
    missing: [],
    invalid: ['report must be a plain object'],
  });
  assert.equal(validateBenchmarkReport([]).ok, false);
});

test('schema validation rejects secret-looking values anywhere in the report', () => {
  const withKey = loadBaseline();
  withKey.implementation = 'call with api_key=sk-test-123';
  const r1 = validateBenchmarkReport(withKey);
  assert.equal(r1.ok, false);
  assert.ok(r1.invalid.some((m) => m.includes('secret-looking value at implementation')));

  const nested = loadBaseline();
  nested.config.prompt = 'my password is hunter2';
  const r2 = validateBenchmarkReport(nested);
  assert.equal(r2.ok, false);
  assert.ok(r2.invalid.some((m) => m.includes('secret-looking value at config.prompt')));

  const bearer = loadBaseline();
  bearer.storage.ref = 'Bearer abc123';
  assert.equal(validateBenchmarkReport(bearer).ok, false);
});

test('meanAbsoluteDifference computes exact MADs and validates inputs', () => {
  assert.equal(meanAbsoluteDifference([0, 10, 20], [0, 10, 20]), 0);
  assert.equal(meanAbsoluteDifference([0, 0], [10, 10]), 10);
  assert.equal(meanAbsoluteDifference([1, 2, 3], [4, 5, 6]), 3);
  assert.equal(meanAbsoluteDifference([0], [255]), 255);
  assert.throws(() => meanAbsoluteDifference([1, 2], [1]), /equal length/);
  assert.throws(() => meanAbsoluteDifference([], []), /non-empty array/);
  assert.throws(() => meanAbsoluteDifference([1, 'x'], [1, 2]), /only finite numbers/);
});

test('keyframeFidelity reports direct MADs and the opposite-keyframe cross-check', () => {
  const ok = keyframeFidelity([0, 0], [100, 100], [0, 0], [100, 100]);
  assert.deepEqual(ok, {
    firstFrameMad: 0,
    lastFrameMad: 0,
    firstFrameVsLastKeyframeMad: 100,
    lastFrameVsFirstKeyframeMad: 100,
  });
  // Reversed conditioning is detectable: the cross-check MAD is smaller
  // than the direct MAD when a frame matches the opposite keyframe.
  const swapped = keyframeFidelity([90, 90], [10, 10], [0, 0], [100, 100]);
  assert.equal(swapped.firstFrameMad, 90);
  assert.equal(swapped.firstFrameVsLastKeyframeMad, 10);
  assert.ok(swapped.firstFrameVsLastKeyframeMad < swapped.firstFrameMad);
  assert.equal(swapped.lastFrameMad, 90);
  assert.equal(swapped.lastFrameVsFirstKeyframeMad, 10);
});

test('consecutiveFrameMad returns the distribution with median and max', () => {
  const out = consecutiveFrameMad([[0], [10], [30]]);
  assert.deepEqual(out.values, [10, 20]);
  assert.equal(out.median, 15);
  assert.equal(out.max, 20);
  assert.equal(out.min, 10);
  assert.equal(out.mean, 15);
  assert.throws(() => consecutiveFrameMad([[0]]), /at least 2 frames/);
});

test('findDuplicatesOrMissing detects duplicates and gaps in frame ids', () => {
  assert.deepEqual(findDuplicatesOrMissing([0, 1, 2, 2, 4]), {
    ok: false,
    duplicates: [{ id: 2, count: 2, indexes: [2, 3] }],
    missing: [3],
  });
  assert.deepEqual(findDuplicatesOrMissing([0, 1, 2, 3]), {
    ok: true,
    duplicates: [],
    missing: [],
  });
  const strings = findDuplicatesOrMissing(['a', 'b', 'a']);
  assert.equal(strings.ok, false);
  assert.equal(strings.duplicates[0].id, 'a');
  assert.deepEqual(strings.missing, []);
  assert.throws(() => findDuplicatesOrMissing([]), /non-empty array/);
});

test('boundaryDiscontinuity reports MAD ratios with no threshold', () => {
  const frames = Array.from({ length: 17 }, (_, i) => [i * 10]);
  const steady = boundaryDiscontinuity(frames, [9]);
  assert.equal(steady.medianConsecutiveMad, 10);
  assert.deepEqual(steady.boundaries, [{ boundaryIndex: 9, mad: 10, ratio: 1 }]);

  // A spike at the boundary: MAD 120 across it vs median 10 -> ratio 12.
  const spiked = frames.map((f) => [...f]);
  spiked[9] = [200];
  const out = boundaryDiscontinuity(spiked, [9]);
  assert.equal(out.medianConsecutiveMad, 10);
  assert.equal(out.boundaries[0].mad, 120);
  assert.equal(out.boundaries[0].ratio, 12);

  // Identical neighbours: median 0 -> ratio null, never Infinity/NaN.
  const flat = boundaryDiscontinuity([[5], [5], [5]], [1, 2]);
  assert.equal(flat.medianConsecutiveMad, 0);
  assert.deepEqual(
    flat.boundaries.map((b) => b.ratio),
    [null, null],
  );
  assert.throws(() => boundaryDiscontinuity([[0], [1]], [0]), /boundary index 0/);
  assert.throws(() => boundaryDiscontinuity([[0], [1]], [2]), /boundary index 2/);
  assert.throws(() => boundaryDiscontinuity([[0]], [1]), /at least 2 frames/);
});

test('probeVideo reads real ffprobe metadata plus a node:crypto SHA-256', async (t) => {
  const file = makeFixtureMp4(t);
  const probe = await probeVideo(file);
  assert.equal(probe.frames, 8);
  assert.equal(probe.width, 64);
  assert.equal(probe.height, 36);
  assert.equal(probe.fps, 24);
  assert.equal(probe.codec, 'h264');
  assert.equal(probe.pixFmt, 'yuv420p');
  assert.ok(Math.abs(probe.duration - 8 / 24) < 0.01, `duration ${probe.duration}`);
  assert.match(probe.sha256, /^[0-9a-f]{64}$/);
  assert.equal(probe.sha256, await sha256File(file));
  await assert.rejects(() => probeVideo(join(file, 'missing.mp4')), /ffprobe failed/);
  await assert.rejects(() => probeVideo(''), /non-empty file path/);
});

test('validateVideoFile passes a matching fixture and fails closed on mismatches', async (t) => {
  const file = makeFixtureMp4(t);
  const expected = { frames: 8, width: 64, height: 36, fps: 24, codec: 'h264', pixFmt: 'yuv420p' };
  const good = await validateVideoFile(file, expected);
  assert.equal(good.ok, true);
  assert.deepEqual(good.failures, []);
  assert.equal(good.checks.length, 6);
  assert.ok(good.checks.every((c) => c.passed));

  const wrongFrames = await validateVideoFile(file, { ...expected, frames: 9 });
  assert.equal(wrongFrames.ok, false);
  assert.ok(wrongFrames.failures.some((f) => f.includes('frames: expected 9, got 8')));

  const wrongPixFmt = await validateVideoFile(file, { ...expected, pixFmt: 'yuv444p' });
  assert.equal(wrongPixFmt.ok, false);
  assert.ok(wrongPixFmt.failures.some((f) => f.includes('pixFmt')));

  const missing = await validateVideoFile(join(file, 'missing.mp4'), expected);
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.length, 0);
  assert.ok(missing.failures[0].startsWith('probe failed:'));
});

test('configHash is stable under key order and sensitive to any changed field', () => {
  const a = { seed: 42, frames: 121, nested: { b: 2, a: 1 } };
  const reordered = { nested: { a: 1, b: 2 }, frames: 121, seed: 42 };
  assert.equal(configHash(a), configHash(reordered));
  assert.match(configHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(configHash(a), configHash({ ...a, seed: 43 }));
  assert.notEqual(configHash(a), configHash({ ...a, nested: { a: 1, b: 3 } }));
  assert.equal(
    stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":1}',
  );
  assert.throws(() => configHash([1, 2]), /plain config object/);
  assert.throws(() => configHash(null), /plain config object/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => configHash(circular), /circular|Converting circular/);
});
