# Wan 2.2 proof — VDP-05 evidence record (v5, 24 Nov 2026)

**Kernel:** `oliversmithh/nova-gpu-cloud-wan-proof-20261124-01`, version 5.
**Package:** `gpu-cloud/packages/wan-proof-20261124-01/` (run artifacts in
`output-v5/`).
**Pushed:** 24 Nov 2026 ~20:53 UTC (21:53 WAT). **Run started:**
2026-11-24T20:56:41Z. **Kernel ERROR:** ~22:34 UTC (detected by poll
22:37:26 UTC). **Kernel wall time:** ~5,853 s (~97.6 min).
**Task:** one 5 s clip, Wan 2.2 TI2V-5B, native 1280x704, 121 frames,
50 steps, seed 42, synthetic start image (VDP-06).

## Verdicts (two, as VDP-05 requires)

### 1. Technical execution — FAILED, one stage further than v3

v5 produced **no video**. `generate.py` exited 1 after 5,743.1 s with a
**CUDA out-of-memory on GPU 0 at step 0/50**, inside the first DiT forward
(block 0's self-attention, `rope_apply` → `torch.stack(output).float()`,
trying to allocate 320.00 MiB with 160.81 MiB free).

But v5 advanced exactly one stage past v3: the **time projection passed**
— the e0 tensor (the v3 failure point) allocated successfully on GPU 0,
and the run reached block 0 before dying. The pipeline-parallel split
freed enough GPU-0 memory for e0 to fit where it did not in v3, but not
enough for block 0's fp32 activation stack. GPU 0 ended at **14.05 GiB
allocated by PyTorch** against a ~11.5 GB design estimate — the estimate
did not account for the full fp32 activation load live at block 0.

### 2. Production suitability — NOT SUITABLE

No video has been produced in five attempts. The 2x T4 route for the
official 5B path at 121 frames / 1280x704 remains unproven, each attempt
costs ~96 minutes of wall time before it can fail, and the v5 design
margin was wrong. Nothing here may be presented as a production-ready
video-generation route. Any next attempt needs the owner's word and must
first fix the instrumentation gap below (per-GPU placement proof).

## Reviewer's 6-stage classification

| Stage | Result | Evidence |
| ----- | ------ | -------- |
| 1. Model loading (no host OOM) | **PASS** | All modules loaded; run reached sampling; no SIGKILL/host OOM. Host RAM at start: total 32.9 GB, available 31.1 GB. |
| 2. Device placement (both T4s hold assigned modules) | **UNVERIFIED** | Patches applied + verified at source level (`NOVA v5 PATCHES APPLIED + VERIFIED`, both files py_compile OK). But NO runtime placement log exists, and the per-GPU peak data was lost (see gap note). Indirect only: v5 passed e0 where v3 failed, so the split freed at least ~0.74 GiB on GPU 0 — consistent with a split that worked at least partly, but not proof of the 15/15 placement. |
| 3. Time projection (sampling passes step 0) | **PASS** | First tqdm line `0/50` printed; failure came AFTER, inside block 0. e0 ([1,27280,6,3072] fp32, ~1.87 GiB) allocated on GPU 0. |
| 4. Transformer sampling (all steps complete) | **FAIL** | **0 of 50 steps completed.** Step 0 died ~0.07 s after its tqdm line appeared. |
| 5. VAE decoding (no OOM) | **NOT REACHED** | Sampling never produced latents. |
| 6. Export (MP4 exists, opens, plays) | **NOT REACHED** | No MP4 in `output-v5/`; verify cell never ran. |

## Per-GPU measurements (reviewer's table)

| Measurement | GPU 0 | GPU 1 |
| ----------- | ----- | ----- |
| Total visible VRAM | 15,360 MiB (nvidia-smi); 14.56 GiB usable (PyTorch); torch reports 15.6 GB | Same |
| Memory before model loading | 0 MiB used (nvidia-smi, gate cell) | 0 MiB used |
| Memory after model placement | **NOT RECORDED — gap** (no snapshot after load) | **NOT RECORDED — gap** |
| Peak during sampling | **NOT SPLIT BY PHASE — gap.** Overall sampled peak (max across GPUs, 5 s poll): 14,751 MB. At the OOM instant GPU 0 held 14.26 GiB in use by the process, 14.05 GiB allocated by PyTorch. | **NOT RECORDED — gap** (per-GPU peaks lost, see below) |
| Peak during decoding | Not reached | Not reached |
| Final memory after generation | **NOT RECORDED — gap** (no post-generation snapshot; run failed) | **NOT RECORDED — gap** |
| torch max_memory_allocated() | **NOT INSTRUMENTED — gap** (reviewer asked for the torch-vs-device comparison; this run cannot supply the torch figure) | Same gap |

**Why the per-GPU data is lost (instrumentation flaw, recorded honestly):**
the notebook's VRAM poller kept `per_gpu_mb` in memory only and printed
just the cross-GPU max (`peak_vram~14751MB`); the per-GPU breakdown was
written only into the report JSON in the verify cell (cell 16), which
never ran because the generate cell (cell 14) asserted first on the
failed exit code. Any next run must print per-GPU peaks AND per-block
device placement in the generate cell itself, before any assert.

## Other requested items

- **GPU 0 before/after time projection; e/e0 shape + dtype:** NOT
  INSTRUMENTED — gap. Code-derived expectations (source, not measured):
  `e` [1, 27280, 3072] fp32 ~320 MiB; `e0` [1, 27280, 6, 3072] fp32
  ~1.87 GiB. Observable proxy: step 0 began, so e0 allocated.
- **GPU 0 before/after block 0; GPU 1 before/after block 15; memory
  during the output head; memory during VAE decoding:** NOT INSTRUMENTED
  — gap (poller gave an overall peak only; head and VAE never ran).
- **Peak host RAM / process RSS:** NOT MEASURED — gap. Gate cell only:
  total 32.9 GB, available 31.1 GB at run start. No host OOM occurred,
  so the single-process load fit (indirect bound only).
- **Denoising steps completed:** 0 of 50.
- **Total generation time:** `generate.py` 5,743.1 s. Time to step 0:
  **5,734.0 s (~95.6 min)** of loading + T5-on-CPU encoding before the
  first sampling step (v3: 4,283 s; v5 took ~24 min longer — cause
  unknown, machine/T5-encode variance or split-move cost). Step 0 then
  died in under a second.
- **Inter-GPU transfer time:** NOT INSTRUMENTED — gap.
- **Whether any module unexpectedly moved back to CPU:** NOT DIRECTLY
  OBSERVABLE — gap. No evidence of a CPU fallback: the failure was a
  GPU OOM, not a slow CPU path. Whether blocks 15–29 stayed on cuda:1
  at runtime is unproven (see stage 2).
- **Output resolution / frame count / file size / playback:** NONE — no
  MP4 was produced.

## Failure analysis (analysis, not measurement — labelled as such)

The OOM message at failure: `Tried to allocate 320.00 MiB. GPU 0 has a
total capacity of 14.56 GiB of which 160.81 MiB is free. ... this process
has 14.26 GiB memory in use. Of the allocated memory 14.05 GiB is
allocated by PyTorch, and 83.19 MiB is reserved by PyTorch but
unallocated.`

Comparison with v3 (same flags, full DiT on GPU 0):

| | v3 | v5 |
| --- | --- | --- |
| Allocated by PyTorch at failure | 13.04 GiB | 14.05 GiB |
| Failed allocation | 1.88 GiB (e0, time projection) | 320 MiB (rope_apply .float(), block 0 attention) |
| Free at failure | 1.14 GiB | 160.81 MiB |
| Time to failure (generate.py) | 4,283 s | 5,743.1 s |
| Steps completed | 0/50 | 0/50 |

Reading: v5's GPU-0 allocation at failure is HIGHER than v3's, because
v5 got further — e0 (1.87 GiB) plus block-0 activations (norm1 float,
q/k/v projections, rope float copies: roughly 1.6–2.0 GB of fp32
[1, 27280, 3072] tensors at 320 MiB each) were all live at once. The
v5 design estimate (~11.5 GB on cuda:0) counted weights but
under-counted the fp32 activation stack that is live inside block 0.
Every fp32 tensor at this sequence length (27,280 tokens) costs
320 MiB, and several are live simultaneously.

The split's runtime effect cannot be quantified from this run's logs:
the OOM arithmetic is consistent with the split having freed at least
~0.74 GiB (e0 fit where it had not), but the 14.05 GiB total is above
what a clean 15/15 split plus activations predicts (~11.5 GB) — the
residual is unexplained from the logs. Candidates: the VAE (2.8 GB
fp32) resident on GPU 0 during sampling despite `--offload_model True`,
autocast fp32 weight caching, or a partial split. A next run must print
per-module device placement and per-GPU memory after load to settle it.

(Note: the `Could not find cuda drivers on your machine` line in the log
is a JAX/absl stderr warning, not a real GPU problem — torch saw both
GPUs and all three gates passed.)

## Run record (all five attempts)

| Version | Outcome | GPU-h | Failure / note |
| ------- | ------- | ----- | -------------- |
| v1 | ERROR | ~0.27 | Gates passed; dataset never mounted |
| v2 | ERROR | ~0.34 | Dependency downgrade broke diffusers |
| v3 | ERROR | ~1.23 | CUDA OOM at e0 (time projection), step 0 |
| v4 | ERROR | ~0.04 | torchrun RAM-blocked; rank 1 SIGKILLed by host OOM killer at ~44 s |
| **v5** | **ERROR** | **1.78** | **CUDA OOM in block 0 attention, step 0; time projection passed** |

GPU-hour accounting (quota readings are authoritative; per-version
figures approximate): quota 1.97 h used before v5 → **3.75 h used /
26.25 h remaining** at v5's end (refresh Sat 28 Nov 2026 00:00 UTC).
v5 cost **1.78 GPU-h**. Cumulative proof spend: 3.75 h of 30 h.

All three gates (GPU / internet / storage), the weights check (34.18 GB,
8 files), the dependency check and the tokenizer remedy passed a fifth
time. The synthetic start image (1280x704, seed 42) was generated in
session; no external media was used (VDP-06).

## What a next attempt would need (NOT authorised — owner/reviewer decision)

1. **Prove placement first:** print per-block device + per-GPU memory
   after model load, before sampling; print per-GPU peaks in the
   generate cell before any assert. This closes the v5 evidence gap.
2. **Check VAE residency:** verify whether the VAE (2.8 GB fp32) stays
   on GPU 0 during sampling despite `--offload_model True`; offload it
   explicitly before sampling if it does.
3. **Deeper split** (e.g. blocks 10–29 on cuda:1) to give GPU 0 more
   headroom — meaningful only once placement is proven.
4. **Reduce the activation load** (fewer frames than 121, or lower
   resolution) — changes the proof target; needs the owner's word.
5. **A bigger single card** (e.g. Lightning AI L4, 24 GB — the vendor's
   own requirement class for this model) — needs the owner's word and
   an account decision.

Do NOT run a repeat or a v6 from this record — it needs the owner's
explicit go-ahead, as v5 did.

## Artifacts

- Run output: `gpu-cloud/packages/wan-proof-20261124-01/output-v5/`
  (`generate.log`, `nova-gpu-cloud-wan-proof-20261124-01.log`,
  `poll.log`, `measurement-plan.md`, `start-image.png`).
- Reviewer's measurement requirements: `architecture/wan-evidence-review-reply-verbatim-2026-11-24.md`.
- v5 design + VDP-03: `gpu-cloud/docs/connection-layer.md` §7 and the
  video plan.
