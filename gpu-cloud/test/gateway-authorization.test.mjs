// NOVA FreeLLMAPI — sandbox owner-authorization store tests (approved v5
// design, A5 contract + implementation spec).
//
// Covers record creation + validation, revocation, supersede, the audit
// log, and the fail-closed behaviour of every one of the design's nine
// validation checks. The store is file-backed; every test gets a fresh
// temp directory and a fixed clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AuthorizationStore,
  AuthorizationStoreError,
  isValidIsoUtc,
  AUTHORIZATION_OPERATION,
  APPROVAL_METHODS,
} from '../src/gateway-authorization.js';

const NOW = Date.parse('2026-11-27T09:00:00.000Z');
const JOB_A = 'nova-job-11111111-1111-1111-1111-111111111111';
const JOB_B = 'nova-job-22222222-2222-2222-2222-222222222222';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-auth-test-'));
  const store = new AuthorizationStore({
    filePath: path.join(dir, 'gateway-authorizations.json'),
    auditPath: path.join(dir, 'gateway-authorization-audit.log'),
    component: 'test',
    now: () => NOW,
  });
  return { store, dir };
}

function createRecord(store, overrides = {}) {
  return store.create({
    jobIds: [JOB_A],
    startsAt: '2026-11-27T08:00:00.000Z',
    expiresAt: '2026-11-28T00:00:00.000Z',
    projectId: 'nova-ai-studio',
    environmentId: 'nova-api',
    ownerId: 'nova-owner',
    ...overrides,
  });
}

function readAudit(dir) {
  const file = path.join(dir, 'gateway-authorization-audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('isValidIsoUtc accepts strict UTC timestamps and rejects the rest', () => {
  assert.equal(isValidIsoUtc('2026-11-27T09:00:00.000Z'), true);
  assert.equal(isValidIsoUtc('2026-11-27T09:00:00Z'), true);
  assert.equal(isValidIsoUtc('2024-02-29T00:00:00.000Z'), true); // leap day
  assert.equal(isValidIsoUtc('2026-02-29T00:00:00.000Z'), false); // not a leap year
  assert.equal(isValidIsoUtc('2026-02-30T00:00:00.000Z'), false);
  assert.equal(isValidIsoUtc('2026-13-01T00:00:00.000Z'), false);
  assert.equal(isValidIsoUtc('2026-11-27T24:00:00.000Z'), false);
  assert.equal(isValidIsoUtc('2026-11-27T09:00:60.000Z'), false); // no leap second
  assert.equal(isValidIsoUtc('0000-01-01T00:00:00.000Z'), false);
  assert.equal(isValidIsoUtc('2026-11-27T09:00:00.000+00:00'), false); // offset, not Z
  assert.equal(isValidIsoUtc('2026-11-27 09:00:00Z'), false);
  assert.equal(isValidIsoUtc(''), false);
  assert.equal(isValidIsoUtc(null), false);
  assert.equal(isValidIsoUtc(123), false);
});

test('create stores a complete active record with the fixed operation and method', () => {
  const { store, dir } = makeStore();
  const record = createRecord(store);
  assert.match(record.authorizationId, /^auth-/);
  assert.equal(record.approvedByOwnerId, 'nova-owner');
  assert.equal(record.approvedAt, '2026-11-27T09:00:00.000Z');
  assert.equal(record.approvalMethod, 'host-operator-cli');
  assert.deepEqual(APPROVAL_METHODS, ['host-operator-cli']);
  assert.equal(record.projectId, 'nova-ai-studio');
  assert.equal(record.environmentId, 'nova-api');
  assert.equal(record.operation, AUTHORIZATION_OPERATION);
  assert.equal(record.operation, 'gateway_prompt_enhancement');
  assert.deepEqual(record.jobScope, { jobIds: [JOB_A] });
  assert.equal(record.startsAt, '2026-11-27T08:00:00.000Z');
  assert.equal(record.expiresAt, '2026-11-28T00:00:00.000Z');
  assert.equal(record.status, 'active');
  assert.equal(record.revokedAt, null);
  assert.equal(record.revokedByOwnerId, null);
  assert.equal(record.supersededBy, null);
  // Files are mode 0600.
  assert.equal(fs.statSync(path.join(dir, 'gateway-authorizations.json')).mode & 0o777, 0o600);
  // The audit log carries the approval event.
  const audit = readAudit(dir);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].decision, 'approved');
  assert.equal(audit[0].authorizationId, record.authorizationId);
  assert.equal(audit[0].operation, AUTHORIZATION_OPERATION);
});

test('create rejects invalid inputs', () => {
  const { store } = makeStore();
  assert.throws(() => createRecord(store, { jobIds: [] }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { jobIds: [123] }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { startsAt: 'not-a-date' }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { expiresAt: '2026-02-30T00:00:00.000Z' }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { expiresAt: '2026-11-27T08:00:00.000Z' }), AuthorizationStoreError); // == startsAt
  assert.throws(() => createRecord(store, { expiresAt: '2026-11-27T07:00:00.000Z' }), AuthorizationStoreError); // < startsAt
  assert.throws(() => createRecord(store, { projectId: '' }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { environmentId: '' }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { ownerId: '' }), AuthorizationStoreError);
  assert.throws(() => createRecord(store, { approvalMethod: 'env-var' }), AuthorizationStoreError);
});

test('validate accepts a covering record and records the decision', () => {
  const { store, dir } = makeStore();
  const record = createRecord(store);
  assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), true);
  // The record now carries the validating component; the audit has approved + validated.
  assert.equal(store.get(record.authorizationId).lastValidatedByComponent, 'test');
  const audit = readAudit(dir);
  assert.deepEqual(audit.map((e) => e.decision), ['approved', 'validated']);
});

test('validate fails closed on every authorization state', () => {
  // No covering authorization at all.
  {
    const { store } = makeStore();
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Expired (now is past expiresAt).
  {
    const { store } = makeStore();
    createRecord(store, { startsAt: '2026-11-27T07:00:00.000Z', expiresAt: '2026-11-27T08:00:00.000Z' });
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Not yet valid (startsAt is in the future).
  {
    const { store } = makeStore();
    createRecord(store, { startsAt: '2026-11-27T10:00:00.000Z', expiresAt: '2026-11-28T00:00:00.000Z' });
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Revoked.
  {
    const { store } = makeStore();
    const record = createRecord(store);
    store.revoke(record.authorizationId, { revokedByOwnerId: 'nova-owner' });
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Owner mismatch.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'someone-else' }), false);
  }
  // Environment mismatch.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'other-env', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Project mismatch.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'other-project', ownerId: 'nova-owner' }), false);
  }
  // Job not in scope.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({ jobId: JOB_B }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Missing job id.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({}, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Unknown authorization reference.
  {
    const { store } = makeStore();
    createRecord(store);
    assert.equal(store.validate({ jobId: JOB_A, sandboxAuthorizationId: 'auth-no-such' }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Approval event missing from the audit log.
  {
    const { store, dir } = makeStore();
    createRecord(store);
    fs.unlinkSync(path.join(dir, 'gateway-authorization-audit.log'));
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Tampered operation.
  {
    const { store, dir } = makeStore();
    const record = createRecord(store);
    const file = path.join(dir, 'gateway-authorizations.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.records[record.authorizationId].operation = 'something-else';
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
  // Corrupt records file fails closed instead of throwing.
  {
    const { store, dir } = makeStore();
    createRecord(store);
    fs.writeFileSync(path.join(dir, 'gateway-authorizations.json'), '{corrupt');
    assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  }
});

test('validate by sandboxAuthorizationId honours the reference', () => {
  const { store } = makeStore();
  const record = createRecord(store);
  assert.equal(store.validate({ jobId: JOB_A, sandboxAuthorizationId: record.authorizationId }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), true);
  // The reference pins the record: a different job id is out of scope.
  assert.equal(store.validate({ jobId: JOB_B, sandboxAuthorizationId: record.authorizationId }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
});

test('creating a second record for the same job supersedes the first', () => {
  const { store, dir } = makeStore();
  const first = createRecord(store);
  const second = createRecord(store);
  assert.notEqual(first.authorizationId, second.authorizationId);
  assert.equal(store.get(first.authorizationId).supersededBy, second.authorizationId);
  assert.equal(store.get(first.authorizationId).status, 'active'); // stored status stays active; supersededBy is the marker
  assert.equal(store.validate({ jobId: JOB_A }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), true);
  assert.equal(store.validate({ jobId: JOB_A, sandboxAuthorizationId: first.authorizationId }, { environmentId: 'nova-api', projectId: 'nova-ai-studio', ownerId: 'nova-owner' }), false);
  const audit = readAudit(dir);
  assert.ok(audit.some((e) => e.decision === 'superseded' && e.authorizationId === first.authorizationId));
});

test('revoke is atomic, audited, and idempotent', () => {
  const { store, dir } = makeStore();
  const record = createRecord(store);
  const revoked = store.revoke(record.authorizationId, { revokedByOwnerId: 'nova-owner' });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedAt, '2026-11-27T09:00:00.000Z');
  assert.equal(revoked.revokedByOwnerId, 'nova-owner');
  const audit = readAudit(dir);
  assert.deepEqual(audit.map((e) => e.decision), ['approved', 'revoked']);
  // A second revoke reports the same record without a second audit event.
  const again = store.revoke(record.authorizationId, { revokedByOwnerId: 'nova-owner' });
  assert.equal(again.status, 'revoked');
  assert.equal(readAudit(dir).length, 2);
  assert.throws(() => store.revoke('auth-no-such', { revokedByOwnerId: 'nova-owner' }), AuthorizationStoreError);
  assert.throws(() => store.revoke(record.authorizationId, {}), AuthorizationStoreError);
});

test('findForJob returns the covering record and honours scope filters', () => {
  const { store } = makeStore();
  const record = createRecord(store);
  assert.equal(store.findForJob(JOB_A).authorizationId, record.authorizationId);
  assert.equal(store.findForJob(JOB_B), null);
  assert.equal(store.findForJob(JOB_A, { projectId: 'other' }), null);
  assert.equal(store.findForJob(JOB_A, { environmentId: 'other' }), null);
  assert.equal(store.findForJob(JOB_A, { projectId: 'nova-ai-studio', environmentId: 'nova-api' }).authorizationId, record.authorizationId);
  // A revoked record no longer covers the job.
  store.revoke(record.authorizationId, { revokedByOwnerId: 'nova-owner' });
  assert.equal(store.findForJob(JOB_A), null);
});

test('list returns records in approval order; get returns null for unknown ids', () => {
  const { store } = makeStore();
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('auth-no-such'), null);
  const first = createRecord(store);
  const second = createRecord(store, { jobIds: [JOB_B] });
  assert.deepEqual(store.list().map((r) => r.authorizationId), [first.authorizationId, second.authorizationId]);
});
