# NOVA Personal GPU Cloud — Stage 2: Kaggle + Colab executors

**Status: Stage 2 Part A complete — built and tested locally (24 Nov 2026).
NOVA Cloud Storage CONNECTED to the GPU Cloud system + proven end to end
with a real file (24 Nov 2026 ~19:14 WAT) — live store at
`gpu-cloud/data/store/`, manager-exposed store/retrieve operations, sweep
timer hosted on the manager.**
**Part B gated** — the live connection check, the end-to-end job on a real
free GPU, and the VDP-03 real-run measurement need the owner's accounts
(see [`docs/connection-layer.md`](docs/connection-layer.md) §7 for the
exact unblock list). Local code + tests only. No live GPU, no accounts, no
API keys, no network calls to any GPU provider, no commit/push/deploy.
Cost: ₦0.

Stage 1 (the GPU Manager: jobs, queue, reservations, ceiling, kill-switch,
timeouts, reconciliation, persistence) is complete and its suite stays
green (60/60). Stage 2 adds the two free-GPU executors on top of it.

The GPU Manager is the orchestration core of Shina's zero-cost GPU
computing infrastructure for NOVA AI STUDIO: our own software that connects
available free GPU resources to NOVA, instead of depending entirely on paid
GPU providers. It does NOT manufacture a physical GPU.

## What it does

- **Job model** — unique idempotent job id per client-supplied idempotency
  key (one key = exactly one job, one dispatch); types image / video /
  other; status lifecycle `queued → dispatched → running →
  succeeded | failed | cancelled | timed-out`; timestamps; provider id;
  cost record (provider-reported usage vs NOVA's own measurement).
- **Provider registry** — providers with id, kind, GPU type, per-card VRAM,
  availability window, cost model and status. Ships one WORKING provider
  (the in-process mock) plus Kaggle, Colab and RunPod DEFINITIONS
  (capability data only, `connected: false` — Stage 2 wires the real
  connection).
- **Queue** — FIFO with priority; duplicate submission protection (same
  idempotency key returns the existing job); max queue depth (default 100).
- **Dispatcher** — assigns queued jobs to available providers matching
  capability (model support, per-card VRAM, capacity). **Quota reservation
  before dispatch**: a reservation record is created before any dispatch
  and released on every terminal state.
- **Global spending ceiling** — see below.
- **Kill-switch** — stops new dispatches; queued jobs are cancelled;
  running jobs get a cancellation REQUEST (honest rule, VDP-02: a gateway
  kill cannot guarantee a running GPU job stops or that a provider won't
  charge for an accepted job). A provider that completes anyway has its
  outcome recorded and its cost kept for reconciliation.
- **Timeouts** — max generation time per job type (image 5 min, video
  30 min, other 10 min; overridable per job). A timed-out job is flagged
  for reconciliation — the provider may still charge for the run NOVA
  gave up on.
- **Reconciliation** — compares provider statements against NOVA's job
  records and flags mismatches (unknown job, provider/status/cost/seconds
  mismatch, charged-for-failed-job, missing statement). Read-only on jobs.
- **Persistence** — job records in a local file-backed JSON store
  (`data/gpu-manager.json`) with atomic writes (temp file + fsync +
  rename). **Records only — never image or video bytes (O-27).**

## The zero-cost ceiling rule

The global spending ceiling lives in the store and **defaults to 0**
(zero-cost mode). **Paid providers are NEVER dispatched while the ceiling
is 0.** A paid dispatch proceeds only when the ceiling covers the job's
estimated cost on top of already-committed spend.

Raising the ceiling is an **owner decision, not a code default**:
`setSpendingCeiling(value, { authorizedBy, reason })` requires both fields
and records every change in the store's audit trail. Lowering the ceiling
back to 0 blocks further paid dispatch immediately (in-flight jobs are
unaffected — they were dispatched under an earlier decision).

## Boundaries (reviewer VDP corrections)

- **VDP-01** — the manager provides its OWN boundary now. It does NOT
  assume the A2 gateway is deployed. Stage 4 connects it to the A2
  boundary when that becomes available.
- **VDP-02** — the kill-switch stops new dispatches only. Running-job,
  retry and provider-cost controls are defined in the plan; the manager
  implements the honest subset: cancellation requests, late-report
  capture, reconciliation flags.
- **O-27** — no persistent media storage. The job record holds an opaque
  delivery reference (`resultRef`), never media bytes.

## Stage 2: what was added

- **Two executors** implementing the manager's contract
  (`start(job) → Promise<final report>`, `requestCancel(jobId) →
  boolean`): `kaggle-t4` and `colab-t4`, both registered by
  `createGpuCloud()` (`src/setup.js`). Both stay `connected: false` /
  `not-connected` until a live connection check passes (Part B).
- **Kaggle is automatable; Colab is honestly manual.** Kaggle has an
  official CLI (`kaggle kernels push/status/output`) — with a
  credentialed transport (Part B) the executor pushes and polls; until
  then a human runs the CLI. Colab has NO official API (Google's FAQ:
  "not possible to run Colab notebooks programmatically... unless you
  leave your browser running") — the executor prepares the notebook
  and a human runs it, every run. No fake API, no UI-driving.
- **The promise is the completion channel.** `start()` stays pending
  until the provider completes; the manual channel files the report
  via `executor.fileReport(report)` (or the `fileReport(manager,
  executor, report)` helper). A report with status `'running'` would
  finalize as failed — `start()` never resolves one.
- **Offline staging (VDP-04)** — manifests for Wan 2.2 TI2V-5B, two
  routes: official (~34.2 GB — exceeds Kaggle's 20 GB working storage,
  so it stages via a dataset mount) and ComfyUI repack (~18.15 GB).
  The mandatory CPU-only preparation test is built and tested locally;
  the notebook generator produces a self-contained nbformat-4 notebook
  (every Python cell verified with `py_compile`) and a standalone
  `check_env.py`.
- **Weekly hours tracking** — Kaggle 30h/week, Colab 12h/week
  (conservative planning figure; Colab's cap is unpublished). The
  dispatcher stops assigning when a budget is spent; the week rolls
  over (default Saturday 00:00 UTC, reported not verified — Part B
  confirms).
- **VDP-06 data boundary** — enforced in the executor path: a job must
  be marked `params.stage2Test === true` and carry no user/private
  media or credentials; only `params.testImage: 'synthetic'`. Refusal,
  never a warning.
- **Honest cancel** — neither free tier offers a programmatic cancel
  (Kaggle has no CLI cancel command; Colab has no API), so
  `requestCancel()` returns `false`. The manager records the request;
  a run that completes anyway is preserved as `cancelOutcome` (VDP-02).

Full detail, per-provider automation-vs-human tables, evidence, and the
Part B unblock list: [`docs/connection-layer.md`](docs/connection-layer.md).
As-built status against the Stage 2 requirements:
[`docs/stage2-requirements.md`](docs/stage2-requirements.md).

## NOVA Cloud Storage — connected (24 Nov 2026)

Our own object store, built first as an engine (content-addressed,
chunked, integrity-verified, retention-aware) and now wired into the
system: `createGpuCloud()` attaches a live `NovaStorage` (local
filesystem backend, home `data/store/`) to the manager, and the manager
exposes store/retrieve operations for job outputs —
`storeJobOutput` / `getJobOutput` / `headJobOutput` /
`issueJobDeliveryRef` (stored as the job's `resultRef`) /
`deleteJobOutput` — plus usage, capacity, the manual sweep and the
sweep timer. Job records hold references only, never media bytes
(O-27). Retention follows the owner's rule: generated outputs
(`outputs` / `media` / `text`) expire 24h after creation and are
deleted automatically; models, job records and projects persist.

- Live proof: the in-house proof clip (1,843,924 bytes) stored under
  `outputs`, retrieved byte-identical with a matching SHA-256,
  delivered by reference; expiry proven with short-TTL objects (manual
  sweep + timer). Full evidence:
  [`docs/storage/live-connection-evidence-2026-11-24.md`](docs/storage/live-connection-evidence-2026-11-24.md).
- Sweep host for this wiring: the manager
  (`startStorageSweep` / `stopStorageSweep`); live runner
  `scripts/run-gpu-cloud.mjs` boots the cloud and tends the timer. The
  production host is still an open owner decision.
- Re-run the live proof: `node scripts/storage-live-test.mjs`.
- Design + open decisions: [`docs/storage/design.md`](docs/storage/design.md).
- The live-site NOVA API link is Stage 4 — nothing on the live NOVA
  site reads or writes this store yet.

## Run the tests

```sh
npm test        # full suite (node:test, no external dependencies)
npm run test:all  # same suite, explicit file list
```

182 tests, all passing (24 Nov 2026): Stage 1's 60 + 58 Stage 2 +
53 storage engine + 11 storage wiring.

## Layout

```
gpu-cloud/
  package.json          # nova-gpu-cloud, ESM, node >= 20
  src/
    index.js            # public exports (Stage 1 + Stage 2)
    gpu-manager.js      # orchestrator: submit/dispatch/cancel/kill/timeout/reconcile
    job.js              # job model + lifecycle state machine
    store.js            # file-backed JSON store, atomic writes
    providers.js        # provider registry + definitions (mock/Kaggle/Colab/RunPod)
    mock-provider.js    # the Stage 1 simulator (still the only live-dispatchable provider)
    queue.js            # FIFO-with-priority ordering
    reservations.js     # quota reservation ledger
    kill-switch.js      # kill-switch state + audit log
    reconcile.js        # provider-statement reconciliation
    setup.js            # Stage 2: createGpuCloud() factory + fileReport() helper
    executor-base.js    # Stage 2: shared executor base (guards, deferred completion)
    kaggle-executor.js  # Stage 2: Kaggle T4 executor (CLI transport seam + manual channel)
    colab-executor.js   # Stage 2: Colab T4 executor (manual channel only — no API)
    data-guard.js       # Stage 2: VDP-06 data boundary (refuse, never warn)
    hours.js            # Stage 2: weekly GPU-hours tracking + registry sync
    staging.js          # Stage 2: VDP-04 manifests, prep test, notebook generator
    storage/            # NOVA Cloud Storage engine (content-addressed, chunked,
                        # integrity-verified, retention-aware) + local backend
  scripts/
    build-smoke-package.mjs  # smoke kernel package builder (Part B)
    validate-notebook.py     # notebook validation
    storage-live-test.mjs    # live storage proof (real file, real store)
    run-gpu-cloud.mjs        # live runner: boots the cloud, tends the sweep timer
  test/                 # node:test suites (one file per area) + support files
  docs/
    stage2-requirements.md  # Stage 2 spec + as-built status
    connection-layer.md     # Stage 2: per-provider automation vs human, evidence, Part B list
    storage/            # storage design doc + live-connection evidence
  data/                 # local job records (data/gpu-manager.json) + the live
                        # object store (data/store/) — gitignored, never committed
  packages/             # job packages (notebook + metadata + instructions; created on dispatch)
```

## Design decisions recorded

- **Head-of-line blocking**: the dispatcher takes the first queued job and
  stops if no provider can run it — it does not skip ahead. Skipping is a
  Stage 2+ decision (it changes fairness guarantees).
- **Single-process store**: the manager is the only writer. Stage 4 must
  decide the multi-process story before the store is ever shared.
- **Estimates are planning figures**: a paid cost estimate is per-second
  rate × estimated seconds — not a guaranteed ceiling (VDP-08). The
  ceiling enforces against estimates; reconciliation catches real drift.
- **Cancel-completed is not a mismatch**: when a provider completes a job
  NOVA cancelled, both records are true. Reconciliation accepts it and
  keeps the cost visible.

## Stage 2 design decisions recorded

- **Refusals resolve, never throw.** `start()` never throws
  synchronously — a sync throw would escape `dispatchNext` as a
  `JobTransitionError` (a latent Stage 1 bug: `TRANSITIONS.queued` has
  no `'failed'`; see `docs/connection-layer.md` §5). The fix would
  change the job-lifecycle contract, so Stage 2 avoids the bug by
  contract instead of fixing it unilaterally.
- **The manager process stays running during a manual job.** The
  pending `start()` promise lives in memory; a restart loses it and
  `fileReport` returns `{ filed: false, reason: 'no-pending-job' }`.
  A persistent pending-report queue is a Stage 3 item (it needs a
  deliberate contract decision).
- **Per-job timeouts cover the human step.** A manual run's wall time
  includes the human handling it, so Stage 2 jobs set
  `params.timeoutMs` to cover the human step + the run (the default
  video timeout is 30 min). A job that times out before its report is
  filed lands in `lateReports`, not dropped.
- **The 20 GB figure is Kaggle's documented limit, not a guarantee of
  free space.** The prep test never assumes a storage figure; a limit
  is passed in by the caller or no limit is asserted.

## What comes next (Part B, then Stage 3)

Part B needs the owner's accounts: which Kaggle account (+ phone
verification + API credentials for the automated channel), which Google
account for Colab, and a human to run the first notebook. The exact
list is [`docs/connection-layer.md`](docs/connection-layer.md) §7.
Stage 3 tests an open-source image-generation model on the connected
GPU.
