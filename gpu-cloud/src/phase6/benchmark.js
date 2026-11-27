// NOVA Personal GPU Cloud — Phase 6 §16/§17: benchmark harness.
//
// Machine-readable benchmark reports, quality metrics on frame arrays,
// ffprobe video validation, and stable config hashing. CPU-only fixtures:
// no GPU, no provider, no network. Pure functions except probeVideo /
// validateVideoFile, which shell out to the local ffprobe binary and read
// the file under test (for its SHA-256).
//
// QUALITY CONTRACT (§16): Run 10's MAD values (4.08 first / 7.34 last)
// are REFERENCE OBSERVATIONS, not pass thresholds. No quality tolerance
// has been approved: metrics are reported, thresholds stay null/absent
// until owner-approved. Nothing in this module passes or fails a video
// on quality — boundaryDiscontinuity reports ratios, it does not judge
// them.
//
// SECRETS (§17): no API keys, tokens, .env contents, private user media
// or secrets belong in logs or reports. validateBenchmarkReport fails
// closed on any secret-looking string value.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Secret-looking values are rejected, wherever they appear in a report.
export const SECRET_PATTERN = /api[_-]?key|token|secret|password|bearer/i;

// ---------------------------------------------------------------------------
// Report schema (design §17)
// ---------------------------------------------------------------------------
//
// Required paths use the manifest shape defined by run10-baseline.json.
// Two §17 items have no evidenced value for the historical Run 10 and are
// therefore OPTIONAL (not silently filled): `sourceRevision` (no revision
// was recorded for the run) and `workerReadiness` (Run 10 ran on a Kaggle
// notebook, not a Phase 5 worker, so no readiness state exists). Both are
// recorded as open gaps in run10-baseline.json's notes. Every other §17
// field is required and fails closed when missing.

const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function req(path, type, extra = {}) {
  return { path, type, ...extra };
}

export const BENCHMARK_REPORT_SCHEMA = Object.freeze({
  version: 1,
  required: Object.freeze([
    req('benchmark', 'string'),
    req('runId', 'string'),
    req('timestamp', 'iso-timestamp'),
    req('model', 'string'),
    req('checkpoint.path', 'string'),
    req('checkpoint.sha256', 'sha256'),
    req('checkpoint.sizeBytes', 'integer', { min: 1 }),
    req('implementation', 'string'),
    req('versions.diffusers', 'string'),
    req('versions.transformers', 'string'),
    req('versions.torch', 'string'),
    req('versions.cuda', 'string'),
    req('gpu.name', 'string'),
    req('gpu.computeCapability', 'string'),
    req('gpu.totalGib', 'number', { min: 0 }),
    req('config.prompt', 'string'),
    req('config.seed', 'integer'),
    req('config.frames', 'integer', { min: 1 }),
    req('config.width', 'integer', { min: 1 }),
    req('config.height', 'integer', { min: 1 }),
    req('config.fps', 'number', { min: 0 }),
    req('config.steps', 'integer', { min: 1 }),
    req('config.guidanceScale', 'number', { min: 0 }),
    req('config.decodeTimestep', 'number', { min: 0 }),
    req('config.imageCondNoiseScale', 'number', { min: 0 }),
    req('config.maxSequenceLength', 'integer', { min: 1 }),
    req('measured.samplingS', 'number', { min: 0 }),
    req('measured.decodeS', 'number', { min: 0 }),
    req('measured.totalGenerateS', 'number', { min: 0 }),
    req('measured.exportS', 'number', { min: 0 }),
    req('measured.notebookElapsedS', 'number', { min: 0 }),
    req('measured.peakVramGib', 'number', { min: 0 }),
    req('measured.samplingVramGib', 'number', { min: 0 }),
    req('measured.hostRamPeakGib', 'number', { min: 0 }),
    req('output.frames', 'integer', { min: 1 }),
    req('output.codec', 'string'),
    req('output.pixFmt', 'string'),
    req('output.resolution', 'string'),
    req('output.fps', 'number', { min: 0 }),
    req('output.durationS', 'number', { min: 0 }),
    req('output.sizeBytes', 'integer', { min: 1 }),
    req('output.sha256', 'sha256'),
    req('qualityReference.madFirst', 'number', { min: 0 }),
    req('qualityReference.madLast', 'number', { min: 0 }),
    req('failureClassification', 'string'),
    req('workerId', 'string'),
    req('storage.ref', 'string'),
    req('storage.expiresAt', 'iso-timestamp'),
    req('provenance.reportPath', 'string'),
    req('provenance.evidenceDocPath', 'string'),
    req('provenance.notebookPath', 'string'),
  ]),
  // §17 fields with no evidenced Run 10 value; required for new reports
  // once the value exists, optional here so the historical baseline is
  // not filled with invented data.
  optional: Object.freeze(['sourceRevision', 'workerReadiness']),
});

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function checkType(field, value) {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' && value.length > 0
        ? null
        : `${field.path} must be a non-empty string`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) &&
        (field.min === undefined || value >= field.min)
        ? null
        : `${field.path} must be a finite number${field.min !== undefined ? ` >= ${field.min}` : ''}`;
    case 'integer':
      return Number.isInteger(value) && (field.min === undefined || value >= field.min)
        ? null
        : `${field.path} must be an integer${field.min !== undefined ? ` >= ${field.min}` : ''}`;
    case 'sha256':
      return typeof value === 'string' && SHA256_RE.test(value)
        ? null
        : `${field.path} must be a 64-character lowercase hex SHA-256`;
    case 'iso-timestamp':
      return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value) &&
        Number.isFinite(Date.parse(value))
        ? null
        : `${field.path} must be an ISO-8601 timestamp string`;
    default:
      return `${field.path} has unknown schema type ${field.type}`;
  }
}

// Recursively collect every string key and string value with its path,
// for the secret scan.
function collectStrings(value, path, out) {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_PATTERN.test(key)) {
        out.push({ path: childPath, value: `(field name) ${key}` });
      }
      collectStrings(item, childPath, out);
    }
  }
}

// Validate a benchmark report against BENCHMARK_REPORT_SCHEMA.
// Returns { ok, missing[], invalid[] }; fails closed: any missing required
// field or any secret-looking string value makes ok false.
export function validateBenchmarkReport(report) {
  const missing = [];
  const invalid = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, missing, invalid: ['report must be a plain object'] };
  }
  for (const field of BENCHMARK_REPORT_SCHEMA.required) {
    const value = getPath(report, field.path);
    if (value === undefined || value === null) {
      missing.push(field.path);
      continue;
    }
    const problem = checkType(field, value);
    if (problem) {
      invalid.push(problem);
    }
  }
  const strings = [];
  collectStrings(report, '', strings);
  for (const { path, value } of strings) {
    if (SECRET_PATTERN.test(value)) {
      invalid.push(`secret-looking value at ${path || '(root)'}`);
    }
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

// ---------------------------------------------------------------------------
// Quality metrics on frame arrays
// ---------------------------------------------------------------------------
//
// A "frame" here is a flat numeric array (e.g. pixel values). MAD is in
// the frame's own units; the evidence doc reports MADs on a /255 scale.

function requireFrame(frame, name) {
  if (!Array.isArray(frame) || frame.length === 0) {
    throw new Error(`${name} must be a non-empty array of numbers`);
  }
  for (const v of frame) {
    if (!Number.isFinite(v)) {
      throw new Error(`${name} must contain only finite numbers, got ${v}`);
    }
  }
}

// Mean absolute difference between two flat numeric frames.
export function meanAbsoluteDifference(frameA, frameB) {
  requireFrame(frameA, 'frameA');
  requireFrame(frameB, 'frameB');
  if (frameA.length !== frameB.length) {
    throw new Error(
      `frames must have equal length, got ${frameA.length} and ${frameB.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < frameA.length; i += 1) {
    sum += Math.abs(frameA[i] - frameB[i]);
  }
  return sum / frameA.length;
}

// Keyframe fidelity (§16 B): first/last frame MAD against the matching
// keyframe, plus the cross-check against the OPPOSITE keyframe (a small
// cross-check MAD next to a large direct MAD would expose reversed
// conditioning; the cross-checks must be much larger than the direct
// MADs for correctly matched endpoints).
export function keyframeFidelity(firstFrame, lastFrame, firstKeyframe, lastKeyframe) {
  return {
    firstFrameMad: meanAbsoluteDifference(firstFrame, firstKeyframe),
    lastFrameMad: meanAbsoluteDifference(lastFrame, lastKeyframe),
    firstFrameVsLastKeyframeMad: meanAbsoluteDifference(firstFrame, lastKeyframe),
    lastFrameVsFirstKeyframeMad: meanAbsoluteDifference(lastFrame, firstKeyframe),
  };
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires a non-empty array');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Consecutive-frame MAD distribution (§16 C): one MAD per adjacent pair.
export function consecutiveFrameMad(frames) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error('consecutiveFrameMad requires at least 2 frames');
  }
  const values = [];
  for (let i = 1; i < frames.length; i += 1) {
    values.push(meanAbsoluteDifference(frames[i - 1], frames[i]));
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { values, median: median(values), max, min, mean };
}

// Exact identity-sequence check (§16 C): duplicate frame ids and gaps in
// a numeric id sequence. Non-numeric ids support duplicate detection
// only (no notion of a gap).
export function findDuplicatesOrMissing(frameIds) {
  if (!Array.isArray(frameIds) || frameIds.length === 0) {
    throw new Error('frameIds must be a non-empty array');
  }
  const seen = new Map();
  const duplicates = [];
  frameIds.forEach((id, index) => {
    if (!seen.has(id)) {
      seen.set(id, []);
    }
    seen.get(id).push(index);
  });
  for (const [id, indexes] of seen.entries()) {
    if (indexes.length > 1) {
      duplicates.push({ id, count: indexes.length, indexes });
    }
  }
  let missing = [];
  if (frameIds.every((id) => Number.isInteger(id))) {
    const min = Math.min(...frameIds);
    const max = Math.max(...frameIds);
    const present = new Set(frameIds);
    for (let n = min; n <= max; n += 1) {
      if (!present.has(n)) {
        missing.push(n);
      }
    }
  }
  return { ok: duplicates.length === 0 && missing.length === 0, duplicates, missing };
}

// Chunk-boundary discontinuity (§16 C): the MAD across each chunk
// boundary (boundaryIndexes hold the index of the first frame of each
// chunk after the first) divided by the median consecutive MAD. Reported
// as a ratio only — NO threshold, NO pass/fail (none approved). Ratio is
// null when the median consecutive MAD is 0 (identical neighbours).
export function boundaryDiscontinuity(frames, boundaryIndexes) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error('boundaryDiscontinuity requires at least 2 frames');
  }
  if (!Array.isArray(boundaryIndexes)) {
    throw new Error('boundaryIndexes must be an array');
  }
  for (const i of boundaryIndexes) {
    if (!Number.isInteger(i) || i < 1 || i >= frames.length) {
      throw new Error(
        `boundary index ${i} must be an integer in [1, ${frames.length - 1}]`,
      );
    }
  }
  const { median: medianConsecutiveMad } = consecutiveFrameMad(frames);
  const boundaries = boundaryIndexes.map((i) => {
    const mad = meanAbsoluteDifference(frames[i - 1], frames[i]);
    return {
      boundaryIndex: i,
      mad,
      ratio: medianConsecutiveMad === 0 ? null : mad / medianConsecutiveMad,
    };
  });
  return { boundaries, medianConsecutiveMad };
}

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------

function parseFrameRate(rate) {
  if (typeof rate !== 'string') {
    return null;
  }
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  if (den === undefined || den === 0) {
    return num;
  }
  return num / den;
}

async function runFfprobe(filePath, extraArgs) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    ...extraArgs,
    '-of', 'json',
    filePath,
  ]);
  return JSON.parse(stdout);
}

// SHA-256 of a file's bytes, computed with node:crypto (separate from
// ffprobe, which does not hash file contents).
export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

// Probe a video file with ffprobe. Returns
// { frames, width, height, fps, codec, pixFmt, duration, sha256 }.
// frames is null when ffprobe cannot determine a count even with
// -count_frames. Throws on a missing file, ffprobe failure, unparseable
// output, or no video stream.
export async function probeVideo(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('probeVideo requires a non-empty file path');
  }
  let data;
  try {
    data = await runFfprobe(filePath, ['-show_streams', '-show_format']);
  } catch (err) {
    throw new Error(`ffprobe failed for ${filePath}: ${err.message}`);
  }
  const stream = (data.streams ?? []).find((s) => s.codec_type === 'video');
  if (!stream) {
    throw new Error(`no video stream found in ${filePath}`);
  }
  let frames = null;
  if (stream.nb_frames !== undefined && stream.nb_frames !== 'N/A') {
    const parsed = Number.parseInt(stream.nb_frames, 10);
    frames = Number.isInteger(parsed) ? parsed : null;
  }
  if (frames === null) {
    // Fall back to an explicit frame count.
    const counted = await runFfprobe(filePath, [
      '-count_frames', '-show_streams', '-select_streams', 'v:0',
    ]);
    const countedStream = (counted.streams ?? [])[0];
    if (countedStream?.nb_read_frames !== undefined) {
      const parsed = Number.parseInt(countedStream.nb_read_frames, 10);
      frames = Number.isInteger(parsed) ? parsed : null;
    }
  }
  const fps = parseFrameRate(stream.avg_frame_rate) ??
    parseFrameRate(stream.r_frame_rate);
  const duration = data.format?.duration !== undefined
    ? Number.parseFloat(data.format.duration)
    : null;
  return {
    frames,
    width: stream.width ?? null,
    height: stream.height ?? null,
    fps,
    codec: stream.codec_name ?? null,
    pixFmt: stream.pix_fmt ?? null,
    duration: Number.isFinite(duration) ? duration : null,
    sha256: await sha256File(filePath),
  };
}

// Validate a probed video against expected metadata. Never throws for a
// mismatch: returns { ok, checks[], failures[] } where each check is
// { field, expected, actual, passed }. A probe failure (missing file,
// no video stream) is reported as a failure, not thrown.
export async function validateVideoFile(filePath, expected = {}) {
  const checks = [];
  const failures = [];
  let probe;
  try {
    probe = await probeVideo(filePath);
  } catch (err) {
    return { ok: false, checks, failures: [`probe failed: ${err.message}`] };
  }
  const compare = (field, actual, wanted, equal) => {
    const passed = equal(actual, wanted);
    checks.push({ field, expected: wanted, actual, passed });
    if (!passed) {
      failures.push(`${field}: expected ${wanted}, got ${actual}`);
    }
  };
  if (expected.frames !== undefined) {
    if (probe.frames === null) {
      checks.push({ field: 'frames', expected: expected.frames, actual: null, passed: false });
      failures.push('frames: could not be determined by ffprobe');
    } else {
      compare('frames', probe.frames, expected.frames, (a, b) => a === b);
    }
  }
  if (expected.width !== undefined) {
    compare('width', probe.width, expected.width, (a, b) => a === b);
  }
  if (expected.height !== undefined) {
    compare('height', probe.height, expected.height, (a, b) => a === b);
  }
  if (expected.fps !== undefined) {
    compare('fps', probe.fps, expected.fps, (a, b) =>
      typeof a === 'number' && Math.abs(a - b) <= 0.01);
  }
  if (expected.codec !== undefined) {
    compare('codec', probe.codec, expected.codec, (a, b) => a === b);
  }
  if (expected.pixFmt !== undefined) {
    compare('pixFmt', probe.pixFmt, expected.pixFmt, (a, b) => a === b);
  }
  return { ok: failures.length === 0, checks, failures };
}

// ---------------------------------------------------------------------------
// Config hashing
// ---------------------------------------------------------------------------

// Canonical JSON: object keys sorted recursively, arrays keep order.
// Throws on circular structures and on values JSON cannot represent
// (undefined, functions, symbols, bigint).
export function stableStringify(value, seen = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
      typeof value === 'bigint') {
    throw new Error(`stableStringify cannot represent a ${typeof value} value`);
  }
  if (value === null || typeof value !== 'object') {
    const rendered = JSON.stringify(value);
    if (rendered === undefined) {
      throw new Error('stableStringify cannot represent this value');
    }
    return rendered;
  }
  if (seen.has(value)) {
    throw new Error('stableStringify cannot represent a circular structure');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

// Stable SHA-256 of the canonicalised benchmark config, for manifest
// comparison: same config (any key order) -> same hash; any changed
// field -> a different hash.
export function configHash(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('configHash requires a plain config object');
  }
  return createHash('sha256').update(stableStringify(config)).digest('hex');
}
