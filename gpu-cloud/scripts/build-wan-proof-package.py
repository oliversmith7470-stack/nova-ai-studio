#!/usr/bin/env python3
"""Build the NOVA GPU Cloud Wan 2.2 one-clip proof package.

Writes gpu-cloud/packages/wan-proof-20261124-01/:
  wan-proof.ipynb        — the self-contained notebook (only this file is sent on push)
  kernel-metadata.json   — kernel metadata (GPU T4 x2 via machine_shape, internet on,
                           barbieverse/wan2-2-5b-weights dataset mount)
  staging-manifest.json  — the VDP-04 staging manifest
  README.md              — runbook

Design (all verified 24 Nov 2026 against the real sources, not the plan):
  - Model: Wan 2.2 TI2V-5B, official vendor path (Wan-Video/Wan2.2 generate.py).
    Native 720P is 1280x704; vendor defaults frame_num=121 (5 s @ 24 fps),
    sample_steps=50, guide 5.0, shift 5.0 (wan/configs/wan_ti2v_5B.py).
  - Weights via the dataset mount /kaggle/input/wan2-2-5b-weights/ (flat,
    34.18 GB — does NOT fit /kaggle/working). Never downloaded.
  - Tokenizer remedy: the google/ dir is absent from that dataset; the
    notebook downloads google/umt5-xxl (4 files, ~5 MB) in-session from the
    OFFICIAL Wan-AI repo and assembles a symlinked ckpt dir (the mount is
    read-only, so symlinks + a real google/ dir). Verified: the tokenizer
    loads from os.path.join(ckpt_dir, 'google/umt5-xxl')
    (wan/textimage2video.py:93 -> T5EncoderModel -> AutoTokenizer).
  - flash_attn is NOT installed: wan/modules/attention.py falls back to
    torch SDPA when it is absent, and flash-attn 2 cannot run on a T4
    (sm75; needs sm80+). Recorded in the report, not hidden.
  - First code cell is the reviewer's three-gate smoke check (Gate A GPU,
    Gate B internet, Gate C storage, recorded independently) with a
    FAIL-FAST exit if any gate fails — a CPU fallback NEVER reaches model
    work. No model download/loading inside the smoke cell.
  - Start image is procedurally generated in-session (PIL, seeded) —
    VDP-06: synthetic prompt + non-sensitive test image only.
  - Papermill: every long cell prints progress with flush=True.
  - v2 LESSON (24 Nov 2026): installing transformers<=4.51.3 alone
    downgraded huggingface-hub 1.33.0 -> 0.36.2, which broke Kaggle's
    preinstalled diffusers 0.42.0 (needs hub >=1.32; imports
    resolve_revision, absent from hub 0.36.2) — generate.py died at
    `import wan`. v3 pins the four interacting packages EXACTLY
    (transformers==4.51.3, diffusers==0.32.2, huggingface-hub==0.36.2,
    tokenizers==0.21.4), installs the whole set in ONE pip invocation,
    checks the five extra `import wan` deps (peft, decord, einops,
    safetensors, librosa), and verifies with `generate.py --help`
    in-cell. The pin set was verified locally in a venv (CPU torch +
    monkeypatched torch.cuda.current_device) running the real
    generate.py --help against the cloned repo.
  - v3 LESSON (24 Nov 2026): the model loaded and ran 4,283 s, then
    OOM'd on the FIRST DiT forward (step 0/50): 13.04 GiB allocated
    (DiT bf16 ~10.3 GB + VAE fp32 ~2.8 GB resident), tried to allocate
    1.88 GiB (the fp32 per-token time projection) with 1.14 GiB free.
    Single-T4 does NOT fit the official 5B path at 121 frames — the
    weights alone leave ~1.5 GB for all activations. The 71 min before
    step 0 went to loading 34 GB + T5-on-CPU encoding (two encodes),
    and generate.py's stdout was block-buffered, so nothing was
    visible until the exit flush. v4 launches on BOTH provisioned
    T4s via torchrun: --ulysses_size 2 (sequence-parallel, halves
    per-GPU activations) + --dit_fsdp (DiT weights sharded bf16 via
    FSDP mixed precision, ~5.15 GB/rank). T5 stays on CPU: T5-FSDP
    would collide at construction (11 GB shard + DiT + VAE > 16 GB),
    because use_sp/dit_fsdp force init_on_cpu=False. Per-rank
    estimate ~9.9 GB vs 14.56 GB. PYTHONUNBUFFERED=1 keeps progress
    live; -t raised to 10800 (3 h).
  - v4 LESSON (24 Nov 2026): torchrun is RAM-blocked on Kaggle, NOT
    VRAM-blocked. Rank 1 was SIGKILLed by the Linux OOM killer at ~44 s
    (peak VRAM only 363 MB): two torchrun workers each load the full
    ~34 GB stack (T5 11 GB + DiT fp32 20 GB + VAE 2.8 GB) and Kaggle's
    ~30 GB host RAM cannot hold both. All three gates, the weights
    check, the dependency check and the tokenizer remedy passed a
    fourth time — only the multi-process launch is at fault. Cost
    0.04 GPU-h; total proof spend 1.88h of 30h.
  - v5 DESIGN (24 Nov 2026): single-process pipeline-parallel. Revert
    torchrun/ulysses/dit_fsdp; one process, plain `python generate.py`
    (v3's RAM profile, proven to fit). Two NOVA patches applied
    in-session after the clone (cell 3b, exact-match anchors asserted):
    (1) wan/textimage2video.py, BOTH branches — after
    `self.model.to(self.device)`, move DiT blocks 15-29 + head to
    cuda:1 when a second GPU exists; (2) wan/modules/model.py
    forward — device-detecting transfer in the block loop (when the
    next block sits on a different device than x, move x, e0,
    context, freqs to it), head runs on the head's device with e
    moved to match, return moves back to the input device. Both
    patches are self-healing no-ops when unsplit. Margins: cuda:0
    ~11.5 GB, cuda:1 ~8.8 GB vs 14.56 GB each. Device audit complete
    (grid_sizes/seq_lens are CPU tensors the stock code already
    handles; rope_apply/unpatchify use .tolist(); flash_attention
    moves k_lens to q.device). NOTE: the head takes the local time
    embedding `e` ([B, L1, C]), NOT kwargs['e'] (e0, [B, L, 6, dim])
    — the head transfer moves local `e` to the head's device.
    Host-RAM reporting added to the gate cell (VDP-03).
    PYTHONUNBUFFERED=1 + expandable_segments + -t 10800 kept.

Usage: python3 scripts/build-wan-proof-package.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..", "packages", "wan-proof-20261124-01")

JOB_ID = "wan-proof-20261124-01"
KERNEL_ID = "oliversmithh/nova-gpu-cloud-wan-proof-20261124-01"
MOUNT = "/kaggle/input/wan2-2-5b-weights"
PROMPT = ("An ash-grey dragon with ember-cracked wings rests on a misty "
          "mountain ridge at dawn, slow cinematic camera push-in, mist "
          "drifting across the ridge, embers glowing faintly along the "
          "dragon's wings, epic fantasy film still, dramatic dawn light")


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


CELLS = []

CELLS.append(md_cell(
    "# NOVA GPU Cloud — Wan 2.2 one-clip proof (Phase 1, VDP-05)\n"
    "\n"
    "**Job:** wan-proof-20261124-01 | **Model:** Wan 2.2 TI2V-5B (official route) | **Provider:** kaggle-t4 | **Version:** v5 (single-process pipeline-parallel)\n"
    "\n"
    "One 5-second clip, native 1280x704, vendor defaults. This notebook proves the model runs on a free T4 — it is a proof exercise, not production approval.\n"
    "\n"
    "**Prompt:** " + PROMPT + "\n"
    "\n"
    "> VDP-06: synthetic prompt + procedurally generated test image only. No private user media, credentials, or real customer content may be added to this notebook.\n"
    "\n"
    "> Weights come from the dataset mount `barbieverse/wan2-2-5b-weights` (third-party mirror — sizes match the official listing exactly, hashes unverified). The `google/` tokenizer dir is absent from that dataset; the notebook downloads it in-session from the OFFICIAL Wan-AI repo (see §4).\n"
    "\n"
    "> Papermill: Kaggle runs committed notebooks via papermill, which kills a kernel that produces no output for ~4 seconds. Every long cell below prints progress with flush=True."
))

CELLS.append(md_cell(
    "## 1. Three-gate smoke check (reviewer §5 — FIRST code cell, fail-fast)\n"
    "\n"
    "Gate A GPU, Gate B internet, Gate C storage — each recorded independently. If ANY gate fails, the notebook writes a failure report and STOPS before any model work. No model download, loading, or generation happens in this cell."
))

CELLS.append(code_cell('''import json, os, platform, socket, subprocess, sys, time, urllib.request
from datetime import datetime, timezone

RUN_STARTED_UTC = datetime.now(timezone.utc).isoformat()
JOB_ID = "wan-proof-20261124-01"
WORKING = "/kaggle/working"
REPORT_PATH = os.path.join(WORKING, "wan-proof.report.json")

print(f"NOVA GPU Cloud — Wan proof {JOB_ID}", flush=True)
print(f"run started (UTC): {RUN_STARTED_UTC}", flush=True)
print(f"python {sys.version.split()[0]} | platform {platform.platform()}", flush=True)

gates = {}

# ---- Gate A: GPU provisioning ----
print("--- Gate A: GPU ---", flush=True)
gate_a = {"name": "gpu", "pass": False, "detail": {}}
try:
    smi = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=30)
    gate_a["detail"]["nvidia_smi_exit"] = smi.returncode
    gate_a["detail"]["nvidia_smi_stdout"] = smi.stdout.strip()
    print(smi.stdout, flush=True)
    q = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader"], capture_output=True, text=True, timeout=30)
    gate_a["detail"]["gpu_query"] = [ln for ln in q.stdout.strip().splitlines() if ln.strip()]
    print("query: " + " | ".join(gate_a["detail"]["gpu_query"]), flush=True)
except Exception as e:
    gate_a["detail"]["nvidia_smi_error"] = f"{type(e).__name__}: {e}"
    print(f"nvidia-smi FAILED: {type(e).__name__}: {e}", flush=True)
try:
    import torch
    gate_a["detail"]["torch_version"] = torch.__version__
    gate_a["detail"]["cuda_version"] = torch.version.cuda
    gate_a["detail"]["cuda_available"] = torch.cuda.is_available()
    gate_a["detail"]["device_count"] = torch.cuda.device_count() if torch.cuda.is_available() else 0
    print(f"torch {torch.__version__} | cuda {torch.version.cuda} | cuda_available={torch.cuda.is_available()} | devices={gate_a['detail']['device_count']}", flush=True)
    if torch.cuda.is_available():
        gate_a["detail"]["devices"] = []
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            gate_a["detail"]["devices"].append({"index": i, "name": p.name, "vram_gb": round(p.total_memory / 1e9, 1)})
            print(f"device {i}: {p.name} | VRAM {p.total_memory / 1e9:.1f} GB", flush=True)
        # short GPU computation test (reviewer §5)
        a = torch.randn(512, 512, device="cuda")
        b = torch.randn(512, 512, device="cuda")
        c = torch.matmul(a, b)
        gate_a["detail"]["cuda_tensor_op"] = {"ok": True, "checksum": round(float(c.sum().item()), 2)}
        print(f"CUDA tensor op OK (checksum {gate_a['detail']['cuda_tensor_op']['checksum']})", flush=True)
        del a, b, c
        torch.cuda.empty_cache()
except Exception as e:
    gate_a["detail"]["torch_error"] = f"{type(e).__name__}: {e}"
    print(f"torch check FAILED: {type(e).__name__}: {e}", flush=True)
gate_a["pass"] = (
    gate_a["detail"].get("nvidia_smi_exit") == 0
    and gate_a["detail"].get("cuda_available") is True
    and gate_a["detail"].get("device_count", 0) >= 1
    and gate_a["detail"].get("cuda_tensor_op", {}).get("ok") is True
)
print(f"Gate A (GPU): {'PASS' if gate_a['pass'] else 'FAIL'}", flush=True)
gates["A-gpu"] = gate_a

# ---- Gate B: internet ----
print("--- Gate B: internet ---", flush=True)
gate_b = {"name": "internet", "pass": False, "detail": {}}
def _fetch(url, timeout=20):
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "NOVA-GPU-Cloud-WanProof/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return {"url": url, "ok": True, "status": resp.status, "bytes": len(body), "seconds": round(time.time() - t0, 2)}
    except Exception as e:
        return {"url": url, "ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 2)}
dns = {}
for host in ("pypi.org", "huggingface.co"):
    try:
        dns[host] = socket.gethostbyname(host)
        print(f"DNS {host}: {dns[host]}", flush=True)
    except Exception as e:
        dns[host] = f"FAILED: {type(e).__name__}: {e}"
        print(f"DNS FAILED {host}: {e}", flush=True)
gate_b["detail"]["dns"] = dns
fetches = [_fetch("https://pypi.org/"), _fetch("https://huggingface.co/api/models/Wan-AI/Wan2.2-TI2V-5B")]
for r in fetches:
    print(json.dumps(r), flush=True)
gate_b["detail"]["fetches"] = fetches
gate_b["pass"] = all(isinstance(v, str) and not v.startswith("FAILED") for v in dns.values()) and all(f.get("ok") for f in fetches)
print(f"Gate B (internet): {'PASS' if gate_b['pass'] else 'FAIL'}", flush=True)
gates["B-internet"] = gate_b

# ---- Gate C: storage ----
print("--- Gate C: storage ---", flush=True)
gate_c = {"name": "storage", "pass": False, "detail": {}}
gate_c["detail"]["working_exists"] = os.path.exists(WORKING)
try:
    out = subprocess.run(["df", "-h", WORKING, "/kaggle/input"], capture_output=True, text=True, timeout=30)
    gate_c["detail"]["df"] = out.stdout.strip()
    print(out.stdout, flush=True)
except Exception as e:
    gate_c["detail"]["df_error"] = f"{type(e).__name__}: {e}"
probe = os.path.join(WORKING, ".wan-proof-write-test")
try:
    with open(probe, "w") as f:
        f.write("nova-wan-proof-write-test")
    with open(probe) as f:
        ok = f.read() == "nova-wan-proof-write-test"
    os.unlink(probe)
    gate_c["detail"]["write_read_delete"] = ok
    print(f"write/read/delete test: {'OK' if ok else 'MISMATCH'}", flush=True)
except Exception as e:
    gate_c["detail"]["write_read_delete"] = False
    gate_c["detail"]["write_error"] = f"{type(e).__name__}: {e}"
    print(f"write/read/delete test FAILED: {type(e).__name__}: {e}", flush=True)
gate_c["pass"] = gate_c["detail"]["working_exists"] and gate_c["detail"].get("write_read_delete") is True
print(f"Gate C (storage): {'PASS' if gate_c['pass'] else 'FAIL'}", flush=True)
gates["C-storage"] = gate_c

# ---- Host RAM (VDP-03 — v4 proved host RAM, not VRAM, is the binding
# constraint for multi-process launches; record the real numbers) ----
print("--- Host RAM ---", flush=True)
host_ram = {"mem_total_gb": None, "mem_available_gb": None, "source": "/proc/meminfo"}
try:
    with open("/proc/meminfo") as _f:
        for _line in _f:
            _parts = _line.split()
            if _parts[0] == "MemTotal:":
                host_ram["mem_total_gb"] = round(int(_parts[1]) / 1e6, 1)
            elif _parts[0] == "MemAvailable:":
                host_ram["mem_available_gb"] = round(int(_parts[1]) / 1e6, 1)
    print(f"host RAM: total {host_ram['mem_total_gb']} GB, available {host_ram['mem_available_gb']} GB", flush=True)
except Exception as e:
    host_ram["error"] = f"{type(e).__name__}: {e}"
    print(f"host RAM read FAILED: {type(e).__name__}: {e}", flush=True)

# ---- Fail-fast: any gate failure stops the run BEFORE any model work ----
failed = [k for k, g in gates.items() if not g["pass"]]
if failed:
    fail_report = {
        "jobId": JOB_ID, "providerId": "kaggle-t4", "status": "failed",
        "error": "fail-fast: gate(s) failed: " + ", ".join(failed),
        "completedAt": int(time.time() * 1000),
        "runStartedUtc": RUN_STARTED_UTC,
        "gates": gates,
    }
    os.makedirs(WORKING, exist_ok=True)
    with open(REPORT_PATH, "w") as f:
        json.dump(fail_report, f, indent=2)
    print(f"FAIL-FAST: gate(s) failed ({', '.join(failed)}) — stopping before any model work. Report: {REPORT_PATH}", flush=True)
    raise SystemExit("FAIL-FAST: smoke gate(s) failed — no GPU/internet/storage proof, no model work attempted")
print("ALL THREE GATES PASSED — proceeding to the proof run.", flush=True)'''))

CELLS.append(md_cell(
    "## 2. Verify staged weights at the dataset mount\n"
    "\n"
    "The 34.18 GB weights ride on the dataset mount (flat layout) — they are never downloaded or copied into `/kaggle/working`. This cell DISCOVERS the mount dynamically (standard `/kaggle/input/wan2-2-5b-weights/` or the `/kaggle/input/datasets/<owner>/<slug>/` variant) instead of hardcoding the path — v1 failed because the first push attached nothing at all. If no mount is found, it writes a failure report and stops. Every manifest file is checked for presence and truncation (same 0.5x tolerance as the VDP-04 prep test) and actual sizes are recorded."
))

CELLS.append(code_cell('''print("--- staged weights at the dataset mount ---", flush=True)
import glob as _glob
EXPECTED = [
    ("Wan2.2_VAE.pth", 2818839170),
    ("config.json", 251),
    ("configuration.json", 43),
    ("diffusion_pytorch_model-00001-of-00003.safetensors", 9825014472),
    ("diffusion_pytorch_model-00002-of-00003.safetensors", 9995661736),
    ("diffusion_pytorch_model-00003-of-00003.safetensors", 178558176),
    ("diffusion_pytorch_model.safetensors.index.json", 72865),
    ("models_t5_umt5-xxl-enc-bf16.pth", 11361920418),
]
INPUT_ROOT = "/kaggle/input"
print("/kaggle/input listing:", flush=True)
try:
    _entries = sorted(os.listdir(INPUT_ROOT))
    for _e in _entries:
        print(f"  {_e}", flush=True)
except Exception as e:
    _entries = []
    print(f"  (cannot list {INPUT_ROOT}: {type(e).__name__}: {e})", flush=True)
# Dynamic mount discovery: Kaggle usually mounts at /kaggle/input/<slug>/,
# but variants exist (/kaggle/input/datasets/<owner>/<slug>/), and a first
# push sometimes attaches nothing at all (v1 lesson). Find the diffusion
# shard wherever it is instead of hardcoding the path.
MOUNT = None
_expected_mount = os.path.join(INPUT_ROOT, "wan2-2-5b-weights")
if os.path.isdir(_expected_mount):
    MOUNT = _expected_mount
    print(f"mount found at the standard path: {MOUNT}", flush=True)
else:
    _hits = _glob.glob(os.path.join(INPUT_ROOT, "**", "diffusion_pytorch_model-00001-of-00003.safetensors"), recursive=True)
    if _hits:
        MOUNT = os.path.dirname(_hits[0])
        print(f"mount found via discovery: {MOUNT}", flush=True)
if MOUNT is None:
    _fail = {
        "jobId": JOB_ID, "providerId": "kaggle-t4", "status": "failed",
        "error": "dataset-not-mounted: barbieverse/wan2-2-5b-weights not found under /kaggle/input",
        "completedAt": int(time.time() * 1000),
        "runStartedUtc": RUN_STARTED_UTC,
        "gates": gates,
        "input_listing": _entries,
    }
    with open(REPORT_PATH, "w") as f:
        json.dump(_fail, f, indent=2)
    print("FAIL-FAST: dataset not mounted — /kaggle/input holds: " + (", ".join(_entries) if _entries else "(empty/unreadable)"), flush=True)
    print(f"failure report written: {REPORT_PATH}", flush=True)
    raise SystemExit("FAIL-FAST: dataset not mounted under /kaggle/input")
print("mount listing:", flush=True)
for name in sorted(os.listdir(MOUNT)):
    full = os.path.join(MOUNT, name)
    print(f"  {name}  {os.path.getsize(full) if os.path.isfile(full) else '<dir>'}", flush=True)
weights = {"mount": MOUNT, "files": {}, "total_bytes": 0}
missing, truncated = [], []
for name, listed in EXPECTED:
    full = os.path.join(MOUNT, name)
    if not os.path.isfile(full):
        missing.append(name)
        weights["files"][name] = {"present": False, "listed_bytes": listed}
        continue
    actual = os.path.getsize(full)
    weights["files"][name] = {"present": True, "listed_bytes": listed, "actual_bytes": actual}
    weights["total_bytes"] += actual
    if actual == 0 or actual < listed * 0.5:
        truncated.append(name)
    print(f"  {name}: {actual} bytes (listed ~{listed})", flush=True)
print(f"total staged: {weights['total_bytes']} bytes ({weights['total_bytes'] / 1e9:.2f} GB)", flush=True)
assert not missing, f"missing staged files: {missing}"
assert not truncated, f"truncated staged files: {truncated}"
google_in_mount = os.path.isdir(os.path.join(MOUNT, "google"))
weights["tokenizer_in_mount"] = google_in_mount
if google_in_mount:
    print("NOTE: google/ tokenizer dir IS present in the dataset mount (dataset updated) — the download remedy will be skipped.", flush=True)
else:
    print("google/ tokenizer dir absent from the mount (as expected) — the remedy cell downloads it from the official repo.", flush=True)
print("WEIGHTS CHECK PASSED", flush=True)'''))

CELLS.append(md_cell(
    "## 3. Install inference code (clone Wan2.2 + pip install missing packages)\n"
    "\n"
    "Needs the network (Gate B passed). Clones the vendor repo (shallow) and installs ONLY the packages that are missing or out of range — torch and friends are already in the Kaggle image and are not reinstalled. `flash_attn` is deliberately NOT installed: `wan/modules/attention.py` falls back to torch SDPA when it is absent, and flash-attn 2 cannot run on a T4 (sm75; needs sm80+).\n"
    "\n"
    "**Coordinated pin set (v2 lesson):** transformers 4.51.3 forces `huggingface-hub<1.0`, which breaks Kaggle's preinstalled diffusers 0.42.0 (needs hub ≥1.32). So the four interacting packages are pinned EXACTLY — transformers==4.51.3, diffusers==0.32.2, huggingface-hub==0.36.2, tokenizers==0.21.4 — and installed in ONE pip invocation so the resolver sees the whole set. The cell also checks the five extra packages `import wan` needs via the animate/speech2video modules (peft, decord, einops, safetensors, librosa), then verifies the whole dependency set by running `generate.py --help` — if the set is broken it fails HERE with a clear error instead of inside the generate cell. Pin set verified locally 24 Nov 2026 (venv, real `generate.py --help`)."
))

CELLS.append(code_cell('''print("--- inference code: clone Wan2.2 + install missing packages ---", flush=True)
import shutil
REPO_DIR = os.path.join(WORKING, "Wan2.2")
install_report = {"repo": {}, "packages": {}, "flash_attn": None}
def run_stream(cmd, cwd=None):
    """Run a command, streaming stdout+stderr line by line (keeps papermill alive). Returns exit code."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, cwd=cwd)
    for line in proc.stdout:
        print(line, end="", flush=True)
    proc.wait()
    return proc.returncode
if os.path.isdir(os.path.join(REPO_DIR, "wan")):
    print(f"Wan2.2 repo already present at {REPO_DIR} — skipping clone.", flush=True)
    install_report["repo"]["cloned"] = False
else:
    print("cloning Wan-Video/Wan2.2 (shallow)...", flush=True)
    rc = run_stream(["git", "clone", "--depth", "1", "https://github.com/Wan-Video/Wan2.2.git", REPO_DIR])
    assert rc == 0, f"git clone failed (exit {rc})"
    install_report["repo"]["cloned"] = True
print(f"repo at {REPO_DIR}; generate.py present: {os.path.isfile(os.path.join(REPO_DIR, 'generate.py'))}", flush=True)
assert os.path.isfile(os.path.join(REPO_DIR, "generate.py")), "generate.py missing after clone"

def pkg_version(mod_name):
    try:
        mod = __import__(mod_name)
        return getattr(mod, "__version__", "unknown")
    except Exception:
        return None
# (import_name, pip_spec, min_version, max_version) — None version = any
CHECKS = [
    ("torch", "torch>=2.4.0", "2.4.0", None),
    ("torchvision", "torchvision>=0.19.0", "0.19.0", None),
    ("torchaudio", "torchaudio", None, None),
    ("cv2", "opencv-python>=4.9.0.80", "4.9.0.80", None),
    # COORDINATED PIN SET (v2 lesson — verified locally 24 Nov 2026 in a venv
    # running the real generate.py --help): transformers 4.51.3 forces
    # huggingface-hub <1.0, which breaks Kaggle's preinstalled diffusers
    # 0.42.0 (needs hub >=1.32; imports resolve_revision, absent from hub
    # 0.36.2). These four are pinned EXACTLY and installed in ONE pip
    # invocation below so the resolver sees the whole set.
    ("diffusers", "diffusers==0.32.2", "0.32.2", "0.32.2"),
    ("transformers", "transformers==4.51.3", "4.51.3", "4.51.3"),
    ("tokenizers", "tokenizers==0.21.4", "0.21.4", "0.21.4"),
    ("huggingface_hub", "huggingface-hub==0.36.2", "0.36.2", "0.36.2"),
    ("accelerate", "accelerate>=1.1.1", "1.1.1", None),
    ("tqdm", "tqdm", None, None),
    ("imageio", "imageio[ffmpeg]", None, None),
    ("imageio_ffmpeg", "imageio-ffmpeg", None, None),
    ("easydict", "easydict", None, None),
    ("ftfy", "ftfy", None, None),
    ("dashscope", "dashscope", None, None),
    ("sentencepiece", "sentencepiece", None, None),
    ("regex", "regex", None, None),
    # Extra deps `import wan` needs via the animate/speech2video modules
    # (wan/__init__ imports all five task modules). Never checked in v1/v2.
    ("peft", "peft", None, None),
    ("decord", "decord", None, None),
    ("einops", "einops", None, None),
    ("safetensors", "safetensors", None, None),
    ("librosa", "librosa", None, None),
]
def _ver_tuple(v):
    parts = []
    for p in str(v).split("."):
        num = ""
        for ch in p:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    return tuple(parts)
to_install = []
for mod_name, pip_spec, vmin, vmax in CHECKS:
    ver = pkg_version(mod_name)
    ok = ver is not None
    if ok and vmin and _ver_tuple(ver) < _ver_tuple(vmin):
        ok = False
    if ok and vmax and _ver_tuple(ver) > _ver_tuple(vmax):
        ok = False
    install_report["packages"][mod_name] = {"installed_version": ver, "ok": ok, "pip_spec": pip_spec}
    print(f"  {mod_name}: {ver if ver else 'MISSING'} -> {'ok' if ok else 'NEEDS INSTALL (' + pip_spec + ')'}", flush=True)
    if not ok:
        to_install.append(pip_spec)
install_report["packages"]["numpy"] = {"installed_version": pkg_version("numpy"), "ok": True, "note": "recorded only; no downgrade enforced"}
print(f"  numpy: {pkg_version('numpy')} (recorded only)", flush=True)
fa_ver = pkg_version("flash_attn")
if fa_ver is None:
    install_report["flash_attn"] = "absent — SKIPPED by design (wan/modules/attention.py falls back to torch SDPA; flash-attn 2 needs sm80+, T4 is sm75)"
    print("  flash_attn: ABSENT — skipped by design (SDPA fallback; flash-attn 2 needs sm80+, T4 is sm75)", flush=True)
else:
    install_report["flash_attn"] = f"present: {fa_ver}"
    print(f"  flash_attn: {fa_ver}", flush=True)
if to_install:
    print(f"pip installing {len(to_install)} package(s) in ONE invocation (so the resolver sees the whole set):", flush=True)
    for spec in to_install:
        print(f"  {spec}", flush=True)
    rc = run_stream([sys.executable, "-m", "pip", "install", "-q"] + to_install)
    assert rc == 0, f"pip install failed (exit {rc})"
    print("pip install complete.", flush=True)
else:
    print("all packages already satisfied — nothing to install.", flush=True)
# Post-install verification (v2 lesson): run generate.py --help in a fresh
# subprocess — it executes every module-level import generate.py needs
# (import wan + all five task modules). If the dependency set is broken,
# this fails HERE with a clear error instead of inside the generate cell.
print("verifying the installed dependency set (generate.py --help)...", flush=True)
rc = run_stream([sys.executable, "generate.py", "--help"], cwd=REPO_DIR)
assert rc == 0, f"dependency verification failed: generate.py --help exited {rc} — see the output above"
install_report["dependency_check"] = "generate.py --help exit 0 (full import graph OK)"
print("DEPENDENCY CHECK PASSED (generate.py --help exit 0)", flush=True)
print("INSTALL CELL COMPLETE", flush=True)'''))

CELLS.append(md_cell(
    "## 3b. NOVA v5 patches — single-process pipeline-parallel split (2x T4)\n"
    "\n"
    "v4 proved torchrun is RAM-blocked on Kaggle (two workers each load the full ~34 GB stack; ~30 GB host RAM). v5 runs ONE process and splits the DiT itself across the two provisioned T4s with two small, exact-anchored patches to the cloned vendor code:\n"
    "\n"
    "- **Patch 1** (`wan/textimage2video.py`, BOTH generate branches): after `self.model.to(self.device)`, move DiT blocks 15–29 + head to `cuda:1` when a second GPU exists.\n"
    "- **Patch 2** (`wan/modules/model.py` forward): device-detecting transfer in the block loop — when the next block sits on a different device than `x`, move `x`, `e0`, `context`, `freqs` to it; the head runs on the head's device (with the local time embedding `e` moved to match — the head takes `e`, NOT `kwargs['e']`); the return moves back to the input device (the scheduler step combines the output with cuda:0 latents).\n"
    "\n"
    "Both patches are self-healing no-ops when the model is unsplit, and the cell is idempotent (re-running skips already-patched files). Anchor counts are asserted before any write, and both patched files are py_compile-checked. Expected VRAM: cuda:0 ~11.5 GB, cuda:1 ~8.8 GB vs 14.56 GB each."
))

CELLS.append(code_cell('''print("--- NOVA v5 patches: pipeline-parallel split across 2x T4 ---", flush=True)
# Patch 1: wan/textimage2video.py — after self.model.to(self.device) in BOTH
# generate branches (t2v + i2v), move DiT blocks 15-29 + head to cuda:1.
# Patch 2: wan/modules/model.py forward — device-detecting transfer in the
# block loop, head on the head's device, return to the input device.
# Both patches are self-healing no-ops when the model is unsplit.
# Idempotent: re-running this cell skips already-patched files.
_p1_path = os.path.join(REPO_DIR, "wan", "textimage2video.py")
_p1_src = open(_p1_path).read()
if "# NOVA v5: pipeline-parallel split" in _p1_src:
    print("patch 1 already applied — skipping.", flush=True)
else:
    _p1_anchor = """                self.model.to(self.device)
                torch.cuda.empty_cache()"""
    _p1_new = """                self.model.to(self.device)
                # NOVA v5: pipeline-parallel split — move the second half
                # of the DiT blocks (15-29) + head to cuda:1 when a second
                # GPU is available. Single process; no torchrun.
                if torch.cuda.device_count() > 1:
                    _nova_dev1 = torch.device('cuda:1')
                    for _nova_b in self.model.blocks[15:]:
                        _nova_b.to(_nova_dev1)
                    self.model.head.to(_nova_dev1)
                torch.cuda.empty_cache()"""
    _p1_count = _p1_src.count(_p1_anchor)
    assert _p1_count == 2, f"patch 1 anchor found {_p1_count}x (expected 2 — both generate branches)"
    _p1_src = _p1_src.replace(_p1_anchor, _p1_new)
    open(_p1_path, "w").write(_p1_src)
    print("patch 1 applied (textimage2video.py, both branches)", flush=True)
_p2_path = os.path.join(REPO_DIR, "wan", "modules", "model.py")
_p2_src = open(_p2_path).read()
if "# NOVA v5: device-detecting transfer" in _p2_src:
    print("patch 2 already applied — skipping.", flush=True)
else:
    _p2_loop_anchor = """        for block in self.blocks:
            x = block(x, **kwargs)"""
    _p2_loop_new = """        # NOVA v5: device-detecting transfer for the pipeline-parallel split.
        # When blocks are split across GPUs (patch 1), move the activations to
        # each block's device before running it. No-op when unsplit.
        for block in self.blocks:
            _nova_bdev = next(block.parameters()).device
            if x.device != _nova_bdev:
                x = x.to(_nova_bdev)
                kwargs['e'] = kwargs['e'].to(_nova_bdev)
                kwargs['context'] = kwargs['context'].to(_nova_bdev)
                kwargs['freqs'] = kwargs['freqs'].to(_nova_bdev)
            x = block(x, **kwargs)"""
    _p2_head_anchor = """        # head
        x = self.head(x, e)"""
    _p2_head_new = """        # head (NOVA v5: run on the head's device — cuda:1 when split;
        # the head takes the local time embedding e, NOT kwargs['e'])
        _nova_hdev = next(self.head.parameters()).device
        if x.device != _nova_hdev:
            x = x.to(_nova_hdev)
            e = e.to(_nova_hdev)
        x = self.head(x, e)"""
    _p2_ret_anchor = "        return [u.float() for u in x]"
    _p2_ret_new = "        return [u.float().to(device) for u in x]"
    assert _p2_src.count(_p2_loop_anchor) == 1, "patch 2 loop anchor not unique"
    assert _p2_src.count(_p2_head_anchor) == 1, "patch 2 head anchor not unique"
    assert _p2_src.count(_p2_ret_anchor) == 1, "patch 2 return anchor not unique"
    _p2_src = _p2_src.replace(_p2_loop_anchor, _p2_loop_new)
    _p2_src = _p2_src.replace(_p2_head_anchor, _p2_head_new)
    _p2_src = _p2_src.replace(_p2_ret_anchor, _p2_ret_new)
    open(_p2_path, "w").write(_p2_src)
    print("patch 2 applied (model.py forward: block loop + head + return)", flush=True)
# verify both patched files compile
for _f in (_p1_path, _p2_path):
    _rc = subprocess.run([sys.executable, "-m", "py_compile", _f], capture_output=True, text=True)
    assert _rc.returncode == 0, f"py_compile failed for {_f}: {_rc.stderr}"
    print(f"py_compile OK: {_f}", flush=True)
print("NOVA v5 PATCHES APPLIED + VERIFIED", flush=True)'''))

CELLS.append(md_cell(
    "## 4. Tokenizer remedy + checkpoint assembly\n"
    "\n"
    "The dataset mount is read-only and lacks the `google/` tokenizer dir, so the notebook builds a checkpoint directory in `/kaggle/working`: symlinks to the 8 mounted weight/config files (no copying — 34 GB) plus a real `google/umt5-xxl/` downloaded in-session from the OFFICIAL Wan-AI repo (`snapshot_download`, `allow_patterns=[\"google/*\"]`, ~5 MB). The tokenizer loads from `os.path.join(ckpt_dir, 'google/umt5-xxl')` (wan/textimage2video.py:93)."
))

CELLS.append(code_cell('''print("--- tokenizer remedy + checkpoint assembly ---", flush=True)
CKPT = os.path.join(WORKING, "Wan2.2-TI2V-5B")
TOKENIZER_FILES = ["special_tokens_map.json", "spiece.model", "tokenizer.json", "tokenizer_config.json"]
ckpt_report = {"ckpt_dir": CKPT, "symlinks": {}, "tokenizer": {}}
os.makedirs(CKPT, exist_ok=True)
for name, _listed in EXPECTED:
    src = os.path.join(MOUNT, name)
    dst = os.path.join(CKPT, name)
    if os.path.islink(dst) or os.path.exists(dst):
        print(f"  link exists: {name}", flush=True)
    else:
        os.symlink(src, dst)
        print(f"  linked: {name} -> {src}", flush=True)
    ckpt_report["symlinks"][name] = {"target": src, "bytes": os.path.getsize(dst)}
if google_in_mount:
    src_g = os.path.join(MOUNT, "google")
    dst_g = os.path.join(CKPT, "google")
    if not os.path.exists(dst_g):
        shutil.copytree(src_g, dst_g)
    ckpt_report["tokenizer"]["source"] = "dataset-mount"
    print("tokenizer taken from the dataset mount.", flush=True)
else:
    from huggingface_hub import snapshot_download
    dl_dir = os.path.join(WORKING, "tokenizer-dl")
    print("downloading google/ tokenizer files from the official Wan-AI repo...", flush=True)
    snapshot_download(repo_id="Wan-AI/Wan2.2-TI2V-5B", allow_patterns=["google/*"], local_dir=dl_dir)
    dl_google = os.path.join(dl_dir, "google")
    dst_g = os.path.join(CKPT, "google")
    if os.path.exists(dst_g):
        shutil.rmtree(dst_g)
    shutil.copytree(dl_google, dst_g)
    ckpt_report["tokenizer"]["source"] = "huggingface-official Wan-AI/Wan2.2-TI2V-5B (in-session download)"
    print("tokenizer downloaded from the official repo.", flush=True)
tok_dir = os.path.join(CKPT, "google", "umt5-xxl")
tok_files = {}
for fname in TOKENIZER_FILES:
    full = os.path.join(tok_dir, fname)
    assert os.path.isfile(full) and os.path.getsize(full) > 0, f"tokenizer file missing/empty: {fname}"
    tok_files[fname] = os.path.getsize(full)
    print(f"  tokenizer {fname}: {os.path.getsize(full)} bytes", flush=True)
ckpt_report["tokenizer"]["files"] = tok_files
ckpt_report["tokenizer"]["total_bytes"] = sum(tok_files.values())
# sanity: config.json parses
with open(os.path.join(CKPT, "config.json")) as f:
    cfg = json.load(f)
print(f"config.json parses OK (keys: {sorted(cfg.keys())})", flush=True)
print("CHECKPOINT ASSEMBLED", flush=True)'''))

CELLS.append(md_cell(
    "## 5. Synthetic start image (VDP-06)\n"
    "\n"
    "Procedurally generated in-session with PIL (fixed seed 42): a dawn-gradient sky, layered mountain-ridge silhouettes, drifting mist bands, and a small winged silhouette. No external image, no photograph, no real person. 1280x704, matching the output size exactly."
))

CELLS.append(code_cell('''print("--- synthetic start image (procedurally generated, no external media) ---", flush=True)
import random as _random
import numpy as _np
from PIL import Image, ImageDraw, ImageFilter
W, H = 1280, 704
rng = _random.Random(42)
# dawn gradient sky (numpy, fast): indigo top -> purple mid -> amber horizon
top = _np.array([18, 22, 58], dtype=float)
mid = _np.array([88, 60, 110], dtype=float)
hor = _np.array([255, 148, 64], dtype=float)
ground = _np.array([52, 40, 48], dtype=float)
horizon_y = 0.62
yy = _np.linspace(0, 1, H)
t = _np.clip(yy / horizon_y, 0, 1)
s1 = _np.clip(t / 0.55, 0, 1)
s2 = _np.clip((t - 0.55) / 0.45, 0, 1)
sky_top = top + (mid - top) * s1[:, None]
sky_bot = mid + (hor - mid) * s2[:, None]
col = _np.where((t < 0.55)[:, None], sky_top, sky_bot)
col[yy >= horizon_y] = ground
arr = _np.repeat(col[:, None, :], W, axis=1)
img = Image.fromarray(arr.astype("uint8"), "RGB").convert("RGBA")
# sun glow near the horizon
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W * 0.60 - 110, H * 0.62 - 130, W * 0.60 + 110, H * 0.62 + 90], fill=(255, 190, 110, 130))
glow = glow.filter(ImageFilter.GaussianBlur(45))
img.alpha_composite(glow)
# three jagged ridge layers, far (light) to near (dark)
ridge_cols = [(96, 84, 118), (62, 54, 84), (30, 26, 46)]
ridge_bases = [0.60, 0.70, 0.82]
for col, base in zip(ridge_cols, ridge_bases):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pts = [(0, H)]
    x = 0
    while x < W:
        pts.append((x, int(H * base - rng.uniform(0, H * 0.10))))
        x += rng.randint(50, 130)
    pts.append((W, int(H * base)))
    pts.append((W, H))
    d.polygon(pts, fill=col + (255,))
    img.alpha_composite(layer)
# drifting mist bands
mist = Image.new("RGBA", (W, H), (0, 0, 0, 0))
md = ImageDraw.Draw(mist)
for y0, hgt, alpha in [(0.58, 26, 70), (0.68, 34, 55), (0.78, 30, 45)]:
    md.rounded_rectangle([W * 0.05, H * y0, W * 0.95, H * y0 + hgt], radius=hgt // 2, fill=(235, 225, 240, alpha))
mist = mist.filter(ImageFilter.GaussianBlur(16))
img.alpha_composite(mist)
# small winged silhouette in the sky
sil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(sil)
cx, cy = int(W * 0.70), int(H * 0.24)
sd.ellipse([cx - 12, cy - 5, cx + 12, cy + 5], fill=(18, 16, 28, 255))
sd.polygon([(cx - 10, cy), (cx - 85, cy - 34), (cx - 55, cy + 8)], fill=(18, 16, 28, 255))
sd.polygon([(cx + 10, cy), (cx + 85, cy - 34), (cx + 55, cy + 8)], fill=(18, 16, 28, 255))
img.alpha_composite(sil)
START_IMG = os.path.join(WORKING, "start-image.png")
img.convert("RGB").save(START_IMG)
print(f"start image saved: {START_IMG} ({W}x{H}, procedurally generated, seed 42)", flush=True)'''))

CELLS.append(md_cell(
    "## 6. Generate — one 5 s clip, native 1280x704, vendor defaults, TWO GPUs (v5)\n"
    "\n"
    "Official `generate.py`, vendor-documented flags: `--task ti2v-5B --size 1280*704 --offload_model True --convert_model_dtype --t5_cpu`, fixed seed 42. Vendor defaults apply for the rest (121 frames @ 24 fps, 50 steps, guide 5.0). A background thread polls `nvidia-smi` every 5 s and records sampled peak VRAM per GPU (VDP-03). Output goes straight to a fixed filename in `/kaggle/working`.\n"
    "\n"
    "**Single-process pipeline-parallel launch (v5):** v3 proved a single T4 does NOT fit the official 5B path at 121 frames, and v4 proved torchrun is RAM-blocked on Kaggle (two workers each load the full ~34 GB stack; ~30 GB host RAM). So v5 runs ONE process, plain `python generate.py`, with the DiT split across both T4s by the NOVA patches in cell 3b (blocks 15–29 + head on cuda:1). T5 stays on CPU (`--t5_cpu`). Expected VRAM: cuda:0 ~11.5 GB, cuda:1 ~8.8 GB vs 14.56 GB each. `PYTHONUNBUFFERED=1` keeps generate.py's progress live in the log (v3's stdout was block-buffered — 71 silent minutes)."
))

CELLS.append(code_cell('''print("--- generate: one 5 s clip, native 1280x704, vendor defaults, TWO GPUs (v5) ---", flush=True)
import threading
PROMPT = "An ash-grey dragon with ember-cracked wings rests on a misty mountain ridge at dawn, slow cinematic camera push-in, mist drifting across the ridge, embers glowing faintly along the dragon's wings, epic fantasy film still, dramatic dawn light"
OUT_MP4 = os.path.join(WORKING, "wan-proof-20261124-01.mp4")
LOG_PATH = os.path.join(WORKING, "generate.log")
peak_vram = {"per_gpu_mb": {}, "overall_mb": 0}
stop_poll = threading.Event()
def poll_vram():
    while not stop_poll.is_set():
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
            for line in out.stdout.strip().splitlines():
                idx, used = line.split(",")
                used = int(used.strip())
                i = int(idx.strip())
                peak_vram["per_gpu_mb"][i] = max(peak_vram["per_gpu_mb"].get(i, 0), used)
                peak_vram["overall_mb"] = max(peak_vram["overall_mb"], used)
        except Exception:
            pass
        stop_poll.wait(5)
threading.Thread(target=poll_vram, daemon=True).start()
# v5: SINGLE-PROCESS pipeline-parallel launch (see the cell markdown).
# v4's torchrun was RAM-blocked on Kaggle (two workers, ~34 GB each,
# ~30 GB host RAM). One process, plain python generate.py; the DiT is
# split across both T4s by the NOVA patches in cell 3b (blocks 15-29 +
# head on cuda:1). PYTHONUNBUFFERED=1 keeps generate.py's progress live
# in the log (v3's stdout was block-buffered — 71 silent min).
gen_env = {**os.environ, "PYTHONUNBUFFERED": "1",
           "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
cmd = [sys.executable, "Wan2.2/generate.py", "--task", "ti2v-5B",
       "--size", "1280*704", "--ckpt_dir", CKPT, "--offload_model", "True",
       "--convert_model_dtype", "--t5_cpu",
       "--prompt", PROMPT, "--image", START_IMG, "--save_file", OUT_MP4,
       "--base_seed", "42"]
print("running: " + " ".join(cmd), flush=True)
t_gen0 = time.time()
markers = {}
logf = open(LOG_PATH, "w")
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, cwd=WORKING, env=gen_env)
for line in proc.stdout:
    logf.write(line)
    logf.flush()
    print(line, end="", flush=True)
    low = line.lower()
    if "creating wanmodel" in low and "model_load_start_s" not in markers:
        markers["model_load_start_s"] = round(time.time() - t_gen0, 1)
    if ("it/s" in low or "s/it" in low) and "first_step_s" not in markers:
        markers["first_step_s"] = round(time.time() - t_gen0, 1)
proc.wait()
logf.close()
stop_poll.set()
gen_runtime_s = round(time.time() - t_gen0, 1)
print(f"generate.py exit={proc.returncode} runtime={gen_runtime_s}s peak_vram~{peak_vram['overall_mb']}MB", flush=True)
with open(LOG_PATH) as f:
    log_text = f.read()
oom = "out of memory" in log_text.lower()
print(f"OOM detected in log: {oom}", flush=True)
assert proc.returncode == 0, f"generate.py failed (exit {proc.returncode}) — see {LOG_PATH}"
assert not oom, "CUDA out-of-memory detected in the generate log"
assert os.path.isfile(OUT_MP4), f"expected output MP4 missing: {OUT_MP4}"
print("GENERATION COMPLETE", flush=True)'''))

CELLS.append(md_cell(
    "## 7. Verify output + write the evidence report (VDP-05)\n"
    "\n"
    "Verifies exactly one MP4 was produced, records its actual spec (ffprobe, cv2 fallback), confirms it carries NO audio stream (Wan has no native audio; the no-background-sound law), and writes `wan-proof.report.json` — the record the manager reads back."
))

CELLS.append(code_cell('''print("--- verify output + write the evidence report ---", flush=True)
import glob
mp4s = sorted(glob.glob(os.path.join(WORKING, "*.mp4")))
print(f"MP4 files in {WORKING}: {mp4s}", flush=True)
assert mp4s == [OUT_MP4], f"expected exactly one MP4 ({OUT_MP4}), found: {mp4s}"
out_bytes = os.path.getsize(OUT_MP4)
print(f"output: {OUT_MP4} — {out_bytes} bytes", flush=True)
# video spec: ffprobe first, cv2 fallback
spec = {"method": None}
try:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_name",
                          "-show_entries", "format=duration", "-of", "json", OUT_MP4],
                         capture_output=True, text=True, timeout=60)
    data = json.loads(out.stdout)
    st = data["streams"][0]
    fps_num, fps_den = st["r_frame_rate"].split("/")
    spec = {"method": "ffprobe", "width": st["width"], "height": st["height"],
            "fps": round(int(fps_num) / int(fps_den), 2), "frames": int(st.get("nb_frames", 0)),
            "duration_s": round(float(data["format"]["duration"]), 2), "codec": st["codec_name"]}
except Exception as e:
    print(f"ffprobe unavailable ({type(e).__name__}: {e}) — falling back to cv2", flush=True)
    import cv2
    cap = cv2.VideoCapture(OUT_MP4)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    spec = {"method": "cv2", "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)), "fps": round(fps, 2),
            "frames": n, "duration_s": round(n / fps, 2) if fps else None, "codec": "unknown"}
    cap.release()
print(f"spec: {json.dumps(spec)}", flush=True)
# audio check: assert no audio stream (Wan has no native audio; the no-sound law)
audio = {"checked": False, "has_audio": None, "method": None}
try:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                          "-show_entries", "stream=index", "-of", "csv=p=0", OUT_MP4],
                         capture_output=True, text=True, timeout=60)
    audio = {"checked": True, "has_audio": bool(out.stdout.strip()), "method": "ffprobe"}
except Exception:
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        out = subprocess.run([ff, "-i", OUT_MP4], capture_output=True, text=True, timeout=60)
        audio = {"checked": True, "has_audio": "Audio:" in (out.stderr or ""), "method": "imageio-ffmpeg"}
    except Exception as e:
        audio = {"checked": False, "has_audio": None, "method": f"unavailable: {type(e).__name__}: {e}"}
print(f"audio check: {json.dumps(audio)}", flush=True)
assert audio.get("has_audio") is not True, "output MP4 has an audio stream — violates the no-sound rule"
report = {
    "jobId": JOB_ID, "providerId": "kaggle-t4", "status": "succeeded",
    "secondsUsed": round(gen_runtime_s), "costUsd": 0,
    "completedAt": int(time.time() * 1000), "runStartedUtc": RUN_STARTED_UTC,
    "resultRef": "manual-download:wan-proof-20261124-01.mp4", "error": None,
    "gates": gates,
    "evidence": {
        "model": {"name": "Wan 2.2 TI2V-5B", "repo": "Wan-AI/Wan2.2-TI2V-5B",
                  "repo_sha": "921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
                  "code_repo": "Wan-Video/Wan2.2", "licence": "Apache 2.0",
                  "weights_source": "Kaggle dataset barbieverse/wan2-2-5b-weights (third-party mirror; sizes match official listing, hashes unverified)",
                  "tokenizer_source": ckpt_report["tokenizer"]["source"]},
        "hardware": gates["A-gpu"]["detail"],
        "prompt": PROMPT,
        "start_image": {"path": START_IMG, "method": "procedurally generated in-session (PIL, seeded); no external image", "size": [1280, 704]},
        "output": {"file": os.path.basename(OUT_MP4), "bytes": out_bytes, **spec},
        "runtime_s": {"generate_total": gen_runtime_s, "markers_best_effort": markers},
        "memory": {"peak_vram_mb_sampled": peak_vram, "offload_model": True, "t5_cpu": True,
                   "convert_model_dtype": True, "oom": oom,
                   "launch": "single-process pipeline-parallel (NOVA v5 patches: DiT blocks 15-29 + head on cuda:1; 2x Tesla T4)",
                   "torchrun": False, "ulysses_size": None, "dit_fsdp": False},
        "host_ram": host_ram,
        "reliability": {"generate_exit": proc.returncode, "oom": oom, "retries": 0},
        "audio": audio,
        "install": install_report,
        "weights": weights,
        "checkpoint": ckpt_report,
    },
}
with open(REPORT_PATH, "w") as f:
    json.dump(report, f, indent=2)
print(f"REPORT WRITTEN: {REPORT_PATH}", flush=True)
print("WAN PROOF COMPLETE", flush=True)'''))

# nbformat 4.5 cell ids (Kaggle's validator warns without them).
for i, c in enumerate(CELLS):
    c["id"] = f"cell-{i}"

NOTEBOOK = {
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.10.0"},
        "nova": {
            "generator": "nova-gpu-cloud/scripts/build-wan-proof-package.py",
            "template": False,
            "validated": False,
            "jobId": JOB_ID,
            "modelId": "wan2.2-ti2v-5b",
            "provider": "kaggle-t4",
            "route": "official",
        },
    },
    "cells": CELLS,
}

METADATA = {
    "id": KERNEL_ID,
    "title": "NOVA GPU Cloud — Wan proof 20261124-01",
    "code_file": "wan-proof.ipynb",
    "language": "python",
    "kernel_type": "notebook",
    "is_private": "true",
    "enable_gpu": "true",
    "enable_tpu": "false",
    "enable_internet": "true",
    "machine_shape": "NvidiaTeslaT4",
    "dataset_sources": ["barbieverse/wan2-2-5b-weights"],
    "competition_sources": [],
    "kernel_sources": [],
    "model_sources": [],
}

MANIFEST = {
    "modelId": "wan2.2-ti2v-5b",
    "route": "official",
    "source": {
        "repo": "Wan-AI/Wan2.2-TI2V-5B",
        "repo_sha": "921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
        "codeRepo": "Wan-Video/Wan2.2",
        "licence": "Apache 2.0",
        "weights_via": "Kaggle dataset barbieverse/wan2-2-5b-weights (third-party mirror; all 8 files, sizes match the official listing exactly — verified via the Kaggle CLI 24 Nov 2026; hashes unverified)",
        "notes": "Official vendor weights + generate.py. Diffusion shards are FP32-stored (~20 GB); generate.py converts dtype at load (--convert_model_dtype). The google/ tokenizer dir is absent from the dataset — the notebook downloads it in-session from the official repo (see tokenizerRemedy).",
    },
    "files": [
        {"path": "diffusion_pytorch_model-00001-of-00003.safetensors", "role": "diffusion-model", "sizeBytes": 9825014472, "required": True},
        {"path": "diffusion_pytorch_model-00002-of-00003.safetensors", "role": "diffusion-model", "sizeBytes": 9995661736, "required": True},
        {"path": "diffusion_pytorch_model-00003-of-00003.safetensors", "role": "diffusion-model", "sizeBytes": 178558176, "required": True},
        {"path": "diffusion_pytorch_model.safetensors.index.json", "role": "diffusion-model-index", "sizeBytes": 72865, "required": True},
        {"path": "models_t5_umt5-xxl-enc-bf16.pth", "role": "text-encoder", "sizeBytes": 11361920418, "required": True},
        {"path": "Wan2.2_VAE.pth", "role": "vae", "sizeBytes": 2818839170, "required": True},
        {"path": "config.json", "role": "config", "sizeBytes": 251, "required": True},
        {"path": "configuration.json", "role": "config", "sizeBytes": 43, "required": True},
    ],
    "tokenizerRemedy": {
        "missing_from_dataset": "google/",
        "files": ["google/umt5-xxl/special_tokens_map.json", "google/umt5-xxl/spiece.model",
                  "google/umt5-xxl/tokenizer.json", "google/umt5-xxl/tokenizer_config.json"],
        "source": "Official repo Wan-AI/Wan2.2-TI2V-5B (huggingface_hub snapshot_download, allow_patterns=['google/*'])",
        "approx_bytes": 5000000,
        "method": "Downloaded in-session after Gate B (internet) passes; copied into the symlinked ckpt dir at google/umt5-xxl (the tokenizer loads from os.path.join(ckpt_dir, 'google/umt5-xxl') — wan/textimage2video.py:93). If the dataset ever gains google/, the download is skipped.",
    },
    "pythonPackages": [
        {"name": "torch", "version": ">=2.4.0", "purpose": "inference runtime", "source": "Wan2.2 README"},
        {"name": "wan2.2-requirements", "version": "repo-pinned", "purpose": "all other deps, as pinned by Wan-Video/Wan2.2 requirements.txt (installed only if missing/out-of-range)", "source": "Wan-Video/Wan2.2 requirements.txt"},
        {"name": "transformers", "version": "==4.51.3 (EXACT)", "purpose": "T5 tokenizer (AutoTokenizer); vendor pin <=4.51.3", "source": "v3 coordinated pin set — verified locally 24 Nov 2026 (venv, real generate.py --help)"},
        {"name": "diffusers", "version": "==0.32.2 (EXACT)", "purpose": "ConfigMixin/ModelMixin/scheduler utils; Kaggle's preinstalled 0.42.0 is INCOMPATIBLE with the hub version transformers 4.51.3 forces (v2 failure)", "source": "v3 coordinated pin set — verified locally 24 Nov 2026"},
        {"name": "huggingface-hub", "version": "==0.36.2 (EXACT)", "purpose": "tokenizer remedy download; transformers 4.51.3 forces hub <1.0", "source": "v3 coordinated pin set — verified locally 24 Nov 2026"},
        {"name": "tokenizers", "version": "==0.21.4 (EXACT)", "purpose": "transformers 4.51.3 requires >=0.21,<0.22", "source": "v3 coordinated pin set — verified locally 24 Nov 2026"},
        {"name": "peft/decord/einops/safetensors/librosa", "version": "any (presence-checked)", "purpose": "`import wan` needs all five via the animate/speech2video modules (wan/__init__ imports all five task modules); librosa via wan/modules/s2v/audio_encoder.py", "source": "added by NOVA in v3 — never checked in v1/v2"},
        {"name": "sentencepiece", "version": "any", "purpose": "T5 slow-tokenizer path (spiece.model)", "source": "added by NOVA — requirements.txt omits it"},
        {"name": "flash_attn", "version": "SKIPPED BY DESIGN", "purpose": "not installed — wan/modules/attention.py falls back to torch SDPA when absent; flash-attn 2 cannot run on T4 (sm75, needs sm80+)", "source": "verified in the cloned repo 24 Nov 2026"},
    ],
    "installSpec": {
        "kind": "repo-clone+pip (in-session, needs internet)",
        "steps": [
            "git clone --depth 1 https://github.com/Wan-Video/Wan2.2.git",
            "pip install (only missing/out-of-range packages from Wan2.2/requirements.txt)",
            "Weights are NOT downloaded — dataset mount /kaggle/input/wan2-2-5b-weights/",
        ],
        "offlineInstall": "Not applicable to this run: internet is ON (proven by the smoke test) and the install + tokenizer remedy need it. The GENERATION step itself needs no network.",
    },
    "loras": [],
    "runPlan": [
        {"id": "env-gates", "description": "Three-gate smoke check (GPU/internet/storage), fail-fast on any failure", "needsNetwork": False},
        {"id": "verify-weights", "description": "Check the 8 dataset-mount files (presence + size)", "needsNetwork": False},
        {"id": "install-code", "description": "Clone Wan2.2 + pip install missing packages", "needsNetwork": True},
        {"id": "nova-patches", "description": "Apply the two NOVA v5 pipeline-parallel patches to the cloned vendor code (cell 3b): DiT blocks 15-29 + head to cuda:1 (textimage2video.py, both branches); device-detecting transfer in the DiT forward (model.py). Anchors asserted, py_compile-checked.", "needsNetwork": False},
        {"id": "tokenizer-remedy", "description": "Download google/ tokenizer from the official HF repo", "needsNetwork": True},
        {"id": "assemble-ckpt", "description": "Symlink mount + tokenizer into /kaggle/working/Wan2.2-TI2V-5B", "needsNetwork": False},
        {"id": "make-start-image", "description": "Procedural PIL start image (1280x704, seeded)", "needsNetwork": False},
        {"id": "generate", "description": "python generate.py --task ti2v-5B --size 1280*704, 5 s clip, vendor defaults — SINGLE PROCESS, pipeline-parallel across 2x T4 via the NOVA v5 patches (v5: v3 proved a single T4 OOMs at the first DiT forward; v4 proved torchrun is RAM-blocked on Kaggle)", "needsNetwork": False},
        {"id": "write-report", "description": "Verify MP4 + write wan-proof.report.json", "needsNetwork": False},
    ],
    "novaPatches": [
        {"id": "v5-patch-1", "file": "wan/textimage2video.py", "anchor": "self.model.to(self.device) followed by torch.cuda.empty_cache() (count 2 — both generate branches)", "change": "After the model moves to the device, move DiT blocks 15-29 + head to cuda:1 when torch.cuda.device_count() > 1.", "purpose": "Pipeline-parallel split across the two provisioned T4s; single process, no torchrun (v4 proved torchrun RAM-blocked on Kaggle)."},
        {"id": "v5-patch-2", "file": "wan/modules/model.py", "anchor": "WanModel.forward block loop + head + return (each count 1)", "change": "Device-detecting transfer in the block loop (move x, e0, context, freqs to each block's device); head runs on the head's device with local e moved to match; return moves back to the input device.", "purpose": "Makes the split forward correct; self-healing no-op when unsplit. The head takes local e [B, L1, C], NOT kwargs['e'] (e0)."},
    ],
    "storage": {
        "totalBytes": 34180067131,
        "fitsWorkingStorage20Gb": False,
        "route": "kaggle-dataset",
        "routeNote": "Weights (34.18 GB) mount at /kaggle/input/wan2-2-5b-weights — never copied into /kaggle/working. Working storage needs only the repo (~50 MB) + tokenizer (~5 MB) + output (~10 MB).",
    },
}

README = """# NOVA GPU Cloud — Kaggle job package: wan-proof-20261124-01

Model: Wan 2.2 TI2V-5B (official route) | Provider: kaggle-t4 | Job: wan-proof-20261124-01

One 5-second clip, native 1280x704, vendor defaults (121 frames @ 24 fps, 50 steps).
Phase 1 proof (VDP-05) — not production approval.

## Files

- `wan-proof.ipynb` — the self-contained notebook (only this file is sent on push)
- `kernel-metadata.json` — kernel metadata (GPU T4 x2 via machine_shape, internet on,
  dataset mount barbieverse/wan2-2-5b-weights)
- `staging-manifest.json` — the VDP-04 staging manifest
- `README.md` — this file

Regenerate the package: `python3 scripts/build-wan-proof-package.py`

## What the notebook does (in order)

1. **Three-gate smoke check** (reviewer §5): Gate A GPU, Gate B internet, Gate C
   storage — each recorded independently. ANY gate failure writes a failure report
   and stops the run BEFORE any model work (fail-fast). No model download/loading
   in this cell.
2. **Verify staged weights** at the dataset mount (8 files, 34.18 GB, sizes checked).
   The mount is DISCOVERED dynamically (standard path or the
   `/kaggle/input/datasets/<owner>/<slug>/` variant) — v1 failed because the
   first push attached no dataset at all, a known Kaggle behaviour fixed by
   re-pushing; if no mount is found the notebook writes a failure report and
   stops.
3. **Install inference code**: shallow-clone Wan-Video/Wan2.2 + pip install ONLY the
   packages that are missing or out of the repo-pinned range. `flash_attn` is
   deliberately NOT installed (SDPA fallback in wan/modules/attention.py; flash-attn 2
   cannot run on T4/sm75).
4. **Tokenizer remedy + checkpoint assembly**: the dataset lacks the `google/`
   tokenizer dir, so the notebook downloads `google/umt5-xxl` (~5 MB) in-session from
   the OFFICIAL Wan-AI repo and builds a symlinked ckpt dir in /kaggle/working
   (the mount is read-only).
5. **Synthetic start image**: procedurally generated in-session (PIL, seeded) — VDP-06.
6. **Generate**: `python generate.py --task ti2v-5B
   --size 1280*704 --offload_model True --convert_model_dtype --t5_cpu`,
   fixed seed 42. SINGLE-PROCESS pipeline-parallel launch (v5 — v3 proved
   a single T4 OOMs at the first DiT forward; v4 proved torchrun is
   RAM-blocked on Kaggle). The DiT is split across both T4s by the NOVA
   patches in cell 3b (blocks 15–29 + head on cuda:1). VRAM polled every
   5 s (VDP-03). `PYTHONUNBUFFERED=1` keeps generate.py's progress live
   in the log.
7. **Verify + report**: exactly one MP4, actual spec recorded, NO audio stream
   asserted (no-sound law), `wan-proof.report.json` written.

## Run it

    cd packages/wan-proof-20261124-01
    kaggle kernels push -p . --accelerator NvidiaTeslaT4 -t 10800

(-t 10800 = 3 h run-time cap. The CLI help defines -t as the run-time limit; 600 s
would kill the run mid-generation. v3 ran 71 min before its OOM (loading 34 GB +
T5-on-CPU encoding); v5 needs load/encode (~70 min) + 50-step sampling on 2 GPUs
+ VAE decode. The 12 h Kaggle session max is not exceeded.)

## Poll + download the output

    kaggle kernels status oliversmithh/nova-gpu-cloud-wan-proof-20261124-01
    kaggle kernels output -p output oliversmithh/nova-gpu-cloud-wan-proof-20261124-01

Then file the report JSON (wan-proof.report.json) with the manager (see
docs/connection-layer.md §6) and download the MP4 separately — no media passes
through the manager (O-27).

## Cancel

The Kaggle CLI has NO cancel command. To stop a runaway run, open the kernel in the
Kaggle web UI and stop/delete it there.

## Version history

- **v1** (pushed 24 Nov 18:32 UTC, ERROR ~18:42 UTC, 0.27 GPU-h): all three gates
  PASSED, but the dataset never mounted (`FileNotFoundError:
  '/kaggle/input/wan2-2-5b-weights'`) — Kaggle silently failed to attach it
  although `dataset_sources` was in the stored metadata. Fix: dynamic mount
  discovery in the weights cell.
- **v2** (pushed 24 Nov 18:44 UTC, ERROR ~18:59 UTC, ~0.34 GPU-h): gates PASSED,
  mount discovered at the variant path
  `/kaggle/input/datasets/barbieverse/wan2-2-5b-weights`, all 8 files verified,
  tokenizer remedy worked — but installing transformers<=4.51.3 alone
  downgraded huggingface-hub 1.33.0 -> 0.36.2, breaking Kaggle's preinstalled
  diffusers 0.42.0 (`ImportError: cannot import name 'resolve_revision'`).
  generate.py died at `import wan` after 7.2 s; the model never loaded.
  Fix (v3): the four interacting packages pinned EXACTLY
  (transformers==4.51.3, diffusers==0.32.2, huggingface-hub==0.36.2,
  tokenizers==0.21.4) and installed in ONE pip invocation; the five extra
  `import wan` deps (peft, decord, einops, safetensors, librosa) now checked;
  `generate.py --help` runs in-cell after install as a dependency check.
  Pin set verified locally in a venv running the real `generate.py --help`.
- **v3**: current. Pushed after the v2 fix; see the kernel status for its outcome.
- **v3** (pushed 24 Nov 19:14 UTC, ERROR ~20:27 UTC, 1.23 GPU-h): gates PASSED,
  mount + tokenizer remedy worked, DEPENDENCY CHECK PASSED (the v2 fix held),
  the model LOADED and ran 4,283 s — then OOM'd on the FIRST DiT forward
  (step 0/50): 13.04 GiB allocated (DiT bf16 ~10.3 GB + VAE fp32 ~2.8 GB
  resident), tried to allocate 1.88 GiB (the fp32 per-token time projection)
  with 1.14 GiB free. Single-T4 does NOT fit the official 5B path at 121
  frames — the weights alone leave ~1.5 GB for all activations (VDP-03
  correction to the plan's "5B fits a T4"). The 71 min before step 0 went
  to loading 34 GB + T5-on-CPU encoding, and generate.py's stdout was
  block-buffered, so nothing was visible until the exit flush.
  Fix (v4): torchrun on BOTH provisioned T4s — `--ulysses_size 2` (halves
  per-GPU activations) + `--dit_fsdp` (DiT weights sharded bf16, ~5.15 GB/
  rank); T5 stays on CPU (T5-FSDP would collide at construction);
  `PYTHONUNBUFFERED=1` for live progress; `-t 10800`. Per-rank estimate
  ~9.9 GB vs 14.56 GB.
- **v4** (pushed 24 Nov 20:36 UTC, ERROR ~20:41 UTC, 0.04 GPU-h): gates PASSED,
  mount + tokenizer remedy + dependency check all held — but torchrun is
  RAM-blocked on Kaggle, NOT VRAM-blocked. Rank 1 was SIGKILLed by the Linux
  OOM killer at ~44 s (peak VRAM only 363 MB): two workers each load the
  full ~34 GB stack and Kaggle's ~30 GB host RAM cannot hold both.
  Fix (v5): single-process pipeline-parallel — revert torchrun, plain
  `python generate.py`, DiT blocks 15–29 + head moved to cuda:1 by two
  NOVA patches (textimage2video.py + model.py forward); host-RAM reporting
  added to the gate cell (VDP-03).
- **v5**: current. Pushed after the v4 fix; see the kernel status for its outcome.

## Papermill

Kaggle runs committed notebooks via papermill, which kills a kernel that produces no
output for ~4 seconds. The notebook prints progress with flush=True throughout — do
not remove the prints.
"""


def main():
    os.makedirs(PKG, exist_ok=True)
    with open(os.path.join(PKG, "wan-proof.ipynb"), "w") as f:
        json.dump(NOTEBOOK, f, indent=2)
    with open(os.path.join(PKG, "kernel-metadata.json"), "w") as f:
        json.dump(METADATA, f, indent=2)
    with open(os.path.join(PKG, "staging-manifest.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2)
    with open(os.path.join(PKG, "README.md"), "w") as f:
        f.write(README)
    n_code = sum(1 for c in CELLS if c["cell_type"] == "code")
    print(f"wrote {PKG}/")
    print(f"  wan-proof.ipynb ({len(CELLS)} cells, {n_code} code)")
    print("  kernel-metadata.json")
    print("  staging-manifest.json")
    print("  README.md")


if __name__ == "__main__":
    main()
