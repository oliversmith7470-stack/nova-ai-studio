// NOVA Cloud Storage — delivery references: the opaque, short-lived
// reference a user redeems to download an object. This is what the GPU
// Manager stores as a job's resultRef — never media bytes.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATED_CONTENT_TTL_MS,
  ObjectNotFoundError,
  DeliveryRefError,
  StorageValidationError,
} from '../../src/storage/index.js';
import { makeStorage, fakeClock } from './support.mjs';

const HOUR_MS = 60 * 60 * 1000;

test('issue + redeem returns the object it points at', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId });
  assert.ok(ref.ref.startsWith('nova://delivery/'));
  assert.equal(ref.redemptions, 0);
  const redeemed = await store.redeemDeliveryRef(ref.ref);
  assert.equal(redeemed.namespace, 'media');
  assert.equal(redeemed.objectId, record.objectId);
  assert.equal(redeemed.record.sizeBytes, 4);
  assert.equal(redeemed.redemptions, 1);
});

test('redeeming an unknown reference fails', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    () => store.redeemDeliveryRef('nova://delivery/doesnotexist'),
    (err) => err instanceof DeliveryRefError && err.reason === 'unknown',
  );
});

test('an expired reference fails and is removed', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'models', source: Buffer.from('weights') });
  const ref = await store.issueDeliveryRef({
    namespace: 'models',
    objectId: record.objectId,
    ttlMs: HOUR_MS,
  });
  clock.advance(2 * HOUR_MS);
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof DeliveryRefError && err.reason === 'expired',
  );
  // Second redeem is 'unknown' now — the expired ref was deleted.
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof DeliveryRefError && err.reason === 'unknown',
  );
});

test('maxRedemptions is enforced', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({
    namespace: 'media',
    objectId: record.objectId,
    maxRedemptions: 2,
  });
  await store.redeemDeliveryRef(ref.ref);
  await store.redeemDeliveryRef(ref.ref);
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof DeliveryRefError && err.reason === 'exhausted',
  );
});

test('a reference to a deleted object fails', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId });
  await store.delete('media', record.objectId);
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof DeliveryRefError && err.reason === 'unknown',
  );
});

test('issuing a reference for a missing object fails', async (t) => {
  const store = makeStorage(t);
  await assert.rejects(
    () => store.issueDeliveryRef({ namespace: 'media', objectId: 'b'.repeat(64) }),
    ObjectNotFoundError,
  );
});

test('a reference is opaque: it carries no object identity in plaintext', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId });
  assert.equal(ref.ref.includes(record.objectId), false);
  assert.equal(ref.ref.includes('media'), false);
  assert.equal(ref.ref.includes('clip'), false);
});

test('a reference dies with its object even when the reference itself is unexpired', async (t) => {
  const clock = fakeClock();
  const store = makeStorage(t, { clock: clock.now });
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({
    namespace: 'media',
    objectId: record.objectId,
    ttlMs: 48 * HOUR_MS, // longer than the object's 24h life
  });
  clock.advance(25 * HOUR_MS);
  await assert.rejects(
    () => store.redeemDeliveryRef(ref.ref),
    (err) => err instanceof ObjectNotFoundError && err.reason === 'expired',
  );
});

test('invalid reference options are rejected', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  await assert.rejects(
    () => store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId, ttlMs: 0 }),
    StorageValidationError,
  );
  await assert.rejects(
    () => store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId, maxRedemptions: 0 }),
    StorageValidationError,
  );
});

test('a bare token redeems the same as the full reference', async (t) => {
  const store = makeStorage(t);
  const record = await store.put({ namespace: 'media', source: Buffer.from('clip') });
  const ref = await store.issueDeliveryRef({ namespace: 'media', objectId: record.objectId });
  const redeemed = await store.redeemDeliveryRef(ref.token);
  assert.equal(redeemed.objectId, record.objectId);
});
