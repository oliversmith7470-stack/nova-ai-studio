// NOVA Personal GPU Cloud — Stage 1: reconciliation.
//
// Provider statements are compared against NOVA's records and every
// mismatch is flagged. Reconciliation is read-only on jobs: it reports,
// it never rewrites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, submitImage, submitVideo } from './support.mjs';

async function succeededJob(t, key, secondsUsed = 12.5) {
  const m = makeManager(t, { mockOptions: { secondsUsed } });
  const { job } = submitImage(m, key);
  m.dispatchNext();
  await m.waitFor(job.id);
  assert.equal(m.getJob(job.id).status, 'succeeded');
  return { m, job: m.getJob(job.id) };
}

function statementFor(job, over = {}) {
  return {
    jobId: job.id,
    providerId: job.providerId,
    status: 'succeeded',
    secondsUsed: job.cost.providerReportedSeconds,
    costUsd: job.cost.providerReportedUsd,
    ...over,
  };
}

test('a matching statement reconciles clean', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-ok');
  const result = m.reconcile([statementFor(job)]);
  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.mismatched, 0);
  assert.deepEqual(result.mismatches, []);
  // The run itself is recorded in the store.
  assert.equal(m.store.state.reconciliations.length, 1);
});

test('cost mismatch is flagged', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-cost');
  const result = m.reconcile([statementFor(job, { costUsd: 5.0 })]);
  assert.equal(result.matched, 0);
  assert.equal(result.mismatches[0].kind, 'cost-mismatch');
  assert.equal(result.mismatches[0].nova, 0);
  assert.equal(result.mismatches[0].provider, 5.0);
});

test('seconds mismatch is flagged', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-seconds');
  const result = m.reconcile([statementFor(job, { secondsUsed: 99 })]);
  assert.equal(result.mismatches[0].kind, 'seconds-mismatch');
  assert.equal(result.mismatches[0].nova, 12.5);
  assert.equal(result.mismatches[0].provider, 99);
});

test('small seconds differences (clock skew) are tolerated', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-skew');
  const result = m.reconcile([statementFor(job, { secondsUsed: 12.8 })]);
  assert.equal(result.matched, 1);
});

test('status mismatch is flagged', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-status');
  const result = m.reconcile([statementFor(job, { status: 'failed' })]);
  assert.equal(result.mismatches[0].kind, 'status-mismatch');
  assert.equal(result.mismatches[0].nova, 'succeeded');
  assert.equal(result.mismatches[0].provider, 'failed');
});

test('unknown job is flagged', async (t) => {
  const { m } = await succeededJob(t, 'rec-unknown');
  const result = m.reconcile([
    {
      jobId: 'job_does-not-exist',
      providerId: 'mock-t4',
      status: 'succeeded',
      secondsUsed: 10,
      costUsd: 1,
    },
  ]);
  assert.equal(result.mismatches[0].kind, 'unknown-job');
  assert.equal(result.mismatches[0].jobId, 'job_does-not-exist');
});

test('provider mismatch is flagged', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-provider');
  const result = m.reconcile([
    statementFor(job, { providerId: 'runpod-4090' }),
  ]);
  const kinds = result.mismatches.map((x) => x.kind);
  assert.ok(kinds.includes('provider-mismatch'));
});

test('report for a job still in flight is flagged', (t) => {
  const m = makeManager(t);
  const { job } = submitVideo(m, 'rec-inflight');
  const result = m.reconcile([
    {
      jobId: job.id,
      providerId: 'mock-t4',
      status: 'succeeded',
      secondsUsed: 10,
      costUsd: 0,
    },
  ]);
  assert.equal(result.mismatches[0].kind, 'job-not-terminal');
  assert.equal(result.mismatches[0].status, 'queued');
});

test('charged-for-failed-job is flagged', async (t) => {
  const m = makeManager(t);
  m.mock.failNext();
  const { job } = submitImage(m, 'rec-failed');
  m.dispatchNext();
  await m.waitFor(job.id);
  assert.equal(m.getJob(job.id).status, 'failed');

  const result = m.reconcile([
    {
      jobId: job.id,
      providerId: 'mock-t4',
      status: 'failed',
      secondsUsed: 5,
      costUsd: 2.5, // charged despite the failure
    },
  ]);
  const kinds = result.mismatches.map((x) => x.kind);
  assert.ok(kinds.includes('charged-for-failed-job'));
});

test('cancel-completed jobs are NOT status mismatches', async (t) => {
  const m = makeManager(t);
  const { job } = submitImage(m, 'rec-cancel');
  m.dispatchNext();
  m.cancelJob(job.id, 'test');
  await m.waitFor(job.id);
  const final = m.getJob(job.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.cancelOutcome, 'provider-completed');

  // The provider says succeeded; NOVA says cancelled. Both are true —
  // the cost is real and must reconcile, not hide.
  const result = m.reconcile([statementFor(final)]);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.mismatches, []);
});

test('unreported succeeded jobs are listed', async (t) => {
  const { m, job } = await succeededJob(t, 'rec-unreported');
  assert.deepEqual(m.unreportedJobs([]), [job.id]);
  assert.deepEqual(m.unreportedJobs([job.id]), []);
});
