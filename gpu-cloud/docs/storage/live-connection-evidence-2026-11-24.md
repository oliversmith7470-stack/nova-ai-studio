# NOVA Cloud Storage — live connection evidence

**Date:** 24 November 2026, ~19:14–19:18 WAT
**Order:** the owner, ~19:10 WAT — "Connect it and test it."
**Scope:** connect the built storage engine into the GPU Cloud system
and prove it end to end with a real file. Local code + tests only. No
NOVA production touch, no live-site changes, no deploy, no commit/push.
Cost: ₦0.

## What is connected

- **Live store home:** `gpu-cloud/data/store/` — beside the manager's
  job records (`data/gpu-manager.json`). Covered by the new
  `gpu-cloud/.gitignore` (media bytes are never committed).
- **Wiring:** `createGpuCloud()` now creates a `NovaStorage` (local
  filesystem backend) at that root and attaches it to the manager
  (`manager.attachStorage()`). The manager shares its clock with the
  store, so job timeouts and object expiry agree. The cloud object
  exposes `storage` and `storageRootDir`.
- **Manager operations:** `storeJobOutput(jobId, …)` (default namespace
  `outputs`), `getJobOutput(jobId)` (verified stream),
  `getJobOutputBuffer(jobId)`, `headJobOutput(jobId)`,
  `issueJobDeliveryRef(jobId)` (stored as the job's `resultRef`),
  `deleteJobOutput(jobId)`, `storageUsage()`, `storageCapacity()`,
  `runStorageSweep()`, `startStorageSweep()` / `stopStorageSweep()`.
  Job records hold references only — never media bytes (O-27).
- **Sweep host (this wiring): the manager.** The timer starts and stops
  with the manager (`startStorageSweep` / `stopStorageSweep`); it is
  unref'd and never holds a process open on its own. `createGpuCloud()`
  does NOT start it by itself — opt in with
  `createGpuCloud({ startSweepTimer: true })`, or run the live runner
  (`scripts/run-gpu-cloud.mjs`), which boots the cloud, runs an initial
  sweep, starts the timer and stays alive until stopped. **The
  production host (Stage 4 API process, cron-triggered sweep, or a
  dedicated daemon) is still an open owner decision** — this is the
  mechanism, not the deployment. See `docs/storage/design.md` §12.

## End-to-end evidence — the real file

Source: `proof-clip-2026-11-24/dragon-ridge-proof-8s.mp4` — our own
synthetic output (VDP-06 clean). The script copied it to scratch and
stored from the copy; the original was never moved or written to, and
the scratch copy was removed afterwards. The original's hash was
re-verified after the run: unchanged.

| Check | Result |
|---|---|
| Original size | 1,843,924 bytes |
| Original SHA-256 | `25569019ad11a997f1c88cac85b0cf88180d654d4d40cf79959059105e72e350` |
| Stored object id | `25569019…e72e350` — identical (content addressing: the id IS the hash) |
| Stored size | 1,843,924 bytes — identical |
| Chunks | 1 (1.8 MB < 4 MiB chunk size) |
| Namespace / retention | `outputs` / transient, 24h TTL |
| Stored at / expires | 2026-11-24T18:14:00.963Z / **2026-11-25T18:14:00.963Z** |
| Retrieved bytes | byte-identical to the original (Buffer.compare == 0) |
| Retrieved checksum | SHA-256 match |
| Delivery reference | issued via the manager, stored as the job's `resultRef` (`nova://delivery/…`); redeemed — resolves to the stored clip |
| Usage accounting | `outputs`: 1 object, 1,843,924 bytes; total 1 object |
| Job | `job_7cf9efb8-8d16-47a8-8b2e-761b6cae8577` (idempotency key `live-storage-test-20261124`, status `queued` — never dispatched, no GPU work) |

On-disk verification (independent of the script's own reporting):
- Chunk file `data/store/chunks/outputs/25569019…/0.chunk` hashes to
  `25569019…e72e350` — identical to the original.
- `data/store/index.json` holds exactly 1 object + 1 live delivery ref.
- `data/gpu-manager.json` holds 3 test jobs, references only, ceiling
  0, kill-switch off.

## Expiry proof (no 24h wait — per-object TTL override)

- Short-TTL object (`ttlMs: 3000`, 24 bytes): present before expiry,
  with a live delivery ref. After 4s, `manager.runStorageSweep()`
  deleted it (report: deleted 1, freed 24 bytes); `headJobOutput`
  returns null; the job's `outputRef` was cleared; its delivery ref
  fails with `DeliveryRefError`.
- Timer proof: a second short-TTL object (`ttlMs: 2000`) with the sweep
  timer running at a 1s interval disappeared with NO manual sweep; the
  timer was then stopped cleanly.
- The proof clip itself was NOT deleted — it expires on its own 24h
  clock, 2026-11-25T18:14:00.963Z.

## Live runner check

`scripts/run-gpu-cloud.mjs --sweep-interval-ms 2000` boots, runs an
initial sweep (checked 1, deleted 0), starts the timer, stays alive,
and stops gracefully on SIGTERM ("Stopping — sweep timer off."). One
bug found + fixed during this check: the first version exited at once
because a pending promise is not an event-loop handle and the sweep
timer is unref'd — the runner now holds itself open with a ref'd
keep-alive interval cleared on stop.

## Tests

- New: `test/storage-wiring.test.mjs` — **11/11 pass** (wiring,
  round-trip, file-path source, delivery refs, retention defaults,
  sweep expiry, lazy expiry, timer, shared clock, no-storage guard,
  error paths).
- Full suite: **182/182 pass** (`npm run test:all` — was 171; +11 new).
  Stage 1 contracts untouched (`job.js` not modified — `outputRef` is
  set dynamically on the job record; no existing test changed).
- Test support: `test/stage2-support.mjs` `makeCloud()` now passes a
  temp `storageRootDir` — tests never write to the live store
  (verified: `data/` stayed empty through the full suite run, before
  the live test created the live files).

## Files changed / added

- Changed: `src/gpu-manager.js` (storage methods, additive only),
  `src/setup.js` (storage wiring + `DEFAULT_STORAGE_ROOT_DIR`),
  `src/index.js` (storage re-exports), `test/stage2-support.mjs`
  (temp store root), `package.json` (`test:all` includes the new
  suite), `README.md`, `docs/storage/design.md` (§12).
- Added: `test/storage-wiring.test.mjs`,
  `scripts/storage-live-test.mjs`, `scripts/run-gpu-cloud.mjs`,
  `gpu-cloud/.gitignore`, this file.
- Live state created (not source): `data/gpu-manager.json` (3 test
  jobs), `data/store/` (1 object + index).

## What is NOT done

- **The live-site NOVA API link is Stage 4 and stays out of this task.**
  Nothing on the live NOVA site reads or writes this store yet; the
  store is connected to the GPU Cloud system only.
- **No runner is currently running.** The sweep timer needs a live
  process; until the owner decides the production host (or the runner
  is launched from the main session), expiry between sweeps is enforced
  lazily on read — a download of an expired object fails and removes
  it — but disk space is only freed when a sweep actually runs.
- **Smoke v2 (Kaggle) untouched** — still QUEUED; this task never
  touched the Kaggle queue. Smoke v1 evidence untouched (verified).
- No credentials or private user media were stored (VDP-06). The only
  object in the live store is our own synthetic proof clip.
