// NOVA Personal GPU Cloud — NOVA Cloud Storage: local filesystem backend.
//
// The first backend: plain files on this machine. It proves the engine
// today with zero dependencies, zero accounts and zero cost.
//
// Layout under the root directory:
//   chunks/<namespace>/<objectId>/<index>.chunk   — final chunk files
//   .staging/<uploadId>/<index>.chunk             — uploads in progress
//   (the metadata index lives beside these, owned by the engine, not here)
//
// Chunk writes are atomic (write temp file in the same directory, fsync,
// rename over the target). Finalise is a rename within the same
// filesystem, so it needs no additional space.
//
// HONEST LIMITS (see docs/storage/design.md for the measured numbers):
//   - Single machine, no replication. A disk failure loses what only
//     lives here. This backend is the proof and the development store,
//     not yet the durable home for NOVA's content.
//   - capacity() reports the OS view (statfs). On this VM the home
//     directory is quota-managed, and the quota headroom is far below the
//     device free space — the engine therefore treats capacity as an
//     estimate and handles ENOSPC/EDQUOT at write time.

import fs from 'node:fs';
import path from 'node:path';
import { ChunkNotFoundError } from './errors.js';

// Identifiers that become path components must be inert (no traversal).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(value, what) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.includes('..')) {
    throw new Error(`unsafe ${what}: ${String(value)}`);
  }
}

function assertChunkIndex(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid chunk index: ${String(index)}`);
  }
}

export class LocalBackend {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new Error('LocalBackend requires a rootDir');
    }
    this.rootDir = rootDir;
    this.chunksDir = path.join(rootDir, 'chunks');
    this.stagingDir = path.join(rootDir, '.staging');
    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  chunkPath(namespace, objectId, chunkIndex) {
    assertSafeId(namespace, 'namespace');
    assertSafeId(objectId, 'objectId');
    assertChunkIndex(chunkIndex);
    return path.join(this.chunksDir, namespace, objectId, `${chunkIndex}.chunk`);
  }

  stagingChunkPath(uploadId, chunkIndex) {
    assertSafeId(uploadId, 'uploadId');
    assertChunkIndex(chunkIndex);
    return path.join(this.stagingDir, uploadId, `${chunkIndex}.chunk`);
  }

  // Atomic chunk write: temp file + fsync + rename. A crash leaves the
  // old chunk or the new chunk, never a half-written one.
  writeFileAtomic(filePath, buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  async putChunk(namespace, objectId, chunkIndex, buffer) {
    this.writeFileAtomic(this.chunkPath(namespace, objectId, chunkIndex), buffer);
  }

  async getChunk(namespace, objectId, chunkIndex) {
    try {
      return fs.readFileSync(this.chunkPath(namespace, objectId, chunkIndex));
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new ChunkNotFoundError(namespace, objectId, chunkIndex);
      }
      throw err;
    }
  }

  async chunkExists(namespace, objectId, chunkIndex) {
    return fs.existsSync(this.chunkPath(namespace, objectId, chunkIndex));
  }

  async listChunks(namespace, objectId) {
    assertSafeId(namespace, 'namespace');
    assertSafeId(objectId, 'objectId');
    const dir = path.join(this.chunksDir, namespace, objectId);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((e) => /^\d+\.chunk$/.test(e))
      .map((e) => Number(e.slice(0, -'.chunk'.length)))
      .sort((a, b) => a - b);
  }

  async deleteObjectChunks(namespace, objectId) {
    assertSafeId(namespace, 'namespace');
    assertSafeId(objectId, 'objectId');
    const dir = path.join(this.chunksDir, namespace, objectId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async capacity() {
    const s = fs.statfsSync(this.rootDir);
    return {
      totalBytes: s.blocks * s.bsize,
      // bavail: blocks available to an unprivileged process. On a
      // quota-managed filesystem this can still overstate what this
      // process may write — see the module header.
      freeBytes: s.bavail * s.bsize,
    };
  }

  async writeStagingChunk(uploadId, chunkIndex, buffer) {
    this.writeFileAtomic(this.stagingChunkPath(uploadId, chunkIndex), buffer);
  }

  async finalizeStaging(uploadId, namespace, objectId, chunkCount) {
    assertSafeId(uploadId, 'uploadId');
    const staging = path.join(this.stagingDir, uploadId);
    const target = path.join(this.chunksDir, namespace, objectId);
    // Verify every chunk is present before moving anything.
    for (let i = 0; i < chunkCount; i++) {
      if (!fs.existsSync(path.join(staging, `${i}.chunk`))) {
        throw new ChunkNotFoundError(namespace, objectId, i);
      }
    }
    fs.mkdirSync(target, { recursive: true });
    for (let i = 0; i < chunkCount; i++) {
      fs.renameSync(path.join(staging, `${i}.chunk`), path.join(target, `${i}.chunk`));
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }

  async discardStaging(uploadId) {
    assertSafeId(uploadId, 'uploadId');
    fs.rmSync(path.join(this.stagingDir, uploadId), { recursive: true, force: true });
  }

  async listStaleStaging(olderThanMs, now) {
    let entries;
    try {
      entries = fs.readdirSync(this.stagingDir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const stale = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.stagingDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch (err) {
        // A concurrent API write can complete (and remove its staging
        // dir) between readdir and stat. A vanished dir is not stale —
        // skip it instead of failing the whole sweep (10C race, found
        // 27 Nov 2026 during the be69bc4 verification).
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (now - stat.mtimeMs > olderThanMs) stale.push(entry.name);
    }
    return stale;
  }
}
