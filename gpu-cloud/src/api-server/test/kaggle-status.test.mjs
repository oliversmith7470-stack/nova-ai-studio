// Authoritative Kaggle wire-state mapping (Rev 3.2 §B-3.2.3.3).
// The wire vocabulary is the prefixed enum KernelWorkerStatus.* with
// SEVEN members. The mapping is fail-closed: anything unrecognised is
// `unknown` (hold), never a guess.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KAGGLE_STATUS_MAP,
  normalizeExecutorState,
  mapStatusQuery,
  queryExecutionState,
} from '../kaggle-status.js';

test('mapping covers exactly the seven wire values', () => {
  assert.deepEqual(Object.keys(KAGGLE_STATUS_MAP).sort(), [
    'CANCEL_ACKNOWLEDGED',
    'CANCEL_REQUESTED',
    'COMPLETE',
    'ERROR',
    'NEW_SCRIPT',
    'QUEUED',
    'RUNNING',
  ]);
});

test('fail-closed mapping per member', () => {
  assert.equal(normalizeExecutorState('KernelWorkerStatus.QUEUED'), 'accepted');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.RUNNING'), 'running');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.COMPLETE'), 'completed');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.ERROR'), 'failed');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.CANCEL_REQUESTED'), 'unknown');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.CANCEL_ACKNOWLEDGED'), 'failed');
  assert.equal(normalizeExecutorState('KernelWorkerStatus.NEW_SCRIPT'), 'unknown');
});

test('unknown, malformed, null, and empty wire values are unknown', () => {
  for (const raw of ['KernelWorkerStatus.DELETED', 'KernelWorkerStatus.', '', null, undefined, 42, 'KernelWorkerStatus.QUEUED ']) {
    assert.equal(normalizeExecutorState(raw), 'unknown', JSON.stringify(raw));
  }
});

test('bare member names are accepted too (the design assumed bare; proofs found prefixed)', () => {
  assert.equal(normalizeExecutorState('QUEUED'), 'accepted');
  assert.equal(normalizeExecutorState('COMPLETE'), 'completed');
  assert.equal(normalizeExecutorState('queued'), 'accepted', 'case-insensitive');
});

test('mapStatusQuery: completed is returned, never treated as acceptance', () => {
  const q = mapStatusQuery({ raw: 'KernelWorkerStatus.COMPLETE', queryError: null });
  assert.equal(q.state, 'completed');
  assert.equal(q.evidence.raw, 'KernelWorkerStatus.COMPLETE');
});

test('mapStatusQuery: query error is unknown, not failed', () => {
  const q = mapStatusQuery({ raw: null, queryError: new Error('timeout') });
  assert.equal(q.state, 'unknown');
  assert.match(q.evidence.queryError, /timeout/);
});

test('queryExecutionState: never-received when the status query returns no record', async () => {
  const statusFn = async () => null;
  const q = await queryExecutionState(statusFn, 'missing-id');
  assert.equal(q.state, 'never-received');
});

test('queryExecutionState: transport error is unknown (hold)', async () => {
  const statusFn = async () => { throw new Error('ECONNRESET'); };
  const q = await queryExecutionState(statusFn, 'some-id');
  // A transport failure is indistinguishable from "executor unreachable":
  // the caller must not fail the job on it.
  assert.equal(q.state, 'unknown');
  assert.match(q.evidence.queryError, /ECONNRESET/);
});
