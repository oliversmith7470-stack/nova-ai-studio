// NOVA Personal GPU Cloud — Phase 6 Workstream A: persistent model worker
// (+ Workstream C CPU-side items: per-job resource ledger, no repeated
// checkpoint hashing).
//
// STANDALONE module. It implements the manager executor contract and the
// API-process executor surface, and is tested with injected fakes. It is
// NOT wired into gpu-cloud/src/api-server.js, dispatch.js, or the
// manager's provider registry: there is no production executor registered
// anywhere and no authorised zero-cost GPU worker exists, so this worker
// must never be registered as a production path by this file.
//
//   Manager contract (see src/gpu-manager.js dispatchNext + src/executor-base.js):
//     start(job) -> Promise<report>
//       { jobId, providerId, status, secondsUsed, costUsd, completedAt,
//         resultRef, error }
//     requestCancel(jobId) -> boolean (a request, not a guarantee)
//   start() NEVER throws synchronously: every refusal resolves as a FAILED
//   report. The manager marks the job dispatched -> running when start()
//   is called and finalises ONLY when the returned promise resolves, so
//   start() resolves with the FINAL report (succeeded/failed) and stays
//   pending until the job ends (or fileReport/reportFailure settles it).
//
//   API-process surface (see src/api-server/fake-executor.js):
//     getExecutionState(executionId) -> { state, evidence }
//       state in 'accepted' | 'running' | 'completed' | 'failed' |
//       'never-received' | 'unknown'
//     fileReport(report) -> { filed, ... } (resolves the pending start promise)
//     reportFailure(managerJobId, error) -> boolean
//     lastReport(managerJobId), submissions Map, id = providerId
//
// The model runner is INJECTED, never imported and never shelled out to:
//   modelRunner = {
//     load(spec) -> Promise<loadedModel>,            // loads + verifies input
//     warmup(loadedModel) -> Promise<void>,         // optional
//     runJob(loadedModel, job, ctx) -> Promise<{ outputPath | resultRef,
//                                                 measurements }>,
//     unload() -> Promise<void>,
//     healthCheck(loadedModel) -> Promise<boolean>, // optional
//     cancel(jobId) -> boolean | Promise<boolean>,  // optional
//     releaseAllocation(id) -> Promise<void>,       // optional
//   }
// The loaded model must carry { checkpointSha256, precision } (or dtype);
// the worker verifies checkpoint sha + dtype fp16 ONCE at load and never
// re-hashes per job (Workstream C). Model load is a worker lifecycle
// event, NOT per-job: warm jobs reuse the same loaded model object.
//
// Health states (exactly, design §8 A2):
//   'starting' | 'ready' | 'busy' | 'draining' | 'failed' | 'unavailable'
// No artificial queue: a job is accepted only while 'ready'; otherwise
// start() resolves a failed report 'worker-not-ready: <state>' at once.
//
// Pinned baseline (Run 10): LTX-Video 2B distilled 0.9.8, diffusers
// 0.40.0, FP16, 121 frames, 1024x576, 24fps, 8 steps, seed 42,
// guidance 1.0. A job whose modelId or frames/resolution/steps/fps/
// seed/guidance differ from the pinned baseline is REFUSED with a failed
// report — never silently run on a different config.
//
// No credentials: the worker accepts no credential fields (constructor
// throws on apiKey/token/secret/password keys), passes none to the
// runner, and its event log / error strings never contain job.prompt
// text or credential values (see _sanitize).

import { unlink as fsUnlink } from 'node:fs/promises';

export const PINNED_BASELINE = Object.freeze({
  model: 'ltx-video-2b',
  checkpointSha256:
    '76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f',
  precision: 'fp16',
  diffusers: '0.40.0',
  frames: 121,
  width: 1024,
  height: 576,
  resolution: '1024x576',
  fps: 24,
  steps: 8,
  seed: 42,
  guidance: 1.0,
});

export const HEALTH_STATES = Object.freeze([
  'starting',
  'ready',
  'busy',
  'draining',
  'failed',
  'unavailable',
]);

export const EXECUTION_STATES = Object.freeze([
  'accepted',
  'running',
  'completed',
  'failed',
  'never-received',
  'unknown',
]);

// Error codes that mean the GPU context itself is suspect: never assume
// empty_cache() repairs it — the worker is marked failed (design §8 A2).
const CUDA_FATAL_CODES = new Set(['cuda-oom', 'cuda-corrupt']);

const CREDENTIAL_KEYS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'token',
  'secret',
  'password',
  'auth',
  'credential',
]);

// Matches `api_key=...`, `token: ...`, `password=...` (any value after the
// key) so the VALUE is redacted; the key name itself is not a secret.
const CREDENTIAL_VALUE_RE =
  /(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;}"']+/gi;

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => Date.now();
}

function assertNoCredentialFields(obj, where) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `persistent-worker: credential field "${key}" is not accepted (${where})`,
      );
    }
  }
}

export class PersistentWorker {
  constructor(options = {}) {
    const {
      providerId,
      modelRunner,
      modelSpec = {},
      flags = {},
      clock = null,
      unlink = fsUnlink,
    } = options;
    if (!providerId) throw new Error('persistent-worker requires providerId');
    if (!modelRunner || typeof modelRunner.load !== 'function') {
      throw new Error('persistent-worker requires modelRunner.load(spec)');
    }
    if (typeof modelRunner.runJob !== 'function') {
      throw new Error('persistent-worker requires modelRunner.runJob(loadedModel, job, ctx)');
    }
    if (typeof modelRunner.unload !== 'function') {
      throw new Error('persistent-worker requires modelRunner.unload()');
    }
    assertNoCredentialFields(options, 'options');
    assertNoCredentialFields(modelSpec, 'modelSpec');
    assertNoCredentialFields(flags, 'flags');

    this.id = providerId;
    this.providerId = providerId;
    this.modelRunner = modelRunner;
    // Pinned baseline defaults; caller overrides only by supplying a field.
    this.modelSpec = { ...PINNED_BASELINE, ...modelSpec };
    // Plain flags object, owned elsewhere (design §18 rollback interface).
    // The worker only READS it. Absent = enabled; an explicit false on
    // `persistentWorker` (Phase 6 flags module) or `persistentWorkerEnabled`
    // disables the worker.
    this.flags = { ...flags };
    this._now = normalizeClock(clock);
    this._unlink = unlink;

    this.state = 'unavailable';
    this.loadedModel = null;
    this.events = [];
    this.cancelRequests = new Set();
    this.submissions = new Map();
    this.executions = new Map();
    this.pending = new Map();
    this.lastReports = new Map();
    this.jobRecords = new Map();
    this.activeContexts = new Map();
    this.currentJobId = null;
    this.draining = false;
    this.drainRequested = false;
    this._lifecycleToken = 0;

    // Metrics (design §8 A3), plain counters/aggregates on the instance.
    // Timing/measurement fields stay null when the runner does not report
    // them — no invented measurements.
    this.processStartToReadyMs = null;
    this.modelLoadMs = null;
    this.warmupMs = null;
    this.jobsCompleted = 0;
    this.jobsFailed = 0;
    this.modelLoadCount = 0;
    this.modelReloadCount = 0;
    this.restarts = 0;
    this.peakMemoryGib = null;
    this.lastJobTimings = null;
  }

  get health() {
    return this.state;
  }

  isReady() {
    return this.state === 'ready';
  }

  // -- lifecycle ------------------------------------------------------------

  // Load the model ONCE, verify checkpoint sha + dtype fp16 + warm-up,
  // then become 'ready'. Returns true when ready, false otherwise (never
  // throws). On load/verify/warm-up failure: 'failed', never a fallback
  // to CPU/BF16/another model/paid provider. A restart after failure
  // reloads + re-verifies from scratch. Calling startWorker while
  // 'draining' with a loaded model resumes to 'ready' without a reload.
  async startWorker() {
    if (this.state === 'busy') return false;
    if (this.state === 'ready') return true;
    if (this.state === 'draining' && this.loadedModel) {
      this.draining = false;
      this.drainRequested = false;
      this.state = 'ready';
      this._event('worker-resumed', null);
      return true;
    }
    if (this.state === 'starting') return false;
    if (this._flagsDisableWorker()) {
      this.state = 'unavailable';
      this._event('worker-unavailable', null);
      return false;
    }
    const wasFailed = this.state === 'failed';
    if (wasFailed) this.restarts += 1;
    const token = ++this._lifecycleToken;
    const startedAt = this._now();
    this.state = 'starting';
    this._event('worker-starting', null);
    try {
      // Count every load attempt: a restart after failure is a reload
      // even when the first attempt threw.
      const loadStartedAt = this._now();
      let loaded;
      try {
        loaded = await this.modelRunner.load(this.modelSpec);
      } finally {
        this.modelLoadMs = this._now() - loadStartedAt;
        this.modelLoadCount += 1;
        if (this.modelLoadCount > 1) this.modelReloadCount += 1;
      }
      // Startup integrity verification, ONCE at load (Workstream C):
      // never re-hashed per job.
      if (!loaded || loaded.checkpointSha256 !== this.modelSpec.checkpointSha256) {
        throw new Error('model-verification-failed: checkpoint sha256 mismatch');
      }
      const precision = loaded.precision ?? loaded.dtype;
      if (precision !== 'fp16') {
        throw new Error(
          `model-verification-failed: precision "${precision}" is not fp16`,
        );
      }
      this.loadedModel = loaded;
      if (typeof this.modelRunner.warmup === 'function') {
        const warmupStartedAt = this._now();
        await this.modelRunner.warmup(loaded);
        this.warmupMs = this._now() - warmupStartedAt;
      } else {
        this.warmupMs = null;
      }
      // A stop/drain requested while loading wins over becoming ready.
      if (token !== this._lifecycleToken) return false;
      this.processStartToReadyMs = this._now() - startedAt;
      this.state = this.drainRequested ? 'draining' : 'ready';
      this.drainRequested = false;
      this._event('worker-ready', null);
      return this.state === 'ready';
    } catch (err) {
      if (token !== this._lifecycleToken) return false;
      this.loadedModel = null;
      this.state = 'failed';
      this._event('worker-failed', null);
      return false;
    }
  }

  // Drain: accept nothing new, finish the in-flight job. While 'starting'
  // the drain is recorded and applies once loading finishes.
  drain() {
    if (this.state === 'ready' || this.state === 'busy') {
      this.draining = true;
      this.state = 'draining';
      this._event('worker-draining', null);
      return true;
    }
    if (this.state === 'starting') {
      this.draining = true;
      this.drainRequested = true;
      this._event('worker-draining', null);
      return true;
    }
    return false;
  }

  // Unload the model (waiting for an in-flight job first) and become
  // 'unavailable'. Best effort: an unload error never throws.
  async stopWorker() {
    this._lifecycleToken += 1;
    this.draining = false;
    this.drainRequested = false;
    const current = this.currentJobId
      ? this.pending.get(this.currentJobId)
      : null;
    if (current) {
      try {
        await current.promise;
      } catch {
        // The pending promise never rejects; this is belt-and-braces.
      }
    }
    if (this.loadedModel) {
      try {
        await this.modelRunner.unload();
      } catch {
        // Best effort — the worker is stopping regardless.
      }
      this.loadedModel = null;
    }
    this.state = 'unavailable';
    this._event('worker-stopped', null);
    return true;
  }

  // Run the injected health check (when the runner provides one). A failed
  // check marks the worker 'failed' (model suspect, unloaded best effort);
  // with no loaded model the worker stays 'unavailable'. Returns true
  // when the check passes (or no check exists and the worker is ready).
  async runHealthCheck() {
    // No model loaded (never started / stopped / already failed): no
    // check can pass.
    if (this.state === 'unavailable' || !this.loadedModel) return false;
    if (typeof this.modelRunner.healthCheck !== 'function') {
      return this.state === 'ready';
    }
    let ok;
    try {
      ok = await this.modelRunner.healthCheck(this.loadedModel);
    } catch {
      ok = false;
    }
    if (ok === false) {
      if (this.state === 'unavailable') return false;
      await this._failWorker();
      return false;
    }
    return true;
  }

  // -- manager contract -----------------------------------------------------

  // start(job) -> Promise<final report>. NEVER throws synchronously.
  async start(job) {
    try {
      return await this._start(job);
    } catch (err) {
      return this._failedReport(
        job,
        `executor-error: ${this._sanitize(err && err.message ? err.message : String(err), job)}`,
      );
    }
  }

  // Alias used by the design text ("startJob only when 'ready'").
  startJob(job) {
    return this.start(job);
  }

  async _start(job) {
    const jobId = job && job.id ? job.id : null;
    if (this.state !== 'ready') {
      const report = this._failedReport(job, `worker-not-ready: ${this.state}`);
      if (jobId) this.lastReports.set(jobId, report);
      return report;
    }
    const mismatch = this._configMismatch(job);
    if (mismatch) {
      const report = this._failedReport(job, mismatch);
      if (jobId) this.lastReports.set(jobId, report);
      this._event('job-refused', jobId);
      return report;
    }
    const executionId =
      (job.params && job.params.executionId) || job.idempotencyKey || job.id;
    const startedAt = this._now();
    this.submissions.set(job.id, {
      executionId,
      managerJobId: job.id,
      modelId: job.modelId,
      startedAt,
    });
    const execRec = {
      executionId,
      managerJobId: job.id,
      state: 'accepted',
      submittedAt: startedAt,
    };
    this.executions.set(executionId, execRec);
    const ctx = this._createJobContext(job.id);
    this.activeContexts.set(job.id, ctx);
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const pending = {
      promise,
      executionId,
      settled: false,
      resolve: (report) => {
        if (!pending.settled) {
          pending.settled = true;
          settle(report);
        }
      },
    };
    this.pending.set(job.id, pending);
    this.currentJobId = job.id;
    this.state = 'busy';
    this._event('job-accepted', job.id);
    // Fire-and-forget: _runJob settles the pending promise when the job
    // ends (or fileReport/reportFailure settles it first).
    void this._runJob(job, ctx, pending, execRec, startedAt);
    return promise;
  }

  async _runJob(job, ctx, pending, execRec, startedAt) {
    execRec.state = 'running';
    this._event('job-started', job.id);
    let report;
    try {
      const result = await this.modelRunner.runJob(this.loadedModel, job, ctx);
      const endedAt = this._now();
      const measurements =
        result && typeof result.measurements === 'object' && result.measurements
          ? result.measurements
          : null;
      // Capture the tracked list BEFORE cleanup empties it (audit trail).
      const trackedTempFiles = [...ctx.tempFiles];
      const cleanupFailures = await this._cleanupJobContext(ctx);
      this._recordJob(job, 'succeeded', startedAt, endedAt, measurements, cleanupFailures, null, trackedTempFiles);
      this.jobsCompleted += 1;
      if (measurements && typeof measurements.peakMemoryGib === 'number') {
        this.peakMemoryGib = measurements.peakMemoryGib;
      }
      this.lastJobTimings = {
        generationMs: measurements?.generationMs ?? null,
        decodeMs: measurements?.decodeMs ?? null,
        exportMs: measurements?.exportMs ?? null,
      };
      report = {
        jobId: job.id,
        providerId: this.id,
        status: 'succeeded',
        secondsUsed: (endedAt - startedAt) / 1000,
        costUsd: 0,
        completedAt: endedAt,
        resultRef:
          (result && (result.resultRef ?? result.outputPath)) ?? null,
        error: null,
        outputPath: (result && result.outputPath) ?? null,
        measurements,
      };
      if (!pending.settled) {
        execRec.state = 'completed';
        this.lastReports.set(job.id, report);
      }
      this._event('job-succeeded', job.id);
    } catch (err) {
      const endedAt = this._now();
      const trackedTempFiles = [...ctx.tempFiles];
      const cleanupFailures = await this._cleanupJobContext(ctx);
      const code = err && (err.code ?? err.errorCode) ? String(err.code ?? err.errorCode) : null;
      const message = this._sanitize(
        err && err.message ? err.message : String(err),
        job,
      );
      const errorText = code ? `${code}: ${message}` : message;
      this.jobsFailed += 1;
      this.lastJobTimings = { generationMs: null, decodeMs: null, exportMs: null };
      report = {
        jobId: job.id,
        providerId: this.id,
        status: 'failed',
        secondsUsed: (endedAt - startedAt) / 1000,
        costUsd: 0,
        completedAt: endedAt,
        resultRef: null,
        error: errorText,
      };
      this._recordJob(job, 'failed', startedAt, endedAt, null, cleanupFailures, errorText, trackedTempFiles);
      if (!pending.settled) {
        execRec.state = 'failed';
        this.lastReports.set(job.id, report);
      }
      this._event('job-failed', job.id);
      // Post-failure health decision (design §8 A2): keep the worker ONLY
      // if a health check passes. A CUDA OOM/corrupt error is fatal
      // regardless — never assume empty_cache() repairs it.
      const fatal = code !== null && CUDA_FATAL_CODES.has(code);
      let keep = !fatal;
      if (keep && typeof this.modelRunner.healthCheck === 'function') {
        try {
          keep = (await this.modelRunner.healthCheck(this.loadedModel)) !== false;
        } catch {
          keep = false;
        }
      }
      if (!keep) await this._failWorker();
    } finally {
      this.activeContexts.delete(job.id);
      if (this.currentJobId === job.id) this.currentJobId = null;
      // _failWorker may already have set 'failed'; a drain requested
      // while busy leaves the worker 'draining'; otherwise back to 'ready'
      // with the SAME loaded model.
      if (this.state === 'busy') {
        this.state = this.draining ? 'draining' : 'ready';
      }
      pending.resolve(report);
    }
  }

  // Honest cancel: records the request, marks the in-flight context
  // cancelled, asks the runner when it offers cancel, and returns what
  // the runner honestly reports (false when there is nothing to cancel
  // or no cancel mechanism).
  requestCancel(jobId) {
    this.cancelRequests.add(jobId);
    const ctx = this.activeContexts.get(jobId);
    if (ctx) ctx.cancelled = true;
    this._event('cancel-requested', jobId);
    const inFlight = this.currentJobId === jobId || this.pending.has(jobId);
    if (!inFlight) return false;
    if (typeof this.modelRunner.cancel === 'function') {
      let result;
      try {
        result = this.modelRunner.cancel(jobId);
      } catch {
        return false;
      }
      if (typeof result === 'boolean') return result;
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
        return true;
      }
      return true;
    }
    return false;
  }

  // -- API-process surface --------------------------------------------------

  getExecutionState(executionId) {
    const rec = this.executions.get(executionId);
    if (!rec) return { state: 'never-received', evidence: { raw: null } };
    return {
      state: EXECUTION_STATES.includes(rec.state) ? rec.state : 'unknown',
      evidence: {
        managerJobId: rec.managerJobId,
        providerId: this.id,
        executionId: rec.executionId,
      },
    };
  }

  // File a completion report: resolves the pending start() promise.
  // A report for a job with no pending promise is NOT filed (honest).
  fileReport(report) {
    const pending = this.pending.get(report && report.jobId);
    if (!pending) return { filed: false, reason: 'no-pending-job' };
    const normalized = this._normalizeReport(report);
    const execRec = this.executions.get(pending.executionId);
    if (execRec) {
      execRec.state = normalized.status === 'succeeded' ? 'completed' : 'failed';
    }
    this.lastReports.set(report.jobId, normalized);
    this.pending.delete(report.jobId);
    pending.resolve(normalized);
    this._event('report-filed', report.jobId);
    return { filed: true, jobId: report.jobId, status: normalized.status };
  }

  // Resolve a pending job as failed without a completion report.
  // Returns false when nothing was pending.
  reportFailure(managerJobId, error) {
    const pending = this.pending.get(managerJobId);
    if (!pending) return false;
    const report = {
      jobId: managerJobId,
      providerId: this.id,
      status: 'failed',
      secondsUsed: 0,
      costUsd: 0,
      completedAt: this._now(),
      resultRef: null,
      error: this._sanitize(error ?? 'executor reported failure'),
    };
    const execRec = this.executions.get(pending.executionId);
    if (execRec) execRec.state = 'failed';
    this.lastReports.set(managerJobId, report);
    this.pending.delete(managerJobId);
    pending.resolve(report);
    this._event('report-failure', managerJobId);
    return true;
  }

  lastReport(managerJobId) {
    return this.lastReports.get(managerJobId) ?? null;
  }

  pendingJobs() {
    return [...this.pending.keys()];
  }

  // -- per-job resource ledger (Workstream C) -------------------------------

  _createJobContext(jobId) {
    const ctx = {
      jobId,
      tempFiles: [],
      allocations: [],
      cancelled: false,
      registerTempFile: (filePath) => {
        ctx.tempFiles.push(filePath);
        return filePath;
      },
      registerAllocation: (id) => {
        ctx.allocations.push(id);
        return id;
      },
      isCancelled: () => ctx.cancelled,
    };
    return ctx;
  }

  // Release every per-job resource on job end (success or failure).
  // Every tracked temp file is removed (injected unlink, default
  // node:fs/promises) and every allocation is released via
  // modelRunner.releaseAllocation when present. Failures are returned
  // for the job-end audit — never silent.
  async _cleanupJobContext(ctx) {
    const failures = [];
    for (const filePath of ctx.tempFiles) {
      try {
        await this._unlink(filePath);
      } catch (err) {
        failures.push({
          kind: 'temp-file',
          path: filePath,
          error: this._sanitize(err && err.message ? err.message : String(err)),
        });
      }
    }
    for (const id of ctx.allocations) {
      if (typeof this.modelRunner.releaseAllocation === 'function') {
        try {
          await this.modelRunner.releaseAllocation(id);
        } catch (err) {
          failures.push({
            kind: 'allocation',
            id,
            error: this._sanitize(err && err.message ? err.message : String(err)),
          });
        }
      }
    }
    ctx.tempFiles.length = 0;
    ctx.allocations.length = 0;
    if (failures.length > 0) this._event('job-cleanup-failed', ctx.jobId);
    return failures;
  }

  // -- internals ------------------------------------------------------------

  _recordJob(job, status, startedAt, endedAt, measurements, cleanupFailures, error, trackedTempFiles) {
    const record = {
      jobId: job.id,
      status,
      startedAt,
      completedAt: endedAt,
      generationMs: measurements?.generationMs ?? null,
      decodeMs: measurements?.decodeMs ?? null,
      exportMs: measurements?.exportMs ?? null,
      peakMemoryGib: measurements?.peakMemoryGib ?? null,
      tempFiles: trackedTempFiles ? [...trackedTempFiles] : [],
      cleanupFailures,
      error: error ?? null,
    };
    this.jobRecords.set(job.id, record);
    return record;
  }

  // Refuse (as a reason string) when the job asks for anything other than
  // the pinned baseline. A field the job does not state is the baseline;
  // a field it states differently is a refusal, never a silent switch.
  _configMismatch(job) {
    if (!job || typeof job !== 'object') return 'config-mismatch: job is not an object';
    if (job.modelId !== this.modelSpec.model) {
      return `config-mismatch: model "${job.modelId}" != pinned "${this.modelSpec.model}"`;
    }
    const p = job.params ?? {};
    const frames = p.frames ?? p.numFrames;
    if (frames !== undefined && frames !== this.modelSpec.frames) {
      return `config-mismatch: frames ${frames} != pinned ${this.modelSpec.frames}`;
    }
    if (p.resolution !== undefined && p.resolution !== this.modelSpec.resolution) {
      return `config-mismatch: resolution "${p.resolution}" != pinned "${this.modelSpec.resolution}"`;
    }
    if (p.width !== undefined && p.width !== this.modelSpec.width) {
      return `config-mismatch: width ${p.width} != pinned ${this.modelSpec.width}`;
    }
    if (p.height !== undefined && p.height !== this.modelSpec.height) {
      return `config-mismatch: height ${p.height} != pinned ${this.modelSpec.height}`;
    }
    const steps = p.steps ?? p.inferenceSteps;
    if (steps !== undefined && steps !== this.modelSpec.steps) {
      return `config-mismatch: steps ${steps} != pinned ${this.modelSpec.steps}`;
    }
    if (p.fps !== undefined && p.fps !== this.modelSpec.fps) {
      return `config-mismatch: fps ${p.fps} != pinned ${this.modelSpec.fps}`;
    }
    if (p.seed !== undefined && p.seed !== this.modelSpec.seed) {
      return `config-mismatch: seed ${p.seed} != pinned ${this.modelSpec.seed}`;
    }
    if (p.guidance !== undefined && p.guidance !== this.modelSpec.guidance) {
      return `config-mismatch: guidance ${p.guidance} != pinned ${this.modelSpec.guidance}`;
    }
    if (p.precision !== undefined && p.precision !== this.modelSpec.precision) {
      return `config-mismatch: precision "${p.precision}" != pinned "${this.modelSpec.precision}"`;
    }
    return null;
  }

  _flagsDisableWorker() {
    if (!this.flags) return false;
    return this.flags.persistentWorker === false || this.flags.persistentWorkerEnabled === false;
  }

  async _failWorker() {
    this.state = 'failed';
    this._event('worker-failed', null);
    if (this.loadedModel) {
      this.loadedModel = null;
      try {
        await this.modelRunner.unload();
      } catch {
        // Best effort — a failed worker stays failed regardless.
      }
    }
  }

  _normalizeReport(report) {
    const status = report.status === 'succeeded' ? 'succeeded' : 'failed';
    const error =
      report.status === 'succeeded'
        ? null
        : this._sanitize(
            report.error ??
              (report.status === 'failed'
                ? 'provider reported failure'
                : `invalid report status "${report.status}" (expected succeeded/failed)`),
          );
    return {
      jobId: report.jobId,
      providerId: this.id,
      status,
      secondsUsed: typeof report.secondsUsed === 'number' ? report.secondsUsed : 0,
      costUsd: 0,
      completedAt: report.completedAt ?? this._now(),
      resultRef: report.status === 'succeeded' ? (report.resultRef ?? report.outputPath ?? null) : null,
      error,
      outputPath: report.outputPath ?? null,
      measurements: report.measurements ?? null,
    };
  }

  _failedReport(job, error) {
    return {
      jobId: job && job.id ? job.id : null,
      providerId: this.id,
      status: 'failed',
      secondsUsed: 0,
      costUsd: 0,
      completedAt: this._now(),
      resultRef: null,
      error: this._sanitize(error, job),
    };
  }

  // Events carry {at, event, jobId} ONLY — never prompt text, never a
  // credential value. Error strings are scrubbed the same way.
  _event(name, jobId) {
    this.events.push({ at: this._now(), event: name, jobId: jobId ?? null });
    if (this.events.length > 1000) {
      this.events.splice(0, this.events.length - 1000);
    }
  }

  _sanitize(text, job) {
    let s = String(text ?? '');
    if (job && typeof job.prompt === 'string' && job.prompt.length > 0) {
      s = s.split(job.prompt).join('[prompt-redacted]');
    }
    s = s.replace(CREDENTIAL_VALUE_RE, '$1=[redacted]');
    return s;
  }
}
