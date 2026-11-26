// NOVA Personal GPU Cloud — NOVA Cloud Storage: backend interface.
//
// The engine talks to storage ONLY through this interface. A backend is
// any object implementing these methods; the engine never touches a disk,
// an API, or a bucket directly. A second backend (a free-tier object
// service, our own future hardware) is an ADAPTER implementing this
// contract — never a rewrite of the engine.
//
// CONTRACT (all methods async; all chunk writes atomic — a reader never
// sees a half-written chunk):
//
//   putChunk(namespace, objectId, chunkIndex, buffer)
//     Store one chunk. Throws CapacityError (or a raw ENOSPC/EDQUOT error
//     the engine translates) when the backend is full.
//   getChunk(namespace, objectId, chunkIndex) -> Buffer
//     Read one chunk. Throws ChunkNotFoundError when it is not there.
//   chunkExists(namespace, objectId, chunkIndex) -> boolean
//   listChunks(namespace, objectId) -> number[] (sorted chunk indices)
//   deleteObjectChunks(namespace, objectId) -> boolean
//     Delete every chunk of the object. True when anything was removed.
//   capacity() -> { totalBytes, freeBytes }
//     The backend's own view of its size. NOTE: on quota-managed
//     filesystems the OS-reported free space can exceed what the process
//     may actually write (measured on this VM 24 Nov 2026: statfs said
//     ~47 GB free; the home quota stopped writes at ~4.85 GB). Backends
//     report what they can measure; the engine treats capacity as an
//     estimate and still handles ENOSPC at write time.
//
// Staging (uploads in progress — the object id is the content hash, known
// only after the last byte is read, so chunks land in staging first and
// are finalised by move/rename):
//
//   writeStagingChunk(uploadId, chunkIndex, buffer)
//   finalizeStaging(uploadId, namespace, objectId, chunkCount)
//     Move every staging chunk into its final place; verify the count.
//     After this returns, the object is readable via getChunk.
//   discardStaging(uploadId)
//     Remove the staging area (dedup hit, capacity refusal, failed put).
//   listStaleStaging(olderThanMs, now) -> string[]
//     Upload ids whose staging area is older than the threshold (crashed
//     uploads) — the sweep discards them.
//
// A backend stores CHUNKS ONLY. The metadata index (object records,
// delivery references) is the engine's own; a backend never sees it.

import { StorageValidationError } from './errors.js';

export const BACKEND_METHODS = Object.freeze([
  'putChunk',
  'getChunk',
  'chunkExists',
  'listChunks',
  'deleteObjectChunks',
  'capacity',
  'writeStagingChunk',
  'finalizeStaging',
  'discardStaging',
  'listStaleStaging',
]);

// Throws StorageValidationError listing every missing method. The engine
// runs this on construction so a half-implemented backend fails fast,
// before it stores anything.
export function assertBackend(backend) {
  if (backend === null || typeof backend !== 'object') {
    throw new StorageValidationError('backend must be an object implementing the backend interface');
  }
  const missing = BACKEND_METHODS.filter((m) => typeof backend[m] !== 'function');
  if (missing.length > 0) {
    throw new StorageValidationError(
      `backend is missing methods: ${missing.join(', ')}`,
    );
  }
  return backend;
}
