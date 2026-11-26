// NOVA Personal GPU Cloud — storage wiring integration tests.
//
// The manager ↔ cloud-store connection (24 Nov 2026): createGpuCloud()
// wires a live NovaStorage into the manager, and the manager exposes
// store/retrieve operations for job outputs (storeJobOutput /
// getJobOutput / headJobOutput / issueJobDeliveryRef / deleteJobOutput)
// plus usage, capacity, the manual sweep and the sweep timer.
//
// Every test uses a temp store root (makeCloud) — tests NEVER write to
// the live gpu-cloud/data/store/. All test data is synthetic bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeCloud } from './stage2-support.mjs';
import { makeManager, fakeClock } from './support.mjs';
import { DEFAULT_STORAGE_ROOT_DIR } from '../src/setup.js';
import { GENERATED_CONTENT_TTL_MS } from '../src/storage/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function submitTestJob(manager, key) {
  return manager.submit({
    idempotencyKey: key,
    type: 'video',
    modelId: 'mock-video-v1',
    prompt: 'storage wiring test video',
  });
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('createGpuCloud wires a live NovaStorage into the manager', (t) => {
  const cloud = makeCloud(t);
  assert.ok(cloud.storage, 'cloud exposes storage');
  assert.equal(cloud.manager.storage, cloud.storage, 'manager holds the same instance');
  assert.equal(cloud.storage.rootDir, cloud.storageRootDir);
  assert.ok(fs.existsSync(path.join(cloud.storageRootDir, 'chunks')), 'chunks dir created');
  assert.ok(fs.existsSync(path.join(cloud.storageRootDir, '.staging')), 'staging dir created');
  // The default live home is gpu-cloud/data/store/ (checked as a value —
  // tests never instantiate a cloud at the default root).
  assert.ok(
    DEFAULT_STORAGE_ROOT_DIR.endsWith(path.join('gpu-cloud', 'data', 'store')),
    `default root is gpu-cloud/data/store, got ${DEFAULT_STORAGE_ROOT_DIR}`,
  );
});

test('manager -> store round-trip: store, retrieve byte-identical, head, usage', async (t) => {
  const cloud = makeCloud(t);
  const { job } = submitTestJob(cloud.manager, 'key-store-1');
  const bytes = Buffer.from('nova-storage-wiring-proof-bytes');
  const expectedHash = sha256Hex(bytes);

  const record = await cloud.manager.storeJobOutput(job.id, {
    source: bytes,
    contentType: 'video/mp4',
  });
  assert.equal(record.namespace, 'outputs');
  assert.equal(record.objectId, expectedHash, 'content addressing: id IS the hash');
  assert.equal(record.sizeBytes, bytes.length);
  assert.equal(record.retentionPolicy, 'transient');
  assert.equal(record.expiresAt, record.createdAt + GENERATED_CONTENT_TTL_MS, '24h TTL');

  // The job record holds the reference only — never media bytes.
  const stored = cloud.manager.getJob(job.id);
  assert.deepEqual(stored.outputRef, {
    namespace: 'outputs',
    objectId: expectedHash,
    sizeBytes: bytes.length,
    contentType: 'video/mp4',
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });

  const retrieved = await cloud.manager.getJobOutputBuffer(job.id);
  assert.ok(Buffer.compare(retrieved, bytes) === 0, 'retrieved bytes identical');
  assert.equal(sha256Hex(retrieved), expectedHash);

  const head = cloud.manager.headJobOutput(job.id);
  assert.equal(head.objectId, expectedHash);
  assert.equal(head.sizeBytes, bytes.length);

  const usage = cloud.manager.storageUsage();
  assert.equal(usage.totalObjects, 1);
  assert.equal(usage.totalBytes, bytes.length);
  assert.equal(usage.namespaces.outputs.bytes, bytes.length);
  assert.equal(usage.namespaces.outputs.objects, 1);
});

test('file-path source stores and retrieves byte-identical (the live-test shape)', async (t) => {
  const cloud = makeCloud(t);
  const { job } = submitTestJob(cloud.manager, 'key-store-2');
  const filePath = path.join(cloud.dir, 'source.bin');
  const bytes = Buffer.alloc(1024, 0xab);
  fs.writeFileSync(filePath, bytes);

  const record = await cloud.manager.storeJobOutput(job.id, {
    source: filePath,
    contentType: 'video/mp4',
  });
  assert.equal(record.sizeBytes, 1024);
  const retrieved = await cloud.manager.getJobOutputBuffer(job.id);
  assert.ok(Buffer.compare(retrieved, bytes) === 0);
  // The source file is untouched (put only reads).
  assert.ok(fs.existsSync(filePath), 'source file still in place');
  assert.equal(fs.readFileSync(filePath).length, 1024);
});

test('delivery ref: issued, stored as resultRef, redeemed, dies with the object', async (t) => {
  const cloud = makeCloud(t);
  const { job } = submitTestJob(cloud.manager, 'key-store-3');
  const bytes = Buffer.from('delivery-ref-test');
  await cloud.manager.storeJobOutput(job.id, { source: bytes });

  const ref = await cloud.manager.issueJobDeliveryRef(job.id);
  assert.ok(ref.ref.startsWith('nova://delivery/'), 'opaque nova:// reference');
  assert.equal(cloud.manager.getJob(job.id).resultRef, ref.ref, 'resultRef holds the ref, not bytes');

  const redeemed = await cloud.storage.redeemDeliveryRef(ref.ref);
  assert.equal(redeemed.objectId, sha256Hex(bytes));
  assert.equal(redeemed.record.sizeBytes, bytes.length);

  const removed = await cloud.manager.deleteJobOutput(job.id);
  assert.equal(removed, true);
  assert.equal(cloud.manager.getJob(job.id).outputRef, null);
  assert.equal(cloud.manager.getJob(job.id).resultRef, null);
  await assert.rejects(
    () => cloud.storage.redeemDeliveryRef(ref.ref),
    (err) => err.name === 'DeliveryRefError',
    'reference to a deleted object fails',
  );
  assert.equal(cloud.manager.headJobOutput(job.id), null);
});

test('retention defaults through the manager: outputs 24h, models persistent', async (t) => {
  const cloud = makeCloud(t);
  const { job: videoJob } = submitTestJob(cloud.manager, 'key-store-4a');
  const { job: modelJob } = submitTestJob(cloud.manager, 'key-store-4b');

  const out = await cloud.manager.storeJobOutput(videoJob.id, {
    source: Buffer.from('generated'),
  });
  assert.equal(out.retentionPolicy, 'transient');
  assert.equal(out.expiresAt, out.createdAt + GENERATED_CONTENT_TTL_MS);

  const model = await cloud.manager.storeJobOutput(modelJob.id, {
    namespace: 'models',
    source: Buffer.from('weights'),
  });
  assert.equal(model.retentionPolicy, 'persistent');
  assert.equal(model.expiresAt, null, 'models never expire');

  // Per-object override: a persistent prompt in the transient text namespace.
  const { job: textJob } = submitTestJob(cloud.manager, 'key-store-4c');
  const text = await cloud.manager.storeJobOutput(textJob.id, {
    namespace: 'text',
    source: Buffer.from('a prompt, kept'),
    retention: 'persistent',
  });
  assert.equal(text.expiresAt, null);
});

test('expiry on the live wiring: short-TTL object swept by the manager', async (t) => {
  const cloud = makeCloud(t);
  const { job } = submitTestJob(cloud.manager, 'key-store-5');
  const bytes = Buffer.from('short-lived-output');
  await cloud.manager.storeJobOutput(job.id, {
    source: bytes,
    // 500ms, not 50ms: under parallel test load the put itself can take
    // >50ms of wall clock, so a 50ms TTL can expire the object before
    // the 'present' check below runs (flaky, not a code bug).
    ttlMs: 500,
  });
  assert.ok(cloud.manager.headJobOutput(job.id), 'present before expiry');

  await sleep(650);
  const report = await cloud.manager.runStorageSweep();
  assert.equal(report.deleted, 1);
  assert.equal(report.bytesFreed, bytes.length);
  assert.ok(report.deletedIds[0].startsWith('outputs/'));

  assert.equal(cloud.manager.headJobOutput(job.id), null, 'gone after the sweep');
  assert.equal(cloud.manager.getJob(job.id).outputRef, null, 'stale outputRef cleared');
  assert.equal(cloud.manager.storageUsage().totalObjects, 0);
});

test('lazy expiry: reading an expired output throws and clears the reference', async (t) => {
  const cloud = makeCloud(t);
  const { job } = submitTestJob(cloud.manager, 'key-store-6');
  await cloud.manager.storeJobOutput(job.id, {
    source: Buffer.from('about-to-expire'),
    ttlMs: 50,
  });
  await sleep(120);
  await assert.rejects(
    cloud.manager.getJobOutputBuffer(job.id),
    (err) => err.name === 'ObjectNotFoundError',
    'expired object reads as missing',
  );
  assert.equal(cloud.manager.getJob(job.id).outputRef, null);
});

test('sweep timer hosted on the manager deletes expired objects on its own', async (t) => {
  const cloud = makeCloud(t);
  t.after(() => cloud.manager.stopStorageSweep());
  const { job } = submitTestJob(cloud.manager, 'key-store-7');
  await cloud.manager.storeJobOutput(job.id, {
    source: Buffer.from('timer-swept'),
    ttlMs: 100,
  });

  cloud.manager.startStorageSweep(50);
  assert.throws(
    () => cloud.manager.startStorageSweep(50),
    /already running/,
    'double start throws',
  );
  await sleep(450);
  assert.equal(
    cloud.manager.headJobOutput(job.id),
    null,
    'timer swept the expired object without a manual sweep',
  );
  assert.equal(cloud.manager.storageUsage().totalObjects, 0);
  cloud.manager.stopStorageSweep();
});

test('manager and storage share one clock: expiry follows the injected clock', async (t) => {
  const clock = fakeClock();
  const cloud = makeCloud(t, { now: clock.now });
  const { job } = submitTestJob(cloud.manager, 'key-store-8');
  await cloud.manager.storeJobOutput(job.id, {
    source: Buffer.from('clock-shared'),
    ttlMs: 60_000,
  });
  assert.ok(cloud.manager.headJobOutput(job.id), 'present at T0');
  clock.advance(61_000);
  const report = await cloud.manager.runStorageSweep();
  assert.equal(report.deleted, 1, 'sweep uses the same clock — no real waiting');
  assert.equal(cloud.manager.headJobOutput(job.id), null);
});

test('no-storage guard: a bare manager refuses storage operations clearly', async (t) => {
  const manager = makeManager(t);
  assert.equal(manager.storage, null);
  const { job } = submitTestJob(manager, 'key-store-9');
  await assert.rejects(
    manager.storeJobOutput(job.id, { source: Buffer.from('x') }),
    /no storage attached/,
  );
  assert.throws(() => manager.storageUsage(), /no storage attached/);
  assert.throws(() => manager.startStorageSweep(), /no storage attached/);
  assert.throws(
    () => manager.attachStorage({}),
    /requires a NovaStorage instance/,
  );
});

test('unknown job and missing-output errors are clear', async (t) => {
  const cloud = makeCloud(t);
  await assert.rejects(
    cloud.manager.storeJobOutput('no-such-job', { source: Buffer.from('x') }),
    /unknown job/,
  );
  const { job } = submitTestJob(cloud.manager, 'key-store-10');
  assert.throws(() => cloud.manager.getJobOutput(job.id), /no stored output/);
  await assert.rejects(cloud.manager.issueJobDeliveryRef(job.id), /no stored output/);
  assert.equal(cloud.manager.headJobOutput(job.id), null);
  assert.equal(await cloud.manager.deleteJobOutput(job.id), false);
});
