// NOVA Personal GPU Cloud — Stage 2: offline staging (VDP-04) tests.
//
// The preparation test is the MANDATORY CPU-only gate: every required
// file present and non-truncated, no network step in the run plan, and
// storage accounting that never assumes a figure. Fixture files stand in
// for the real weights (a 1-byte file with sizeTolerance 0 checks
// presence; a small synthetic manifest checks the truncation logic).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STAGING_MANIFESTS,
  getStagingManifest,
  manifestTotalBytes,
  runPreparationTest,
  buildNotebook,
  CHECK_ENV_PY,
} from '../src/staging.js';
import { tempDir } from './stage2-support.mjs';

const OFFICIAL = STAGING_MANIFESTS['wan2.2-ti2v-5b'].official;
const COMFYUI = STAGING_MANIFESTS['wan2.2-ti2v-5b'].comfyui;

// Create every file in a manifest as a 1-byte fixture (dirs get one file).
function stageFixtures(t, manifest) {
  const dir = tempDir(t);
  for (const file of manifest.files) {
    const full = path.join(dir, file.path);
    if (file.dir) {
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, 'tokenizer.json'), 'x');
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x');
    }
  }
  return dir;
}

test('the official manifest totals ~34.2 GB and does NOT fit 20 GB working storage', () => {
  const total = manifestTotalBytes(OFFICIAL);
  assert.ok(total > 34_000_000_000 && total < 34_500_000_000, `total ${total}`);
  assert.equal(OFFICIAL.storage.fitsWorkingStorage20Gb, false);
  assert.equal(OFFICIAL.storage.route, 'kaggle-dataset');
});

test('the ComfyUI repack totals ~18.15 GB and fits 20 GB with ~1.85 GB headroom', () => {
  const total = manifestTotalBytes(COMFYUI);
  assert.ok(total > 18_000_000_000 && total < 18_300_000_000, `total ${total}`);
  assert.equal(COMFYUI.storage.fitsWorkingStorage20Gb, true);
  assert.equal(COMFYUI.storage.headroomBytes, 1_850_000_000);
});

test('both manifests cover every VDP-04 category', () => {
  for (const m of [OFFICIAL, COMFYUI]) {
    const roles = new Set(m.files.map((f) => f.role));
    assert.ok(roles.has('diffusion-model'), 'weights');
    assert.ok(roles.has('text-encoder'), 'text encoder');
    assert.ok(roles.has('vae'), 'VAE');
    assert.ok(m.pythonPackages.length > 0, 'packages');
    assert.ok(m.installSpec.offlineInstall, 'offline install spec');
    assert.ok(m.runPlan.length > 0, 'run plan');
  }
  assert.ok(new Set(OFFICIAL.files.map((f) => f.role)).has('tokenizer'));
  assert.ok(new Set(OFFICIAL.files.map((f) => f.role)).has('config'));
});

test('getStagingManifest rejects unknown models and routes', () => {
  assert.throws(() => getStagingManifest('no-such-model'), /no staging manifest/);
  assert.throws(() => getStagingManifest('wan2.2-ti2v-5b', 'no-such-route'), /no staging manifest/);
  assert.equal(getStagingManifest('wan2.2-ti2v-5b').route, 'official');
});

test('the prep test passes on a fully staged official directory', (t) => {
  const dir = stageFixtures(t, OFFICIAL);
  const result = runPreparationTest(OFFICIAL, { rootDir: dir, sizeTolerance: 0 });
  assert.equal(result.pass, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.truncated, []);
  assert.deepEqual(result.networkSteps, []);
});

test('the prep test fails on a missing file and names it', (t) => {
  const dir = stageFixtures(t, OFFICIAL);
  fs.rmSync(path.join(dir, 'Wan2.2_VAE.pth'));
  const result = runPreparationTest(OFFICIAL, { rootDir: dir, sizeTolerance: 0 });
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, ['Wan2.2_VAE.pth']);
});

test('the prep test fails on an empty file', (t) => {
  const dir = stageFixtures(t, OFFICIAL);
  fs.writeFileSync(path.join(dir, 'config.json'), '');
  const result = runPreparationTest(OFFICIAL, { rootDir: dir, sizeTolerance: 0 });
  assert.equal(result.pass, false);
  assert.ok(result.checks.some((c) => c.id === 'file:config.json' && !c.ok));
});

test('the prep test fails on a truncated file (below the size tolerance)', (t) => {
  const manifest = {
    modelId: 'test-model',
    route: 'test',
    files: [
      { path: 'weights.bin', role: 'diffusion-model', sizeBytes: 1000, required: true },
    ],
    runPlan: [],
  };
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'weights.bin'), Buffer.alloc(400)); // 40% of 1000
  const result = runPreparationTest(manifest, { rootDir: dir });
  assert.equal(result.pass, false);
  assert.equal(result.truncated.length, 1);
  assert.equal(result.truncated[0].path, 'weights.bin');
});

test('the prep test fails when a run-plan step needs the network in offline mode', (t) => {
  const manifest = {
    modelId: 'test-model',
    route: 'test',
    files: [],
    runPlan: [{ id: 'download-weights', description: 'download', needsNetwork: true }],
  };
  const offline = runPreparationTest(manifest, { rootDir: tempDir(t), offline: true });
  assert.equal(offline.pass, false);
  assert.deepEqual(offline.networkSteps, ['download-weights']);
  const online = runPreparationTest(manifest, { rootDir: tempDir(t), offline: false });
  assert.equal(online.pass, true);
});

test('the prep test reports storage fit only when a limit is given', (t) => {
  const dir = stageFixtures(t, OFFICIAL);
  const noLimit = runPreparationTest(OFFICIAL, { rootDir: dir, sizeTolerance: 0 });
  assert.equal(noLimit.storage, null);
  assert.equal(noLimit.totalBytes, manifestTotalBytes(OFFICIAL));
  const over = runPreparationTest(OFFICIAL, {
    rootDir: dir,
    sizeTolerance: 0,
    storageLimitBytes: 20_000_000_000,
  });
  assert.equal(over.pass, false);
  assert.equal(over.storage.fits, false);
  const under = runPreparationTest(COMFYUI, {
    rootDir: stageFixtures(t, COMFYUI),
    sizeTolerance: 0,
    storageLimitBytes: 20_000_000_000,
  });
  assert.equal(under.pass, true);
  assert.equal(under.storage.fits, true);
  assert.equal(under.storage.headroomBytes, 1_850_000_000);
});

test('the Kaggle notebook is self-contained nbformat-4 with the documented generate call', () => {
  const job = { id: 'job-nb-1', modelId: 'wan2.2-ti2v-5b', prompt: 'a synthetic test dragon' };
  const nb = buildNotebook({ job, manifest: OFFICIAL, provider: 'kaggle-t4', offline: true });
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.metadata.nova.template, true);
  assert.equal(nb.metadata.nova.validated, false);
  const sources = nb.cells.map((c) => c.source.join(''));
  const joined = sources.join('\n');
  assert.ok(joined.includes('ENV CHECK PASSED'), 'env check cell');
  assert.ok(joined.includes('generate.py'), 'generate cell');
  assert.ok(joined.includes('--task') && joined.includes('ti2v-5B'), 'task flag');
  assert.ok(joined.includes('1280*704'), 'native 1280x704 size');
  assert.ok(joined.includes('--ckpt_dir'), 'ckpt dir flag');
  assert.ok(joined.includes('--offload_model'), 'offload flag');
  assert.ok(joined.includes('--convert_model_dtype'), 'dtype conversion flag');
  assert.ok(joined.includes('--t5_cpu'), 't5-cpu flag');
  assert.ok(joined.includes('a synthetic test dragon'), 'the job prompt is inlined');
  assert.ok(joined.includes('job-nb-1.report.json'), 'report cell');
  assert.ok(joined.includes('nvidia-smi'), 'VRAM polling');
  assert.ok(!joined.includes('snapshot_download'), 'no download cell on the offline route');
  assert.ok(joined.includes('/kaggle/input/wan22-ti2v-5b'), 'dataset mount path');
  assert.ok(joined.includes('/kaggle/working'), 'working dir');
  // Valid JSON (a notebook file must round-trip through JSON).
  JSON.parse(JSON.stringify(nb));
});

test('the Colab notebook adds an in-session download cell', () => {
  const job = { id: 'job-nb-2', modelId: 'wan2.2-ti2v-5b', prompt: 'a synthetic test dragon' };
  const nb = buildNotebook({ job, manifest: OFFICIAL, provider: 'colab-t4', offline: false });
  const joined = nb.cells.map((c) => c.source.join('')).join('\n');
  assert.ok(joined.includes('snapshot_download'), 'download cell present');
  assert.ok(joined.includes('Wan-AI/Wan2.2-TI2V-5B'), 'repo id in the download cell');
});

test('every Python cell in both notebooks + check_env.py compiles', (t) => {
  const dir = tempDir(t);
  const job = { id: 'job-nb-3', modelId: 'wan2.2-ti2v-5b', prompt: 'a synthetic test dragon' };
  const notebooks = [
    buildNotebook({ job, manifest: OFFICIAL, provider: 'kaggle-t4', offline: true }),
    buildNotebook({ job, manifest: OFFICIAL, provider: 'colab-t4', offline: false }),
  ];
  let cellCount = 0;
  for (const [i, nb] of notebooks.entries()) {
    for (const [j, cell] of nb.cells.entries()) {
      if (cell.cell_type !== 'code') continue;
      cellCount += 1;
      const file = path.join(dir, `nb${i}-cell${j}.py`);
      fs.writeFileSync(file, cell.source.join(''));
      // py_compile checks syntax only (names resolve at runtime in the
      // notebook) — a syntax error here would fail the real run.
      execFileSync('python3', ['-m', 'py_compile', file], { stdio: 'pipe' });
    }
  }
  assert.ok(cellCount >= 6, `expected >= 6 code cells, got ${cellCount}`);
  const envFile = path.join(dir, 'check_env.py');
  fs.writeFileSync(envFile, CHECK_ENV_PY);
  execFileSync('python3', ['-m', 'py_compile', envFile], { stdio: 'pipe' });
});
