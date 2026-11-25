// MP4 validation (Rev 2 §18) against real ffmpeg-encoded clips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { validateMp4 } from '../validation.js';

const execFileAsync = promisify(execFile);

async function encode(dir, name, args) {
  const out = path.join(dir, name);
  await execFileAsync('ffmpeg', ['-y', ...args, out], { timeout: 60000 });
  return out;
}

test('valid 121-frame 1024x576 24fps yuv420p clip passes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = await encode(dir, 'good.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=duration=5.04:size=1024x576:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-frames:v', '121', '-an',
  ]);
  const res = await validateMp4(clip);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.details.frames, 121);
  assert.equal(res.details.width, 1024);
  assert.equal(res.details.height, 576);
  assert.equal(res.details.pix_fmt, 'yuv420p');
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
});

test('wrong resolution fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = await encode(dir, 'small.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=duration=5.04:size=640x360:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-frames:v', '121', '-an',
  ]);
  const res = await validateMp4(clip);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'validation-resolution');
});

test('unexpected audio stream fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = await encode(dir, 'audio.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=duration=5.04:size=1024x576:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5.04',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-frames:v', '121',
    '-c:a', 'aac',
  ]);
  const res = await validateMp4(clip);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'validation-unexpected-audio');
});

test('wrong frame count fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = await encode(dir, 'short.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=duration=2.5:size=1024x576:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-frames:v', '60', '-an',
  ]);
  const res = await validateMp4(clip);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'validation-frame-count');
});

test('missing file and non-video file fail without a shell', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missing = await validateMp4(path.join(dir, 'nope.mp4'));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'validation-missing-file');
  const junk = path.join(dir, 'junk.mp4');
  await writeFile(junk, 'this is not a video file');
  const res = await validateMp4(junk);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'validation-probe-failed');
});
