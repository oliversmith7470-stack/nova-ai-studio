// NOVA Cloud Storage — chunking: multi-hundred-MB streamed upload,
// chunk boundaries, chunk-size override, on-disk layout.
//
// The 256 MiB test stores real bytes under test/storage/.tmp/ (home
// filesystem, not the 512 MB /tmp tmpfs) and removes them in t.after().

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeStorage, tempStorageRoot, deterministicStream, hashDeterministic, hashStream } from './support.mjs';

const MIB = 1024 * 1024;

test('256 MiB streamed upload: 64 chunks, integrity verified on read', async (t) => {
  const store = makeStorage(t);
  const totalBytes = 256 * MIB;
  const expectedHash = await hashDeterministic(totalBytes);
  const record = await store.put({
    namespace: 'media',
    source: deterministicStream(totalBytes),
    contentType: 'video/mp4',
  });
  assert.equal(record.sizeBytes, totalBytes);
  assert.equal(record.chunkCount, 64);
  assert.equal(record.chunkSizeBytes, 4 * MIB);
  assert.equal(record.hash, expectedHash);
  assert.equal(record.chunkHashes.length, 64);
  const readHash = await hashStream(store.get({ namespace: 'media', objectId: record.objectId }));
  assert.equal(readHash, expectedHash);
});

test('exact multiple of the chunk size leaves no empty trailing chunk', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({
    namespace: 'outputs',
    source: deterministicStream(8 * MIB),
  });
  assert.equal(record.chunkCount, 2);
  assert.equal(record.chunkHashes.length, 2);
  const readHash = await hashStream(store.get({ namespace: 'outputs', objectId: record.objectId }));
  assert.equal(readHash, await hashDeterministic(8 * MIB));
});

test('partial last chunk holds only the remaining bytes', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const record = await store.put({
    namespace: 'outputs',
    source: deterministicStream(4 * MIB + 123),
  });
  assert.equal(record.chunkCount, 2);
  const lastChunk = path.join(root, 'chunks', 'outputs', record.objectId, '1.chunk');
  assert.equal(fs.statSync(lastChunk).size, 123);
  const firstChunk = path.join(root, 'chunks', 'outputs', record.objectId, '0.chunk');
  assert.equal(fs.statSync(firstChunk).size, 4 * MIB);
});

test('chunk size override is honoured', async (t) => {
  const store = makeStorage(t, { chunkSizeBytes: 1 * MIB });
  const record = await store.put({
    namespace: 'models',
    source: deterministicStream(8 * MIB),
  });
  assert.equal(record.chunkCount, 8);
  assert.equal(record.chunkSizeBytes, 1 * MIB);
  const readHash = await hashStream(store.get({ namespace: 'models', objectId: record.objectId }));
  assert.equal(readHash, await hashDeterministic(8 * MIB));
});

test('small file is a single chunk', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'text', source: Buffer.from('tiny') });
  assert.equal(record.chunkCount, 1);
  assert.equal(record.chunkHashes.length, 1);
});

test('chunk files live at the documented layout', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const record = await store.put({
    namespace: 'jobs',
    source: deterministicStream(5 * MIB),
  });
  assert.equal(fs.existsSync(path.join(root, 'chunks', 'jobs', record.objectId, '0.chunk')), true);
  assert.equal(fs.existsSync(path.join(root, 'chunks', 'jobs', record.objectId, '1.chunk')), true);
  assert.equal(fs.existsSync(path.join(root, 'index.json')), true);
});
