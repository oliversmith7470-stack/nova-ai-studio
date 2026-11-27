// NOVA Personal GPU Cloud — Phase 6 Workstream F: throughput tests.
//
// Pure functions over job-record arrays; no GPU, no network. Statuses
// use the repo vocabulary (src/job.js): succeeded | failed | cancelled |
// timed-out | queued | dispatched | running.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN10_GENERATION_CALL_RATE,
  endToEndLatencyMs,
  generationCallRate,
  reliabilityAdjustedThroughput,
  warmGenerationThroughput,
  warmVideoThroughput,
} from '../src/phase6/throughput.js';

const T0 = '2026-11-24T07:00:00.000Z';
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();

function job(overrides) {
  return {
    frames: 121,
    activeGpuSeconds: 45.7,
    submittedAt: T0,
    downloadableAt: at(60_000),
    status: 'succeeded',
    ...overrides,
  };
}

test('warmGenerationThroughput counts completed frames per active GPU-second, successful jobs only', () => {
  const jobs = [
    job({ frames: 240, activeGpuSeconds: 60 }),
    job({ frames: 120, activeGpuSeconds: 30 }),
    // Failed work generates no completed frames and is excluded here.
    job({ frames: 999, activeGpuSeconds: 999, status: 'failed' }),
    job({ frames: 50, activeGpuSeconds: 10, status: 'running' }),
  ];
  assert.equal(warmGenerationThroughput(jobs), 4); // 360 frames / 90 s
});

test('warmVideoThroughput converts frames to video-seconds per active GPU-hour', () => {
  const jobs = [
    job({ frames: 240, activeGpuSeconds: 60 }),
    job({ frames: 120, activeGpuSeconds: 30 }),
    job({ frames: 999, activeGpuSeconds: 999, status: 'failed' }),
  ];
  // 360 frames / 24 fps = 15 video-s; 90 GPU-s = 0.025 GPU-h -> 600.
  assert.equal(warmVideoThroughput(jobs), 600);
  assert.equal(warmVideoThroughput(jobs, 24), 600);
  // A different fps changes the video-seconds, not the GPU time.
  assert.equal(warmVideoThroughput(jobs, 12), 1200);
  assert.throws(() => warmVideoThroughput(jobs, 0), /fps must be/);
  assert.throws(() => warmVideoThroughput(jobs, -24), /fps must be/);
});

test('endToEndLatencyMs reports per-job latencies plus the median', () => {
  const jobs = [
    job({ submittedAt: T0, downloadableAt: at(1_000) }),
    job({ submittedAt: T0, downloadableAt: at(3_000) }),
    job({ submittedAt: T0, downloadableAt: at(2_000) }),
  ];
  const out = endToEndLatencyMs(jobs);
  assert.deepEqual(out.latenciesMs, [1000, 3000, 2000]);
  assert.equal(out.medianMs, 2000);
  // Even count: median is the mean of the two middle values.
  const even = endToEndLatencyMs([
    job({ submittedAt: T0, downloadableAt: at(1_000) }),
    job({ submittedAt: T0, downloadableAt: at(3_000) }),
  ]);
  assert.equal(even.medianMs, 2000);
  // Epoch ms and Date objects are accepted as timestamps.
  const mixed = endToEndLatencyMs([
    job({ submittedAt: Date.parse(T0), downloadableAt: Date.parse(T0) + 5_000 }),
    job({ submittedAt: new Date(T0), downloadableAt: new Date(Date.parse(T0) + 7_000) }),
  ]);
  assert.deepEqual(mixed.latenciesMs, [5000, 7000]);
  assert.equal(mixed.medianMs, 6000);
});

test('endToEndLatencyMs skips jobs that never became downloadable, and throws on bad input', () => {
  const jobs = [
    job({ submittedAt: T0, downloadableAt: at(2_000) }),
    job({ status: 'failed', downloadableAt: null }),
    job({ status: 'running', downloadableAt: undefined }),
  ];
  assert.deepEqual(endToEndLatencyMs(jobs), { latenciesMs: [2000], medianMs: 2000 });
  assert.throws(() => endToEndLatencyMs([]), /non-empty array/);
  assert.throws(
    () => endToEndLatencyMs([job({ downloadableAt: null, status: 'failed' })]),
    /no job in the input ever became downloadable/,
  );
  assert.throws(
    () => endToEndLatencyMs([job({ submittedAt: at(5_000), downloadableAt: at(1_000) })]),
    /negative end-to-end latency/,
  );
  assert.throws(
    () => endToEndLatencyMs([job({ submittedAt: T0, downloadableAt: 'not-a-date' })]),
    /not a parseable timestamp/,
  );
  assert.throws(
    () => endToEndLatencyMs([job({ submittedAt: undefined, downloadableAt: at(1_000) })]),
    /has downloadableAt but no submittedAt/,
  );
});

test('reliabilityAdjustedThroughput INCLUDES failed jobs in the denominator GPU-seconds', () => {
  const jobs = [
    job({ activeGpuSeconds: 60 }),
    job({ activeGpuSeconds: 30 }),
    // 30 GPU-s of failed work: it counts in the denominator, not the numerator.
    job({ activeGpuSeconds: 30, status: 'failed', downloadableAt: at(10_000) }),
    // Cancelled work also burns GPU-seconds in the denominator.
    job({ activeGpuSeconds: 0, status: 'cancelled', downloadableAt: null }),
  ];
  // 2 downloadable outputs / (120 s = 1/30 GPU-h) = 60 outputs per GPU-h.
  assert.equal(reliabilityAdjustedThroughput(jobs), 60);
  // If the failed job's 30 s were wrongly omitted, the answer would be 80.
  assert.notEqual(reliabilityAdjustedThroughput(jobs), 80);
});

test('reliabilityAdjustedThroughput counts only succeeded AND downloadable outputs', () => {
  const jobs = [
    job({ activeGpuSeconds: 60 }),
    // Succeeded but never downloadable: not a downloadable output.
    job({ activeGpuSeconds: 60, downloadableAt: null }),
    job({ activeGpuSeconds: 60, status: 'failed' }),
  ];
  // 1 output / (180 s = 0.05 GPU-h) = 20 outputs per GPU-h.
  assert.equal(reliabilityAdjustedThroughput(jobs), 20);
});

test('all rates throw on empty input or negative values, and return null on a zero denominator', () => {
  assert.throws(() => warmGenerationThroughput([]), /non-empty array/);
  assert.throws(() => warmVideoThroughput([]), /non-empty array/);
  assert.throws(() => endToEndLatencyMs([]), /non-empty array/);
  assert.throws(() => reliabilityAdjustedThroughput([]), /non-empty array/);
  assert.throws(
    () => warmGenerationThroughput([job({ activeGpuSeconds: -1 })]),
    /activeGpuSeconds must be/,
  );
  assert.throws(
    () => warmGenerationThroughput([job({ frames: -5 })]),
    /frames must be/,
  );
  assert.throws(
    () => reliabilityAdjustedThroughput([job({ activeGpuSeconds: -0.5, status: 'failed' })]),
    /activeGpuSeconds must be/,
  );
  assert.throws(() => warmGenerationThroughput([job({ status: '' })]), /status string/);
  // Zero GPU-seconds everywhere: null, never a divide-by-zero or an invented rate.
  const zeroGpu = [job({ activeGpuSeconds: 0 }), job({ activeGpuSeconds: 0, status: 'failed' })];
  assert.equal(warmGenerationThroughput(zeroGpu), null);
  assert.equal(warmVideoThroughput(zeroGpu), null);
  assert.equal(reliabilityAdjustedThroughput(zeroGpu), null);
  // No successful jobs at all: warm rates have a zero denominator -> null.
  assert.equal(warmGenerationThroughput([job({ status: 'failed' })]), null);
  // Reliability with no successes but real GPU time: 0 outputs per GPU-h.
  assert.equal(reliabilityAdjustedThroughput([job({ status: 'failed' })]), 0);
});

test('Run 10 reference: 121 frames / 45.7 s = 2.65 fps generation-call rate (descriptive, single run)', () => {
  assert.ok(Math.abs(generationCallRate(121, 45.7) - 2.65) < 0.005);
  assert.equal(generationCallRate(121, 45.7).toFixed(2), '2.65');
  assert.equal(RUN10_GENERATION_CALL_RATE.frames, 121);
  assert.equal(RUN10_GENERATION_CALL_RATE.generationCallSeconds, 45.7);
  assert.equal(RUN10_GENERATION_CALL_RATE.framesPerSecondRounded, 2.65);
  assert.match(RUN10_GENERATION_CALL_RATE.note, /NOT sustained/);
  assert.ok(Object.isFrozen(RUN10_GENERATION_CALL_RATE));
  assert.throws(() => generationCallRate(121, 0), /seconds must be/);
  assert.throws(() => generationCallRate(-1, 45.7), /frames must be/);
});
