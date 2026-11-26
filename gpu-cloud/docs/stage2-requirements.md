# Stage 2 requirements — connect a free GPU environment

Stage 1 built and tested the NOVA GPU Manager independently: jobs, queue,
reservations, ceiling, kill-switch, timeouts, reconciliation, persistence
— with the in-process mock as the only working provider. Stage 2 connects
a REAL free GPU environment to it. This document states exactly what Stage
2 must add, and what it must NOT change.

## What Stage 2 must add

### 1. A real executor for Kaggle (first free provider)

Implement an executor object with the manager's executor contract:

- `start(job) -> Promise<report>` — submits the job to the GPU
  environment and resolves with a provider report:
  `{ jobId, providerId, status, secondsUsed, costUsd, completedAt,
  resultRef, error }`. `resultRef` is an opaque delivery reference only
  — NEVER media bytes (O-27).
- `requestCancel(jobId) -> boolean` — requests cancellation of a running
  job. Returns whether the request was accepted by the provider. The
  manager already handles the honest case (the job may still complete);
  the executor must NOT pretend a request is a guarantee.

Register it with `manager.registerExecutor('kaggle-t4', executor)` and
mark the provider connected via `manager.registry.setConnected('kaggle-t4',
true)` + `setStatus('kaggle-t4', 'available')` only after a live
connection check passes.

### 2. The offline-staging procedure (VDP-04)

Kaggle GPU sessions have NO internet. Before any GPU run, Stage 2 must
provide and TEST a staging procedure covering the full dependency list:

- model weights, config + tokenizer files, VAE + text encoder,
- inference code + required Python packages,
- ComfyUI custom nodes / workflow dependencies (if used),
- any LoRAs + their configuration,
- a tested, offline-compatible installation procedure.

A **CPU-only preparation test is mandatory** before the GPU run: it must
confirm every required file is available locally and that the notebook
attempts no download during generation. Do NOT assume two T4 cards give
more working storage, or that any reported working-storage figure is
guaranteed.

### 3. Availability tracking against the weekly hour budget

Kaggle gives 30 GPU-hours/week (2× T4, 9–12h sessions). The executor (or
a provider-state updater) must track hours used and update the provider
record so the dispatcher stops assigning work when the budget is spent.
The store already has `providerState[providerId].hoursUsedThisWeek` for
this. Colab's budget (~12–15h/week, variable, GPU not guaranteed) needs
the same treatment when it is wired.

### 4. The GPU connection layer

The transport between the manager and the notebook environment. Stage 2
must define and document:

- how a job submission reaches the notebook (API, queue file, or other
  channel — no choice is made in Stage 1),
- how completion/failure is reported back (polling or push),
- how the delivery reference reaches the user WITHOUT the manager or any
  NOVA server retaining the media (O-27 transient-output rule: the MP4
  may exist transiently only as necessary to complete generation and
  delivery; any temporary provider-side output has a defined expiry and
  deletion behaviour).

### 5. Data-handling boundary (VDP-06)

Stage 2 runs use a synthetic prompt and a non-sensitive test image only.
No private user media, confidential project material, credentials, or
real customer content goes to Kaggle (Google-owned infrastructure) in
any Stage 2 test.

### 6. Precision + VRAM verification (VDP-03)

The first real run must record ACTUAL peak VRAM and whether the model
completed without out-of-memory errors, and verify the chosen precision
runs on a T4. "Candidate fit" in the registry becomes "verified fit"
only after a real run proves it. Two T4 cards are NOT one 32 GB pool
unless the workflow explicitly supports multi-GPU execution.

## What Stage 2 must NOT change

- The job lifecycle, queue ordering, reservation-before-dispatch rule,
  ceiling default (0) or kill-switch semantics. These are Stage 1
  contracts with passing tests; Stage 2 extends the PROVIDER side only.
- The store format version without a migration (bump `version` and
  migrate `defaultState()` if a new field is genuinely needed).
- The O-27 rule: no media bytes in the store, ever.
- The A2 boundary assumption (VDP-01): Stage 2 does not connect to the
  A2 gateway. That is Stage 4, after A2 approval + tested implementation.

## Stage 2 acceptance (before Stage 3)

1. A real Kaggle executor is registered and dispatchable.
2. The CPU-only preparation test passes (all files local, no downloads).
3. One end-to-end job runs on the real free GPU through the manager
   (submit → reserve → dispatch → complete → reconcile clean).
4. Hours-used tracking updates after the run.
5. The full Stage 1 test suite still passes (60/60) with the new
   executor present but the mock still available for offline tests.
6. Shina's verdict on the output (proof-before-batch is house law).

## Open questions for the owner (not Stage 2 blockers)

- Which Kaggle account runs the proof (Shina to confirm he has one)?
- Colab as a second free provider, or Kaggle only until Stage 3 proves
  the image path? (Recommendation: Kaggle only — one connection to prove
  before adding a second.)

---

# As-built state — Stage 2 Part A complete, 24 Nov 2026

**Owner decision (24 Nov ~16:36 WAT): BOTH providers — Kaggle AND
Colab.** The recommendation above ("Kaggle only") was overruled. Part A
built both executors; Part B (live) is gated on the owner's accounts
(see `docs/connection-layer.md` §7 for the exact unblock list).

## What was built (Part A)

| Requirement | As built | Evidence |
|---|---|---|
| §1 Real executor(s) | `KaggleExecutor` + `ColabExecutor`, both registered via `createGpuCloud()` (`src/setup.js`). Both stay `connected: false` / `not-connected` until a live connection check passes (Part B) — never marked connected without the live check. | `src/kaggle-executor.js`, `src/colab-executor.js`, `test/executors.test.mjs` (14), `test/stage2-integration.test.mjs` (7) |
| §2 Offline staging (VDP-04) | Staging manifests for Wan 2.2 TI2V-5B, two routes (official ~34.2 GB via dataset mount; ComfyUI ~18.15 GB). Mandatory CPU-only prep test built + tested locally. Self-contained notebook generator (nbformat-4) + standalone `check_env.py`. | `src/staging.js`, `test/staging.test.mjs` (13) |
| §3 Hours tracking | `HoursTracker` against the weekly budgets (Kaggle 30h, Colab 12h planning figure), wired into provider state + the registry (dispatcher stops assigning when spent; week rollover restores). | `src/hours.js`, `test/hours.test.mjs` (14) |
| §4 Connection layer | Documented per provider: what is automated vs what needs a human, with evidence. Kaggle: official CLI (automated with a credentialed transport in Part B; human runs the CLI until then). Colab: NO official API — honestly manual, always. Completion via the `start()` promise (polling) or `fileReport()` (manual). Delivery ref only — no media through the manager (O-27). | `docs/connection-layer.md`, `src/executor-base.js` |
| §5 Data boundary (VDP-06) | Enforced in the executor path: a job must be marked `params.stage2Test === true` and carry no user/private media or credentials; only `params.testImage: 'synthetic'` is allowed. Refusal, never a warning. | `src/data-guard.js`, `test/data-guard.test.mjs` (10) |
| §6 Precision + VRAM (VDP-03) | **NOT measured — needs a real run (Part B).** The notebook polls `nvidia-smi` every 5s and records sampled peak VRAM + OOM status in the completion report. The official README (≥24 GB VRAM) and the ComfyUI tutorial (~8 GB) conflict — the run decides. | `src/staging.js` (notebook §2–3), `docs/connection-layer.md` §4 |

## Corrections to this document's own assumptions (from the research)

1. **"Kaggle GPU sessions have NO internet" (§2) is NOT confirmed by
   Kaggle's own docs.** The docs describe internet as a session setting,
   ON by default for new notebooks. The offline-staging procedure stands
   regardless (reviewer-mandated, conservative). Whether a GPU session
   can download weights in-session is a Part B verification item.
2. **The video plan's "5B fits easily" (§2 context) is wrong for the
   official repo** — ~34.2 GB vs the 20 GB `/kaggle/working` limit
   (Kaggle's own docs). The official route stages via a dataset mount.
3. **The model's native 720P is 1280×704, not 1280×720** — the
   notebook uses the native size; the evidence record records the
   actual resolution.
4. **"9–12h sessions" (§3)** — Kaggle's docs say 12h for CPU and GPU
   sessions (9h TPU).

## Acceptance status

| # | Criterion | Status |
|---|---|---|
| 1 | A real Kaggle executor is registered and dispatchable | **PARTIAL** — registered, but NOT dispatchable until Part B's live connection check flips `connected` (by design: never mark connected without the live check). The Colab executor is registered the same way. |
| 2 | The CPU-only preparation test passes | **DONE** — built + tested locally (13 staging tests; `check_env.py` run against a fixture staging dir, failing honestly at the missing torch) |
| 3 | One end-to-end job runs on the real free GPU through the manager | **GATED (Part B)** — needs the owner's accounts. The full flow runs end to end locally with a simulated transport + the manual channel (7 integration tests). |
| 4 | Hours-used tracking updates after the run | **DONE locally** — recording + registry flip + rollover tested; a real run's hours land the same way via `fileReport` / the polling path |
| 5 | Full Stage 1 suite still passes (60/60) | **DONE — 60/60**, plus 58 new Stage 2 tests: **118/118 total** |
| 6 | Shina's verdict on the output | **GATED (Part B)** — no output exists until a real run |

## Open questions — answered / carried

- Which Kaggle account runs the proof? **STILL OPEN** — asked the
  owner 24 Nov ~16:18 + ~16:33 WAT, unanswered. Part B item B-K1.
- Colab as a second provider? **ANSWERED — yes, both** (owner,
  24 Nov ~16:36 WAT). Built.
- Which Google account for Colab? **OPEN** — Part B item B-C1.

## Latent Stage 1 bug (recorded, not fixed)

A synchronous throw from an executor's `start()` escapes
`dispatchNext` as a `JobTransitionError` instead of the clean
`provider-start-failed` result (`TRANSITIONS.queued` has no
`'failed'`). Stage 2 avoids it by contract (executors never throw
synchronously); fixing it changes the job-lifecycle contract and
needs a deliberate decision. Full detail: `docs/connection-layer.md`
§5.
