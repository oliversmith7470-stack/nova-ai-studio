// NOVA Personal GPU Cloud — Stage 2: offline staging (VDP-04) + notebook.
//
// The proof model is Wan 2.2 TI2V-5B (Apache 2.0, T2V+I2V, 720P at
// 24 FPS, native frame 1280x704). Everything below is verified against
// the official sources on 24 Nov 2026 — the Hugging Face repo file
// listing (Wan-AI/Wan2.2-TI2V-5B) and the Wan2.2 README — NOT against
// the video plan's estimates, which this module CORRECTS in two places:
//
//   CORRECTION 1 — SIZE. The video plan §3 says "the 5B / 1.3B models
//   (a few GB) fit easily". That does NOT hold for the official TI2V-5B
//   repo: the listed files total ~34.2 GB (diffusion shards ~20 GB
//   FP32-stored + T5 encoder 11.4 GB + VAE 2.82 GB), which EXCEEDS
//   Kaggle's 20 GB /kaggle/working (confirmed by Kaggle's own docs).
//   The official route therefore stages via a Kaggle Dataset mount
//   (/kaggle/input), NOT working storage. The ComfyUI repack (~18.15 GB:
//   FP16 diffusion 10.0 GB + FP8 T5 6.74 GB + VAE 1.41 GB) fits working
//   storage with ~1.85 GB headroom — tight, and the 20 GB figure itself
//   is the only storage figure Kaggle's docs state.
//   CORRECTION 2 — FRAME SIZE. The model's native 720P is 1280x704, not
//   1280x720. The VDP-05 evidence record's "1280x720 target" is a
//   target; the notebook uses the model's native size and the report
//   records the ACTUAL resolution.
//
// Two staging routes are specified. The default is 'official' (the
// vendor-blessed generate.py path — one documented command); 'comfyui'
// is the alternative (smaller files, but needs a ComfyUI install +
// workflow JSON validated in Part B).
//
// The MANDATORY CPU-only preparation test (runPreparationTest) verifies
// a staging directory BEFORE any GPU run: every required file present
// and non-truncated, and (for the offline route) NO run-plan step needs
// the network. It never assumes a storage figure: a storage limit is
// passed in by the caller, or the test reports the total with no limit
// asserted. The test is runnable locally against fixture files (see
// test/staging.test.mjs); the same checks run inside the target
// environment as the notebook's first cell (CHECK_ENV_PY).

import fs from 'node:fs';
import path from 'node:path';
// The LTX checkpoint identity is the Phase 6 Run 10 baseline's single
// source of truth — the manifest below cites it, never a copy.
import { CHECKPOINT_SHA256 } from './phase6/config.js';

export const PROOF_MODEL_ID = 'wan2.2-ti2v-5b';

// The production model (Phase 6, Run 10 baseline, 25 Nov 2026 — Shina's
// "Wow perfect"). The only model the personal executor runs.
export const LTX_MODEL_ID = 'ltx-video-2b';

// File sizes in bytes, as listed on huggingface.co/Wan-AI/Wan2.2-TI2V-5B
// on 24 Nov 2026 (GB figures are the listing's rounded values).
const GB = 1_000_000_000;
const MB = 1_000_000;

export const STAGING_MANIFESTS = Object.freeze({
  'wan2.2-ti2v-5b': Object.freeze({
    official: Object.freeze({
      modelId: 'wan2.2-ti2v-5b',
      route: 'official',
      source: Object.freeze({
        repo: 'Wan-AI/Wan2.2-TI2V-5B',
        codeRepo: 'Wan-Video/Wan2.2',
        licence: 'Apache 2.0',
        download: 'huggingface-cli download Wan-AI/Wan2.2-TI2V-5B --local-dir ./Wan2.2-TI2V-5B',
        notes: 'Official vendor weights + generate.py. Diffusion shards are FP32-stored (~20 GB); generate.py converts dtype at load (--convert_model_dtype).',
      }),
      // VDP-04 categories: weights, config + tokenizer, VAE + text
      // encoder, inference code + packages, workflow deps, LoRAs (none).
      files: Object.freeze([
        { path: 'diffusion_pytorch_model-00001-of-00003.safetensors', role: 'diffusion-model', sizeBytes: 9.83 * GB, required: true },
        { path: 'diffusion_pytorch_model-00002-of-00003.safetensors', role: 'diffusion-model', sizeBytes: 10 * GB, required: true },
        { path: 'diffusion_pytorch_model-00003-of-00003.safetensors', role: 'diffusion-model', sizeBytes: 179 * MB, required: true },
        { path: 'diffusion_pytorch_model.safetensors.index.json', role: 'diffusion-model-index', sizeBytes: 72_900, required: true },
        { path: 'models_t5_umt5-xxl-enc-bf16.pth', role: 'text-encoder', sizeBytes: 11.4 * GB, required: true },
        { path: 'Wan2.2_VAE.pth', role: 'vae', sizeBytes: 2.82 * GB, required: true },
        { path: 'config.json', role: 'config', sizeBytes: 251, required: true },
        { path: 'configuration.json', role: 'config', sizeBytes: 43, required: true },
        // Tokenizer files live under google/ in the repo (T5 tokenizer).
        // Contents not enumerated from the listing page — verified at
        // Part B when the repo is downloaded. Marked required: the run
        // needs the tokenizer; the prep test checks the directory exists
        // and is non-empty rather than a fixed file list.
        { path: 'google/', role: 'tokenizer', sizeBytes: null, required: true, dir: true },
      ]),
      pythonPackages: Object.freeze([
        { name: 'torch', version: '>=2.4.0', purpose: 'inference runtime', source: 'Wan2.2 README (torch >= 2.4.0)' },
        { name: 'wan2.2-requirements', version: 'repo-pinned', purpose: 'all other deps, as pinned by Wan-Video/Wan2.2 requirements.txt', source: 'Wan-Video/Wan2.2 requirements.txt' },
      ]),
      installSpec: Object.freeze({
        kind: 'repo-clone+pip',
        steps: Object.freeze([
          'git clone https://github.com/Wan-Video/Wan2.2.git',
          'pip install -r Wan2.2/requirements.txt  (torch >= 2.4.0)',
          'Download Wan-AI/Wan2.2-TI2V-5B into ./Wan2.2-TI2V-5B (CPU session or dataset upload — NOT in the GPU session)',
        ]),
        offlineInstall: 'Install in a CPU session (or prebuilt dataset) BEFORE the GPU session starts. The GPU run itself installs nothing.',
      }),
      loras: Object.freeze([]), // none required for the proof
      runPlan: Object.freeze([
        { id: 'env-check', description: 'Run check_env.py: torch/CUDA/files/offline flags', needsNetwork: false },
        { id: 'load-staged-model', description: 'generate.py loads weights from --ckpt_dir (local only)', needsNetwork: false },
        { id: 'generate', description: 'generate.py --task ti2v-5B --size 1280*704, 5 s clip', needsNetwork: false },
        { id: 'write-report', description: 'Write report JSON + MP4 to /kaggle/working', needsNetwork: false },
      ]),
      storage: Object.freeze({
        // ~34.2 GB total — EXCEEDS Kaggle's 20 GB /kaggle/working.
        totalBytes: 34_212_073_194,
        fitsWorkingStorage20Gb: false,
        route: 'kaggle-dataset',
        routeNote: 'Stage the weights as a private Kaggle Dataset and mount at /kaggle/input. Do NOT copy into /kaggle/working (20 GB limit). Dataset size limits to be confirmed at Part B.',
      }),
    }),
    comfyui: Object.freeze({
      modelId: 'wan2.2-ti2v-5b',
      route: 'comfyui',
      source: Object.freeze({
        repo: 'Comfy-Org/Wan-2.2',
        codeRepo: 'comfyanonymous/ComfyUI',
        licence: 'Apache 2.0 (model weights; ComfyUI is GPL-3.0 — check before any redistribution)',
        download: 'hf download Comfy-Org/Wan-2.2 split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors split_files/vae/wan2.2_vae.safetensors split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors --local-dir ./wan-dl',
        notes: 'ComfyUI repack: FP16 diffusion + FP8 T5. Smaller than the official repo; needs a ComfyUI install + Wan2.2 workflow JSON.',
      }),
      files: Object.freeze([
        { path: 'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', role: 'diffusion-model', sizeBytes: 10 * GB, required: true },
        { path: 'vae/wan2.2_vae.safetensors', role: 'vae', sizeBytes: 1.41 * GB, required: true },
        { path: 'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', role: 'text-encoder', sizeBytes: 6.74 * GB, required: true },
        { path: 'wan22-ti2v-5b-workflow.json', role: 'workflow', sizeBytes: null, required: true, note: 'ComfyUI Wan2.2 TI2V-5B workflow JSON — supplied at Part B; the prep test checks presence only.' },
      ]),
      pythonPackages: Object.freeze([
        { name: 'torch', version: '>=2.4.0', purpose: 'inference runtime', source: 'ComfyUI requirements' },
        { name: 'comfyui', version: 'repo-pinned', purpose: 'ComfyUI server + nodes', source: 'comfyanonymous/ComfyUI' },
      ]),
      installSpec: Object.freeze({
        kind: 'repo-clone+pip',
        steps: Object.freeze([
          'git clone https://github.com/comfyanonymous/ComfyUI.git',
          'pip install -r ComfyUI/requirements.txt',
          'Place the 3 safetensors files under ComfyUI/models/{diffusion_models,vae,text_encoders}/',
          'Load wan22-ti2v-5b-workflow.json (Part B supplies the validated workflow)',
        ]),
        offlineInstall: 'Install in a CPU session (or prebuilt dataset) BEFORE the GPU session starts. The GPU run itself installs nothing.',
      }),
      loras: Object.freeze([]),
      runPlan: Object.freeze([
        { id: 'env-check', description: 'Run check_env.py: torch/CUDA/files/offline flags', needsNetwork: false },
        { id: 'start-comfyui', description: 'Start the ComfyUI server (local only)', needsNetwork: false },
        { id: 'generate', description: 'Submit the Wan2.2 workflow via the ComfyUI /prompt API; poll for completion', needsNetwork: false },
        { id: 'write-report', description: 'Write report JSON + MP4 to /kaggle/working', needsNetwork: false },
      ]),
      storage: Object.freeze({
        // ~18.15 GB — fits 20 GB working storage with ~1.85 GB headroom.
        // Tight: outputs + workspace share the same ~1.85 GB. The 20 GB
        // figure is Kaggle's documented limit, not a guarantee of free
        // space (the image + workspace consume some of it).
        totalBytes: 18_150_000_000,
        fitsWorkingStorage20Gb: true,
        headroomBytes: 1_850_000_000,
        route: 'working-storage',
        routeNote: 'Fits /kaggle/working only if the 20 GB figure holds and nothing else competes for it. If the first proof shows pressure, move to the dataset route.',
      }),
    }),
  }),
  // LTX-Video 2B distilled (Lightricks) — the PRODUCTION model (Phase 6).
  // Verified against the Run 10 proof (25 Nov 2026, kernel
  // oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01, output
  // run10/ltx-proof-report.json): 121 frames, 1024x576, 24 fps, 8 steps,
  // guidance 1.0, seed 42, peak VRAM 12.64 GiB, 5.04 s h264 yuv420p.
  // Weights ride Kaggle Model mounts under /kaggle/input/models
  // (read-only) — nothing large is downloaded in-session, so the 20 GB
  // /kaggle/working limit is not the constraint; the mounts are.
  'ltx-video-2b': Object.freeze({
    official: Object.freeze({
      modelId: 'ltx-video-2b',
      route: 'official',
      source: Object.freeze({
        repo: 'Lightricks/LTX-Video',
        codeRepo: 'Lightricks/LTX-Video',
        licence: 'LTXV Open Weights License 0.X (15 Apr 2025)',
        download: 'Kaggle Model marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors (mount, no download in-session); T5-XXL FP16 + tokenizer via the sanderland/flux.1-schnell model mount',
        notes: 'Run 10 baseline (phase6/run10-baseline.json + packages/ltx-proof-20261124-01/ltx-proof.ipynb). Checkpoint sha256 is phase6/config.js CHECKPOINT_SHA256 — the single source of truth.',
      }),
      // VDP-04 categories: diffusion weights, text encoder + tokenizer,
      // keyframes (first/last), inference code + packages, LoRAs (none).
      // The checkpoint + T5 encoder are single files/dirs on the mounts;
      // the prep test checks the checkpoint size and the dirs' presence.
      files: Object.freeze([
        { path: 'ltxv-2b-0.9.8-distilled.safetensors', role: 'diffusion-model', sizeBytes: 6_340_744_492, sha256: CHECKPOINT_SHA256, required: true },
        // T5-XXL FP16 encoder (9,524,669,251 bytes, 4 files) + tokenizer
        // (special_tokens_map.json, spiece.model, tokenizer.json,
        // tokenizer_config.json) from the FLUX model mount — enumerated
        // by the notebook's asset inventory (find_one globs), not a
        // fixed file list here; the prep test checks each dir exists
        // and is non-empty.
        { path: 'text_encoder_2/', role: 'text-encoder', sizeBytes: null, required: true, dir: true },
        { path: 'tokenizer_2/', role: 'tokenizer', sizeBytes: null, required: true, dir: true },
        { path: 'first_frame.png', role: 'keyframe-first', sizeBytes: null, required: true },
        { path: 'last_frame.png', role: 'keyframe-last', sizeBytes: null, required: true },
      ]),
      pythonPackages: Object.freeze([
        { name: 'diffusers', version: '==0.40.0', purpose: 'LTXConditionPipeline', source: 'Run 10 pinned set (packages/ltx-proof-20261124-01/ltx-proof.ipynb cell 2)' },
        { name: 'transformers', version: '==5.16.1', purpose: 'T5-XXL encoder/tokenizer', source: 'Run 10 pinned set' },
        { name: 'accelerate', version: 'latest', purpose: 'model loading / device placement', source: 'Run 10 pinned set' },
        { name: 'sentencepiece', version: 'latest', purpose: 'T5 tokenizer', source: 'Run 10 pinned set' },
        { name: 'protobuf', version: 'latest', purpose: 'T5 tokenizer', source: 'Run 10 pinned set' },
        { name: 'imageio-ffmpeg', version: 'latest', purpose: 'yuv420p MP4 export', source: 'Run 10 pinned set' },
        // torch is NOT pinned — the Kaggle image ships torch 2.11.0+cu130
        // (Run 10 used it). Pinning torch would fight the image.
      ]),
      installSpec: Object.freeze({
        kind: 'pip',
        steps: Object.freeze([
          'pip install diffusers==0.40.0 transformers==5.16.1 accelerate sentencepiece protobuf imageio-ffmpeg  (one invocation, Kaggle image torch 2.11.0+cu130)',
        ]),
        offlineInstall: 'Weights ride Kaggle Model mounts under /kaggle/input/models (read-only) — no weight is downloaded in-session. The single pip install of pinned packages needs the kernel\'s internet flag (Run 10 used enable_internet: true); the generation itself uses only mounted weights.',
      }),
      loras: Object.freeze([]), // none required for the proof
      runPlan: Object.freeze([
        { id: 'env-check', description: 'Check torch/CUDA, GPU name + free VRAM, imageio-ffmpeg binary', needsNetwork: false },
        { id: 'asset-inventory', description: 'Locate checkpoint + T5 encoder/tokenizer + keyframes under /kaggle/input; verify checkpoint size (6,340,744,492 bytes) and sha256; verify keyframes are 1024x576', needsNetwork: false },
        { id: 'load-pipeline', description: 'LTXConditionPipeline.from_single_file (FP16) with the passed-in T5 encoder + tokenizer, config Lightricks/LTX-Video-0.9.5; assert the pipeline components ARE the passed-in ones', needsNetwork: false },
        { id: 'generate', description: 'Generate 121 frames, 1024x576, 24 fps, 8 steps, guidance 1.0, seed 42, first/last keyframe conditions (strength 1.0), decode_timestep 0.0, image_cond_noise_scale 0.15, max_sequence_length 128', needsNetwork: false },
        { id: 'write-report', description: 'Write report JSON + yuv420p MP4 to /kaggle/working', needsNetwork: false },
      ]),
      storage: Object.freeze({
        // Checkpoint 6,340,744,492 + T5 encoder 9,524,669,251 = 15.9 GB
        // of mounted weights. The tokenizer (~4 MB) and keyframes
        // (~MB) are not counted — negligible at this scale. Mounts are
        // read-only under /kaggle/input/models; nothing large is
        // downloaded into /kaggle/working.
        totalBytes: 15_865_413_743,
        fitsWorkingStorage20Gb: false,
        route: 'kaggle-model',
        routeNote: 'Stage the weights as Kaggle Model mounts (marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors + sanderland/flux.1-schnell) and the keyframes as a Kaggle Dataset mount. Do NOT copy into /kaggle/working.',
      }),
    }),
  }),
});

export function getStagingManifest(modelId, route = 'official') {
  const byModel = STAGING_MANIFESTS[modelId];
  if (!byModel) throw new Error(`no staging manifest for model "${modelId}"`);
  const manifest = byModel[route];
  if (!manifest) {
    throw new Error(
      `no staging manifest for model "${modelId}" route "${route}" ` +
      `(known routes: ${Object.keys(byModel).join(', ')})`,
    );
  }
  return manifest;
}

// Total staged bytes for a manifest (files with a known size).
export function manifestTotalBytes(manifest) {
  return manifest.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
}

// -- The mandatory CPU-only preparation test (VDP-04) ----------------------
//
// Verifies a staging directory BEFORE any GPU run:
//   1. every required file exists and is non-empty (a file smaller than
//      sizeTolerance x its listed size counts as truncated — a failed
//      download, not a pass);
//   2. (offline mode) NO run-plan step needs the network;
//   3. storage accounting: the total is computed; if the caller passes a
//      storageLimitBytes, fits/headroom are reported — if not, no limit
//      is asserted (the test never assumes a storage figure).
// Returns { pass, modelId, route, checks, missing, truncated,
// networkSteps, totalBytes, storage } — never throws for a failed check
// (only for a bad call, e.g. a missing rootDir).
export function runPreparationTest(manifest, {
  rootDir,
  storageLimitBytes = null,
  offline = true,
  sizeTolerance = 0.5,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new Error('runPreparationTest requires rootDir (the staging directory)');
  }
  const checks = [];
  const missing = [];
  const truncated = [];
  const networkSteps = [];

  for (const file of manifest.files) {
    if (!file.required) continue;
    const full = path.join(rootDir, file.path);
    let ok = false;
    let detail = '';
    try {
      const stat = fs.statSync(full);
      if (file.dir) {
        const entries = fs.readdirSync(full);
        ok = stat.isDirectory() && entries.length > 0;
        detail = ok ? `directory with ${entries.length} entries` : 'directory empty or not a directory';
      } else if (!stat.isFile()) {
        detail = 'not a regular file';
      } else if (stat.size === 0) {
        detail = 'file is empty (0 bytes)';
      } else if (file.sizeBytes && stat.size < file.sizeBytes * sizeTolerance) {
        truncated.push({ path: file.path, expected: file.sizeBytes, actual: stat.size });
        detail = `truncated: ${stat.size} bytes, expected ~${file.sizeBytes}`;
      } else {
        ok = true;
        detail = file.sizeBytes
          ? `${stat.size} bytes (listed ~${file.sizeBytes})`
          : `${stat.size} bytes`;
      }
    } catch {
      missing.push(file.path);
      detail = 'missing';
    }
    checks.push({ id: `file:${file.path}`, ok, detail });
  }

  if (offline) {
    for (const step of manifest.runPlan) {
      if (step.needsNetwork) {
        networkSteps.push(step.id);
        checks.push({
          id: `network:${step.id}`,
          ok: false,
          detail: `run-plan step "${step.id}" needs the network (offline mode)`,
        });
      }
    }
  }

  const totalBytes = manifestTotalBytes(manifest);
  let storage = null;
  if (storageLimitBytes !== null && storageLimitBytes !== undefined) {
    storage = {
      limitBytes: storageLimitBytes,
      totalBytes,
      fits: totalBytes <= storageLimitBytes,
      headroomBytes: storageLimitBytes - totalBytes,
    };
    checks.push({
      id: 'storage:fits-limit',
      ok: storage.fits,
      detail: storage.fits
        ? `${totalBytes} bytes staged, ${storage.headroomBytes} bytes headroom under a ${storageLimitBytes}-byte limit`
        : `${totalBytes} bytes staged EXCEEDS the ${storageLimitBytes}-byte limit by ${-storage.headroomBytes} bytes`,
    });
  }

  const pass = checks.every((c) => c.ok);
  return {
    pass,
    modelId: manifest.modelId,
    route: manifest.route,
    checks,
    missing,
    truncated,
    networkSteps,
    totalBytes,
    storage,
  };
}

// -- check_env.py ----------------------------------------------------------
//
// The environment check that runs as the notebook's FIRST cell (and can
// also run standalone in a CPU session before the GPU session starts).
// It verifies torch/CUDA, the GPU name + VRAM, every staged file, and
// that the offline flags are set. It exits non-zero on any failure — the
// notebook must not proceed past a failed env check.
// NOTE: this template is Python, delivered as a string. It is validated
// by `python3 -m py_compile` in Stage 2 verification (see the report),
// and against the real environment in Part B.
export const CHECK_ENV_PY = `#!/usr/bin/env python3
"""NOVA GPU Cloud — Stage 2 environment check (VDP-04).

Run FIRST, before any generation. Verifies the staged files, torch/CUDA
and the GPU, and that the offline flags are set. Exits non-zero on any
failure — do not proceed past a failed check.

Usage: python3 check_env.py --manifest staging-manifest.json --root <staging-dir>
"""
import argparse
import json
import os
import sys


def fail(msg):
    print(f"CHECK FAILED: {msg}", flush=True)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="staging-manifest.json path")
    ap.add_argument("--root", required=True, help="staging root directory")
    args = ap.parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)

    # 1. Offline flags must be set (the GPU run downloads nothing).
    for var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        if os.environ.get(var) != "1":
            fail(f"{var} is not '1' — set it before running (offline run)")
    print("offline flags: HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1", flush=True)

    # 2. torch + CUDA + GPU identity (VDP-03 evidence starts here).
    try:
        import torch
    except ImportError:
        fail("torch is not installed")
    print(f"torch {torch.__version__}", flush=True)
    if not torch.cuda.is_available():
        fail("torch.cuda.is_available() is False — no GPU visible")
    props = torch.cuda.get_device_properties(0)
    print(f"GPU: {props.name} | VRAM: {props.total_memory / 1e9:.1f} GB | "
          f"count: {torch.cuda.device_count()}", flush=True)

    # 3. Every required staged file exists and is non-empty.
    missing = []
    for entry in manifest["files"]:
        if not entry.get("required"):
            continue
        full = os.path.join(args.root, entry["path"])
        if entry.get("dir"):
            if not (os.path.isdir(full) and os.listdir(full)):
                missing.append(entry["path"] + " (empty/missing dir)")
            continue
        if not os.path.isfile(full) or os.path.getsize(full) == 0:
            missing.append(entry["path"])
    if missing:
        fail("missing/empty staged files: " + ", ".join(missing))
    print(f"staged files: all {len(manifest['files'])} manifest entries present",
          flush=True)

    print("ENV CHECK PASSED", flush=True)


if __name__ == "__main__":
    main()
`;

// -- Notebook generation ---------------------------------------------------
//
// buildNotebook produces a nbformat-4 notebook object for one job. The
// notebook is SELF-CONTAINED: it inlines the env check and the generation
// call and imports nothing from sibling files — because `kaggle kernels
// push` sends only the code_file text (sibling files are NOT uploaded),
// so a notebook that imports a local helper would fail on push.
//
// TEMPLATE STATUS: the notebook structure is complete and the official
// generate.py command is the vendor-documented one, but the notebook has
// NOT run against a real environment yet. Part B validates it (and the
// ComfyUI workflow JSON, which Part B supplies). The notebook says so in
// its first cell — it never pretends to be proven.
//
// Papermill gotcha (documented in the notebook): Kaggle runs committed
// notebooks via papermill, which kills a kernel that produces no output
// for ~4 seconds. Every long-running cell therefore prints progress with
// flush=True at least every few seconds.
export function buildNotebook({ job, manifest, provider, offline = true }) {
  const ckptDir = provider === 'kaggle-t4'
    ? '/kaggle/input/wan22-ti2v-5b/Wan2.2-TI2V-5B'
    : './Wan2.2-TI2V-5B';
  const workingDir = provider === 'kaggle-t4' ? '/kaggle/working' : './output';
  const cells = [];

  cells.push(mdCell(
    `# NOVA GPU Cloud — Stage 2 proof job\n\n` +
    `**Job:** ${job.id} | **Model:** ${job.modelId} (${manifest.route} route) | **Provider:** ${provider}\n\n` +
    `**Prompt:** ${job.prompt}\n\n` +
    `> TEMPLATE — generated by the NOVA GPU Manager (Stage 2). The structure is complete and the ` +
    `generate.py command is the vendor-documented one, but this notebook has NOT run against a real ` +
    `environment yet. Part B validates it. Do not treat a successful run of this template as ` +
    `production approval.\n\n` +
    `> VDP-06: this job uses a synthetic prompt and a non-sensitive test image only. No private user ` +
    `media, credentials, or real customer content may be added to this notebook.\n\n` +
    `> Papermill: Kaggle runs committed notebooks via papermill, which kills a kernel that produces ` +
    `no output for ~4 seconds. Every long cell below prints progress with flush=True.`,
  ));

  if (!offline) {
    // Colab route: sessions have internet, so weights download in-session.
    // (The offline Kaggle route never has this cell.)
    cells.push(mdCell(
      `## 0. Download the weights (Colab only — sessions have internet)\n\n` +
      `This cell needs the network. It runs BEFORE the env check. The Kaggle route has no such cell.`,
    ));
    cells.push(codeCell(
      `import subprocess, sys\n` +
      `print("downloading model weights (Colab in-session download)...", flush=True)\n` +
      `subprocess.run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub"], check=True)\n` +
      `from huggingface_hub import snapshot_download\n` +
      `snapshot_download(repo_id="${manifest.source.repo}", local_dir="${ckptDir}")\n` +
      `print("weights downloaded.", flush=True)`,
    ));
  }

  cells.push(mdCell(
    `## 1. Environment check (VDP-04 — mandatory, runs first)\n\n` +
    `Verifies torch/CUDA, the GPU name + VRAM, every staged file, and the offline flags. ` +
    `If this cell fails, STOP — do not run the generation cell.`,
  ));
  cells.push(codeCell(
    `import json, os, sys\n` +
    `os.environ["HF_HUB_OFFLINE"] = "1"\n` +
    `os.environ["TRANSFORMERS_OFFLINE"] = "1"\n` +
    `import torch\n` +
    `print(f"torch {torch.__version__}", flush=True)\n` +
    `assert torch.cuda.is_available(), "no GPU visible"\n` +
    `props = torch.cuda.get_device_properties(0)\n` +
    `print(f"GPU: {props.name} | VRAM: {props.total_memory / 1e9:.1f} GB | count: {torch.cuda.device_count()}", flush=True)\n` +
    `MANIFEST = json.loads(${JSON.stringify(JSON.stringify(manifest))})\n` +
    `ROOT = ${JSON.stringify(ckptDir)}\n` +
    `missing = [f["path"] for f in MANIFEST["files"] if f.get("required") and not os.path.exists(os.path.join(ROOT, f["path"]))]\n` +
    `assert not missing, f"missing staged files: {missing}"\n` +
    `print("ENV CHECK PASSED", flush=True)`,
  ));

  cells.push(mdCell(
    `## 2. Generate (5 s clip, native 1280x704)\n\n` +
    `Official generate.py, vendor-documented flags. A background thread polls nvidia-smi every 5 s ` +
    `and records peak VRAM (VDP-03 evidence — sampling, not allocator-exact). Progress prints keep ` +
    `papermill alive.`,
  ));
  if (manifest.route === 'official') {
    cells.push(codeCell(
      `import json, subprocess, threading, time\n` +
      `WORKING = ${JSON.stringify(workingDir)}\n` +
      `os.makedirs(WORKING, exist_ok=True)\n` +
      `peak_vram_mb = {"mb": 0}\n` +
      `stop_poll = threading.Event()\n` +
      `def poll_vram():\n` +
      `    import subprocess as sp\n` +
      `    while not stop_poll.is_set():\n` +
      `        try:\n` +
      `            out = sp.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)\n` +
      `            used = max(int(x) for x in out.strip().splitlines())\n` +
      `            peak_vram_mb["mb"] = max(peak_vram_mb["mb"], used)\n` +
      `        except Exception:\n` +
      `            pass\n` +
      `        stop_poll.wait(5)\n` +
      `threading.Thread(target=poll_vram, daemon=True).start()\n` +
      `t0 = time.time()\n` +
      `cmd = ["python", "Wan2.2/generate.py", "--task", "ti2v-5B", "--size", "1280*704",\n` +
      `       "--ckpt_dir", ${JSON.stringify(ckptDir)}, "--offload_model", "True",\n` +
      `       "--convert_model_dtype", "--t5_cpu", "--prompt", ${JSON.stringify(job.prompt)},\n` +
      `       "--save_dir", WORKING]\n` +
      `print("running: " + " ".join(cmd), flush=True)\n` +
      `proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)\n` +
      `for line in proc.stdout:\n` +
      `    print(line, end="", flush=True)  # keep papermill alive\n` +
      `proc.wait()\n` +
      `stop_poll.set()\n` +
      `runtime_s = time.time() - t0\n` +
      `print(f"generate.py exit={proc.returncode} runtime={runtime_s:.1f}s peak_vram~{peak_vram_mb['mb']}MB", flush=True)\n` +
      `assert proc.returncode == 0, f"generate.py failed (exit {proc.returncode})"`,
    ));
  } else {
    cells.push(codeCell(
      `# ComfyUI route — Part B validates this cell against the real environment.\n` +
      `# The workflow JSON (wan22-ti2v-5b-workflow.json) is supplied at Part B.\n` +
      `# Structure: start the ComfyUI server, POST the workflow to /prompt, poll /history.\n` +
      `raise SystemExit("ComfyUI route: workflow JSON + server call are validated in Part B — do not run yet")`,
    ));
  }

  cells.push(mdCell(
    `## 3. Write the completion report\n\n` +
    `The report is the ONLY thing the manager reads back (plus the MP4, which the human downloads ` +
    `separately — no media ever passes through the manager, O-27). Record the actual resolution ` +
    `(native 1280x704), the runtime, the sampled peak VRAM, and whether the run completed without ` +
    `out-of-memory errors.`,
  ));
  cells.push(codeCell(
    `import glob, os\n` +
    `mp4s = sorted(glob.glob(os.path.join(WORKING, "**/*.mp4"), recursive=True))\n` +
    `assert mp4s, "no MP4 output found"\n` +
    `mp4 = mp4s[-1]\n` +
    `report = {\n` +
    `    "jobId": ${JSON.stringify(job.id)},\n` +
    `    "providerId": ${JSON.stringify(provider)},\n` +
    `    "status": "succeeded",\n` +
    `    "secondsUsed": round(runtime_s),\n` +
    `    "costUsd": 0,\n` +
    `    "completedAt": int(time.time() * 1000),\n` +
    `    "resultRef": f"manual-download:{os.path.basename(mp4)}",\n` +
    `    "error": None,\n` +
    `    "evidence": {\n` +
    `        "model": ${JSON.stringify(manifest.modelId)},\n` +
    `        "route": ${JSON.stringify(manifest.route)},\n` +
    `        "resolution": "1280x704 (native 720P for this model)",\n` +
    `        "peakVramMbSampled": peak_vram_mb["mb"],\n` +
    `        "oom": False,\n` +
    `        "outputFile": os.path.basename(mp4),\n` +
    `        "outputBytes": os.path.getsize(mp4),\n` +
    `    },\n` +
    `}\n` +
    `with open(os.path.join(WORKING, ${JSON.stringify(job.id + '.report.json')}), "w") as f:\n` +
    `    json.dump(report, f, indent=2)\n` +
    `print("REPORT WRITTEN: " + os.path.join(WORKING, ${JSON.stringify(job.id + '.report.json')}), flush=True)\n` +
    `print("Download the MP4 + the report JSON, then file the report with the manager.", flush=True)`,
  ));

  // nbformat 4.5 cell ids (Part B smoke run, 24 Nov 2026: Kaggle's
  // validator warns "Cell is missing an id field" without them — a
  // warning today, a hard error in future nbformat versions).
  cells.forEach((c, i) => { c.id = `cell-${i}`; });

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10.0' },
      nova: {
        generator: 'nova-gpu-cloud/staging.js buildNotebook',
        template: true,
        validated: false,
        jobId: job.id,
        modelId: job.modelId,
        provider,
        route: manifest.route,
      },
    },
    cells,
  };
}

// -- Smoke notebook (Part B, B-K6/B-K8) --------------------------------------
//
// buildSmokeNotebook produces a TRIVIAL GPU smoke kernel: it prints
// nvidia-smi output, python/torch/CUDA availability, disk space, and an
// internet test (two small fetches), then writes smoke.report.json to
// /kaggle/working. It generates NOTHING — the Wan proof run is a
// separate job that waits on the smoke results and the owner's
// go-ahead. It reuses the same nbformat-4 structure and mdCell/codeCell
// helpers as buildNotebook, and the KaggleExecutor writes the package
// (notebook + kernel metadata + README) through the same submit() path —
// the smoke run exercises the real Stage 2 packaging path, not a
// hand-rolled one.
//
// The smoke kernel runs with internet ON (enable_internet: true in the
// kernel metadata) — the point is to answer B-K8 empirically: can a GPU
// session download in-session? The proof run keeps internet OFF.
export const SMOKE_MANIFEST = Object.freeze({
  modelId: 'smoke',
  route: 'smoke',
  source: Object.freeze({
    repo: null,
    codeRepo: null,
    licence: null,
    notes: 'Trivial GPU smoke kernel (Part B B-K6/B-K8). No model, no weights, no generation.',
  }),
  files: Object.freeze([]),
  pythonPackages: Object.freeze([]),
  runPlan: Object.freeze([
    { id: 'env-info', description: 'Print python/platform/nvidia-smi/disk', needsNetwork: false },
    { id: 'torch-check', description: 'Import torch, report CUDA + GPU name/VRAM', needsNetwork: false },
    { id: 'internet-test', description: 'Fetch two small URLs (huggingface.co API + example.com)', needsNetwork: true },
    { id: 'write-report', description: 'Write smoke.report.json to /kaggle/working', needsNetwork: false },
  ]),
  storage: Object.freeze({
    totalBytes: 0,
    fitsWorkingStorage20Gb: true,
    route: 'working-storage',
    routeNote: 'Smoke kernel stages nothing.',
  }),
});

export function buildSmokeNotebook({ job, provider }) {
  const cells = [];

  cells.push(mdCell(
    `# NOVA GPU Cloud — GPU smoke kernel (Part B, B-K6/B-K8)\n\n` +
    `**Job:** ${job.id} | **Provider:** ${provider}\n\n` +
    `Trivial smoke test: GPU identity (nvidia-smi + torch), python/torch availability, disk space, ` +
    `and an internet test (two small fetches). This kernel generates NOTHING — it proves the live ` +
    `connection and answers whether a GPU session can download in-session (B-K8) before the Wan ` +
    `proof run is attempted.\n\n` +
    `> Papermill: Kaggle runs committed notebooks via papermill, which kills a kernel that produces ` +
    `no output for ~4 seconds. Every cell below prints progress with flush=True.`,
  ));

  cells.push(mdCell(`## 1. Environment: python, nvidia-smi, disk`));
  cells.push(codeCell(
    `import json, os, platform, subprocess, sys, time\n` +
    `print(f"python {sys.version}", flush=True)\n` +
    `print(f"platform {platform.platform()}", flush=True)\n` +
    `print(f"working dir {os.getcwd()}", flush=True)\n` +
    `print("--- nvidia-smi ---", flush=True)\n` +
    `try:\n` +
    `    out = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=30)\n` +
    `    print(out.stdout, flush=True)\n` +
    `    if out.stderr:\n` +
    `        print("nvidia-smi stderr: " + out.stderr, flush=True)\n` +
    `except Exception as e:\n` +
    `    print(f"nvidia-smi FAILED: {type(e).__name__}: {e}", flush=True)\n` +
    `print("--- nvidia-smi query ---", flush=True)\n` +
    `try:\n` +
    `    out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv"], capture_output=True, text=True, timeout=30)\n` +
    `    print(out.stdout, flush=True)\n` +
    `except Exception as e:\n` +
    `    print(f"nvidia-smi query FAILED: {type(e).__name__}: {e}", flush=True)\n` +
    `print("--- disk ---", flush=True)\n` +
    `try:\n` +
    `    out = subprocess.run(["df", "-h", "/kaggle/working", "/kaggle/input", "/tmp"], capture_output=True, text=True, timeout=30)\n` +
    `    print(out.stdout, flush=True)\n` +
    `except Exception as e:\n` +
    `    print(f"df FAILED: {type(e).__name__}: {e}", flush=True)`,
  ));

  cells.push(mdCell(`## 2. torch / CUDA availability`));
  cells.push(codeCell(
    `print("--- torch / CUDA ---", flush=True)\n` +
    `torch_info = {"imported": False}\n` +
    `try:\n` +
    `    import torch\n` +
    `    torch_info["imported"] = True\n` +
    `    torch_info["torch_version"] = torch.__version__\n` +
    `    torch_info["cuda_version"] = torch.version.cuda\n` +
    `    torch_info["cuda_available"] = torch.cuda.is_available()\n` +
    `    torch_info["device_count"] = torch.cuda.device_count() if torch.cuda.is_available() else 0\n` +
    `    print(f"torch {torch.__version__} | cuda {torch.version.cuda} | cuda_available={torch.cuda.is_available()} | devices={torch_info['device_count']}", flush=True)\n` +
    `    if torch.cuda.is_available():\n` +
    `        torch_info["devices"] = []\n` +
    `        for i in range(torch.cuda.device_count()):\n` +
    `            props = torch.cuda.get_device_properties(i)\n` +
    `            torch_info["devices"].append({"index": i, "name": props.name, "vram_gb": round(props.total_memory / 1e9, 1)})\n` +
    `            print(f"device {i}: {props.name} | VRAM {props.total_memory / 1e9:.1f} GB", flush=True)\n` +
    `except Exception as e:\n` +
    `    torch_info["error"] = f"{type(e).__name__}: {e}"\n` +
    `    print(f"torch check FAILED: {type(e).__name__}: {e}", flush=True)`,
  ));

  cells.push(mdCell(`## 3. Internet test (B-K8 — two small fetches)`));
  cells.push(codeCell(
    `print("--- internet test ---", flush=True)\n` +
    `import urllib.request\n` +
    `def fetch(url, timeout=15):\n` +
    `    t0 = time.time()\n` +
    `    try:\n` +
    `        req = urllib.request.Request(url, headers={"User-Agent": "NOVA-GPU-Cloud-Smoke/1.0"})\n` +
    `        with urllib.request.urlopen(req, timeout=timeout) as resp:\n` +
    `            body = resp.read()\n` +
    `            return {"url": url, "ok": True, "status": resp.status, "bytes": len(body), "seconds": round(time.time() - t0, 2)}\n` +
    `    except Exception as e:\n` +
    `        return {"url": url, "ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 2)}\n` +
    `internet = [\n` +
    `    fetch("https://huggingface.co/api/models/Wan-AI/Wan2.2-TI2V-5B"),\n` +
    `    fetch("https://example.com"),\n` +
    `]\n` +
    `for r in internet:\n` +
    `    print(json.dumps(r), flush=True)`,
  ));

  cells.push(mdCell(`## 4. Write the smoke report`));
  cells.push(codeCell(
    `print("--- writing report ---", flush=True)\n` +
    `report = {\n` +
    `    "jobId": ${JSON.stringify(job.id)},\n` +
    `    "providerId": ${JSON.stringify(provider)},\n` +
    `    "status": "succeeded",\n` +
    `    "completedAt": int(time.time() * 1000),\n` +
    `    "smoke": {\n` +
    `        "python": sys.version.split()[0],\n` +
    `        "platform": platform.platform(),\n` +
    `        "torch": globals().get("torch_info", {"imported": False, "error": "torch cell did not run"}),\n` +
    `        "internet": globals().get("internet", []),\n` +
    `    },\n` +
    `}\n` +
    `os.makedirs("/kaggle/working", exist_ok=True)\n` +
    `with open("/kaggle/working/smoke.report.json", "w") as f:\n` +
    `    json.dump(report, f, indent=2)\n` +
    `print("REPORT WRITTEN: /kaggle/working/smoke.report.json", flush=True)\n` +
    `print("SMOKE COMPLETE", flush=True)`,
  ));

  // nbformat 4.5 cell ids (see buildNotebook — Kaggle's validator warns
  // without them).
  cells.forEach((c, i) => { c.id = `cell-${i}`; });

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10.0' },
      nova: {
        generator: 'nova-gpu-cloud/staging.js buildSmokeNotebook',
        template: false,
        validated: false,
        jobId: job.id,
        modelId: 'smoke',
        provider,
        route: 'smoke',
      },
    },
    cells,
  };
}

function mdCell(source) {
  return { cell_type: 'markdown', metadata: {}, source: source.split('\n').map((l) => l + '\n') };
}

function codeCell(source) {
  return {
    cell_type: 'code',
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.split('\n').map((l) => l + '\n'),
  };
}
