// NOVA Cloud Storage — expiry: the 24-hour rule for generated outputs.
// A user has 24 hours from generation to download; after that the manager
// deletes the content automatically. Models, system files and small
// records persist.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  GENERATED_CONTENT_TTL_MS,
  ObjectNotFoundError,
  DeliveryRefError,
  StorageValidationError,
} from '../../src/storage/index.js';
import { makeStorage, fakeClock, tempStorageRoot, sleep } from './support.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

test('an output 23h59m old survives the sweep', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'media', source: Buffer.from('fresh clip') });
  clock.advance(GENERATED_CONTENT_TTL_MS - MINUTE_MS);
  const report = await store.sweep();
  assert.equal(report.deleted, 0);
  assert.notEqual(store.head({ namespace: 'media', objectId: record.objectId }), null);
  assert.deepEqual(
    await store.getBuffer({ namespace: 'media', objectId: record.objectId }),
    Buffer.from('fresh clip'),
  );
});

test('an output 24h01m old is deleted by the sweep, for real', async (t) => {
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const clock = fakeClock();
  const store = createStorage({ rootDir: root, clock: clock.now });
  const record = await store.put({ namespace: 'media', source: Buffer.from('old clip') });
  const objectDir = path.join(root, 'chunks', 'media', record.objectId);
  assert.equal(fs.existsSync(objectDir), true);
  clock.advance(GENERATED_CONTENT_TTL_MS + MINUTE_MS);
  const report = await store.sweep();
  assert.equal(report.deleted, 1);
  assert.equal(report.bytesFreed, 8);
  assert.deepEqual(report.deletedIds, [`media/${record.objectId}`]);
  assert.equal(fs.existsSync(objectDir), false);
  assert.equal(store.head({ namespace: 'media', objectId: record.objectId }), null);
  assert.equal(store.usage().totalObjects, 0);
});

test('a delivery reference stops working once its object is swept', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'outputs', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({ namespace: 'outputs', objectId: record.objectId });
  clock.advance(GENERATED_CONTENT_TTL_MS + MINUTE_MS);
  await store.sweep();
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof DeliveryRefError && err.reason === 'unknown',
  );
});

test('a model file older than 24h is untouched by the sweep', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'models', source: Buffer.from('weights') });
  clock.advance(48 * HOUR_MS);
  const report = await store.sweep();
  assert.equal(report.deleted, 0);
  assert.deepEqual(
    await store.getBuffer({ namespace: 'models', objectId: record.objectId }),
    Buffer.from('weights'),
  );
});

test('a persistent override on a media object survives past 24h', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({
    namespace: 'media',
    source: Buffer.from('kept clip'),
    retention: 'persistent',
  });
  clock.advance(7 * 24 * HOUR_MS);
  assert.equal((await store.sweep()).deleted, 0);
  assert.notEqual(store.head({ namespace: 'media', objectId: record.objectId }), null);
});

test('a custom short transient TTL is honoured', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({
    namespace: 'jobs',
    source: Buffer.from('working file'),
    retention: 'transient',
    ttlMs: 1000,
  });
  assert.equal(record.expiresAt, clock.now() + 1000);
  clock.advance(2000);
  assert.equal((await store.sweep()).deleted, 1);
  assert.equal(store.head({ namespace: 'jobs', objectId: record.objectId }), null);
});

test('lazy expiry: get() on an expired object fails without deleting it; the sweep removes it', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'text', source: Buffer.from('generated text') });
  clock.advance(GENERATED_CONTENT_TTL_MS + 1);
  await assert.rejects(
    store.getBuffer({ namespace: 'text', objectId: record.objectId }),
    (err) => err instanceof ObjectNotFoundError && err.reason === 'expired',
  );
  assert.equal(store.head({ namespace: 'text', objectId: record.objectId }), null);
  // Finding 10A: the read path treats the expired object as unavailable
  // WITHOUT physically deleting it — the index record (and chunks) stay
  // until a sweep removes them. A lazy read must never delete.
  assert.equal(store.usage().totalObjects, 1);
  const report = await store.sweep();
  assert.equal(report.deleted, 1);
  assert.equal(store.usage().totalObjects, 0);
});

test('the sweep discards crashed staging areas older than an hour', async (t) => {
  // Real clock: staging mtimes are real filesystem times.
  const root = tempStorageRoot(t);
  const { createStorage } = await import('../../src/storage/index.js');
  const store = createStorage({ rootDir: root });
  const staleDir = path.join(root, '.staging', 'up_crashed');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, '0.chunk'), Buffer.from('orphan'));
  const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
  fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);
  const freshDir = path.join(root, '.staging', 'up_live');
  fs.mkdirSync(freshDir, { recursive: true });
  fs.writeFileSync(path.join(freshDir, '0.chunk'), Buffer.from('in-flight'));
  const report = await store.sweep();
  assert.equal(report.stagingCleaned, 1);
  assert.equal(fs.existsSync(staleDir), false);
  assert.equal(fs.existsSync(freshDir), true);
});

test('the sweep timer deletes expired objects on schedule', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({
    namespace: 'outputs',
    source: Buffer.from('short-lived'),
    retention: 'transient',
    ttlMs: 100,
  });
  store.startSweepTimer(50);
  t.after(() => store.stopSweepTimer());
  await sleep(400);
  assert.equal(store.head({ namespace: 'outputs', objectId: record.objectId }), null);
  store.stopSweepTimer();
});

test('starting the sweep timer twice is rejected', async (t) => {
  const store = makeStorage(t);
  store.startSweepTimer(60_000);
  t.after(() => store.stopSweepTimer());
  assert.throws(() => store.startSweepTimer(60_000), StorageValidationError);
  store.stopSweepTimer();
});
