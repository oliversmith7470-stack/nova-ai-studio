# NOVA GPU Cloud — Kaggle smoke test blocker: request for solutions

**Date:** 24 November 2026, ~18:51 WAT
**Project:** NOVA AI Studio — Personal GPU Cloud, Stage 2 Part B
**Account:** Kaggle user `oliversmithh` (Google sign-in oliversmith7470@gmail.com)

## What we are proving

That a free Kaggle GPU notebook can run our workloads. The smoke test
checks three things: a GPU is present, the notebook has internet, and the
working storage is as expected. If the smoke passes, the next step is a
one-clip proof run of the Wan 2.2 TI2V-5B video model (weights already
found as a public Kaggle dataset — no upload needed).

## The account state

- GPU quota: **30.00 hours/week, 0.00 used**, refresh Saturday 28 Nov 2026 00:00 UTC.
- Phone verification: **Verified** (owner verified it himself, 17:53 WAT).
- Identity verification (Persona): **NOT verified** — understood to gate
  TPUs only, not GPUs, but this is unconfirmed.
- No payment method, no paid plan. Free tier only; existing account only
  (no new accounts).

## Smoke v1 — what happened

- Kernel: `oliversmithh/nova-gpu-cloud-smoke-20261124-01`, pushed via the
  Kaggle CLI, ran and completed in under 3 minutes (~17:47–17:49 WAT).
- The push metadata requested GPU and internet explicitly:
  `"enable_gpu": true, "enable_internet": true`.
- The actual run: **CPU only, internet off.** `nvidia-smi` not found,
  torch 2.11.0+cpu, `cuda_available` False, 0 devices; both internet
  fetches failed on DNS. `/kaggle/working` confirmed at 20 GB.
  **0.00 GPU-hours used.**
- Kaggle gave **no error at push time** — the downgrade was silent.
- At the time v1 ran, phone verification was **not yet done**. That is
  our leading explanation, but it is not confirmed.

## Smoke v2 — current state

The v2 re-push (same smoke test, GPU + internet explicit in metadata)
has **not yet produced a run**. No v2 kernel exists on the account and
no v2 package is on disk yet. The re-push is still in progress on our
side; this brief is about the Kaggle behaviour, not the re-push timing.

## Questions

1. **Why would Kaggle silently downgrade a kernel that requests GPU +
   internet?** Is missing phone verification the cause, or are there
   other causes (identity verification also required for GPU? GPU
   availability? account standing? metadata fields insufficient)?
2. **What is the reliable way to guarantee a GPU + internet run on a
   kernels push via the CLI/API?** Are there additional metadata fields,
   flags, or a different push method we should use?
3. **If the API route keeps downgrading, what alternative proof route
   do you recommend?** (For example, running from the Kaggle web editor
   with GPU selected in the session options, or another method.)
4. **Should the smoke design itself change** before the Wan proof run?

## Constraints on any solution

Free tier only; no payment method and no paid plan. Existing account
only — no new accounts. Phone verified; identity (Persona) not
verified. The proof must stay honest: a GPU run must be a real GPU
run, verified by `nvidia-smi` and `torch.cuda.is_available()`, not
assumed from the push settings.
