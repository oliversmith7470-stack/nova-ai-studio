// NOVA FreeLLMAPI — gateway policy + production-boundary tests (approved
// v5 design, A5/§7).
//
// The production-aware effectivePrompt resolver verbatim from the design,
// plus the five production-boundary tests: (1) production startup rejects
// NOVA_GATEWAY_ENHANCEMENT=true, (2) production always uses the original
// prompt, (3) production + enhanced throws, (4) a sandbox label on a job
// cannot bypass production classification, (5) every sandbox
// authorization state gates dispatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGatewayPolicy, effectivePrompt, InvalidJobError } from '../src/gateway-policy.js';
import { AuthorizationStore } from '../src/gateway-authorization.js';
import { createApiServer } from '../src/api-server.js';
import { MemoryD1Client } from '../src/api-server/test/support.mjs';
import { FakeControlledExecutor } from '../src/api-server/fake-executor.js';

const NOW = Date.parse('2026-11-27T09:00:00.000Z');
const JOB_A = 'nova-job-11111111-1111-1111-1111-111111111111';
const JOB_B = 'nova-job-22222222-2222-2222-2222-222222222222';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-policy-test-'));
  return new AuthorizationStore({
    filePath: path.join(dir, 'gateway-authorizations.json'),
    auditPath: path.join(dir, 'gateway-authorization-audit.log'),
    component: 'test',
    now: () => NOW,
  });
}

function authorize(store, jobIds = [JOB_A], overrides = {}) {
  return store.create({
    jobIds,
    startsAt: '2026-11-27T08:00:00.000Z',
    expiresAt: '2026-11-28T00:00:00.000Z',
    projectId: 'nova-ai-studio',
    environmentId: 'nova-api',
    ownerId: 'nova-owner',
    ...overrides,
  });
}

const userJob = {
  id: JOB_A,
  prompt: 'A dragon on a ridge at dawn.',
  promptSource: 'user',
  enhancedPrompt: null,
};

const enhancedJob = {
  id: JOB_A,
  prompt: 'A dragon on a ridge at dawn.',
  promptSource: 'enhanced',
  enhancedPrompt: 'A grey dragon with ember cracks circles a mountain ridge at dawn, wings spread.',
  sandboxAuthorizationId: null,
};

// -- resolver basics ---------------------------------------------------------

test('development: a user job dispatches its original prompt', () => {
  const policy = buildGatewayPolicy({ environment: 'development' });
  assert.equal(effectivePrompt(userJob, policy), userJob.prompt);
});

test('development: an enhanced job dispatches its enhanced prompt', () => {
  const policy = buildGatewayPolicy({ environment: 'development' });
  assert.equal(effectivePrompt(enhancedJob, policy), enhancedJob.enhancedPrompt);
});

test('development: an empty or non-string enhanced prompt falls back to the original', () => {
  const policy = buildGatewayPolicy({ environment: 'development' });
  assert.equal(effectivePrompt({ ...enhancedJob, enhancedPrompt: '' }, policy), enhancedJob.prompt);
  assert.equal(effectivePrompt({ ...enhancedJob, enhancedPrompt: 42 }, policy), enhancedJob.prompt);
  assert.equal(effectivePrompt({ ...enhancedJob, promptSource: 'user' }, policy), enhancedJob.prompt);
});

test('test environment behaves like development (no authorization needed)', () => {
  const policy = buildGatewayPolicy({ environment: 'test' });
  assert.equal(effectivePrompt(enhancedJob, policy), enhancedJob.enhancedPrompt);
});

test('unknown environments are rejected at policy build', () => {
  assert.throws(() => buildGatewayPolicy({ environment: 'staging' }), /unknown gateway environment/);
});

// -- the five production-boundary tests (§7) ---------------------------------

test('1. production startup rejects NOVA_GATEWAY_ENHANCEMENT=true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-prod-start-'));
  // Production mode + flag on.
  assert.throws(
    () => createApiServer({
      mode: 'production',
      secret: 'test-secret',
      signingSecret: 'test-signing-secret',
      dataDir: dir,
      d1Client: new MemoryD1Client(),
      gatewayEnhancement: true,
    }),
    /cannot be enabled in production/,
  );
  // Controlled-test mode but a production environment + flag on.
  assert.throws(
    () => createApiServer({
      mode: 'controlled-test',
      secret: 'test-secret',
      dataDir: dir,
      d1Client: new MemoryD1Client(),
      executor: new FakeControlledExecutor(),
      environment: 'production',
      gatewayEnhancement: true,
    }),
    /cannot be enabled in production/,
  );
  // Development + flag on starts (client disabled without a key).
  const api = createApiServer({
    mode: 'controlled-test',
    secret: 'test-secret',
    dataDir: dir,
    d1Client: new MemoryD1Client(),
    executor: new FakeControlledExecutor(),
    environment: 'development',
    gatewayEnhancement: true,
  });
  try {
    assert.equal(api.config.gatewayEnhancement, true);
    assert.equal(api.gatewayClient, null);
    assert.equal(api.gatewayPolicy.environment, 'development');
  } finally {
    await api.stop().catch(() => {});
  }
});

test('2. production always uses the original prompt', () => {
  const policy = buildGatewayPolicy({ environment: 'production' });
  assert.equal(effectivePrompt(userJob, policy), userJob.prompt);
  // Even a job that carries an enhanced prompt field dispatches the original.
  assert.equal(effectivePrompt({ ...userJob, enhancedPrompt: 'Some enhanced text.' }, policy), userJob.prompt);
});

test('3. production dispatch of a job marked promptSource enhanced throws InvalidJobError', () => {
  const policy = buildGatewayPolicy({ environment: 'production' });
  assert.throws(
    () => effectivePrompt(enhancedJob, policy),
    (err) => err instanceof InvalidJobError
      && err.message === 'Gateway-enhanced prompts are prohibited in production',
  );
});

test('4. a sandbox label on a job cannot bypass production classification', () => {
  const production = buildGatewayPolicy({ environment: 'production' });
  // The job claims to be a sandbox job; the trusted environment is production.
  assert.throws(
    () => effectivePrompt({ ...enhancedJob, environment: 'sandbox' }, production),
    (err) => err instanceof InvalidJobError
      && err.message === 'Gateway-enhanced prompts are prohibited in production',
  );
  // And a user job labelled sandbox still dispatches its original in production.
  assert.equal(
    effectivePrompt({ ...userJob, environment: 'sandbox' }, production),
    userJob.prompt,
  );
  // The reverse: a job labelled production in a sandbox environment is
  // governed by the sandbox policy, not its label — without authorization
  // it cannot dispatch at all.
  const store = makeStore();
  const sandbox = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
  assert.throws(
    () => effectivePrompt({ ...enhancedJob, environment: 'production' }, sandbox),
    (err) => err instanceof InvalidJobError
      && err.message === 'Sandbox prompt enhancement is not authorized',
  );
});

test('5. sandbox authorization states gate dispatch (one case per state)', () => {
  // No authorization record at all.
  {
    const store = makeStore();
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Valid authorization: the enhanced prompt dispatches.
  {
    const store = makeStore();
    const record = authorize(store);
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    const job = { ...enhancedJob, sandboxAuthorizationId: record.authorizationId };
    assert.equal(effectivePrompt(job, policy), enhancedJob.enhancedPrompt);
    // The lookup path (no sandboxAuthorizationId on the job) also works.
    assert.equal(effectivePrompt(enhancedJob, policy), enhancedJob.enhancedPrompt);
  }
  // Revoked authorization.
  {
    const store = makeStore();
    const record = authorize(store);
    store.revoke(record.authorizationId, { revokedByOwnerId: 'nova-owner' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt({ ...enhancedJob, sandboxAuthorizationId: record.authorizationId }, policy), /not authorized/);
  }
  // Expired authorization.
  {
    const store = makeStore();
    authorize(store, [JOB_A], { startsAt: '2026-11-27T07:00:00.000Z', expiresAt: '2026-11-27T08:00:00.000Z' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Not-yet-valid authorization.
  {
    const store = makeStore();
    authorize(store, [JOB_A], { startsAt: '2026-11-27T10:00:00.000Z', expiresAt: '2026-11-28T00:00:00.000Z' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Job out of scope.
  {
    const store = makeStore();
    authorize(store, [JOB_B]);
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Wrong environment id.
  {
    const store = makeStore();
    authorize(store, [JOB_A], { environmentId: 'other-env' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Wrong project.
  {
    const store = makeStore();
    authorize(store, [JOB_A], { projectId: 'other-project' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Wrong owner.
  {
    const store = makeStore();
    authorize(store, [JOB_A], { ownerId: 'someone-else' });
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // No authorization store at all: sandbox always refuses.
  {
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: null });
    assert.throws(() => effectivePrompt(enhancedJob, policy), /not authorized/);
  }
  // Superseded authorization.
  {
    const store = makeStore();
    const first = authorize(store);
    authorize(store); // supersedes the first
    const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
    assert.throws(() => effectivePrompt({ ...enhancedJob, sandboxAuthorizationId: first.authorizationId }, policy), /not authorized/);
    assert.equal(effectivePrompt(enhancedJob, policy), enhancedJob.enhancedPrompt);
  }
});

test('findAuthorizationForJob returns the covering record for intake linkage', () => {
  const store = makeStore();
  const record = authorize(store);
  const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
  assert.equal(policy.findAuthorizationForJob(JOB_A).authorizationId, record.authorizationId);
  assert.equal(policy.findAuthorizationForJob(JOB_B), null);
  const noStore = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: null });
  assert.equal(noStore.findAuthorizationForJob(JOB_A), null);
});
