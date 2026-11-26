// NOVA Personal GPU Cloud — NOVA Cloud Storage: metadata index.
//
// The store's bookkeeping, kept as ONE JSON document next to the chunks:
//   - objects: (namespace, objectId) -> record { objectId, namespace,
//     hash, sizeBytes, chunkSizeBytes, chunkCount, chunkHashes[],
//     contentType, jobId, createdAt, expiresAt, retentionPolicy, ttlMs }
//   - deliveryRefs: token -> { ref, namespace, objectId, createdAt,
//     expiresAt, maxRedemptions, redemptions }
//
// Same persistence rules as the GPU Manager's JsonStore: atomic writes
// (temp file in the same directory, fsync, rename) so a crash can never
// leave a half-written index.
//
// CROSS-PROCESS (ChatGPT Rev 4.9 review, Finding 10C): the API process
// and the storage runner are two processes sharing this one file, so the
// index is NO LONGER single-writer. Every mutation runs under a shared
// cross-process transaction lock (index.lock, next to index.json, via
// the flock binding) and reloads the file from disk under that lock
// before applying — a runner pass can no longer clobber an API put that
// landed between the runner's load and its save (last-writer-wins is
// gone). Every read reloads when the file's mtime/size changed since
// the last load, so a process never serves a stale in-memory copy after
// another process saved. A malformed index fails closed: loads throw
// instead of overwriting the corrupt file with stale in-memory state.
//
// The lock wait is ASYNC (the poll yields the event loop): a synchronous
// wait (Atomics.wait) would block the whole process while contended —
// freezing the API and starving the very code that would release the
// lock. That is why every mutation method is async. Reads stay
// synchronous: they take no lock.
//
// The lock file is opened for writing, falling back to read-only when
// another user created it (a root-side test run): flock(2) LOCK_EX
// works on a read-only fd (verified live on this VM). install.sh
// pre-creates the lock file as root:nova-api 0660, mirroring the
// startup-attempts lock.
//
// The index holds METADATA only — hashes and sizes, never media bytes.

import fs from 'node:fs';
import path from 'node:path';

import { flockExNb, flockUn } from '../api-server/flock-binding.mjs';

// Bounded wait for the index lock. Mutations are read-apply-save
// sequences of milliseconds; 10 s is generous, and a timeout fails the
// mutation loudly instead of stalling a request or a pass forever.
export const INDEX_LOCK_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultIndexState() {
  return {
    version: 1,
    objects: {}, // "<namespace>:<objectId>" -> object record
    deliveryRefs: {}, // token -> delivery reference record
  };
}

export function indexKey(namespace, objectId) {
  return `${namespace}:${objectId}`;
}

export class MetadataIndex {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = path.join(path.dirname(filePath), 'index.lock');
    this.state = defaultIndexState();
    this._loadedStat = null;
    if (fs.existsSync(filePath)) {
      this._loadFromDisk();
    }
  }

  // --- disk state ---------------------------------------------------------

  _stat() {
    try {
      const s = fs.statSync(this.filePath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  _sameStat(a, b) {
    if (a === null || b === null) return a === b;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  // Read + parse + shape-check the index file. Throws on malformed JSON
  // or a wrong-shaped document — fail closed, never overwrite a corrupt
  // file with stale in-memory state.
  _loadFromDisk() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let value;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Error(`metadata index is unusable (invalid JSON): ${this.filePath}: ${err.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`metadata index is not an object: ${this.filePath}`);
    }
    if (!value.objects || typeof value.objects !== 'object' || Array.isArray(value.objects)
      || !value.deliveryRefs || typeof value.deliveryRefs !== 'object' || Array.isArray(value.deliveryRefs)) {
      throw new Error(`metadata index has an invalid shape: ${this.filePath}`);
    }
    this.state = value;
    this._loadedStat = this._stat();
  }

  // Unconditional reload for use under the lock: the file may have been
  // replaced by another process since this instance last looked. A
  // missing file means an empty index; a malformed file throws.
  _loadFromDiskOrEmpty() {
    if (fs.existsSync(this.filePath)) {
      this._loadFromDisk();
    } else {
      this.state = defaultIndexState();
      this._loadedStat = null;
    }
  }

  // Reload only when the file changed since the last load/save (mtime +
  // size). Called at the start of every read so a process never serves
  // a stale in-memory copy after another process saved.
  reloadIfStale() {
    const stat = this._stat();
    if (this._sameStat(stat, this._loadedStat)) return;
    if (stat === null) {
      this.state = defaultIndexState();
      this._loadedStat = null;
      return;
    }
    this._loadFromDisk();
  }

  // --- cross-process lock ---------------------------------------------------

  // Run fn() holding the exclusive index lock. The lock is held only
  // for one read-apply-save sequence (milliseconds). ASYNC: the poll
  // yields the event loop while contended — a synchronous wait would
  // block the whole process and starve the code that releases the lock.
  // Throws when the lock cannot be acquired within the timeout.
  async withLock(fn, timeoutMs = INDEX_LOCK_TIMEOUT_MS) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(this.lockPath, 'w');
    } catch (err) {
      if (err?.code === 'EACCES') {
        // The lock file was created by another user and is not writable
        // here; flock(2) LOCK_EX works on a read-only fd.
        fd = fs.openSync(this.lockPath, 'r');
      } else {
        throw err;
      }
    }
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (flockExNb(fd)) break;
        if (Date.now() >= deadline) {
          throw new Error(`metadata index lock contended (another process holds ${this.lockPath})`);
        }
        await sleep(25);
      }
      return await fn();
    } finally {
      try { flockUn(fd); } catch { /* already released */ }
      fs.closeSync(fd);
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
    this._loadedStat = this._stat();
  }

  // --- objects ---

  getObject(namespace, objectId) {
    this.reloadIfStale();
    return this.state.objects[indexKey(namespace, objectId)] ?? null;
  }

  async putObject(record) {
    return this.withLock(async () => {
      this._loadFromDiskOrEmpty();
      this.state.objects[indexKey(record.namespace, record.objectId)] = { ...record };
      this.save();
      return record;
    });
  }

  async deleteObject(namespace, objectId) {
    return this.withLock(async () => {
      this._loadFromDiskOrEmpty();
      const key = indexKey(namespace, objectId);
      if (!Object.prototype.hasOwnProperty.call(this.state.objects, key)) return false;
      delete this.state.objects[key];
      this.save();
      return true;
    });
  }

  listObjects(namespace = null) {
    this.reloadIfStale();
    const all = Object.values(this.state.objects);
    if (namespace === null) return all;
    return all.filter((r) => r.namespace === namespace);
  }

  listExpired(now) {
    this.reloadIfStale();
    return Object.values(this.state.objects).filter(
      (r) => r.expiresAt !== null && r.expiresAt <= now,
    );
  }

  // --- delivery references ---

  getRef(token) {
    this.reloadIfStale();
    return this.state.deliveryRefs[token] ?? null;
  }

  async putRef(refRecord) {
    return this.withLock(async () => {
      this._loadFromDiskOrEmpty();
      this.state.deliveryRefs[refRecord.token] = { ...refRecord };
      this.save();
      return refRecord;
    });
  }

  async deleteRef(token) {
    return this.withLock(async () => {
      this._loadFromDiskOrEmpty();
      if (!Object.prototype.hasOwnProperty.call(this.state.deliveryRefs, token)) return false;
      delete this.state.deliveryRefs[token];
      this.save();
      return true;
    });
  }

  // Every reference pointing at one object (used when the object is
  // deleted — a deleted object's references must stop working).
  async deleteRefsForObject(namespace, objectId) {
    return this.withLock(async () => {
      this._loadFromDiskOrEmpty();
      let removed = 0;
      for (const [token, ref] of Object.entries(this.state.deliveryRefs)) {
        if (ref.namespace === namespace && ref.objectId === objectId) {
          delete this.state.deliveryRefs[token];
          removed += 1;
        }
      }
      if (removed > 0) this.save();
      return removed;
    });
  }
}
