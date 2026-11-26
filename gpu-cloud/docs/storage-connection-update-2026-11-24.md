# NOVA GPU Cloud — storage connected + smoke v2 queue update

**Date:** 24 November 2026, ~19:17 WAT
**Project:** NOVA AI Studio — Personal GPU Cloud

## 1. Cloud storage connected and tested

The storage engine is no longer standalone. It is wired into the GPU
Cloud system and proven end to end with a real file.

- **Live store:** `gpu-cloud/data/store/`, wired into `createGpuCloud()`.
  The manager exposes store, retrieve, delivery-reference, delete, usage
  and sweep operations. Job records hold references only — never media
  bytes.
- **End-to-end proof (real file):** the in-house proof clip (1,843,924
  bytes) was stored under `outputs`, retrieved byte-identical (SHA-256
  match, independently verified against the original), delivered by
  reference (redeemed successfully), and usage accounting confirmed.
- **Expiry proven on the live store:** short-TTL test objects were
  deleted by the sweep and by the running timer; their delivery
  references fail after deletion. The clip itself expires 25 Nov 18:14
  UTC under the 24-hour rule.
- **Full GPU Cloud test suite: 182/182 pass**, parent-verified
  (was 171; +11 new wiring tests).
- **Sweep host for this wiring:** the manager (the timer starts with
  it). The production host (API process, cron-triggered sweep, or a
  dedicated daemon) stays an open owner decision.
- **Scope:** the live-site NOVA API link remains Stage 4 — nothing on
  the live NOVA site reads or writes this store yet. The store is
  connected to the GPU Cloud system only.

## 2. Smoke v2 queue update (follows the blocker brief)

Correction to the brief's "the v2 re-push has not yet produced a run":
the push itself happened; the run has not started.

- **v2 pushed 16:55 UTC** (version 2, same package, T4 accelerator
  requested in the push command).
- **Status: QUEUED for 56+ minutes** — 105 status polls, every one
  `KernelWorkerStatus.QUEUED`, verified by a direct status check. No
  GPU allocated, 0.00 GPU-hours used.
- Likely cause: free-tier GPU contention at evening peak (the v1 CPU
  run started within ~30 seconds by comparison).
- No v3 push is planned — it would only re-queue behind v2. Next
  status check: in 1–2 hours or tomorrow morning off-peak.
