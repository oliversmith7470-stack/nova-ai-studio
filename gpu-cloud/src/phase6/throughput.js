// NOVA Personal GPU Cloud — Phase 6 Workstream F: throughput metrics.
//
// Pure functions over job-record arrays. Job records are plain objects:
//   { frames, activeGpuSeconds, submittedAt, downloadableAt, status }
// Status vocabulary is the repo's own (src/job.js JOB_STATUSES):
//   queued | dispatched | running | succeeded | failed | cancelled | timed-out
// "Successful" below means status === 'succeeded'. Timestamps may be
// Date objects, epoch milliseconds, or ISO-8601 strings.
//
// The four rates (design §13, F1):
//   1. Warm generation throughput: completed frames per active GPU-second,
//      successful jobs only, queue/startup excluded (activeGpuSeconds is
//      GPU-busy time, not wall time).
//   2. Warm video throughput: generated video-seconds per active GPU-hour,
//      successful jobs only.
//   3. End-to-end service latency: submission -> downloadable, per job
//      plus the median.
//   4. Reliability-adjusted throughput: successfully validated and
//      downloadable outputs per active GPU-hour, with FAILED jobs INCLUDED
//      in the denominator's GPU-seconds — never omitted.
//
// All functions throw on empty input or negative durations/values, and
// return null (never divide by zero, never invent a rate) when the
// denominator is zero. No I/O, no network, no mutation of inputs.

export const SUCCESS_STATUS = 'succeeded';
export const FAILED_STATUS = 'failed';

// Run 10 worked reference (design §3.3): 121 frames / 45.7 s generation
// call = 2.65 frames per generation-call second. This is a DESCRIPTIVE
// single-run calculation, NOT sustained multi-job throughput.
export const RUN10_GENERATION_CALL_RATE = Object.freeze({
  frames: 121,
  generationCallSeconds: 45.7,
  framesPerSecond: 121 / 45.7,
  framesPerSecondRounded: 2.65,
  basis: 'single Run 10 generation call (sampling 32.6 s + decode 13.1 s)',
  note: 'Descriptive single-run rate, NOT sustained multi-job throughput.',
});

// Frames per generation-call second for one run (the Run 10 arithmetic).
export function generationCallRate(frames, seconds) {
  if (!Number.isFinite(frames) || frames < 0) {
    throw new Error(`frames must be a finite number >= 0, got ${frames}`);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`seconds must be a finite number > 0, got ${seconds}`);
  }
  return frames / seconds;
}

function requireJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('jobs must be a non-empty array of job records');
  }
  return jobs;
}

function requireJobNumbers(job, index) {
  if (!job || typeof job !== 'object') {
    throw new Error(`job ${index} must be an object`);
  }
  if (typeof job.status !== 'string' || job.status.length === 0) {
    throw new Error(`job ${index} must carry a status string`);
  }
  if (!Number.isFinite(job.frames) || job.frames < 0) {
    throw new Error(`job ${index} frames must be a finite number >= 0, got ${job.frames}`);
  }
  if (!Number.isFinite(job.activeGpuSeconds) || job.activeGpuSeconds < 0) {
    throw new Error(
      `job ${index} activeGpuSeconds must be a finite number >= 0, got ${job.activeGpuSeconds}`,
    );
  }
}

function toEpochMs(value, jobIndex, field) {
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    throw new Error(`job ${jobIndex} ${field} must be a Date, epoch ms, or ISO string`);
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`job ${jobIndex} ${field} is not a parseable timestamp: ${value}`);
  }
  return ms;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires a non-empty array');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function isSuccessful(job) {
  return job.status === SUCCESS_STATUS;
}

// 1. Warm generation throughput: completed frames per active GPU-second,
//    successful jobs only. Null when successful jobs used zero GPU-seconds.
export function warmGenerationThroughput(jobs) {
  requireJobs(jobs);
  let frames = 0;
  let gpuSeconds = 0;
  jobs.forEach((job, i) => {
    requireJobNumbers(job, i);
    if (isSuccessful(job)) {
      frames += job.frames;
      gpuSeconds += job.activeGpuSeconds;
    }
  });
  if (gpuSeconds === 0) {
    return null;
  }
  return frames / gpuSeconds;
}

// 2. Warm video throughput: generated video-seconds per active GPU-hour,
//    successful jobs only. `fps` converts frames to video-seconds
//    (Run 10: 24 fps). Null when successful jobs used zero GPU-seconds.
export function warmVideoThroughput(jobs, fps = 24) {
  requireJobs(jobs);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps must be a finite number > 0, got ${fps}`);
  }
  let videoSeconds = 0;
  let gpuSeconds = 0;
  jobs.forEach((job, i) => {
    requireJobNumbers(job, i);
    if (isSuccessful(job)) {
      videoSeconds += job.frames / fps;
      gpuSeconds += job.activeGpuSeconds;
    }
  });
  if (gpuSeconds === 0) {
    return null;
  }
  return videoSeconds / (gpuSeconds / 3600);
}

// 3. End-to-end service latency: submission -> downloadable, per job
//    plus the median. Jobs with no downloadableAt never became
//    downloadable and are skipped; if none remain, throws. A
//    downloadable timestamp before submission throws (negative duration).
export function endToEndLatencyMs(jobs) {
  requireJobs(jobs);
  const latenciesMs = [];
  jobs.forEach((job, i) => {
    if (!job || typeof job !== 'object') {
      throw new Error(`job ${i} must be an object`);
    }
    if (job.downloadableAt === undefined || job.downloadableAt === null) {
      return;
    }
    if (job.submittedAt === undefined || job.submittedAt === null) {
      throw new Error(`job ${i} has downloadableAt but no submittedAt`);
    }
    const submittedMs = toEpochMs(job.submittedAt, i, 'submittedAt');
    const downloadableMs = toEpochMs(job.downloadableAt, i, 'downloadableAt');
    const latency = downloadableMs - submittedMs;
    if (latency < 0) {
      throw new Error(
        `job ${i} has negative end-to-end latency: downloadableAt precedes submittedAt by ${-latency} ms`,
      );
    }
    latenciesMs.push(latency);
  });
  if (latenciesMs.length === 0) {
    throw new Error('no job in the input ever became downloadable');
  }
  return { latenciesMs, medianMs: median(latenciesMs) };
}

// 4. Reliability-adjusted throughput: successfully validated and
//    downloadable outputs per active GPU-hour. The numerator counts only
//    succeeded jobs that reached downloadableAt; the denominator sums
//    activeGpuSeconds over ALL jobs — including failed, cancelled and
//    timed-out ones. Null when total GPU-seconds are zero.
export function reliabilityAdjustedThroughput(jobs) {
  requireJobs(jobs);
  let outputs = 0;
  let gpuSeconds = 0;
  jobs.forEach((job, i) => {
    requireJobNumbers(job, i);
    gpuSeconds += job.activeGpuSeconds;
    if (
      isSuccessful(job) &&
      job.downloadableAt !== undefined &&
      job.downloadableAt !== null
    ) {
      outputs += 1;
    }
  });
  if (gpuSeconds === 0) {
    return null;
  }
  return outputs / (gpuSeconds / 3600);
}
