// NOVA FreeLLMAPI — non-interference tests (approved v5 design, NOVA-12/§7).
//
// The gateway integration must never: introduce a daily quota; introduce
// a gateway-dependent admission condition; introduce a new user-facing
// queue; change capacity calculations; change production model selection;
// change engine routing; change billing or cost calculations; depend on
// gateway availability for job completion; change public activation
// flags; turn gateway benchmarks into production routes. One test per
// item: a valid job is submitted with the gateway stub down, and the
// existing capacity and admission behaviour is identical to gateway-up.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { makeManager, submitVideo, sleep } from './support.mjs';
import { buildGatewayPolicy } from '../src/gateway-policy.js';
import { defaultState } from '../src/store.js';
import { createStorage } from '../src/storage/index.js';
import { estimateCostUsd } from '../src/providers.js';
import { createApiServer, routeInventory } from '../src/api-server.js';
import {
  makeApi,
  submitBody,
  seedJobForSubmit,
  execIdFor,
} from '../src/api-server/test/support.mjs';

const ORIGINAL = 'A dragon on a ridge at dawn.';
const ENHANCED = 'A grey dragon with ember cracks circles a mountain ridge at dawn, wings spread wide.';
const GOOGLE_PIN = 'google:gemini-3.5-flash-lite';
const GOOGLE_ROUTED = 'google/gemini-3.5-flash-lite';
// The scratch root is resolved from this file's location, not process.cwd():
// the suite is launched from gpu-cloud/ (full run) or the repo root
// (single-file run), and the harness resolves its own root from the
// script location — a cwd-relative expectation fails in one of the two.
const SCRATCH_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'benchmark-scratch');

function gatewayStub({ down = false } = {}) {
  let calls = 0;
  return {
    model: GOOGLE_PIN,
    get calls() { return calls; },
    async enhance() {
      calls += 1;
      if (down) throw new Error('gateway down');
      return { content: ENHANCED, routedVia: GOOGLE_ROUTED, reportedModel: 'gemini-3.5-flash-lite' };
    },
  };
}

function makeGatewayManager(t, { down, config = {} } = {}) {
  return makeManager(t, {
    config,
    enhancement: {
      enabled: true,
      client: gatewayStub({ down }),
      policy: buildGatewayPolicy({ environment: 'development' }),
    },
  });
}

// A capturing executor: records the prompt + model each dispatched job carries.
function capturingExecutor() {
  const received = [];
  return {
    received,
    start(job) {
      received.push({ id: job.id, prompt: job.prompt, modelId: job.modelId });
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

test('1. no daily quota: the queue limit is unchanged with the gateway down', async (t) => {
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down, config: { maxQueueDepth: 2 } });
    submitVideo(manager, `quota-${down}-1`, { prompt: ORIGINAL });
    submitVideo(manager, `quota-${down}-2`, { prompt: ORIGINAL });
    assert.throws(
      () => submitVideo(manager, `quota-${down}-3`, { prompt: ORIGINAL }),
      (err) => err.name === 'QueueFullError',
      `gateway ${down ? 'down' : 'up'}: the third submit must hit the queue limit, not a quota`,
    );
    assert.equal(manager.listJobs('queued').length, 2);
  }
});

test('2. no gateway-dependent admission: a valid submit is 202 with the gateway down', async () => {
  // Gateway down at the API level: the client points at a closed port.
  const { api, d1, cleanup } = await makeApi({
    environment: 'development',
    gatewayEnhancement: true,
    gatewayApiKey: 'test-key',
    gatewayBaseUrl: 'http://127.0.0.1:1',
  });
  try {
    const body = submitBody('noninterf-admission');
    seedJobForSubmit(d1, body);
    const res = await api.dispatch.submitExecutions(body);
    assert.equal(res.status, 202, 'admission must not depend on the gateway');
    const job = api.manager.getJobByKey(execIdFor(body));
    assert.ok(job);
    await sleep(100);
    assert.equal(api.manager.getJob(job.id).promptSource, 'user', 'no enhancement, but the job was admitted');
  } finally {
    await cleanup();
  }
});

test('3. no new user-facing queue: the store shape is unchanged', async (t) => {
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down });
    submitVideo(manager, `queue-${down}`, { prompt: ORIGINAL });
    await manager.waitForEnhancement(manager.listJobs('queued')[0].id);
    const keys = Object.keys(manager.store.state).sort();
    assert.deepEqual(keys, Object.keys(defaultState()).sort(), `gateway ${down ? 'down' : 'up'}: no new store top-level keys`);
    assert.equal(manager.listJobs('queued').length, 1);
  }
});

test('4. capacity calculations are unchanged with the gateway down', async (t) => {
  const usages = [];
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down });
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cap-store-'));
    t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
    manager.attachStorage(createStorage({ rootDir: storeRoot }));
    const before = manager.storageUsage();
    const { job } = submitVideo(manager, `cap-${down}`, { prompt: ORIGINAL });
    await manager.waitForEnhancement(job.id);
    const after = manager.storageUsage();
    usages.push({ before, after });
    assert.deepEqual(after, before, 'enhancement writes nothing to storage');
  }
  assert.deepEqual(usages[0], usages[1], 'capacity figures are identical gateway-up and gateway-down');
});

test('5. production model selection is unchanged with the gateway down', async (t) => {
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down });
    const capturing = capturingExecutor();
    manager.registerExecutor('mock-t4', capturing);
    const { job } = submitVideo(manager, `model-${down}`, { prompt: ORIGINAL });
    await manager.waitForEnhancement(job.id);
    const r = manager.dispatchNext();
    assert.equal(r.dispatched, true);
    assert.equal(r.providerId, 'mock-t4', `gateway ${down ? 'down' : 'up'}: same provider`);
    assert.equal(capturing.received[0].modelId, 'mock-video-v1');
  }
});

test('6. engine routing is unchanged with the gateway down', async (t) => {
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down });
    const capturing = capturingExecutor();
    manager.registerExecutor('mock-t4', capturing);
    const { job } = submitVideo(manager, `route-${down}`, { prompt: ORIGINAL });
    await manager.waitForEnhancement(job.id);
    manager.dispatchNext();
    // The engine sees the same model id and the same provider either way;
    // only the prompt text differs (enhanced vs original).
    assert.equal(capturing.received[0].modelId, 'mock-video-v1');
    assert.equal(
      capturing.received[0].prompt,
      down ? ORIGINAL : ENHANCED,
    );
  }
});

test('7. billing and cost calculations are unchanged with the gateway down', async (t) => {
  const costs = [];
  for (const down of [false, true]) {
    const manager = makeGatewayManager(t, { down });
    const provider = manager.registry.get('mock-t4');
    const { job } = submitVideo(manager, `cost-${down}`, { prompt: ORIGINAL });
    costs.push(estimateCostUsd(provider, job));
    await manager.waitForEnhancement(job.id);
    const r = manager.dispatchNext();
    assert.equal(r.dispatched, true);
    await manager.waitFor(job.id, 5000);
    const final = manager.getJob(job.id);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.cost.estimatedUsd, costs[down ? 1 : 0], 'the recorded estimate matches');
    assert.equal(final.cost.providerReportedUsd, 0, 'the mock is free either way');
  }
  assert.equal(costs[0], costs[1], 'estimated cost is identical gateway-up and gateway-down');
});

test('8. job completion does not depend on gateway availability', async (t) => {
  const manager = makeGatewayManager(t, { down: true });
  const { job } = submitVideo(manager, 'complete-down', { prompt: ORIGINAL });
  await manager.waitForEnhancement(job.id);
  const r = manager.dispatchNext();
  assert.equal(r.dispatched, true);
  await manager.waitFor(job.id, 5000);
  assert.equal(manager.getJob(job.id).status, 'succeeded');
  assert.equal(manager.getJob(job.id).promptSource, 'user');
});

test('9. public activation flags are unchanged by the gateway integration', async () => {
  // The gateway flags are separate config, not activation flags; the
  // route inventory is identical with the flag on or off; no activation
  // flag keys appear on the server config.
  const before = routeInventory();
  const { api, cleanup } = await makeApi({
    environment: 'development',
    gatewayEnhancement: true,
    gatewayApiKey: 'test-key',
    gatewayBaseUrl: 'http://127.0.0.1:1',
  });
  try {
    assert.deepEqual(routeInventory(), before);
    assert.equal('publicProductionActivated' in api.config, false);
    assert.equal('personalProductionActivated' in api.config, false);
    assert.equal(api.config.gatewayEnhancement, true);
    assert.equal(api.config.gatewayEnvironment, 'development');
  } finally {
    await cleanup();
  }
});

test('10. gateway benchmarks never become production routes', async () => {
  // The harness cannot reach the store or dispatch modules (asserted in
  // the benchmark tests). A benchmark run writes only its manifest under
  // the scratch root — no job record, no resultRef, nothing promotable.
  const execFileAsync = promisify(execFile);
  const harness = new URL('../scripts/freellmapi-benchmark.mjs', import.meta.url).pathname;
  const { stdout } = await execFileAsync('node', [harness, '--mode', 'image'], {
    env: { ...process.env, NOVA_GATEWAY_BENCHMARK: 'true', NOVA_GATEWAY_API_KEY: 'test-key' },
  });
  const manifestPath = /— (\S+benchmark\.json)$/.exec(stdout.trim())[1];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.reason, 'image-benchmark-blocked');
  const runDir = path.dirname(manifestPath);
  assert.ok(runDir.startsWith(SCRATCH_ROOT));
  assert.deepEqual(fs.readdirSync(runDir), ['benchmark.json']);
  assert.ok(!JSON.stringify(manifest).includes('resultRef'), 'the manifest carries no production job reference');
  fs.rmSync(runDir, { recursive: true, force: true });
});

// A stub HTTP gateway that answers correctly, for the end-to-end check
// that the server-level wiring calls the real gateway client. NOTE the
// honest race: the API submit dispatches synchronously in the same call,
// so dispatch always begins before the gateway round-trip returns — the
// enhancement is discarded 'late' and the job dispatches its original
// prompt. The enhancement path wins only when dispatch cannot begin
// immediately (see the manager-level dispatch tests). This test proves
// the wiring runs and the race resolves closed.
test('end-to-end: the API server calls the real gateway client; dispatch wins the race and the original stands', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': GOOGLE_ROUTED });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: ENHANCED } }],
        model: 'gemini-3.5-flash-lite',
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { api, d1, cleanup } = await makeApi({
    environment: 'development',
    gatewayEnhancement: true,
    gatewayApiKey: 'test-key',
    gatewayBaseUrl: baseUrl,
  });
  try {
    const body = submitBody('noninterf-e2e');
    seedJobForSubmit(d1, body);
    const res = await api.dispatch.submitExecutions(body);
    assert.equal(res.status, 202);
    const job = api.manager.getJobByKey(execIdFor(body));
    await api.manager.waitForEnhancement(job.id);
    // The real client was called exactly once, with the colon-form pin.
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0]).model, GOOGLE_PIN);
    // Dispatch began first, so the late enhancement was discarded and
    // the original prompt dispatched — fail closed, never a wrong prompt.
    const stored = api.manager.getJob(job.id);
    assert.equal(stored.promptSource, 'user');
    assert.equal(stored.enhancedPrompt, null);
    assert.equal(stored.prompt, 'A dragon on a ridge at dawn.');
    const discarded = api.manager.events.filter((e) => e.name === 'enhancement-discarded' && e.jobId === job.id);
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0].reason, 'late');
  } finally {
    await cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});
