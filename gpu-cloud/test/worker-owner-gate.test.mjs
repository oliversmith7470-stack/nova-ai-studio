// Worker-side owner-token gate + audience + activation preflight,
// through the ACTUAL Worker boundary (Miniflare + a real production API
// server). No mocks of the Worker or the API: the request goes through
// dispatchFetch to the real _worker.js, which calls the real API over
// HTTP, which dispatches to the real LTX executor (no transport, no
// Kaggle call, no spend — the executor builds the package locally and
// waits for a fileReport that never comes).
//
// What is proven here:
//   - a personal job reaches the personal executor (202, D1 job carries
//     the Worker-asserted ownerTokenId, the API journal carries the
//     audience + attestation, the LTX package is built);
//   - missing / wrong / revoked owner tokens are 401 and create NO job;
//   - a public request cannot become personal (a valid owner token does
//     not upgrade it; an ownerTokenId field is rejected as unknown);
//   - an unknown audience fails closed (400);
//   - the kill-switch blocks the personal path (503, no job);
//   - the personal flag off blocks the personal path (503, no job);
//   - the capacity preflight is verified through the Worker boundary
//     (tampered / stale / wrong-nonce / wrong-audience / inconsistent
//     responses are 503 with no submit attempt and no job; a good
//     response lets the submit be attempted);
//   - an unreachable API is 503 with no job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, before, after } from 'node:test';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Miniflare lives in a2-impl/node_modules (the workerd install); resolve
// it the same way api-worker.test.mjs does.
const requireA2 = createRequire(new URL('../../a2-impl/package.json', import.meta.url));
const { Miniflare } = requireA2('miniflare');

import { createApiServer } from '../src/api-server.js';
import { HttpD1Client } from '../src/api-server/d1-client.js';
import { createStorage } from '../src/storage/index.js';
import { verifyWorkerAuth } from '../src/api-server/auth.js';
import { ApiStateStore } from '../src/api-server/state-store.js';
import { SqliteNonceStore } from '../src/api-server/nonce-store.js';
import { signCapacityResponse } from '../src/api-server/activation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'http://test.invalid';

// workerd refuses any module path containing ".." relative to its
// starting directory (the process cwd). The suite runs from gpu-cloud,
// one level below the repo root where _worker.js lives, so the boot
// must start from the repo root. (Same root cause as the pre-existing
// api-worker.test.mjs workerd startup failure.)
process.chdir(ROOT);
const TEST_SECRET = 'worker-gate-secret';
const TEST_SIGNING_SECRET = 'worker-gate-signing-secret';
const TEST_OWNER_TOKEN = 'worker-gate-owner-token-value';
const TEST_OWNER_TOKEN_REVOKED = 'worker-gate-owner-token-old-value';
const TEST_OWNER_TOKEN_ID = 'owner-token-v1';
const TEST_SALT = 'worker-gate-salt';

async function applySchema(db) {
  const schema = fs.readFileSync(path.join(ROOT, 'd1/schema.sql'), 'utf8');
  const noComments = schema.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const stmt of noComments.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

async function callWorker(mf, method, urlPath, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await mf.dispatchFetch(SITE + urlPath, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function writeActivationConf(dir, personalFlag) {
  const p = path.join(dir, 'activation.conf');
  fs.writeFileSync(p, `NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=${personalFlag}\n`, 'utf8');
  return p;
}

function seedHeartbeat(dir) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'runner-health.json'), JSON.stringify({
    lastSuccessfulSweepAt: now,
    lastAttemptAt: now,
    status: 'ok',
    objectsDeleted: 0,
    error: null,
  }));
}

// Boot a real production API server + a real Miniflare Worker, sharing
// one D1 (the API's HttpD1Client routes through mf.dispatchFetch).
// apiOriginOverride replaces the API origin (stub / dead-port boots).
async function bootProduction({ personalFlag = true, apiOriginOverride = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-worker-gate-'));
  const confPath = writeActivationConf(dir, personalFlag);
  const storeRoot = path.join(dir, 'store');
  fs.mkdirSync(storeRoot, { recursive: true });
  const storage = createStorage({
    rootDir: storeRoot,
    capacityProbe: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
  });
  seedHeartbeat(dir);
  let workerFetch = null;
  const fetchImpl = async (url, init) => {
    if (!workerFetch) throw new Error('miniflare not booted yet');
    const u = new URL(url);
    return workerFetch(SITE + u.pathname + u.search, init);
  };
  const api = createApiServer({
    mode: 'production',
    secret: TEST_SECRET,
    signingSecret: TEST_SIGNING_SECRET,
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    executor: null,
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    kaggleCredentialPresent: true,
    personalExecutor: 'kaggle-t4',
    activationConfigPath: confPath,
    storage,
    d1Client: new HttpD1Client({
      workerOrigin: 'http://127.0.0.1:1',
      secret: TEST_SECRET,
      signingSecret: TEST_SIGNING_SECRET,
      fetchImpl,
    }),
    usageSource: async () => ({ readable: true, usageFraction: 0.1 }),
  });
  const { port: apiPort } = await api.start();
  const apiOrigin = apiOriginOverride ?? `http://localhost:${apiPort}`;
  let mf;
  let db;
  try {
    mf = new Miniflare({
      root: ROOT,
      modules: true,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
      scriptPath: path.join(ROOT, '_worker.js'),
      d1Databases: { NOVA_DB: `nova-worker-gate-${Date.now()}-${randomUUID().slice(0, 8)}` },
      d1Persist: false,
      compatibilityDate: '2025-01-01',
      bindings: {
        NOVA_API_SECRET: TEST_SECRET,
        NOVA_SIGNING_SECRET: TEST_SIGNING_SECRET,
        NOVA_API_MODE: 'production',
        NOVA_OWNER_TOKEN: TEST_OWNER_TOKEN,
        NOVA_OWNER_TOKEN_ID: TEST_OWNER_TOKEN_ID,
        NOVA_IP_HASH_SALT: TEST_SALT,
        NOVA_API_ORIGIN: apiOrigin,
      },
    });
    const d1 = await mf.getD1Database('NOVA_DB');
    await applySchema(d1);
    db = d1;
  } catch (err) {
    // A failed boot must not leak the listening API server or the temp
    // dir — otherwise a later boot (or the runner's exit) hangs on it.
    if (mf) await mf.dispose().catch(() => {});
    await api.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  workerFetch = (url, init) => mf.dispatchFetch(url, init);
  return {
    api, mf, db, dir, apiPort,
    async cleanup() {
      await mf.dispose().catch(() => {});
      await api.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function jobRow(db, jobId) {
  const row = await db.prepare('SELECT data FROM jobs WHERE id = ?').bind(jobId).first();
  return row ? JSON.parse(row.data) : null;
}

function genBody(jobId, overrides = {}) {
  return {
    jobId,
    mode: 'single',
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    model: 'ltx-video-2b',
    frames: 121,
    resolution: '1024x576',
    fps: 24,
    audience: 'personal',
    ...overrides,
  };
}

let ipCounter = 0;
function genHeaders({ ownerToken = TEST_OWNER_TOKEN } = {}) {
  ipCounter += 1;
  const headers = {
    'X-NOVA-JOB-TOKEN': randomBytes(32).toString('hex'),
    'CF-Connecting-IP': `203.0.113.${ipCounter}`,
  };
  if (ownerToken !== null) headers['X-NOVA-OWNER-TOKEN'] = ownerToken;
  return headers;
}

describe('worker owner-token gate + personal path (production, flag on)', () => {
  let ctx;
  before(async () => { ctx = await bootProduction({ personalFlag: true }); });
  after(async () => { if (ctx) await ctx.cleanup(); });

  test('personal + valid owner token: 202, job reaches the personal executor', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders(),
    });
    assert.equal(res.status, 202, `generate: HTTP ${res.status} ${res.text.slice(0, 300)}`);
    assert.equal(res.json.dispatchState, 'slot-claimed');
    // The D1 job record carries the Worker-asserted identity — never a
    // request field (the request carried no ownerTokenId at all).
    const job = await jobRow(ctx.db, jobId);
    assert.ok(job, 'D1 job record exists');
    assert.equal(job.audience, 'personal');
    assert.equal(job.ownerTokenId, TEST_OWNER_TOKEN_ID);
    assert.equal(job.nonCommercialAttested, true);
    assert.equal(job.nonCommercialPurpose, 'proof');
    // The API journal entry carries the same audience + attestation.
    const entry = ctx.api.dispatch.journalEntry(`${jobId}:scene-0:attempt-1`);
    assert.ok(entry, 'journal entry exists');
    assert.equal(entry.audience, 'personal');
    assert.equal(entry.nonCommercialAttested, true);
    assert.equal(entry.nonCommercialPurpose, 'proof');
    assert.equal(entry.ownerTokenId, TEST_OWNER_TOKEN_ID);
    // The personal executor built the real LTX package (no transport,
    // no push — the package is built locally and the job waits for a
    // fileReport that never comes). The package dir is keyed by the
    // manager job id, so it is discovered by listing the packages dir.
    const packagesRoot = path.join(ctx.dir, 'packages');
    const pkgDir = await waitFor(async () => {
      try {
        const entries = fs.readdirSync(packagesRoot);
        if (entries.length === 0) return null;
        const dir = path.join(packagesRoot, entries[0]);
        const meta = JSON.parse(await readFile(path.join(dir, 'kernel-metadata.json'), 'utf8'));
        return meta.model_sources ? dir : null;
      } catch { return null; }
    }, { label: 'LTX package' });
    const meta = JSON.parse(await readFile(path.join(pkgDir, 'kernel-metadata.json'), 'utf8'));
    assert.ok(meta.model_sources.includes('marcelolmesilva/ltxv-2b-0.9.8-distilled.safetensors/pytorch/default/1'));
    assert.ok(meta.model_sources.includes('sanderland/flux.1-schnell/pytorch/hf/1'));
    assert.equal(meta.machine_shape, 'NvidiaTeslaT4');
    const notebook = JSON.parse(await readFile(path.join(pkgDir, 'notebook.ipynb'), 'utf8'));
    const text = notebook.cells.map((c) => c.source.join('')).join('\n');
    assert.ok(text.includes('LTXConditionPipeline.from_single_file'));
  });

  test('personal + missing owner token: 401, no job record', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders({ ownerToken: null }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.message, 'A valid owner token is required.');
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('personal + wrong owner token: 401, no job record', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders({ ownerToken: 'not-the-owner-token' }),
    });
    assert.equal(res.status, 401);
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('personal + revoked (previous-generation) owner token: 401, no job record', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders({ ownerToken: TEST_OWNER_TOKEN_REVOKED }),
    });
    assert.equal(res.status, 401);
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('public + valid owner token: 503 — a token never upgrades a public request', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId, { audience: 'public' }),
      headers: genHeaders(),
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'capacity_unavailable');
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('personal + a forged ownerTokenId field: 400 — identifiers are not authentication', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId, { ownerTokenId: 'owner-token-v999' }),
      headers: genHeaders(),
    });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /Unexpected field: ownerTokenId/);
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('unknown audience fails closed (400)', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId, { audience: 'owner' }),
      headers: genHeaders(),
    });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /audience must be public or personal/);
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('personal + a non-commercial purpose outside the five: 400', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId, { nonCommercialPurpose: 'monetised-film' }),
      headers: genHeaders(),
    });
    assert.equal(res.status, 400);
    assert.equal(await jobRow(ctx.db, jobId), null);
  });

  test('kill-switch engaged: personal + valid token is 503, no job record', async () => {
    const { engageKillSwitch, disengageKillSwitch } = await import('../src/kill-switch.js');
    engageKillSwitch(ctx.api.manager.store.state, 'test', Date.now());
    try {
      const jobId = `nova-job-${randomUUID()}`;
      const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
        body: genBody(jobId),
        headers: genHeaders(),
      });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, 'capacity_unavailable');
      assert.equal(await jobRow(ctx.db, jobId), null);
    } finally {
      disengageKillSwitch(ctx.api.manager.store.state, 'test', Date.now());
    }
  });
});

describe('personal path with the personal flag off', () => {
  let ctx;
  before(async () => { ctx = await bootProduction({ personalFlag: false }); });
  after(async () => { if (ctx) await ctx.cleanup(); });

  test('personal + valid token + flag off: 503, no job record', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders(),
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'capacity_unavailable');
    assert.equal(await jobRow(ctx.db, jobId), null);
  });
});

// -- Capacity preflight against a stub API ---------------------------------
// The stub is a stand-in API process: it verifies the Worker's request
// auth with the REAL verifyWorkerAuth (two-secret + SQLite nonce store),
// then answers /internal/capacity with a signed response whose shape is
// driven by `stubMode`. It records every request, so the tests prove
// whether the preflight let the submit be attempted or stopped it cold.

let stubMode = 'good';
let stubRequests = [];

function stubCapacityBody({ audience, requestNonce, mode }) {
  const base = {
    mode: 'production',
    publicProductionAuthorised: false,
    publicProductionActivated: false,
    personalProductionAuthorised: true,
    personalProductionActivated: true,
    killSwitchEngaged: false,
    reason: 'not-activated',
    requestedAudience: audience,
    requestNonce,
  };
  if (mode === 'wrong-audience') base.requestedAudience = 'public';
  if (mode === 'wrong-nonce') base.requestNonce = '0'.repeat(32);
  if (mode === 'inconsistent') base.personalProductionActivated = false;
  if (mode === 'kill-switch') {
    base.personalProductionAuthorised = false;
    base.personalProductionActivated = true;
    base.killSwitchEngaged = true;
    base.personalReason = 'kill-switch-engaged';
  }
  return base;
}

async function bootStubApi(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-stub-api-'));
  const apiState = new ApiStateStore(path.join(dir, 'api-state.json'));
  const nonceStore = new SqliteNonceStore(path.join(dir, 'nonces.db'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathWithQuery = url.pathname + url.search;
    stubRequests.push(`${req.method} ${pathWithQuery}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    // The stub verifies the Worker's request with the real verifier.
    const auth = verifyWorkerAuth(req, req.method, pathWithQuery, bodyText, {
      transportSecrets: [TEST_SECRET],
      signingSecrets: [TEST_SIGNING_SECRET],
      apiState,
      nonceStore,
    }, { processStartMs: 0 });
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorised' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/internal/capacity') {
      const audience = url.searchParams.get('audience');
      const requestNonce = url.searchParams.get('requestNonce');
      const body = stubCapacityBody({ audience, requestNonce, mode: stubMode });
      const bodyTextOut = JSON.stringify(body);
      const signingSecret = stubMode === 'tampered' ? 'wrong-signing-secret' : TEST_SIGNING_SECRET;
      const timestamp = stubMode === 'stale'
        ? String(Math.floor(Date.now() / 1000) - 60)
        : null;
      const { timestamp: ts, signature } = signCapacityResponse({
        signingSecret,
        requestNonce,
        bodyText: bodyTextOut,
        timestamp,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-NOVA-Capacity-Timestamp': ts,
        'X-NOVA-Capacity-Signature': signature,
      });
      res.end(bodyTextOut);
      return;
    }
    // The stub has no submit: a submit attempt is recorded and 404'd.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server, port, dir,
    async cleanup() {
      await new Promise((resolve) => server.close(resolve));
      try { nonceStore.close(); } catch { /* ignore */ }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('capacity preflight through the Worker boundary (stub API)', () => {
  let ctx;
  let stub;
  before(async () => {
    stub = await bootStubApi();
    ctx = await bootProduction({ personalFlag: true, apiOriginOverride: `http://localhost:${stub.port}` });
  });
  after(async () => {
    if (ctx) await ctx.cleanup();
    if (stub) await stub.cleanup();
  });

  test('good signed response: the preflight passes and the submit is attempted', async () => {
    stubMode = 'good';
    stubRequests = [];
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders(),
    });
    // The stub has no submit endpoint, so the dispatch fails — but the
    // preflight PASSED: the submit was attempted, and the job record
    // was created before the submit.
    assert.equal(res.status, 503);
    assert.ok(stubRequests.some((r) => r.startsWith('POST /internal/submit')), 'submit was attempted');
    assert.ok(await jobRow(ctx.db, jobId), 'D1 job record exists');
  });

  for (const mode of ['tampered', 'stale', 'wrong-nonce', 'wrong-audience', 'inconsistent', 'kill-switch']) {
    test(`capacity response ${mode}: 503 capacity-unavailable, no submit attempt, no job record`, async () => {
      stubMode = mode;
      stubRequests = [];
      const jobId = `nova-job-${randomUUID()}`;
      const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
        body: genBody(jobId),
        headers: genHeaders(),
      });
      assert.equal(res.status, 503, `mode ${mode}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
      assert.equal(res.json.error, 'capacity_unavailable');
      assert.ok(!stubRequests.some((r) => r.startsWith('POST /internal/submit')), `mode ${mode}: submit must not be attempted`);
      assert.equal(await jobRow(ctx.db, jobId), null, `mode ${mode}: no job record`);
    });
  }
});

describe('capacity preflight with an unreachable API', () => {
  let ctx;
  before(async () => {
    // No API server at all: the origin is a closed port.
    ctx = await bootProduction({ personalFlag: true, apiOriginOverride: 'http://localhost:1' });
  });
  after(async () => { if (ctx) await ctx.cleanup(); });

  test('personal + valid token + unreachable API: 503, no job record', async () => {
    const jobId = `nova-job-${randomUUID()}`;
    const res = await callWorker(ctx.mf, 'POST', '/api/generate', {
      body: genBody(jobId),
      headers: genHeaders(),
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'capacity_unavailable');
    assert.equal(await jobRow(ctx.db, jobId), null);
  });
});
