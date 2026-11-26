// NOVA Personal GPU Cloud — NOVA Cloud Storage: engine.
//
// The store itself. Content-addressed, chunked, integrity-verified,
// retention-aware object storage behind the backend interface — the
// engine never touches a chunk directly: chunk bytes go through the
// backend. Two engine-owned metadata files live on disk beside the
// chunks: the metadata index (index.json, via MetadataIndex) and one
// manifest.json per object (a durable copy of the object's record,
// written at put time so the runner can rebuild the index from surviving
// objects if index.json is lost — ChatGPT Rev 4.9 review, Finding 10B).
// The manifest is written only when the backend exposes a local chunk
// directory (LocalBackend); a future remote backend has no manifest,
// and a manifest rebuild on such a store falls back to fail-closed.
//
// How a put works:
//   1. The source (Buffer, file path, or stream) is read in chunks
//      (default 4 MiB). Chunks go to backend STAGING — the object id is
//      the content hash, known only after the last byte is read.
//   2. The content hash is computed incrementally as bytes arrive, and
//      each chunk is hashed as it is written.
//   3. On completion: if the same bytes already exist in the namespace,
//      the staging area is discarded and the existing record is returned
//      (deduplication — same bytes, same object, stored once). Otherwise
//      the capacity check runs, staging is finalised into place, and the
//      metadata index record is written.
//   4. A failed put (disk full, quota exceeded) leaves NO partial object:
//      staging is discarded and no index record is written.
//
// How a get works: the record is resolved (expired objects are lazily
// deleted and reported missing), then chunks stream out one at a time,
// each hash-verified against the record before it is yielded. Corruption
// is detected, never silently served.
//
// Retention (owner direction, 24 Nov 2026 ~16:46 WAT): generated outputs
// expire 24h after creation; the sweep deletes them for real. Models,
// system files and small records persist. See retention.js.
//
// NO artificial caps: there is no per-object or per-namespace size limit
// in this engine — the only limit is physical capacity (see capacity()).
// Usage accounting reports bytes per namespace; it does not refuse
// writes. "Abundant" is a property of the backend underneath, and the
// local backend's measured headroom is small — see docs/storage/design.md.

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assertBackend } from './backend-interface.js';
import { LocalBackend } from './local-backend.js';
import { MetadataIndex } from './metadata-index.js';
import { assertNamespace } from './namespaces.js';
import { resolveRetention, isExpired, GENERATED_CONTENT_TTL_MS } from './retention.js';
import { createHasher, sha256Hex } from './hashing.js';
import {
  StorageValidationError,
  ObjectNotFoundError,
  IntegrityError,
  CapacityError,
  DeliveryRefError,
  ChunkNotFoundError,
} from './errors.js';

export const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_DELIVERY_REF_TTL_MS = GENERATED_CONTENT_TTL_MS; // 24 hours
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000; // crashed uploads older than 1h
export const DELIVERY_REF_PREFIX = 'nova://delivery/';
// One manifest per object, written into the object's chunk directory at
// put time (Finding 10B). The manifest is a durable copy of the index
// record — the second source of truth the runner rebuilds the index
// from when index.json is missing or unusable. It is NOT a chunk:
// LocalBackend.listChunks only counts /^\d+\.chunk$/ files, so the
// manifest is invisible to chunk enumeration, and deleteObjectChunks
// removes the whole object directory (manifest included) with the
// object. Delivery references are NOT in the manifest (they live only
// in the index): a manifest rebuild restores objects, not references.
export const MANIFEST_FILE_NAME = 'manifest.json';

function isDiskFullError(err) {
  return err && (err.code === 'ENOSPC' || err.code === 'EDQUOT');
}

// Atomic file write (temp file in the same directory, fsync, rename) —
// the same rule as the index and the chunk writes: a crash leaves the
// old file or the new file, never a half-written one.
function writeFileAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function manifestPath(chunksDir, namespace, objectId) {
  return path.join(chunksDir, namespace, objectId, MANIFEST_FILE_NAME);
}

// Write the manifest for one object record. Local backends only (the
// caller guards on typeof backend.chunksDir === 'string').
export function writeObjectManifest(chunksDir, record) {
  writeFileAtomic(manifestPath(chunksDir, record.namespace, record.objectId), JSON.stringify(record, null, 2) + '\n');
}

// Read a manifest back. Returns the parsed record, or null when the
// manifest is missing or unparseable (both mean "unrecoverable" to the
// rebuild — never a throw, never a guess).
export function readObjectManifest(chunksDir, namespace, objectId) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath(chunksDir, namespace, objectId), 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Validate a manifest record against the object directory it claims to
// describe. `chunkIndices` is the on-disk chunk list (from
// backend.listChunks). Returns { ok: true } or { ok: false, reason }.
// Strict on purpose: a manifest that does not describe exactly the
// chunks on disk cannot prove the object's integrity, so the object is
// unrecoverable — preserved on disk, never served, never deleted by the
// rebuild.
export function validateManifestRecord(record, namespace, objectId, chunkIndices) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'manifest-not-an-object' };
  }
  if (record.namespace !== namespace) return { ok: false, reason: 'manifest-namespace-mismatch' };
  if (record.objectId !== objectId) return { ok: false, reason: 'manifest-objectId-mismatch' };
  // Content addressing: the id IS the content hash.
  if (record.hash !== objectId) return { ok: false, reason: 'manifest-hash-mismatch' };
  if (!Number.isInteger(record.chunkCount) || record.chunkCount <= 0) {
    return { ok: false, reason: 'manifest-chunkCount-invalid' };
  }
  if (!Array.isArray(record.chunkHashes) || record.chunkHashes.length !== record.chunkCount) {
    return { ok: false, reason: 'manifest-chunkHashes-invalid' };
  }
  if (!record.chunkHashes.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
    return { ok: false, reason: 'manifest-chunkHashes-invalid' };
  }
  if (typeof record.sizeBytes !== 'number' || record.sizeBytes < 0) {
    return { ok: false, reason: 'manifest-sizeBytes-invalid' };
  }
  if (!Number.isInteger(record.chunkSizeBytes) || record.chunkSizeBytes <= 0) {
    return { ok: false, reason: 'manifest-chunkSizeBytes-invalid' };
  }
  if (typeof record.createdAt !== 'number') return { ok: false, reason: 'manifest-createdAt-invalid' };
  if (record.expiresAt !== null && typeof record.expiresAt !== 'number') {
    return { ok: false, reason: 'manifest-expiresAt-invalid' };
  }
  if (!Array.isArray(chunkIndices) || chunkIndices.length !== record.chunkCount
    || !chunkIndices.every((i, n) => i === n)) {
    return { ok: false, reason: 'manifest-chunks-incomplete' };
  }
  return { ok: true };
}

function toCapacityError(err, what) {
  if (err instanceof CapacityError) return err;
  if (isDiskFullError(err)) {
    return new CapacityError(`${what}: backend out of space (${err.code})`);
  }
  return err;
}

export class NovaStorage {
  constructor(options = {}) {
    const { rootDir } = options;
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new StorageValidationError('NovaStorage requires a rootDir');
    }
    this.rootDir = rootDir;
    this.backend = options.backend ?? new LocalBackend(rootDir);
    assertBackend(this.backend);
    this.index = new MetadataIndex(path.join(rootDir, 'index.json'));
    this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    if (!Number.isInteger(this.chunkSizeBytes) || this.chunkSizeBytes <= 0) {
      throw new StorageValidationError('chunkSizeBytes must be a positive integer');
    }
    // Controllable clock (same idea as the GPU Manager's tests): the
    // engine reads time only through this function.
    this.now = options.clock ?? Date.now;
    // Capacity probe: () => { totalBytes, freeBytes }. Defaults to the
    // backend's own capacity(); injectable so tests can simulate a full
    // disk without filling one.
    this.capacityProbe = options.capacityProbe ?? (() => this.backend.capacity());
    this.onSweepError = options.onSweepError ?? null;
    this.sweepTimer = null;
  }

  // --- put ---

  // Store an object. source: Buffer | file path (string) | Readable stream
  // | async iterable of Buffers. Returns the object record.
  async put({ namespace, source, contentType = 'application/octet-stream', jobId = null, retention, ttlMs }) {
    const namespaceDef = assertNamespace(namespace);
    if (typeof contentType !== 'string' || contentType.length === 0) {
      throw new StorageValidationError('contentType must be a non-empty string');
    }
    if (jobId !== null && typeof jobId !== 'string') {
      throw new StorageValidationError('jobId must be a string or null');
    }
    const createdAt = this.now();
    const retentionResult = resolveRetention(namespaceDef, { retention, ttlMs }, createdAt);

    // Normalise the source to { stream, knownSize }. Known-size sources
    // get a capacity pre-check before any byte is written.
    const { stream, knownSize } = this.normaliseSource(source);
    if (knownSize !== null) {
      await this.checkCapacity(knownSize);
    }

    const uploadId = `up_${randomUUID()}`;
    const contentHasher = createHasher();
    const chunkHashes = [];
    let sizeBytes = 0;
    let chunkCount = 0;
    let pending = [];
    let pendingBytes = 0;

    const flushChunk = async (buffer) => {
      try {
        await this.backend.writeStagingChunk(uploadId, chunkCount, buffer);
      } catch (err) {
        await this.backend.discardStaging(uploadId).catch(() => {});
        throw toCapacityError(err, 'put');
      }
      chunkHashes.push(sha256Hex(buffer));
      chunkCount += 1;
    };

    try {
      for await (const piece of stream) {
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        contentHasher.update(buf);
        sizeBytes += buf.length;
        pending.push(buf);
        pendingBytes += buf.length;
        while (pendingBytes >= this.chunkSizeBytes) {
          const joined = Buffer.concat(pending);
          const chunk = joined.subarray(0, this.chunkSizeBytes);
          const rest = joined.subarray(this.chunkSizeBytes);
          pending = rest.length > 0 ? [Buffer.from(rest)] : [];
          pendingBytes = rest.length;
          await flushChunk(Buffer.from(chunk));
        }
      }
      if (pendingBytes > 0) {
        await flushChunk(Buffer.concat(pending));
      }
    } catch (err) {
      await this.backend.discardStaging(uploadId).catch(() => {});
      throw toCapacityError(err, 'put');
    }

    const objectId = contentHasher.digest();

    // Deduplication: the same bytes in the same namespace are the same
    // object. An expired record with the same hash is dead — delete it
    // and store fresh.
    const existing = this.index.getObject(namespace, objectId);
    if (existing) {
      if (!isExpired(existing, this.now())) {
        await this.backend.discardStaging(uploadId);
        return { ...existing, deduplicated: true };
      }
      await this.delete(namespace, objectId);
    }

    // Unknown-size sources get their capacity check here (known-size
    // sources were checked before staging; the check is cheap, run it
    // for both — free space can move while a long upload streams). A
    // refusal here discards staging: no partial object is left behind.
    try {
      await this.checkCapacity(sizeBytes);
    } catch (err) {
      await this.backend.discardStaging(uploadId).catch(() => {});
      throw err;
    }

    try {
      await this.backend.finalizeStaging(uploadId, namespace, objectId, chunkCount);
    } catch (err) {
      await this.backend.discardStaging(uploadId).catch(() => {});
      throw toCapacityError(err, 'put finalize');
    }

    const record = {
      objectId,
      namespace,
      hash: objectId, // content addressing: the id IS the content hash
      sizeBytes,
      chunkSizeBytes: this.chunkSizeBytes,
      chunkCount,
      chunkHashes,
      contentType,
      jobId,
      createdAt,
      expiresAt: retentionResult.expiresAt,
      retentionPolicy: retentionResult.policy,
      ttlMs: retentionResult.ttlMs,
    };
    // Durable per-object manifest (Finding 10B): the runner rebuilds
    // the index from manifests when index.json is lost, so the manifest
    // must exist before the index record does. A manifest write failure
    // fails the put rather than storing an object no rebuild could ever
    // restore: the finalized chunks are removed and the put throws, so
    // no partial object is left behind. Backends without a local chunk
    // directory (a future remote backend) have no manifest; a rebuild
    // on such a store falls back to fail-closed.
    // NOTE: a crash between finalizeStaging and this manifest write
    // leaves orphan chunks (unreachable, no index entry, no manifest).
    // They waste space but are never served; the runner's rebuild
    // deletes them when the index is present, and preserves them (never
    // deletes) when the index is missing and they cannot be restored.
    if (typeof this.backend.chunksDir === 'string') {
      try {
        writeObjectManifest(this.backend.chunksDir, record);
      } catch (err) {
        await this.backend.deleteObjectChunks(namespace, objectId).catch(() => {});
        throw err;
      }
    }
    await this.index.putObject(record);
    return { ...record, deduplicated: false };
  }

  normaliseSource(source) {
    if (Buffer.isBuffer(source)) {
      return { stream: Readable.from([source]), knownSize: source.length };
    }
    if (typeof source === 'string') {
      let stat;
      try {
        stat = fs.statSync(source);
      } catch {
        throw new StorageValidationError(`source file not found: ${source}`);
      }
      if (!stat.isFile()) {
        throw new StorageValidationError(`source is not a file: ${source}`);
      }
      return { stream: fs.createReadStream(source), knownSize: stat.size };
    }
    if (source !== null && typeof source === 'object' && typeof source[Symbol.asyncIterator] === 'function') {
      return { stream: source, knownSize: null };
    }
    throw new StorageValidationError('source must be a Buffer, a file path, or a readable stream');
  }

  async checkCapacity(neededBytes) {
    let probe;
    try {
      probe = await this.capacityProbe();
    } catch {
      // An unmeasurable backend does not block a put — the write itself
      // will fail honestly with ENOSPC if there is no room.
      return;
    }
    if (probe && Number.isFinite(probe.freeBytes) && probe.freeBytes < neededBytes) {
      throw new CapacityError(
        `insufficient capacity: object needs ${neededBytes} bytes, backend reports ${probe.freeBytes} free`,
      );
    }
  }

  // --- get / head / delete ---

  // Resolve a record for reading. Expired objects are reported missing
  // WITHOUT physical deletion (Finding 10A): the storage runner's sweep
  // is the SOLE deleter. A read path that deleted would race the
  // runner's index rebuild and could destroy an object the runner
  // still counts as live — the 24h rule holds even between sweeps,
  // because the object is simply unavailable until the sweep removes it.
  resolveForRead(namespace, objectId) {
    assertNamespace(namespace);
    const record = this.index.getObject(namespace, objectId);
    if (!record) {
      throw new ObjectNotFoundError(namespace, objectId, 'missing');
    }
    if (isExpired(record, this.now())) {
      throw new ObjectNotFoundError(namespace, objectId, 'expired');
    }
    return record;
  }

  // Stream an object out, one chunk at a time, each hash-verified before
  // it is yielded. Never loads the whole object into memory.
  get({ namespace, objectId }) {
    const record = this.resolveForRead(namespace, objectId);
    const backend = this.backend;
    const self = this;
    async function* verifiedChunks() {
      for (let i = 0; i < record.chunkCount; i++) {
        let chunk;
        try {
          chunk = await backend.getChunk(namespace, objectId, i);
        } catch (err) {
          if (err instanceof ChunkNotFoundError) {
            throw new IntegrityError(namespace, objectId, i, 'chunk missing from backend');
          }
          throw err;
        }
        if (sha256Hex(chunk) !== record.chunkHashes[i]) {
          throw new IntegrityError(namespace, objectId, i, 'hash mismatch');
        }
        yield chunk;
      }
      void self;
    }
    return Readable.from(verifiedChunks());
  }

  // Whole-object read as one Buffer. For SMALL objects only (tests,
  // text records) — a 10 GB model must stream through get().
  async getBuffer({ namespace, objectId }) {
    const stream = this.get({ namespace, objectId });
    const parts = [];
    for await (const piece of stream) {
      parts.push(piece);
    }
    return Buffer.concat(parts);
  }

  // Metadata without bytes. Returns null when the object is missing or
  // expired (expired objects are NOT physically deleted here — Finding
  // 10A; the runner's sweep is the sole deleter).
  head({ namespace, objectId }) {
    assertNamespace(namespace);
    const record = this.index.getObject(namespace, objectId);
    if (!record) return null;
    if (isExpired(record, this.now())) {
      return null;
    }
    return { ...record };
  }

  // Real deletion: chunks + index record + delivery references. Returns
  // true when an object was actually removed.
  async delete(namespace, objectId) {
    assertNamespace(namespace);
    await this.backend.deleteObjectChunks(namespace, objectId);
    const removed = await this.index.deleteObject(namespace, objectId);
    await this.index.deleteRefsForObject(namespace, objectId);
    return removed;
  }

  // --- expiry sweep ---

  // Delete every expired object (real deletion) and discard crashed
  // staging areas. Returns a report. Nothing is deleted before its
  // expiry time — a sweep run early is harmless.
  async sweep(now = this.now()) {
    const expired = this.index.listExpired(now);
    let bytesFreed = 0;
    const deletedIds = [];
    for (const record of expired) {
      await this.backend.deleteObjectChunks(record.namespace, record.objectId);
      await this.index.deleteObject(record.namespace, record.objectId);
      await this.index.deleteRefsForObject(record.namespace, record.objectId);
      bytesFreed += record.sizeBytes;
      deletedIds.push(`${record.namespace}/${record.objectId}`);
    }
    const staleStaging = await this.backend.listStaleStaging(STAGING_MAX_AGE_MS, now);
    for (const uploadId of staleStaging) {
      await this.backend.discardStaging(uploadId);
    }
    return {
      checked: this.index.listObjects().length + expired.length,
      deleted: deletedIds.length,
      deletedIds,
      bytesFreed,
      stagingCleaned: staleStaging.length,
    };
  }

  // Run the sweep on a timer (default every hour — well inside the 24h
  // rule, so an expired object is reclaimed promptly). The timer is
  // unref'd: it never holds a process open on its own. Sweep errors go
  // to onSweepError, never out of the timer.
  startSweepTimer(intervalMs = DEFAULT_SWEEP_INTERVAL_MS) {
    if (this.sweepTimer !== null) {
      throw new StorageValidationError('sweep timer already running');
    }
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new StorageValidationError('sweep interval must be a positive integer (ms)');
    }
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => {
        if (this.onSweepError) this.onSweepError(err);
      });
    }, intervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    return this.sweepTimer;
  }

  stopSweepTimer() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // --- usage + capacity ---

  // Usage accounting: bytes + object counts, per namespace and total.
  // Reporting only — this engine enforces no usage caps.
  usage() {
    const perNamespace = {};
    let totalBytes = 0;
    let totalObjects = 0;
    for (const record of this.index.listObjects()) {
      const entry = perNamespace[record.namespace] ?? { bytes: 0, objects: 0 };
      entry.bytes += record.sizeBytes;
      entry.objects += 1;
      perNamespace[record.namespace] = entry;
      totalBytes += record.sizeBytes;
      totalObjects += 1;
    }
    return { totalBytes, totalObjects, namespaces: perNamespace };
  }

  // Physical capacity: the backend's own numbers plus what this store
  // holds. freeBytes is the backend's report — on a quota-managed
  // filesystem the true headroom may be lower (see the design doc).
  async capacity() {
    const probe = await this.capacityProbe();
    const usage = this.usage();
    return {
      totalBytes: probe.totalBytes,
      freeBytes: probe.freeBytes,
      usedBytes: probe.totalBytes - probe.freeBytes,
      storeBytes: usage.totalBytes,
      storeObjects: usage.totalObjects,
      headroomBytes: probe.freeBytes,
    };
  }

  // --- delivery references ---

  // Issue a short-lived, opaque reference a user redeems to download one
  // object. This is what the GPU Manager stores as a job's resultRef —
  // never media bytes. The reference carries no object identity in
  // plaintext: it is a random token, resolved server-side.
  // Async: issuing a ref mutates the index, and index mutations take
  // the cross-process lock (Finding 10C) — the wait yields the loop.
  async issueDeliveryRef({ namespace, objectId, ttlMs = DEFAULT_DELIVERY_REF_TTL_MS, maxRedemptions = null }) {
    const record = this.resolveForRead(namespace, objectId);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new StorageValidationError('delivery reference ttlMs must be a positive integer');
    }
    if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0)) {
      throw new StorageValidationError('maxRedemptions must be a positive integer or null');
    }
    const now = this.now();
    const token = randomBytes(24).toString('hex');
    const refRecord = {
      token,
      ref: `${DELIVERY_REF_PREFIX}${token}`,
      namespace,
      objectId,
      createdAt: now,
      expiresAt: now + ttlMs,
      maxRedemptions,
      redemptions: 0,
    };
    await this.index.putRef(refRecord);
    void record;
    return { ...refRecord };
  }

  // Redeem a reference: validates it, counts the redemption, and returns
  // the object it points at. A reference to a deleted or expired object
  // fails — deleting the object kills its references.
  // Async, like issueDeliveryRef: redeeming mutates the index (the
  // redemption count, and possibly the ref's deletion).
  async redeemDeliveryRef(ref) {
    const token = typeof ref === 'string' && ref.startsWith(DELIVERY_REF_PREFIX)
      ? ref.slice(DELIVERY_REF_PREFIX.length)
      : ref;
    const now = this.now();
    const refRecord = typeof token === 'string' ? this.index.getRef(token) : null;
    if (!refRecord) {
      throw new DeliveryRefError('unknown');
    }
    if (refRecord.expiresAt <= now) {
      await this.index.deleteRef(token);
      throw new DeliveryRefError('expired');
    }
    if (refRecord.maxRedemptions !== null && refRecord.redemptions >= refRecord.maxRedemptions) {
      throw new DeliveryRefError('exhausted');
    }
    const record = this.index.getObject(refRecord.namespace, refRecord.objectId);
    if (!record) {
      await this.index.deleteRef(token);
      throw new ObjectNotFoundError(refRecord.namespace, refRecord.objectId, 'missing');
    }
    if (isExpired(record, now)) {
      // No physical deletion here (Finding 10A): an expired object is
      // unavailable, and the runner's sweep removes it.
      throw new ObjectNotFoundError(refRecord.namespace, refRecord.objectId, 'expired');
    }
    refRecord.redemptions += 1;
    await this.index.putRef(refRecord);
    return {
      namespace: refRecord.namespace,
      objectId: refRecord.objectId,
      record: { ...record },
      redemptions: refRecord.redemptions,
    };
  }
}

export function createStorage(options) {
  return new NovaStorage(options);
}
