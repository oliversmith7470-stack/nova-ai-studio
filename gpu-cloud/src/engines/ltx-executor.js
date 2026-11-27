// NOVA Personal GPU Cloud — the real personal LTX executor (Rev 4.8 §7,
// Phase 6 Run 10 baseline).
//
// This is the executor the personal (owner-only) path runs. It is NOT the
// generic KaggleExecutor's Wan default: it builds the Run 10 notebook —
// the 121-frame, 1024x576, 24 fps, 8-step, guidance-1.0, seed-42 notebook
// that produced the 5.04 s clip Shina called "Wow perfect" (25 Nov 2026,
// kernel oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01) — parameterised
// by the job (the prompt and the job id come from the job; the generation
// parameters are the frozen Run 10 baseline and are NOT job-tunable).
//
// The notebook is a faithful transcription of the Run 10 proof notebook
// (gpu-cloud/packages/ltx-proof-20261124-01/ltx-proof.ipynb), with exactly
// three changes:
//   1. the prompt comes from the job, not the Run 10 hardcoded prompt;
//   2. output filenames use the job id (<jobId>.mp4, <jobId>.report.json)
//      — the executor's fileReport channel expects <jobId>.report.json;
//   3. the keyframe sha256 asserts are removed: per-job keyframes differ
//      from the Run 10 proof pair, so a hash assert would fail every real
//      job. The 1024x576 size assert stays (a wrong-size keyframe is a
//      real failure, not a proof-pair difference).
// Everything else — gates, the single pip install, the asset inventory,
// the T5 encode-on-GPU-then-CPU, the from_single_file pipeline build with
// the passed-in T5/tokenizer, the dtype audits, the yuv420p export — is
// the Run 10 notebook verbatim. It has NOT run against a real environment
// from THIS builder yet: the live proof run needs separate authorisation
// (Part B). The notebook says so in its first cell — it never pretends
// the builder output itself is proven.
//
// Weights ride Kaggle Model mounts under /kaggle/input/models (read-only):
// the LTX checkpoint (marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors)
// and the T5-XXL FP16 encoder + tokenizer (sanderland/flux.1-schnell).
// Keyframes ride the owner's keyframes dataset mount. Nothing large is
// downloaded in-session. The single pip install of pinned packages DOES
// need the kernel's internet flag — the kernel metadata sets
// enable_internet: true for that reason (Run 10 ran with internet on);
// the generation itself uses only mounted weights.
//
// Audience: personal only (inherited from KaggleExecutor). The executor
// refuses a public job at _start (audience mismatch) and at submit()
// (transport boundary). The Kaggle transport is null by default — the
// human channel — until the owner supplies a credential AND the proof
// run is separately authorised.

import { KaggleExecutor, KAGGLE_PROVIDER_ID } from '../kaggle-executor.js';
import { BASELINE_CONFIG, CHECKPOINT_SHA256 } from '../phase6/config.js';
import { LTX_MODEL_ID } from '../staging.js';

export { LTX_MODEL_ID };

// Run 10 baseline — the frozen generation parameters (phase6/config.js
// BASELINE_CONFIG is the single source of truth; these are restated here
// only so the notebook builder can reference them by name).
export const LTX_PARAMETERS = Object.freeze({
  frames: BASELINE_CONFIG.frames, // 121
  width: 1024,
  height: 576,
  fps: 24,
  steps: BASELINE_CONFIG.steps, // 8
  guidanceScale: 1.0,
  seed: 42,
  decodeTimestep: 0.0,
  imageCondNoiseScale: 0.15,
  maxSequenceLength: 128,
  config: 'Lightricks/LTX-Video-0.9.5',
});

// The Run 10 mounts (kernel-metadata.json, verified against the Run 10
// kernel metadata file).
export const LTX_CHECKPOINT = Object.freeze({
  fileName: 'ltxv-2b-0.9.8-distilled.safetensors',
  sizeBytes: 6_340_744_492,
  sha256: CHECKPOINT_SHA256,
  // Kaggle Model source, framework/variation/version form.
  modelSource: 'marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors/pytorch/default/1',
});
export const LTX_T5_MODEL_SOURCE =
  'sanderland/flux.1-schnell/pytorch/hf/1';
// The Run 10 keyframes dataset (the owner's dataset). Per-job keyframes
// ride a job-specific dataset in the future; the proof pair is the
// default mount until then.
export const LTX_KEYFRAMES_DATASET =
  'oliversmithh/nova-ltx-proof-keyframes-20261124';

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

// Build the production LTX notebook for one job. `offline` means "weights
// are mounted, no in-session weight download" — always true for LTX; it
// does NOT mean the kernel has no internet (the single pip install needs
// it — see the module header and the kernel metadata's enable_internet).
export function buildLtxNotebook({ job, manifest, provider, offline = true } = {}) {
  if (!job || typeof job.id !== 'string' || job.id.length === 0) {
    throw new Error('buildLtxNotebook requires job.id');
  }
  if (typeof job.prompt !== 'string' || job.prompt.length === 0) {
    throw new Error('buildLtxNotebook requires job.prompt');
  }
  if (!manifest || manifest.modelId !== LTX_MODEL_ID) {
    throw new Error(`buildLtxNotebook requires the ${LTX_MODEL_ID} manifest`);
  }
  const promptJson = JSON.stringify(job.prompt);
  const jobIdJson = JSON.stringify(job.id);
  const cells = [];

  cells.push(mdCell(
    `# NOVA GPU Cloud — LTX-Video 2B distilled (0.9.8) production job\n\n` +
    `**Job:** ${job.id} | **Model:** ${job.modelId} (${manifest.route} route) | **Provider:** ${provider}\n\n` +
    `**Prompt:** ${job.prompt}\n\n` +
    `> PRODUCTION notebook — a faithful transcription of the Run 10 proof notebook ` +
    `(gpu-cloud/packages/ltx-proof-20261124-01/ltx-proof.ipynb, 25 Nov 2026, kernel ` +
    `oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01), parameterised by the job: the prompt and the job id come from the job; the generation ` +
    `parameters are the frozen Run 10 baseline (121 frames, 1024x576, 24 fps, 8 steps, guidance 1.0, seed 42). ` +
    `The keyframe sha256 asserts are removed (per-job keyframes differ from the Run 10 proof pair); the 1024x576 size assert stays. ` +
    `This builder output has NOT run against a real environment yet — the live proof run needs separate authorisation (Part B).\n\n` +
    `- **Model:** LTX-Video 2B distilled 0.9.8 (\`ltxv-2b-0.9.8-distilled.safetensors\`, 6.34 GB) via Kaggle Model mount.\n` +
    `- **Implementation:** diffusers 0.40.0 \`LTXConditionPipeline.from_single_file\`, \`torch_dtype=torch.float16\` — the FP16 adaptation. The official yaml is BF16 + two-pass multi-scale + upscaler + prompt enhancement and does NOT run on a T4; it is NOT used here.\n` +
    `- **Text encoder:** T5-XXL FP16 from the FLUX layout mount; encoded on GPU, then moved to CPU before sampling (intentional).\n` +
    `- **Hardware:** ONE Tesla T4 (cuda:0), ONE process. **Frames:** 121 (8n+1 temporal convention). **Resolution:** 1024x576. **Steps:** 8. **Guidance:** 1.0 (no CFG). **Seed:** 42.\n\n` +
    `Papermill gotcha: Kaggle runs committed notebooks via papermill, which kills a kernel that produces no output for ~4 seconds. Every long-running cell prints progress with flush=True at least every few seconds.`,
  ));

  // Cell 1 — environment gates (Run 10 cell 1, job id substituted).
  cells.push(codeCell(
    `import os, sys, json, time, gc, glob, hashlib, subprocess, shutil\n` +
    `os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")\n` +
    `os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")\n` +
    `os.environ.setdefault("PYTHONUNBUFFERED", "1")\n` +
    `\n` +
    `T0 = time.time()\n` +
    `REPORT = {"job": ${jobIdJson},\n` +
    `          "model": "LTX-Video 2B distilled 0.9.8",\n` +
    `          "implementation": "diffusers 0.40.0 LTXConditionPipeline.from_single_file, torch_dtype=float16",\n` +
    `          "fp16_adaptation": "native yaml is BF16 two-pass multi-scale + upscaler + prompt enhancement (does not run on T4); production uses diffusers single-pass flow matching, 8 steps, no upscaler, no prompt enhancement"}\n` +
    `OUT = "/kaggle/working/output"\n` +
    `os.makedirs(OUT, exist_ok=True)\n` +
    `\n` +
    `def log(*a, **k):\n` +
    `    print(*a, flush=True)\n` +
    `\n` +
    `# ---------- Gate A: GPU ----------\n` +
    `import torch\n` +
    `log("torch:", torch.__version__, "| cuda:", torch.version.cuda)\n` +
    `if not torch.cuda.is_available():\n` +
    `    raise SystemExit("GATE A FAILED: cuda unavailable")\n` +
    `n_gpu = torch.cuda.device_count()\n` +
    `log("GPUs provisioned:", n_gpu)\n` +
    `gpu_info = []\n` +
    `for i in range(n_gpu):\n` +
    `    p = torch.cuda.get_device_properties(i)\n` +
    `    log("  cuda:%d %s cc=%d.%d total=%.2f GiB" % (i, p.name, p.major, p.minor, p.total_memory / 2**30))\n` +
    `    gpu_info.append({"index": i, "name": p.name, "cc": "%d.%d" % (p.major, p.minor),\n` +
    `                     "total_gib": round(p.total_memory / 2**30, 2)})\n` +
    `if not gpu_info[0]["name"].startswith("Tesla T4"):\n` +
    `    raise SystemExit("GATE A FAILED: cuda:0 is not a Tesla T4: " + gpu_info[0]["name"])\n` +
    `log("bf16 supported (cuda):", torch.cuda.is_bf16_supported())\n` +
    `log("GATE A: PASS (production uses cuda:0 only; any second GPU stays idle)")\n` +
    `REPORT["gpu"] = gpu_info\n` +
    `REPORT["bf16_supported"] = torch.cuda.is_bf16_supported()\n` +
    `REPORT["torch_version"] = torch.__version__\n` +
    `REPORT["cuda_version"] = torch.version.cuda\n` +
    `REPORT["gate_a"] = "PASS"\n` +
    `\n` +
    `# ---------- Gate B: internet ----------\n` +
    `# The kernel needs internet for the single pip install of pinned\n` +
    `# packages (cell 2) and for the config-JSON fetch in cell 5. The\n` +
    `# generation itself uses only mounted weights.\n` +
    `import urllib.request\n` +
    `try:\n` +
    `    r = urllib.request.urlopen("https://huggingface.co", timeout=15)\n` +
    `    log("Gate B: huggingface.co ->", r.status)\n` +
    `    assert r.status == 200\n` +
    `except Exception as e:\n` +
    `    raise SystemExit("GATE B FAILED: %s" % e)\n` +
    `REPORT["gate_b"] = "PASS"\n` +
    `\n` +
    `# ---------- Gate C: storage ----------\n` +
    `disk_before = {}\n` +
    `for path in ["/kaggle/working", "/kaggle/input"]:\n` +
    `    total, used, free = shutil.disk_usage(path)\n` +
    `    log("disk %s: total=%.1fG used=%.1fG free=%.1fG" % (path, total / 2**30, used / 2**30, free / 2**30))\n` +
    `    disk_before[path] = {"total_gib": round(total / 2**30, 2), "used_gib": round(used / 2**30, 2),\n` +
    `                         "free_gib": round(free / 2**30, 2)}\n` +
    `REPORT["disk_before"] = disk_before\n` +
    `REPORT["gate_c"] = "PASS"\n` +
    `\n` +
    `# ---------- host RAM / CPU ----------\n` +
    `with open("/proc/meminfo") as f:\n` +
    `    mem = {}\n` +
    `    for line in f:\n` +
    `        if ":" in line:\n` +
    `            k, v = line.split(":", 1)\n` +
    `            mem[k.strip()] = int(v.split()[0])\n` +
    `log("host RAM total=%.1f GiB avail=%.1f GiB | CPUs=%d" % (\n` +
    `    mem["MemTotal"] / 2**20, mem["MemAvailable"] / 2**20, os.cpu_count()))\n` +
    `REPORT["host_ram_total_gib"] = round(mem["MemTotal"] / 2**20, 1)\n` +
    `REPORT["host_ram_avail_gib"] = round(mem["MemAvailable"] / 2**20, 1)\n` +
    `REPORT["cpu_count"] = os.cpu_count()\n` +
    `\n` +
    `def rss_gib():\n` +
    `    with open("/proc/self/status") as f:\n` +
    `        for line in f:\n` +
    `            if line.startswith("VmRSS:"):\n` +
    `                return round(int(line.split()[1]) / 2**20, 2)\n` +
    `    return None\n` +
    `REPORT["rss_gib_start"] = rss_gib()\n` +
    `log("process RSS at start: %.2f GiB" % rss_gib())\n` +
    `\n` +
    `# ---------- pre-install package versions (metadata only, no imports) ----------\n` +
    `from importlib.metadata import version as pkg_version, PackageNotFoundError\n` +
    `def pv(name):\n` +
    `    try:\n` +
    `        return pkg_version(name)\n` +
    `    except PackageNotFoundError:\n` +
    `        return "NOT INSTALLED"\n` +
    `pre = {}\n` +
    `for p in ["diffusers", "transformers", "accelerate", "sentencepiece", "protobuf",\n` +
    `          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors"]:\n` +
    `    pre[p] = pv(p)\n` +
    `    log("pre-install %s: %s" % (p, pre[p]))\n` +
    `REPORT["packages_pre_install"] = pre\n` +
    `log("ALL GATES PASS")`,
  ));

  // Cell 2 — pinned dependency install (Run 10 cell 2, verbatim).
  cells.push(codeCell(
    `# Pinned dependency set (TRACK-C's proven Kaggle set, verified on PyPI 24 Nov 2026).\n` +
    `# ONE pip invocation (Wan v2 lesson: interacting packages pinned together).\n` +
    `# Torch is NOT pinned: the Kaggle image torch (2.11.0+cu130) matches TRACK-C.\n` +
    `t_install = time.time()\n` +
    `log("installing pinned deps (one invocation)...")\n` +
    `res = subprocess.run(\n` +
    `    [sys.executable, "-m", "pip", "install", "-q",\n` +
    `     "diffusers==0.40.0", "transformers==5.16.1", "accelerate",\n` +
    `     "sentencepiece", "protobuf", "imageio-ffmpeg"],\n` +
    `    capture_output=True, text=True)\n` +
    `log("pip returncode:", res.returncode)\n` +
    `if res.stdout.strip():\n` +
    `    log("pip stdout (last 5 lines):")\n` +
    `    for ln in res.stdout.strip().splitlines()[-5:]:\n` +
    `        log("  ", ln)\n` +
    `if res.returncode != 0:\n` +
    `    log("pip stderr:")\n` +
    `    log(res.stderr)\n` +
    `    raise SystemExit("DEPENDENCY INSTALL FAILED")\n` +
    `REPORT["pip_install_s"] = round(time.time() - t_install, 1)\n` +
    `log("pip install took %.1f s" % REPORT["pip_install_s"])\n` +
    `\n` +
    `import diffusers, transformers\n` +
    `log("diffusers:", diffusers.__version__, "| transformers:", transformers.__version__)\n` +
    `assert diffusers.__version__ == "0.40.0", "diffusers version mismatch"\n` +
    `assert transformers.__version__ == "5.16.1", "transformers version mismatch"\n` +
    `post = {}\n` +
    `for p in ["diffusers", "transformers", "accelerate", "sentencepiece", "protobuf",\n` +
    `          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors"]:\n` +
    `    post[p] = pv(p)\n` +
    `    log("post-install %s: %s" % (p, post[p]))\n` +
    `REPORT["packages_post_install"] = post\n` +
    `import imageio_ffmpeg\n` +
    `log("ffmpeg exe:", imageio_ffmpeg.get_ffmpeg_exe())\n` +
    `REPORT["rss_gib_after_install"] = rss_gib()`,
  ));

  // Cell 3 — asset inventory (Run 10 cell 3; keyframe sha asserts removed
  // — per-job keyframes differ from the Run 10 proof pair).
  cells.push(codeCell(
    `# Asset inventory: every weight comes from a read-only Kaggle mount.\n` +
    `# NOTHING large is downloaded into /kaggle/working (the full pipeline is\n` +
    `# 25.39 GB by download and does not fit the 20 GB working disk).\n` +
    `log("input mount roots:", sorted(os.listdir("/kaggle/input")))\n` +
    `\n` +
    `def find_one(pattern, what):\n` +
    `    hits = sorted(p for p in glob.glob(pattern, recursive=True) if os.path.isfile(p))\n` +
    `    if not hits:\n` +
    `        raise SystemExit("ASSET NOT FOUND: %s (pattern %s)" % (what, pattern))\n` +
    `    log("%s: %s" % (what, hits[0]))\n` +
    `    if len(hits) > 1:\n` +
    `        log("  (plus %d more matches)" % (len(hits) - 1))\n` +
    `    return hits[0]\n` +
    `\n` +
    `def sha256_file(path, label):\n` +
    `    h = hashlib.sha256()\n` +
    `    done = 0\n` +
    `    total = os.path.getsize(path)\n` +
    `    with open(path, "rb") as f:\n` +
    `        while True:\n` +
    `            chunk = f.read(64 * 1024 * 1024)\n` +
    `            if not chunk:\n` +
    `                break\n` +
    `            h.update(chunk)\n` +
    `            done += len(chunk)\n` +
    `            log("  %s sha256 %.2f / %.2f GiB" % (label, done / 2**30, total / 2**30), flush=True)\n` +
    `    return h.hexdigest()\n` +
    `\n` +
    `# --- LTX checkpoint ---\n` +
    `t = time.time()\n` +
    `LTX_PATH = find_one("/kaggle/input/**/ltxv-2b-0.9.8-distilled.safetensors", "LTX checkpoint")\n` +
    `ltx_size = os.path.getsize(LTX_PATH)\n` +
    `log("LTX size: %d bytes (expected %d)" % (ltx_size, 6340744492))\n` +
    `assert ltx_size == 6340744492, "LTX SIZE MISMATCH"\n` +
    `LTX_SHA = sha256_file(LTX_PATH, "LTX")\n` +
    `log("LTX sha256:", LTX_SHA)\n` +
    `assert LTX_SHA == ${JSON.stringify(CHECKPOINT_SHA256)}, "LTX SHA256 MISMATCH"\n` +
    `REPORT["ltx_checkpoint"] = {"path": LTX_PATH, "size_bytes": ltx_size, "sha256": LTX_SHA,\n` +
    `                            "sha256_s": round(time.time() - t, 1)}\n` +
    `\n` +
    `# --- T5-XXL encoder (FLUX layout mount) ---\n` +
    `TE2_CFG = find_one("/kaggle/input/**/text_encoder_2/config.json", "FLUX T5 encoder config")\n` +
    `TE2_DIR = os.path.dirname(TE2_CFG)\n` +
    `te2_size = 0\n` +
    `te2_files = []\n` +
    `for r, _, fs in os.walk(TE2_DIR):\n` +
    `    for fn in fs:\n` +
    `        fp = os.path.join(r, fn)\n` +
    `        te2_size += os.path.getsize(fp)\n` +
    `        te2_files.append(os.path.relpath(fp, TE2_DIR))\n` +
    `log("T5 encoder dir: %s (%.2f GiB, %d files)" % (TE2_DIR, te2_size / 2**30, len(te2_files)))\n` +
    `for fn in sorted(te2_files):\n` +
    `    log("   ", fn)\n` +
    `REPORT["t5_encoder"] = {"dir": TE2_DIR, "size_bytes": te2_size, "files": sorted(te2_files)}\n` +
    `\n` +
    `# --- T5 tokenizer (FLUX layout mount) ---\n` +
    `TOK2_CFG = find_one("/kaggle/input/**/tokenizer_2/tokenizer_config.json", "FLUX T5 tokenizer config")\n` +
    `TOK2_DIR = os.path.dirname(TOK2_CFG)\n` +
    `tok2_files = sorted(os.listdir(TOK2_DIR))\n` +
    `log("T5 tokenizer dir: %s (%s)" % (TOK2_DIR, tok2_files))\n` +
    `REPORT["t5_tokenizer"] = {"dir": TOK2_DIR, "files": tok2_files}\n` +
    `\n` +
    `# --- Keyframes (private dataset mount) ---\n` +
    `# Per-job keyframes: the sha256 asserts from the Run 10 proof pair are\n` +
    `# NOT carried over (every job has its own keyframes). The 1024x576\n` +
    `# size assert in the generation cell is the keyframe check.\n` +
    `FIRST = find_one("/kaggle/input/**/first_frame.png", "first keyframe")\n` +
    `LAST = find_one("/kaggle/input/**/last_frame.png", "last keyframe")\n` +
    `REPORT["keyframes"] = {"first": FIRST, "last": LAST, "verified": "size-only (per-job keyframes)"}\n` +
    `\n` +
    `# --- disk after inventory (mounts are read-only; only pip + HF cache grew) ---\n` +
    `disk_after_inv = {}\n` +
    `for path in ["/kaggle/working"]:\n` +
    `    total, used, free = shutil.disk_usage(path)\n` +
    `    disk_after_inv[path] = {"used_gib": round(used / 2**30, 2), "free_gib": round(free / 2**30, 2)}\n` +
    `    log("disk %s after inventory: used=%.2fG free=%.2fG" % (path, used / 2**30, free / 2**30))\n` +
    `REPORT["disk_after_inventory"] = disk_after_inv\n` +
    `REPORT["rss_gib_after_inventory"] = rss_gib()\n` +
    `log("INVENTORY COMPLETE — all assets present, sizes + checkpoint hash verified")`,
  ));

  // Cell 4 — T5 load + prompt encode (Run 10 cell 4; PROMPT from the job).
  cells.push(codeCell(
    `# T5-XXL: load FP16 from the mount, encode the prompt on GPU, then move to\n` +
    `# CPU before sampling. The CPU placement after encoding is INTENTIONAL and\n` +
    `# recorded here — it is not a fallback.\n` +
    `from transformers import T5EncoderModel, T5TokenizerFast\n` +
    `from PIL import Image\n` +
    `import numpy as np\n` +
    `\n` +
    `PROMPT = ${promptJson}\n` +
    `MAX_SEQ = 128\n` +
    `REPORT["prompt"] = PROMPT\n` +
    `REPORT["max_sequence_length"] = MAX_SEQ\n` +
    `\n` +
    `t = time.time()\n` +
    `tok = T5TokenizerFast.from_pretrained(TOK2_DIR)\n` +
    `log("tokenizer loaded in %.1f s: %s" % (time.time() - t, tok.__class__.__name__))\n` +
    `\n` +
    `t = time.time()\n` +
    `t5 = T5EncoderModel.from_pretrained(TE2_DIR, torch_dtype=torch.float16)\n` +
    `t5_load_s = time.time() - t\n` +
    `t5_params = sum(p.numel() for p in t5.parameters())\n` +
    `t5_dtype = next(t5.parameters()).dtype\n` +
    `log("T5 loaded (CPU, fp16) in %.1f s; params=%.2fB; dtype=%s" % (t5_load_s, t5_params / 1e9, t5_dtype))\n` +
    `assert str(t5_dtype) == "torch.float16", "T5 NOT FP16"\n` +
    `REPORT["t5_load_s"] = round(t5_load_s, 1)\n` +
    `REPORT["t5_params_b"] = round(t5_params / 1e9, 2)\n` +
    `REPORT["t5_dtype"] = str(t5_dtype)\n` +
    `REPORT["rss_gib_after_t5_load"] = rss_gib()\n` +
    `log("VRAM before T5->cuda: %.2f GiB | RSS %.2f GiB" % (\n` +
    `    torch.cuda.memory_allocated() / 2**30, rss_gib()))\n` +
    `\n` +
    `t = time.time()\n` +
    `t5.to("cuda")\n` +
    `log("T5 -> cuda in %.1f s; VRAM now %.2f GiB" % (\n` +
    `    time.time() - t, torch.cuda.memory_allocated() / 2**30))\n` +
    `REPORT["t5_vram_gib"] = round(torch.cuda.memory_allocated() / 2**30, 2)\n` +
    `\n` +
    `# Encode — exact replica of diffusers 0.40.0\n` +
    `# LTXPipeline._get_t5_prompt_embeds (pipeline_ltx.py).\n` +
    `text_inputs = tok(PROMPT, padding="max_length", max_length=MAX_SEQ,\n` +
    `                  truncation=True, add_special_tokens=True, return_tensors="pt")\n` +
    `text_input_ids = text_inputs.input_ids\n` +
    `prompt_attention_mask = text_inputs.attention_mask.bool().to("cuda")\n` +
    `untruncated = tok(PROMPT, padding="longest", return_tensors="pt").input_ids\n` +
    `truncated = (untruncated.shape[-1] >= text_input_ids.shape[-1]\n` +
    `             and not torch.equal(text_input_ids, untruncated))\n` +
    `log("prompt tokens: %d (max %d); untruncated len %d; truncated=%s" % (\n` +
    `    text_input_ids.shape[1], MAX_SEQ, untruncated.shape[-1], truncated))\n` +
    `REPORT["prompt_tokens"] = int(text_input_ids.shape[1])\n` +
    `REPORT["prompt_truncated"] = bool(truncated)\n` +
    `\n` +
    `t = time.time()\n` +
    `with torch.no_grad():\n` +
    `    prompt_embeds = t5(text_input_ids.to("cuda"))[0]\n` +
    `prompt_embeds = prompt_embeds.to(dtype=t5.dtype, device="cuda")\n` +
    `t5_encode_s = time.time() - t\n` +
    `finite = bool(torch.isfinite(prompt_embeds).all().item())\n` +
    `log("T5 encode in %.1f s; embeds %s %s; finite=%s" % (\n` +
    `    t5_encode_s, tuple(prompt_embeds.shape), prompt_embeds.dtype, finite))\n` +
    `assert finite, "NON-FINITE PROMPT EMBEDS"\n` +
    `REPORT["t5_encode_s"] = round(t5_encode_s, 1)\n` +
    `REPORT["prompt_embeds_shape"] = [int(x) for x in prompt_embeds.shape]\n` +
    `REPORT["prompt_embeds_dtype"] = str(prompt_embeds.dtype)\n` +
    `REPORT["prompt_embeds_finite"] = finite\n` +
    `\n` +
    `# Keep the embeds on CPU; move T5 back to CPU; free the GPU for sampling.\n` +
    `prompt_embeds_cpu = prompt_embeds.to("cpu")\n` +
    `mask_cpu = prompt_attention_mask.to("cpu")\n` +
    `del prompt_embeds, prompt_attention_mask, text_inputs, text_input_ids, untruncated\n` +
    `t5.to("cpu")\n` +
    `gc.collect()\n` +
    `torch.cuda.empty_cache()\n` +
    `torch.cuda.reset_peak_memory_stats()\n` +
    `log("T5 -> CPU (intentional, post-encode); VRAM now %.2f GiB; RSS %.2f GiB" % (\n` +
    `    torch.cuda.memory_allocated() / 2**30, rss_gib()))\n` +
    `REPORT["vram_gib_after_t5_to_cpu"] = round(torch.cuda.memory_allocated() / 2**30, 2)\n` +
    `REPORT["rss_gib_after_t5_to_cpu"] = rss_gib()`,
  ));

  // Cell 5 — pipeline build (Run 10 cell 5, verbatim).
  cells.push(codeCell(
    `# Build the pipeline from the single file (diffusers converter, embedded\n` +
    `# 0.9.5-architecture configs). The passed-in T5 + tokenizer MUST be the ones\n` +
    `# used — otherwise from_single_file would download the ~19 GB text encoder\n` +
    `# from the config repo. The HF cache delta proves no large download happened.\n` +
    `from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXConditionPipeline, LTXVideoCondition\n` +
    `\n` +
    `def du_bytes(path):\n` +
    `    s = 0\n` +
    `    for r, _, fs in os.walk(path):\n` +
    `        for fn in fs:\n` +
    `            try:\n` +
    `                s += os.path.getsize(os.path.join(r, fn))\n` +
    `            except OSError:\n` +
    `                pass\n` +
    `    return s\n` +
    `\n` +
    `hf_before = du_bytes(os.path.expanduser("~/.cache/huggingface"))\n` +
    `log("HF cache before from_single_file: %.1f MiB" % (hf_before / 2**20))\n` +
    `\n` +
    `t = time.time()\n` +
    `pipe = LTXConditionPipeline.from_single_file(\n` +
    `    LTX_PATH,\n` +
    `    torch_dtype=torch.float16,\n` +
    `    text_encoder=t5,\n` +
    `    tokenizer=tok,\n` +
    `    config="Lightricks/LTX-Video-0.9.5",\n` +
    `)\n` +
    `from_single_file_s = time.time() - t\n` +
    `log("from_single_file in %.1f s" % from_single_file_s)\n` +
    `assert pipe.text_encoder is t5, "text_encoder was NOT the passed-in T5 (a download may have happened)"\n` +
    `assert pipe.tokenizer is tok, "tokenizer was NOT the passed-in tokenizer"\n` +
    `log("text_encoder/tokenizer: passed-in components confirmed (no download)")\n` +
    `hf_after = du_bytes(os.path.expanduser("~/.cache/huggingface"))\n` +
    `log("HF cache after: %.1f MiB (delta %.1f MiB — config JSONs only)" % (\n` +
    `    hf_after / 2**20, (hf_after - hf_before) / 2**20))\n` +
    `REPORT["from_single_file_s"] = round(from_single_file_s, 1)\n` +
    `REPORT["config_repo"] = "Lightricks/LTX-Video-0.9.5"\n` +
    `REPORT["hf_cache_delta_mib"] = round((hf_after - hf_before) / 2**20, 1)\n` +
    `REPORT["scheduler"] = pipe.scheduler.__class__.__name__\n` +
    `REPORT["scheduler_config"] = {k: str(v) for k, v in dict(pipe.scheduler.config).items()}\n` +
    `log("scheduler:", pipe.scheduler.__class__.__name__)\n` +
    `log("transformer:", pipe.transformer.__class__.__name__,\n` +
    `    "| layers:", pipe.transformer.config.num_layers,\n` +
    `    "| vae:", pipe.vae.__class__.__name__)\n` +
    `try:\n` +
    `    log("transformer attention implementation:",\n` +
    `        getattr(pipe.transformer.config, "_attn_implementation", "unknown"))\n` +
    `    REPORT["attn_implementation"] = str(getattr(pipe.transformer.config, "_attn_implementation", "unknown"))\n` +
    `except Exception as e:\n` +
    `    log("attention implementation unreadable:", e)\n` +
    `\n` +
    `# Move transformer + VAE to cuda. T5 stays on CPU by design.\n` +
    `t = time.time()\n` +
    `pipe.transformer.to("cuda")\n` +
    `pipe.vae.to("cuda")\n` +
    `log("transformer+vae -> cuda in %.1f s; VRAM %.2f GiB; RSS %.2f GiB" % (\n` +
    `    time.time() - t, torch.cuda.memory_allocated() / 2**30, rss_gib()))\n` +
    `REPORT["vram_gib_after_transformer_vae_to_cuda"] = round(torch.cuda.memory_allocated() / 2**30, 2)\n` +
    `REPORT["rss_gib_after_pipeline"] = rss_gib()\n` +
    `torch.cuda.reset_peak_memory_stats()\n` +
    `\n` +
    `# ---------- DTYPE AUDIT (before sampling) ----------\n` +
    `def dtype_audit(module, name):\n` +
    `    counts = {}\n` +
    `    for p in list(module.parameters()) + list(module.buffers()):\n` +
    `        k = str(p.dtype)\n` +
    `        counts[k] = counts.get(k, 0) + int(p.numel())\n` +
    `    total = sum(counts.values())\n` +
    `    parts = " ".join("%s=%.1f%%" % (k, v / total * 100) for k, v in sorted(counts.items()))\n` +
    `    log("  %s: %.2fB params %s" % (name, total / 1e9, parts))\n` +
    `    return counts\n` +
    `\n` +
    `log("DTYPE AUDIT (before sampling):")\n` +
    `a_tr = dtype_audit(pipe.transformer, "transformer")\n` +
    `a_vae = dtype_audit(pipe.vae, "vae")\n` +
    `a_t5 = dtype_audit(pipe.text_encoder, "text_encoder (CPU)")\n` +
    `bf16_before = sum(c.get("torch.bfloat16", 0) for c in (a_tr, a_vae, a_t5))\n` +
    `log("bf16 params before sampling: %d" % bf16_before)\n` +
    `assert bf16_before == 0, "BF16 PARAMS PRESENT BEFORE SAMPLING: %d" % bf16_before\n` +
    `log("FP16 VERIFIED BEFORE SAMPLING: 0 bf16 params; is_bf16_supported=%s" % torch.cuda.is_bf16_supported())\n` +
    `REPORT["dtype_audit_before"] = {"transformer": a_tr, "vae": a_vae, "text_encoder": a_t5,\n` +
    `                                "bf16_params": 0}`,
  ));

  // Cell 6 — the generation (Run 10 cell 6, verbatim).
  cells.push(codeCell(
    `# THE GENERATION — one run only.\n` +
    `first_img = Image.open(FIRST).convert("RGB")\n` +
    `last_img = Image.open(LAST).convert("RGB")\n` +
    `log("keyframes: first %s, last %s" % (first_img.size, last_img.size))\n` +
    `assert first_img.size == (1024, 576) and last_img.size == (1024, 576)\n` +
    `\n` +
    `conditions = [\n` +
    `    LTXVideoCondition(image=first_img, frame_index=0, strength=1.0),\n` +
    `    LTXVideoCondition(image=last_img, frame_index=120, strength=1.0),\n` +
    `]\n` +
    `gen = torch.Generator(device="cuda").manual_seed(42)\n` +
    `step_times = []\n` +
    `step_vram = []\n` +
    `latent_dtypes = []\n` +
    `\n` +
    `def cb(pipe_obj, step, timestep, callback_kwargs):\n` +
    `    step_times.append(time.time())\n` +
    `    step_vram.append(round(torch.cuda.memory_allocated() / 2**30, 2))\n` +
    `    lat = callback_kwargs.get("latents")\n` +
    `    if lat is not None:\n` +
    `        latent_dtypes.append(str(lat.dtype))\n` +
    `    log("  step %d t=%.4f VRAM %.2f GiB latents %s" % (\n` +
    `        step, float(timestep), step_vram[-1], lat.dtype if lat is not None else "?"), flush=True)\n` +
    `    return callback_kwargs\n` +
    `\n` +
    `torch.cuda.reset_peak_memory_stats()\n` +
    `torch.cuda.synchronize()\n` +
    `t_call = time.time()\n` +
    `out = pipe(\n` +
    `    prompt_embeds=prompt_embeds_cpu.to("cuda"),\n` +
    `    prompt_attention_mask=mask_cpu.to("cuda"),\n` +
    `    conditions=conditions,\n` +
    `    height=576, width=1024, num_frames=121,\n` +
    `    num_inference_steps=8, guidance_scale=1.0,\n` +
    `    generator=gen, max_sequence_length=128,\n` +
    `    decode_timestep=0.0, image_cond_noise_scale=0.15,\n` +
    `    output_type="pil", return_dict=True,\n` +
    `    callback_on_step_end=cb,\n` +
    `    callback_on_step_end_tensor_inputs=["latents"],\n` +
    `)\n` +
    `torch.cuda.synchronize()\n` +
    `t_ret = time.time()\n` +
    `frames = out.frames[0]\n` +
    `log("generated %d frames, each %s %s" % (len(frames), frames[0].size, frames[0].mode))\n` +
    `assert len(frames) == 121, "EXPECTED 121 FRAMES, GOT %d" % len(frames)\n` +
    `assert len(step_times) == 8, "EXPECTED 8 STEPS, SAW %d" % len(step_times)\n` +
    `\n` +
    `t_last_step = step_times[-1]\n` +
    `sampling_s = t_last_step - t_call\n` +
    `decode_s = t_ret - t_last_step\n` +
    `total_gen_s = t_ret - t_call\n` +
    `per_step = [round(step_times[i + 1] - step_times[i], 2) for i in range(len(step_times) - 1)]\n` +
    `log("TIMING: sampling (incl latent init + conditioning) = %.1f s" % sampling_s)\n` +
    `log("TIMING: decode + post = %.1f s" % decode_s)\n` +
    `log("TIMING: total generate call = %.1f s" % total_gen_s)\n` +
    `log("per-step times (s): %s" % per_step)\n` +
    `log("per-step VRAM (GiB): %s" % step_vram)\n` +
    `log("peak VRAM during generation: %.2f GiB" % (torch.cuda.max_memory_allocated() / 2**30))\n` +
    `log("latent dtypes seen: %s" % sorted(set(latent_dtypes)))\n` +
    `assert "torch.bfloat16" not in set(latent_dtypes), "LATENTS CONTAIN BF16: %s" % set(latent_dtypes)\n` +
    `log("latents are %s — diffusers keeps the latent state in fp32 by design; weights are fp16, zero bf16 anywhere" % sorted(set(latent_dtypes)))\n` +
    `REPORT["generation"] = {\n` +
    `    "num_frames": 121, "height": 576, "width": 1024, "num_inference_steps": 8,\n` +
    `    "guidance_scale": 1.0, "seed": 42, "decode_timestep": 0.0,\n` +
    `    "image_cond_noise_scale": 0.15,\n` +
    `    "sampling_s": round(sampling_s, 1), "decode_s": round(decode_s, 1),\n` +
    `    "total_generate_s": round(total_gen_s, 1),\n` +
    `    "per_step_s": per_step, "per_step_vram_gib": step_vram,\n` +
    `    "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2),\n` +
    `    "latent_dtypes": sorted(set(latent_dtypes)),\n` +
    `    "frames_returned": len(frames),\n` +
    `}\n` +
    `REPORT["rss_gib_after_generation"] = rss_gib()\n` +
    `\n` +
    `# ---------- DTYPE AUDIT (after sampling) ----------\n` +
    `log("DTYPE AUDIT (after sampling):")\n` +
    `b_tr = dtype_audit(pipe.transformer, "transformer")\n` +
    `b_vae = dtype_audit(pipe.vae, "vae")\n` +
    `bf16_after = sum(c.get("torch.bfloat16", 0) for c in (b_tr, b_vae))\n` +
    `log("bf16 params after sampling: %d" % bf16_after)\n` +
    `assert bf16_after == 0, "BF16 PARAMS PRESENT AFTER SAMPLING: %d" % bf16_after\n` +
    `log("FP16 VERIFIED AFTER SAMPLING: 0 bf16 params — no silent conversion")\n` +
    `REPORT["dtype_audit_after"] = {"transformer": b_tr, "vae": b_vae, "bf16_params": 0}`,
  ));

  // Cell 7 — export + integrity + report (Run 10 cell 7; filenames use
  // the job id — the executor's fileReport channel expects
  // <jobId>.report.json).
  cells.push(codeCell(
    `# Export + output integrity. MP4 must be yuv420p (phone-playback law).\n` +
    `import imageio.v2 as imageio\n` +
    `import imageio_ffmpeg\n` +
    `\n` +
    `ffexe = imageio_ffmpeg.get_ffmpeg_exe()\n` +
    `mp4_path = os.path.join(OUT, ${jobIdJson} + ".mp4")\n` +
    `t = time.time()\n` +
    `writer = imageio.get_writer(mp4_path, fps=24, codec="libx264", quality=8,\n` +
    `                            pixelformat="yuv420p",\n` +
    `                            ffmpeg_params=["-movflags", "+faststart"],\n` +
    `                            macro_block_size=16)\n` +
    `for fr in frames:\n` +
    `    writer.append_data(np.array(fr))\n` +
    `writer.close()\n` +
    `export_s = time.time() - t\n` +
    `log("exported %s in %.1f s" % (mp4_path, export_s))\n` +
    `REPORT["export_s"] = round(export_s, 1)\n` +
    `\n` +
    `frames[0].save(os.path.join(OUT, ${jobIdJson} + "-frame-00-first.png"))\n` +
    `frames[60].save(os.path.join(OUT, ${jobIdJson} + "-frame-60-middle.png"))\n` +
    `frames[120].save(os.path.join(OUT, ${jobIdJson} + "-frame-120-last.png"))\n` +
    `strip = Image.new("RGB", (1024 * 3, 576))\n` +
    `strip.paste(frames[0], (0, 0))\n` +
    `strip.paste(frames[60], (1024, 0))\n` +
    `strip.paste(frames[120], (2048, 0))\n` +
    `strip.save(os.path.join(OUT, ${jobIdJson} + "-contact-first-mid-last.png"))\n` +
    `log("saved check frames + contact strip")\n` +
    `\n` +
    `# Integrity: ffmpeg -i parse (codec / pix_fmt / resolution / fps) + full decode.\n` +
    `probe = subprocess.run([ffexe, "-hide_banner", "-i", mp4_path],\n` +
    `                       capture_output=True, text=True)\n` +
    `info = probe.stderr\n` +
    `log("ffmpeg -i output:")\n` +
    `log(info)\n` +
    `assert "yuv420p" in info, "PIX_FMT IS NOT yuv420p"\n` +
    `assert "1024x576" in info, "RESOLUTION NOT 1024x576"\n` +
    `assert "h264" in info, "CODEC NOT h264"\n` +
    `reader = imageio.get_reader(mp4_path)\n` +
    `n_decoded = 0\n` +
    `for _ in reader:\n` +
    `    n_decoded += 1\n` +
    `log("read-back decoded %d frames (expected 121)" % n_decoded)\n` +
    `assert n_decoded == 121, "DECODED FRAME COUNT MISMATCH: %d" % n_decoded\n` +
    `meta = reader.get_meta_data()\n` +
    `log("reader metadata: %s" % meta)\n` +
    `mp4_size = os.path.getsize(mp4_path)\n` +
    `mp4_sha = hashlib.sha256(open(mp4_path, "rb").read()).hexdigest()\n` +
    `log("MP4: %d bytes sha256 %s" % (mp4_size, mp4_sha))\n` +
    `REPORT["output"] = {"path": mp4_path, "size_bytes": mp4_size, "sha256": mp4_sha,\n` +
    `                    "frames_decoded": n_decoded, "pix_fmt": "yuv420p",\n` +
    `                    "codec": "h264", "resolution": "1024x576", "fps": 24,\n` +
    `                    "reader_meta": {k: str(v) for k, v in meta.items()}}\n` +
    `\n` +
    `# Disk after everything.\n` +
    `disk_after = {}\n` +
    `for path in ["/kaggle/working"]:\n` +
    `    total, used, free = shutil.disk_usage(path)\n` +
    `    disk_after[path] = {"used_gib": round(used / 2**30, 2), "free_gib": round(free / 2**30, 2)}\n` +
    `    log("disk %s at end: used=%.2fG free=%.2fG" % (path, used / 2**30, free / 2**30))\n` +
    `REPORT["disk_after"] = disk_after\n` +
    `REPORT["rss_gib_end"] = rss_gib()\n` +
    `REPORT["total_elapsed_s"] = round(time.time() - T0, 1)\n` +
    `REPORT["total_elapsed_min"] = round((time.time() - T0) / 60, 1)\n` +
    `\n` +
    `with open(os.path.join(OUT, ${jobIdJson} + ".report.json"), "w") as f:\n` +
    `    json.dump(REPORT, f, indent=2, default=str)\n` +
    `log("REPORT WRITTEN: " + os.path.join(OUT, ${jobIdJson} + ".report.json"))\n` +
    `log("TOTAL ELAPSED: %.1f min" % REPORT["total_elapsed_min"])\n` +
    `log("=== LTX JOB COMPLETE — ONE RUN ONLY. STOP. ===")`,
  ));

  cells.push(mdCell(
    `## End of job\n\n` +
    `One controlled 121-frame run, as authorised. Outputs in \`/kaggle/working/output/\`:\n\n` +
    `- \`${job.id}.mp4\` — the clip (1024x576, 24 fps, h264, yuv420p, ~5 s)\n` +
    `- \`${job.id}.report.json\` — all measurements (filed with the manager via the fileReport channel)\n` +
    `- \`${job.id}-frame-00-first.png\`, \`${job.id}-frame-60-middle.png\`, \`${job.id}-frame-120-last.png\` — I2V check frames\n` +
    `- \`${job.id}-contact-first-mid-last.png\` — first / middle / last side by side\n\n` +
    `No second generation in this kernel.`,
  ));

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10.0' },
    },
    cells,
  };
}

// The real personal LTX executor. A KaggleExecutor whose notebook builder
// is the Run 10 builder and whose kernel metadata carries the Run 10
// mounts (checkpoint + T5 via Kaggle Models, keyframes via dataset).
// Audience is personal (inherited); the transport stays null (human
// channel) until the owner supplies a credential AND the proof run is
// separately authorised.
export class LtxKaggleExecutor extends KaggleExecutor {
  constructor({ notebookBuilder = null, kaggleUsername = null, ...rest } = {}) {
    super({
      notebookBuilder: notebookBuilder ?? buildLtxNotebook,
      kaggleUsername,
      ...rest,
    });
  }

  _kernelMetadata(job, manifest) {
    const meta = super._kernelMetadata(job, manifest);
    // Run 10 mounts: the checkpoint + T5 ride Kaggle Models (not a
    // dataset), the keyframes ride the owner's keyframes dataset.
    meta.dataset_sources = [LTX_KEYFRAMES_DATASET];
    meta.model_sources = [LTX_CHECKPOINT.modelSource, LTX_T5_MODEL_SOURCE];
    // The single pip install of pinned packages needs the kernel's
    // internet flag (Run 10 ran with internet on). The generation itself
    // uses only mounted weights — nothing large is downloaded.
    meta.enable_internet = true;
    // Run 10 ran on a T4; the LTX notebook is validated on T4 only.
    meta.machine_shape = 'NvidiaTeslaT4';
    return meta;
  }

  _readme(job, manifest) {
    // The base README describes the Wan weights dataset for the official
    // route — wrong for LTX (weights ride Kaggle Model mounts, not a
    // dataset). The LTX package README names the real mounts.
    const lines = [
      `# NOVA GPU Cloud — Kaggle job package: ${job.id}`,
      ``,
      `Model: ${job.modelId} (${manifest.route} route) | Provider: kaggle-t4`,
      ``,
      `## Files`,
      ``,
      `- \`notebook.ipynb\` — the self-contained notebook (only this file is sent on push)`,
      `- \`kernel-metadata.json\` — kernel metadata (GPU on, internet on for the pinned pip install, LTX checkpoint + T5 model mounts, keyframes dataset attached)`,
      `- \`staging-manifest.json\` — the VDP-04 staging manifest (weights, text encoder, keyframes, packages)`,
      ``,
      `## Before the first push (Part B, human)`,
      ``,
      `1. Sign in to Kaggle as the owner's account and complete phone verification (gates the GPU accelerator and the Internet toggle).`,
      `2. Fill in the Kaggle username in \`kernel-metadata.json\` (currently \`<kaggle-username>\`).`,
      `3. Confirm the Kaggle Model mounts exist: \`${LTX_CHECKPOINT.modelSource}\` (LTX checkpoint) and \`${LTX_T5_MODEL_SOURCE}\` (T5-XXL FP16 + tokenizer), and the keyframes dataset \`${LTX_KEYFRAMES_DATASET}\`. The weights are mounted read-only — nothing large is downloaded in-session.`,
      ``,
      `## Run it`,
      ``,
      `    cd ${job.id}`,
      `    kaggle kernels push -p . --accelerator NvidiaTeslaT4 -t 43200`,
      ``,
      `(-t 43200 = 12h timeout, Kaggle's GPU session limit. The proof run is expected to take far less.)`,
      ``,
      `## Poll + download the report`,
      ``,
      `    kaggle kernels status <kaggle-username>/nova-gpu-cloud-${job.id}`,
      `    kaggle kernels output -p . <kaggle-username>/nova-gpu-cloud-${job.id}`,
      ``,
      `Then file the report JSON (${job.id}.report.json) with the manager (see docs/connection-layer.md §6) and download the MP4 separately — no media passes through the manager (O-27).`,
      ``,
      `## Cancel`,
      ``,
      `The Kaggle CLI has NO cancel command. To stop a runaway run, open the kernel in the Kaggle web UI and delete/stop it there.`,
      ``,
      `## Papermill`,
      ``,
      `Kaggle runs committed notebooks via papermill, which kills a kernel that produces no output for ~4 s. The notebook prints progress with flush=True throughout — do not remove the prints.`,
      ``,
    ];
    return lines.join('\n');
  }
}
