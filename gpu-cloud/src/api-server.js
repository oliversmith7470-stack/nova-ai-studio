// NOVA AI Studio — Phase 3 API process (NEW — Rev 2 §2, §23;
// Rev 3 §C-6: `gpu-cloud/src/api-server.js`).
//
// The small Node HTTP server that owns one GpuManager instance. It is
// the ONLY process that touches the manager store, the storage engine,
// and the sweep/reconciliation timers. It exposes exactly the internal
// endpoints in Rev 2 §3.4, all requiring the API secret + HMAC signing
// (§11, Rev 3 §C-1.10). It never serves browsers directly. It never
// holds the Gemini key, a job token, or any Cloudflare secret. It never
// touches D1 directly — every D1 need goes through the Worker's signed
// /internal/d1-apply + /internal/d1-read endpoints (Rev 3 §C-1.1).
//
// Controlled-test mode ONLY in Phase 3. There is no production behaviour
// here: in production mode the process starts with NO controlled-test
// executor registered and every submit is refused with no-capacity
// (Rev 2 §6.4, Rev 3 §C-1.4). No deployment, no systemd installation,
// no live-database writes, no paid GPU dispatch. The draft systemd unit
// (gpu-cloud/systemd/nova-api-server.service) is a FILE ONLY — it is
// not installed or enabled by anything here.
//
// Usage (controlled test):
//   NOVA_API_SECRET=<secret> NOVA_WORKER_ORIGIN=http://127.0.0.1:<port>
//   NOVA_API_MODE=controlled-test node gpu-cloud/src/api-server.js
//
// Configuration is env-only for the CLI entry; createApiServer(config)
// takes the same values programmatically (tests inject a fake D1 client,
// a fake executor, and a stub usage source).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { GpuManager } from './gpu-manager.js';
import { createStorage } from './storage/index.js';
import { ApiStateStore } from './api-server/state-store.js';
import { verifyWorkerAuth } from './api-server/auth.js';
import { HttpD1Client } from './api-server/d1-client.js';
import { DispatchManager } from './api-server/dispatch.js';
import { SweepRunner } from './api-server/sweep.js';
import { ReconciliationRunner } from './api-server/reconcile.js';
import { FakeControlledExecutor } from './api-server/fake-executor.js';
import { validateMp4 } from './api-server/validation.js';
import { revokeSecret as doRevokeSecret } from './api-server/revocation.js';
import {
  API_SERVER_VERSION,
  ACK_WINDOW_MS,
  SWEEP_INTERVAL_MS,
  RECONCILE_INTERVAL_MS,
  RETENTION_ENABLED,
  RETENTION_DAYS,
} from './api-server/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_DATA_DIR = path.join(__dirname, '..', 'data', 'api');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MAX_BODY_BYTES = 256 * 1024;

export function routeInventory() {
  // Rev 3.2 §B-3.2.11: four attributes per entry, generated from the
  // shipped code (this table is built from the route table below).
  return [
    { method: 'GET', pattern: '/internal/health', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 5 s Worker timeout applies client-side' },
    { method: 'POST', pattern: '/internal/submit', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 256 KB body limit, 10 s Worker timeout applies client-side' },
    { method: 'GET', pattern: '/internal/status', auth: 'API-secret + HMAC', middleware: 'HMAC verify (empty body), 5 s Worker timeout applies client-side' },
    { method: 'GET', pattern: '/internal/download', auth: 'API-secret + HMAC', middleware: 'HMAC verify (empty body), 30 s idle timeout applies client-side' },
    { method: 'POST', pattern: '/internal/cancel', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 256 KB body limit, 5 s Worker timeout applies client-side' },
  ];
}

export function createApiServer(config = {}) {
  const mode = config.mode === 'controlled-test' ? 'controlled-test' : 'production';
  const secret = config.secret ?? process.env.NOVA_API_SECRET ?? '';
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('NOVA_API_SECRET is required');
  }
  const secretPrevious = config.secretPrevious ?? process.env.NOVA_API_SECRET_PREVIOUS ?? '';
  const dataDir = config.dataDir ?? process.env.NOVA_API_DATA_DIR ?? DEFAULT_API_DATA_DIR;
  const now = config.now ?? (() => Date.now());

  const apiState = new ApiStateStore(path.join(dataDir, 'api-state.json'));

  // D1 client: the Worker origin is required — the API process cannot
  // function without its D1 callbacks (it never touches D1 directly).
  const d1Client = config.d1Client ?? new HttpD1Client({
    workerOrigin: config.workerOrigin ?? process.env.NOVA_WORKER_ORIGIN ?? '',
    secret,
    timeoutMs: config.d1TimeoutMs ?? 5000,
  });

  // Manager + storage (local store behind the API process, Rev 2 §2).
  const manager = new GpuManager({
    storePath: config.storePath ?? path.join(dataDir, 'gpu-manager.json'),
    now,
    config: { maxQueueDepth: 100 },
  });
  const storage = config.storage ?? createStorage({
    rootDir: config.storageRootDir ?? path.join(dataDir, 'store'),
    clock: now,
  });
  manager.attachStorage(storage);

  // Executor registry (Rev 3 §C-1.4 gate 3): controlled-test mode
  // registers ONLY the controlled-test executor. Production mode
  // registers NO executor for ltx-video-2b — and refuses to start if a
  // controlled-test executor is configured.
  const executor = config.executor ?? new FakeControlledExecutor();
  if (mode === 'production' && executor && executor.id === 'controlled-test-ltx') {
    throw new Error('refusing to start: a controlled-test executor is configured in production mode (Rev 3 §C-1.4)');
  }
  if (mode === 'controlled-test') {
    if (!executor || executor.id !== 'controlled-test-ltx') {
      throw new Error('refusing to start: controlled-test mode requires the controlled-test executor only (Rev 3 §C-1.4)');
    }
    manager.registerProvider({
      id: 'controlled-test-ltx',
      kind: 'kaggle',
      label: 'Controlled-test LTX executor (fake, Phase 3 only)',
      gpuType: 'NVIDIA T4 (simulated)',
      vramGb: 16,
      models: ['ltx-video-2b'],
      costModel: { type: 'free', perSecondUsd: 0 },
      availabilityWindow: { type: 'always', description: 'Controlled test only — not public capacity.' },
      maxConcurrentJobs: 1,
      connected: true,
      status: 'available',
    });
    manager.registerExecutor('controlled-test-ltx', executor);
  }

  const dispatch = new DispatchManager({
    manager,
    executor,
    d1Client,
    apiState,
    mode,
    ackWindowMs: config.ackWindowMs ?? ACK_WINDOW_MS,
    ackPollMs: config.ackPollMs ?? 1000,
    validateOutput: config.validateOutput ?? validateMp4,
    now,
  });

  const sweep = new SweepRunner({
    manager,
    d1Client,
    apiState,
    dispatch,
    usageSource: config.usageSource ?? null,
    // Q3 APPROVED 25 Nov 2026 ~18:21 WAT: retention ENABLED, 30 days.
    // Rev 2 §16.1. Config overrides exist only for tests (disabled-path
    // verification); production always uses the approved constants.
    retentionEnabled: config.retentionEnabled ?? RETENTION_ENABLED,
    retentionDays: config.retentionDays ?? RETENTION_DAYS,
    now,
    onBeforeComponent: config.onBeforeComponent ?? null,
    onBeforeDeleteRows: config.onBeforeDeleteRows ?? null,
  });

  const reconcile = new ReconciliationRunner({
    manager,
    d1Client,
    apiState,
    dispatch,
    now,
  });

  const startedAt = Date.now();
  const host = config.host ?? process.env.NOVA_API_HOST ?? '127.0.0.1';
  const port = config.port ?? Number(process.env.NOVA_API_PORT ?? 8788);
  let server = null;
  let sweepTimer = null;
  let reconcileTimer = null;

  async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function send(res, status, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  async function handle(req, res) {
    const requestId = randomUUID();
    const url = new URL(req.url, 'http://localhost');
    const pathWithQuery = url.pathname + url.search;
    try {
      // No unauthenticated route exists on this process — every route,
      // including health-check, requires the secret + HMAC (Rev 2 §3.4).
      const isGet = req.method === 'GET';
      const bodyText = isGet ? '' : await readBody(req);
      const auth = verifyWorkerAuth(req, req.method, pathWithQuery, bodyText,
        [secret, secretPrevious], apiState);
      if (!auth.ok) {
        console.error(`[api-server] auth rejected step ${auth.step} requestId=${requestId} ${req.method} ${url.pathname}`);
        return send(res, 401, { error: 'unauthorised' });
      }
      let body = null;
      if (!isGet && bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          return send(res, 400, { error: 'invalid-json' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/internal/health') {
        return send(res, 200, {
          status: 'ok',
          version: API_SERVER_VERSION,
          uptimeMs: Date.now() - startedAt,
          manager: 'ready',
          mode,
        });
      }

      if (req.method === 'POST' && url.pathname === '/internal/submit') {
        const out = await dispatch.submitExecutions(body ?? {});
        return send(res, out.status, out.body);
      }

      if (req.method === 'GET' && url.pathname === '/internal/status') {
        const executionId = url.searchParams.get('executionId');
        const jobId = url.searchParams.get('jobId');
        if (executionId) {
          const entry = dispatch.executionStatus(executionId);
          if (!entry) return send(res, 404, { error: 'not-found' });
          return send(res, 200, entry);
        }
        if (jobId) {
          try {
            const parent = await dispatch.parentStatus(jobId);
            return send(res, 200, parent);
          } catch (err) {
            return send(res, 502, { error: 'd1-unavailable' });
          }
        }
        return send(res, 400, { error: 'executionId or jobId is required' });
      }

      if (req.method === 'GET' && url.pathname === '/internal/download') {
        return streamDownload(req, res, url);
      }

      if (req.method === 'POST' && url.pathname === '/internal/cancel') {
        if (!body || typeof body.jobId !== 'string' || typeof body.executionId !== 'string') {
          return send(res, 400, { error: 'jobId and executionId are required' });
        }
        const out = await dispatch.cancelExecution(body.jobId, body.executionId);
        return send(res, out.status, out.body);
      }

      return send(res, 404, { error: 'unknown-route' });
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        return send(res, 413, { error: 'body-too-large' });
      }
      console.error(`[api-server] ${req.method} ${url.pathname} failed requestId=${requestId}:`, err && err.message);
      if (!res.headersSent) return send(res, 500, { error: 'internal-error' });
      try { res.end(); } catch { /* ignore */ }
    }
  }

  async function streamDownload(req, res, url) {
    const jobId = url.searchParams.get('jobId');
    const executionId = url.searchParams.get('executionId');
    if (!jobId || !executionId) {
      return send(res, 400, { error: 'jobId and executionId are required' });
    }
    const entry = dispatch.journalEntry(executionId);
    if (!entry || entry.jobId !== jobId || !entry.managerJobId) {
      return send(res, 404, { error: 'not-found' });
    }
    const job = manager.getJob(entry.managerJobId);
    if (!job || !job.outputRef) return send(res, 404, { error: 'not-found' });
    // Access expiry (§9.1): never served after expiry, even if the
    // object still physically exists.
    if (job.outputRef.expiresAt !== null && job.outputRef.expiresAt !== undefined
      && job.outputRef.expiresAt <= now()) {
      return send(res, 410, { error: 'expired' });
    }
    let head;
    try {
      head = manager.headJobOutput(entry.managerJobId);
    } catch {
      return send(res, 404, { error: 'not-found' });
    }
    if (!head) return send(res, 404, { error: 'not-found' });
    let stream;
    try {
      stream = manager.getJobOutput(entry.managerJobId);
    } catch {
      return send(res, 404, { error: 'not-found' });
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'video/mp4',
      'Content-Length': head.sizeBytes,
      'Content-Disposition': `attachment; filename="nova-${jobId}-scene-${entry.sceneIndex}.mp4"`,
      'X-NOVA-Expires-At': String(head.expiresAt ?? ''),
    });
    stream.on('error', () => {
      try { res.end(); } catch { /* ignore */ }
    });
    stream.pipe(res);
  }

  async function start() {
    // Startup sequence (Rev 2 §9.2, §10.4): catch-up sweep FIRST, then
    // pending-mutation replay, then startup reconciliation — all BEFORE
    // accepting any new job (before listen).
    await sweep.runSweep({ reason: 'startup' });
    await dispatch.replayPendingMutations();
    await reconcile.runReconciliation({ source: 'startup' });
    server = http.createServer((req, res) => { void handle(req, res); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    // Independent timers (Rev 3.2 §B-3.2.7.2): a sweep failure does not
    // stop reconciliation, and vice versa. Unref'd: timers never hold
    // the process open on their own.
    const sweepIntervalMs = config.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    const reconcileIntervalMs = config.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    sweepTimer = setInterval(() => {
      sweep.runSweep({ reason: 'interval' }).catch((err) => {
        console.error('[api-server] sweep failed:', err && err.message);
      });
    }, sweepIntervalMs);
    reconcileTimer = setInterval(() => {
      reconcile.runReconciliation({ source: 'timer' }).catch((err) => {
        console.error('[api-server] reconciliation failed:', err && err.message);
      });
    }, reconcileIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
    return { host, port: server.address().port, mode };
  }

  async function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    dispatch.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  }

  return {
    config: { mode, host, port, dataDir },
    manager,
    executor,
    storage,
    dispatch,
    sweep,
    reconcile,
    apiState,
    d1Client,
    routeInventory,
    start,
    stop,
    get address() {
      return server ? server.address() : null;
    },
    // Operator surface (CLI-only, never HTTP — Rev 2 §11.6).
    fileReport: (executionId, report) => dispatch.fileReportForExecution(executionId, report),
    revokeSecret: ({ secret: s, revokedBy, reason }) => doRevokeSecret({
      apiState, managerStore: manager.store, secret: s, revokedBy, reason,
    }),
    manualResolve: (args) => reconcile.manualResolve(args),
    repairSceneSet: (jobId, args) => reconcile.repairSceneSet(jobId, args),
    runSweep: (args) => sweep.runSweep(args),
    runReconciliation: (args) => reconcile.runReconciliation(args),
  };
}

// CLI entry: `node gpu-cloud/src/api-server.js`. Env config only; no
// secrets are ever logged.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const api = createApiServer();
  api.start().then(({ host, port, mode }) => {
    console.log(`[api-server] listening on ${host}:${port} mode=${mode} version=${API_SERVER_VERSION}`);
  }).catch((err) => {
    console.error('[api-server] failed to start:', err && err.message);
    process.exit(1);
  });
  const shutdown = () => {
    api.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
