#!/usr/bin/env python3
"""Build the NOVA GPU Cloud Wan2.1-Fun-1.3B-InP one-clip proof package.

Writes gpu-cloud/packages/fun-inp-proof-20261125-01/:
  fun-inp-proof.ipynb    — the self-contained notebook (only this file is sent on push)
  kernel-metadata.json   — kernel metadata (GPU T4 via machine_shape, internet on,
                           keyframes dataset + umT5-XXL FP16 Kaggle Model mount)
  staging-manifest.json  — the VDP-04 staging manifest
  README.md              — runbook

Authorisation: Shina 25 Nov 2026 ~07:46 WAT ("connect to those engine you
found"); reviewer 25 Nov 2026 (morning, thread 17): "ONE controlled Kaggle
proof" of Fun-InP, "strict stop if it fails the T4 memory/FP16 gate", "must
not delay LTX longer-clip work". ONE RUN ONLY. Stop after the first output
(success or failure). Do NOT run any other engine proof.

Design (all verified 25 Nov 2026 against the real sources, not the plan):
  - Engine: Wan2.1-Fun-1.3B-InP (V1.1 refresh), Alibaba PAI, Apache 2.0 —
    the only true first+last-frame I2V at 1.3B with a clean licence.
    Official repo alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP.
  - THE FP16 QUESTION (the whole proof): Wan-family models are BF16-native
    and a T4 (Turing CC 7.5) has no BF16 tensor cores. The proof establishes
    whether Fun-InP loads AND executes in FP16, or fails. Dtype audits
    before AND after sampling assert ZERO bf16 parameters across
    transformer + VAE + CLIP image encoder + text encoder, and the
    per-step callback records latent dtypes.
  - Pipeline: VideoX-Fun WanFunInpaintPipeline (native, pinned commit
    98fffa929bb373edcbfa3620e9aa05cd65a53103, 2026-11-24). NOT the
    diffusers WanImageToVideoPipeline: the conversion's model_index.json
    declares it, but the standard pipeline builds 32 channels and cannot
    drive the 36-channel InP transformer (16 noise + 4 mask + 16
    masked-video). Scheduler: diffusers FlowMatchEulerDiscreteScheduler
    (as the ComfyUI Fun loader constructs it).
  - Weights: transformer + VAE + CLIP image encoder + tokenizer from the
    diffusers conversion weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers, via a
    SCOPED huggingface_hub download (transformer/ + vae/ +
    image_encoder/ + tokenizer/ + scheduler/ + model_index.json only;
    ~4.9 GB). The conversion's text_encoder is 22.5 GB FP32 — too big to
    download; NOT used. Verified by safetensors-header Range reads 25 Nov:
    transformer 3.13 GB / 1,013 tensors ALL BF16, in_channels 36; VAE
    0.48 GB / 194 tensors ALL F32; image_encoder 1.26 GB / 520 tensors
    ALL BF16.
  - Text encoder: umT5-XXL as transformers UMT5EncoderModel, weights from
    Kaggle Model thiminhnht/umt5-xxl-fp16 (single file
    umt5_xxl_fp16.safetensors, 11.37 GB, 243 tensors ALL F16, keys in
    transformers format — verified via the Kaggle API 25 Nov). Mounted
    read-only, zero disk. CORRECTION (v4, 25 Nov): the file's keys are 242
    real weights + a U8 spiece_model (the SentencePiece model bytes packed
    into the weights file, not a parameter); the canonical conversion index
    stores the embedding as shared.weight only, and transformers
    UMT5EncoderModel builds BOTH self.shared and self.encoder.embed_tokens,
    tied — so the notebook must call t5.tie_weights() after load_state_dict
    (v5 fix) or the tied alias stays randomly initialised. DISCLOSED
    SUBSTITUTION: the native pipeline
    expects its custom WanT5EncoderModel class; the proof loads the SAME
    umT5-XXL weights into transformers' UMT5EncoderModel instead, because
    the native class's parameter names differ from the checkpoint's
    transformers-format keys and a remap could not be verified without the
    weights in hand. Same weights, same architecture, same FP16
    arithmetic; the native pipeline only calls
    text_encoder(input_ids, attention_mask)[0] and reads .dtype, both of
    which UMT5EncoderModel satisfies. The native class's fp16_clamp
    safety net is absent in the transformers class — the notebook checks
    the embeddings for inf/NaN and records it as a finding.
  - Precomputed prompt_embeds are NOT passed: the native __call__ does
    `in_prompt_embeds = negative_prompt_embeds + prompt_embeds`, which
    is list concatenation for internally-encoded embeds but ELEMENT-WISE
    ADDITION for directly-passed tensors — the precomputed-embeds path
    is broken in this native pipeline. The proof calls the pipeline with
    prompt= (string) + negative_prompt="" so encode_prompt runs the text
    encoder internally. Consequence: the encoder must be on the
    execution device during the call, so the notebook enables diffusers
    model CPU offload (text encoder on CPU except while encoding;
    transformer + VAE + CLIP on GPU during denoising). All four modules
    resident would be 16.24 GB > the 15.36 GB T4.
  - Hardware: ONE Tesla T4 (cuda:0 only), ONE process. Kaggle provisions
    2 T4s per session; cuda:1 is recorded as provisioned-but-unused.
  - Input: the SAME dragon keyframes as LTX run 6 (first sha256
    b746e5fa..., last c8218a25...) — the dataset now serves run-6
    keyframes (v2 fix: the v1 script asserted the run-4/5 hashes), same
    run-6 prompt, 17 frames,
    1024x576, seed 42 — for comparability. 50 steps, guidance 6.0
    (native default). Keyframes via the private Kaggle dataset
    oliversmithh/nova-ltx-proof-keyframes-20261124.
  - Pins: diffusers==0.40.0, transformers==5.16.1, plus accelerate,
    sentencepiece, protobuf, imageio-ffmpeg, einops, safetensors,
    huggingface-hub — installed in ONE pip invocation (Wan v2 lesson:
    interacting packages pinned together). Torch is NOT pinned (Kaggle
    image torch 2.11.0+cu130). No bitsandbytes.
  - First code cell is the three-gate smoke check (Gate A GPU, Gate B
    internet, Gate C storage) with FAIL-FAST exit — a CPU fallback NEVER
    reaches model work. Every long cell prints progress with flush=True.
  - If any gate, load, or dtype audit fails, the notebook raises
    SystemExit with the exact blocker and stops. No workarounds in-run.

v7 (25 Nov 2026 ~13:18-13:40) — key-remap discovery, VERIFIED against the
real key sets (headers fetched live; native param sets derived from the
pinned source at commit 98fffa92; simulations /tmp/sim_tr_clip.py and
/tmp/sim_vae.py; the notebook's own remap/surgery functions re-tested
against the real key files, 983/983 + 392/392 exact):
  - TRANSFORMER: the conversion's weights are diffusers-named, the native
    WanTransformer3DModel is native-named, and from_pretrained does NOT
    rename (its dict_mapping covers config keys only — verified in source).
    Remap: 1,013 checkpoint keys -> 983 native i2v params, 30 dropped
    (blocks.N.attn2.norm_added_q only), 0 collisions, 0 shape mismatches.
    Native build: model_type='i2v', dim=1536, num_heads=12, num_layers=30,
    ffn_dim=8960 (v6 wrongly passed 6144), in_dim=36, out_dim=16.
  - CLIP: native CLIPModel is open_clip XLMRobertaCLIP (visual ViT-H/14 +
    XLM-R text tower); the conversion is transformers CLIP-ViT-H-14
    (vision only). Surgery: 520 keys -> 392 native visual params, 0 shape
    mismatches (rename + 2 unsqueezes + 1 transpose + 32 qkv concats).
    The text tower is expected-missing (vision-only checkpoint; the
    pipeline only calls .visual). NOTE: the CLIP file is model.safetensors
    (not diffusion_pytorch_model.safetensors) and from_pretrained takes a
    FILE path, not a directory — both were latent v6 notebook bugs.
  - VAE: REBUILT in v8 (authorised 25 Nov ~14:47 WAT, "Continue with V8").
    The native from_pretrained converter maps the 194 names correctly, but
    the native Decoder3d builds a different channel progression than this
    conversion's VAE decoder (native halves in_dims: blocks
    (384,384),(192,192),(96,96),(48,96); checkpoint: (384,384),(192->384),
    (192,192),(96,96)) — 43 shape mismatches + 2 name mismatches; the
    standard load raises RuntimeError. The notebook constructs the VAE
    directly, rebuilds decoder.upsamples with the checkpoint's progression,
    converts the keys with a faithful port of the native
    convert_state_dict_keys, verifies the keyset exactly (names + shapes),
    then loads with strict=True. The simulation proves all 194 keys match
    exactly; the port was verified locally against the v7 sim before the
    push. v7 was NOT pushed. No GPU-hours spent in the v7 session. v8 is
    the last reasonable fix in the series: if it fails at the T4
    memory/FP16 gate, the proof is DONE — no v9 without a fresh
    authorisation.

v9 (25 Nov 2026 ~22:00, night run; owner 25 Nov ~18:21 WAT: "retry the
Fun-InP proof at night; TEN attempts total, then stop"). v8 re-hit the v1
`ftfy` import error at CELL2 because the v7 build-script sync had dropped
the `ftfy` pip entry v2 had added (a regression, not a T4/FP16 gate
failure); the VAE rebuild was never exercised. v9 restores `ftfy` to the
pip install list (the v2 fix, verbatim) — the ONLY change vs v8. Attempt 9
of 10; if v9 fails, v10 is the LAST attempt; a T4 memory/FP16 gate failure
stops the proof immediately (reviewer strict stop).
"""

import json
import os

PKG = "packages/fun-inp-proof-20261125-01"
OUT = os.path.join(PKG, "output")


def _lines(src):
    return src.splitlines(keepends=True)


def md_cell(source):
    return {"cell_type": "markdown", "metadata": {}, "source": _lines(source)}


def code_cell(source):
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": _lines(source),
    }


CELL0 = r"""# NOVA GPU Cloud — Wan2.1-Fun-1.3B-InP one-clip proof (2026-11-25)

**Authorisation:** Shina 25 Nov 2026 ~07:46 WAT ("connect to those engine you found"); reviewer 25 Nov 2026 (morning, thread 17): ONE controlled Kaggle proof, strict stop if it fails the T4 memory/FP16 gate, must not delay LTX longer-clip work.

**ONE RUN ONLY. Stop after the first output (success or failure). Do NOT run any other engine proof.**

## The question

Wan-family models are BF16-native; a T4 has no BF16 tensor cores. Does Fun-InP **load AND execute in FP16** on one T4, or does it fail? Everything else in this notebook is scaffolding for that verdict.

## Design (verified 25 Nov 2026 against the real sources)

- **Engine:** Wan2.1-Fun-1.3B-InP (V1.1), Alibaba PAI, Apache 2.0. True first+last-frame I2V at 1.3B.
- **Pipeline:** VideoX-Fun `WanFunInpaintPipeline` (native, pinned commit `98fffa92…`, 2026-11-24) — NOT the diffusers `WanImageToVideoPipeline` (it builds 32 channels; the InP transformer needs 36: 16 noise + 4 mask + 16 masked-video). Scheduler: diffusers `FlowMatchEulerDiscreteScheduler`.
- **Weights:** transformer + VAE + CLIP + tokenizer from the diffusers conversion `weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers` via a scoped download (~4.9 GB; the conversion's 22.5 GB FP32 text encoder is NOT downloaded).
- **Text encoder:** umT5-XXL as transformers `UMT5EncoderModel`, weights from Kaggle Model `thiminhnht/umt5-xxl-fp16` (11.37 GB, all F16, transformers-format keys). Disclosed substitution for the native custom `WanT5EncoderModel` class — same weights, same architecture, same FP16 arithmetic; the native pipeline only calls `text_encoder(input_ids, attention_mask)[0]` and reads `.dtype`. The native class's `fp16_clamp` safety net is absent here; the notebook checks embeddings for inf/NaN.
- **Precomputed prompt_embeds are NOT passed:** the native `__call__` does `in_prompt_embeds = negative_prompt_embeds + prompt_embeds` — list concatenation for internally-encoded embeds, but element-wise addition for directly-passed tensors. The proof calls the pipeline with `prompt=` (string), so the encoder runs internally. Consequence: diffusers **model CPU offload** is enabled (encoder on CPU except while encoding); all four modules resident would be 16.24 GB > the 15.36 GB T4.
- **Comparability:** same dragon keyframes as LTX run 4 (hashes asserted), same run-4 prompt, 17 frames, 1024×576, seed 42. 50 steps, guidance 6.0 (native defaults).
- **FP16 proof:** dtype audits before AND after sampling assert zero BF16 parameters across transformer + VAE + CLIP + text encoder; the per-step callback records latent dtypes.
**Version history (see doc §3 for the full record)**

- **v1** (25 Nov ~08:29): `ModuleNotFoundError: ftfy` at native import — harness bug, 0.03 GPU-h.
- **v2** (~08:52): stale keyframe hashes (run-4/5 asserted, dataset serves run-6) — harness bug, 0.02 GPU-h.
- **v3** (~09:28): tokenizer `config.json` assertion wrong (the dir never had one) — harness bug, 0.03 GPU-h.
- **v4** (~09:44): T5 tied-weights assertion — `shared.weight` present, `encoder.embed_tokens.weight` only filled by `tie_weights()` — harness bug, 0.07 GPU-h.
- **v5** (~11:59): transformer built at the 5B shape (dim 2048) — `from_pretrained` ignores the diffusers config — harness bug, 0.08 GPU-h.
- **v6** (~12:51): transformer keyset mismatch — 823/825 params unfilled; the conversion's weights are diffusers-named, the native class is native-named; `from_pretrained` does NOT rename — harness bug, 0.08 GPU-h.
- **v7** (25 Nov ~13:18–13:40): key-remap discovery COMPLETE and verified against the real key sets — transformer remap (1,013 → 983, 30 dropped, 0 shape mismatches) and CLIP surgery (520 → 392, 0 shape mismatches) both proven, and the notebook code itself re-tested against the real key files. **STOPPED, NOT PUSHED**: the VAE cannot load — the native `Decoder3d` builds a different channel progression than the conversion's VAE decoder (43 shape mismatches + 2 name mismatches of 194 keys; the standard load raises `RuntimeError`). This is a new harness bug beyond the authorised v7 scope, so per the stop rule v7 was NOT pushed and no v8 was attempted. Next step is Shina's call: authorise the v8 decoder rebuild (simulation-proven, all 194 keys would then match), a transformer/CLIP-only load test, or another direction.
- **v8** (25 Nov ~14:47): Shina authorised the decoder rebuild ("Continue with V8"). The notebook constructs the VAE directly, rebuilds `decoder.upsamples` with the checkpoint's progression, converts the keys with a faithful port of the native `convert_state_dict_keys` (verified locally against the v7 sim before the push: identical output on the real 194 header keys), verifies the keyset exactly (names + shapes), then loads with `strict=True`. This is the last reasonable fix in the series: if v8 fails at the T4 memory/FP16 gate, the proof is DONE — no v9 without a fresh authorisation.
- **v9** (25 Nov ~22:00, night run; owner 25 Nov ~18:21 WAT: "retry the Fun-InP proof at night; TEN attempts total, then stop"): single change vs v8 — restore `ftfy` to the pinned pip install list (the v2 fix, verbatim), so the already-verified VAE rebuild can actually run. No other config change. Attempt 9 of 10; if v9 fails, v10 is the LAST attempt; a T4 memory/FP16 gate failure stops the proof immediately (reviewer strict stop).
"""

CELL1 = r"""import os, sys, json, time, gc, glob, hashlib, subprocess, shutil
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTHONUNBUFFERED", "1")

T0 = time.time()
REPORT = {"job": "fun-inp-proof-20261125-01",
          "engine": "Wan2.1-Fun-1.3B-InP (V1.1)",
          "implementation": "VideoX-Fun WanFunInpaintPipeline @ 98fffa929bb373edcbfa3620e9aa05cd65a53103, FlowMatchEulerDiscreteScheduler, torch_dtype=float16",
          "fp16_question": "Wan is BF16-native; T4 has no BF16 tensor cores. Proof: load AND execute in FP16, or fail."}
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
          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors", "einops", "torchvision"]:
    pre[p] = pv(p)
    log("pre-install %s: %s" % (p, pre[p]))
REPORT["packages_pre_install"] = pre
log("ALL GATES PASS")
"""

CELL2 = r"""# Pinned dependency set (LTX-proven Kaggle set + einops for the native VAE).
# ONE pip invocation (Wan v2 lesson: interacting packages pinned together).
# Torch is NOT pinned: the Kaggle image torch (2.11.0+cu130) matches LTX.
# ftfy: required by videox_fun.pipeline MOVAPipeline (import ftfy at module
# top level); v1 died on its absence, v2 added it (Shina ~08:45 WAT), the v7
# build-script sync dropped it and v8 re-died on it. v9 restores it verbatim.
t_install = time.time()
log("installing pinned deps (one invocation)...")
res = subprocess.run(
    [sys.executable, "-m", "pip", "install", "-q",
     "diffusers==0.40.0", "transformers==5.16.1", "accelerate",
     "sentencepiece", "protobuf", "imageio-ffmpeg", "einops", "safetensors",
     "huggingface-hub", "ftfy"],
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
          "imageio-ffmpeg", "huggingface-hub", "tokenizers", "safetensors", "einops", "torchvision"]:
    post[p] = pv(p)
    log("post-install %s: %s" % (p, post[p]))
REPORT["packages_post_install"] = post
import imageio_ffmpeg
log("ffmpeg exe:", imageio_ffmpeg.get_ffmpeg_exe())
REPORT["rss_gib_after_install"] = rss_gib()

# ---------- VideoX-Fun native code, pinned commit ----------
# Sparse, blob-filtered clone: only the videox_fun package is checked out.
# Full history metadata (no blobs) so the pinned commit is always reachable.
VXFUN = "/kaggle/working/videox-fun"
VXFUN_PIN = "98fffa929bb373edcbfa3620e9aa05cd65a53103"
t_clone = time.time()
if os.path.isdir(VXFUN):
    log("videox-fun dir already exists; reusing")
else:
    res = subprocess.run(
        ["git", "clone", "--filter=blob:none", "--sparse",
         "https://github.com/aigc-apps/VideoX-Fun.git", VXFUN],
        capture_output=True, text=True, timeout=600)
    log("git clone returncode:", res.returncode)
    if res.returncode != 0:
        log(res.stderr[-2000:])
        raise SystemExit("VIDEOX-FUN CLONE FAILED")
    res = subprocess.run(
        ["git", "-C", VXFUN, "sparse-checkout", "set", "videox_fun"],
        capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        log(res.stderr[-2000:])
        raise SystemExit("VIDEOX-FUN SPARSE-CHECKOUT FAILED")
    res = subprocess.run(
        ["git", "-C", VXFUN, "checkout", VXFUN_PIN],
        capture_output=True, text=True, timeout=300)
    log("git checkout %s returncode: %s" % (VXFUN_PIN[:8], res.returncode))
    if res.returncode != 0:
        log(res.stderr[-2000:])
        raise SystemExit("VIDEOX-FUN PINNED-COMMIT CHECKOUT FAILED")
res = subprocess.run(
    ["git", "-C", VXFUN, "rev-parse", "HEAD"],
    capture_output=True, text=True, timeout=60)
head = res.stdout.strip()
log("videox-fun HEAD:", head)
assert head == VXFUN_PIN, "VIDEOX-FUN HEAD MISMATCH: %s != %s" % (head, VXFUN_PIN)
REPORT["videox_fun_commit"] = head
REPORT["videox_fun_clone_s"] = round(time.time() - t_clone, 1)
REPORT["rss_gib_after_clone"] = rss_gib()

# Import smoke test: the native classes the proof runs. Importing
# videox_fun.models executes its __init__ (heavy transformers imports);
# a failure here is a blocker, recorded, not worked around.
sys.path.insert(0, VXFUN)
try:
    from videox_fun.models.wan_transformer3d import WanTransformer3DModel
    from videox_fun.models.wan_vae import AutoencoderKLWan, ResidualBlock, Resample
    from videox_fun.models.wan_image_encoder import CLIPModel
    from videox_fun.pipeline.pipeline_wan_fun_inpaint import WanFunInpaintPipeline
    from diffusers import FlowMatchEulerDiscreteScheduler
    log("native imports OK: WanTransformer3DModel, AutoencoderKLWan, CLIPModel, WanFunInpaintPipeline, FlowMatchEulerDiscreteScheduler")
except Exception as e:
    import traceback
    traceback.print_exc()
    raise SystemExit("NATIVE IMPORT FAILED (blocker): %s" % e)
REPORT["native_imports"] = "OK"
"""
CELL3 = r"""# Asset inventory: keyframes from the mount, conversion weights by scoped
# download, text-encoder weights from the Kaggle model mount.
# NOTHING larger than the ~4.9 GB scoped download lands in /kaggle/working.
log("input mount roots:", sorted(os.listdir("/kaggle/input")))

def find_one(pattern, what):
    hits = sorted(p for p in glob.glob(pattern, recursive=True) if os.path.isfile(p))
    if not hits:
        raise SystemExit("ASSET NOT FOUND: %s (pattern %s)" % (what, pattern))
    log("%s: %s" % (what, hits[0]))
    if len(hits) > 1:
        log("  (plus %d more matches)" % (len(hits) - 1))
    return hits[0]

def du_bytes(path):
    s = 0
    for r, _, fs in os.walk(path):
        for fn in fs:
            try:
                s += os.path.getsize(os.path.join(r, fn))
            except OSError:
                pass
    return s

# ---------- keyframes (run-6 keyframes; hashes asserted) ----------
FIRST = find_one("/kaggle/input/**/first_frame.png", "first keyframe")
LAST = find_one("/kaggle/input/**/last_frame.png", "last keyframe")
for path, exp in [(FIRST, "b746e5fa74332b86bdf2e088e02c86e9741e5c94f70bfe01d8bf2ca5d05055fb"),
                  (LAST, "c8218a25a535c498168192b86104f470ddb84408d1436922cf93d35eb76ed3eb")]:
    got = hashlib.sha256(open(path, "rb").read()).hexdigest()
    log("%s sha256 %s (match=%s)" % (os.path.basename(path), got[:16], got == exp))
    assert got == exp, "KEYFRAME HASH MISMATCH: " + path
REPORT["keyframes"] = {"first": FIRST, "last": LAST, "verified": True}

# ---------- text-encoder weights: Kaggle model mount ----------
T5_FILE = find_one("/kaggle/input/**/umt5_xxl_fp16.safetensors", "umT5-XXL FP16")
t5_size = os.path.getsize(T5_FILE)
log("umT5-XXL FP16 file: %.2f GiB" % (t5_size / 2**30))
from safetensors import safe_open
with safe_open(T5_FILE, framework="pt") as f:
    t5_keys = list(f.keys())
    t5_dtypes = {}
    for k in t5_keys:
        d = str(f.get_slice(k).get_dtype())
        t5_dtypes[d] = t5_dtypes.get(d, 0) + 1
log("umT5-XXL tensors: %d; dtypes: %s" % (len(t5_keys), t5_dtypes))
log("sample keys:", t5_keys[:2])
assert len(t5_keys) == 243, "UMT5 TENSOR COUNT MISMATCH: %d (expected 243)" % len(t5_keys)
assert t5_dtypes.get("F16", 0) == 242 and t5_dtypes.get("U8", 0) == 1, "UMT5 DTYPE MISMATCH: %s" % t5_dtypes
REPORT["text_encoder_mount"] = {"file": T5_FILE, "size_bytes": t5_size,
                                "tensors": len(t5_keys), "dtypes": t5_dtypes}

# ---------- conversion weights: scoped HF download (NOT text_encoder) ----------
from huggingface_hub import snapshot_download, hf_hub_download
CONV = "weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers"
W_DIR = "/kaggle/working/fun-inp-weights"
t_dl = time.time()
log("scoped download of %s (transformer/vae/image_encoder/tokenizer/scheduler/model_index.json)..." % CONV)
try:
    snapshot_download(repo_id=CONV, local_dir=W_DIR, local_dir_use_symlinks=False,
                      allow_patterns=["transformer/*", "vae/*", "image_encoder/*",
                                      "tokenizer/*", "scheduler/*", "model_index.json"])
except Exception as e:
    raise SystemExit("SCOPED DOWNLOAD FAILED (blocker): %s" % e)
dl_s = time.time() - t_dl
dl_bytes = du_bytes(W_DIR)
log("scoped download: %.2f GiB in %.1f s" % (dl_bytes / 2**30, dl_s))
assert dl_bytes <= 5 * 1024**3, "DOWNLOAD BUDGET EXCEEDED: %.2f GiB > 5 GiB" % (dl_bytes / 2**30)
assert not os.path.isdir(os.path.join(W_DIR, "text_encoder")), "text_encoder was downloaded (must NOT be)"
REPORT["scoped_download"] = {"repo": CONV, "dir": W_DIR, "bytes": dl_bytes,
                             "seconds": round(dl_s, 1)}

TR_DIR = os.path.join(W_DIR, "transformer")
VAE_DIR = os.path.join(W_DIR, "vae")
CLIP_DIR = os.path.join(W_DIR, "image_encoder")
TOK_DIR = os.path.join(W_DIR, "tokenizer")
for d, what, cfg in [(TR_DIR, "transformer", "config.json"), (VAE_DIR, "vae", "config.json"),
                     (CLIP_DIR, "image_encoder", "config.json"), (TOK_DIR, "tokenizer", "tokenizer_config.json")]:
    assert os.path.isdir(d), "MISSING COMPONENT DIR: %s (%s)" % (d, what)
    assert os.path.isfile(os.path.join(d, cfg)), "MISSING %s in %s" % (cfg, d)
    log("%s dir OK: %.2f GiB" % (what, du_bytes(d) / 2**30))

# Transformer config: the 36-channel proof of the InP architecture.
with open(os.path.join(TR_DIR, "config.json")) as f:
    tr_cfg = json.load(f)
log("transformer config: in_channels=%s class=%s ffn_dim=%s layers=%s heads=%s" % (
    tr_cfg.get("in_channels"), tr_cfg.get("_class_name"), tr_cfg.get("ffn_dim"),
    tr_cfg.get("num_layers"), tr_cfg.get("num_attention_heads")))
assert tr_cfg.get("in_channels") == 36, "TRANSFORMER in_channels != 36: %s" % tr_cfg.get("in_channels")
assert tr_cfg.get("_class_name") == "WanTransformer3DModel", "TRANSFORMER class mismatch: %s" % tr_cfg.get("_class_name")
# v7: the native build kwargs below are read from these values, not guessed.
# ffn_dim=8960 (v6 wrongly passed 6144); num_layers=30; heads=12 (dim 1536 = 12x128).
assert tr_cfg.get("ffn_dim") == 8960, "TRANSFORMER ffn_dim != 8960: %s" % tr_cfg.get("ffn_dim")
assert tr_cfg.get("num_layers") == 30, "TRANSFORMER num_layers != 30: %s" % tr_cfg.get("num_layers")
assert tr_cfg.get("num_attention_heads") == 12, "TRANSFORMER heads != 12: %s" % tr_cfg.get("num_attention_heads")
assert tr_cfg.get("out_channels") == 16, "TRANSFORMER out_channels != 16: %s" % tr_cfg.get("out_channels")
REPORT["transformer_config"] = {"in_channels": tr_cfg.get("in_channels"),
                                "class": tr_cfg.get("_class_name"),
                                "ffn_dim": tr_cfg.get("ffn_dim"),
                                "num_layers": tr_cfg.get("num_layers"),
                                "num_attention_heads": tr_cfg.get("num_attention_heads"),
                                "out_channels": tr_cfg.get("out_channels")}
with open(os.path.join(VAE_DIR, "config.json")) as f:
    vae_cfg = json.load(f)
log("vae config: latent_channels=%s" % vae_cfg.get("latent_channels"))
REPORT["vae_config"] = {"latent_channels": vae_cfg.get("latent_channels")}

# Text-encoder config only (tiny): the conversion's text_encoder/config.json.
TE_CFG_FILE = hf_hub_download(repo_id=CONV, filename="text_encoder/config.json")
with open(TE_CFG_FILE) as f:
    te_cfg = json.load(f)
log("text_encoder config: architectures=%s" % te_cfg.get("architectures"))
assert "UMT5EncoderModel" in (te_cfg.get("architectures") or []), "TEXT-ENCODER config is not UMT5EncoderModel: %s" % te_cfg.get("architectures")
REPORT["text_encoder_config"] = {"architectures": te_cfg.get("architectures")}
REPORT["rss_gib_after_assets"] = rss_gib()
log("ASSET INVENTORY COMPLETE")
"""

CELL4 = r"""# Text encoder: umT5-XXL, same weights as the native model, loaded into
# transformers UMT5EncoderModel (disclosed substitution — see header).
# Encode the prompt on GPU as a finite/dtype verification, then move the
# encoder to CPU. NOTE: these embeddings are NOT passed to the pipeline
# (the native __call__ element-wise-adds directly-passed embeds); the
# pipeline re-encodes internally from prompt= in cell 6.
from transformers import UMT5EncoderModel, AutoTokenizer
from safetensors.torch import load_file

PROMPT = ("An ash-grey dragon with ember-cracked wings rests on a misty "
          "mountain ridge at dawn, slow cinematic camera push-in, mist "
          "drifting across the ridge, embers glowing faintly along the "
          "dragon's wings, epic fantasy film still, dramatic dawn light")
MAX_SEQ = 512
REPORT["prompt"] = PROMPT
REPORT["max_sequence_length"] = MAX_SEQ

t = time.time()
enc_config = UMT5EncoderModel.config_class.from_pretrained(os.path.dirname(TE_CFG_FILE))
t5 = UMT5EncoderModel(enc_config)
log("UMT5EncoderModel built from config in %.1f s" % (time.time() - t))

t = time.time()
sd = load_file(T5_FILE)
missing, unexpected = t5.load_state_dict(sd, strict=False)
t5_load_s = time.time() - t
log("state_dict loaded in %.1f s; missing=%d unexpected=%d" % (t5_load_s, len(missing), len(unexpected)))
if missing:
    log("  missing (first 5):", missing[:5])
if unexpected:
    log("  unexpected (first 5):", unexpected[:5])
# v5 FIX (Shina authorised 25 Nov 2026 ~10:57 WAT): the conversion stores the
# embedding as shared.weight only; transformers UMT5EncoderModel builds BOTH
# self.shared and self.encoder.embed_tokens, tied via _tied_weights_keys, so the
# tied alias 'encoder.embed_tokens.weight' is the only expected missing key and
# load_state_dict alone never fills it. tie_weights() binds the alias to the
# loaded shared.weight (without it the embedding would stay randomly
# initialised — silent garbage). 'spiece_model' is the SentencePiece model bytes
# packed into the weights file, not a parameter — the only allowed unexpected key.
t5.tie_weights()
log("tie_weights() called; embed_tokens tied to shared.weight: %s" % (t5.encoder.embed_tokens.weight.data_ptr() == t5.shared.weight.data_ptr()))
assert set(missing) <= {"encoder.embed_tokens.weight"}, "T5 MISSING KEYS: %s" % missing[:5]
assert set(unexpected) <= {"spiece_model"}, "T5 UNEXPECTED KEYS: %s" % unexpected[:5]
del sd
t5_params = sum(p.numel() for p in t5.parameters())
t5.to(torch.float16)
t5.eval()
t5_dtype = next(t5.parameters()).dtype
log("T5 loaded (CPU, fp16) in %.1f s; params=%.2fB; dtype=%s" % (t5_load_s, t5_params / 1e9, t5_dtype))
assert str(t5_dtype) == "torch.float16", "T5 NOT FP16"
REPORT["t5_load_s"] = round(t5_load_s, 1)
REPORT["t5_params_b"] = round(t5_params / 1e9, 2)
REPORT["t5_dtype"] = str(t5_dtype)
REPORT["rss_gib_after_t5_load"] = rss_gib()

t = time.time()
tok = AutoTokenizer.from_pretrained(TOK_DIR)
log("tokenizer loaded in %.1f s: %s" % (time.time() - t, tok.__class__.__name__))

t = time.time()
t5.to("cuda")
log("T5 -> cuda in %.1f s; VRAM now %.2f GiB" % (time.time() - t, torch.cuda.memory_allocated() / 2**30))
REPORT["t5_vram_gib"] = round(torch.cuda.memory_allocated() / 2**30, 2)

# Encode prompt + negative prompt on GPU; finite check (the native class's
# fp16_clamp safety net is absent in transformers UMT5 — inf/NaN here is
# a recorded FP16 finding, not a silent failure).
def encode_check(text, label):
    ids = tok(text, padding="max_length", max_length=MAX_SEQ, truncation=True,
              add_special_tokens=True, return_tensors="pt")
    with torch.no_grad():
        emb = t5(ids.input_ids.to("cuda"), attention_mask=ids.attention_mask.to("cuda"))[0]
    emb = emb.to(dtype=t5.dtype, device="cuda")
    finite = bool(torch.isfinite(emb).all().item())
    log("%s: embeds %s %s; finite=%s; max|.|=%.3f" % (
        label, tuple(emb.shape), emb.dtype, finite, float(emb.abs().max().item())))
    assert finite, "NON-FINITE %s EMBEDS (FP16 overflow in the text encoder)" % label
    return emb

t = time.time()
prompt_embeds_check = encode_check(PROMPT, "prompt")
neg_embeds_check = encode_check("", "negative prompt")
t5_encode_s = time.time() - t
REPORT["t5_encode_s"] = round(t5_encode_s, 1)
REPORT["prompt_embeds_shape"] = [int(x) for x in prompt_embeds_check.shape]
REPORT["prompt_embeds_dtype"] = str(prompt_embeds_check.dtype)
REPORT["prompt_embeds_finite"] = True
del prompt_embeds_check, neg_embeds_check

# Encoder to CPU; free the GPU for the pipeline. (The pipeline re-encodes
# internally; with model CPU offload it will pull the encoder back to GPU
# for that call and offload it again.)
t5.to("cpu")
gc.collect()
torch.cuda.empty_cache()
torch.cuda.reset_peak_memory_stats()
log("T5 -> CPU; VRAM now %.2f GiB; RSS %.2f GiB" % (
    torch.cuda.memory_allocated() / 2**30, rss_gib()))
REPORT["vram_gib_after_t5_to_cpu"] = round(torch.cuda.memory_allocated() / 2**30, 2)
REPORT["rss_gib_after_t5_to_cpu"] = rss_gib()
"""

CELL5 = r"""# Build the native pipeline in FP16 (v8, 25 Nov 2026).
# v8 changes (authorised 25 Nov ~14:47 WAT, "Continue with V8"; doc §3):
#  - VAE: DECODER REBUILT (see below). The native from_pretrained converter
#    maps the 194 names correctly, BUT the native Decoder3d builds a
#    different channel progression than this conversion's VAE decoder
#    (native halves in_dims: blocks (384,384),(192,192),(96,96),(48,96);
#    checkpoint: (384,384),(192->384),(192,192),(96,96)) — 43 shape
#    mismatches + 2 name mismatches, so the standard load raises
#    RuntimeError. The load below constructs the VAE directly, rebuilds
#    decoder.upsamples with the checkpoint's progression, converts the keys
#    with a faithful port of the native convert_state_dict_keys (verified
#    locally against the v7 sim before the push: identical output on the
#    real 194 header keys), verifies the keyset EXACTLY (names + shapes)
#    before loading, then loads with strict=True. from_pretrained is NOT
#    used (it builds the native decoder and loads internally). Latent v6
#    bug fixed: the load reads the FILE diffusion_pytorch_model.safetensors,
#    never the directory.
#  - TRANSFORMER: the conversion's weights use diffusers names; the native
#    WanTransformer3DModel uses its own names, and its from_pretrained does
#    NOT rename them (v6: 823/825 params unfilled). The remap below is
#    verified: 1,013 checkpoint keys -> 983 native i2v params, 30 dropped
#    (blocks.N.attn2.norm_added_q only — diffusers itself lists it in
#    _keys_to_ignore_on_load_unexpected), 0 shape mismatches. Native build is
#    direct construction: model_type='i2v', dim=1536 (12 heads x 128),
#    num_heads=12, num_layers=30, ffn_dim=8960 (v6 wrongly passed 6144),
#    in_dim=36 (the native forward concatenates 16ch latents + 20ch
#    masked-video BEFORE patch_embedding, so patch_embedding takes 36
#    channels), out_dim=16. The native from_pretrained's dict_mapping covers
#    CONFIG keys only, not weight keys — verified, not used.
#  - CLIP: the native CLIPModel is open_clip XLMRobertaCLIP (visual ViT-H/14
#    + an XLM-R text tower), while the conversion ships transformers
#    CLIP-ViT-H-14 (vision only). The surgery below is verified: 520
#    checkpoint keys -> 392 native visual params, 0 shape mismatches
#    (rename + 2 unsqueezes + 1 transpose + 32 qkv concats). The text tower
#    (model.textual.* + model.log_scale) is EXPECTED missing — the checkpoint
#    is vision-only and the pipeline only calls .visual. NOTE: the CLIP file
#    is model.safetensors, NOT diffusion_pytorch_model.safetensors, and the
#    native from_pretrained takes a FILE path, not a directory (both were
#    latent bugs in the v6 notebook, which passed CLIP_DIR).
#  - VAE: see the v8 decoder-rebuild bullet at the top of this header.
from PIL import Image
import numpy as np
import re

def checkpoint_keys(path):
    with safe_open(path, framework="pt") as f:
        return set(f.keys())

def remapped_keyset_check(module, remapped, name):
    # Exact 1:1 check on the REMAPPED key set (names + shapes). Any gap is a
    # real load failure, not a naming difference — fail closed.
    model = module.state_dict()
    if set(remapped) != set(model):
        only_r = sorted(set(remapped) - set(model))[:5]
        only_m = sorted(set(model) - set(remapped))[:5]
        log("  keys only in remapped checkpoint (first 5):", only_r)
        log("  keys only in model (first 5):", only_m)
        raise SystemExit("KEYSET MISMATCH (%s): remapped checkpoint != model key set" % name)
    bad = [k for k in remapped if tuple(remapped[k].shape) != tuple(model[k].shape)]
    if bad:
        log("  shape mismatches (first 5):", [(k, tuple(remapped[k].shape), tuple(model[k].shape)) for k in bad[:5]])
        raise SystemExit("KEYSET MISMATCH (%s): %d shape mismatches" % (name, len(bad)))
    log("%s keyset: EXACT MATCH (%d keys, shapes verified)" % (name, len(remapped)))

def subset_keyset_check(module, remapped, name, allowed_extra_prefixes):
    # For modules whose checkpoint covers only part of the model (CLIP: the
    # vision tower only; the text tower is expected-missing). Every remapped
    # key must exist in the model with the same shape; every extra model key
    # must sit under one of the allowed prefixes.
    model = module.state_dict()
    missing = [k for k in remapped if k not in model]
    bad = [k for k in remapped if k in model and tuple(remapped[k].shape) != tuple(model[k].shape)]
    extra = [k for k in model if k not in remapped and not any(k.startswith(p) for p in allowed_extra_prefixes)]
    if missing or bad or extra:
        log("  remapped keys missing from model (first 5):", missing[:5])
        log("  shape mismatches (first 5):", [(k, tuple(remapped[k].shape), tuple(model[k].shape)) for k in bad[:5]])
        log("  unexplained extra model keys (first 5):", extra[:5])
        raise SystemExit("KEYSET MISMATCH (%s): missing=%d bad-shape=%d unexplained-extra=%d" % (name, len(missing), len(bad), len(extra)))
    log("%s keyset: SUBSET MATCH (%d keys, shapes verified; %d model keys expected-absent under %s)" % (
        name, len(remapped), len(model) - len(remapped), allowed_extra_prefixes))

# ---------- v7 transformer key remap (verified) ----------
def remap_transformer_keys(sd):
    out = {}
    dropped = []
    for k, v in sd.items():
        seg = k.split(".")
        if seg[0] == "condition_embedder":
            if seg[1] == "text_embedder":
                nk = "text_embedding.%s.%s" % ("0" if seg[2] == "linear_1" else "2", seg[3])
            elif seg[1] == "time_embedder":
                nk = "time_embedding.%s.%s" % ("0" if seg[2] == "linear_1" else "2", seg[3])
            elif seg[1] == "time_proj":
                nk = "time_projection.1." + seg[2]
            elif seg[1] == "image_embedder":
                if seg[2] == "norm1":
                    nk = "img_emb.proj.0." + seg[3]
                elif seg[2] == "norm2":
                    nk = "img_emb.proj.4." + seg[3]
                elif seg[2] == "ff" and seg[3] == "net" and seg[4] == "0":
                    nk = "img_emb.proj.1." + seg[6]
                elif seg[2] == "ff" and seg[3] == "net" and seg[4] == "2":
                    nk = "img_emb.proj.3." + seg[5]
                else:
                    raise SystemExit("TRANSFORMER REMAP: unmapped image_embedder key %s" % k)
            else:
                raise SystemExit("TRANSFORMER REMAP: unmapped condition_embedder key %s" % k)
        elif seg[0] == "patch_embedding":
            nk = k
        elif seg[0] == "proj_out":
            nk = "head.head." + seg[1]
        elif k == "scale_shift_table":
            nk = "head.modulation"
        elif seg[0] == "blocks":
            blk = "blocks." + seg[1]
            if seg[2] == "attn1":
                m = {"to_q": "self_attn.q", "to_k": "self_attn.k", "to_v": "self_attn.v",
                     "to_out": "self_attn.o", "norm_q": "self_attn.norm_q", "norm_k": "self_attn.norm_k"}
                nk = blk + "." + m[seg[3]] + "." + seg[-1]
            elif seg[2] == "attn2":
                if seg[3] == "norm_added_q":
                    dropped.append(k)
                    continue
                m = {"to_q": "cross_attn.q", "to_k": "cross_attn.k", "to_v": "cross_attn.v",
                     "to_out": "cross_attn.o", "norm_q": "cross_attn.norm_q", "norm_k": "cross_attn.norm_k",
                     "add_k_proj": "cross_attn.k_img", "add_v_proj": "cross_attn.v_img",
                     "norm_added_k": "cross_attn.norm_k_img"}
                nk = blk + "." + m[seg[3]] + "." + seg[-1]
            elif seg[2] == "norm2":
                nk = blk + ".norm3." + seg[3]
            elif seg[2] == "ffn":
                nk = blk + (".ffn.0." if seg[4] == "0" else ".ffn.2.") + seg[-1]
            elif seg[2] == "scale_shift_table":
                nk = blk + ".modulation"
            else:
                raise SystemExit("TRANSFORMER REMAP: unmapped block key %s" % k)
        else:
            raise SystemExit("TRANSFORMER REMAP: unmapped checkpoint key %s" % k)
        if nk in out:
            raise SystemExit("TRANSFORMER REMAP: collision on %s (from %s)" % (nk, k))
        out[nk] = v
    return out, dropped

t = time.time()
transformer = WanTransformer3DModel(model_type="i2v", dim=1536, num_heads=12,
                                    num_layers=30, ffn_dim=8960, in_dim=36, out_dim=16)
log("transformer built (i2v, dim=1536, heads=12, layers=30, ffn=8960, in_dim=36); patch_embedding %s" % (
    tuple(transformer.patch_embedding.weight.shape),))
assert tuple(transformer.patch_embedding.weight.shape) == (1536, 36, 1, 2, 2), "TRANSFORMER patch_embedding shape wrong"
tr_sd = load_file(os.path.join(TR_DIR, "diffusion_pytorch_model.safetensors"))
tr_remapped, tr_dropped = remap_transformer_keys(tr_sd)
log("transformer remap: %d checkpoint keys -> %d native params, %d dropped" % (len(tr_sd), len(tr_remapped), len(tr_dropped)))
assert len(tr_dropped) == 30 and all("norm_added_q" in d for d in tr_dropped), "TRANSFORMER REMAP: unexpected dropped keys: %s" % tr_dropped[:5]
missing, unexpected = transformer.load_state_dict(tr_remapped, strict=False)
assert not missing and not unexpected, "TRANSFORMER LOAD: missing=%s unexpected=%s" % (missing[:5], unexpected[:5])
transformer = transformer.to(torch.float16)
log("transformer loaded in %.1f s" % (time.time() - t))
REPORT["transformer_load_s"] = round(time.time() - t, 1)
REPORT["transformer_remap"] = {"checkpoint_keys": len(tr_sd), "native_params": len(tr_remapped),
                               "dropped": len(tr_dropped), "dropped_kind": "blocks.N.attn2.norm_added_q"}
remapped_keyset_check(transformer, tr_remapped, "transformer")
del tr_sd, tr_remapped

# ---------- v7 CLIP surgery (verified) ----------
def surgery_clip_keys(sd):
    out = {}
    qkv = {}
    for k, v in sd.items():
        if k == "vision_model.embeddings.class_embedding":
            # checkpoint [1280] -> native [1, 1, 1280]: TWO unsqueezes (the
            # native cls_embedding is a [1, 1, dim] Parameter, not [1, dim]).
            out["model.visual.cls_embedding"] = v.unsqueeze(0).unsqueeze(0)
        elif k == "vision_model.embeddings.patch_embedding.weight":
            out["model.visual.patch_embedding.weight"] = v
        elif k == "vision_model.embeddings.position_embedding.weight":
            out["model.visual.pos_embedding"] = v.unsqueeze(0)
        elif k == "vision_model.pre_layrnorm.weight":
            out["model.visual.pre_norm.weight"] = v
        elif k == "vision_model.pre_layrnorm.bias":
            out["model.visual.pre_norm.bias"] = v
        elif k == "vision_model.post_layernorm.weight":
            out["model.visual.post_norm.weight"] = v
        elif k == "vision_model.post_layernorm.bias":
            out["model.visual.post_norm.bias"] = v
        elif k == "visual_projection.weight":
            out["model.visual.head"] = v.t().contiguous()
        else:
            m = re.match(r"vision_model\.encoder\.layers\.(\d+)\.(.*)", k)
            if not m:
                raise SystemExit("CLIP SURGERY: unmapped key %s" % k)
            i, rest = m.groups()
            p = "model.visual.transformer.%s." % i
            if rest.startswith("layer_norm1."):
                out[p + "norm1." + rest.split(".")[-1]] = v
            elif rest.startswith("layer_norm2."):
                out[p + "norm2." + rest.split(".")[-1]] = v
            elif rest.startswith("mlp.fc1."):
                out[p + "mlp.0." + rest.split(".")[-1]] = v
            elif rest.startswith("mlp.fc2."):
                out[p + "mlp.2." + rest.split(".")[-1]] = v
            elif rest.startswith("self_attn.out_proj."):
                out[p + "attn.proj." + rest.split(".")[-1]] = v
            elif rest.startswith("self_attn.q_proj."):
                qkv.setdefault((i, rest.split(".")[-1]), {})["q"] = v
            elif rest.startswith("self_attn.k_proj."):
                qkv.setdefault((i, rest.split(".")[-1]), {})["k"] = v
            elif rest.startswith("self_attn.v_proj."):
                qkv.setdefault((i, rest.split(".")[-1]), {})["v"] = v
            else:
                raise SystemExit("CLIP SURGERY: unmapped layer key %s" % k)
    for (i, suffix), d in qkv.items():
        assert set(d) == {"q", "k", "v"}, "CLIP SURGERY: incomplete qkv for layer %s %s" % (i, suffix)
        out["model.visual.transformer.%s.attn.to_qkv.%s" % (i, suffix)] = torch.cat([d["q"], d["k"], d["v"]], dim=0)
    return out

t = time.time()
clip = CLIPModel()
clip_sd = load_file(os.path.join(CLIP_DIR, "model.safetensors"))
clip_remapped = surgery_clip_keys(clip_sd)
log("clip surgery: %d checkpoint keys -> %d native visual params" % (len(clip_sd), len(clip_remapped)))
missing, unexpected = clip.load_state_dict(clip_remapped, strict=False)
# The checkpoint is vision-only; the native model's XLM-R text tower
# (model.textual.*) + log_scale are EXPECTED missing — the pipeline only
# calls .visual, and clip_image=None zeroes the result anyway.
bad_missing = [k for k in missing if not (k.startswith("model.textual.") or k == "model.log_scale")]
assert not bad_missing, "CLIP LOAD: unexpected missing keys: %s" % bad_missing[:5]
assert not unexpected, "CLIP LOAD: unexpected keys: %s" % unexpected[:5]
log("clip: %d visual params loaded; %d text-tower params expected-missing (unused)" % (len(clip_remapped), len(missing)))
clip = clip.to(torch.float16)
log("clip image encoder loaded in %.1f s" % (time.time() - t))
REPORT["clip_load_s"] = round(time.time() - t, 1)
REPORT["clip_surgery"] = {"checkpoint_keys": len(clip_sd), "native_visual_params": len(clip_remapped),
                          "text_tower_expected_missing": len(missing)}
subset_keyset_check(clip, clip_remapped, "clip_image_encoder", ("model.textual.", "model.log_scale"))
del clip_sd, clip_remapped

# ---------- v8 VAE: decoder rebuild (authorised 25 Nov ~14:47 WAT) ----------
# Verified 25 Nov 2026 (doc §3, simulation against the real header shapes):
# the native from_pretrained converter maps the 194 names correctly, BUT the
# native Decoder3d builds blocks (384,384),(192,192),(96,96),(48,96) while
# this conversion's decoder is (384,384),(192->384),(192,192),(96,96).
# The v8 fix (simulation-proven: all 194 keys match exactly): construct the
# VAE directly (defaults == conversion config, asserted below), rebuild
# decoder.upsamples with the checkpoint's progression, convert the keys with
# a faithful port of the native convert_state_dict_keys, verify the keyset
# EXACTLY (names + shapes) before loading, then load with strict=True.
# from_pretrained is NOT used: it builds the native decoder and loads
# internally, so the rebuild could never intervene. Its convert function is
# nested inside it, hence the port below (verified locally against the v7
# sim before the push: identical output on the real 194 header keys).
# Latent v6 bug fixed here too: the load reads the FILE
# diffusion_pytorch_model.safetensors, never the directory.
def convert_vae_keys(sd):
    new = {}
    for raw_key in sd:
        old_key = "model." + raw_key
        new_key = old_key
        if '.quant_conv.' in old_key and 'post_quant_conv' not in old_key:
            new_key = old_key.replace('.quant_conv.', '.conv1.')
        elif '.post_quant_conv.' in old_key:
            new_key = old_key.replace('.post_quant_conv.', '.conv2.')
        if '.encoder.mid_block.attentions.' in old_key:
            m = re.match(r'(.*)\.encoder\.mid_block\.attentions\.(\d+)\.(norm|to_qkv|proj)\.(.*)', old_key)
            if m:
                new_key = "%s.encoder.middle.1.%s.%s" % (m.group(1), m.group(3), m.group(4))
        if '.decoder.mid_block.attentions.' in old_key:
            m = re.match(r'(.*)\.decoder\.mid_block\.attentions\.(\d+)\.(norm|to_qkv|proj)\.(.*)', old_key)
            if m:
                new_key = "%s.decoder.middle.1.%s.%s" % (m.group(1), m.group(3), m.group(4))
        if '.encoder.down_blocks.' in old_key:
            m = re.match(r'(.*)\.encoder\.down_blocks\.(\d+)\.(conv1|conv2|norm1|norm2|conv_shortcut|resample\.\d+|time_conv)\.(.*)', old_key)
            if m:
                layer_map = {'conv1': 'residual.2', 'conv2': 'residual.6', 'norm1': 'residual.0', 'norm2': 'residual.3', 'conv_shortcut': 'shortcut'}
                new_key = "%s.encoder.downsamples.%s.%s.%s" % (m.group(1), m.group(2), layer_map.get(m.group(3), m.group(3)), m.group(4))
        elif '.decoder.up_blocks.' in old_key and '.resnets.' in old_key:
            m = re.match(r'(.*)\.decoder\.up_blocks\.(\d+)\.resnets\.(\d+)\.(conv1|conv2|norm1|norm2|conv_shortcut)\.(.*)', old_key)
            if m:
                block_start = {0: 0, 1: 4, 2: 8, 3: 12}
                upsample_idx = block_start.get(int(m.group(2)), 0) + int(m.group(3))
                layer_map = {'conv1': 'residual.2', 'conv2': 'residual.6', 'norm1': 'residual.0', 'norm2': 'residual.3', 'conv_shortcut': 'shortcut'}
                new_key = "%s.decoder.upsamples.%d.%s.%s" % (m.group(1), upsample_idx, layer_map.get(m.group(4), m.group(4)), m.group(5))
        elif '.decoder.up_blocks.' in old_key and '.upsamplers.' in old_key:
            m = re.match(r'(.*)\.decoder\.up_blocks\.(\d+)\.upsamplers\.0\.(resample\.\d+|time_conv)\.(.*)', old_key)
            if m:
                upsampler_idx = {0: 3, 1: 7, 2: 11, 3: None}
                idx = upsampler_idx.get(int(m.group(2)))
                if idx is not None:
                    new_key = "%s.decoder.upsamples.%d.%s.%s" % (m.group(1), idx, m.group(3), m.group(4))
                else:
                    continue
        elif '.encoder.mid_block.resnets.' in old_key:
            m = re.match(r'(.*)\.encoder\.mid_block\.resnets\.(\d+)\.(conv1|conv2|norm1|norm2)\.(.*)', old_key)
            if m:
                layer_map = {'conv1': 'residual.2', 'conv2': 'residual.6', 'norm1': 'residual.0', 'norm2': 'residual.3'}
                new_key = "%s.encoder.middle.%d.%s.%s" % (m.group(1), int(m.group(2)) * 2, layer_map.get(m.group(3), m.group(3)), m.group(4))
        elif '.decoder.mid_block.resnets.' in old_key:
            m = re.match(r'(.*)\.decoder\.mid_block\.resnets\.(\d+)\.(conv1|conv2|norm1|norm2)\.(.*)', old_key)
            if m:
                layer_map = {'conv1': 'residual.2', 'conv2': 'residual.6', 'norm1': 'residual.0', 'norm2': 'residual.3'}
                new_key = "%s.decoder.middle.%d.%s.%s" % (m.group(1), int(m.group(2)) * 2, layer_map.get(m.group(3), m.group(3)), m.group(4))
        elif '.encoder.norm_out.' in old_key:
            new_key = old_key.replace('.encoder.norm_out.', '.encoder.head.0.')
        elif '.decoder.norm_out.' in old_key:
            new_key = old_key.replace('.decoder.norm_out.', '.decoder.head.0.')
        if '.encoder.conv_in.' in new_key:
            new_key = new_key.replace('.encoder.conv_in.', '.encoder.conv1.')
        if '.decoder.conv_in.' in new_key:
            new_key = new_key.replace('.decoder.conv_in.', '.decoder.conv1.')
        if '.encoder.conv_out.' in new_key:
            new_key = new_key.replace('.encoder.conv_out.', '.encoder.head.2.')
        if '.decoder.conv_out.' in new_key:
            new_key = new_key.replace('.decoder.conv_out.', '.decoder.head.2.')
        new[new_key] = sd[raw_key]
    return new

t = time.time()
assert vae_cfg.get("latent_channels", 16) == 16, "VAE CONFIG: latent_channels != 16 (defaults would not match)"
vae = AutoencoderKLWan()
log("vae built from defaults (latent_channels=16; config matches native defaults per doc §3)")
# Rebuild decoder.upsamples to the checkpoint's progression. The native
# Decoder3d halves in_dim at blocks 1-3; the checkpoint does not halve at
# block 1 (RB(192,384) re-expands) and keeps block 2 at 192. Indices follow
# the native layout (3 RBs per block, resample after blocks 0-2 at 3/7/11).
vae.model.decoder.upsamples = torch.nn.Sequential(
    ResidualBlock(384, 384), ResidualBlock(384, 384), ResidualBlock(384, 384),
    Resample(384, "upsample3d"),
    ResidualBlock(192, 384), ResidualBlock(384, 384), ResidualBlock(384, 384),
    Resample(384, "upsample3d"),
    ResidualBlock(192, 192), ResidualBlock(192, 192), ResidualBlock(192, 192),
    Resample(192, "upsample2d"),
    ResidualBlock(96, 96), ResidualBlock(96, 96), ResidualBlock(96, 96),
)
log("vae decoder.upsamples rebuilt to checkpoint progression (15 modules)")
vae_sd = load_file(os.path.join(VAE_DIR, "diffusion_pytorch_model.safetensors"))
vae_converted = convert_vae_keys(vae_sd)
log("vae keys converted: %d raw -> %d converted" % (len(vae_sd), len(vae_converted)))
assert len(vae_converted) == 194, "VAE CONVERT: expected 194 converted keys, got %d" % len(vae_converted)
remapped_keyset_check(vae, vae_converted, "vae")
try:
    vae.load_state_dict(vae_converted, strict=True)
except RuntimeError as e:
    with open(os.path.join(OUT, "fun-inp-proof-report.json"), "w") as f:
        json.dump(REPORT, f, indent=2, default=str)
    raise SystemExit("VAE LOAD FAILED (v8 rebuild): %s" % str(e)[:500])
vae = vae.to(torch.float16)
del vae_sd, vae_converted
log("vae loaded in %.1f s (decoder rebuilt, strict=True, 194/194 keys)" % (time.time() - t))
REPORT["vae_load_s"] = round(time.time() - t, 1)
REPORT["vae_rebuild"] = {"progression": "checkpoint (384,384),(192->384),(192,192),(96,96)", "keys": 194, "strict": True}

scheduler = FlowMatchEulerDiscreteScheduler()
log("scheduler:", scheduler.__class__.__name__, "| config:", {k: str(v) for k, v in dict(scheduler.config).items()})
REPORT["scheduler"] = scheduler.__class__.__name__
REPORT["scheduler_config"] = {k: str(v) for k, v in dict(scheduler.config).items()}

t = time.time()
pipe = WanFunInpaintPipeline(tokenizer=tok, text_encoder=t5, vae=vae,
                             transformer=transformer, clip_image_encoder=clip,
                             scheduler=scheduler)
log("WanFunInpaintPipeline built in %.1f s" % (time.time() - t))
assert pipe.text_encoder is t5, "text_encoder was NOT the loaded UMT5"
assert pipe.tokenizer is tok, "tokenizer was NOT the loaded tokenizer"
log("text_encoder/tokenizer: loaded components confirmed")
REPORT["pipeline_build_s"] = round(time.time() - t, 1)
REPORT["rss_gib_after_pipeline"] = rss_gib()

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
a_clip = dtype_audit(pipe.clip_image_encoder, "clip_image_encoder")
a_t5 = dtype_audit(pipe.text_encoder, "text_encoder (CPU)")
bf16_before = sum(c.get("torch.bfloat16", 0) for c in (a_tr, a_vae, a_clip, a_t5))
log("bf16 params before sampling: %d" % bf16_before)
assert bf16_before == 0, "BF16 PARAMS PRESENT BEFORE SAMPLING: %d" % bf16_before
log("FP16 VERIFIED BEFORE SAMPLING: 0 bf16 params; is_bf16_supported=%s" % torch.cuda.is_bf16_supported())
REPORT["dtype_audit_before"] = {"transformer": a_tr, "vae": a_vae,
                                "clip_image_encoder": a_clip, "text_encoder": a_t5,
                                "bf16_params": 0}

# ---------- model CPU offload ----------
# All four modules resident would be ~16.24 GB > the 15.36 GB T4. Diffusers
# model CPU offload keeps the text encoder on CPU except while encoding
# and the transformer + VAE + CLIP on GPU during denoising. If this fails,
# that is a recorded blocker — no fallback in-run.
try:
    pipe.enable_model_cpu_offload()
    log("model CPU offload ENABLED (sequence: %s)" % pipe.model_cpu_offload_seq)
    REPORT["cpu_offload"] = "enabled"
except Exception as e:
    import traceback
    traceback.print_exc()
    raise SystemExit("MODEL CPU OFFLOAD FAILED (blocker): %s" % e)
log("VRAM after offload: %.2f GiB; RSS %.2f GiB" % (
    torch.cuda.memory_allocated() / 2**30, rss_gib()))
torch.cuda.reset_peak_memory_stats()
"""

CELL6 = r"""# THE GENERATION — one run only.
# Conditioning layout (native pipeline semantics, verified from the source):
#   video [1,3,17,576,1024] float in [0,1]: frame 0 = first keyframe,
#   frame 16 = last keyframe, middle frames ZERO.
#   mask_video [1,1,17,576,1024]: 0 at the given frames (keep), 255 at the
#   middle frames (generate). mask==255 everywhere would be T2V mode.
first_img = Image.open(FIRST).convert("RGB")
last_img = Image.open(LAST).convert("RGB")
log("keyframes: first %s, last %s" % (first_img.size, last_img.size))
assert first_img.size == (1024, 576) and last_img.size == (1024, 576)

def img_to_chw(img):
    return torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0).permute(2, 0, 1)

video = torch.zeros(1, 3, 17, 576, 1024, dtype=torch.float32)
video[0, :, 0] = img_to_chw(first_img)
video[0, :, 16] = img_to_chw(last_img)
mask_video = torch.full((1, 1, 17, 576, 1024), 255.0, dtype=torch.float32)
mask_video[0, 0, 0] = 0.0
mask_video[0, 0, 16] = 0.0
log("video tensor %s float32 [0,1]; mask_video %s (0 at frames 0,16; 255 elsewhere)" % (
    tuple(video.shape), tuple(mask_video.shape)))
REPORT["conditioning"] = {
    "video_shape": [int(x) for x in video.shape],
    "mask_shape": [int(x) for x in mask_video.shape],
    "mask_values": "0 at frames 0 and 16 (given); 255 at frames 1-15 (generate)",
    "clip_image": None,
    "clip_image_note": "None: native pipeline runs CLIP on a black image and zeroes the result",
}

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
    prompt=PROMPT,
    negative_prompt="",
    video=video,
    mask_video=mask_video,
    num_frames=17,
    height=576,
    width=1024,
    num_inference_steps=50,
    guidance_scale=6.0,
    generator=gen,
    output_type="pil",
    return_dict=True,
    callback_on_step_end=cb,
    callback_on_step_end_tensor_inputs=["latents"],
    clip_image=None,
    max_sequence_length=512,
)
torch.cuda.synchronize()
t_ret = time.time()
frames_t = out.videos
log("pipeline returned videos %s %s" % (tuple(frames_t.shape), frames_t.dtype))
assert tuple(frames_t.shape) == (1, 17, 576, 1024, 3), "UNEXPECTED OUTPUT SHAPE: %s" % (tuple(frames_t.shape),)
assert len(step_times) == 50, "EXPECTED 50 STEPS, SAW %d" % len(step_times)

t_last_step = step_times[-1]
sampling_s = t_last_step - t_call
decode_s = t_ret - t_last_step
total_gen_s = t_ret - t_call
per_step = [round(step_times[i + 1] - step_times[i], 2) for i in range(len(step_times) - 1)]
peak_vram = torch.cuda.max_memory_allocated() / 2**30
log("TIMING: sampling = %.1f s" % sampling_s)
log("TIMING: decode + post = %.1f s" % decode_s)
log("TIMING: total generate call = %.1f s" % total_gen_s)
log("per-step times (s): %s" % per_step)
log("per-step VRAM (GiB): %s" % step_vram)
log("peak VRAM during generation: %.2f GiB" % peak_vram)
log("latent dtypes seen: %s" % sorted(set(latent_dtypes)))
REPORT["generation"] = {
    "num_frames": 17, "height": 576, "width": 1024, "num_inference_steps": 50,
    "guidance_scale": 6.0, "seed": 42, "max_sequence_length": 512,
    "sampling_s": round(sampling_s, 1), "decode_s": round(decode_s, 1),
    "total_generate_s": round(total_gen_s, 1),
    "per_step_s": per_step, "per_step_vram_gib": step_vram,
    "peak_vram_gib": round(peak_vram, 2),
    "latent_dtypes": sorted(set(latent_dtypes)),
    "steps_seen": len(step_times),
}
REPORT["rss_gib_after_generation"] = rss_gib()

# ---------- DTYPE AUDIT (after sampling) ----------
log("DTYPE AUDIT (after sampling):")
b_tr = dtype_audit(pipe.transformer, "transformer")
b_vae = dtype_audit(pipe.vae, "vae")
b_clip = dtype_audit(pipe.clip_image_encoder, "clip_image_encoder")
b_t5 = dtype_audit(pipe.text_encoder, "text_encoder")
bf16_after = sum(c.get("torch.bfloat16", 0) for c in (b_tr, b_vae, b_clip, b_t5))
log("bf16 params after sampling: %d" % bf16_after)
assert bf16_after == 0, "BF16 PARAMS PRESENT AFTER SAMPLING: %d" % bf16_after
log("FP16 VERIFIED AFTER SAMPLING: 0 bf16 params")
REPORT["dtype_audit_after"] = {"transformer": b_tr, "vae": b_vae,
                               "clip_image_encoder": b_clip, "text_encoder": b_t5,
                               "bf16_params": 0}
"""

CELL7 = r"""# Export + output integrity. MP4 must be yuv420p (phone-playback law).
import imageio.v2 as imageio

frames_np = (frames_t[0].cpu().numpy() * 255.0).round().astype(np.uint8)
assert frames_np.shape == (17, 576, 1024, 3), "FRAME ARRAY SHAPE: %s" % (frames_np.shape,)
log("frames array %s uint8" % (frames_np.shape,))
finite_frames = bool(np.isfinite(frames_np.astype(np.float32)).all())
log("frames finite: %s; pixel range [%d, %d]; mean %.1f" % (
    finite_frames, int(frames_np.min()), int(frames_np.max()), float(frames_np.mean())))
assert finite_frames, "NON-FINITE PIXELS IN OUTPUT FRAMES"
REPORT["frames_finite"] = finite_frames
REPORT["frames_pixel_mean"] = round(float(frames_np.mean()), 1)

MP4 = os.path.join(OUT, "fun-inp-proof-17f.mp4")
ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
t = time.time()
writer = imageio.get_writer(
    MP4, fps=24, codec="libx264", quality=8,
    ffmpeg_params=["-pix_fmt", "yuv420p", "-movflags", "+faststart",
                   "-profile:v", "high", "-preset", "medium"])
for f in frames_np:
    writer.append_data(f)
writer.close()
log("MP4 written in %.1f s: %s (%.2f MiB)" % (time.time() - t, MP4, os.path.getsize(MP4) / 2**20))
REPORT["mp4"] = {"path": MP4, "bytes": os.path.getsize(MP4), "fps": 24}

# Frame PNGs + contact strip (frames 0, 4, 8, 12, 16) for the by-eye check.
for i, f in enumerate(frames_np):
    Image.fromarray(f).save(os.path.join(OUT, "frame-%02d.png" % i))
strip = Image.new("RGB", (1024 * 5, 576))
for j, i in enumerate([0, 4, 8, 12, 16]):
    strip.paste(Image.fromarray(frames_np[i]), (1024 * j, 0))
strip.save(os.path.join(OUT, "contact-strip.png"))
log("frame PNGs + contact strip written")

# Probe with ffmpeg -i (stderr parse) + full decode count via imageio.
res = subprocess.run([ffmpeg_exe, "-i", MP4], capture_output=True, text=True)
probe = res.stderr
log("ffmpeg -i (video line):")
for ln in probe.splitlines():
    if "Video:" in ln or "Duration:" in ln:
        log("  ", ln.strip())
assert "yuv420p" in probe, "MP4 IS NOT yuv420p"
assert "1024x576" in probe, "MP4 IS NOT 1024x576"
assert "h264" in probe, "MP4 IS NOT h264"
REPORT["probe"] = {"pix_fmt": "yuv420p", "resolution": "1024x576", "codec": "h264"}

reader = imageio.get_reader(MP4)
n_decoded = 0
for _ in reader:
    n_decoded += 1
reader.close()
log("full decode: %d frames" % n_decoded)
assert n_decoded == 17, "DECODED %d FRAMES, EXPECTED 17" % n_decoded
REPORT["decoded_frames"] = n_decoded

mp4_sha = hashlib.sha256(open(MP4, "rb").read()).hexdigest()
log("MP4 sha256: %s" % mp4_sha)
REPORT["mp4_sha256"] = mp4_sha
REPORT["total_elapsed_s"] = round(time.time() - T0, 1)
REPORT["wall_clock_min"] = round((time.time() - T0) / 60, 1)
with open(os.path.join(OUT, "fun-inp-proof-report.json"), "w") as f:
    json.dump(REPORT, f, indent=2, default=str)
log("report written: %s" % os.path.join(OUT, "fun-inp-proof-report.json"))
log("TOTAL ELAPSED: %.1f min" % ((time.time() - T0) / 60))
"""

CELL8 = r"""## End of proof

**=== FUN-INP PROOF COMPLETE — ONE RUN ONLY. STOP. ===**

The report is `output/fun-inp-proof-report.json`; the clip is `output/fun-inp-proof-17f.mp4`; the by-eye check is `output/contact-strip.png`.

What the report must contain for the FP16 verdict to be YES:
- `dtype_audit_before.bf16_params == 0` AND `dtype_audit_after.bf16_params == 0`
- `generation.steps_seen == 50`, `decoded_frames == 17`
- `probe.pix_fmt == "yuv420p"`, `mp4_sha256` recorded, `peak_vram_gib` recorded

If any cell raised SystemExit, the blocker is the verdict: record it exactly, do not work around it, do not re-push without authorisation.
"""

CELLS = [
    md_cell(CELL0),
    code_cell(CELL1),
    code_cell(CELL2),
    code_cell(CELL3),
    code_cell(CELL4),
    code_cell(CELL5),
    code_cell(CELL6),
    code_cell(CELL7),
    md_cell(CELL8),
]

NB = {
    "cells": CELLS,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.11.0"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

METADATA = {
    "id": "oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01",
    "title": "NOVA GPU Cloud — Fun-InP proof 20261125-01",
    "code_file": "fun-inp-proof.ipynb",
    "language": "python",
    "kernel_type": "notebook",
    "is_private": "true",
    "enable_gpu": "true",
    "enable_tpu": "false",
    "enable_internet": "true",
    "machine_shape": "NvidiaTeslaT4",
    "dataset_sources": [
        "oliversmithh/nova-ltx-proof-keyframes-20261124"
    ],
    "competition_sources": [],
    "kernel_sources": [],
    "model_sources": [
        "thiminhnht/umt5-xxl-fp16/pytorch/default/1"
    ],
}

MANIFEST = {
    "modelId": "wan2.1-fun-inp-1.3b",
    "route": "videox-fun-native-fp16",
    "source": {
        "repo": "alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP",
        "conversion": "weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers",
        "pipeline_code": "aigc-apps/VideoX-Fun",
        "pipeline_commit": "98fffa929bb373edcbfa3620e9aa05cd65a53103",
        "pipeline_commit_date": "2026-11-24T03:20:36Z",
        "licence": "Apache 2.0",
        "weights_via": "scoped huggingface_hub download of the conversion (transformer/vae/image_encoder/tokenizer/scheduler/model_index.json only, ~4.9 GB); the conversion text_encoder (22.5 GB FP32) is NOT downloaded",
        "text_encoder_via": "Kaggle Model thiminhnht/umt5-xxl-fp16 (umt5_xxl_fp16.safetensors, 11.37 GB, 243 tensors all F16, transformers-format keys, MIT); mounted read-only",
        "notes": "The native pipeline is WanFunInpaintPipeline (36 in_channels); the diffusers WanImageToVideoPipeline cannot drive it. Text encoder is transformers UMT5EncoderModel (disclosed substitution for the native custom WanT5EncoderModel class — same weights/architecture/FP16; the native fp16_clamp safety net is absent, embeddings are finite-checked). Precomputed prompt_embeds are NOT passed (native __call__ element-wise-adds directly-passed embeds); prompt= string is used with diffusers model CPU offload (all four modules resident would be 16.24 GB > 15.36 GB T4).",
    },
    "files": [
        {
            "path": "transformer/diffusion_pytorch_model.safetensors (conversion)",
            "role": "transformer-1.3b-inp-36ch",
            "sizeBytes": 3363000000,
            "required": True,
            "note": "approx. 3.13 GiB, 1,013 tensors all BF16 (verified by safetensors-header Range read 25 Nov); cast to FP16 on load. v7: weights are diffusers-named; the native class is native-named and from_pretrained does NOT rename — the notebook remaps keys (1,013 -> 983, 30 dropped norm_added_q, 0 shape mismatches, verified). Native build: model_type='i2v', dim=1536, heads=12, layers=30, ffn_dim=8960, in_dim=36, out_dim=16.",
        },
        {
            "path": "vae/diffusion_pytorch_model.safetensors (conversion)",
            "role": "vae",
            "sizeBytes": 515000000,
            "required": True,
            "note": "0.48 GB, 194 tensors all F32 (verified 25 Nov); cast to FP16 on load. v8: the native Decoder3d builds a different channel progression than this conversion's VAE decoder (43 shape mismatches + 2 name mismatches of 194 keys); the notebook constructs the VAE directly, rebuilds decoder.upsamples with the checkpoint's progression, converts the keys with a faithful port of the native converter, verifies the keyset exactly, then loads with strict=True.",
        },
        {
            "path": "image_encoder/model.safetensors (conversion)",
            "role": "clip-image-encoder",
            "sizeBytes": 1350000000,
            "required": True,
            "note": "1.26 GB, 520 tensors all BF16 (verified 25 Nov); cast to FP16 on load. v7: the file is model.safetensors, NOT diffusion_pytorch_model.safetensors; the native CLIPModel is open_clip XLMRobertaCLIP (vision + text tower) while the conversion is transformers CLIP-ViT-H-14 (vision only) — the notebook applies verified surgery (520 -> 392 visual params, 0 shape mismatches); the text tower is expected-missing.",
        },
        {
            "path": "tokenizer/ (conversion)",
            "role": "tokenizer",
            "sizeBytes": None,
            "required": True,
        },
        {
            "path": "umt5_xxl_fp16.safetensors (Kaggle mount)",
            "role": "text-encoder-umt5-xxl-fp16",
            "sizeBytes": 11370000000,
            "required": True,
            "note": "11.37 GB, 243 tensors (242 F16 + 1 U8 spiece_model, the SentencePiece model bytes packed into the weights file, not a parameter; the canonical index stores the embedding as shared.weight only). v5 fix: call t5.tie_weights() after load_state_dict or encoder.embed_tokens.weight stays randomly initialised.",
        },
        {
            "path": "first_frame.png",
            "role": "keyframe-first",
            "sizeBytes": 753840,
            "sha256": "b746e5fa74332b86bdf2e088e02c86e9741e5c94f70bfe01d8bf2ca5d05055fb",
            "required": True,
        },
        {
            "path": "last_frame.png",
            "role": "keyframe-last-1.12x-zoom",
            "sizeBytes": 849154,
            "sha256": "c8218a25a535c498168192b86104f470ddb84408d1436922cf93d35eb76ed3eb",
            "required": True,
        },
    ],
    "pins": {
        "diffusers": "0.40.0",
        "transformers": "5.16.1",
        "torch": "Kaggle image (2.11.0+cu130, not pinned)",
        "videox_fun_commit": "98fffa929bb373edcbfa3620e9aa05cd65a53103",
        "scheduler": "FlowMatchEulerDiscreteScheduler (diffusers defaults)",
    },
    "proof": {
        "frames": 17,
        "height": 576,
        "width": 1024,
        "steps": 50,
        "guidance_scale": 6.0,
        "seed": 42,
        "max_sequence_length": 512,
        "gpu": "1x Tesla T4 (cuda:0 only)",
        "process": "single",
    },
}

README = """# Wan2.1-Fun-1.3B-InP — one-clip proof (2026-11-25)

Authorisation: Shina 25 Nov 2026 ~07:46 WAT ("connect to those engine you found"); reviewer 25 Nov 2026 (morning, thread 17): ONE controlled Kaggle proof, strict stop if it fails the T4 memory/FP16 gate, must not delay LTX longer-clip work.

## What this proves

Whether Fun-InP loads AND executes in FP16 on one Tesla T4 — or fails. Wan is BF16-native; T4 has no BF16 tensor cores. That is the whole question.

## Design (verified 25 Nov 2026 against the real sources)

- Pipeline: VideoX-Fun `WanFunInpaintPipeline` (native, pinned commit `98fffa92…`), NOT the diffusers `WanImageToVideoPipeline` (32 channels vs the InP transformer's 36). Scheduler: `FlowMatchEulerDiscreteScheduler`.
- Weights: transformer + VAE + CLIP + tokenizer from the diffusers conversion `weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers` via a scoped download (~4.9 GB). The conversion's 22.5 GB FP32 text encoder is NOT downloaded.
- Text encoder: umT5-XXL via Kaggle Model mount `thiminhnht/umt5-xxl-fp16` (11.37 GB FP16), loaded into transformers `UMT5EncoderModel` — a disclosed substitution for the native custom `WanT5EncoderModel` class (same weights/architecture/FP16; native `fp16_clamp` absent, embeddings finite-checked).
- Precomputed prompt_embeds are NOT passed (the native `__call__` element-wise-adds directly-passed embeds). The pipeline is called with `prompt=` + `negative_prompt=""`; diffusers model CPU offload is enabled because all four modules resident would be 16.24 GB > the 15.36 GB T4.
- Same dragon keyframes + prompt as LTX run 6; 17 frames, 1024×576, 50 steps, guidance 6.0, seed 42.

## Status (25 Nov 2026 ~22:00 WAT)

**v9 AUTHORISED — night run (owner, 25 Nov ~18:21 WAT: "retry the Fun-InP proof at night; TEN attempts total, then stop").** Single change vs v8: restore `ftfy` to the pinned pip install list (the v2 fix, verbatim). v8 re-hit the v1 `ftfy` import error at CELL2 because the v7 build-script sync had dropped the `ftfy` entry v2 added — a regression, NOT a T4/FP16 gate failure — so the already-verified VAE decoder rebuild (194/194 keys exact) was never exercised. The key-remap discovery is complete and verified: transformer remap (1,013 checkpoint keys → 983 native i2v params, 30 dropped `norm_added_q`, 0 shape mismatches) and CLIP surgery (520 → 392 visual params, 0 shape mismatches) both proven, and the notebook's own remap/surgery functions re-tested against the real key files (983/983 + 392/392 exact). **v7 was STOPPED, NOT PUSHED** on the VAE blocker. Attempt 9 of 10; if v9 fails, v10 is the LAST attempt; a T4 memory/FP16 gate failure stops the proof immediately (reviewer strict stop). v1–v8 ≈ 0.34 GPU-h total.

## Layout

- `fun-inp-proof.ipynb` — the notebook (only this file is pushed)
- `kernel-metadata.json` — GPU T4, internet on, keyframes dataset + umT5-XXL FP16 model mount
- `staging-manifest.json` — VDP-04 manifest (pins, sizes, hashes)
- `output/` — kernel outputs land here on download

## Run (ONE RUN ONLY — stop after the first output)

```
python3 scripts/build-fun-inp-proof-package.py
cd packages/fun-inp-proof-20261125-01
kaggle kernels push -p . -t 10800
kaggle kernels status oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01
kaggle kernels output oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01 -p output
```

Kaggle CLI: `gpu-cloud/.venv-kaggle` (kaggle 2.2.5, username oliversmithh).
Expected cost ~0.3–0.6 GPU-h for a full run; expected wall time ~15–40 min (50 steps + model CPU offload swaps).

## After the run

- Read `output/fun-inp-proof-report.json` for the FP16 verdict (bf16 params before AND after == 0), peak VRAM, timings.
- Verify motion BY EYE from `output/contact-strip.png` (frames 0/4/8/12/16) — MAD numbers do not settle it (LTX run-5 lesson).
- Store the clip in the GPU Cloud store (same pattern as the LTX proof clip) and write the result into `docs/fun-inp-connection-2026-11-25.md`.
- If the run fails: record the exact blocker in the report and STOP. No re-push without authorisation.
"""


def main():
    os.makedirs(PKG, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(PKG, "fun-inp-proof.ipynb"), "w") as f:
        json.dump(NB, f, indent=1)
    with open(os.path.join(PKG, "kernel-metadata.json"), "w") as f:
        json.dump(METADATA, f, indent=2)
    with open(os.path.join(PKG, "staging-manifest.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2)
    with open(os.path.join(PKG, "README.md"), "w") as f:
        f.write(README)
    print("cells:", len(CELLS))
    print("wrote:", PKG)


if __name__ == "__main__":
    main()
