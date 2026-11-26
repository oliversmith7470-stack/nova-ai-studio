// NOVA Cloud Storage — usage accounting + capacity.
//
// No artificial caps: the engine enforces no per-object or per-namespace
// limit. Usage accounting REPORTS bytes per namespace; capacity() reports
// the backend's physical room; a put that cannot fit fails whole with
// CapacityError and leaves no partial object.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { CapacityError } from '../../src/storage/index.js';
import { makeStorage, tempStorageRoot } from './support.mjs';

test('usage accounting is exact per namespace and in total', async (t) => {
  const store = makeStorage(t);
  await store.put({ namespace: 'media', source: Buffer.alloc(100) });
  await store.put({ namespace: 'media', source: Buffer.alloc(50) });
  await store.put({ namespace: 'models', source: Buffer.alloc(1000) });
  const usage = store.usage();
  assert.equal(usage.totalBytes, 1150);
  assert.equal(usage.totalObjects, 3);
  assert.deepEqual(usage.namespaces.media, { bytes: 150, objects: 2 });
  assert.deepEqual(usage.namespaces.models, { bytes: 1000, objects: 1 });
});

test('usage drops after a delete', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.alloc(200) });
  await store.put({ namespace: 'media', source: Buffer.alloc(100) });
  await store.delete('media', record.objectId);
  assert.deepEqual(store.usage().namespaces.media, { bytes: 100, objects: 1 });
});

test('dedup does not double-count usage', async (t) => {
  const store = makeStorage(t);
  const data = Buffer.alloc(64, 7);
  await store.put({ namespace: 'text', source: data });
  await store.put({ namespace: 'text', source: data });
  await store.put({ namespace: 'text', source: data });
  assert.equal(store.usage().totalBytes, 64);
  assert.equal(store.usage().totalObjects, 1);
});

test('capacity() reports the backend numbers plus what the store holds', async (t) => {
  const store = makeStorage(t);
  await store.put({ namespace: 'media', source: Buffer.alloc(128) });
  const cap = await store.capacity();
  assert.ok(cap.totalBytes > 0);
  assert.ok(cap.freeBytes >= 0);
  assert.equal(cap.storeBytes, 128);
  assert.equal(cap.storeObjects, 1);
  assert.equal(cap.headroomBytes, cap.freeBytes);
  assert.equal(cap.usedBytes, cap.totalBytes - cap.freeBytes);
});

test('a known-size put over the reported capacity fails whole (CapacityError)', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({
    rootDir: root,
    capacityProbe: async () => ({ totalBytes: 1000, freeBytes: 100 }),
  });
  await assert.rejects(
    store.put({ namespace: 'media', source: Buffer.alloc(1024) }),
    CapacityError,
  );
  assert.equal(store.usage().totalObjects, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'chunks')), []);
});

test('a streamed put over the reported capacity fails whole (no partial object)', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({
    rootDir: root,
    capacityProbe: async () => ({ totalBytes: 1000, freeBytes: 100 }),
  });
  await assert.rejects(
    store.put({ namespace: 'media', source: Readable.from([Buffer.alloc(1024)]) }),
    CapacityError,
  );
  assert.equal(store.usage().totalObjects, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'chunks')), []);
});

test('an unmeasurable backend does not block a put (the write is the real test)', async (t) => {
  const store = makeStorage(t, {
    capacityProbe: async () => {
      throw new Error('probe unavailable');
    },
  });
  const record = await store.put({ namespace: 'media', source: Buffer.from('goes through') });
  assert.deepEqual(
    await store.getBuffer({ namespace: 'media', objectId: record.objectId }),
    Buffer.from('goes through'),
  );
});
