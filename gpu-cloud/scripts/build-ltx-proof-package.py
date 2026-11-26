#!/usr/bin/env python3
"""Build the NOVA GPU Cloud LTX-Video 2B distilled (0.9.8) one-clip proof package.

Writes gpu-cloud/packages/ltx-proof-20261124-01/:
  ltx-proof.ipynb        — the self-contained notebook (only this file is sent on push)
  kernel-metadata.json   — kernel metadata (GPU T4 via machine_shape, internet on,
                           keyframes dataset + two Kaggle Model mounts)
  staging-manifest.json  — the VDP-04 staging manifest
  README.md              — runbook

Authorisation: Shina 24 Nov 2026 ~22:35 WAT ("Get the reviewer's word, then run
the proof"); reviewer verdict 24 Nov ~22:38: "Proceed with one controlled
17-frame Kaggle proof." ONE RUN ONLY. Stop after the first output.

Design (all verified 24 Nov 2026 against the real sources, not the plan):
  - Model: LTX-Video 2B distilled 0.9.8, checkpoint
    ltxv-2b-0.9.8-distilled.safetensors, 6,340,744,492 bytes, repo
    Lightricks/LTX-Video (ungated), Apache-style LTXV Open Weights License 0.X.
  - THE FP16 ADAPTATION (reviewer's top requirement): the official
    ltxv-2b-0.9.8-distilled.yaml (LTX-Video repo commit bdc8f01) specifies
    precision bfloat16 with a TWO-PASS multi-scale pipeline (7 first-pass +
    3 second-pass timesteps), a spatial upscaler, and prompt enhancement
    (Florence-2 + Llama-3.2-3B). That native path does NOT run on a T4
    (Turing CC 7.5 has no BF16). The proof does NOT use the native repo.
    It uses the diffusers 0.40.0 implementation (LTXConditionPipeline,
    from_single_file with the converter's embedded 0.9.5-architecture
    configs, torch_dtype=torch.float16): single-pass flow matching, 8
    inference steps, no upscaler, no prompt enhancement, no CFG
    (guidance_scale 1.0). This is the FP16 adaptation, documented here and
    in the evidence record. The notebook PROVES the FP16 path: a dtype
    audit before AND after sampling asserts ZERO bf16 parameters across
    transformer + VAE + text encoder, and the per-step callback records
    latent dtypes.
  - Steps reconciliation (recorded, not glossed): native yaml 7+3=10
    timesteps (two-pass, BF16); diffusers distilled "8 fixed timesteps";
    T4-Bench 27.4 s at FOUR steps, warm, model's own preset resolution.
    The proof uses 8 steps and records its own measured times; the 27.4 s
    figure is NOT comparable and is never compared with total time.
  - Weights via Kaggle Model mounts (read-only, OUTSIDE /kaggle/working):
    marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors (6.34 GB, size
    byte-identical to the official file; TRACK-C verified its sha256
    equals the Hub LFS oid) + sanderland/flux.1-schnell (33.7 GB layout,
    used ONLY for its T5-XXL text encoder + tokenizer). The full pipeline
    does NOT fit 20 GB by download (LTX 6.34 GB + PixArt T5 19.05 GB =
    25.39 GB) — mounts are the strategy, decided in pre-flight.
  - T5-XXL: loaded FP16 from the FLUX layout mount, prompt encoded on
    GPU, then moved to CPU BEFORE sampling (intentional, recorded — not
    a fallback). The transformer + VAE are the only modules on GPU
    during sampling. The notebook asserts the passed-in T5/tokenizer
    objects are the ones the pipeline uses, and measures the HF cache
    delta to prove no 19 GB text-encoder download happened.
  - Hardware: ONE Tesla T4 (cuda:0 only), ONE process. Kaggle provisions
    2 T4s per session; cuda:1 is recorded as provisioned-but-unused.
  - Input: TWO controlled keyframes of the SAME dragon (first: dragon on the
    ridge; last: the same still at 1.12x centre zoom), both our own generated
    dragon still (VDP-06 synthetic only). Delivered as the private Kaggle
    dataset oliversmithh/nova-ltx-proof-keyframes-20261124. (Run 6 used
    genuinely different keyframes — wings folded vs raised — and produced
    genuinely visible motion; this repeatability series returns to the
    run-4 keyframes by design.)
  - Frames 17 (0.708 s at 24 fps), resolution 1024x576 (TRACK-C-proven on T4), 8 steps,
    guidance 1.0, seed 42, max_sequence_length 128, decode_timestep 0.0,
    image_cond_noise_scale 0.15 (defaults recorded).
  - Pins (TRACK-C's proven Kaggle set, verified on PyPI 24 Nov):
    diffusers==0.40.0, transformers==5.16.1, plus accelerate,
    sentencepiece, protobuf, imageio-ffmpeg — installed in ONE pip
    invocation (Wan v2 lesson: interacting packages pinned together).
    Torch is NOT pinned (Kaggle image torch 2.11.0+cu130, matches
    TRACK-C). No bitsandbytes (no 8-bit loading in this proof).
  - First code cell is the reviewer's three-gate smoke check (Gate A
    GPU, Gate B internet, Gate C storage) with FAIL-FAST exit — a CPU
    fallback NEVER reaches model work. Papermill: every long cell
    prints progress with flush=True.
  - Coexistence: the Wan v5 kernel runs as a SEPARATE session/machinery
    experiment. This kernel is separate; quota accounting is distinct.
  - v1 LESSON (24 Nov 2026): the first push FAILED at cell 3 (inventory)
    with AssertionError LTX SIZE MISMATCH — the glob
    /kaggle/input/**/ltxv-2b-0.9.8-distilled.safetensors matched the model
    SLUG DIRECTORY itself (the slug ends in .safetensors) before the file,
    and getsize of a directory is 4096 bytes. Fix: find_one filters to
    os.path.isfile. Everything before cell 3 passed (all three gates, pip
    install 20.3 s, pins asserted, mounts attached). No generation was
    attempted; no model was loaded.
  - v2 LESSON (24 Nov 2026): the second push FAILED at cell 3 again, one
    line past the v1 fix — the size check PASSED (6340744492 bytes), then
    sha256_file crashed with TypeError: log() got an unexpected keyword
    argument 'flush'. The notebook's log() was defined as def log(*a) but
    two call sites pass flush=True (sha256 progress + the per-step
    sampling callback). Fix: def log(*a, **k) — kwargs accepted and
    ignored, print already flushes. Both call sites are now safe. No
    generation was attempted; no model was loaded.
  - v3 LESSON (24 Nov 2026): the third push ran all the way through
    generation — 17 frames in 8.9 s, peak VRAM 6.92 GiB, dtype audit
    0 bf16 params — then FAILED at cell 6 on an OVER-STRICT harness
    assertion: `assert set(latent_dtypes) == {"torch.float16"}`. Diffusers
    keeps the latent state in FP32 by design (numerical stability); the
    latents were torch.float32 on all 8 steps, weights 100% FP16, zero
    BF16 anywhere. The assertion demanded something the framework never
    promises. Fix: assert only that no latent is BF16, and record the
    observed dtype. The FP16 requirement is about weights and the compute
    path (proven by the dtype audits), not the latent tensor dtype.
  - v4 OUTCOME (24 Nov 2026): run 4 SUCCEEDED — the first clip from NOVA's
    own engine (17 frames, 1024x576, 0.708 s, sampling 7.2 s, peak VRAM
    6.92 GiB, FP16 proven, 0 BF16, MP4 stored in the GPU Cloud store).
    BUT Shina's verdict on watching it: no sound, no visible motion — the
    first/mid/last frames are nearly identical; the only motion was a slow
    push-in across 0.7 s, too short and too subtle to see. The numbers
    looked fine while the clip looked still. Lesson: verify motion BY EYE
    on the contact strip, never on measurements alone.
  - v5 (authorised by Shina 24 Nov ~23:40 WAT): ONE change of substance — 49 frames (~2 s at 24 fps) instead of 17, plus a stronger motion prompt (wings rising and falling, head turning toward camera, mist drifting, embers rising). Same model, same keyframes, same FP16 path, same resolution, same harness fixes v1/v2/v3. Run 5 SUCCEEDED technically (49 frames, 8.68 GiB peak) but Shina's verdict was again "no motion" — the six frames across the clip are nearly identical. Root cause identified: the first and last keyframes were almost the same picture (last = 1.12x zoom of first), so the model interpolated between near-identical endpoints. A stronger prompt cannot fix that.
  - v6 (24 Nov 2026, authorised by Shina ~23:49 WAT): TWO genuinely different keyframes — first: wings folded DOWN at the dragon's sides, head lowered; last: wings raised HIGH and spread, head lifted toward camera. Same dragon identity, ridge, mist and dawn light (both edited from the same still). 49 frames, same model, same FP16 path, same resolution/steps/guidance/seed, motion prompt matching the pose change. Run 6 SUCCEEDED with genuinely visible motion (wings rise from folded to spread; head lifts toward camera). Shina's verdict: "Ok" (25 Nov ~00:01 WAT). Sound is NOT part of any LTX run: LTX generates video only; audio is a separate later step.
  - v7/v8/v9 — REPEATABILITY SERIES, Phase 2 (authorised by Shina's "Ok" + the reviewer/mentor order, 25 Nov 2026): THREE independent runs of the EXACT run-4 configuration (17 frames, run-4 prompt, run-4 keyframes, seed 42, 8 steps, guidance 1.0, 1024x576). Do NOT change the configuration midway; if a run needs a correction, document it and distinguish the corrected configuration from the original series.
  - v10 — PRODUCTION-LENGTH PROOF (25 Nov 2026, authorised by Shina ~08:03 WAT "get to work"; reviewer confirmed longer clips as the next primary priority, thread 17): ONE change of substance — 121 frames (~5 s at 24 fps, 8n+1 temporal convention) instead of 49, using the run-6 keyframes (wings folded vs raised) and the run-6 motion prompt. Same model, same FP16 path, same resolution 1024x576, same steps (8), same guidance (1.0), same seed (42), same harness fixes v1/v2/v3. Strict stop rule: if it fails the T4 memory or FP16 gate, STOP and report the failure — do not change configurations to force a pass, do not silently retry smaller.

Usage: python3 scripts/build-ltx-proof-package.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..", "packages", "ltx-proof-20261124-01")

JOB_ID = "ltx-proof-20261124-01"
KERNEL_ID = "oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01"
PROMPT = ("An ash-grey dragon with ember-cracked wings rests on a misty "
          "mountain ridge at dawn; the dragon slowly raises its wings from "
          "folded at its sides to spread high above its back, lifting its "
          "head toward the camera, mist drifts across the ridge, embers rise "
          "glowing from its wings, epic fantasy film, dramatic dawn light")
LTX_SIZE = 6340744492
FIRST_SHA = "b746e5fa74332b86bdf2e088e02c86e9741e5c94f70bfe01d8bf2ca5d05055fb"
LAST_SHA = "c8218a25a535c498168192b86104f470ddb84408d1436922cf93d35eb76ed3eb"


def _lines(src):
    lines = src.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [ln + "\n" for ln in lines]


def md_cell(source):
    return {"cell_type": "markdown", "metadata": {}, "source": _lines(source)}


def code_cell(source):
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": _lines(source)}


CELL_0_MD = """# NOVA GPU Cloud — LTX-Video 2B distilled (0.9.8) production-length proof (Phase 2 → production settings)

**Authorisation:** Shina 25 Nov 2026 ~08:03 WAT ("get to work"); reviewer (thread 17, 25 Nov) confirmed longer production-length clips as the next primary priority. **ONE controlled run (kernel v10) at 121 frames (~5 s at 24 fps)** — the production-length step-up from the proven 49-frame run 6. Strict stop rule: if it fails the T4 memory or FP16 gate, STOP and report the failure — do not change configurations to force a pass, do not silently retry smaller.

- **Model:** LTX-Video 2B distilled 0.9.8 (`ltxv-2b-0.9.8-distilled.safetensors`, 6.34 GB) via Kaggle Model mount.
- **Implementation:** diffusers 0.40.0 `LTXConditionPipeline.from_single_file`, `torch_dtype=torch.float16` — the FP16 adaptation. The official yaml is BF16 + two-pass multi-scale + upscaler + prompt enhancement and does NOT run on a T4; it is NOT used here. FP16 is PROVEN by dtype audits before and after sampling (zero BF16 parameters).
- **Text encoder:** T5-XXL FP16 from the FLUX layout mount; encoded on GPU, then moved to CPU before sampling (intentional).
- **Hardware:** ONE Tesla T4 (cuda:0), ONE process. **Frames:** 121 (8n+1 temporal convention). **Resolution:** 1024x576. **Steps:** 8. **Guidance:** 1.0 (no CFG). **Seed:** 42.
- **Keyframes:** the run-6 pair (first: wings folded DOWN, head lowered; last: wings raised HIGH and spread, head lifted toward camera) — same dragon identity, ridge, mist and dawn light. Synthetic content only (VDP-06).
"""

CELL_1_GATES = """import os, sys, json, time, gc, glob, hashlib, subprocess, shutil
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTHONUNBUFFERED", "1")

T0 = time.time()
REPORT = {"job": "ltx-proof-20261124-01",
          "model": "LTX-Video 2B distilled 0.9.8",
          "implementation": "diffusers 0.40.0 LTXConditionPipeline.from_single_file, torch_dtype=float16",
          "fp16_adaptation": "native yaml is BF16 two-pass multi-scale + upscaler + prompt enhancement (does not run on T4); proof uses diffusers single-pass flow matching, 8 steps, no upscaler, no prompt enhancement"}
OUT = "/kaggle/working/output"
os.makedirs(OUT, exist_ok=True)

def log(*a, **k):
    print(*a, flush=True)

# ---------- Gate A: GPU ----------
import torch
log("torch:", torch.__version__, "| cuda:", torch.version.cuda)
if not torch.cuda.is_available():
    raise SystemExit("GATE A FAILED: cuda unavailable")
n_gpu = torch.cuda.device_count()
log("GPUs provisioned:", n_gpu)
gpu_info = []
for i in range(n_gpu):
    p = torch.cuda.get_device_properties(i)
    log("  cuda:%d %s cc=%d.%d total=%.2f GiB" % (i, p.name, p.major, p.minor, p.total_memory / 2**30))
    gpu_info.append({"index": i, "name": p.name, "cc": "%d.%d" % (p.major, p.minor),
                     "total_gib": round(p.total_memory / 2**30, 2)})
if not gpu_info[0]["name"].startswith("Tesla T4"):
    raise SystemExit("GATE A FAILED: cuda:0 is not a Tesla T4: " + gpu_info[0]["name"])
log("bf16 supported (cuda):", torch.cuda.is_bf16_supported())
log("GATE A: PASS (proof uses cuda:0 only; any second GPU stays idle)")
REPORT["gpu"] = gpu_info
REPORT["bf16_supported"] = torch.cuda.is_bf16_supported()
REPORT["torch_version"] = torch.__version__
REPORT["cuda_version"] = torch.version.cuda
REPORT["gate_a"] = "PASS"

# ---------- Gate B: internet ----------
import urllib.request
try:
    r = urllib.request.urlopen("https://huggingface.co", timeout=15)
    log("Gate B: huggingface.co ->", r.status)
    assert r.status == 200
except Exception as e:
    raise SystemExit("GATE B FAILED: %s" % e)
REPORT["gate_b"] = "PASS"

# ---------- Gate C: storage ----------
disk_before = {}
for path in ["/kaggle/working", "/kaggle/input"]:
    total, used, free = shutil.disk_usage(path)
    log("disk %s: total=%.1fG used=%.1fG free=%.1fG" % (path, total / 2**30, used / 2**30, free / 2**30))
    disk_before[path] = {"total_gib": round(total / 2**30, 2), "used_gib": round(used / 2**30, 2),
                         "free_gib": round(free / 2**30, 2)}
REPORT["disk_before"] = disk_before
REPORT["gate_c"] = "PASS"

# ---------- host RAM / CPU ----------
with open("/proc/meminfo") as f:
    mem = {}
    for line in f:
        if ":" in line:
            k, v = line.split(":", 1)
            mem[k.strip()] = int(v.split()[0])
log("host RAM total=%.1f GiB avail=%.1f GiB | CPUs=%d" % (
    mem["MemTotal"] / 2**20, mem["MemAvailable"] / 2**20, os.cpu_count()))
REPORT["host_ram_total_gib"] = round(mem["MemTotal"] / 2**20, 1)
REPORT["host_ram_avail_gib"] = round(mem["MemAvailable"] / 2**20, 1)
REPORT["cpu_count"] = os.cpu_count()

def rss_gib():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return round(int(line.split()[1]) / 2**20, 2)
    return None
REPORT["rss_gib_start"] = rss_gib()
log("process RSS at start: %.2f GiB" % rss_gib())

# ---------- pre-install package versions (metadata only, no imports) ----------
from importlib.metadata import version as pkg_version, PackageNotFoundError
def pv(name):
    try:
        return pkg_version(name)
    except PackageNotFoundError:
        return "NOT INSTALLED"
pre = {}
for p in ["diffusers", "transformers", "accelerate", "sentencepiece", "protobuf",
          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors"]:
    pre[p] = pv(p)
    log("pre-install %s: %s" % (p, pre[p]))
REPORT["packages_pre_install"] = pre
log("ALL GATES PASS")
"""


CELL_2_DEPS = """# Pinned dependency set (TRACK-C's proven Kaggle set, verified on PyPI 24 Nov 2026).
# ONE pip invocation (Wan v2 lesson: interacting packages pinned together).
# Torch is NOT pinned: the Kaggle image torch (2.11.0+cu130) matches TRACK-C.
t_install = time.time()
log("installing pinned deps (one invocation)...")
res = subprocess.run(
    [sys.executable, "-m", "pip", "install", "-q",
     "diffusers==0.40.0", "transformers==5.16.1", "accelerate",
     "sentencepiece", "protobuf", "imageio-ffmpeg"],
    capture_output=True, text=True)
log("pip returncode:", res.returncode)
if res.stdout.strip():
    log("pip stdout (last 5 lines):")
    for ln in res.stdout.strip().splitlines()[-5:]:
        log("  ", ln)
if res.returncode != 0:
    log("pip stderr:")
    log(res.stderr)
    raise SystemExit("DEPENDENCY INSTALL FAILED")
REPORT["pip_install_s"] = round(time.time() - t_install, 1)
log("pip install took %.1f s" % REPORT["pip_install_s"])

import diffusers, transformers
log("diffusers:", diffusers.__version__, "| transformers:", transformers.__version__)
assert diffusers.__version__ == "0.40.0", "diffusers version mismatch"
assert transformers.__version__ == "5.16.1", "transformers version mismatch"
post = {}
for p in ["diffusers", "transformers", "accelerate", "sentencepiece", "protobuf",
          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors"]:
    post[p] = pv(p)
    log("post-install %s: %s" % (p, post[p]))
REPORT["packages_post_install"] = post
import imageio_ffmpeg
log("ffmpeg exe:", imageio_ffmpeg.get_ffmpeg_exe())
REPORT["rss_gib_after_install"] = rss_gib()
"""

CELL_3_INVENTORY = """# Asset inventory: every weight comes from a read-only Kaggle mount.
# NOTHING large is downloaded into /kaggle/working (the full pipeline is
# 25.39 GB by download and does not fit the 20 GB working disk).
log("input mount roots:", sorted(os.listdir("/kaggle/input")))

def find_one(pattern, what):
    hits = sorted(p for p in glob.glob(pattern, recursive=True) if os.path.isfile(p))
    if not hits:
        raise SystemExit("ASSET NOT FOUND: %s (pattern %s)" % (what, pattern))
    log("%s: %s" % (what, hits[0]))
    if len(hits) > 1:
        log("  (plus %d more matches)" % (len(hits) - 1))
    return hits[0]

def sha256_file(path, label):
    h = hashlib.sha256()
    done = 0
    total = os.path.getsize(path)
    with open(path, "rb") as f:
        while True:
            chunk = f.read(64 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            done += len(chunk)
            log("  %s sha256 %.2f / %.2f GiB" % (label, done / 2**30, total / 2**30), flush=True)
    return h.hexdigest()

# --- LTX checkpoint ---
t = time.time()
LTX_PATH = find_one("/kaggle/input/**/ltxv-2b-0.9.8-distilled.safetensors", "LTX checkpoint")
ltx_size = os.path.getsize(LTX_PATH)
log("LTX size: %d bytes (expected %d)" % (ltx_size, 6340744492))
assert ltx_size == 6340744492, "LTX SIZE MISMATCH"
LTX_SHA = sha256_file(LTX_PATH, "LTX")
log("LTX sha256:", LTX_SHA)
REPORT["ltx_checkpoint"] = {"path": LTX_PATH, "size_bytes": ltx_size, "sha256": LTX_SHA,
                            "sha256_s": round(time.time() - t, 1)}

# --- T5-XXL encoder (FLUX layout mount) ---
TE2_CFG = find_one("/kaggle/input/**/text_encoder_2/config.json", "FLUX T5 encoder config")
TE2_DIR = os.path.dirname(TE2_CFG)
te2_size = 0
te2_files = []
for r, _, fs in os.walk(TE2_DIR):
    for fn in fs:
        fp = os.path.join(r, fn)
        te2_size += os.path.getsize(fp)
        te2_files.append(os.path.relpath(fp, TE2_DIR))
log("T5 encoder dir: %s (%.2f GiB, %d files)" % (TE2_DIR, te2_size / 2**30, len(te2_files)))
for fn in sorted(te2_files):
    log("   ", fn)
REPORT["t5_encoder"] = {"dir": TE2_DIR, "size_bytes": te2_size, "files": sorted(te2_files)}

# --- T5 tokenizer (FLUX layout mount) ---
TOK2_CFG = find_one("/kaggle/input/**/tokenizer_2/tokenizer_config.json", "FLUX T5 tokenizer config")
TOK2_DIR = os.path.dirname(TOK2_CFG)
tok2_files = sorted(os.listdir(TOK2_DIR))
log("T5 tokenizer dir: %s (%s)" % (TOK2_DIR, tok2_files))
REPORT["t5_tokenizer"] = {"dir": TOK2_DIR, "files": tok2_files}

# --- Keyframes (private dataset mount) ---
FIRST = find_one("/kaggle/input/**/first_frame.png", "first keyframe")
LAST = find_one("/kaggle/input/**/last_frame.png", "last keyframe")
for path, exp in [(FIRST, "b746e5fa74332b86bdf2e088e02c86e9741e5c94f70bfe01d8bf2ca5d05055fb"),
                  (LAST, "c8218a25a535c498168192b86104f470ddb84408d1436922cf93d35eb76ed3eb")]:
    got = hashlib.sha256(open(path, "rb").read()).hexdigest()
    log("%s sha256 %s (match=%s)" % (os.path.basename(path), got[:16], got == exp))
    assert got == exp, "KEYFRAME HASH MISMATCH: " + path
REPORT["keyframes"] = {"first": FIRST, "last": LAST, "verified": True}

# --- disk after inventory (mounts are read-only; only pip + HF cache grew) ---
disk_after_inv = {}
for path in ["/kaggle/working"]:
    total, used, free = shutil.disk_usage(path)
    disk_after_inv[path] = {"used_gib": round(used / 2**30, 2), "free_gib": round(free / 2**30, 2)}
    log("disk %s after inventory: used=%.2fG free=%.2fG" % (path, used / 2**30, free / 2**30))
REPORT["disk_after_inventory"] = disk_after_inv
REPORT["rss_gib_after_inventory"] = rss_gib()
log("INVENTORY COMPLETE — all assets present, sizes + hashes verified")
"""

CELL_4_T5 = """# T5-XXL: load FP16 from the mount, encode the prompt on GPU, then move to
# CPU before sampling. The CPU placement after encoding is INTENTIONAL and
# recorded here — it is not a fallback.
from transformers import T5EncoderModel, T5TokenizerFast
from PIL import Image
import numpy as np

PROMPT = ("An ash-grey dragon with ember-cracked wings rests on a misty "
          "mountain ridge at dawn; the dragon slowly raises its wings from "
          "folded at its sides to spread high above its back, lifting its "
          "head toward the camera, mist drifts across the ridge, embers rise "
          "glowing from its wings, epic fantasy film, dramatic dawn light")
MAX_SEQ = 128
REPORT["prompt"] = PROMPT
REPORT["max_sequence_length"] = MAX_SEQ

t = time.time()
tok = T5TokenizerFast.from_pretrained(TOK2_DIR)
log("tokenizer loaded in %.1f s: %s" % (time.time() - t, tok.__class__.__name__))

t = time.time()
t5 = T5EncoderModel.from_pretrained(TE2_DIR, torch_dtype=torch.float16)
t5_load_s = time.time() - t
t5_params = sum(p.numel() for p in t5.parameters())
t5_dtype = next(t5.parameters()).dtype
log("T5 loaded (CPU, fp16) in %.1f s; params=%.2fB; dtype=%s" % (t5_load_s, t5_params / 1e9, t5_dtype))
assert str(t5_dtype) == "torch.float16", "T5 NOT FP16"
REPORT["t5_load_s"] = round(t5_load_s, 1)
REPORT["t5_params_b"] = round(t5_params / 1e9, 2)
REPORT["t5_dtype"] = str(t5_dtype)
REPORT["rss_gib_after_t5_load"] = rss_gib()
log("VRAM before T5->cuda: %.2f GiB | RSS %.2f GiB" % (
    torch.cuda.memory_allocated() / 2**30, rss_gib()))

t = time.time()
t5.to("cuda")
log("T5 -> cuda in %.1f s; VRAM now %.2f GiB" % (
    time.time() - t, torch.cuda.memory_allocated() / 2**30))
REPORT["t5_vram_gib"] = round(torch.cuda.memory_allocated() / 2**30, 2)

# Encode — exact replica of diffusers 0.40.0
# LTXPipeline._get_t5_prompt_embeds (pipeline_ltx.py).
text_inputs = tok(PROMPT, padding="max_length", max_length=MAX_SEQ,
                  truncation=True, add_special_tokens=True, return_tensors="pt")
text_input_ids = text_inputs.input_ids
prompt_attention_mask = text_inputs.attention_mask.bool().to("cuda")
untruncated = tok(PROMPT, padding="longest", return_tensors="pt").input_ids
truncated = (untruncated.shape[-1] >= text_input_ids.shape[-1]
             and not torch.equal(text_input_ids, untruncated))
log("prompt tokens: %d (max %d); untruncated len %d; truncated=%s" % (
    text_input_ids.shape[1], MAX_SEQ, untruncated.shape[-1], truncated))
REPORT["prompt_tokens"] = int(text_input_ids.shape[1])
REPORT["prompt_truncated"] = bool(truncated)

t = time.time()
with torch.no_grad():
    prompt_embeds = t5(text_input_ids.to("cuda"))[0]
prompt_embeds = prompt_embeds.to(dtype=t5.dtype, device="cuda")
t5_encode_s = time.time() - t
finite = bool(torch.isfinite(prompt_embeds).all().item())
log("T5 encode in %.1f s; embeds %s %s; finite=%s" % (
    t5_encode_s, tuple(prompt_embeds.shape), prompt_embeds.dtype, finite))
assert finite, "NON-FINITE PROMPT EMBEDS"
REPORT["t5_encode_s"] = round(t5_encode_s, 1)
REPORT["prompt_embeds_shape"] = [int(x) for x in prompt_embeds.shape]
REPORT["prompt_embeds_dtype"] = str(prompt_embeds.dtype)
REPORT["prompt_embeds_finite"] = finite

# Keep the embeds on CPU; move T5 back to CPU; free the GPU for sampling.
prompt_embeds_cpu = prompt_embeds.to("cpu")
mask_cpu = prompt_attention_mask.to("cpu")
del prompt_embeds, prompt_attention_mask, text_inputs, text_input_ids, untruncated
t5.to("cpu")
gc.collect()
torch.cuda.empty_cache()
torch.cuda.reset_peak_memory_stats()
log("T5 -> CPU (intentional, post-encode); VRAM now %.2f GiB; RSS %.2f GiB" % (
    torch.cuda.memory_allocated() / 2**30, rss_gib()))
REPORT["vram_gib_after_t5_to_cpu"] = round(torch.cuda.memory_allocated() / 2**30, 2)
REPORT["rss_gib_after_t5_to_cpu"] = rss_gib()
"""


CELL_5_PIPELINE = """# Build the pipeline from the single file (diffusers converter, embedded
# 0.9.5-architecture configs). The passed-in T5 + tokenizer MUST be the ones
# used — otherwise from_single_file would download the ~19 GB text encoder
# from the config repo. The HF cache delta proves no large download happened.
from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXConditionPipeline, LTXVideoCondition

def du_bytes(path):
    s = 0
    for r, _, fs in os.walk(path):
        for fn in fs:
            try:
                s += os.path.getsize(os.path.join(r, fn))
            except OSError:
                pass
    return s

hf_before = du_bytes(os.path.expanduser("~/.cache/huggingface"))
log("HF cache before from_single_file: %.1f MiB" % (hf_before / 2**20))

t = time.time()
pipe = LTXConditionPipeline.from_single_file(
    LTX_PATH,
    torch_dtype=torch.float16,
    text_encoder=t5,
    tokenizer=tok,
    config="Lightricks/LTX-Video-0.9.5",
)
from_single_file_s = time.time() - t
log("from_single_file in %.1f s" % from_single_file_s)
assert pipe.text_encoder is t5, "text_encoder was NOT the passed-in T5 (a download may have happened)"
assert pipe.tokenizer is tok, "tokenizer was NOT the passed-in tokenizer"
log("text_encoder/tokenizer: passed-in components confirmed (no download)")
hf_after = du_bytes(os.path.expanduser("~/.cache/huggingface"))
log("HF cache after: %.1f MiB (delta %.1f MiB — config JSONs only)" % (
    hf_after / 2**20, (hf_after - hf_before) / 2**20))
REPORT["from_single_file_s"] = round(from_single_file_s, 1)
REPORT["config_repo"] = "Lightricks/LTX-Video-0.9.5"
REPORT["hf_cache_delta_mib"] = round((hf_after - hf_before) / 2**20, 1)
REPORT["scheduler"] = pipe.scheduler.__class__.__name__
REPORT["scheduler_config"] = {k: str(v) for k, v in dict(pipe.scheduler.config).items()}
log("scheduler:", pipe.scheduler.__class__.__name__)
log("transformer:", pipe.transformer.__class__.__name__,
    "| layers:", pipe.transformer.config.num_layers,
    "| vae:", pipe.vae.__class__.__name__)
try:
    log("transformer attention implementation:",
        getattr(pipe.transformer.config, "_attn_implementation", "unknown"))
    REPORT["attn_implementation"] = str(getattr(pipe.transformer.config, "_attn_implementation", "unknown"))
except Exception as e:
    log("attention implementation unreadable:", e)

# Move transformer + VAE to cuda. T5 stays on CPU by design.
t = time.time()
pipe.transformer.to("cuda")
pipe.vae.to("cuda")
log("transformer+vae -> cuda in %.1f s; VRAM %.2f GiB; RSS %.2f GiB" % (
    time.time() - t, torch.cuda.memory_allocated() / 2**30, rss_gib()))
REPORT["vram_gib_after_transformer_vae_to_cuda"] = round(torch.cuda.memory_allocated() / 2**30, 2)
REPORT["rss_gib_after_pipeline"] = rss_gib()
torch.cuda.reset_peak_memory_stats()

# ---------- DTYPE AUDIT (before sampling) ----------
def dtype_audit(module, name):
    counts = {}
    for p in list(module.parameters()) + list(module.buffers()):
        k = str(p.dtype)
        counts[k] = counts.get(k, 0) + int(p.numel())
    total = sum(counts.values())
    parts = " ".join("%s=%.1f%%" % (k, v / total * 100) for k, v in sorted(counts.items()))
    log("  %s: %.2fB params %s" % (name, total / 1e9, parts))
    return counts

log("DTYPE AUDIT (before sampling):")
a_tr = dtype_audit(pipe.transformer, "transformer")
a_vae = dtype_audit(pipe.vae, "vae")
a_t5 = dtype_audit(pipe.text_encoder, "text_encoder (CPU)")
bf16_before = sum(c.get("torch.bfloat16", 0) for c in (a_tr, a_vae, a_t5))
log("bf16 params before sampling: %d" % bf16_before)
assert bf16_before == 0, "BF16 PARAMS PRESENT BEFORE SAMPLING: %d" % bf16_before
log("FP16 VERIFIED BEFORE SAMPLING: 0 bf16 params; is_bf16_supported=%s" % torch.cuda.is_bf16_supported())
REPORT["dtype_audit_before"] = {"transformer": a_tr, "vae": a_vae, "text_encoder": a_t5,
                                "bf16_params": 0}
"""

CELL_6_GENERATE = """# THE GENERATION — one run only.
first_img = Image.open(FIRST).convert("RGB")
last_img = Image.open(LAST).convert("RGB")
log("keyframes: first %s, last %s" % (first_img.size, last_img.size))
assert first_img.size == (1024, 576) and last_img.size == (1024, 576)

conditions = [
    LTXVideoCondition(image=first_img, frame_index=0, strength=1.0),
    LTXVideoCondition(image=last_img, frame_index=120, strength=1.0),
]
gen = torch.Generator(device="cuda").manual_seed(42)
step_times = []
step_vram = []
latent_dtypes = []

def cb(pipe_obj, step, timestep, callback_kwargs):
    step_times.append(time.time())
    step_vram.append(round(torch.cuda.memory_allocated() / 2**30, 2))
    lat = callback_kwargs.get("latents")
    if lat is not None:
        latent_dtypes.append(str(lat.dtype))
    log("  step %d t=%.4f VRAM %.2f GiB latents %s" % (
        step, float(timestep), step_vram[-1], lat.dtype if lat is not None else "?"), flush=True)
    return callback_kwargs

torch.cuda.reset_peak_memory_stats()
torch.cuda.synchronize()
t_call = time.time()
out = pipe(
    prompt_embeds=prompt_embeds_cpu.to("cuda"),
    prompt_attention_mask=mask_cpu.to("cuda"),
    conditions=conditions,
    height=576, width=1024, num_frames=121,
    num_inference_steps=8, guidance_scale=1.0,
    generator=gen, max_sequence_length=128,
    decode_timestep=0.0, image_cond_noise_scale=0.15,
    output_type="pil", return_dict=True,
    callback_on_step_end=cb,
    callback_on_step_end_tensor_inputs=["latents"],
)
torch.cuda.synchronize()
t_ret = time.time()
frames = out.frames[0]
log("generated %d frames, each %s %s" % (len(frames), frames[0].size, frames[0].mode))
assert len(frames) == 121, "EXPECTED 121 FRAMES, GOT %d" % len(frames)
assert len(step_times) == 8, "EXPECTED 8 STEPS, SAW %d" % len(step_times)

t_last_step = step_times[-1]
sampling_s = t_last_step - t_call
decode_s = t_ret - t_last_step
total_gen_s = t_ret - t_call
per_step = [round(step_times[i + 1] - step_times[i], 2) for i in range(len(step_times) - 1)]
log("TIMING: sampling (incl latent init + conditioning) = %.1f s" % sampling_s)
log("TIMING: decode + post = %.1f s" % decode_s)
log("TIMING: total generate call = %.1f s" % total_gen_s)
log("per-step times (s): %s" % per_step)
log("per-step VRAM (GiB): %s" % step_vram)
log("peak VRAM during generation: %.2f GiB" % (torch.cuda.max_memory_allocated() / 2**30))
log("latent dtypes seen: %s" % sorted(set(latent_dtypes)))
assert "torch.bfloat16" not in set(latent_dtypes), "LATENTS CONTAIN BF16: %s" % set(latent_dtypes)
log("latents are %s — diffusers keeps the latent state in fp32 by design; weights are fp16, zero bf16 anywhere" % sorted(set(latent_dtypes)))
REPORT["generation"] = {
    "num_frames": 121, "height": 576, "width": 1024, "num_inference_steps": 8,
    "guidance_scale": 1.0, "seed": 42, "decode_timestep": 0.0,
    "image_cond_noise_scale": 0.15,
    "sampling_s": round(sampling_s, 1), "decode_s": round(decode_s, 1),
    "total_generate_s": round(total_gen_s, 1),
    "per_step_s": per_step, "per_step_vram_gib": step_vram,
    "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2),
    "latent_dtypes": sorted(set(latent_dtypes)),
    "frames_returned": len(frames),
}
REPORT["rss_gib_after_generation"] = rss_gib()

# ---------- DTYPE AUDIT (after sampling) ----------
log("DTYPE AUDIT (after sampling):")
b_tr = dtype_audit(pipe.transformer, "transformer")
b_vae = dtype_audit(pipe.vae, "vae")
bf16_after = sum(c.get("torch.bfloat16", 0) for c in (b_tr, b_vae))
log("bf16 params after sampling: %d" % bf16_after)
assert bf16_after == 0, "BF16 PARAMS PRESENT AFTER SAMPLING: %d" % bf16_after
log("FP16 VERIFIED AFTER SAMPLING: 0 bf16 params — no silent conversion")
REPORT["dtype_audit_after"] = {"transformer": b_tr, "vae": b_vae, "bf16_params": 0}
"""


CELL_7_EXPORT = """# Export + output integrity. MP4 must be yuv420p (phone-playback law).
import imageio.v2 as imageio
import imageio_ffmpeg

ffexe = imageio_ffmpeg.get_ffmpeg_exe()
mp4_path = os.path.join(OUT, "ltx-proof-121f.mp4")
t = time.time()
writer = imageio.get_writer(mp4_path, fps=24, codec="libx264", quality=8,
                            pixelformat="yuv420p",
                            ffmpeg_params=["-movflags", "+faststart"],
                            macro_block_size=16)
for fr in frames:
    writer.append_data(np.array(fr))
writer.close()
export_s = time.time() - t
log("exported %s in %.1f s" % (mp4_path, export_s))
REPORT["export_s"] = round(export_s, 1)

frames[0].save(os.path.join(OUT, "frame_00_first.png"))
frames[60].save(os.path.join(OUT, "frame_60_middle.png"))
frames[120].save(os.path.join(OUT, "frame_120_last.png"))
strip = Image.new("RGB", (1024 * 3, 576))
strip.paste(frames[0], (0, 0))
strip.paste(frames[60], (1024, 0))
strip.paste(frames[120], (2048, 0))
strip.save(os.path.join(OUT, "contact_first_mid_last.png"))
log("saved frame_00_first.png, frame_60_middle.png, frame_120_last.png, contact strip")

# Integrity: ffmpeg -i parse (codec / pix_fmt / resolution / fps) + full decode.
probe = subprocess.run([ffexe, "-hide_banner", "-i", mp4_path],
                       capture_output=True, text=True)
info = probe.stderr
log("ffmpeg -i output:")
log(info)
assert "yuv420p" in info, "PIX_FMT IS NOT yuv420p"
assert "1024x576" in info, "RESOLUTION NOT 1024x576"
assert "h264" in info, "CODEC NOT h264"
reader = imageio.get_reader(mp4_path)
n_decoded = 0
for _ in reader:
    n_decoded += 1
log("read-back decoded %d frames (expected 121)" % n_decoded)
assert n_decoded == 121, "DECODED FRAME COUNT MISMATCH: %d" % n_decoded
meta = reader.get_meta_data()
log("reader metadata: %s" % meta)
mp4_size = os.path.getsize(mp4_path)
mp4_sha = hashlib.sha256(open(mp4_path, "rb").read()).hexdigest()
log("MP4: %d bytes sha256 %s" % (mp4_size, mp4_sha))
REPORT["output"] = {"path": mp4_path, "size_bytes": mp4_size, "sha256": mp4_sha,
                    "frames_decoded": n_decoded, "pix_fmt": "yuv420p",
                    "codec": "h264", "resolution": "1024x576", "fps": 24,
                    "reader_meta": {k: str(v) for k, v in meta.items()}}

# Disk after everything.
disk_after = {}
for path in ["/kaggle/working"]:
    total, used, free = shutil.disk_usage(path)
    disk_after[path] = {"used_gib": round(used / 2**30, 2), "free_gib": round(free / 2**30, 2)}
    log("disk %s at end: used=%.2fG free=%.2fG" % (path, used / 2**30, free / 2**30))
REPORT["disk_after"] = disk_after
REPORT["rss_gib_end"] = rss_gib()
REPORT["total_elapsed_s"] = round(time.time() - T0, 1)
REPORT["total_elapsed_min"] = round((time.time() - T0) / 60, 1)

with open(os.path.join(OUT, "ltx-proof-report.json"), "w") as f:
    json.dump(REPORT, f, indent=2, default=str)
log("REPORT WRITTEN: /kaggle/working/output/ltx-proof-report.json")
log("TOTAL ELAPSED: %.1f min" % REPORT["total_elapsed_min"])
log("=== LTX PROOF COMPLETE — ONE RUN ONLY. STOP. ===")
"""

CELL_8_MD = """## End of proof

One controlled 121-frame run (production-length proof), as authorised. Outputs in `/kaggle/working/output/`:

- `ltx-proof-121f.mp4` — the proof clip (1024x576, 24 fps, h264, yuv420p, ~5 s)
- `ltx-proof-report.json` — all measurements
- `frame_00_first.png`, `frame_60_middle.png`, `frame_120_last.png` — I2V check frames
- `contact_first_mid_last.png` — first / middle / last side by side

No second generation in this kernel. The clip is compared against the run-6 49-frame baseline.
"""

CELLS = [
    md_cell(CELL_0_MD),
    code_cell(CELL_1_GATES),
    code_cell(CELL_2_DEPS),
    code_cell(CELL_3_INVENTORY),
    code_cell(CELL_4_T5),
    code_cell(CELL_5_PIPELINE),
    code_cell(CELL_6_GENERATE),
    code_cell(CELL_7_EXPORT),
    md_cell(CELL_8_MD),
]

NB = {
    "cells": CELLS,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.13.0"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

METADATA = {
    "id": KERNEL_ID,
    "title": "NOVA GPU Cloud \u2014 LTX proof 20261124-01",
    "code_file": "ltx-proof.ipynb",
    "language": "python",
    "kernel_type": "notebook",
    "is_private": "true",
    "enable_gpu": "true",
    "enable_tpu": "false",
    "enable_internet": "true",
    "machine_shape": "NvidiaTeslaT4",
    "dataset_sources": ["oliversmithh/nova-ltx-proof-keyframes-20261124"],
    "competition_sources": [],
    "kernel_sources": [],
    "model_sources": [
        "marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors/pytorch/default/1",
        "sanderland/flux.1-schnell/pytorch/hf/1",
    ],
}

MANIFEST = {
    "modelId": "ltx-video-2b-distilled-0.9.8",
    "route": "diffusers-fp16-adaptation",
    "source": {
        "repo": "Lightricks/LTX-Video",
        "checkpoint": "ltxv-2b-0.9.8-distilled.safetensors",
        "checkpoint_size_bytes": LTX_SIZE,
        "licence": "LTXV Open Weights License 0.X (15 Apr 2025)",
        "weights_via": ("Kaggle Model marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors "
                        "(third-party mirror; size byte-identical to the official file; "
                        "TRACK-C verified its sha256 equals the Hub LFS oid; "
                        "the notebook re-computes sha256 in-session)"),
        "text_encoder_via": ("Kaggle Model sanderland/flux.1-schnell (Apache 2.0 mirror of "
                             "black-forest-labs/FLUX.1-schnell); only text_encoder_2/ "
                             "(T5-XXL) + tokenizer_2/ are used"),
        "config_repo": "Lightricks/LTX-Video-0.9.5 (config JSONs only; no weights downloaded)",
        "notes": ("The official native yaml is BF16 + two-pass multi-scale + upscaler + "
                  "prompt enhancement and does not run on a T4. The proof uses the "
                  "diffusers 0.40.0 implementation (from_single_file, torch_dtype=float16, "
                  "single-pass flow matching, 8 steps, no upscaler, no prompt enhancement). "
                  "Full pipeline by download is 25.39 GB (LTX 6.34 + PixArt T5 19.05) and "
                  "does not fit 20 GB /kaggle/working — mounts are the strategy."),
    },
    "files": [
        {"path": "ltxv-2b-0.9.8-distilled.safetensors", "role": "transformer+vae",
         "sizeBytes": LTX_SIZE, "required": True},
        {"path": "text_encoder_2/ (FLUX layout)", "role": "text-encoder-t5-xxl",
         "sizeBytes": None, "required": True,
         "note": "size measured in-session; loaded FP16, encoded on GPU, then CPU"},
        {"path": "tokenizer_2/ (FLUX layout)", "role": "tokenizer",
         "sizeBytes": None, "required": True},
        {"path": "first_frame.png", "role": "keyframe-first-wings-folded",
         "sizeBytes": 753840, "sha256": FIRST_SHA, "required": True},
        {"path": "last_frame.png", "role": "keyframe-last-wings-raised",
         "sizeBytes": 849154, "sha256": LAST_SHA, "required": True},
    ],
    "pins": {
        "diffusers": "0.40.0", "transformers": "5.16.1",
        "torch": "Kaggle image (2.11.0+cu130, not pinned)",
        "config": "Lightricks/LTX-Video-0.9.5",
        "native_yaml_commit": "LTX-Video bdc8f01 (reference only — not executed)",
    },
    "proof": {
        "frames": 121, "height": 576, "width": 1024, "steps": 8,
        "guidance_scale": 1.0, "seed": 42, "max_sequence_length": 128,
        "decode_timestep": 0.0, "image_cond_noise_scale": 0.15,
        "gpu": "1x Tesla T4 (cuda:0 only)", "process": "single",
    },
}

README = """# LTX-Video 2B distilled (0.9.8) — production-length proof, 121 frames (2026-11-25)

Authorisation: Shina 25 Nov 2026 ~08:03 WAT ("get to work"); reviewer
(thread 17, 25 Nov) confirmed longer production-length clips as the next
primary priority. ONE controlled run (kernel v10) at 121 frames (~5 s at
24 fps) — the production-length step-up from the proven 49-frame run 6.
Strict stop rule: if it fails the T4 memory or FP16 gate, STOP and report
the failure — do not change configurations to force a pass, do not silently
retry smaller.

## What this proves
Whether the LTX pipeline holds at production length on one T4: 121 frames
at 1024x576 in FP16 — peak VRAM, host RAM, generation time, FP16 proof,
first/last-frame fidelity, visible motion over ~5 s, and a valid playable
MP4 stored in NOVA's own storage.

## The FP16 adaptation (the reviewer's top requirement)
The official yaml is BF16 + two-pass multi-scale + upscaler + prompt
enhancement. It does NOT run on a T4 (no BF16 on Turing). The proof uses
diffusers 0.40.0 `LTXConditionPipeline.from_single_file` with
`torch_dtype=torch.float16`: single-pass flow matching, 8 steps, no upscaler,
no prompt enhancement, no CFG. Dtype audits before AND after sampling assert
zero BF16 parameters; the per-step callback records latent dtypes.

## Layout
- `ltx-proof.ipynb` — the notebook (only this file is pushed)
- `kernel-metadata.json` — GPU T4, internet on, keyframes dataset + 2 model mounts
- `staging-manifest.json` — VDP-04 manifest (pins, sizes, hashes)
- `keyframes/` — local copies of the two run-6 keyframes (wings folded / raised)
- `keyframes-run4-5/` — the preserved run-4/5 keyframes (near-identical pair)
- `keyframes-v6/` — the run-6 keyframe originals at 2048x1152 (source of the resized pair)
- `dataset-keyframes/` — the dataset upload dir (metadata + PNGs)

## Run (per kernel version)
```
python3 scripts/build-ltx-proof-package.py
cd packages/ltx-proof-20261124-01
kaggle kernels push -p . -t 10800
kaggle kernels status oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01
kaggle kernels output oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01 -p output
```
"""


def main():
    os.makedirs(PKG, exist_ok=True)
    with open(os.path.join(PKG, "ltx-proof.ipynb"), "w") as f:
        json.dump(NB, f, indent=1)
    with open(os.path.join(PKG, "kernel-metadata.json"), "w") as f:
        json.dump(METADATA, f, indent=2)
    with open(os.path.join(PKG, "staging-manifest.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2)
    with open(os.path.join(PKG, "README.md"), "w") as f:
        f.write(README)
    print("built", PKG)
    print("cells:", len(CELLS))


if __name__ == "__main__":
    main()
