// End-to-end integration: the REAL _worker.js under miniflare (in-memory
// D1, schema applied, never the production database) talking to the REAL
// API server over HTTP, with the fake controlled-test executor and a REAL
// ffmpeg-encoded 121-frame clip validated by the real §18 validator.
//
// Flow: POST /api/generate (controlled-test) -> Worker 202 slot-claimed
// -> API accepts via the executor status query -> operator fileReport
// with the real clip -> D1 scene succeeded -> Worker status succeeded
// -> Worker download returns the identical bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

import { createApiServer } from '../../api-server.js';
import { HttpD1Client } from '../d1-client.js';
import { FakeControlledExecutor } from '../fake-executor.js';
import { signApiCall } from '../auth.js';

const requireA2 = createRequire(new URL('../../../../a2-impl/package.json', import.meta.url));
const { Miniflare } = requireA2('miniflare');
const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SITE = 'http://test.invalid';

// workerd refuses any module path containing ".." relative to its
// starting directory (the process cwd). The suite runs from gpu-cloud,
// one level below the repo root where _worker.js lives, so the boot
// must start from the repo root — without this, the end-to-end test
// fails at Miniflare startup (the long-standing workerd error).
process.chdir(ROOT);
const TEST_SECRET = 'phase3-integration-secret';
const TEST_SIGNING_SECRET = 'phase3-integration-signing-secret';
const TEST_KEY = 'phase3-test-key';
const TEST_SALT = 'phase3-test-salt';

async function applySchema(db) {
  const schema = readFileSync(path.join(ROOT, 'd1/schema.sql'), 'utf8');
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

test('end-to-end: generate -> 202 -> accept -> fileReport -> succeeded -> download identical bytes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Encode a real 121-frame 1024x576 24fps clip (the §18 validator's
  // exact shape) for the completion channel.
  const clipPath = path.join(dir, 'scene-0.mp4');
  await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'testsrc=duration=5.04:size=1024x576:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-frames:v', '121', '-an', clipPath],
    { timeout: 60000 });
  const clipBytes = await readFile(clipPath);
  const clipSha = createHash('sha256').update(clipBytes).digest('hex');

  // The API's D1 client routes through miniflare's dispatchFetch; the
  // miniflare instance is created after the API server starts (the
  // Worker binding needs the API port), so the fetch target is a
  // mutable holder filled in once miniflare boots.
  let workerFetch = null;
  const fetchImpl = async (url, init) => {
    if (!workerFetch) throw new Error('miniflare not booted yet');
    const u = new URL(url);
    return workerFetch(SITE + u.pathname + u.search, init);
  };

  const apiDataDir = path.join(dir, 'api-data');
  // Seed a fresh runner heartbeat (Rev 4.9 §6 gate): in production the
  // runner's startup catch-up pass writes runner-health.json before the
  // API listens, so a submit-time gate always sees a fresh heartbeat.
  // Without it every submit is refused 503 storage-full on the missing
  // file — the same seeding the makeApi harness does.
  mkdirSync(apiDataDir, { recursive: true });
  const _hbNow = new Date().toISOString();
  writeFileSync(path.join(apiDataDir, 'runner-health.json'), JSON.stringify({
    lastSuccessfulSweepAt: _hbNow,
    lastAttemptAt: _hbNow,
    status: 'ok',
    objectsDeleted: 0,
    error: null,
  }));
  const api = createApiServer({
    mode: 'controlled-test',
    secret: TEST_SECRET,
    signingSecret: TEST_SIGNING_SECRET,
    port: 0,
    host: '127.0.0.1',
    dataDir: apiDataDir,
    // Controlled-test mode requires an explicitly supplied executor
    // (Rev 3 §C-1.4); without it construction refuses to start.
    executor: new FakeControlledExecutor(),
    d1Client: new HttpD1Client({
      workerOrigin: 'http://127.0.0.1:1',
      secret: TEST_SECRET,
      signingSecret: TEST_SIGNING_SECRET,
      fetchImpl,
    }),
    usageSource: async () => ({ readable: true, usageFraction: 0.1 }),
  });
  const { port: apiPort } = await api.start();
  t.after(() => api.stop());

  // No unauthenticated route exists — even health-check needs the secret.
  const unauth = await fetch(`http://127.0.0.1:${apiPort}/internal/health`);
  assert.equal(unauth.status, 401);
  const signed = await fetch(`http://127.0.0.1:${apiPort}/internal/health`, {
    headers: signApiCall(TEST_SECRET, TEST_SIGNING_SECRET, 'GET', '/internal/health', ''),
  });
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).status, 'ok');

  const mf = new Miniflare({
    root: ROOT,
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: path.join(ROOT, '_worker.js'),
    d1Databases: { NOVA_DB: `nova-api-e2e-${Date.now()}` },
    d1Persist: false,
    compatibilityDate: '2025-01-01',
    bindings: {
      NOVA_API_SECRET: TEST_SECRET,
      NOVA_SIGNING_SECRET: TEST_SIGNING_SECRET,
      NOVA_API_MODE: 'controlled-test',
      NOVA_TEST_KEY: TEST_KEY,
      NOVA_IP_HASH_SALT: TEST_SALT,
      NOVA_API_ORIGIN: `http://localhost:${apiPort}`,
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('NOVA_DB');
  await applySchema(db);
  workerFetch = (url, init) => mf.dispatchFetch(url, init);

  const jobId = `nova-job-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const headers = {
    'X-NOVA-JOB-TOKEN': token,
    'X-NOVA-TEST-KEY': TEST_KEY,
    'CF-Connecting-IP': '203.0.113.7',
  };
  const gen = await callWorker(mf, 'POST', '/api/generate', {
    body: {
      jobId, mode: 'single', prompt: 'A dragon over a golden kingdom',
      model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24,
    },
    headers,
  });
  assert.equal(gen.status, 202, `generate: HTTP ${gen.status} ${gen.text.slice(0, 300)}`);
  // Rev 3.2 §B-3.2.8: the 202 carries 'slot-claimed', or
  // 'executor-accepted' when the immediate acceptance probe already saw
  // acceptance (the fake executor defaults to QUEUED → accepted, so the
  // fast path is the usual outcome here).
  assert.ok(
    gen.json.dispatchState === 'slot-claimed' || gen.json.dispatchState === 'executor-accepted',
    `dispatchState: ${gen.json.dispatchState}`,
  );
  assert.equal(gen.json.status, 'queued');

  const executionId = `${jobId}:scene-0:attempt-1`;
  // Acceptance arrives asynchronously via the executor status query.
  await waitFor(() => {
    const e = api.dispatch.journalEntry(executionId);
    return e && e.state === 'dispatched' ? e : null;
  }, { label: 'executor acceptance (journal dispatched)' });

  // Operator completion channel: the real clip, validated by the real
  // §18 validator (ffprobe + full decode + SHA-256).
  const reported = await api.fileReport(executionId, {
    status: 'complete',
    output: clipBytes,
    outputName: 'scene-0.mp4',
  });
  assert.equal(reported.filed, true, JSON.stringify(reported));

  // The finaliser is asynchronous (validate → store → D1): poll the D1
  // scene row until it is succeeded with the recorded SHA-256.
  const sceneRow = await waitFor(async () => {
    const row = await db.prepare(
      'SELECT status, output_ref FROM scenes WHERE job_id = ? AND scene_index = 0 AND attempt = 1',
    ).bind(jobId).first();
    return row && row.status === 'succeeded' ? row : null;
  }, { label: 'D1 scene succeeded' });
  assert.ok(sceneRow.output_ref, 'output reference recorded in D1');
  const jobRow = await db.prepare('SELECT data FROM jobs WHERE id = ?').bind(jobId).first();
  const jobData = JSON.parse(jobRow.data);
  assert.equal(jobData.status, 'succeeded');
  // §18.4: the SHA-256 is recorded on the API-process execution record.
  assert.equal(api.dispatch.journalEntry(executionId).sha256, clipSha);

  // Worker status: succeeded with a download URL.
  const st = await waitFor(async () => {
    const r = await callWorker(mf, 'GET', `/api/status?jobId=${jobId}`, { headers });
    return r.json && r.json.status === 'succeeded' ? r : null;
  }, { label: 'Worker status succeeded' });
  assert.equal(typeof st.json.downloadUrl, 'string');

  // Worker download: the identical bytes, streamed from the API process.
  const dlRes = await mf.dispatchFetch(
    SITE + `/api/download?jobId=${jobId}&scene=0`,
    { method: 'GET', headers },
  );
  assert.equal(dlRes.status, 200, `download: HTTP ${dlRes.status}`);
  assert.ok((dlRes.headers.get('Content-Disposition') || '').includes('attachment'));
  const dlBytes = Buffer.from(await dlRes.arrayBuffer());
  assert.equal(dlBytes.length, clipBytes.length);
  assert.equal(createHash('sha256').update(dlBytes).digest('hex'), clipSha, 'downloaded bytes are identical to the validated clip');

  // The API journal agrees with D1: the execution is dispatched and
  // the manager job holds the stored output.
  const entry = api.dispatch.journalEntry(executionId);
  assert.equal(entry.state, 'dispatched');
  const managerJob = api.manager.getJob(entry.managerJobId);
  assert.ok(managerJob.outputRef, 'manager job holds the output reference');
});
