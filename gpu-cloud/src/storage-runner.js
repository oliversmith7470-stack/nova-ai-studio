// storage-runner.js — the NOVA storage runner (Rev 4.8 §14, Rev 4.9 §6).
//
// The SINGLE production implementation used by both the hourly runner
// service and the startup catch-up recovery unit. It is the SOLE deleter
// of expired objects: the API process never physically deletes objects.
//
// Modes:
//   --catch-up   One bounded startup pass (recovery unit): delete every
//                object past expiry, rebuild the store index, reconcile
//                the job ledger, write the readiness record and the runner
//                heartbeat. Exits 0 on success, non-zero on ANY incomplete
//                deletion/index/ledger/readiness/heartbeat operation. The
//                recovery unit has a ten-minute timeout; if the pass does
//                not complete, the API must not listen.
//   (no flag)    Hourly daemon mode (runner unit): one pass immediately,
//                then one pass every hour, supervised (Restart=always). A
//                failed pass is logged and recorded as a failed heartbeat;
//                the daemon stays up for the next hourly pass. Exits
//                non-zero only on a fatal startup error.
//
// Both modes operate on the exact storage root configured for the API
// (NOVA_API_DATA_DIR/store — /var/lib/nova-api/store in the shipped
// service configuration), use the same storage/index implementation as
// the API (NovaStorage/MetadataIndex), and take the shared
// /var/lib/nova-api/sweep.lock before any physical deletion. A pass is
// serialised (one holder at a time) and idempotent (delete-by-object-id,
// existence checked first).
//
// A pass:
//   0. index preflight + manifest rebuild (Finding 10B): when index.json
//      is missing and chunk directories survive, the index is rebuilt
//      from the per-object manifests BEFORE any deletion can happen. An
//      object whose manifest is missing or invalid is left on disk,
//      logged, and reported — never deleted. When nothing at all can be
//      restored the pass THROWS (fail closed) instead of deleting every
//      surviving chunk dir as an "orphan". A present-but-unparseable
//      index also throws. `indexRebuilt` is true ONLY when this manifest
//      reconstruction actually restored at least one object; a normal
//      validation pass reports false.
//   1. deletes every object past its absolute expiry (idempotent
//      delete-by-id), records each deletion in deletion-log.jsonl;
//   2. validates the index against the objects that remain (an index
//      record whose chunks are gone is dropped; orphan chunk dirs with no
//      index record are deleted and logged — safe now, because step 0
//      ran first when the index was missing);
//   3. (--catch-up only) reconciles the job ledger against the store: a
//      job whose MP4 is gone is marked `expired`; a store object that
//      claims a ledger row (non-null jobId) with no matching job is
//      deleted and logged. The hourly pass does NOT touch the ledger: the
//      API process owns gpu-manager.json while it runs, and a direct file
//      edit from this process would be overwritten by the API's next
//      save (see KNOWN LIMITS below);
//   4. atomically writes runner-health.json after every pass, with
//      lastSuccessfulSweepAt, lastAttemptAt, status, objectsDeleted, and
//      error. A failed pass records status "failed" and an error WITHOUT
//      advancing lastSuccessfulSweepAt.
//
// The API treats a missing, unreadable, failed, or older-than-two-hours
// heartbeat as unhealthy and refuses new submissions with 503
// capacity_unavailable / storage-full; in-flight work is not cancelled.
// The standing health-check probe reads the heartbeat every 5 minutes and
// alerts on an outage (storage-runner-heartbeat-outage).
//
// §15 fault-injection markers (Rev 4.9): the installed-unit tests drive
// fault modes with marker files in the state dir. Markers are honoured
// ONLY in --catch-up mode (the recovery path the tests exercise); the
// hourly daemon ignores them entirely, so a daemon pass can never consume
// or mask a recovery fault:
//   runner-fault-fail          -> write status:"failed" + log
//                                startup-recovery-failed, exit 1
//   runner-fault-fail-once     -> fail once (marker consumed), then succeed
//   runner-fault-slow          -> sleep ~590 s, then run the real pass
//   runner-fault-slow-timeout  -> sleep 610 s (exceeds the unit TimeoutSec
//                                600 -> systemd kills it)
//   runner-fault-slow-once     -> slow once (marker consumed), then succeed
//   runner-fault-slow-short    -> sleep 10 s, then run the real pass
//                                (marker NOT consumed)
//   runner-fault-stale-readiness -> run the real pass, then write
//                                readiness.json with a WRONG
//                                startupRequestId (marker consumed, one bad
//                                pass only)
//
// KNOWN LIMITS (for the Rev 4.9 report — the §14 contract as written has
// these properties; this runner implements the contract, it does not
// redesign it):
//   - RESOLVED by Finding 10C (Rev 4.9 corrections): the API process no
//     longer holds the store index in memory across a runner pass.
//     MetadataIndex mutations run under a shared cross-process lock
//     (index.lock) and reload the file under that lock, and reads
//     reload when the file changed — a runner save can no longer
//     clobber an API put. The single remaining multi-process file is
//     the job ledger (below).
//   - Ledger reconciliation runs in --catch-up mode only (see step 3).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStorage, readObjectManifest, validateManifestRecord } from './storage/index.js';
import { flockExNb, flockUn } from './api-server/flock-binding.mjs';

const DEFAULT_DATA_DIR = '/var/lib/nova-api';
const SWEEP_LOCK_TIMEOUT_MS = 60_000; // bounded wait for sweep.lock
const HOURLY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Orphan grace (Finding 10C): an orphan chunk dir younger than this is
// never deleted. A put finalises its chunks BEFORE writing the index
// record, so a chunk dir with no index record may be a put in flight,
// not a crash leftover — deleting it would destroy an object the API
// just accepted. The put's commit window is milliseconds; 60 s is a
// wide margin. A genuine crash orphan is deleted by the next pass once
// it ages past the grace.
const ORPHAN_GRACE_MS = 60_000;

export const RUNNER_VERSION = 'phase5-rev4.9';
export { SWEEP_LOCK_TIMEOUT_MS, HOURLY_INTERVAL_MS, ORPHAN_GRACE_MS };

function dataDirFromEnv(argv) {
  const flag = argv.indexOf('--data-dir');
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('storage-runner: --data-dir requires a path');
    }
    return value;
  }
  return process.env.NOVA_API_DATA_DIR ?? DEFAULT_DATA_DIR;
}

function readRequestId(dataDir) {
  try { return fs.readFileSync(path.join(dataDir, 'startup-request-id'), 'utf8').trim() || 'none'; }
  catch { return 'none'; }
}

function readWindowStart(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, 'startup-attempts'), 'utf8'));
    return typeof v.windowStart === 'string' ? v.windowStart : 'none';
  } catch { return 'none'; }
}

function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return 'unknown'; }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function appendDeletionLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function logLine(dataDir, event, detail, level = 'error') {
  const line = `ts=${new Date().toISOString()} level=${level} event=${event} requestId=${readRequestId(dataDir)} windowStart=${readWindowStart(dataDir)} detail=${detail}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Stream a file through SHA-256 without loading it into memory (the
// manifest rebuild hashes every restored chunk; a video object can be
// gigabytes).
async function hashFile(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// --- sweep lock ------------------------------------------------------------
// One holder at a time, via the native flock binding on sweep.lock. Bounded
// wait: a contended lock returns { acquired: false } after the timeout
// instead of blocking forever.
async function withSweepLock(dataDir, fn, lockTimeoutMs = SWEEP_LOCK_TIMEOUT_MS) {
  const lockPath = path.join(dataDir, 'sweep.lock');
  fs.mkdirSync(dataDir, { recursive: true });
  const fd = fs.openSync(lockPath, 'w');
  const deadline = Date.now() + lockTimeoutMs;
  try {
    for (;;) {
      if (flockExNb(fd)) break;
      if (Date.now() >= deadline) return { acquired: false };
      await sleep(250);
    }
    return { acquired: true, result: await fn() };
  } finally {
    try { flockUn(fd); } catch { /* already released */ }
    fs.closeSync(fd);
  }
}

// --- the pass ---------------------------------------------------------------

// List the expired index records and, for each, whether its chunks are
// still present. An expired record with no chunks is already gone
// (expired-but-missing): nothing to delete, index record dropped by the
// rebuild, counted separately.
async function expiredWithPresence(storage, now) {
  const expired = storage.index.listExpired(now);
  const out = [];
  for (const record of expired) {
    let chunks = [];
    try { chunks = await storage.backend.listChunks(record.namespace, record.objectId); }
    catch { chunks = []; }
    const complete = chunks.length === record.chunkCount
      && chunks.every((i, n) => i === n);
    out.push({ record, chunksPresent: chunks.length > 0, complete });
  }
  return out;
}

// --- index preflight + manifest rebuild (Finding 10B) ----------------------

// Scan the chunk tree for surviving chunk directories: a directory
// <chunks>/<namespace>/<objectId> holding at least one <index>.chunk
// file. Empty directories hold no data and are not surviving.
function listSurvivingChunkDirs(chunksDir) {
  const out = [];
  let namespaces = [];
  try {
    namespaces = fs.readdirSync(chunksDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const namespace of namespaces) {
    const nsDir = path.join(chunksDir, namespace);
    let ids = [];
    try { ids = fs.readdirSync(nsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    for (const objectId of ids) {
      const dir = path.join(nsDir, objectId);
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      if (entries.some((e) => /^\d+\.chunk$/.test(e))) {
        out.push({ namespace, objectId });
      }
    }
  }
  return out;
}

// Fail-closed preflight (Finding 10B): inspect index.json BEFORE any
// deletion can happen, and before the storage engine is even
// constructed. Returns { missing } — missing means the index file does
// not exist. A present-but-unparseable or wrong-shaped index THROWS:
// the pass must never delete or reconcile anything on an index it
// cannot read.
function preflightIndex(storeRoot) {
  const indexPath = path.join(storeRoot, 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    throw new Error(`storage-runner: cannot read the store index ${indexPath}: ${err.message}`);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !value.objects || typeof value.objects !== 'object' || Array.isArray(value.objects)
      || !value.deliveryRefs || typeof value.deliveryRefs !== 'object' || Array.isArray(value.deliveryRefs)) {
      throw new Error('invalid shape');
    }
  } catch (err) {
    throw new Error(`storage-runner: the store index ${indexPath} is unusable (${err.message}) — refusing to delete or reconcile anything until it is repaired`);
  }
  return { missing: false };
}
// True manifest rebuild (Finding 10B): runs only when the preflight
// found index.json missing. Scans the surviving chunk dirs and
// re-indexes every restorable object from its manifest. An object whose
// manifest is missing or invalid is left on disk, logged, and reported
// — NEVER deleted. When nothing at all can be restored it THROWS
// (fail closed): the validation step that follows would otherwise
// delete every surviving chunk dir as an "orphan". Delivery references
// are NOT restored (they live only in the index): a manifest rebuild
// restores objects, not references; a reference issued before the loss
// fails as 'unknown' afterwards — safe, fail-closed.
// Returns { rebuilt, restored, unrecoverable, preserveKeys }: rebuilt
// is true ONLY when reconstruction actually restored at least one
// object (this is what readiness.indexRebuilt reports); preserveKeys
// is the set of "namespace/objectId" keys the validation step must
// leave alone.
async function rebuildIndexFromManifests(storage, storeRoot, dataDir) {
  const chunksDir = path.join(storeRoot, 'chunks');
  const surviving = listSurvivingChunkDirs(chunksDir);
  if (surviving.length === 0) {
    return { rebuilt: false, restored: 0, unrecoverable: [], preserveKeys: new Set() };
  }
  // The index is missing and objects survive: rebuild from manifests.
  // No local chunk directory means no durable manifest source exists
  // (a non-local backend) — fail closed rather than delete.
  if (typeof storage.backend.chunksDir !== 'string') {
    throw new Error(`storage-runner: index.json is missing and ${surviving.length} chunk director(ies) survive, but this backend has no local chunk directory (no manifests) — refusing to delete orphan chunks`);
  }
  let restored = 0;
  const unrecoverable = [];
  for (const { namespace, objectId } of surviving) {
    let chunks = [];
    try { chunks = await storage.backend.listChunks(namespace, objectId); }
    catch { chunks = []; }
    const manifest = readObjectManifest(storage.backend.chunksDir, namespace, objectId);
    const check = manifest === null
      ? { ok: false, reason: 'manifest-missing' }
      : validateManifestRecord(manifest, namespace, objectId, chunks);
    if (!check.ok) {
      unrecoverable.push({ namespace, objectId, reason: check.reason });
      continue;
    }
    // The manifest's hashes must match the bytes actually on disk: a
    // manifest that lies about its chunks would restore an object the
    // engine could never serve (its reads are hash-verified). Verify
    // every chunk before trusting the record. This reads each restored
    // object's bytes once — acceptable for a disaster-recovery path
    // that runs only when the index is lost.
    let hashesOk = true;
    let hashReason = null;
    try {
      for (let i = 0; i < manifest.chunkCount; i++) {
        const digest = await hashFile(path.join(storage.backend.chunksDir, namespace, objectId, `${i}.chunk`));
        if (digest !== manifest.chunkHashes[i]) { hashesOk = false; hashReason = 'manifest-chunk-hash-mismatch'; break; }
      }
    } catch {
      hashesOk = false;
      hashReason = 'manifest-chunk-unreadable';
    }
    if (!hashesOk) {
      unrecoverable.push({ namespace, objectId, reason: hashReason });
      continue;
    }
    await storage.index.putObject(manifest);
    restored += 1;
  }
  if (restored === 0) {
    throw new Error(`storage-runner: index.json is missing and ${surviving.length} chunk director(ies) survive, but none could be restored from manifests (${unrecoverable.map((u) => `${u.namespace}/${u.objectId}:${u.reason}`).join(', ')}) — refusing to delete orphan chunks`);
  }
  const preserveKeys = new Set(unrecoverable.map((u) => `${u.namespace}/${u.objectId}`));
  for (const u of unrecoverable) {
    logLine(dataDir, 'storage-unrecoverable-object', `${u.namespace}/${u.objectId} reason=${u.reason} (preserved on disk, not indexed, not deleted)`);
  }
  return { rebuilt: true, restored, unrecoverable, preserveKeys };
}

// Validate the index against the objects that remain: drop index records
// whose chunks are gone or incomplete, delete orphan chunk dirs with no
// index record. `preserveKeys` ("namespace/objectId") exempts
// unrecoverable objects from a manifest rebuild — they stay on disk.
// Returns { droppedMissing, orphansDeleted, orphanIds }. Every physical
// deletion is logged to the deletion log. This step runs only AFTER the
// preflight (step 0), so an orphan deletion here can never destroy
// data a missing index merely forgot.
async function rebuildIndex(storage, logPath, preserveKeys = new Set()) {
  const objects = storage.index.listObjects();
  let droppedMissing = 0;
  const orphanIds = [];
  for (const record of objects) {
    let chunks = [];
    try { chunks = await storage.backend.listChunks(record.namespace, record.objectId); }
    catch { chunks = []; }
    const complete = chunks.length === record.chunkCount
      && chunks.every((i, n) => i === n);
    if (!complete) {
      await storage.backend.deleteObjectChunks(record.namespace, record.objectId);
      await storage.index.deleteObject(record.namespace, record.objectId);
      await storage.index.deleteRefsForObject(record.namespace, record.objectId);
      droppedMissing += 1;
      appendDeletionLog(logPath, {
        ts: new Date().toISOString(), event: 'object-deleted',
        namespace: record.namespace, objectId: record.objectId,
        sizeBytes: record.sizeBytes ?? null, jobId: record.jobId ?? null,
        reason: chunks.length === 0 ? 'missing' : 'damaged',
      });
    }
  }
  // Orphan chunk dirs: present on disk, no index record.
  const chunksRoot = storage.backend.chunksDir;
  let namespaces = [];
  try { namespaces = fs.readdirSync(chunksRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { namespaces = []; }
  for (const namespace of namespaces) {
    const nsDir = path.join(chunksRoot, namespace);
    let ids = [];
    try { ids = fs.readdirSync(nsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { ids = []; }
    for (const objectId of ids) {
      if (storage.index.getObject(namespace, objectId)) continue;
      if (preserveKeys.has(`${namespace}/${objectId}`)) continue;
      // Orphan grace (Finding 10C): a freshly-created chunk dir may be
      // a put in flight (chunks finalised, index record not yet
      // written). Never delete it — the next pass cleans it up once it
      // ages past the grace, if it is still orphaned then.
      let dirAgeMs = Number.POSITIVE_INFINITY;
      try { dirAgeMs = Date.now() - fs.statSync(path.join(nsDir, objectId)).mtimeMs; } catch { /* gone */ }
      if (dirAgeMs < ORPHAN_GRACE_MS) continue;
      await storage.backend.deleteObjectChunks(namespace, objectId);
      orphanIds.push(`${namespace}/${objectId}`);
      appendDeletionLog(logPath, {
        ts: new Date().toISOString(), event: 'object-deleted',
        namespace, objectId, sizeBytes: null, jobId: null, reason: 'orphan',
      });
    }
    // Remove the namespace dir when it is left empty (best effort).
    try { if (fs.readdirSync(nsDir).length === 0) fs.rmdirSync(nsDir); } catch { /* not empty / gone */ }
  }
  return { droppedMissing, orphansDeleted: orphanIds.length, orphanIds };
}

// Reconcile the job ledger (gpu-manager.json) against the rebuilt store.
// --catch-up only: the API process owns this file while it runs.
//   - a job whose MP4 is gone is marked `expired` (status + reason);
//   - a store object that claims a ledger row (non-null jobId) with no
//     matching job is deleted and logged.
// Returns { jobsExpired, objectsDeletedNoLedger, ledgerPresent }.
async function reconcileLedger(dataDir, storage, logPath) {
  const ledgerPath = path.join(dataDir, 'gpu-manager.json');
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { jobsExpired: 0, objectsDeletedNoLedger: 0, ledgerPresent: false };
    throw new Error(`storage-runner: cannot read job ledger ${ledgerPath}: ${err.message}`);
  }
  const jobs = ledger?.state?.jobs ?? ledger?.jobs ?? {};
  if (typeof jobs !== 'object' || jobs === null) {
    throw new Error(`storage-runner: job ledger ${ledgerPath} has no jobs object`);
  }
  const now = Date.now();
  let jobsExpired = 0;
  for (const job of Object.values(jobs)) {
    const ref = job?.outputRef;
    if (!ref || typeof ref.namespace !== 'string' || typeof ref.objectId !== 'string') continue;
    if (job.status === 'expired' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'timed-out') continue;
    if (storage.index.getObject(ref.namespace, ref.objectId)) continue;
    job.status = 'expired';
    job.error = 'output-expired';
    job.expiredReason = 'output-missing';
    job.updatedAt = now;
    jobsExpired += 1;
  }
  let objectsDeletedNoLedger = 0;
  for (const record of storage.index.listObjects()) {
    if (typeof record.jobId !== 'string' || record.jobId.length === 0) continue;
    if (jobs[record.jobId]) continue;
    storage.backend.deleteObjectChunks(record.namespace, record.objectId);
    await storage.index.deleteObject(record.namespace, record.objectId);
    await storage.index.deleteRefsForObject(record.namespace, record.objectId);
    objectsDeletedNoLedger += 1;
    appendDeletionLog(logPath, {
      ts: new Date().toISOString(), event: 'object-deleted',
      namespace: record.namespace, objectId: record.objectId,
      sizeBytes: record.sizeBytes ?? null, jobId: record.jobId, reason: 'no-ledger-row',
    });
  }
  if (jobsExpired > 0 || objectsDeletedNoLedger > 0) {
    writeJsonAtomic(ledgerPath, ledger);
  }
  return { jobsExpired, objectsDeletedNoLedger, ledgerPresent: true };
}

function readPreviousHeartbeat(healthPath) {
  try {
    const v = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    if (v && typeof v === 'object') return v;
  } catch { /* none / unreadable — treated as no previous success */ }
  return null;
}

function writeHeartbeat(healthPath, { status, lastSuccessfulSweepAt, lastAttemptAt, objectsDeleted, error }) {
  writeJsonAtomic(healthPath, {
    lastSuccessfulSweepAt,
    lastAttemptAt,
    status,
    objectsDeleted,
    error: error ?? null,
  });
}

// One pass over the store. `catchUp` selects the --catch-up semantics
// (readiness record + ledger reconciliation); the hourly pass sweeps,
// rebuilds, and heartbeats only. Returns a report; throws on any
// incomplete work (the caller records the failed heartbeat and decides
// the exit code).
export async function runPass({ dataDir, catchUp = false } = {}) {
  const startedAt = new Date().toISOString();
  const storeRoot = path.join(dataDir, 'store');
  const logPath = path.join(dataDir, 'deletion-log.jsonl');
  const healthPath = path.join(dataDir, 'runner-health.json');
  fs.mkdirSync(storeRoot, { recursive: true });
  // 0. Index preflight (Finding 10B): inspects index.json BEFORE the
  // storage engine is constructed and before any deletion can happen.
  // Throws fail-closed on an unusable index.
  const indexPreflight = preflightIndex(storeRoot);
  const storage = createStorage({ rootDir: storeRoot });
  const now = Date.now();

  // §15 fault injection (--catch-up only; see the module header).
  const marker = (name) => path.join(dataDir, name);
  const has = (name) => fs.existsSync(marker(name));
  const consume = (name) => { try { fs.unlinkSync(marker(name)); } catch { /* already gone */ } };
  let staleReadiness = false;
  if (catchUp) {
    if (has('runner-fault-fail-once')) {
      consume('runner-fault-fail-once');
      throw Object.assign(new Error('test-stub fail-once fault'), { faultMarker: 'runner-fault-fail-once' });
    }
    if (has('runner-fault-fail')) {
      throw Object.assign(new Error('test-stub fail fault'), { faultMarker: 'runner-fault-fail' });
    }
    if (has('runner-fault-slow-short')) {
      await sleep(10_000);
    } else if (has('runner-fault-stale-readiness')) {
      consume('runner-fault-stale-readiness');
      staleReadiness = true;
    } else if (has('runner-fault-slow-once')) {
      consume('runner-fault-slow-once');
      await sleep(590_000);
    } else if (has('runner-fault-slow')) {
      await sleep(590_000);
    } else if (has('runner-fault-slow-timeout')) {
      await sleep(610_000);
    }
  }

  // 0b. Manifest rebuild (Finding 10B): when the preflight found the
  // index missing, rebuild it from the per-object manifests BEFORE any
  // deletion. Throws fail-closed when nothing can be restored at all.
  const manifestRebuild = indexPreflight.missing
    ? await rebuildIndexFromManifests(storage, storeRoot, dataDir)
    : { rebuilt: false, restored: 0, unrecoverable: [], preserveKeys: new Set() };

  // 1. Expiry sweep (idempotent delete-by-id; the engine checks existence
  // per object). The deletion log is written from the pre-sweep expired
  // list so sizes are recorded; only ids the sweep actually deleted are
  // logged.
  const expired = await expiredWithPresence(storage, now);
  const expiredButMissing = expired.filter((e) => !e.chunksPresent).length;
  const sizeByKey = new Map(expired.map((e) => [`${e.record.namespace}/${e.record.objectId}`, e.record]));
  const sweepReport = await storage.sweep(now);
  for (const id of sweepReport.deletedIds) {
    const record = sizeByKey.get(id);
    const [namespace, objectId] = id.split('/');
    appendDeletionLog(logPath, {
      ts: new Date().toISOString(), event: 'object-deleted',
      namespace, objectId, sizeBytes: record?.sizeBytes ?? null,
      jobId: record?.jobId ?? null, reason: 'expired',
    });
  }

  // 2. Index validation against the objects that remain. Unrecoverable
  // objects from a manifest rebuild are exempt from orphan deletion.
  const rebuild = await rebuildIndex(storage, logPath, manifestRebuild.preserveKeys);

  // 3. Ledger reconciliation (--catch-up only).
  let ledger = { jobsExpired: 0, objectsDeletedNoLedger: 0, ledgerPresent: false };
  if (catchUp) {
    ledger = await reconcileLedger(dataDir, storage, logPath);
  }

  const objectsDeleted = sweepReport.deleted
    + rebuild.droppedMissing
    + rebuild.orphansDeleted
    + ledger.objectsDeletedNoLedger;
  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    status: 'ok',
    objectsDeleted,
    objectsExpiredButMissing: expiredButMissing,
    // True ONLY when the manifest reconstruction in step 0 actually
    // restored at least one object (Finding 10B). A normal validation
    // pass — including an empty store — reports false.
    indexRebuilt: manifestRebuild.rebuilt,
    indexRestored: manifestRebuild.restored,
    unrecoverableOrphans: manifestRebuild.unrecoverable,
    stagingCleaned: sweepReport.stagingCleaned ?? 0,
    bytesFreed: sweepReport.bytesFreed ?? 0,
    jobsExpired: ledger.jobsExpired,
    ledgerPresent: ledger.ledgerPresent,
    staleReadiness,
  };
}

// Write the readiness record (--catch-up only) and the heartbeat after a
// pass. On a failed pass the heartbeat keeps the previous
// lastSuccessfulSweepAt (never advanced by a failure) and records the
// error; the readiness record carries status failed.
function writeRecords(dataDir, { catchUp, report, error }) {
  const healthPath = path.join(dataDir, 'runner-health.json');
  const previous = readPreviousHeartbeat(healthPath);
  const lastAttemptAt = new Date().toISOString();
  if (error) {
    writeHeartbeat(healthPath, {
      status: 'failed',
      lastSuccessfulSweepAt: previous?.lastSuccessfulSweepAt ?? null,
      lastAttemptAt,
      objectsDeleted: report?.objectsDeleted ?? 0,
      error: String(error.message ?? error),
    });
  } else {
    writeHeartbeat(healthPath, {
      status: 'ok',
      lastSuccessfulSweepAt: report.completedAt,
      lastAttemptAt,
      objectsDeleted: report.objectsDeleted,
      error: null,
    });
  }
  if (catchUp) {
    const requestId = readRequestId(dataDir);
    const record = {
      cycleId: requestId === 'none' ? 'unknown' : requestId,
      startupRequestId: report?.staleReadiness
        ? '00000000-0000-4000-8000-000000000000'
        : requestId,
      bootId: readBootId(),
      startedAt: report?.startedAt ?? lastAttemptAt,
      completedAt: report?.completedAt ?? lastAttemptAt,
      status: error ? 'failed' : 'ok',
      objectsDeleted: report?.objectsDeleted ?? 0,
      objectsExpiredButMissing: report?.objectsExpiredButMissing ?? 0,
      indexRebuilt: report?.indexRebuilt ?? false,
      indexRestored: report?.indexRestored ?? 0,
      unrecoverableOrphans: report?.unrecoverableOrphans ?? [],
      ...(error ? { error: String(error.message ?? error) } : {}),
    };
    writeJsonAtomic(path.join(dataDir, 'readiness.json'), record);
  }
}

// Run one pass under the sweep lock and record its outcome. Returns
// { ok, report?, error?, lockContended?, skipped? }. `shouldProceed`
// is checked AFTER the lock is acquired and BEFORE any work runs: the
// daemon passes () => !stopping so a pass queued behind a running pass
// skips instead of starting after shutdown began. A skipped pass is
// not a failure (no heartbeat write, no error) — it simply never ran.
export async function runPassLocked({ dataDir, catchUp = false, lockTimeoutMs = SWEEP_LOCK_TIMEOUT_MS, shouldProceed = null } = {}) {
  const locked = await withSweepLock(dataDir, async () => {
    if (shouldProceed && !shouldProceed()) {
      return { skipped: true };
    }
    const report = await runPass({ dataDir, catchUp });
    writeRecords(dataDir, { catchUp, report, error: null });
    return report;
  }, lockTimeoutMs);
  if (!locked.acquired) {
    return { ok: false, lockContended: true, error: new Error('sweep lock contended (another pass is running)') };
  }
  if (locked.result?.skipped) {
    return { ok: true, skipped: true, report: null };
  }
  return { ok: true, report: locked.result };
}

// The --catch-up entry: one bounded pass; exit 0 on success, non-zero on
// any incomplete work. A lock-contended pass is a failure here (the
// recovery unit's 10-minute timeout is the bound, and the API must not
// listen on an unreconciled store).
export async function runCatchUp({ dataDir }) {
  const startedAt = new Date().toISOString();
  let report = null;
  let error = null;
  try {
    const outcome = await runPassLocked({ dataDir, catchUp: true });
    if (!outcome.ok) {
      error = outcome.error;
    } else if (outcome.skipped) {
      // Impossible (catch-up never passes shouldProceed), but a skipped
      // catch-up must never be reported as a success.
      error = new Error('catch-up pass skipped (shutdown requested)');
    } else {
      report = outcome.report;
    }
  } catch (err) {
    error = err;
  }
  if (error) {
    // The failed pass still records a failed heartbeat (and a failed
    // readiness record) so the outage is visible to the probe and the
    // API gate — unless the failure happened before any record could be
    // written, in which case the write itself is best-effort.
    try {
      writeRecords(dataDir, { catchUp: true, report, error });
    } catch { /* the heartbeat/readiness write itself failed; the exit code still reports it */ }
    logLine(dataDir, 'startup-recovery-failed', `storage-runner-${String(error.message ?? error).replace(/\s+/g, '-')}`);
    return { ok: false, error };
  }
  logLine(dataDir, 'startup-recovery-succeeded', 'none', 'info');
  return { ok: true, report };
}

// The hourly daemon: one pass immediately, then one pass every hour. A
// failed pass is logged and recorded as a failed heartbeat; the daemon
// stays up for the next hourly pass. A lock-contended pass is skipped
// silently (the previous heartbeat stands; it ages out on its own merit
// if contention persists). Exits non-zero only on a fatal startup error.
//
// SHUTDOWN (Finding 10E): runDaemon returns a controller synchronously
// — { stopping, timer, started, stop } — so the CLI can register its
// signal handlers BEFORE the initial pass starts. stop() sets the
// stopping flag (no new pass starts, including a pass queued on the
// sweep lock behind a running one), clears the interval, and waits for
// every in-flight pass to settle and release its sweep lock. stop() is
// idempotent: a second call returns at once. `started` resolves when
// the initial pass completes and the interval is armed; it rejects only
// on a fatal startup error. `intervalMs` is configurable (default one
// hour) so tests can drive hourly passes without waiting an hour.
export function runDaemon({ dataDir, intervalMs = HOURLY_INTERVAL_MS } = {}) {
  const controller = {
    dataDir,
    stopping: false,
    activePasses: new Set(),
    timer: null,
    started: null,
    stop: null,
  };
  console.log(`[storage-runner] starting hourly daemon (dataDir=${dataDir})`);
  const passOnce = async () => {
    if (controller.stopping) return;
    const pass = (async () => {
      let outcome;
      try {
        outcome = await runPassLocked({
          dataDir,
          catchUp: false,
          shouldProceed: () => !controller.stopping,
        });
      } catch (err) {
        outcome = { ok: false, error: err };
      }
      if (outcome.skipped) return;
      if (!outcome.ok && outcome.lockContended) {
        console.log('[storage-runner] sweep lock contended, skipping this pass');
        return;
      }
      if (!outcome.ok) {
        const err = outcome.error;
        try {
          writeRecords(dataDir, { catchUp: false, report: null, error: err });
        } catch { /* heartbeat write failed; the log line below still records it */ }
        console.error(`[storage-runner] hourly pass failed: ${err?.message ?? err}`);
        return;
      }
      console.log(`[storage-runner] hourly pass ok (objectsDeleted=${outcome.report.objectsDeleted})`);
    })();
    controller.activePasses.add(pass);
    try {
      await pass;
    } finally {
      controller.activePasses.delete(pass);
    }
  };
  controller.stop = async () => {
    controller.stopping = true;
    if (controller.timer) {
      clearInterval(controller.timer);
      controller.timer = null;
    }
    if (controller.activePasses.size > 0) {
      await Promise.all([...controller.activePasses]);
    }
  };
  controller.started = (async () => {
    await passOnce();
    if (!controller.stopping) {
      controller.timer = setInterval(() => { void passOnce(); }, intervalMs);
    }
  })();
  return controller;
}

// --- CLI --------------------------------------------------------------------
function parseArgs(argv) {
  const out = { catchUp: false, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--catch-up') { out.catchUp = true; continue; }
    if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error('storage-runner: --data-dir requires a path');
      }
      out.dataDir = value;
      i += 1;
      continue;
    }
    throw new Error(`storage-runner: unknown argument ${JSON.stringify(arg)}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('usage: node storage-runner.js [--catch-up] [--data-dir <path>]');
    process.exitCode = 2;
    process.exit(2);
  }
  const dataDir = options.dataDir ?? process.env.NOVA_API_DATA_DIR ?? DEFAULT_DATA_DIR;
  if (options.catchUp) {
    runCatchUp({ dataDir }).then(
      (r) => { process.exit(r.ok ? 0 : 1); },
      (err) => { console.error(`[storage-runner] catch-up failed: ${err?.message ?? err}`); process.exit(1); },
    );
  } else {
    // Shutdown handlers are registered BEFORE the daemon starts
    // (Finding 10E): a SIGTERM/SIGINT arriving during the initial pass
    // must wait for that pass to settle and release its sweep lock, not
    // kill the process mid-pass. The handler is idempotent: a second
    // signal exits at once instead of stacking waits.
    let daemonResolve;
    const daemonReady = new Promise((resolve) => { daemonResolve = resolve; });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) { process.exit(0); return; }
      shuttingDown = true;
      const daemon = await daemonReady;
      try { await daemon.stop(); } catch { /* best effort; the exit code still reports clean shutdown */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
    const daemon = runDaemon({ dataDir });
    daemonResolve(daemon);
    daemon.started.catch((err) => {
      console.error(`[storage-runner] daemon failed to start: ${err?.message ?? err}`);
      process.exit(1);
    });
  }
}
