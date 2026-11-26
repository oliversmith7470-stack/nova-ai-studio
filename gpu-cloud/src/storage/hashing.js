// NOVA Personal GPU Cloud — NOVA Cloud Storage: hashing.
//
// One hash function for the whole store: SHA-256, hex-encoded.
//  - The CONTENT hash is the object's identity (content addressing): the
//    same bytes in the same namespace are the same object, stored once.
//  - Each CHUNK has its own hash, recorded in the metadata index, so a
//    read can verify every chunk as it streams and detect corruption
//    instead of silently serving bad bytes.

import { createHash } from 'node:crypto';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Incremental hasher for streaming: feed chunks as they arrive, digest at
// the end. The engine hashes the content hash this way so a 10 GB object
// never sits in memory whole.
export function createHasher() {
  const hash = createHash('sha256');
  return {
    update(buffer) {
      hash.update(buffer);
    },
    digest() {
      return hash.digest('hex');
    },
  };
}
