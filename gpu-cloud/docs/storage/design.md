# NOVA Cloud Storage — design

**Status: engine built + tested (24 Nov 2026); CONNECTED to the GPU Cloud
system + proven end to end with a real file (24 Nov 2026 ~19:14–19:18
WAT).** Local filesystem backend only. Live store at
`gpu-cloud/data/store/`. No accounts, no third-party storage service, no
network calls, no commit/push/deploy. Cost: ₦0. Tests: 53/53 storage
tests pass; the full gpu-cloud suite is 182/182 (incl. 11 storage-wiring
tests); the Stage 1 GPU Manager suite still passes 60/60. Evidence:
`docs/storage/live-connection-evidence-2026-11-24.md`.

**Owner direction (24 Nov 2026):**
- ~16:39 WAT — "we should build Gpu cloud storage", not a GPU Manager alone.
- ~16:43 WAT — "we need to build our own since the ones that are available
  are not really okay" + "put more priority on the cloud storage."
  Storage is the priority track, ahead of the GPU connection work.
- ~16:44 WAT — scope is ALL OF NOVA: this store is NOVA AI Studio's
  storage FOUNDATION. Everything that works on NOVA rests on it — videos,
  images, text, and all data from everything users do on the platform.
- ~16:46 WAT — the retention rule: every 24 hours the manager
  automatically deletes generated content to keep space. A user has 24
  HOURS from generation to download what was generated; after 24 hours it
  is deleted automatically.

## 1. Why build our own

The free tiers that were available were verified against each provider's
own official pages on 24 Nov 2026 (full record:
`~/workspace/nova-ai-studio/platform-alternatives-verification-2026-11-24.md`).
Every one of them has a catch that makes it a poor foundation:

- **Supabase Free** — free projects **pause after 7 days of low activity**
  and answer **HTTP 540** until a human clicks Resume in the dashboard
  (official docs: supabase.com/docs/guides/platform/free-project-pausing;
  KB: supabase.com/kb/troubleshooting/http-status-codes). A quiet week
  takes the whole project offline — database, Auth and Storage together.
  Free storage is 1 GB per project.
- **Turso Free** — free databases are **archived after 10 days of
  inactivity** (official CLI docs: docs.turso.tech/cli/group/unarchive;
  the pricing page never states this). Exceeding ANY single free metric
  BLOCKS the databases until upgrade. And Turso announced 2 Oct 2026 it
  is joining Supabase — it is no longer an independent fallback from
  Supabase at all.
- **hCaptcha Basic (Free)** — 10,000 requests/month covers roughly ONE day
  of NOVA's 10,000-valid-requests/day design load, and the Terms (§7) say
  overage "may elect to terminate your service". A volume mismatch, not a
  feature gap.
- **Cloudflare R2 Free** (from the earlier storage brief,
  `docs/gpu-cloud-storage-design.md`, verified against
  developers.cloudflare.com/r2/pricing/ 24 Nov 2026) — 10 GB-month
  storage, 1M Class A + 10M Class B ops, egress free. Real, but using it
  needs an R2 permission added to the NOVA PAGES DEPLOY token, and Shina
  decided 24 Nov 15:55 WAT to "leave the token as is". A single Wan 2.2
  5B weights file (~10 GB) would also eat the whole free allowance alone.

The pattern across all of them: the free allowance is not the binding
constraint — the inactivity clock, the terms change, or the permission
gate is. Our own store has none of those: no vendor's pause policy, no
account to keep warm, no token permission to negotiate. The engine is
provider-independent by design (see §3), so a future backend — R2, a
free-tier object service, our own hardware — is an adapter, never a
rewrite.

Note on the earlier brief: `docs/gpu-cloud-storage-design.md` (prepared
~16:45 WAT, before this build) recommended storing only staging bundles
in our own bucket and keeping model weights as Hugging Face pointers.
This build implements the engine + namespaces the owner directed,
including a `models` namespace. The two are compatible: the engine stores
whatever it is given, and the models namespace exists for the VDP-04
staging set — but the local backend's measured headroom today (see §6)
cannot hold a 10 GB weights file, so weights stay Hugging Face pointers
until a backend big enough exists. That is an operational decision the
bigger backend unlocks, not an engine limitation.

## 2. What it is

An object store for the GPU Cloud and for NOVA:

- **Content-addressed** — an object's id is the SHA-256 hash of its
  bytes. Same bytes in the same namespace = the same object, stored once.
- **Chunked** — objects stream in 4 MiB chunks (configurable). A 10 GB
  object never sits in memory whole, on write or on read.
- **Integrity-verified** — every chunk is hashed on write and re-checked
  on read. Corruption is detected and reported, never silently served.
- **Retention-aware** — every object carries a retention policy and an
  expiry time (or none). The sweep deletes expired objects for real.
- **Quota-accounted, uncapped** — usage is measured per namespace, but
  the engine enforces NO artificial per-object or per-namespace limit.
  The only limit is physical capacity.
- **Delivery by reference** — a user redeems a short-lived opaque
  reference to download an object. The GPU Manager stores that reference
  as a job's `resultRef`, never media bytes.

## 3. Architecture

```
                ┌─────────────────────────────────┐
                │  NovaStorage (src/storage/      │
                │  engine.js)                     │
                │  put / get / head / delete /    │
                │  sweep / usage / capacity /     │
                │  delivery refs / sweep timer    │
                └──────┬──────────────┬───────────┘
                       │              │
        ┌──────────────┘              └──────────────┐
        │ metadata index              │ backend      │
        │ (metadata-index.js)         │ interface    │
        │ one JSON doc, atomic        │ (backend-    │
        │ writes: object records,     │ interface.js)│
        │ delivery references         │              │
        └──────────────┐              └──────┬───────┘
                       │                     │
                       │              ┌──────┴───────┐
                       │              │ LocalBackend │
                       │              │ (local-      │
                       │              │ backend.js)  │
                       │              │ filesystem   │
                       │              └──────────────┘
```

- **Engine** (`engine.js`) — the store. Owns the put/get/delete/sweep
  logic, retention resolution, dedup, delivery references and the sweep
  timer. Never touches a disk directly.
- **Backend interface** (`backend-interface.js`) — the contract every
  backend implements: chunk put/get/exists/list/delete, capacity, and
  the staging calls (write/finalise/discard/list-stale). The engine
  validates a backend on construction and fails fast on a
  half-implemented one.
- **Local backend** (`local-backend.js`) — the first backend. Chunk files
  under `<root>/chunks/<namespace>/<objectId>/<index>.chunk`; uploads in
  progress under `<root>/.staging/<uploadId>/`. Chunk writes are atomic
  (temp file + fsync + rename); finalise is a rename, so it needs no
  additional space.
- **Metadata index** (`metadata-index.js`) — one JSON document
  (`<root>/index.json`), atomic writes, same pattern as the GPU
  Manager's JsonStore. Holds object records (id, hash, size, chunk
  count, per-chunk hashes, content type, job id, created/expiry times,
  retention) and delivery references. Metadata only — never media bytes.
- **Namespaces** (`namespaces.js`) — six, see §4.
- **Retention** (`retention.js`) — the two policies + the 24h rule, see §5.
- **Hashing** (`hashing.js`) — SHA-256, hex; incremental hasher for
  streaming.

### Put flow (why staging exists)

The object id is the content hash, known only after the last byte is
read — so chunks land in a staging area first, then finalise by rename:

1. Source (Buffer, file path, or stream) is read in chunks; each chunk
   is hashed and written to staging; the content hash accumulates.
2. On completion: if the same bytes already exist live in the namespace,
   staging is discarded and the existing record returned (dedup). If an
   expired record with the same hash exists, it is deleted and the put
   proceeds fresh.
3. Capacity check (known-size sources are also checked BEFORE staging).
4. Staging finalises into place; the index record is written.
5. Any failure (disk full, quota exceeded) discards staging and writes
   no index record — a failed put leaves no partial object.

### Get flow

Resolve the record (an expired object is lazily deleted and reported
missing — the 24h rule holds even between sweeps), then stream chunks
one at a time, each hash-verified against the record before it is
yielded. `getBuffer()` is a small-objects-only convenience.

## 4. Namespaces

| Namespace | Holds | Default retention |
|---|---|---|
| `models` | Weights, configs, tokenizers, VAE/text-encoder files, system files (the VDP-04 staging set) | PERSISTENT |
| `jobs` | Job inputs (prompts, start images), working files, job records | PERSISTENT (per-object transient override for throwaway working files) |
| `outputs` | Generated images/videos in transit to delivery (where a GPU worker lands a fresh generation) | TRANSIENT, 24h TTL |
| `media` | Generated videos + images (the generated-content home) | TRANSIENT, 24h TTL |
| `text` | Generated text by default; prompts/scripts via persistent override | TRANSIENT, 24h TTL |
| `projects` | User project data, project metadata, activity records | PERSISTENT |

`outputs` vs `media` is a lifecycle stage, not a retention difference:
both hold generated content and both expire 24h after creation.
`outputs` is the landing stage; `media` is the generated-content home.

Objects are addressed (namespace, objectId). The same bytes in two
namespaces are two objects, because their retention differs.

## 5. Retention — the 24-hour rule

### The rule (owner direction, 24 Nov 2026 ~16:46 WAT)

Every 24 hours the manager automatically deletes generated content to
keep space. A user has 24 HOURS from generation to download what was
generated; after 24 hours it is deleted automatically.

Implemented as: every generated video, generated image and generated
text output expires 24 hours after creation (`GENERATED_CONTENT_TTL_MS`
in `retention.js`). The expiry sweep deletes it — chunks, index record
and delivery references, all of them. The sweep runs on a timer (default
every hour — well inside the 24h rule, so an expired object is reclaimed
promptly); more frequent sweeps are safe because nothing is deleted
before its expiry time. Between sweeps, lazy expiry on read enforces the
rule: a read of an expired object fails and removes it.

A delivery reference for a deleted object stops working: deletion
removes the object's references, and redemption re-checks the object.

### What the 24h rule does NOT cover

- **Model weights, configs, tokenizers, VAE/text-encoder files and other
  system files PERSIST.** They are not generated content, and re-fetching
  10–28 GB of weights every day is infeasible (Kaggle GPU sessions have
  no internet). Deleting them on a 24h clock would break the system.
- **Job records, project metadata, prompts and other small records
  PERSIST.** They are tiny (space is consumed by media, not records) and
  the manager needs them for reconciliation and audit.
- **Only GENERATED OUTPUTS (media + generated text) carry the 24h TTL.**

This split is the owner's rule as stated; if it is wrong in any part,
he corrects it and the namespace defaults change in one place
(`namespaces.js`).

### The policy switch (still configurable)

Retention stays a configurable policy module with two named policies —
`transient` (expires ttlMs after creation) and `persistent` (no expiry).
Namespace defaults are the table in §4; any put can override per object
(a prompt stored in `text` passes `retention: 'persistent'`; a
throwaway working file in `jobs` passes a short transient TTL).

### Direction history (auditable, not silent)

- **A2 O-27** (owner, 24 Nov ~12:23 WAT): deliver, no server copy kept,
  for uploaded images, generated images, generated videos, audio and
  exported films. **That record stands for the A2 scope.**
- **Storage direction** (owner, 24 Nov ~16:44 WAT): everything rests on
  this store, so NOVA content is KEPT on it by default. This supersedes
  the O-27 "deliver with no copy kept" rule **for content on this store**
  — it is the storage programme's own decision, recorded here, not a
  change to the A2 record.
- **Storage direction refined** (owner, 24 Nov ~16:46 WAT): generated
  outputs get a 24h TTL with automatic deletion; models, system files
  and small records persist. This document implements the refined rule.

## 6. Capacity — measured, not assumed

The engine enforces no artificial caps, so the honest question is what
the backend underneath can actually hold. Measured on this VM, 24 Nov
2026 ~16:47 WAT:

| Measurement | Figure |
|---|---|
| `df` / statfs device free | ~44–47 GB (150 GB device, 71% used) |
| **Write probe (5 GB urandom `dd` into home)** | **FAILED at 4,850,884,608 bytes — "Disk quota exceeded"** |
| **Real usable headroom at probe time** | **~4.85 GB** |

The home directory is quota-managed (btrfs qgroup; the `btrfs` CLI is
not installed on this VM, so the quota ceiling itself is not directly
readable). `df` reports the whole device and lies about what this
process may write — exactly the standing lesson in AGENTS.md. The probe
used incompressible random bytes (the mount forces zstd compression, but
random bytes and already-compressed media/weights do not compress), so
the 4.85 GB figure is honest for media- and weights-like data. The probe
file was deleted immediately after the measurement. Headroom moves as
other work writes to home, so 4.85 GB is the figure at probe time, not a
guarantee.

**Stated plainly: the local backend is a few-GB store today.** A single
Wan 2.2 5B weights file (~10 GB) does NOT fit in it. The engine is ready
for tens of GB — the backend underneath is not. "Abundant" requires one
of: a second backend (a free-tier object service, or R2 with the token
permission the owner has so far declined to change), our own hardware,
or quota relief on this VM. **Unlimited storage is never promised.**

The engine handles the small headroom honestly: `capacity()` reports the
backend's numbers plus what the store holds; a put that cannot fit fails
whole with `CapacityError` and leaves no partial object; and the
capacity probe is treated as an estimate — the write itself is the real
test, and ENOSPC/EDQUOT at write time becomes a clean `CapacityError`.

## 7. What it is NOT

- **Not a CDN.** No edge caching, no geographic distribution, no
  signed-URL delivery network. Delivery references are redeemed
  server-side; the bytes come from this store.
- **Not a database.** The metadata index is bookkeeping for objects, not
  a query engine. No secondary indexes, no transactions across objects,
  no SQL.
- **Not a backup service.** The local backend is one machine with no
  replication. A disk failure loses what only lives here. Anything that
  must survive a disk failure needs a second backend or a copy elsewhere.

## 8. Honest limits

1. **Single machine, no replication** (local backend). See §7.
2. **Small measured headroom** — ~4.85 GB at probe time (§6). Weights do
   not fit today.
3. **Single-process index.** The engine is the only writer, same as the
   GPU Manager's store. Stage 4 (the NOVA API connection) must decide
   the multi-process story before this index is ever shared.
4. **Orphan chunks on a crash** between finalise and the index write.
   They are unreachable and never served, but they waste space until an
   orphan reaper exists (future work).
5. **The sweep needs a live process.** The sweep timer runs inside a
   host process; if no process runs, no sweep runs. Lazy expiry on read
   still enforces the 24h rule for downloads, but disk space is only
   freed when a sweep actually runs. The production host for the timer
   is an open decision (§9).
6. **Capacity reporting is an estimate on quota filesystems.** statfs
   reports device free space, not quota headroom (§6). The engine
   handles the gap at write time, but `capacity()` cannot report a
   number the OS does not expose.
7. **Dedup is per-namespace, not per-chunk.** The same bytes in two
   namespaces are stored twice (retention differs); two objects sharing
   a chunk store that chunk twice. Chunk-level dedup is a future
   optimisation, not implemented.
8. **No encryption at rest, no access control in the engine.** The store
   trusts its caller. Authentication/authorisation belong to the layer
   above (Stage 4 / the A2 boundary), not to the object store.

## 9. What a second backend or own hardware changes

- **Capacity** — the binding constraint today (§6). A bigger backend
  lets the `models` namespace hold real weights instead of pointers.
- **Durability** — replication (a second copy) is what turns this from a
  proof store into a durable home for NOVA's content.
- **Reach** — a backend the GPU workers can reach directly changes the
  staging story (today, Kaggle sessions have no internet, so the
  VDP-04 offline-staging procedure prepares everything beforehand).
- **Nothing in the engine changes.** A new backend implements the
  interface in `backend-interface.js`; the engine, index, retention and
  delivery flow are untouched.

## 10. Open decisions

1. **Uploaded input images** (start images in `jobs`) currently PERSIST
   with the job record — the 24h rule covers GENERATED outputs only.
   The owner can extend the 24h rule to inputs if wanted.
2. **Weights' physical home** — Hugging Face pointers until a backend big
   enough exists (§1, §6).
3. **Sweep host** — which process runs the sweep timer in production (§8.5).
   DECIDED FOR THIS WIRING (24 Nov 2026 ~19:14 WAT): the manager hosts
   it (`startStorageSweep` / `stopStorageSweep`; live runner at
   `scripts/run-gpu-cloud.mjs`) — see §12. The PRODUCTION host (Stage 4
   API process, cron-triggered sweep, or a dedicated daemon) is still an
   open owner decision.
4. **Orphan reaper** — future work (§8.4).
5. **Second backend choice** — R2 (needs the token-permission decision),
   another free-tier object service, or own hardware (§9).

## 11. Running the tests

```sh
node --test test/storage/*.test.mjs   # 53 storage tests (24 Nov 2026)
node --test test/job-lifecycle.test.mjs test/idempotency.test.mjs \
  test/queue.test.mjs test/reservations.test.mjs test/ceiling.test.mjs \
  test/kill-switch.test.mjs test/timeouts.test.mjs test/reconcile.test.mjs \
  test/store.test.mjs                 # Stage 1 suite: 60/60
```

NOTE: `package.json`'s `test` / `test:all` scripts DO include
`test/storage/` (wired in 24 Nov 2026) and `test/storage-wiring.test.mjs`
(the manager ↔ store wiring suite). Test data is synthetic generated
bytes only; temp roots live under `test/storage/.tmp/` and are removed
after each test.

## 12. Live connection (24 Nov 2026 ~19:14 WAT)

The owner ordered "Connect it and test it" (~19:10 WAT). The engine is
now wired into the GPU Cloud system — it is no longer a standalone
library with nothing stored in it.

- **Live home:** `gpu-cloud/data/store/`, beside the manager's job
  records (`data/gpu-manager.json`). Covered by `gpu-cloud/.gitignore`
  — media bytes are never committed.
- **Wiring:** `createGpuCloud()` creates a `NovaStorage` at that root
  (or accepts a pre-constructed one) and attaches it to the manager.
  The manager shares its clock with the store. Manager operations:
  `storeJobOutput` / `getJobOutput` / `getJobOutputBuffer` /
  `headJobOutput` / `issueJobDeliveryRef` (stored as the job's
  `resultRef`) / `deleteJobOutput` / `storageUsage` /
  `storageCapacity` / `runStorageSweep`. Job records hold references
  only — never media bytes (O-27). `job.js` was NOT modified:
  `outputRef` is set dynamically on the job record, so the Stage 1
  job-lifecycle contract is untouched.
- **Sweep host — this wiring's choice: the manager.**
  `startStorageSweep(intervalMs)` / `stopStorageSweep()` on the
  manager; the timer is unref'd and never holds a process open on its
  own. `createGpuCloud()` does NOT start it by itself — opt in with
  `createGpuCloud({ startSweepTimer: true })`, or run the live runner
  `scripts/run-gpu-cloud.mjs` (boots the cloud, runs an initial sweep,
  starts the timer, stays alive until SIGINT/SIGTERM). The manager is
  the right host for this wiring because it is the long-lived process
  that already owns the store — but it is a mechanism, not a
  deployment: **the production host (Stage 4 API process,
  cron-triggered sweep, or a dedicated daemon) stays an open owner
  decision.** Until a host runs, expiry is enforced lazily on read
  (a download of an expired object fails and removes it), but disk
  space is only freed when a sweep actually runs.
- **Live proof:** the in-house proof clip (1,843,924 bytes, our own
  synthetic output) was stored under `outputs` via the manager,
  retrieved byte-identical with a matching SHA-256, delivered by
  reference, and accounted in usage. Expiry was proven with short-TTL
  objects (manual sweep + timer sweep, no 24h wait). The clip stays in
  the live store until its 24h expiry (2026-11-25T18:14:00.963Z).
  Full evidence: `docs/storage/live-connection-evidence-2026-11-24.md`.
  Re-run: `node scripts/storage-live-test.mjs` (idempotent — same
  jobs, dedup on the clip).
- **Not done:** the live-site NOVA API link is Stage 4 — nothing on
  the live NOVA site reads or writes this store yet.
