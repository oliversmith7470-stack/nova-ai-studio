// NOVA AI Studio — Phase 3 API process: MP4 validation (Rev 2 §18).
//
// Every generated file is validated BEFORE storeJobOutput. All rules must
// pass; any failure → job failed, file discarded, reason recorded, temp
// files removed (§16.3).
//   1. File exists, size > 0 and ≤ 50 MB.
//   2. ffprobe: container MP4, codec h264, pix_fmt yuv420p (phone-playback
//      law), resolution 1024x576, fps 24, frame count 121,
//      duration 5.04 s ± 0.1 s.
//   3. Full decode clean: every frame decodes, zero corrupt frames.
//   4. SHA-256 recorded on the job record.
//   5. No audio stream expected (LTX is video-only); an unexpected audio
//      stream is a validation failure, not a feature.
//
// Safety (§18.1): ffprobe/ffmpeg are invoked via execFile with an
// argument array — user-controlled values (job IDs, file paths) are
// passed as arguments, never interpolated into a shell command string.
// There is no shell in the validation path at all. Timeouts: ffprobe
// 30 s, full decode 120 s — a timeout is a validation failure
// (`validation-timeout`), not a retry.
//
// The validator is injectable (config.validateOutput): local tests use a
// stub so they do not need a real encode for every case; the integration
// test uses this real validator against a real ffmpeg-encoded clip.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import {
  MAX_OUTPUT_BYTES,
  VALIDATION_FFPROBE_TIMEOUT_MS,
  VALIDATION_DECODE_TIMEOUT_MS,
} from './constants.js';

const execFileAsync = promisify(execFile);

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function parseFps(rate) {
  if (typeof rate !== 'string') return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return null;
  return num / den;
}

export async function validateMp4(filePath, {
  ffprobePath = 'ffprobe',
  ffmpegPath = 'ffmpeg',
  ffprobeTimeoutMs = VALIDATION_FFPROBE_TIMEOUT_MS,
  decodeTimeoutMs = VALIDATION_DECODE_TIMEOUT_MS,
} = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: 'validation-missing-file' };
  }
  if (!stat.isFile() || stat.size === 0) {
    return { ok: false, error: 'validation-empty-file' };
  }
  if (stat.size > MAX_OUTPUT_BYTES) {
    return { ok: false, error: 'validation-oversize' };
  }

  let probe;
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error',
       '-show_entries',
       'stream=codec_name,codec_type,pix_fmt,width,height,r_frame_rate,nb_frames,duration',
       '-show_entries', 'format=format_name,duration',
       '-of', 'json', filePath],
      { timeout: ffprobeTimeoutMs, maxBuffer: 1024 * 1024 },
    );
    probe = JSON.parse(stdout);
  } catch (err) {
    if (err && err.killed) return { ok: false, error: 'validation-timeout' };
    return { ok: false, error: 'validation-probe-failed' };
  }

  const formatName = (probe.format && probe.format.format_name) || '';
  if (!formatName.split(',').includes('mp4') && !formatName.includes('mov')) {
    return { ok: false, error: 'validation-not-mp4' };
  }
  const streams = probe.streams || [];
  if (streams.some((s) => s.codec_type === 'audio')) {
    return { ok: false, error: 'validation-unexpected-audio' };
  }
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) return { ok: false, error: 'validation-no-video-stream' };
  if (video.codec_name !== 'h264') return { ok: false, error: 'validation-codec' };
  if (video.pix_fmt !== 'yuv420p') return { ok: false, error: 'validation-pix-fmt' };
  if (video.width !== 1024 || video.height !== 576) {
    return { ok: false, error: 'validation-resolution' };
  }
  const fps = parseFps(video.r_frame_rate);
  if (fps === null || Math.abs(fps - 24) > 0.01) {
    return { ok: false, error: 'validation-fps' };
  }
  const frames = Number(video.nb_frames);
  if (!Number.isInteger(frames) || frames !== 121) {
    return { ok: false, error: 'validation-frame-count' };
  }
  const duration = Number(probe.format.duration ?? video.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - 5.04) > 0.1) {
    return { ok: false, error: 'validation-duration' };
  }

  // Full decode: every frame must decode, zero corrupt frames.
  try {
    await execFileAsync(
      ffmpegPath,
      ['-v', 'error', '-i', filePath, '-f', 'null', '-'],
      { timeout: decodeTimeoutMs, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    if (err && err.killed) return { ok: false, error: 'validation-timeout' };
    return { ok: false, error: 'validation-decode-failed' };
  }

  const sha256 = await sha256File(filePath);
  return {
    ok: true,
    sha256,
    sizeBytes: stat.size,
    details: {
      codec: video.codec_name,
      pix_fmt: video.pix_fmt,
      width: video.width,
      height: video.height,
      fps,
      frames,
      duration,
    },
  };
}
