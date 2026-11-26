# NOVA Personal GPU Cloud — Connection Layer (Stage 2, as built 24 Nov 2026)

How the GPU Manager reaches the two free GPU environments — Kaggle and
Colab — and, honestly, what each link can and cannot do. Every claim in
§2–§3 carries its evidence. Where the evidence contradicts the video
plan, the plan is wrong and this document says so.

**Status: Part A complete (built + tested locally, 118/118). Part B
gated** — the live connection check, the end-to-end job on a real free
GPU, and the VDP-03 real-run VRAM/precision measurement all need the
owner's accounts, which are not confirmed. §7 lists exactly what Part B
needs per provider.

## 1. The contract the executors implement

The manager's executor contract (Stage 1, unchanged):

```
start(job) -> Promise<provider report>
  { jobId, providerId, status, secondsUsed, costUsd, completedAt,
    resultRef, error }
requestCancel(jobId) -> Promise<boolean>   // a request, not a guarantee
```

**The promise is the completion channel.** `dispatchNext()` marks the
job dispatched → running the moment `start()` is called, and finalizes
it only when the returned promise resolves (`_finalizeFromProvider`).
A report with status `'running'` would be treated as a FAILED
completion — anything not `'succeeded'` finalizes as failed. So
`start()` never resolves with a `'running'` report: it resolves with
the FINAL report (`succeeded`/`failed`) and stays pending until the
provider completes.

That shapes the two channels:

| Channel | Who resolves the promise | Used by |
|---|---|---|
| Automated (polling) | The executor polls the provider API in the background | Kaggle, only when a credentialed transport is injected (Part B) |
| Manual (`fileReport`) | The operator files the provider's completion report | Colab (always); Kaggle without a transport |

`fileReport(report)` on the executor resolves the job's pending
`start()` promise. The `fileReport(manager, executor, report)` helper
in `src/setup.js` files the report and waits for the job to finalize.

**Refusals resolve, never throw.** Every executor refusal (VDP-06 data
boundary, spent hours budget, unknown model, failed staging prep test,
failed transport push) resolves as a FAILED report. `start()` never
throws synchronously — see §5 for the latent Stage 1 bug this avoids.

**No media ever passes through the manager (O-27).** The completion
report carries `resultRef: "manual-download:<mp4>"` — an opaque
reference. The human downloads the MP4 separately. The manager stores
records only.

## 2. Kaggle — what is automated vs what needs a human

### The mechanism (researched 24 Nov 2026)

Kaggle **does** have an official remote-execution API — the Kaggle CLI
(`kaggle-api`, Kaggle/kaggle-cli docs, fetched 24 Nov 2026):

- `kaggle kernels push -p <folder> [--accelerator NvidiaTeslaT4] [-t timeout]` — uploads the notebook **and runs it**
- `kaggle kernels status` — polls the run state
- `kaggle kernels output -p <dir> [--file-pattern]` — downloads artifacts
- `kaggle kernels logs` / `files` / `pull` / `delete` — also exist

Accelerators (Sep 2026): NvidiaTeslaT4 (GPU T4 ×2, the default GPU),
A100, L4, L4X1, TPU v5e/v6e, H100, RtxPro6000 (some
competition/admin-only).

### Automated vs human

| Step | Who | Evidence |
|---|---|---|
| Job package (notebook + kernel metadata + staging manifest + instructions) | **Automated** — `KaggleExecutor.submit()` | `src/kaggle-executor.js`; `test/executors.test.mjs` |
| VDP-06 guard, hours-budget check, staging prep test | **Automated** — in `start()`, before any submission | `src/executor-base.js` |
| `kaggle kernels push` + polling + output download | **Human** in Stage 2 (no transport); **automated** in Part B with a credentialed transport | The CLI needs credentials (`kaggle.json` / API token / `kaggle auth login`) — a credential, so Part B only |
| Kaggle account + phone verification | **Human** (Part B) | Phone verification gates the GPU accelerator and the Internet toggle (reported from Kaggle's product-feedback threads + 2026-06 research; not on the docs pages read) |
| 34 GB weights dataset upload | **Human** (Part B) | The official weights exceed the 20 GB `/kaggle/working` limit (see §4); they ride on a dataset mount at `/kaggle/input` |
| Filing the completion report | **Human** (`fileReport`) until a transport exists | The notebook writes `<jobId>.report.json`; the human downloads it and files it |

### What Kaggle cannot do

- **No cancel command.** The CLI has no cancel (`kaggle kernels`
  subcommands are list/init/push/pull/output/status/files/logs/delete —
  verified against the kaggle-api reference). A runaway run is stopped
  in the web UI. `requestCancel()` therefore returns `false`, honestly.
- **Only the `code_file` text is sent on push.** Sibling files are NOT
  uploaded (kaggle-api reference). The notebook is therefore
  self-contained — it inlines the env check and the generation call and
  imports nothing from a sibling file. Helpers must be inlined or
  shipped via a dataset source.
- **Secrets have no CLI support.** Kaggle Secrets are web-UI only. The
  proof run needs no secrets.

### Session facts (kaggle.com/docs/notebooks, fetched 24 Nov 2026)

- 12h execution for CPU and GPU sessions; 9h for TPU.
- **20 GB auto-saved disk in `/kaggle/working`** (confirmed first-party
  — the "73 GB" figure seen in third-party sources is not supported by
  the docs page), plus additional scratchpad disk (not saved).
- T4 ×2 = 2× T4, 4 vCPU, 29 GB RAM; P100 = 1× P100, 4 vCPU, 29 GB RAM.
- Interactive sessions have 20 minutes idle time.
- "Save & Run All" runs the notebook top-to-bottom in a fresh session
  (up to 12h) — the commit/batch path, same as `kaggle kernels push`.
- Weekly GPU quota ~30h (plan-verified; reset day ~Sat 00:00 UTC per a
  2026-06 research doc — REPORTED, not verified from Kaggle directly).
  The hours tracker defaults the week to Saturday 00:00 UTC; Part B
  confirms the real reset day via `kaggle quota` and corrects it if
  needed.
- **Internet: the plan's "no internet during GPU sessions" is NOT
  confirmed by Kaggle's own docs.** The docs describe internet as a
  session setting, ON by default for new notebooks, with
  internet-disabled required only for select competition submissions.
  The offline-staging procedure stands regardless (reviewer-mandated,
  conservative); whether a GPU session can download weights in-session
  is a Part B verification item. The kernel metadata sets
  `enable_internet: false` for the proof run.
- **Papermill gotcha:** Kaggle runs committed notebooks via papermill,
  which kills a kernel that produces no output for ~4s. Long cells must
  print progress regularly — every long cell in the generated notebook
  prints with `flush=True`.

### The transport seam (Part B)

An injected transport is an object with:

```
push(packageDir)  -> Promise<{ ok, kernelId?, error? }>
status(kernelId)  -> Promise<{ state: 'running'|'complete'|'error', error? }>
output(kernelId)  -> Promise<provider report>
```

A real transport execs the Kaggle CLI with the owner's credentials.
With a transport, `start()` pushes and polls in the background
(default 60s interval — the CLI is rate-limited; do not poll fast),
with a 12h poll backstop (Kaggle's session limit). A transient poll
failure is recorded and retried; the poll timeout bounds a dead
transport. Tests use a simulated transport
(`test/executors.test.mjs`).

## 3. Colab — what is automated vs what needs a human

### The mechanism (researched 24 Nov 2026)

**There is no official Colab API.** Google's own FAQ (quoted by two
independent 2026 sources; symphony-neocloud-bridge research from
official docs, 2026-06, fetched 24 Nov): it is "not possible to run
Colab notebooks programmatically... unless you leave your browser
running." No official way exists to start a runtime, run code
headlessly, or fetch outputs. The paid ToS bans access "other than by
means authorized by Google" — paying does not legitimize headless
brokering. The only "automation" is headless-Selenium UI-driving (e.g.
`colabctl`), which breaks on UI changes and faces idle-disconnect +
non-guaranteed GPU. **It is not used.**

So the Colab executor is **honestly manual**: it prepares the job
package and the human runs it in their browser. There is no transport
seam — nothing to inject — because there is no API to call.

### Automated vs human

| Step | Who | Evidence |
|---|---|---|
| Job package (notebook + staging manifest + instructions) | **Automated** — `ColabExecutor.submit()` | `src/colab-executor.js` |
| VDP-06 guard, hours-budget check, staging prep test | **Automated** — in `start()`, before any submission | `src/executor-base.js` |
| Open the notebook, select the T4 runtime, run all cells | **Human, every run** | No API exists |
| Keep the browser open during the run | **Human, every run** | No background execution — execution STOPS when the browser closes |
| Download the report + MP4, file the report | **Human** (`fileReport`) | No API exists |
| Cancel | **Human** (Runtime > Disconnect and delete runtime) | No API exists; `requestCancel()` returns `false` |

### Free-tier facts

- 12h max session; NO background execution.
- T4 subject to quota + availability (**not guaranteed**). A Colab run
  can fail at the "get a GPU" step for reasons outside the manager's
  control — the human reports that as a failed report
  (`error: colab-gpu-unavailable`) so the job can be retried on Kaggle.
  Do not retry Colab in a loop — the quota is unpublished and retries
  burn it.
- Idle timeouts and usage caps UNPUBLISHED ("Colab does not publish
  these limits"). The 12–15h/week figure is a third-party estimate;
  the tracker uses **12h as the conservative planning figure**.
- **Colab sessions HAVE internet** — the weights download in-session
  (the notebook has a download cell). No dataset upload is needed.

## 4. Offline staging (VDP-04)

The proof model is **Wan 2.2 TI2V-5B** (Apache 2.0, T2V+I2V, 720P at
24 FPS). The staging manifests live in `src/staging.js`, verified
against the official Hugging Face repo file listing and the Wan2.2
README on 24 Nov 2026.

### Two corrections to the video plan

1. **SIZE.** The plan §3 says "the 5B / 1.3B models (a few GB) fit
   easily". That does NOT hold for the official TI2V-5B repo: the
   listed files total **~34.2 GB** (diffusion shards ~20 GB
   FP32-stored + T5 encoder 11.4 GB + VAE 2.82 GB), which EXCEEDS
   Kaggle's 20 GB `/kaggle/working`. The official route therefore
   stages via a **Kaggle Dataset mount** (`/kaggle/input`), not working
   storage.
2. **FRAME SIZE.** The model's native 720P is **1280×704, not
   1280×720**. The VDP-05 evidence record's "1280×720 target" is a
   target; the notebook uses the native size and the report records the
   ACTUAL resolution.

### The two routes

| | Official (default) | ComfyUI repack |
|---|---|---|
| Source | Wan-AI/Wan2.2-TI2V-5B | Comfy-Org/Wan-2.2 |
| Total | ~34.2 GB | ~18.15 GB (FP16 diffusion 10.0 GB + FP8 T5 6.74 GB + VAE 1.41 GB) |
| Fits 20 GB working storage? | **No** — dataset mount | Yes, with ~1.85 GB headroom (tight) |
| Generation | `generate.py` — one vendor-documented command | ComfyUI server + workflow JSON (validated in Part B) |

The default is `official`: the generate command is fully documented in
the Wan2.2 README (`generate.py --task ti2v-5B --size 1280*704
--ckpt_dir ./Wan2.2-TI2V-5B --offload_model True
--convert_model_dtype --t5_cpu --prompt "..."`; torch >= 2.4.0), and
the dataset step is a standard Kaggle operation. The ComfyUI route
saves the dataset step but adds a ComfyUI install + workflow JSON.
The executor takes a `route` option (default `'official'`).

### The mandatory CPU-only preparation test

`runPreparationTest(manifest, { rootDir, storageLimitBytes, offline,
sizeTolerance })` verifies a staging directory BEFORE any GPU run:

1. Every required file exists and is non-empty; a file smaller than
   `sizeTolerance` × its listed size (default 0.5) counts as truncated
   — a failed download, not a pass.
2. In offline mode, NO run-plan step needs the network.
3. Storage accounting: the total is computed; if the caller passes a
   storage limit, fits/headroom are reported — if not, **no limit is
   asserted**. The test never assumes a storage figure.

It is built and tested locally (`test/staging.test.mjs`, 13 tests):
fixture files stand in for the real weights, a small synthetic manifest
checks the truncation/network logic, and the real manifests are checked
for presence + structure + totals. The same checks run inside the
target environment as the notebook's first cell (`CHECK_ENV_PY`, also
runnable standalone in a CPU session before the GPU session starts).
`check_env.py` was run locally against a fixture staging dir on
24 Nov 2026: it passed the offline-flags check and failed honestly at
"torch is not installed" (torch is not on this VM — expected; the full
check runs in the GPU environment). Without the offline flags it fails
at the flags check. Both failure modes exit non-zero.

### VDP-03 (still open — a real run measures it)

The official README says TI2V-5B needs "at least 24GB VRAM (e.g. RTX
4090)" with offloading; the ComfyUI tutorial says the repack "should
fit well on 8GB vram with native offloading". These conflict. VDP-03
stands: **measure on a real run.** The notebook polls `nvidia-smi`
every 5s during generation and records sampled peak VRAM in the
completion report (sampling, not allocator-exact). T4 precision is
verified by the run itself.

## 5. The latent Stage 1 bug (recorded, not fixed)

If an executor's `start()` throws SYNCHRONOUSLY, the manager's
`dispatchNext` catch block calls `_failJob`, which calls
`transition(queued → failed)` — but `TRANSITIONS.queued` is only
`['dispatched', 'cancelled']`, so it throws a `JobTransitionError` out
of `dispatchNext` instead of returning the clean
`{ dispatched: false, reason: 'provider-start-failed' }` result.

**Stage 2 avoids it by contract, not by fixing it:** executors must
NEVER throw synchronously from `start()` — refusals resolve as failed
reports (or rejected promises, which the manager's `.then` rejection
handler finalizes cleanly). The base class enforces this with a
try/catch around the whole `start()`. A test proves it (a transport
that throws synchronously still resolves a failed report).

Fixing the bug would change the job-lifecycle contract (Stage 1
contracts are frozen) and needs a deliberate decision — recorded here
for the parent. The fix would be in `gpu-manager.js` `dispatchNext`'s
catch block (transition the job through `dispatched` first, or add
`'failed'` to `TRANSITIONS.queued`).

## 6. The operator's runbook (manual channel)

1. Start the manager with `createGpuCloud()` and keep the process
   running while a manual job is out (a restart loses the pending
   `start()` promise — see below).
2. Submit a Stage 2 job (`params.stage2Test: true`,
   `params.testImage: 'synthetic'`, a synthetic prompt). Set
   `params.timeoutMs` to cover the human step + the run (the default
   video timeout is 30 min; a Kaggle run + human handling can exceed
   it — the per-job override exists for this).
3. Dispatch (`dispatchNext()`). The package lands in
   `packages/<jobId>/`.
4. Follow the package README (Kaggle) or INSTRUCTIONS.md (Colab).
5. When the notebook finishes, download `<jobId>.report.json` and the
   MP4. File the report: `fileReport(manager, executor, report)`.
6. The job finalizes; the GPU seconds are recorded against the weekly
   budget.

**If the job times out before the report is filed:** the manager marks
it timed-out and flags `reconciliationNeeded`; the late report is kept
in `lateReports`, not dropped (the Stage 1 late-report path). File the
report anyway — the hours are still recorded.

**If the manager restarts while a manual job is out:** the pending
promise is lost and `fileReport` returns `{ filed: false, reason:
'no-pending-job' }`. The job stays `running` in the store until the
timeout sweep marks it timed-out. A persistent pending-report queue
(a public `manager.fileReport` that finalizes from the store) is a
Stage 3 item — it needs a deliberate contract decision, so Stage 2
does not invent one.

## 7. Part B — the exact unblock list

Part B needs the owner's accounts, which are NOT confirmed. Nothing in
Part B is attempted in Stage 2.

### Kaggle

| # | Needed | Why | Who |
|---|---|---|---|
| B-K1 | A Kaggle account (which one? — the owner's answer) | The CLI and the dataset both need an account | Owner |
| B-K2 | Phone verification on that account | Gates the GPU accelerator and the Internet toggle | Owner (hand) |
| B-K3 | The Kaggle username | Fills `<kaggle-username>` in `kernel-metadata.json` + the dataset reference | Owner (one answer) |
| B-K4 | Kaggle API credentials (`kaggle.json` / API token) — for the automated channel only | `kaggle kernels push` needs credentials; the manual channel (human runs the CLI) does not need them in the manager | Owner (Secure Vault, never chat) |
| B-K5 | The 34 GB official weights uploaded as a private dataset `wan22-ti2v-5b` | The official route stages via a dataset mount (20 GB working-storage limit) | Owner (hand, or the manager with B-K4) |
| B-K6 | The live connection check: `kaggle kernels push` of a trivial notebook, status poll, output download | Proves the CLI works end to end before the proof job | Manager (with B-K4) or owner (manual) |
| B-K7 | Confirm the weekly reset day (`kaggle quota`) | The tracker defaults to Saturday 00:00 UTC (reported, not verified) | Manager (with B-K4) |
| B-K8 | Confirm whether a GPU session can download weights in-session | The docs say internet is a session setting ON by default; the offline procedure stands regardless | Manager (with B-K4) |

### Colab

| # | Needed | Why | Who |
|---|---|---|---|
| B-C1 | A Google account for Colab (which one? — the owner's answer) | Colab needs a signed-in Google account | Owner |
| B-C2 | A human to run the notebook in the browser (every run) | No API exists; this is permanent, not a Part B gap | Owner (hand) |
| B-C3 | The live connection check: open the generated notebook in Colab, select a T4 runtime, run the env-check cell | Proves the notebook + the T4 are reachable before the proof job | Owner (hand) |

### Both

| # | Needed | Why | Who |
|---|---|---|---|
| B-1 | The end-to-end proof job: one Wan 2.2 TI2V-5B clip through the manager, owner's verdict | Phase 1 proof (proof-before-batch is house law) | Manager + owner |
| B-2 | VDP-03 measurement: actual peak VRAM + OOM status + precision from the real run | Resolves the 24 GB vs 8 GB VRAM conflict (§4) | The run itself |
| B-3 | Notebook validation against the real environments | The notebook is a template until it runs (it says so in its first cell); the ComfyUI workflow JSON is supplied at Part B | Manager + owner |

### Part B progress (24 Nov 2026, smoke stage)

Smoke kernel `oliversmithh/nova-gpu-cloud-smoke-20261124-01` pushed
(version 1, 16:46 UTC), ran, **COMPLETE in under 3 minutes** — on CPU
with no internet (see B-K2/B-K8 below). Package:
`packages/smoke-20261124-01/` (notebook, kernel metadata, manifest,
README, `output/smoke.report.json` + log, `pulled/` copy).

- **B-K1/B-K3 — ANSWERED, with a correction:** the Kaggle username is
  **`oliversmithh`** (author "Oliver Smithh", verified via `kaggle
  kernels list --mine`) — NOT `Oliversmith7470` (the Google account
  name). The push accepts either owner string in the metadata id, but
  status/output need the canonical ref. The generator
  (`scripts/build-smoke-package.mjs`) now uses `oliversmithh`.
- **B-K4 — CONFIGURED:** token file `~/.kaggle/access_token`; Kaggle
  CLI 2.2.5 at `gpu-cloud/.venv-kaggle/bin/kaggle`. Never print, copy,
  or log the token value.
- **B-K7 — CONFIRMED:** `kaggle quota` shows GPU 0.00h used / 30.00h
  total, refresh 2026-11-28T00:00:00Z (Saturday). The tracker's
  Saturday-00:00-UTC default is correct.
- **B-K6 — TRANSPORT PROVEN, GPU NOT PROVEN:** push, status poll,
  output download, and logs all work end to end via the CLI. But the
  run executed on **CPU** (torch 2.11.0+cpu, cuda_available False,
  nvidia-smi not installed) despite `enable_gpu: true` in the metadata
  AND `--accelerator NvidiaTeslaT4` on the push — and consumed **0.00
  GPU-hours**. The metadata WAS applied (the kernel title matches), so
  the accelerator request was submitted and not honoured.
- **B-K2 — PHONE VERIFICATION UNKNOWN, leading explanation:** the only
  account-level gate that blocks GPU *and* internet together is phone
  verification (§2). No error appeared at push — the failure mode is a
  SILENT downgrade to CPU + offline, not a rejection. This is the
  leading explanation, NOT yet directly verified: the owner (or a
  browser check) must confirm the phone-verification status in Kaggle
  Settings and the kernel page's Accelerator setting. After
  verification, re-run the smoke kernel (re-push, version 2) to
  confirm GPU + internet. Do NOT assume push success means a GPU was
  allocated — the Wan notebook's env-check cell (assert
  `torch.cuda.is_available()`) is the loud guard, and the smoke
  report's `cuda_available` field is the record.
- **B-K8 — NOT PROVEN:** internet is OFF in the session (both fetches
  failed with DNS `Temporary failure in name resolution`). Re-test
  after phone verification. The offline-staging procedure stands
  regardless.
- **B-K5 — DATASET FOUND (no upload needed if the owner accepts a
  third-party mirror):** `barbieverse/wan2-2-5b-weights` — flat
  layout, all 8 manifest files with exact sizes (3 diffusion shards,
  T5 11.4 GB, VAE 2.82 GB, configs); only the `google/` tokenizer dir
  is missing. Provenance caveat: third-party mirror, sizes match the
  official listing exactly but hashes are unverified. Mount-path note:
  the generator's `ckptDir` assumes
  `/kaggle/input/wan22-ti2v-5b/Wan2.2-TI2V-5B`; with barbieverse the
  mount is `/kaggle/input/wan2-2-5b-weights/` (flat) — a generator
  adjustment is needed at proof time. ComfyUI alternative:
  `muchunan/wan22-ti2v-fp16-models` (complete set, FP16 T5, 21.0 GB —
  dataset mount, not working storage).
- **B-3 — notebook validation:** the smoke run surfaced an nbformat
  warning ("Cell is missing an id field") — FIXED: both builders now
  assign `cell-N` ids. `scripts/validate-notebook.py` added (JSON +
  py_compile check for every code cell). Full suite still 171/171.
- **Confirmed in-session facts:** `/kaggle/working` is 20 GB (df:
  20G total, 20G avail); Python 3.13.18; CPU image ships torch
  2.11.0+cpu.

### Smoke kernel v2 (24 Nov 2026, evening) — PUSHED, STILL QUEUED

- **B-K2 — ANSWERED:** the owner completed phone verification himself
  (Settings shows "Phone verification: Verified"). Identity
  verification (Persona) is still unverified — that gates TPUs only,
  not GPUs; ignore it for the GPU proof.
- **Metadata verified before push:** `kernel-metadata.json` already had
  `enable_gpu: true` AND `enable_internet: true` — both explicit, no
  generator fix needed. (The browser check's "Internet off" note was
  about the editor's draft session, not the pushed metadata.)
- **v2 pushed 16:55 UTC** (`kaggle kernels push -p
  packages/smoke-20261124-01 --accelerator NvidiaTeslaT4 -t 600`) —
  CLI confirmed "Kernel version 2 successfully pushed." Same package,
  same notebook, no rebuild.
- **Outcome: QUEUED for 56 minutes, never started.** 105 status polls
  (16:55–17:51 UTC), every one `KernelWorkerStatus.QUEUED`. No error,
  no failure — Kaggle simply has not allocated a GPU worker. Contrast
  v1 (CPU): started within ~30 seconds, COMPLETE in under 3 minutes.
  GPU-hours consumed: **0.00h** (quota unchanged, 30.00h remaining,
  refresh Sat 28 Nov 2026 00:00 UTC). The kernel stays queued on
  Kaggle's side and will run when a GPU frees up; a later status check
  can pick up the output (`kaggle kernels status` /
  `kaggle kernels output`). Do NOT push a v3 — v2 is live in the
  queue; a new push would only re-queue behind it.
- **B-K6/B-K8 — STILL UNPROVEN:** no GPU run has happened yet, so
  `cuda_available`, nvidia-smi, and the internet tests are all still
  open. The v2 proof is PENDING, not failed.

### Smoke proof LANDED in the web editor (24 Nov 2026, ~19:22 WAT) — B-K6/B-K8 PROVEN

- The smoke notebook ran in the Kaggle web editor (GPU T4 x2, internet
  ON): 2x Tesla T4, CUDA 13.0, `torch.cuda.is_available()=True`,
  internet working (200 from huggingface.co), `/kaggle/working` 20G.
  The reviewer-required separate smoke proof now exists. The queued v2
  kernel run was NOT touched.

### Wan proof pushed (24 Nov 2026, 18:32 UTC) — QUEUED, polling

- **Kernel:** `oliversmithh/nova-gpu-cloud-wan-proof-20261124-01`,
  version 1, private. Package: `packages/wan-proof-20261124-01/`
  (notebook `wan-proof.ipynb`, kernel metadata, staging manifest,
  README). Builder: `scripts/build-wan-proof-package.py`.
- **Metadata:** `machine_shape: "NvidiaTeslaT4"` (reviewer's
  requirement — `enable_gpu` deprecated), `enable_gpu`/`enable_internet`
  true, `dataset_sources: ["barbieverse/wan2-2-5b-weights"]`.
- **Push:** `kaggle kernels push -p . --accelerator NvidiaTeslaT4
  -t 7200`. NOTE: the timeout is 2h, NOT the 600s used for smoke —
  the CLI help defines `-t` as the run-time limit in seconds, and 600s
  would kill the run mid-generation (install + load + 50-step
  generation is realistically 20–45 min on a T4).
- **Notebook design (all verified against the cloned Wan-Video/Wan2.2
  repo, not the plan):** first code cell is the reviewer's three-gate
  smoke check (A GPU / B internet / C storage, recorded independently)
  with FAIL-FAST on any gate failure; weights verified at the dataset
  mount (8 files, 34.18 GB); in-session clone + pip-install-only-missing
  (`flash_attn` deliberately NOT installed — SDPA fallback in
  `wan/modules/attention.py`, flash-attn 2 cannot run on T4/sm75);
  tokenizer remedy downloads `google/umt5-xxl` (~5 MB) from the
  OFFICIAL Wan-AI repo into a symlinked ckpt dir (the tokenizer loads
  from `os.path.join(ckpt_dir, 'google/umt5-xxl')`); start image
  procedurally generated in-session (PIL, seeded) — VDP-06; generate.py
  with vendor defaults (121 frames @ 24 fps, 50 steps, seed 42);
  VRAM polled every 5s; output verified (exactly one MP4, no audio
  stream asserted) + `wan-proof.report.json`.
- **VDP-04 prep test PASSED locally before pushing:** all 7 code cells
  py_compile OK; prep test PASS (fixtures mirror the dataset layout,
  `google/` absent as in the dataset); network steps exactly
  {install-code, tokenizer-remedy}; generate needs no network; both
  controls behaved (offline=true fails on exactly the two network
  steps; removing a fixture file fails with the file named). Functional
  dry-runs: the start-image cell produces a 1280x704 PNG; the gate cell
  fails fast locally (no GPU) with a per-gate failure report.
  One real bug found + fixed in the dry-run: a numpy broadcast error
  in the gradient code.
- **Status at push:** QUEUED. Polling every ~5 min; never push a second
  version to jump the queue. Quota at push: GPU 0.09h used / 29.91h
  remaining (refresh Sat 28 Nov 2026 00:00 UTC).

### Wan proof v1 — ERROR (dataset never mounted), gates ALL PASSED (24 Nov 2026, 18:32–18:42 UTC)

- **v1 ran and FAILED at the weights cell:** `FileNotFoundError:
  '/kaggle/input/wan2-2-5b-weights'` — the dataset never mounted in
  the v1 session. The stored metadata (verified via `kernels pull -m`)
  DOES list `dataset_sources: ["barbieverse/wan2-2-5b-weights"]`, so
  the push applied the metadata and Kaggle silently failed to attach
  the dataset — a known behaviour (troubleshooting sources: "push
  twice if first run still empty"). No report JSON was produced (the
  failure was a raw exception before any report write); only the log
  downloaded. GPU used by v1: 0.27h (quota 0.09h → 0.36h).
- **The gates are the real v1 result — ALL THREE PASSED on the pushed
  kernel via the CLI path:** Gate A (2x Tesla T4, CUDA 13.0, torch
  2.11.0+cu130, cuda_available=True, CUDA tensor op OK), Gate B (DNS +
  HTTPS 200 from pypi.org and huggingface.co), Gate C (20G working,
  write/read/delete OK). B-K6/B-K8 are now proven via the automated
  channel too, not just the web editor. The notebook itself started
  ~9 min after the kernel showed RUNNING (session/dataset staging).
- **v2 pushed 18:44 UTC** (same command, `-t 7200`): the weights cell
  now DISCOVERS the mount dynamically (standard path or the
  `/kaggle/input/datasets/<owner>/<slug>/` variant) and fail-fasts
  with a diagnostic failure report if no mount exists. Discovery
  dry-run: all 3 cases pass (standard / variant / not-mounted).
  Rebuilt + re-validated (7/7 cells py_compile OK).

### Wan proof v2 — ERROR (dependency conflict), gates ALL PASSED (24 Nov 2026, 18:44–18:59 UTC)

- **v2 ran and FAILED at the generate cell:** `ImportError: cannot
  import name 'resolve_revision' from 'huggingface_hub'` — installing
  `transformers<=4.51.3` (the vendor pin) alone downgraded
  `huggingface-hub` 1.33.0 → 0.36.2, which broke Kaggle's preinstalled
  `diffusers 0.42.0` (needs hub ≥1.32). `generate.py` died at
  `import wan` after 7.2 s; the model never loaded, no MP4. The pip
  conflict warnings were visible in the log but the install cell
  reported success and moved on. GPU used by v2: ~0.34h (quota 0.36h
  → 0.70h). Log + generate.log + start-image.png + tokenizer files in
  `packages/wan-proof-20261124-01/output-v2/` (the redundant Wan2.2
  repo clone and tokenizer cache were deleted to save disk).
- **What v2 PROVED:** all three gates PASSED again via the CLI path;
  the mount-discovery fix WORKED (dataset found at the variant path
  `/kaggle/input/datasets/barbieverse/wan2-2-5b-weights`, all 8 files
  verified, 34.18 GB); the tokenizer remedy WORKED (downloaded from
  the official Wan-AI repo); the start image generated. The failure
  was packaging, not GPU, mount, or model.
- **Latent deps found by reading the import graph:** `import wan`
  pulls all five task modules, so it also needs `peft`, `decord`,
  `einops`, `safetensors` (animate/speech2video) and `librosa`
  (`wan/modules/s2v/audio_encoder.py`) — none checked in v1/v2.
  `decord` installs fine on Python 3.13 (its wheel is `py3-none`).
- **v3 pushed 19:14 UTC** (same command, `-t 7200`): the four
  interacting packages pinned EXACTLY (transformers==4.51.3,
  diffusers==0.32.2, huggingface-hub==0.36.2, tokenizers==0.21.4) and
  installed in ONE pip invocation; the five extra `import wan` deps
  now presence-checked; `generate.py --help` runs in-cell after
  install as a dependency check (fails fast with a clear error if the
  set is broken). **The pin set was verified locally before pushing:**
  a venv (CPU torch 2.15.0, monkeypatched
  `torch.cuda.current_device` — t5.py calls it at class-definition
  time) ran the real `generate.py --help` against the cloned repo —
  full usage printed, exit 0. VDP-04 re-verified: 7/7 cells
  py_compile OK, staging prep tests 13/13 PASS, manifest totals
  exact (34,180,067,131 bytes), network steps exactly
  {install-code, tokenizer-remedy}. Quota at v3 push: GPU 0.70h used
  / 29.30h remaining (refresh Sat 28 Nov 2026 00:00 UTC).

### Wan proof v3 — ERROR (CUDA out of memory at step 0/50), model LOADED (24 Nov 2026, 19:14–20:27 UTC)

- **v3 ran 4,283 s and OOM'd on the FIRST DiT forward (step 0/50):**
  `torch.OutOfMemoryError: tried to allocate 1.88 GiB, 1.14 GiB free`
  — 13.04 GiB already allocated (DiT bf16 ~10.3 GB + VAE fp32 ~2.8 GB
  resident). The failing allocation is the fp32 per-token time
  projection (27,280 tokens × 6×3072 × 4 B ≈ 1.88 GiB). Peak VRAM
  sampled: 13,741 MB. GPU used by v3: 1.23h (quota 0.70h → 1.93h).
  Log + generate.log (only 3,368 bytes) + start-image.png in
  `packages/wan-proof-20261124-01/output-v3/`.
- **What v3 PROVED:** the v2 fix HELD (DEPENDENCY CHECK PASSED in-cell;
  Kaggle preinstalls peft 0.21.2, einops 0.8.2, safetensors 0.8.0,
  librosa 0.11.0; only ftfy/dashscope/decord were missing); all three
  gates PASSED a third time; the model LOADED (34 GB read, dtype
  converted) and reached the sampling loop. The 71 min before step 0
  went to loading + T5-on-CPU encoding (two encodes) — and
  generate.py's stdout was block-buffered when piped, so NOTHING was
  visible until the exit flush (only `0/50` bars survived).
- **VDP-03 CORRECTION (measured, not assumed): a single T4 does NOT
  fit the official 5B path at 121 frames.** The plan's "5B fits a T4
  (12 GB weights)" counted the DiT only; the VAE (2.8 GB fp32,
  resident from construction through the loop — no offload flag
  exists) + the fp32 time projection leave ~1.5 GB for all
  activations. Single-GPU is marginal at ANY frame count. The proof
  proceeds on the provisioned 2× T4.
- **v4 pushed 20:36 UTC** (same command, `-t 10800` = 3 h):
  `torchrun --nproc_per_node=2` + `--ulysses_size 2` (vendor sequence
  parallelism — halves per-GPU activations; 24 heads % 2 == 0) +
  `--dit_fsdp` (FSDP shards the DiT in bf16 mixed precision,
  ~5.15 GB/rank). T5 stays on CPU: T5-FSDP would collide at
  construction (11 GB shard + DiT + VAE > 16 GB), because use_sp /
  dit_fsdp force `init_on_cpu=False` (DiT moves to GPU at
  construction). Per-rank estimate ~9.9 GB vs 14.56 GB.
  `PYTHONUNBUFFERED=1` keeps generate.py's progress live;
  `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set as
  fragmentation insurance. Quota at v4 push: GPU 1.93h used / 28.07h
  remaining. Total proof spend so far: 1.84h of 30h.
- **v4 verdict: ERROR — torchrun is RAM-blocked on Kaggle, not
  VRAM-blocked (24 Nov ~21:41 WAT, parent-verified).** Pushed 20:36
  UTC, ERROR by 20:41 UTC (~5 min, 0.04 GPU-h). Rank-1 worker killed
  by SIGKILL (-9) at ~44s, peak VRAM only 363 MB — the Linux OOM
  killer, i.e. system RAM, not GPU memory. Two torchrun workers each
  load the full ~34 GB stack (T5 11 GB + DiT fp32 20 GB + VAE 2.8 GB)
  and Kaggle's ~30 GB RAM cannot hold both. No loading log lines
  appeared even with `PYTHONUNBUFFERED=1` — death came during
  T5/VAE construction, before the DiT load. All three gates PASSED a
  fourth time; weights check, dependency check and the tokenizer
  remedy all held. Output in
  `packages/wan-proof-20261124-01/output-v4/` (generate.log, kernel
  log, start-image.png). Quota after v4: 1.97h used / 28.03h
  remaining. Total proof spend: 1.88h of 30h.
- **v5 design — single-process pipeline-parallel (fully designed,
  build BLOCKED on the owner's go-ahead).** Revert torchrun/ulysses/
  dit_fsdp; one process, plain `python generate.py` (v3's RAM
  profile, proven to fit). NOVA patch 1 (`wan/textimage2video.py`,
  both branches): after `self.model.to(self.device)`, move DiT blocks
  15–29 + head to `cuda:1`. NOVA patch 2 (`wan/modules/model.py`
  forward): device-detecting transfer in the block loop — when the
  next block sits on a different device than `x`, move `x`, `e`,
  `context`, `freqs` to it; head uses `kwargs['e']`; return moves to
  the input device. Device audit complete (grid_sizes/seq_lens are
  CPU tensors the stock code already handles; rope_apply and
  unpatchify use `.tolist()`; flash_attention moves `k_lens` to
  `q.device`). Margins: cuda:0 ~11.5 GB, cuda:1 ~8.8 GB vs 14.56 GB
  each. Alternatives rejected: VAE-offload-only (refined peak
  ~13.7 GB vs 14.56 GB — margin ~0.45 GB, too thin); `e0`→bf16
  (fights deliberate vendor fp32 adaLN); 81 frames (spec deviation);
  any torchrun variant (all RAM-blocked). The build is BLOCKED
  because an execution-risk notice was attached to the builder
  script (`scripts/build-wan-proof-package.py`) — the owner must
  give his plain go-ahead to edit and run it before v5 is built or
  pushed.

## 8. What Stage 2 did NOT do (deliberately)

- No accounts, sign-ups, API keys, or credentials of any kind.
- No live GPU run, no commit/push/deploy, ₦0 spent.
- No media bytes anywhere (O-27).
- No change to the Stage 1 contracts (job lifecycle, queue ordering,
  reservation-before-dispatch, ceiling default 0, kill-switch
  semantics). `gpu-manager.js`, `job.js`, `queue.js`,
  `reservations.js`, `kill-switch.js`, `reconcile.js`, `store.js`,
  `mock-provider.js` are untouched. `providers.js` changed only in
  two description strings (the Kaggle internet correction + the Colab
  no-API note — text, not behaviour).
- No connection to the A2 gateway (Stage 4).
- No headless-Selenium Colab driving, no fake API, no invented
  mechanism. Where a free tier offers no automation, the design says so
  and names the human step.
