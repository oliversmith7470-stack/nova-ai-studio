// Test support for the Phase 3 API process.
//
// MemoryD1Client mimics the Worker's /internal/d1-apply + /internal/d1-read
// semantics (see _worker.js handleD1Apply/handleD1Read) against in-memory
// maps, so the API process can be exercised without miniflare. It is a
// TEST DOUBLE — it is not a D1 connection, and the API process never
// opens one in production either (Worker-sole-D1-access, Rev 3 §C-1.1).

import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Write the harness default activation conf (both flags false) into the
// test's temp dir: 0440, owned by the test process, in a 0755 parent the
// test process owns — exactly what the §3.3 strict reader expects for
// the default fileAccess bundle below. The parent mode is set
// explicitly: mkdtemp gives the temp dir 0700, but a plain mkdir under
// umask 0007 would be 0770 (group-writable) and fail the read as
// `parent-writable`.
function writeDefaultActivationConf(dir) {
  const confDir = path.join(dir, 'conf');
  fs.mkdirSync(confDir, { recursive: true });
  fs.chmodSync(confDir, 0o755);
  const confPath = path.join(confDir, 'activation.conf');
  fs.writeFileSync(confPath, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  fs.chmodSync(confPath, 0o440);
  return confPath;
}

// Deterministic canonical job ID for a test label, in the Worker's
// `nova-job-<uuid>` shape (the API process rejects anything else).
export function canonicalJobId(label) {
  const hex = createHash('sha256').update(label).digest('hex').slice(0, 32);
  return `nova-job-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function execIdFor(body, sceneIndex = 0, attempt = 1) {
  return `${body.jobId}:scene-${sceneIndex}:attempt-${attempt}`;
}

import { createApiServer } from '../../api-server.js';
import { FakeControlledExecutor } from '../fake-executor.js';
import { D1AuthError } from '../d1-client.js';

const TERMINAL_SCENE = new Set(['succeeded', 'failed', 'timed-out', 'cancelled', 'expired']);

function aggregateFromScenes(scenes) {
  const latest = new Map();
  for (const s of scenes) {
    const cur = latest.get(s.scene_index);
    if (!cur || s.attempt > cur.attempt) latest.set(s.scene_index, s);
  }
  const statuses = [...latest.values()].map((s) => s.status);
  if (statuses.length === 0) return 'queued';
  if (statuses.some((s) => s === 'dispatched' || s === 'running')) return 'running';
  if (statuses.some((s) => s === 'queued') && statuses.some((s) => s === 'succeeded')) return 'running';
  if (statuses.every((s) => s === 'succeeded')) return 'succeeded';
  if (statuses.some((s) => s === 'succeeded')
    && statuses.some((s) => ['failed', 'timed-out', 'cancelled'].includes(s))) return 'partial_failed';
  if (statuses.every((s) => ['failed', 'timed-out', 'cancelled'].includes(s))) return 'failed';
  return 'queued';
}

export class MemoryD1Client {
  constructor() {
    this.jobs = new Map(); // id -> { id, data: string }
    this.scenes = new Map(); // `${jobId}|${sceneIndex}|${attempt}` -> row
    this.rateLimits = new Map(); // key -> { key, window_start, window_end, count, updated_at }
    this.applyRequests = new Map(); // requestId -> result
    // Q3 APPROVED 25 Nov 2026: retention ENABLED, 30 days. Mirrors the
    // Worker's env (NOVA_JOB_RECORD_RETENTION_ENABLED=true,
    // NOVA_JOB_RECORD_RETENTION_DAYS=30). Tests can set this false to
    // exercise the Worker's 403 retention-deletion-disabled gate.
    this.retentionEnabled = true;
    this.retentionDays = 30;
  }

  seedJob(jobData, sceneRows = []) {
    const id = jobData.id;
    this.jobs.set(id, { id, data: JSON.stringify(jobData) });
    for (const s of sceneRows) {
      this.scenes.set(`${id}|${s.scene_index}|${s.attempt}`, {
        job_id: id,
        scene_index: s.scene_index,
        attempt: s.attempt,
        execution_id: s.execution_id ?? null,
        provider_job_id: s.provider_job_id ?? null,
        status: s.status ?? 'queued',
        output_ref: s.output_ref ?? null,
        error: s.error ?? null,
        expires_at: s.expires_at ?? null,
        attempt_started_at: s.attempt_started_at ?? null,
        // Mirrors the Worker's scenes.updated_at (INTEGER ms): the
        // terminal-age measure for list-terminal-jobs. Defaults to now;
        // tests age it explicitly to make a job retention-eligible.
        updated_at: s.updated_at ?? Date.now(),
      });
    }
  }

  seedRateLimit(row) {
    this.rateLimits.set(row.key, {
      key: row.key,
      window_start: row.window_start,
      window_end: row.window_end,
      count: row.count ?? 0,
      updated_at: row.updated_at ?? Date.now(),
    });
  }

  _sceneRows(jobId) {
    return [...this.scenes.values()]
      .filter((s) => s.job_id === jobId)
      .sort((a, b) => a.scene_index - b.scene_index || a.attempt - b.attempt);
  }

  _recomputeAggregate(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const data = JSON.parse(job.data);
    if (data.status === 'cancelled' || data.status === 'expired') return;
    data.status = aggregateFromScenes(this._sceneRows(jobId));
    job.data = JSON.stringify(data);
  }

  // Mirrors HttpD1Client's positional signatures:
  // d1Apply(mutations, requestId), d1Read(op, params).
  async d1Apply(mutations, requestId = randomUUID()) {
    if (this.applyRequests.has(requestId)) return this.applyRequests.get(requestId);
    const results = [];
    for (const m of mutations) {
      if (m.type === 'scene-update') {
        const key = `${m.jobId}|${m.sceneIndex}|${m.attempt}`;
        const row = this.scenes.get(key);
        if (!row || TERMINAL_SCENE.has(row.status)) {
          results.push({ type: m.type, changes: 0 });
          continue;
        }
        row.status = m.status;
        if (m.error !== undefined) row.error = m.error;
        if (m.outputRef !== undefined) row.output_ref = m.outputRef;
        if (m.expiresAt !== undefined) row.expires_at = m.expiresAt;
        // The Worker sets scenes.updated_at on every scene transition;
        // list-terminal-jobs reads MAX(updated_at) as the terminal age.
        row.updated_at = Date.now();
        this._recomputeAggregate(m.jobId);
        results.push({ type: m.type, changes: 1 });
      } else if (m.type === 'mark-submitted') {
        let ok = true;
        let changes = 0;
        for (const ex of m.executions) {
          const key = `${m.jobId}|${ex.sceneIndex}|${ex.attempt}`;
          const row = this.scenes.get(key);
          if (!row || (row.provider_job_id && row.provider_job_id !== ex.providerJobId)) {
            ok = false;
            break;
          }
          row.provider_job_id = ex.providerJobId;
          changes += 1;
        }
        if (!ok) {
          results.push({ type: m.type, changes: 0 });
          continue;
        }
        // markSubmitted re-read verification (Rev 3.2 §B-3.2.3.1), and
        // the dispatchState transition the Worker performs on submit:
        // intent-recorded -> submitted (Worker handleD1Apply, same SQL).
        for (const ex of m.executions) {
          const row = this.scenes.get(`${m.jobId}|${ex.sceneIndex}|${ex.attempt}`);
          if (!row || row.provider_job_id !== ex.providerJobId) { ok = false; break; }
        }
        if (ok) {
          const job = this.jobs.get(m.jobId);
          if (job) {
            const data = JSON.parse(job.data);
            if (data.dispatchState === 'intent-recorded') {
              data.dispatchState = 'submitted';
              job.data = JSON.stringify(data);
            }
          }
        }
        results.push({ type: m.type, changes: ok ? changes : 0 });
      } else if (m.type === 'mark-expired') {
        let changes = 0;
        for (const s of m.scenes) {
          const row = this.scenes.get(`${m.jobId}|${s.sceneIndex}|${s.attempt}`);
          if (row && ['queued', 'dispatched', 'running'].includes(row.status)) {
            row.status = 'expired';
            changes += 1;
          }
        }
        results.push({ type: m.type, changes });
      } else if (m.type === 'delete-rows') {
        // Mirrors the Worker (handleD1Apply): explicit table + IDs only;
        // jobs/scenes refused 403 while retention is unconfirmed (Rev
        // 3.1 §A-3.1.3). Age eligibility is the caller's responsibility.
        const tables = { jobs: 'id', scenes: 'execution_id', rate_limits: 'key' };
        if (
          !Object.prototype.hasOwnProperty.call(tables, m.table)
          || !Array.isArray(m.ids) || m.ids.length === 0
          || m.ids.some((id) => typeof id !== 'string' || id.length === 0)
        ) {
          throw new Error('Invalid delete-rows mutation.');
        }
        if ((m.table === 'jobs' || m.table === 'scenes') && !this.retentionEnabled) {
          throw new D1AuthError('retention-deletion-disabled');
        }
        let changes = 0;
        if (m.table === 'jobs') {
          for (const id of m.ids) if (this.jobs.delete(id)) changes += 1;
        } else if (m.table === 'scenes') {
          for (const execId of m.ids) {
            for (const [key, row] of this.scenes) {
              if (row.execution_id === execId) {
                this.scenes.delete(key);
                changes += 1;
              }
            }
          }
        } else {
          // rate_limits: delete the named keys, counting rows actually
          // deleted (the real Worker deletes expired windows the same
          // way; previously this double always reported 0 changes).
          for (const key of m.ids) if (this.rateLimits.delete(key)) changes += 1;
        }
        results.push({ type: m.type, changes });
      } else if (m.type === 'repair-scene-row') {
        const totalRows = this.jobs.size + this.scenes.size;
        if (totalRows >= 100000) {
          results.push({ type: m.type, changes: 0 });
          continue;
        }
        const key = `${m.jobId}|${m.sceneIndex}|1`;
        if (this.scenes.has(key)) {
          results.push({ type: m.type, changes: 0 });
          continue;
        }
        const job = this.jobs.get(m.jobId);
        const data = job ? JSON.parse(job.data) : {};
        const exec = (data.sceneExecutions || []).find((x) => x.sceneIndex === m.sceneIndex && x.attempt === 1);
        this.scenes.set(key, {
          job_id: m.jobId,
          scene_index: m.sceneIndex,
          attempt: 1,
          execution_id: exec ? exec.executionId : `${m.jobId}:scene-${m.sceneIndex}:attempt-1`,
          provider_job_id: null,
          status: 'queued',
          output_ref: null,
          error: null,
          expires_at: null,
          attempt_started_at: null,
        });
        results.push({ type: m.type, changes: 1 });
      } else {
        throw new Error(`unknown mutation ${m.type}`);
      }
    }
    const result = { requestId, results };
    this.applyRequests.set(requestId, result);
    return result;
  }

  async d1Read(op, params = {}) {
    const { jobId, limit, beforeMs } = params;
    if (op === 'get-job') {
      const job = this.jobs.get(jobId);
      return job ? { ...job } : null;
    }
    if (op === 'list-scenes') {
      return this._sceneRows(jobId);
    }
    if (op === 'list-expired-scenes') {
      const nowMs = Date.now();
      return [...this.scenes.values()].filter((s) => s.expires_at
        && s.expires_at <= nowMs
        && ['queued', 'dispatched', 'running', 'succeeded'].includes(s.status));
    }
    if (op === 'list-pending-jobs') {
      const out = [];
      for (const job of this.jobs.values()) {
        const data = JSON.parse(job.data);
        if (['queued', 'running', 'partial_failed'].includes(data.status ?? 'queued')) {
          out.push({ id: job.id, data: job.data });
        }
        if (out.length >= (limit ?? 100)) break;
      }
      return out;
    }
    if (op === 'list-terminal-jobs') {
      // Mirrors the Worker (handleD1Read, impl-notes §10.4): terminal
      // jobs, oldest-terminal-first; terminalAtMs is MAX(scenes
      // .updated_at), null for a terminal job with no scene rows. With
      // beforeMs, null-terminalAtMs rows are excluded and only rows
      // with terminalAtMs < beforeMs are returned. Limit default 100,
      // clamped 1..500; invalid limit/beforeMs throws (Worker: 400).
      const n = limit === undefined || limit === null ? 100 : Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('Invalid limit.');
      let before = null;
      if (beforeMs !== undefined && beforeMs !== null) {
        before = Number(beforeMs);
        if (!Number.isInteger(before) || before < 0) throw new Error('Invalid beforeMs.');
      }
      const terminal = new Set(['succeeded', 'partial_failed', 'failed', 'cancelled', 'expired']);
      const out = [];
      for (const job of this.jobs.values()) {
        const data = JSON.parse(job.data);
        if (!terminal.has(data.status)) continue;
        const rows = this._sceneRows(job.id);
        const terminalAtMs = rows.length === 0
          ? null
          : Math.max(...rows.map((s) => s.updated_at ?? Date.now()));
        if (before !== null && (terminalAtMs === null || terminalAtMs >= before)) continue;
        out.push({ id: job.id, status: data.status, terminalAtMs });
      }
      out.sort((a, b) => {
        if (a.terminalAtMs === null && b.terminalAtMs === null) return 0;
        if (a.terminalAtMs === null) return -1;
        if (b.terminalAtMs === null) return 1;
        return a.terminalAtMs - b.terminalAtMs;
      });
      return out.slice(0, n);
    }
    if (op === 'list-expired-rate-limits') {
      // Mirrors the Worker (handleD1Read, impl-notes §10.4): expired
      // rows (window_end <= now), oldest expiry first. Limit default
      // 100, clamped 1..500; invalid limit throws (Worker: 400).
      const n = limit === undefined || limit === null ? 100 : Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('Invalid limit.');
      const nowMs = Date.now();
      return [...this.rateLimits.values()]
        .filter((r) => r.window_end <= nowMs)
        .sort((a, b) => a.window_end - b.window_end)
        .slice(0, n);
    }
    throw new Error(`unknown read op ${op}`);
  }

  async getJob(jobId) { return this.d1Read('get-job', { jobId }); }
  async listScenes(jobId) { return this.d1Read('list-scenes', { jobId }); }
  async listPendingJobs(limit = 100) { return this.d1Read('list-pending-jobs', { limit }); }
  async listExpiredScenes() { return this.d1Read('list-expired-scenes'); }
  async listTerminalJobs({ beforeMs, limit } = {}) {
    return this.d1Read('list-terminal-jobs', { beforeMs, limit });
  }
  async listExpiredRateLimits({ limit } = {}) {
    return this.d1Read('list-expired-rate-limits', { limit });
  }
}

// A stub Kaggle transport for harness boots that simulate a
// credential-present host: push succeeds, status stays 'running'
// forever, output is never reached. A pushed job therefore stays
// pending until a report is filed — the same observable behaviour as
// the old null (human) channel, which is what the orphan/pending
// tests rely on (a completing stub would settle jobs the tests expect
// to stay outstanding). It never shells out and never touches Kaggle.
// The harness injects it automatically when the caller simulates a
// credential (kaggleCredentialPresent: true) without supplying its own
// transport; it never bypasses the factory's credential or owner-token
// gates — those still run first.
export function stubKaggleTransport() {
  const calls = { push: [], status: [], output: [] };
  return {
    calls,
    async push(packageDir) {
      calls.push.push(packageDir);
      const jobId = path.basename(packageDir);
      return { ok: true, kernelId: `test-owner/nova-gpu-cloud-${jobId}` };
    },
    async status(kernelId) {
      calls.status.push(kernelId);
      return { state: 'running' };
    },
    async output(kernelId) {
      calls.output.push(kernelId);
      throw new Error('stubKaggleTransport.output is never reached while status is running');
    },
  };
}

// -- API process harness ----------------------------------------------------

export async function makeApi(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-api-test-'));
  const d1 = new MemoryD1Client();
  // executor: false => no executor at all (production-mode tests).
  // It must be null, not a stub object: production mode rejects ANY
  // injected executor at construction (Rev 4.9 §4), so a truthy stub
  // throws instead of letting the submit be refused with 503.
  const executor = overrides.executor === false
    ? null
    : (overrides.executor ?? new FakeControlledExecutor());
  const api = createApiServer({
    mode: overrides.mode ?? 'controlled-test',
    secret: 'test-secret',
    secretPrevious: '',
    dataDir: dir,
    d1Client: d1,
    executor,
    // Rev 4.8 §4/§6 (M2-P): activation passthroughs for the capacity and
    // personal-path tests. Undefined falls back to the server defaults
    // (flags file absent -> both false; no signing secret; no owner
    // token id; no Kaggle credential; no personal executor).
    // Kaggle design v13 §3.3: when the caller passes no conf, the
    // harness writes its OWN temp conf (both flags false, 0440,
    // test-owned parent) instead of reading the production
    // /etc/nova-api/activation.conf. The production file is host state:
    // a missing /etc/nova-api fails the strict read as `unreadable`,
    // and a rebuilt host's root:nova-api file fails it as `wrong-group`
    // against the test process's uid/gid — either way every makeApi
    // caller without an explicit conf throws at construction, and in
    // gateway-non-interference the throw lands after the e2e stub
    // server listens but before its try/finally, leaking the server and
    // stalling the whole suite (603 s observed). Tests that need a
    // specific conf pass activationConfigPath explicitly, as before.
    activationConfigPath: overrides.activationConfigPath ?? writeDefaultActivationConf(dir),
    // Kaggle design v13 §3.3: the strict re-verification overrides
    // (expected owner uid / mode for the temp conf). The default expects
    // a test-owned file (the test process's uid/gid, mode 0440, parent
    // owned by the test process) — which is what
    // writeDefaultActivationConf writes, and what callers that pass an
    // explicit activationConfigPath write themselves.
    activationConfigOwnerUid: overrides.activationConfigOwnerUid,
    activationConfigMode: overrides.activationConfigMode,
    activationConfigGroupGid: overrides.activationConfigGroupGid,
    activationConfigParentUid: overrides.activationConfigParentUid,
    fileAccess: overrides.fileAccess ?? {
      ownerUid: process.getuid(),
      groupGid: process.getgid(),
      mode: 0o440,
      parentUid: process.getuid(),
    },
    // Kaggle design v13: file-based permit (§3.5) + licence record
    // (§3.4) paths and the API event log (§5.5). Undefined falls back
    // to the production paths.
    commissioningPermitPath: overrides.commissioningPermitPath,
    licenceDeterminationPath: overrides.licenceDeterminationPath,
    apiEventLogPath: overrides.apiEventLogPath,
    stagingDir: overrides.stagingDir,
    // Kaggle design v4: NEXORA per-client credentials + ledger +
    // staging passthroughs. Undefined falls back to the server
    // defaults (no NEXORA secrets -> NEXORA routes fail closed;
    // cap 5 h; budget 0.5 h; no staging URL -> staging-unavailable).
    novaApiSecretNexora: overrides.novaApiSecretNexora,
    novaApiSecretNexoraPrevious: overrides.novaApiSecretNexoraPrevious,
    novaSigningSecretNexora: overrides.novaSigningSecretNexora,
    novaSigningSecretNexoraPrevious: overrides.novaSigningSecretNexoraPrevious,
    nexoraWeeklyCapHours: overrides.nexoraWeeklyCapHours,
    nexoraJobBudgetHours: overrides.nexoraJobBudgetHours,
    nexoraStagingBaseUrl: overrides.nexoraStagingBaseUrl,
    stagingFetch: overrides.stagingFetch,
    // Rev 4.8 §8: production mode requires a signing secret; the harness
    // supplies a test-only one by default so production-mode harness
    // servers construct (tests that exercise the missing-secret startup
    // failure construct createApiServer directly).
    signingSecret: overrides.signingSecret
      ?? ((overrides.mode ?? 'controlled-test') === 'production' ? 'test-signing-secret' : undefined),
    ownerTokenId: overrides.ownerTokenId,
    kaggleCredentialPresent: overrides.kaggleCredentialPresent,
    personalExecutor: overrides.personalExecutor,
    // The factory builds the real KaggleCliTransport when no transport
    // is injected — which throws without a real credential. A harness
    // boot that simulates a credential-present host therefore also
    // simulates the transport (the stub above); an explicit
    // kaggleTransport override wins. Boots that do not simulate the
    // credential get nothing, and the factory refuses on its own gate.
    kaggleTransport: overrides.kaggleTransport
      ?? (overrides.kaggleCredentialPresent === true ? stubKaggleTransport() : undefined),
    productionExecutors: overrides.productionExecutors,
    storage: overrides.storage,
    // FreeLLMAPI (A4/A5): gateway options pass through; undefined falls
    // back to the server defaults (environment production, flags OFF).
    environment: overrides.environment,
    environmentId: overrides.environmentId,
    projectId: overrides.projectId,
    ownerId: overrides.ownerId,
    gatewayEnhancement: overrides.gatewayEnhancement,
    gatewayApiKey: overrides.gatewayApiKey,
    gatewayBaseUrl: overrides.gatewayBaseUrl,
    gatewayTextModel: overrides.gatewayTextModel,
    geminiApiKey: overrides.geminiApiKey,
    usageSource: overrides.usageSource ?? (async () => ({ readable: true, usageFraction: 0.1 })),
    retentionEnabled: overrides.retentionEnabled,
    retentionDays: overrides.retentionDays,
    ackWindowMs: overrides.ackWindowMs ?? 300,
    ackPollMs: overrides.ackPollMs ?? 25,
    onBeforeDeleteRows: overrides.onBeforeDeleteRows ?? null,
    validateOutput: overrides.validateOutput ?? (async () => ({
      ok: true, sha256: 'deadbeef', sizeBytes: 1234,
      details: { codec: 'h264', pix_fmt: 'yuv420p', width: 1024, height: 576, fps: 24, frames: 121, duration: 5.04 },
    })),
    now: overrides.now,
    onBeforeComponent: overrides.onBeforeComponent ?? null,
  });
  // Seed a fresh runner heartbeat (Rev 4.9 §6 gate): in production the
  // runner's startup catch-up pass writes runner-health.json before the
  // API listens, so a submit-time gate always sees a fresh heartbeat.
  // The harness simulates that — otherwise every submit is refused 503
  // storage-full on the missing file and no submit-path test can run.
  // Pass seedHeartbeat: false to exercise the gate itself (missing file
  // → 503 storage-full).
  if (overrides.seedHeartbeat !== false) {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'runner-health.json'), JSON.stringify({
      lastSuccessfulSweepAt: now,
      lastAttemptAt: now,
      status: 'ok',
      objectsDeleted: 0,
      error: null,
    }));
  }
  return {
    api, d1, executor, dir,
    async cleanup() {
      await api.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function submitBody(label, { scenes = 1, mode = 'single' } = {}) {
  const jobId = canonicalJobId(label);
  const sceneExecutions = [];
  for (let i = 0; i < scenes; i += 1) {
    sceneExecutions.push({
      sceneIndex: i,
      attempt: 1,
      executionId: `${jobId}:scene-${i}:attempt-1`,
      idempotencyKey: `${jobId}:scene-${i}:attempt-1`,
    });
  }
  const body = {
    jobId,
    mode,
    model: 'ltx-video-2b',
    frames: 121,
    resolution: '1024x576',
    fps: 24,
    deploymentMode: 'controlled-test',
    sceneExecutions,
  };
  if (mode === 'single') body.prompt = 'A dragon on a ridge at dawn.';
  else body.scenes = sceneExecutions.map((x) => ({ index: x.sceneIndex, prompt: `Scene ${x.sceneIndex}.` }));
  return body;
}

export function seedJobForSubmit(d1, body, { dispatchState = undefined, status = 'queued' } = {}) {
  const data = {
    id: body.jobId,
    mode: body.mode,
    status,
    createdAtMs: Date.now(),
    ...(body.mode === 'single' ? { prompt: body.prompt } : { scenes: body.scenes }),
    sceneExecutions: body.sceneExecutions,
  };
  if (dispatchState) data.dispatchState = dispatchState;
  const rows = body.sceneExecutions.map((x) => ({
    scene_index: x.sceneIndex,
    attempt: x.attempt,
    execution_id: x.executionId,
    status: 'queued',
  }));
  d1.seedJob(data, rows);
  return data;
}
