// NOVA Cloud Storage — integrity: corruption is detected, never silently
// served. Tests flip bytes / remove chunk files on disk, then read.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { IntegrityError } from '../../src/storage/index.js';
import { makeStorage, tempStorageRoot, deterministicStream, hashStream } from './support.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function storeTwoChunks(t) {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const record = await store.put({
    namespace: 'media',
    source: deterministicStream(5 * 1024 * 1024),
  });
  assert.equal(record.chunkCount, 2);
  return { root, store, record };
}

test('a corrupted chunk makes get() fail with IntegrityError', async (t) => {
  const { root, store, record } = await storeTwoChunks(t);
  const chunkPath = path.join(root, 'chunks', 'media', record.objectId, '1.chunk');
  const bytes = fs.readFileSync(chunkPath);
  bytes[0] = bytes[0] === 0 ? 1 : 0; // flip one byte
  fs.writeFileSync(chunkPath, bytes);
  await assert.rejects(
    hashStream(store.get({ namespace: 'media', objectId: record.objectId })),
    (err) => err instanceof IntegrityError && err.chunkIndex === 1,
  );
});

test('a corrupted chunk makes getBuffer() fail with IntegrityError', async (t) => {
  const { root, store, record } = await storeTwoChunks(t);
  const chunkPath = path.join(root, 'chunks', 'media', record.objectId, '0.chunk');
  const bytes = fs.readFileSync(chunkPath);
  bytes[100] = (bytes[100] + 1) % 256;
  fs.writeFileSync(chunkPath, bytes);
  await assert.rejects(
    store.getBuffer({ namespace: 'media', objectId: record.objectId }),
    (err) => err instanceof IntegrityError && err.chunkIndex === 0,
  );
});

test('a missing chunk file makes get() fail with IntegrityError', async (t) => {
  const { root, store, record } = await storeTwoChunks(t);
  fs.rmSync(path.join(root, 'chunks', 'media', record.objectId, '0.chunk'));
  await assert.rejects(
    hashStream(store.get({ namespace: 'media', objectId: record.objectId })),
    (err) => err instanceof IntegrityError && err.chunkIndex === 0,
  );
});

test('recorded chunk hashes match the chunk files on disk', async (t) => {
  const { root, store, record } = await storeTwoChunks(t);
  void store;
  for (let i = 0; i < record.chunkCount; i++) {
    const bytes = fs.readFileSync(path.join(root, 'chunks', 'media', record.objectId, `${i}.chunk`));
    assert.equal(sha(bytes), record.chunkHashes[i]);
  }
});

test('an uncorrupted object reads clean after the corruption tests', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({
    namespace: 'media',
    source: deterministicStream(5 * 1024 * 1024),
  });
  const readHash = await hashStream(store.get({ namespace: 'media', objectId: record.objectId }));
  assert.equal(readHash, record.hash);
});
