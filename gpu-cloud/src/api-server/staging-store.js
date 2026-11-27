// Staging store (Kaggle design v13 §5.7): the API-side push model for
// NEXORA keyframes. The NEXORA client PUSHES each keyframe file to the
// API (signed POST /internal/stage?jobId=) BEFORE submitting; the API
// stores it BY CONTENT HASH — never by a client-supplied name — and the
// submit re-verifies the staged hashes before BEGIN IMMEDIATE.
//
// Bounds (all enforced here, fail closed):
//   - one file: at most 10 MB (the route also checks Content-Length
//     before reading and aborts the stream at 10 MB);
//   - one jobId: at most 2 files / 20 MB;
//   - one client: at most 100 MB of UNREFERENCED files (the quarantine).
// A file leaves the quarantine only when an accepted job references it
// (releaseForJob); unreferenced files are swept after 1 h, regardless
// of halt / pause / activation. A staged file is deleted only when no
// non-terminal job references its hash — references are removed when
// the job reaches a terminal state (unreferenceJob), so the sweep can
// never delete a live job's keyframes.
//
// Layout: <dir>/<sha256> (the bytes) + <dir>/<sha256>.meta.json
// ({jobIds, keyId, size, stagedAtMs, referencedBy: [jobId...]}).
// jobIds lists every job the file was staged for (content-addressed:
// identical bytes staged for a second job are a no-op write, but the
// second job is recorded so its submit verifies); referencedBy lists
// the ACCEPTED jobs that own the file (it leaves the quarantine when
// an accepted job references it). All writes are synchronous (the API
// is single-process; a sync read-modify-write of one small meta file
// cannot interleave).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_STAGE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_STAGE_FILES_PER_JOB = 2;
export const MAX_STAGE_BYTES_PER_JOB = 20 * 1024 * 1024;
export const MAX_UNREFERENCED_BYTES_PER_CLIENT = 100 * 1024 * 1024;
export const UNREFERENCED_TTL_MS = 3600 * 1000;
export const DEFAULT_STAGING_DIR = '/var/lib/nova-api/staging';

export function sha256HexBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// -- Image verification ------------------------------------------------------
// A staged keyframe must be a decodable image, not arbitrary bytes: the
// magic bytes plus a structural walk (PNG chunk chain with CRCs, JPEG
// marker scan to EOI, WebP RIFF size, GIF trailer). No image library is
// available on the API host, so the walk is hand-rolled and strict about
// structure; it is a validity check, not a render.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function verifyPng(bytes) {
  // 8-byte signature, then chunks: length (4 BE) + type (4) + data +
  // CRC32 (4, over type + data). First chunk IHDR; the chain must end
  // at IEND with no truncation and no trailing garbage.
  if (bytes.length < 8 + 12 + 12) return false;
  let off = 8;
  let first = true;
  let sawIend = false;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('latin1', off + 4, off + 8);
    if (len > bytes.length) return false;
    if (off + 12 + len > bytes.length) return false;
    if (first && type !== 'IHDR') return false;
    first = false;
    const crc = bytes.readUInt32BE(off + 8 + len);
    if (crc32(bytes, off + 4, off + 8 + len) !== crc) return false;
    off += 12 + len;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  return sawIend && off === bytes.length;
}

function verifyJpeg(bytes) {
  // SOI (FF D8), then markers; every marker with a length field skips
  // its segment; standalone markers (RSTn, SOI, EOI, TEM) carry none.
  // Scan data (SOS) is skipped byte-by-byte (0xFF00 is an escaped FF,
  // 0xFFD9 ends the image). Must reach EOI.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let off = 2;
  while (off + 1 < bytes.length) {
    if (bytes[off] !== 0xff) return false;
    const marker = bytes[off + 1];
    if (marker === 0xd9) return true; // EOI
    if (marker === 0x00 || marker === 0xff) { off += 1; continue; }
    if (marker === 0xda) {
      // SOS: scan data until the next non-escaped marker.
      off += 2;
      while (off + 1 < bytes.length) {
        if (bytes[off] === 0xff && bytes[off + 1] !== 0x00) break;
        off += 1;
      }
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2; // standalone markers carry no length
      continue;
    }
    if (off + 4 > bytes.length) return false;
    const len = bytes.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > bytes.length) return false;
    off += 2 + len;
  }
  return false;
}

function verifyWebp(bytes) {
  if (bytes.length < 12) return false;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF') return false;
  if (bytes.toString('latin1', 8, 12) !== 'WEBP') return false;
  return bytes.readUInt32LE(4) + 8 <= bytes.length;
}

function verifyGif(bytes) {
  const header = bytes.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;
  return bytes.length > 0 && bytes[bytes.length - 1] === 0x3b;
}

export function verifyImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) {
    return { ok: false, reason: 'invalid-image' };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return verifyPng(bytes) ? { ok: true, format: 'png' } : { ok: false, reason: 'invalid-image' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return verifyJpeg(bytes) ? { ok: true, format: 'jpeg' } : { ok: false, reason: 'invalid-image' };
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return verifyWebp(bytes) ? { ok: true, format: 'webp' } : { ok: false, reason: 'invalid-image' };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return verifyGif(bytes) ? { ok: true, format: 'gif' } : { ok: false, reason: 'invalid-image' };
  }
  return { ok: false, reason: 'invalid-image' };
}

// -- The store -----------------------------------------------------------------

export class StagingStore {
  constructor({ dir = DEFAULT_STAGING_DIR, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
  }

  _filePath(hash) {
    return path.join(this.dir, hash);
  }

  _metaPath(hash) {
    return path.join(this.dir, `${hash}.meta.json`);
  }

  _readMeta(hash) {
    try {
      return JSON.parse(fs.readFileSync(this._metaPath(hash), 'utf8'));
    } catch {
      return null;
    }
  }

  _writeMeta(hash, meta) {
    const tmp = `${this._metaPath(hash)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this._metaPath(hash));
  }

  _listMetas() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const hash = name.slice(0, -'.meta.json'.length);
      const meta = this._readMeta(hash);
      if (meta) out.push({ hash, meta });
    }
    return out;
  }

  // Stage one file for a job. Verifies size, hash, and image validity
  // BEFORE writing anything; enforces the per-job and per-client
  // bounds. A re-stage of the identical file is a no-op success.
  stage({ jobId, keyId, bytes, sha256, size }) {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return { ok: false, reason: 'invalid-job-id' };
    }
    if (typeof keyId !== 'string' || keyId.length === 0) {
      return { ok: false, reason: 'invalid-key-id' };
    }
    if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'invalid-image' };
    if (typeof size !== 'number' || size !== bytes.length) {
      return { ok: false, reason: 'size-mismatch' };
    }
    if (bytes.length > MAX_STAGE_FILE_BYTES) {
      return { ok: false, reason: 'file-too-large' };
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      return { ok: false, reason: 'staging-hash-mismatch' };
    }
    const actual = sha256HexBytes(bytes);
    if (actual !== sha256.toLowerCase()) {
      return { ok: false, reason: 'staging-hash-mismatch' };
    }
    const image = verifyImageBytes(bytes);
    if (!image.ok) return { ok: false, reason: image.reason };
    const hash = actual;
    const existing = this._readMeta(hash);
    if (existing && fs.existsSync(this._filePath(hash))) {
      // Identical bytes already staged (content-addressed): a re-stage
      // writes no bytes — but the new jobId is recorded, so this job's
      // submit verifies (the file was staged for it too). The per-job
      // file bound still applies to the new job.
      const jobIds = Array.isArray(existing.jobIds) ? existing.jobIds : [];
      if (!jobIds.includes(jobId)) {
        const mine = this._listMetas().filter(({ meta }) =>
          (Array.isArray(meta.jobIds) ? meta.jobIds : []).includes(jobId));
        if (mine.length >= MAX_STAGE_FILES_PER_JOB) {
          return { ok: false, reason: 'storage-unavailable' };
        }
        jobIds.push(jobId);
        this._writeMeta(hash, { ...existing, jobIds });
      }
      return { ok: true, hash, size: bytes.length, format: image.format, alreadyStaged: true };
    }
    // Per-job bounds: 2 files / 20 MB staged for this jobId.
    const jobFiles = this._listMetas().filter(({ meta }) =>
      (Array.isArray(meta.jobIds) ? meta.jobIds : []).includes(jobId));
    if (jobFiles.length >= MAX_STAGE_FILES_PER_JOB) {
      return { ok: false, reason: 'storage-unavailable' };
    }
    const jobBytes = jobFiles.reduce((n, { meta }) => n + (meta.size || 0), 0);
    if (jobBytes + bytes.length > MAX_STAGE_BYTES_PER_JOB) {
      return { ok: false, reason: 'storage-unavailable' };
    }
    // Per-client unreferenced quarantine: 100 MB.
    const unref = this._listMetas()
      .filter(({ meta }) => meta.keyId === keyId && (meta.referencedBy?.length ?? 0) === 0)
      .reduce((n, { meta }) => n + (meta.size || 0), 0);
    if (unref + bytes.length > MAX_UNREFERENCED_BYTES_PER_CLIENT) {
      return { ok: false, reason: 'storage-unavailable' };
    }
    // Atomic write: temp file + rename, so a crash never leaves a
    // half-written staged file under its hash.
    const tmp = path.join(this.dir, `.tmp-${hash}-${process.pid}`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this._filePath(hash));
    this._writeMeta(hash, {
      jobIds: [jobId],
      keyId,
      size: bytes.length,
      format: image.format,
      stagedAtMs: this.now(),
      referencedBy: [],
    });
    return { ok: true, hash, size: bytes.length, format: image.format, alreadyStaged: false };
  }

  // The submit re-verifies staged hashes before BEGIN IMMEDIATE: every
  // hash the payload claims must have a staged file, staged for THIS
  // jobId. Missing or wrong-job → 400 staging-failed /
  // keyframe-hash-mismatch (the payload claims bytes the API never
  // received for this job).
  verifyStagedForJob(jobId, hashes) {
    for (const hash of hashes) {
      const meta = typeof hash === 'string' ? this._readMeta(hash.toLowerCase()) : null;
      if (!meta || !fs.existsSync(this._filePath(hash.toLowerCase()))) {
        return { ok: false, status: 400, error: 'staging-failed', reason: 'keyframe-hash-mismatch' };
      }
      const jobIds = Array.isArray(meta.jobIds) ? meta.jobIds : [];
      if (!jobIds.includes(jobId)) {
        return { ok: false, status: 400, error: 'staging-failed', reason: 'keyframe-hash-mismatch' };
      }
    }
    return { ok: true };
  }

  // An accepted job references its staged files: they leave the
  // quarantine (they no longer count against the 100 MB) and the sweep
  // will never delete them while referenced.
  releaseForJob(jobId, hashes) {
    for (const hash of hashes) {
      const h = String(hash).toLowerCase();
      const meta = this._readMeta(h);
      if (!meta || !fs.existsSync(this._filePath(h))) continue;
      if (!meta.referencedBy.includes(jobId)) {
        meta.referencedBy.push(jobId);
        this._writeMeta(h, meta);
      }
    }
  }

  // A terminal job releases its references; the sweep may then delete
  // the files once they age out. (A file is deleted only when NO
  // non-terminal job references it — the reference list IS that check.)
  unreferenceJob(jobId) {
    for (const { hash, meta } of this._listMetas()) {
      if (!meta.referencedBy.includes(jobId)) continue;
      meta.referencedBy = meta.referencedBy.filter((j) => j !== jobId);
      this._writeMeta(hash, meta);
    }
  }

  referencedHashes(jobId) {
    return this._listMetas()
      .filter(({ meta }) => meta.referencedBy.includes(jobId))
      .map(({ hash }) => hash);
  }

  // Absolute path of a staged file (for the executor to read), or null.
  pathFor(hash) {
    const h = String(hash).toLowerCase();
    const p = this._filePath(h);
    return fs.existsSync(p) ? p : null;
  }

  // Delete unreferenced files staged more than 1 h ago — regardless of
  // halt / pause / activation. Referenced files are never touched, and
  // neither are fresh ones. Also drops orphaned metas / files.
  sweepUnreferenced(nowMs = this.now()) {
    let deleted = 0;
    let bytesFreed = 0;
    for (const { hash, meta } of this._listMetas()) {
      const referenced = (meta.referencedBy?.length ?? 0) > 0;
      const stale = (nowMs - (meta.stagedAtMs ?? 0)) > UNREFERENCED_TTL_MS;
      const fileExists = fs.existsSync(this._filePath(hash));
      if (!referenced && (stale || !fileExists)) {
        try { fs.unlinkSync(this._filePath(hash)); } catch { /* already gone */ }
        try { fs.unlinkSync(this._metaPath(hash)); } catch { /* already gone */ }
        deleted += 1;
        bytesFreed += meta.size || 0;
      }
    }
    // Files with no meta at all are orphans: remove them (never a live
    // job's file — every staged file gets its meta in the same call).
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.endsWith('.meta.json') || name.startsWith('.tmp-')) continue;
      if (!fs.existsSync(this._metaPath(name))) {
        try {
          const st = fs.statSync(this._filePath(name));
          fs.unlinkSync(this._filePath(name));
          deleted += 1;
          bytesFreed += st.size;
        } catch { /* already gone */ }
      }
    }
    return { deleted, bytesFreed };
  }

  stats() {
    const metas = this._listMetas();
    const unreferencedBytes = metas
      .filter(({ meta }) => (meta.referencedBy?.length ?? 0) === 0)
      .reduce((n, { meta }) => n + (meta.size || 0), 0);
    return {
      files: metas.length,
      bytes: metas.reduce((n, { meta }) => n + (meta.size || 0), 0),
      unreferencedBytes,
    };
  }
}
