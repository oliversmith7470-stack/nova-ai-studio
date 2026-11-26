// NOVA Personal GPU Cloud — Stage 1: global spending ceiling.
//
// The ceiling defaults to 0 (zero-cost mode): paid providers are NEVER
// dispatched while it is 0. Raising it is an owner decision — it requires
// authorizedBy + reason and is recorded in the store. A paid dispatch
// proceeds only when the ceiling covers the estimate on top of
// already-committed spend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  submitImage,
  registerPaidTestProvider,
} from './support.mjs';

function submitPaidVideo(manager, key, extra = {}) {
  return manager.submit({
    idempotencyKey: key,
    type: 'video',
    modelId: 'paid-video-v1',
    prompt: 'paid test video',
    ...extra,
  });
}

test('default ceiling is 0 and paid providers are never dispatched at 0', (t) => {
  const m = makeManager(t);
  registerPaidTestProvider(m);
  assert.equal(m.getSpendingCeiling(), 0);

  const { job } = submitPaidVideo(m, 'ceil-zero');
  const r = m.dispatchNext();
  assert.equal(r.dispatched, false);
  assert.equal(r.reason, 'ceiling-exceeded');
  assert.equal(r.estimatedUsd, 3); // 300s x $0.01/s
  assert.equal(r.ceiling, 0);
  assert.equal(m.getJob(job.id).status, 'queued');
  // No reservation survives a ceiling refusal.
  assert.equal(Object.keys(m.store.state.reservations).length, 0);
});

test('free providers dispatch at ceiling 0', async (t) => {
  const m = makeManager(t);
  assert.equal(m.getSpendingCeiling(), 0);
  const { job } = submitImage(m, 'ceil-free');
  assert.equal(m.dispatchNext().dispatched, true);
  await m.waitFor(job.id);
  assert.equal(m.getJob(job.id).status, 'succeeded');
});

test('raising the ceiling requires an owner decision (authorizedBy + reason)', (t) => {
  const m = makeManager(t);
  assert.throws(() => m.setSpendingCeiling(10), /authorizedBy/);
  assert.throws(
    () => m.setSpendingCeiling(10, { authorizedBy: 'Shina' }),
    /reason/,
  );
  assert.throws(
    () => m.setSpendingCeiling(-1, { authorizedBy: 'Shina', reason: 'x' }),
    /finite number/,
  );
  assert.equal(m.getSpendingCeiling(), 0);

  m.setSpendingCeiling(10, { authorizedBy: 'Shina', reason: 'test approval' });
  assert.equal(m.getSpendingCeiling(), 10);
  // The change is audited in the store.
  const changes = m.store.state.ceiling.changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousUsd, 0);
  assert.equal(changes[0].valueUsd, 10);
  assert.equal(changes[0].authorizedBy, 'Shina');
});

test('paid dispatch proceeds only when the ceiling covers the estimate', async (t) => {
  const m = makeManager(t);
  registerPaidTestProvider(m);
  const { job } = submitPaidVideo(m, 'ceil-cover');

  m.setSpendingCeiling(2, { authorizedBy: 'Shina', reason: 'too small' });
  assert.equal(m.dispatchNext().reason, 'ceiling-exceeded');

  m.setSpendingCeiling(5, { authorizedBy: 'Shina', reason: 'covers $3 estimate' });
  const r = m.dispatchNext();
  assert.equal(r.dispatched, true);
  assert.equal(r.providerId, 'mock-paid');
  await m.waitFor(job.id);
  assert.equal(m.getJob(job.id).status, 'succeeded');
  assert.equal(m.getJob(job.id).cost.estimatedUsd, 3);
});

test('committed spend counts against the ceiling', async (t) => {
  const m = makeManager(t);
  registerPaidTestProvider(m);
  m.setSpendingCeiling(5, { authorizedBy: 'Shina', reason: 'test' });

  const a = submitPaidVideo(m, 'ceil-a'); // $3 estimate
  const b = submitPaidVideo(m, 'ceil-b'); // $3 estimate
  assert.equal(m.dispatchNext().jobId, a.job.id);
  assert.equal(m.committedUsd(), 3);

  // $3 committed + $3 estimate > $5 ceiling: the second job waits.
  const blocked = m.dispatchNext();
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.reason, 'ceiling-exceeded');
  assert.equal(blocked.committed, 3);

  await m.waitFor(a.job.id);
  assert.equal(m.committedUsd(), 0);
  assert.equal(m.dispatchNext().jobId, b.job.id);
  await m.waitFor(b.job.id);
});

test('lowering the ceiling blocks further paid dispatch', (t) => {
  const m = makeManager(t);
  registerPaidTestProvider(m);
  m.setSpendingCeiling(10, { authorizedBy: 'Shina', reason: 'test' });
  const a = submitPaidVideo(m, 'ceil-down-a');
  assert.equal(m.dispatchNext().dispatched, true);

  m.setSpendingCeiling(0, { authorizedBy: 'Shina', reason: 'back to zero-cost' });
  const b = submitPaidVideo(m, 'ceil-down-b');
  assert.equal(m.dispatchNext().reason, 'ceiling-exceeded');
  assert.equal(m.getJob(b.job.id).status, 'queued');
  assert.equal(m.getJob(a.job.id).status, 'running'); // in-flight job unaffected
});
