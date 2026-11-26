# Fun-InP Proof v9 — Failure Report

- **Date:** 25 November 2026 (~22:11 WAT)
- **Kernel:** `oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01`, version 8 (pushed ~22:00 WAT)
- **Status:** FAILED on the T4 memory gate. No clip produced. **The proof STOPS here — no v10.**

## Outcome

The kernel ran 5.75 min of execution (log t=0 → 345 s) and errored at CELL In [6] (t≈338 s): `OutOfMemoryError: CUDA out of memory. Tried to allocate 652.00 MiB. GPU 0 has a total capacity of 14.56 GiB of which 198.81 MiB is free. Including non-PyTorch memory, this process has 14.37 GiB memory in use. Of the allocated memory 14.12 GiB is allocated by PyTorch, and 112.37 MiB is reserved by PyTorch but unallocated.` The notebook raised `SystemExit` via papermill (`PapermillExecutionError`, exception at `In [6]`). Gates A+B+C passed (2× Tesla T4 14.56 GiB, torch 2.11.0+cu130, huggingface.co 200, 19.5 GB free disk); pip install returncode 0 in 18.5 s; git clone + checkout `98fffa92` returncode 0, HEAD confirmed.

## What worked — the furthest any version got

- **The `ftfy` fix WORKED.** Native imports OK at t≈62.5 s (`WanTransformer3DModel, AutoencoderKLWan, CLIPModel, WanFunInpaintPipeline, FlowMatchEulerDiscreteScheduler`). The v7 sync regression is closed.
- Asset inventory complete: keyframes hash-verified (run-6), umT5-XXL 243 tensors (242 F16 + 1 U8), scoped download 4.58 GiB in 10.5 s.
- T5 loaded (5.68B params, fp16), `tie_weights()` bound, prompt embeds finite (max|.|=3.656 prompt, 0.790 negative).
- Transformer remap 1,013 → 983 **EXACT MATCH**; CLIP surgery 520 → 392 **SUBSET MATCH** (392 text-tower params expected-missing).
- **The VAE decoder rebuild was EXERCISED and WORKED: 194/194 keys EXACT MATCH, loaded with `strict=True` in 3.0 s.** The v8 fix finally ran — the first time the rebuilt decoder loaded on GPU.
- Pipeline built; **DTYPE AUDIT before sampling: 0 bf16 params** — transformer 1.56B, VAE 0.13B, CLIP 1.19B, text encoder 5.68B, all 100% float16. FP16 *loading* is established — a first for this proof.
- Model CPU offload enabled; VRAM 0.01 GiB after offload; RSS 19.11 GiB. Video tensor (1, 3, 17, 576, 1024) float32 + mask built.

## The failure

The `pipe(...)` call died inside `prepare_mask_latents` → `self.vae.encode(masked_video)` → VAE encoder forward → `CausalConv3d` `F.pad` — while encoding the masked video, BEFORE any denoising step. The per-step callback never fired; zero denoising steps ran; no frames were decoded; no clip, no `fun-inp-proof-report.json`, no contact strip. The log does not break down the 14.12 GiB PyTorch allocation (no VRAM print inside `prepare_mask_latents`), so the exact resident mix at the failure is not recorded — only that the VAE encode at 1024×576×17 frames exhausted the 14.56 GiB T4.

## Classification

**A T4 memory gate failure.** This is the failure the strict stop rule covers: stop immediately, do not push through it, no setup changes to force a pass. A v10 would need exactly such changes (lower resolution/frames, chunked VAE encode) — explicitly forbidden by the reviewer's rule ("no further version, no setup changes to force a pass"). The owner's night order ("if v9 fails, v10 is the LAST attempt") was given for the `ftfy` retry; the task's strict stop rule governs a gate failure. **So the Fun-InP proof ends at nine attempts. LTX stands as the engine.** A reduced-config attempt would be a new authorisation for Shina, not a continuation of this proof.

## GPU-hours

v9 ≈ 0.10 GPU-h (execution ~345 s; queue not billed). Cumulative Fun-InP ≈ 0.44 GPU-h (v1–v6 ≈ 0.31, v7 = 0, v8 ≈ 0.03, v9 ≈ 0.10). Balance ≈ 26.12h remaining (refresh Sat 28 Nov 2026 00:00 UTC).

## FP16 verdict

**LOADING established, EXECUTION not established.** All four modules loaded 100% FP16 with 0 bf16 parameters — the first time the proof got that far. But no denoising step ever ran, so there are still zero generation measurements and no clip. The proof as specified (FP16 *plus a real generated clip*) fails at the memory gate.

## Retrieval note

The unfiltered `kaggle kernels output` pulled the 2.91 GB output archive (including the downloaded `fun-inp-weights/`) and failed after ~40 min with `OSError: [Errno 122] Disk quota exceeded` — a VM quota limit, not raw space (df shows 39G free; the quota was separately flagged the same evening). The 4.6 GB partial download was deleted. Re-fetched with `--file-pattern 'fun-inp-proof*'` — only the 49,568-byte kernel log; no report JSON and no MP4 exist (none was produced). Nothing from the archive was executed, imported, or copied.

## Record

Full record: `gpu-cloud/docs/fun-inp-connection-2026-11-25.md` (v9 section added). Kernel log: `gpu-cloud/scratch-v9/kernel-output/nova-gpu-cloud-fun-inp-proof-20261125-01.log` (49,568 bytes). Build script + regenerated v9 package: `gpu-cloud/scripts/build-fun-inp-proof-package.py`, `gpu-cloud/packages/fun-inp-proof-20261125-01/` (v8 notebook preserved at `gpu-cloud/scratch-v9/fun-inp-proof-v8.ipynb`; diff v9 vs v8 is only the `ftfy` line + comment + v9 history line).

— End of report. —
