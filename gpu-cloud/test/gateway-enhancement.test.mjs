// NOVA FreeLLMAPI — enhancement + metadata tests (approved v5 design,
// A4/A5/§7).
//
// The background enhancement task on GpuManager, exercised with stub
// gateway / direct-Gemini clients (no live gateway): submit never awaits
// the task, late results are discarded, updates are queued-only,
// duplicates start no second task, failures fall back to the original
// prompt, and job metadata stays deferred (no metadata fields, no
// metadata call).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeManager, submitVideo, sleep } from './support.mjs';
import { buildGatewayPolicy } from '../src/gateway-policy.js';
import { AuthorizationStore } from '../src/gateway-authorization.js';
import { createJob } from '../src/job.js';

const ORIGINAL = 'A dragon on a ridge at dawn.';
const ENHANCED = 'A grey dragon with ember cracks circles a mountain ridge at dawn, wings spread wide.';
const GOOGLE_PIN = 'google:gemini-3.5-flash-lite';
const GOOGLE_ROUTED = 'google/gemini-3.5-flash-lite';

function gatewayStub({ content = ENHANCED, delayMs = 0, calls = null } = {}) {
  let count = 0;
  return {
    model: GOOGLE_PIN,
    get calls() { return count; },
    async enhance(prompt) {
      count += 1;
      if (calls) calls.push(prompt);
      if (delayMs > 0) await sleep(delayMs);
      return { content, routedVia: GOOGLE_ROUTED, reportedModel: 'gemini-3.5-flash-lite' };
    },
  };
}

function throwingGatewayStub() {
  let count = 0;
  return {
    model: GOOGLE_PIN,
    get calls() { return count; },
    async enhance() {
      count += 1;
      throw new Error('gateway down');
    },
  };
}

function directGeminiStub({ content = 'Direct Gemini enhancement of the prompt.' } = {}) {
  let count = 0;
  return {
    model: 'gemini-3.5-flash',
    modelIdentity: 'google/gemini-3.5-flash',
    get calls() { return count; },
    async enhance() {
      count += 1;
      return { content, reportedModel: null };
    },
  };
}

function devPolicy() {
  return buildGatewayPolicy({ environment: 'development' });
}

function makeEnhancedManager(t, { client, directGemini = null, policy = devPolicy() } = {}) {
  return makeManager(t, {
    enhancement: { enabled: true, client, directGemini, policy },
  });
}

// A capturing executor: records the prompt each dispatched job carries.
function capturingExecutor() {
  const received = [];
  return {
    received,
    start(job) {
      received.push({ id: job.id, prompt: job.prompt });
      return Promise.resolve({
        jobId: job.id,
        providerId: 'mock-t4',
        status: 'succeeded',
        secondsUsed: 0.001,
        costUsd: 0,
        completedAt: Date.now(),
        resultRef: `mock://transient/${job.id}`,
        error: null,
      });
    },
  };
}

function eventsNamed(manager, name) {
  return manager.events.filter((e) => e.name === name);
}

test('submit never awaits enhancement: it returns at once and the job stays on the original prompt', async (t) => {
  // A gateway that never resolves.
  const hanging = { model: GOOGLE_PIN, async enhance() { return new Promise(() => {}); } };
  const manager = makeEnhancedManager(t, { client: hanging });
  const started = Date.now();
  const { job, created } = submitVideo(manager, 'hang-1', { prompt: ORIGINAL });
  assert.equal(created, true);
  assert.ok(Date.now() - started < 1000, 'submit must return without waiting for the gateway');
  assert.equal(manager.getJob(job.id).promptSource, 'user');
  assert.equal(manager.getJob(job.id).prompt, ORIGINAL);
  // The task is registered (and still pending).
  assert.ok(manager.pendingEnhancement(job.id) !== null);
  // Dispatch is not delayed by the hanging enhancement either.
  const r = manager.dispatchNext();
  assert.equal(r.dispatched, true);
  assert.equal(r.jobId, job.id);
});

test('an accepted enhancement lands on the record with full metadata', async (t) => {
  const client = gatewayStub();
  const manager = makeEnhancedManager(t, { client });
  const { job } = submitVideo(manager, 'acc-1', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  const stored = manager.getJob(job.id);
  assert.equal(stored.prompt, ORIGINAL, 'the original prompt is immutable');
  assert.equal(stored.enhancedPrompt, ENHANCED);
  assert.equal(stored.promptSource, 'enhanced');
  assert.equal(stored.enhancementSource, 'gateway');
  assert.equal(stored.enhancementModel, GOOGLE_ROUTED);
  assert.equal(stored.enhancementRequestedModel, GOOGLE_PIN);
  assert.equal(stored.enhancementReportedModel, 'gemini-3.5-flash-lite');
  assert.equal(client.calls, 1);
  const names = manager.events.map((e) => e.name);
  assert.ok(names.indexOf('job-queued') < names.indexOf('enhancement-started'));
  assert.ok(names.indexOf('enhancement-started') < names.indexOf('enhancement-accepted'));
  assert.equal(eventsNamed(manager, 'enhancement-accepted').length, 1);
});

test('a late enhancement is discarded: dispatch before the gateway answers keeps the original', async (t) => {
  const client = gatewayStub({ delayMs: 150 });
  const manager = makeEnhancedManager(t, { client });
  const { job } = submitVideo(manager, 'late-1', { prompt: ORIGINAL });
  // Dispatch immediately, before the gateway answers.
  const r = manager.dispatchNext();
  assert.equal(r.dispatched, true);
  await manager.waitForEnhancement(job.id);
  const stored = manager.getJob(job.id);
  assert.equal(stored.promptSource, 'user');
  assert.equal(stored.enhancedPrompt, null);
  const discarded = eventsNamed(manager, 'enhancement-discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].reason, 'late');
});

test('a duplicate submit starts no second enhancement task', async (t) => {
  const client = gatewayStub({ delayMs: 20 });
  const manager = makeEnhancedManager(t, { client });
  const first = submitVideo(manager, 'dup-1', { prompt: ORIGINAL });
  const second = submitVideo(manager, 'dup-1', { prompt: ORIGINAL });
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  await manager.waitForEnhancement(first.job.id);
  assert.equal(client.calls, 1);
  assert.equal(eventsNamed(manager, 'enhancement-started').length, 1);
  assert.equal(eventsNamed(manager, 'job-queued').length, 1);
});

test('sandbox without a covering authorization never attempts enhancement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-enh-unauth-'));
  const store = new AuthorizationStore({
    filePath: path.join(dir, 'gateway-authorizations.json'),
    auditPath: path.join(dir, 'gateway-authorization-audit.log'),
    component: 'test',
  });
  const client = gatewayStub();
  const policy = buildGatewayPolicy({ environment: 'sandbox', authorizationStore: store });
  const manager = makeEnhancedManager(t, { client, policy });
  const { job } = submitVideo(manager, 'unauth-1', { prompt: ORIGINAL, params: { jobId: 'nova-job-11111111-1111-1111-1111-111111111111' } });
  await manager.waitForEnhancement(job.id);
  assert.equal(client.calls, 0, 'the gateway must not be called without authorization');
  assert.equal(manager.getJob(job.id).promptSource, 'user');
  const discarded = eventsNamed(manager, 'enhancement-discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].reason, 'unauthorized');
});

test('empty, excessive and credential-pattern enhancements are rejected; the original stands', async (t) => {
  for (const [label, content, reason] of [
    ['empty', '', 'empty'],
    ['excessive', 'x'.repeat(4001), 'too-long'],
    ['credential-pattern', `Use this key sk-abcdefgh12345678 in the scene.`, 'data-guard'],
  ]) {
    const client = gatewayStub({ content });
    const manager = makeEnhancedManager(t, { client });
    const { job } = submitVideo(manager, `rej-${label}`, { prompt: ORIGINAL });
    await manager.waitForEnhancement(job.id);
    const stored = manager.getJob(job.id);
    assert.equal(stored.promptSource, 'user', label);
    assert.equal(stored.enhancedPrompt, null, label);
    assert.equal(stored.prompt, ORIGINAL, label);
    assert.equal(eventsNamed(manager, 'enhancement-failed')[0].reason, reason, label);
    assert.equal(eventsNamed(manager, 'enhancement-discarded')[0].reason, reason, label);
  }
});

test('a 4,000-character enhancement is accepted (the boundary is inclusive)', async (t) => {
  const client = gatewayStub({ content: 'x'.repeat(4000) });
  const manager = makeEnhancedManager(t, { client });
  const { job } = submitVideo(manager, 'edge-4000', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  assert.equal(manager.getJob(job.id).promptSource, 'enhanced');
});

test('metadata is deferred: no metadata fields exist and no metadata call is made', async (t) => {
  const calls = [];
  const client = gatewayStub({ calls });
  const manager = makeEnhancedManager(t, { client });
  const { job } = submitVideo(manager, 'meta-1', { prompt: ORIGINAL });
  // (1) The fresh record carries no metadata field at all.
  assert.equal('metadata' in job, false);
  assert.equal('metadataSource' in job, false);
  await manager.waitForEnhancement(job.id);
  // (2) Exactly one gateway call, carrying only the prompt — no second
  // metadata fetch.
  assert.equal(calls.length, 1);
  assert.equal(calls[0], ORIGINAL);
  // (3) The stored record after enhancement still carries no metadata.
  const stored = manager.getJob(job.id);
  assert.equal('metadata' in stored, false);
  assert.equal('metadataSource' in stored, false);
  assert.equal(stored.enhancementSource, 'gateway');
});

test('flag OFF means zero gateway requests', async (t) => {
  const client = gatewayStub();
  const manager = makeManager(t, { enhancement: { enabled: false, client, policy: devPolicy() } });
  const { job } = submitVideo(manager, 'off-1', { prompt: ORIGINAL });
  await sleep(50);
  assert.equal(client.calls, 0);
  assert.equal(manager.pendingEnhancement(job.id), null);
  assert.equal(manager.events.filter((e) => e.name.startsWith('enhancement-')).length, 0);
  assert.equal(manager.getJob(job.id).promptSource, 'user');
});

test('direct-Gemini fallback: gateway failure falls through with the documented identities', async (t) => {
  const direct = directGeminiStub();
  const manager = makeEnhancedManager(t, { client: throwingGatewayStub(), directGemini: direct });
  const { job } = submitVideo(manager, 'dg-1', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  const stored = manager.getJob(job.id);
  assert.equal(stored.promptSource, 'enhanced');
  assert.equal(stored.enhancementSource, 'direct-gemini');
  assert.equal(stored.enhancementModel, 'google/gemini-3.5-flash');
  assert.equal(stored.enhancementRequestedModel, null);
  assert.equal(stored.enhancementReportedModel, null);
  assert.equal(stored.enhancedPrompt, 'Direct Gemini enhancement of the prompt.');
  assert.equal(direct.calls, 1);
});

test('chain shortens to the raw prompt when the gateway fails and no fallback is configured', async (t) => {
  const manager = makeEnhancedManager(t, { client: throwingGatewayStub(), directGemini: null });
  const { job } = submitVideo(manager, 'dg-2', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  const stored = manager.getJob(job.id);
  assert.equal(stored.promptSource, 'user');
  assert.equal(stored.enhancedPrompt, null);
  assert.equal(stored.prompt, ORIGINAL);
  assert.equal(eventsNamed(manager, 'enhancement-failed')[0].reason, 'gateway-failed');
});

test('no gateway client + direct Gemini configured: the fallback is used directly', async (t) => {
  const direct = directGeminiStub();
  const manager = makeEnhancedManager(t, { client: null, directGemini: direct });
  const { job } = submitVideo(manager, 'dg-3', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  assert.equal(manager.getJob(job.id).enhancementSource, 'direct-gemini');
  assert.equal(direct.calls, 1);
});

test('an enhanced job dispatches its enhanced prompt; a user job dispatches its original', async (t) => {
  const client = gatewayStub();
  const manager = makeEnhancedManager(t, { client });
  const capturing = capturingExecutor();
  manager.registerExecutor('mock-t4', capturing);
  const { job: enhanced } = submitVideo(manager, 'disp-enh', { prompt: ORIGINAL });
  await manager.waitForEnhancement(enhanced.id);
  const r1 = manager.dispatchNext();
  assert.equal(r1.dispatched, true);
  assert.equal(capturing.received[0].prompt, ENHANCED);
  // The stored record still keeps the original.
  assert.equal(manager.getJob(enhanced.id).prompt, ORIGINAL);

  const failing = makeEnhancedManager(t, { client: throwingGatewayStub() });
  const capturing2 = capturingExecutor();
  failing.registerExecutor('mock-t4', capturing2);
  const { job: plain } = submitVideo(failing, 'disp-user', { prompt: ORIGINAL });
  await failing.waitForEnhancement(plain.id);
  const r2 = failing.dispatchNext();
  assert.equal(r2.dispatched, true);
  assert.equal(capturing2.received[0].prompt, ORIGINAL);
});

test('event order: job-queued exactly once, enhancement events after it', async (t) => {
  const client = gatewayStub({ delayMs: 30 });
  const manager = makeEnhancedManager(t, { client });
  const { job } = submitVideo(manager, 'order-1', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  const names = manager.events.filter((e) => e.jobId === job.id).map((e) => e.name);
  assert.equal(names.filter((n) => n === 'job-queued').length, 1);
  assert.ok(names.indexOf('job-queued') < names.indexOf('enhancement-started'));
  assert.ok(names.indexOf('enhancement-started') < names.indexOf('enhancement-accepted'));
});

test('existing jobs without the new fields still dispatch their original prompt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-old-job-'));
  const storePath = path.join(dir, 'gpu-manager.json');
  // Build a stored record the old way, then strip the new fields.
  const job = createJob({
    idempotencyKey: 'old-1',
    type: 'video',
    modelId: 'mock-video-v1',
    prompt: ORIGINAL,
    params: {},
    seq: 1,
    now: Date.now(),
  });
  for (const field of [
    'enhancedPrompt', 'promptSource', 'enhancementSource', 'enhancementModel',
    'enhancementRequestedModel', 'enhancementReportedModel', 'sandboxAuthorizationId',
  ]) delete job[field];
  const { defaultState } = await import('../src/store.js');
  const state = defaultState();
  state.seq = 1;
  state.jobs = { [job.id]: job };
  state.idempotency = { 'old-1': job.id };
  fs.writeFileSync(storePath, JSON.stringify(state));
  const { GpuManager } = await import('../src/gpu-manager.js');
  const manager = new GpuManager({ storePath, enhancement: { enabled: true, client: gatewayStub(), policy: devPolicy() } });
  const capturing = capturingExecutor();
  manager.registerExecutor('mock-t4', capturing);
  const r = manager.dispatchNext();
  assert.equal(r.dispatched, true);
  assert.equal(r.jobId, job.id);
  assert.equal(capturing.received[0].prompt, ORIGINAL);
});

test('production policy never enhances, even with the flag on at the manager level', async (t) => {
  const client = gatewayStub();
  const policy = buildGatewayPolicy({ environment: 'production' });
  const manager = makeEnhancedManager(t, { client, policy });
  const { job } = submitVideo(manager, 'prod-1', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  assert.equal(client.calls, 0);
  assert.equal(manager.getJob(job.id).promptSource, 'user');
  assert.equal(eventsNamed(manager, 'enhancement-discarded')[0].reason, 'production');
});
