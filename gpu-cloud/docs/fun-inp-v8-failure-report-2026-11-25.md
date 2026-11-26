# Fun-InP Proof v8 — Failure Report for the Project 1 Reviewer

- **Date:** 25 November 2026 (~16:05 WAT)
- **Kernel:** `oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01`, version 7 (pushed ~14:54 WAT)
- **Status:** STOPPED on a new harness bug. No clip produced. No v9 attempted.

## Outcome

The kernel ran and errored at CELL2 (t≈96 s): `ModuleNotFoundError: No module named 'ftfy'` — importing `WanFunInpaintPipeline` triggers `videox_fun/pipeline/__init__.py` → `MOVAPipeline` → `import ftfy`. The notebook raised `SystemExit: NATIVE IMPORT FAILED (blocker)`; papermill raised `PapermillExecutionError`. Gates A+B passed (2× Tesla T4 14.56 GiB, torch 2.11.0+cu130, huggingface.co 200, 19.5 GB free disk); pip install returncode 0 in 23.5 s; git clone + checkout `98fffa92` returncode 0, HEAD confirmed. The VAE rebuild was never exercised — the run died before any model loaded.

## Root cause

A regression from the v7 build-script sync, not a new environment problem: the build script's pip install list has no `ftfy`. Version 2 (authorised ~08:45, "Yes — re-run it with ftfy added") added it and the fix worked — v2–v6 all passed the native import and failed later. The v7 sync dropped the entry. (The v6 notebook is gone — overwritten by the v8 regeneration — so the drop cannot be byte-compared, but the v2–v6 logs prove `ftfy` was installed then and the v8 log + script prove it is not now.)

## Classification

**NOT a T4 memory/FP16 gate failure.** This is a new harness bug beyond the authorised v8 scope, so per the stop rule the run was stopped with no fix attempted. The one-line fix would be restoring `ftfy` to the install list (the v2 fix, verbatim) — but that is a v9 change needing the owner's fresh word, and v8 was declared the last reasonable fix.

## GPU-hours

v8 ≈ 0.03 GPU-h (execution ~100 s; the ~70 min queue is not billed). Cumulative Fun-InP ≈ 0.34 GPU-h (v1–v6 ≈ 0.31, v7 = 0). Balance ≈ 26.22h remaining (refresh Sat 28 Nov 2026 00:00 UTC).

## What was verified before the push (all passed)

- VAE rebuild locally proven (`gpu-cloud/scratch-v8/verify-v8-vae.py`, no torch): notebook `convert_vae_keys` == simulation convert on the real 194 keys (identical); simulation baseline reproduced (43 shape + 2 name mismatches vs halved decoder); rebuilt decoder computed from the notebook's actual Sequential list gives **194/194 names, 0 shape mismatches**. Both latent v6 file-path fixes confirmed in the script (VAE reads the file `diffusion_pytorch_model.safetensors`; CLIP reads `model.safetensors`).
- Reproducibility proven by throwaway build (throwaway == regenerated real package byte-for-byte; throwaway deleted). Real package: 9 cells, all code cells parse, config unchanged (17 frames, 50 steps, guidance 6.0, seed 42, run-6 keyframes).

## FP16 verdict

**STILL NOT ESTABLISHED after eight versions, zero generation measurements.** The transformer remap, CLIP surgery, and VAE decoder rebuild are all proven locally; the only thing standing between the proof and actually running is the one-line `ftfy` restore.

## Decision needed from the owner

Authorise a v9 (restore `ftfy`, run the already-verified VAE rebuild) or stop the Fun-InP proof here. If the proof stops, LTX stands as the engine.

## Record

Full record: `gpu-cloud/docs/fun-inp-connection-2026-11-25.md` (v8 section added, 283 → 307 lines). Kernel log: `gpu-cloud/scratch-v8/kernel-output/nova-gpu-cloud-fun-inp-proof-20261125-01.log` (33 KB). Retrieval used `--file-pattern` only; one side effect — the `\.mp4$` pattern also matched a sample video inside the cloned VideoX-Fun tree — downloaded, then deleted immediately (repo-tree content, never executed/imported/copied).

— End of report. —
