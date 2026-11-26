// NOVA Cloud Storage — engine: put/get/head/delete round-trip, dedup,
// namespaces, validation.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  NamespaceError,
  ObjectNotFoundError,
  StorageValidationError,
  GENERATED_CONTENT_TTL_MS,
} from '../../src/storage/index.js';
import { makeStorage, fakeClock, tempStorageRoot } from './support.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('put/getBuffer round-trip returns the same bytes + a full record', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const data = Buffer.from('hello nova storage');
  const record = await store.put({ namespace: 'text', source: data, contentType: 'text/plain', jobId: 'job_1' });
  assert.equal(record.objectId, sha(data));
  assert.equal(record.hash, sha(data));
  assert.equal(record.sizeBytes, data.length);
  assert.equal(record.chunkCount, 1);
  assert.equal(record.contentType, 'text/plain');
  assert.equal(record.jobId, 'job_1');
  assert.equal(record.namespace, 'text');
  assert.equal(record.retentionPolicy, 'transient');
  assert.equal(record.ttlMs, GENERATED_CONTENT_TTL_MS);
  assert.equal(record.expiresAt, clock.now() + GENERATED_CONTENT_TTL_MS);
  assert.equal(record.deduplicated, false);
  const out = await store.getBuffer({ namespace: 'text', objectId: record.objectId });
  assert.deepEqual(out, data);
});

test('put accepts a file path source', async (t) => {
  const store = makeStorage(t);
  const dir = tempStorageRoot(t);
  const file = path.join(dir, 'input.bin');
  const data = Buffer.from('file-path source bytes');
  fs.writeFileSync(file, data);
  const record = await store.put({ namespace: 'jobs', source: file });
  assert.equal(record.objectId, sha(data));
  assert.deepEqual(await store.getBuffer({ namespace: 'jobs', objectId: record.objectId }), data);
});

test('put accepts a stream source', async (t) => {
  const store = makeStorage(t);
  const data = Buffer.from('streamed bytes in two pieces');
  const stream = Readable.from([data.subarray(0, 10), data.subarray(10)]);
  const record = await store.put({ namespace: 'projects', source: stream });
  assert.equal(record.objectId, sha(data));
  assert.deepEqual(await store.getBuffer({ namespace: 'projects', objectId: record.objectId }), data);
});

test('head returns metadata without bytes; null when missing', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip-bytes') });
  const head = store.head({ namespace: 'media', objectId: record.objectId });
  assert.equal(head.objectId, record.objectId);
  assert.equal(head.sizeBytes, 10);
  assert.equal(store.head({ namespace: 'media', objectId: 'nope'.padEnd(64, '0') }), null);
});

test('delete removes the object for real (chunks + record)', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const record = await store.put({ namespace: 'outputs', source: Buffer.from('to-delete') });
  const objectDir = path.join(root, 'chunks', 'outputs', record.objectId);
  assert.equal(fs.existsSync(objectDir), true);
  assert.equal(await store.delete('outputs', record.objectId), true);
  assert.equal(fs.existsSync(objectDir), false);
  assert.equal(store.head({ namespace: 'outputs', objectId: record.objectId }), null);
  await assert.rejects(
    store.getBuffer({ namespace: 'outputs', objectId: record.objectId }),
    ObjectNotFoundError,
  );
  assert.equal(await store.delete('outputs', record.objectId), false);
  assert.equal(store.usage().totalObjects, 0);
});

test('dedup: same bytes in the same namespace are stored once', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const data = Buffer.from('identical bytes');
  const first = await store.put({ namespace: 'media', source: data });
  const second = await store.put({ namespace: 'media', source: data });
  assert.equal(second.objectId, first.objectId);
  assert.equal(second.deduplicated, true);
  const usage = store.usage();
  assert.equal(usage.totalObjects, 1);
  assert.equal(usage.totalBytes, data.length);
  const objectDirs = fs.readdirSync(path.join(root, 'chunks', 'media'));
  assert.equal(objectDirs.length, 1);
  const staging = fs.readdirSync(path.join(root, '.staging'));
  assert.equal(staging.length, 0);
});

test('same bytes in two namespaces are two objects (retention differs)', async (t) => {
  const store = makeStorage(t);
  const data = Buffer.from('shared bytes');
  const a = await store.put({ namespace: 'media', source: data });
  const b = await store.put({ namespace: 'models', source: data });
  assert.equal(a.objectId, b.objectId);
  assert.equal(store.usage().totalObjects, 2);
  assert.equal(store.usage().totalBytes, data.length * 2);
});

test('unknown namespace is rejected', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    store.put({ namespace: 'nope', source: Buffer.from('x') }),
    NamespaceError,
  );
  assert.throws(() => store.head({ namespace: 'nope', objectId: 'x' }), NamespaceError);
});

test('get on a missing object throws ObjectNotFoundError', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    store.getBuffer({ namespace: 'media', objectId: 'a'.repeat(64) }),
    (err) => err instanceof ObjectNotFoundError && err.reason === 'missing',
  );
});

test('empty object round-trips (0 bytes, 0 chunks)', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'text', source: Buffer.alloc(0) });
  assert.equal(record.sizeBytes, 0);
  assert.equal(record.chunkCount, 0);
  assert.equal(record.objectId, sha(Buffer.alloc(0)));
  const out = await store.getBuffer({ namespace: 'text', objectId: record.objectId });
  assert.equal(out.length, 0);
});

test('models namespace records are persistent (no expiry)', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'models', source: Buffer.from('weights-bytes') });
  assert.equal(record.retentionPolicy, 'persistent');
  assert.equal(record.expiresAt, null);
  assert.equal(record.ttlMs, null);
});

test('per-object persistent override on a transient namespace', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({
    namespace: 'text',
    source: Buffer.from('a prompt, not an output'),
    retention: 'persistent',
  });
  assert.equal(record.retentionPolicy, 'persistent');
  assert.equal(record.expiresAt, null);
});

test('invalid retention value is rejected', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    store.put({ namespace: 'media', source: Buffer.from('x'), retention: 'forever-ish' }),
    StorageValidationError,
  );
});

test('invalid source type is rejected', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    store.put({ namespace: 'media', source: 42 }),
    StorageValidationError,
  );
  await assert.rejects(
    store.put({ namespace: 'media', source: '/does/not/exist.bin' }),
    StorageValidationError,
  );
});

test('get streams chunks (Readable) without loading the object', async (t) => {
  const store = makeStorage(t);
  const data = Buffer.from('streamed read');
  const record = await store.put({ namespace: 'media', source: data });
  const stream = store.get({ namespace: 'media', objectId: record.objectId });
  const parts = [];
  for await (const piece of stream) parts.push(piece);
  assert.deepEqual(Buffer.concat(parts), data);
});
