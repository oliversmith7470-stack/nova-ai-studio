// The real personal LTX executor (Rev 4.8 §7, reviewer correction):
// the Run 10 notebook builder + the Kaggle executor with the Run 10
// mounts. No live Kaggle execution, no credential, no spend — the
// executor builds the package locally and the transport stays null
// (human channel) until the proof run is separately authorised.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';

import { getStagingManifest, runPreparationTest, manifestTotalBytes } from '../src/staging.js';
import { buildLtxNotebook, LtxKaggleExecutor, LTX_CHECKPOINT, LTX_T5_MODEL_SOURCE, LTX_KEYFRAMES_DATASET, LTX_PARAMETERS } from '../src/engines/ltx-executor.js';
import { CHECKPOINT_SHA256, BASELINE_CONFIG } from '../src/phase6/config.js';
import { requiredVramGb } from '../src/phase6/resource-profiles.js';

function notebookText(nb) {
  return nb.cells.map((c) => c.source.join('')).join('\n');
}

function makeJob(overrides = {}) {
  return {
    id: 'nova-job-test-ltx',
    modelId: 'ltx-video-2b',
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    audience: 'personal',
    params: { audience: 'personal' },
    ...overrides,
  };
}

test('LTX staging manifest exists and matches the Run 10 baseline', () => {
  const manifest = getStagingManifest('ltx-video-2b');
  assert.equal(manifest.modelId, 'ltx-video-2b');
  assert.equal(manifest.route, 'official');
  const ckpt = manifest.files.find((f) => f.role === 'diffusion-model');
  assert.equal(ckpt.path, LTX_CHECKPOINT.fileName);
  assert.equal(ckpt.sizeBytes, 6_340_744_492);
  assert.equal(ckpt.sha256, CHECKPOINT_SHA256);
  // The T5 encoder + tokenizer ride the FLUX model mount as dirs.
  assert.ok(manifest.files.some((f) => f.path === 'text_encoder_2/' && f.dir));
  assert.ok(manifest.files.some((f) => f.path === 'tokenizer_2/' && f.dir));
  assert.ok(manifest.files.some((f) => f.path === 'first_frame.png'));
  assert.ok(manifest.files.some((f) => f.path === 'last_frame.png'));
  // Pinned deps are the Run 10 set, torch NOT pinned (Kaggle image).
  const pkgs = Object.fromEntries(manifest.pythonPackages.map((p) => [p.name, p.version]));
  assert.equal(pkgs.diffusers, '==0.40.0');
  assert.equal(pkgs.transformers, '==5.16.1');
  assert.ok(!('torch' in pkgs));
  // ~15.9 GB of mounted weights — fits no working disk, rides mounts.
  assert.equal(manifest.storage.totalBytes, 15_865_413_743);
  assert.equal(manifest.storage.route, 'kaggle-model');
  assert.equal(manifestTotalBytes(manifest), 6_340_744_492);
});

test('LTX manifest preparation test: missing and truncated assets fail; a full staging dir passes', async (t) => {
  const manifest = getStagingManifest('ltx-video-2b');
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-ltx-staging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Empty dir: everything required is missing.
  let res = runPreparationTest(manifest, { rootDir: dir });
  assert.equal(res.pass, false);
  assert.ok(res.missing.includes('ltxv-2b-0.9.8-distilled.safetensors'));

  // A truncated checkpoint (a small fake file) counts as truncated,
  // not present — the prep test catches a failed download.
  await mkdir(path.join(dir, 'text_encoder_2'), { recursive: true });
  await mkdir(path.join(dir, 'tokenizer_2'), { recursive: true });
  await writeFile(path.join(dir, 'text_encoder_2', 'config.json'), '{}');
  await writeFile(path.join(dir, 'tokenizer_2', 'tokenizer_config.json'), '{}');
  await writeFile(path.join(dir, 'first_frame.png'), Buffer.alloc(100));
  await writeFile(path.join(dir, 'last_frame.png'), Buffer.alloc(100));
  await writeFile(path.join(dir, 'ltxv-2b-0.9.8-distilled.safetensors'), Buffer.alloc(1024));
  res = runPreparationTest(manifest, { rootDir: dir });
  assert.equal(res.pass, false);
  assert.equal(res.truncated.length, 1);
  assert.equal(res.truncated[0].path, 'ltxv-2b-0.9.8-distilled.safetensors');

  // A sparse file of the right size (no disk used) + the dirs + the
  // keyframes: the prep test passes. (A real pass needs the real
  // weights — Part B.)
  fs.truncateSync(path.join(dir, 'ltxv-2b-0.9.8-distilled.safetensors'), 6_340_744_492);
  res = runPreparationTest(manifest, { rootDir: dir });
  assert.equal(res.pass, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.truncated, []);
});

test('buildLtxNotebook carries the frozen Run 10 parameters and the job prompt', () => {
  const manifest = getStagingManifest('ltx-video-2b');
  const job = makeJob();
  const nb = buildLtxNotebook({ job, manifest, provider: 'kaggle-t4' });
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.cells.length, 9);
  const text = notebookText(nb);
  // Frozen Run 10 parameters.
  assert.ok(text.includes('LTXConditionPipeline.from_single_file'));
  assert.ok(text.includes('num_frames=121'));
  assert.ok(text.includes('height=576, width=1024'));
  assert.ok(text.includes('num_inference_steps=8'));
  assert.ok(text.includes('guidance_scale=1.0'));
  assert.ok(text.includes('manual_seed(42)'));
  assert.ok(text.includes('decode_timestep=0.0'));
  assert.ok(text.includes('image_cond_noise_scale=0.15'));
  assert.ok(text.includes('max_sequence_length=128'));
  assert.ok(text.includes('config="Lightricks/LTX-Video-0.9.5"'));
  // The checkpoint identity is asserted in the notebook.
  assert.ok(text.includes('6340744492'));
  assert.ok(text.includes(CHECKPOINT_SHA256));
  // The job's prompt — not the Run 10 hardcoded prompt.
  assert.ok(text.includes(job.prompt));
  assert.ok(!text.includes('ember-cracked wings'));
  // The job id drives the report + output filenames.
  assert.ok(text.includes(job.id + '.report.json'));
  assert.ok(text.includes(job.id + '.mp4'));
  // yuv420p export (phone-playback law) + the integrity asserts.
  assert.ok(text.includes('pixelformat="yuv420p"'));
  assert.ok(text.includes('"yuv420p" in info'));
  assert.ok(text.includes('n_decoded == 121'));
  // Pinned install, one invocation.
  assert.ok(text.includes('diffusers==0.40.0'));
  assert.ok(text.includes('transformers==5.16.1'));
  // The T5-encode-on-GPU-then-CPU placement is intentional, not a fallback.
  assert.ok(text.includes('T5 -> CPU (intentional, post-encode)'));
  // The builder output says it has not run yet (no false proof claim).
  assert.ok(text.includes('has NOT run against a real environment yet'));
  // No keyframe hash asserts (per-job keyframes differ from Run 10).
  assert.ok(!text.includes('KEYFRAME HASH MISMATCH'));
  assert.ok(text.includes('first_img.size == (1024, 576)'));
  // Parameters match the frozen baseline config.
  assert.equal(LTX_PARAMETERS.frames, BASELINE_CONFIG.frames);
  assert.equal(LTX_PARAMETERS.steps, BASELINE_CONFIG.steps);
});

test('buildLtxNotebook requires a job id, a prompt, and the LTX manifest', () => {
  const manifest = getStagingManifest('ltx-video-2b');
  assert.throws(() => buildLtxNotebook({ job: { prompt: 'x' }, manifest, provider: 'kaggle-t4' }), /job\.id/);
  assert.throws(() => buildLtxNotebook({ job: { id: 'j', prompt: '' }, manifest, provider: 'kaggle-t4' }), /prompt/);
  assert.throws(() => buildLtxNotebook({ job: makeJob(), manifest: getStagingManifest('wan2.2-ti2v-5b'), provider: 'kaggle-t4' }), /ltx-video-2b/);
});

test('LtxKaggleExecutor submit builds the Run 10 package (no transport, no push)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-ltx-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executor = new LtxKaggleExecutor({ packageDir: path.join(dir, 'packages') });
  assert.equal(executor.audience, 'personal');
  const manifest = getStagingManifest('ltx-video-2b');
  const job = makeJob({ id: 'nova-job-ltx-pkg' });
  const out = await executor.submit(job, manifest);
  assert.equal(out.channel, 'kaggle-cli-human');
  assert.equal(out.kernelId, null);
  const pkgDir = path.join(dir, 'packages', 'nova-job-ltx-pkg');
  const notebook = JSON.parse(await readFile(path.join(pkgDir, 'notebook.ipynb'), 'utf8'));
  assert.equal(notebook.nbformat, 4);
  assert.ok(notebookText(notebook).includes('LTXConditionPipeline.from_single_file'));
  const meta = JSON.parse(await readFile(path.join(pkgDir, 'kernel-metadata.json'), 'utf8'));
  assert.equal(meta.id, '<kaggle-username>/nova-gpu-cloud-nova-job-ltx-pkg');
  assert.equal(meta.enable_gpu, true);
  // Run 10 mounts: checkpoint + T5 via Kaggle Models, keyframes via dataset.
  assert.deepEqual(meta.model_sources, [LTX_CHECKPOINT.modelSource, LTX_T5_MODEL_SOURCE]);
  assert.deepEqual(meta.dataset_sources, [LTX_KEYFRAMES_DATASET]);
  assert.equal(meta.enable_internet, true);
  assert.equal(meta.machine_shape, 'NvidiaTeslaT4');
  const readme = await readFile(path.join(pkgDir, 'README.md'), 'utf8');
  assert.ok(readme.includes(LTX_CHECKPOINT.modelSource));
  assert.ok(!readme.includes('34 GB official weights'));
  const staged = JSON.parse(await readFile(path.join(pkgDir, 'staging-manifest.json'), 'utf8'));
  assert.equal(staged.modelId, 'ltx-video-2b');
});

test('LtxKaggleExecutor refuses a public job at submit (transport boundary)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-ltx-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executor = new LtxKaggleExecutor({ packageDir: path.join(dir, 'packages') });
  const manifest = getStagingManifest('ltx-video-2b');
  const job = makeJob({ params: { audience: 'public' } });
  await assert.rejects(() => executor.submit(job, manifest), /audience-mismatch/);
});

test('LtxKaggleExecutor refuses missing and unknown audiences at submit (transport boundary)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-ltx-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executor = new LtxKaggleExecutor({ packageDir: path.join(dir, 'packages') });
  const manifest = getStagingManifest('ltx-video-2b');
  // Missing audience: no audience field at all.
  const missing = makeJob({ params: {} });
  await assert.rejects(
    () => executor.submit(missing, manifest),
    /audience-mismatch: Kaggle transport requires personal audience/,
  );
  // Unknown audience value.
  const unknown = makeJob({ params: { audience: 'owner' } });
  await assert.rejects(
    () => executor.submit(unknown, manifest),
    /audience-mismatch: Kaggle transport requires personal audience/,
  );
});

test('LTX admission: the 121-frame profile needs 15.64 GB (16 GB admits, 15 GB refuses)', async () => {
  const { admitJob } = await import('../src/phase6/resource-profiles.js');
  const key = {
    model: 'ltx-video-2b',
    resolution: '1024x576',
    frames: 121,
    steps: 8,
    decoderMode: 'single-pass',
    attentionBackend: 'default',
  };
  assert.equal(requiredVramGb(key), 15.64);
  assert.equal(admitJob(key, 16).admitted, true);
  assert.equal(admitJob(key, 15).admitted, false);
  assert.equal(admitJob(key, 15).reason, 'insufficient-vram');
  // An unmeasured config refuses fail-closed, never guesses.
  assert.equal(admitJob({ ...key, frames: 60 }, 16).reason, 'no-measured-profile');
});
