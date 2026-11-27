// NOVA Personal GPU Cloud — Stage 1: NOVA GPU Manager.
//
// The orchestrator. It owns the job lifecycle, the queue, the provider
// registry, reservations, the spending ceiling, the kill-switch, timeouts
// and reconciliation — and nothing else. It does NOT talk to any live GPU
// provider: the only executor in Stage 1 is the in-process mock.
//
// Boundaries (from the reviewer's VDP corrections on the Video
// Independence Plan):
//   VDP-01 — the manager provides its OWN boundary now. It does NOT assume
//     the A2 gateway is deployed; Stage 4 connects it to the A2 boundary
//     when that becomes available.
//   VDP-02 — the kill-switch stops NEW dispatches only. A running GPU job
//     may still complete and may still be charged; the manager records the
//     provider's outcome and keeps the cost for reconciliation.
//   O-27   — job records only. No media bytes are ever stored.
//
// Spending ceiling: the global ceiling lives in the store and defaults to
// 0 (zero-cost mode). Paid providers are NEVER dispatched while the
// ceiling is 0. Raising it requires an owner decision, recorded with
// authorizedBy + reason (setSpendingCeiling).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import {
  ProviderRegistry,
  providerSupports,
  estimateCostUsd,
} from './providers.js';
import { MockProvider } from './mock-provider.js';
import {
  createJob,
  transition,
  isTerminal,
  startedClockAt,
} from './job.js';
import { queueDepth, nextJob } from './queue.js';
import {
  createReservation,
  releaseReservation,
  committedUsd,
} from './reservations.js';
import {
  engageKillSwitch,
  disengageKillSwitch,
  isEngaged,
} from './kill-switch.js';
import { reconcileReports, findUnreportedJobs } from './reconcile.js';
import { DEFAULT_SWEEP_INTERVAL_MS } from './storage/index.js';
import {
  buildGatewayPolicy,
  effectivePrompt,
  InvalidJobError,
} from './gateway-policy.js';
import { scanCredentialPatterns } from './data-guard.js';
import { GATEWAY_DEFAULT_TIMEOUT_MS } from './gateway-client.js';

const DEFAULT_STORE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'gpu-manager.json',
);

export class QueueFullError extends Error {
  constructor(depth, max) {
    super(`queue is full (${depth}/${max})`);
    this.name = 'QueueFullError';
    this.depth = depth;
    this.max = max;
  }
}

export class GpuManager {
  constructor({ storePath = DEFAULT_STORE_PATH, now = () => Date.now(), config = {}, mockOptions = {}, enhancement = {}, personalProviderIds = null } = {}) {
    this.now = now; // injectable clock (tests use a fake clock for timeouts)
    this.store = new JsonStore(storePath);
    this.registry = new ProviderRegistry();
    // Rev 4.8 §5.3/§7 audience routing: the provider ids that serve
    // personal (owner-only) jobs. A personal job routes ONLY to these;
    // a public job routes NEVER to these. The set is shared by
    // reference with the API factory, which fills it when the personal
    // executor registers. Empty (the default) means no personal
    // provider is known and the audience filter changes nothing for
    // jobs without an audience (legacy/controlled-test callers).
    this.personalProviderIds = personalProviderIds instanceof Set ? personalProviderIds : new Set();
    this.config = {
      maxQueueDepth: config.maxQueueDepth ?? 100,
    };
    // In-memory diagnostic event log (not persisted). Tests use it to
    // assert ORDERING (e.g. reservation-created precedes job-dispatched).
    this.events = [];
    // In-flight provider promises, keyed by job id.
    this.inflight = new Map();
    // Executors: provider id -> object with start(job) + requestCancel(jobId).
    // Stage 1 wires only the mock. Stage 2 registers real executors.
    this.mock = new MockProvider(this.registry.get('mock-t4'), mockOptions);
    this.executors = new Map([[this.mock.id, this.mock]]);
    // Attached NOVA Cloud Storage (NovaStorage) — null until
    // attachStorage() is called. createGpuCloud() attaches it; a bare
    // GpuManager has no storage and its storage methods throw.
    this.storage = null;
    // FreeLLMAPI gateway prompt enhancement (approved v5 design, A4/A5).
    // Disabled by default: no gateway client, no background task, no
    // behaviour change. When enabled, submit() registers a bounded
    // background enhancement task (never awaited) and dispatchNext()
    // resolves the effective prompt server-side. The policy defaults to
    // the production policy (fail closed: production jobs always use
    // the original prompt).
    this.enhancement = {
      enabled: enhancement.enabled ?? false,
      client: enhancement.client ?? null,
      directGemini: enhancement.directGemini ?? null,
      policy: enhancement.policy ?? null,
      authorizationStore: enhancement.authorizationStore ?? null,
      timeoutMs: enhancement.timeoutMs ?? GATEWAY_DEFAULT_TIMEOUT_MS,
    };
    this._defaultGatewayPolicy = buildGatewayPolicy({});
    // In-flight enhancement tasks, keyed by job id (test observability;
    // the tasks never hold a reservation or delay dispatch).
    this._enhancementTasks = new Map();
  }

  _gatewayPolicy() {
    return this.enhancement.policy ?? this._defaultGatewayPolicy;
  }

  // -- submission ---------------------------------------------------------

  // Submit a job. Idempotent: the same idempotency key always returns the
  // same job (created: false on a repeat) — never a second job, never a
  // second dispatch.
  submit({ idempotencyKey, type, modelId, prompt, params = {}, priority = 0 }) {
    const existingId = this.store.state.idempotency[idempotencyKey];
    if (existingId) {
      const existing = this.store.state.jobs[existingId];
      if (existing) {
        this._event('submit-duplicate', existing.id);
        return { job: existing, created: false };
      }
    }
    if (queueDepth(this.store.state) >= this.config.maxQueueDepth) {
      throw new QueueFullError(queueDepth(this.store.state), this.config.maxQueueDepth);
    }
    let job;
    this.store.mutate((s) => {
      s.seq += 1;
      job = createJob({
        idempotencyKey,
        type,
        modelId,
        prompt,
        params,
        priority,
        seq: s.seq,
        now: this.now(),
      });
      // FreeLLMAPI (A5 contract): the server — and only the server —
      // attaches the sandbox-authorization reference at intake, from a
      // trusted scope lookup on the job's D1 parent-job id. The caller
      // can never supply it.
      if (this.enhancement.enabled && this.enhancement.policy && typeof params?.jobId === 'string') {
        const auth = this.enhancement.policy.findAuthorizationForJob(params.jobId);
        if (auth) job.sandboxAuthorizationId = auth.authorizationId;
      }
      s.jobs[job.id] = job;
      s.idempotency[idempotencyKey] = job.id;
    });
    // FreeLLMAPI (A4 execution model): (1) the job is persisted above
    // with promptSource "user"; (2) the bounded background enhancement
    // task is registered WITHOUT awaiting it; (3) job-queued is emitted
    // exactly once; (4) submit returns under the existing lifecycle.
    // A duplicate submission (above) registers no task and emits no
    // second event.
    if (this.enhancement.enabled) this._registerEnhancementTask(job);
    this._event('job-queued', job.id);
    return { job, created: true };
  }

  // -- FreeLLMAPI enhancement (approved v5 design, A4/A5) -----------------
  //
  // Bounded best-effort background task. Never holds a reservation, never
  // delays dispatch, never creates a queue, never delays the submit
  // response. Failure or timeout leaves the job on its original prompt
  // (promptSource stays "user"). The 30 s timeout is the cancellation
  // mechanism (enforced by the gateway client / direct-Gemini adapter).

  _registerEnhancementTask(job) {
    // Deferred to a microtask: the task body (including its
    // enhancement-started event) runs only after submit() has returned,
    // so job-queued is emitted exactly once, before any enhancement
    // event, per the A4 execution model.
    const task = Promise.resolve()
      .then(() => this._runEnhancement(job))
      .catch(() => false);
    this._enhancementTasks.set(job.id, task);
    task.finally(() => {
      if (this._enhancementTasks.get(job.id) === task) this._enhancementTasks.delete(job.id);
    });
  }

  // The in-flight enhancement promise for a job, or null. Test helper.
  pendingEnhancement(jobId) {
    return this._enhancementTasks.get(jobId) ?? null;
  }

  // Wait for a job's enhancement task to settle (test helper). Resolves
  // immediately when no task is registered.
  async waitForEnhancement(jobId, timeoutMs = 5000) {
    const task = this._enhancementTasks.get(jobId);
    if (!task) return false;
    const deadline = Date.now() + timeoutMs;
    await task;
    if (Date.now() > deadline) throw new Error(`waitForEnhancement timed out for ${jobId}`);
    return true;
  }

  // Enhancement validation boundary (A4): non-empty string, at most 4,000
  // characters, no credential-like pattern. Returns { ok, reason }.
  _checkEnhancementText(text) {
    if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty' };
    if (text.length > 4000) return { ok: false, reason: 'too-long' };
    if (scanCredentialPatterns(text)) return { ok: false, reason: 'data-guard' };
    return { ok: true };
  }

  async _runEnhancement(job) {
    const enh = this.enhancement;
    const jobId = job.id;
    const current = () => this.store.state.jobs[jobId] ?? null;
    const discard = (reason) => {
      this._event('enhancement-discarded', jobId, { reason });
      return false;
    };
    // Never enhance in production (defense in depth — production startup
    // already rejects the flag).
    if (enh.policy?.environment === 'production') return discard('production');
    // Revalidate immediately before enhancement begins (sandbox): the
    // check reads current authoritative state, never a cached result.
    if (enh.policy?.environment === 'sandbox') {
      const live = current();
      if (!live || !enh.policy.hasValidOwnerAuthorization(live)) return discard('unauthorized');
    }
    this._event('enhancement-started', jobId, {});
    const original = job.prompt;
    let attempt = null;
    let lastFailure = null; // the most specific reason no enhancement was accepted
    // Fallback order (A4): gateway → direct Gemini (if configured) → raw
    // prompt. Each step is independent; a failure falls through without
    // raising. No retries inside the client.
    if (enh.client) {
      try {
        const result = await enh.client.enhance(original);
        const check = this._checkEnhancementText(result.content);
        if (check.ok) {
          attempt = {
            content: result.content,
            source: 'gateway',
            model: result.routedVia,
            requestedModel: enh.client.model,
            reportedModel: result.reportedModel,
          };
        } else {
          lastFailure = check.reason;
          this._event('enhancement-failed', jobId, { reason: check.reason });
        }
      } catch {
        this._event('enhancement-failed', jobId, { reason: 'gateway-failed' });
      }
    }
    if (!attempt && enh.directGemini) {
      try {
        const result = await enh.directGemini.enhance(original);
        const check = this._checkEnhancementText(result.content);
        if (check.ok) {
          attempt = {
            content: result.content,
            source: 'direct-gemini',
            model: enh.directGemini.modelIdentity,
            requestedModel: null,
            reportedModel: result.reportedModel ?? null,
          };
        } else {
          lastFailure = check.reason;
          this._event('enhancement-failed', jobId, { reason: check.reason });
        }
      } catch {
        this._event('enhancement-failed', jobId, { reason: 'direct-gemini-failed' });
      }
    }
    if (!attempt) return discard(lastFailure ?? 'unavailable');
    // Revalidate immediately before an enhanced prompt is accepted for
    // dispatch (sandbox): the second validation reads current
    // authoritative revocation state.
    if (enh.policy?.environment === 'sandbox') {
      const live = current();
      if (!live || !enh.policy.hasValidOwnerAuthorization(live)) return discard('unauthorized');
    }
    // Atomic conditional update: succeeds only while the job remains
    // queued and dispatch has not begun. A late result is discarded.
    let committed = false;
    this.store.mutate((s) => {
      const j = s.jobs[jobId];
      if (!j || j.status !== 'queued') return;
      j.enhancedPrompt = attempt.content;
      j.promptSource = 'enhanced';
      j.enhancementSource = attempt.source;
      j.enhancementModel = attempt.model;
      j.enhancementRequestedModel = attempt.requestedModel;
      j.enhancementReportedModel = attempt.reportedModel;
      j.updatedAt = this.now();
      committed = true;
    });
    if (!committed) return discard('late');
    this._event('enhancement-accepted', jobId, { source: attempt.source });
    return true;
  }

  getJob(jobId) {
    return this.store.state.jobs[jobId] ?? null;
  }

  getJobByKey(idempotencyKey) {
    const id = this.store.state.idempotency[idempotencyKey];
    return id ? this.store.state.jobs[id] ?? null : null;
  }

  listJobs(status) {
    const jobs = Object.values(this.store.state.jobs);
    return status ? jobs.filter((j) => j.status === status) : jobs;
  }

  // -- dispatch -----------------------------------------------------------

  // Dispatch the next queued job (priority FIFO) to a matching provider.
  // Order of operations is deliberate and tested:
  //   1. kill-switch check (no dispatch while engaged)
  //   2. capability match (model + per-card VRAM + capacity)
  //   3. spending-ceiling check (paid only)
  //   4. RESERVATION CREATED (before any dispatch)
  //   5. dispatch (job -> dispatched -> running; provider start invoked)
  // If step 5 cannot proceed (no executor wired), the reservation is
  // released and the job stays queued.
  dispatchNext() {
    if (isEngaged(this.store.state)) {
      return { dispatched: false, reason: 'kill-switch-engaged' };
    }
    const job = nextJob(this.store.state);
    if (!job) return { dispatched: false, reason: 'queue-empty' };

    const capable = this.registry
      .list()
      .filter((p) => this.registry.dispatchable(p.id))
      .filter((p) => providerSupports(p, job).ok)
      .filter((p) => this._activeJobsOn(p.id) < p.maxConcurrentJobs);

    // Rev 4.8 §5.3 audience routing (layer 1 — dispatcher): a personal
    // job routes ONLY to the personal executors; a public job routes
    // NEVER to them. A job without an audience (legacy/controlled-test
    // callers) is unfiltered — the API submit path always sets the
    // audience in production, so an unaudited job cannot reach a
    // personal executor through the site path. An unknown audience value
    // fails closed: no provider is capable.
    const jobAudience = job?.params?.audience;
    if (jobAudience === 'personal') {
      for (let i = capable.length - 1; i >= 0; i--) {
        if (!this.personalProviderIds.has(capable[i].id)) capable.splice(i, 1);
      }
    } else if (jobAudience === 'public') {
      for (let i = capable.length - 1; i >= 0; i--) {
        if (this.personalProviderIds.has(capable[i].id)) capable.splice(i, 1);
      }
    } else if (jobAudience !== undefined && jobAudience !== null) {
      capable.length = 0;
    }

    if (capable.length === 0) {
      return { dispatched: false, reason: 'no-provider', jobId: job.id };
    }
    // Prefer the cheapest capable provider (free first).
    capable.sort((a, b) => estimateCostUsd(a, job) - estimateCostUsd(b, job));
    const provider = capable[0];
    const estimatedUsd = estimateCostUsd(provider, job);

    // GLOBAL SPENDING CEILING. A paid dispatch proceeds only when the
    // ceiling covers the estimate on top of already-committed spend. With
    // the default ceiling of 0, no paid provider is ever dispatched.
    if (provider.costModel.type === 'paid') {
      const ceiling = this.store.state.ceiling.valueUsd;
      const committed = committedUsd(this.store.state);
      if (estimatedUsd > ceiling - committed) {
        return {
          dispatched: false,
          reason: 'ceiling-exceeded',
          jobId: job.id,
          providerId: provider.id,
          estimatedUsd,
          ceiling,
          committed,
        };
      }
    }

    // 4. Reservation BEFORE dispatch.
    let reservation;
    this.store.mutate((s) => {
      reservation = createReservation(s, {
        jobId: job.id,
        providerId: provider.id,
        estimatedUsd,
        now: this.now(),
      });
    });
    this._event('reservation-created', job.id, { reservationId: reservation.id });

    // 5. Dispatch — requires a wired executor. A dispatchable provider with
    // no executor (a Stage 2 job) releases its reservation and waits.
    const executor = this.executors.get(provider.id);
    if (!executor) {
      this.store.mutate((s) => {
        releaseReservation(s, reservation.id, 'no-executor', this.now());
      });
      return {
        dispatched: false,
        reason: 'no-executor',
        jobId: job.id,
        providerId: provider.id,
      };
    }

    // FreeLLMAPI (A5): the prompt the engine sees is the EFFECTIVE prompt,
    // resolved server-side from the stored record. A direct read of
    // job.prompt for dispatch is prohibited. The stored record keeps its
    // original prompt; the executor receives a copy carrying the
    // effective prompt. An enhanced prompt matching a credential-like
    // pattern is rejected for this dispatch (the original stands); a
    // pattern on the original is left to the executor's own boundary,
    // as today. A resolver refusal fails the job closed — it never
    // dispatches with a wrong prompt.
    let dispatchJob = job;
    try {
      const effective = effectivePrompt(job, this._gatewayPolicy());
      const pattern = scanCredentialPatterns(effective);
      if (pattern && job.promptSource === 'enhanced') {
        this._event('enhancement-discarded', job.id, { reason: 'data-guard' });
      } else if (!pattern && effective !== job.prompt) {
        dispatchJob = { ...job, prompt: effective };
      }
    } catch (err) {
      if (err instanceof InvalidJobError) {
        this._failJob(job.id, err.message);
        return {
          dispatched: false,
          reason: 'invalid-job',
          jobId: job.id,
        };
      }
      throw err;
    }

    try {
      const promise = executor.start(dispatchJob);
      this.store.mutate((s) => {
        const j = s.jobs[job.id];
        j.providerId = provider.id;
        j.reservationId = reservation.id;
        j.cost.estimatedUsd = estimatedUsd;
        transition(j, 'dispatched', this.now());
        transition(j, 'running', this.now());
      });
      this._event('job-dispatched', job.id, { providerId: provider.id });
      this._event('job-running', job.id);

      const done = promise.then(
        (report) => this._finalizeFromProvider(report),
        (err) =>
          this._finalizeFromProvider({
            jobId: job.id,
            providerId: provider.id,
            status: 'failed',
            secondsUsed: 0,
            costUsd: 0,
            completedAt: this.now(),
            error: String(err?.message ?? err),
          }),
      );
      this.inflight.set(job.id, done);
      done.finally(() => this.inflight.delete(job.id));
      return {
        dispatched: true,
        jobId: job.id,
        providerId: provider.id,
        reservationId: reservation.id,
      };
    } catch (err) {
      this._failJob(job.id, `provider start failed: ${err.message}`);
      return {
        dispatched: false,
        reason: 'provider-start-failed',
        jobId: job.id,
        providerId: provider.id,
      };
    }
  }

  // Dispatch until the queue is empty or nothing further can dispatch.
  // Stops at the head-of-line job when it cannot be placed (see queue.js).
  dispatchAll() {
    const results = [];
    for (;;) {
      const r = this.dispatchNext();
      results.push(r);
      if (!r.dispatched) break;
    }
    return results;
  }

  // -- cancellation + kill-switch -----------------------------------------

  // Cancel a job. Queued jobs go straight to cancelled. Dispatched/running
  // jobs get a cancellation REQUEST — the remote job may still complete
  // (VDP-02); its outcome is recorded when the provider reports back.
  cancelJob(jobId, reason = 'owner-cancel') {
    const job = this.store.state.jobs[jobId];
    if (!job) return null;
    if (isTerminal(job)) return job;
    if (job.status === 'queued') {
      this.store.mutate((s) => {
        transition(s.jobs[jobId], 'cancelled', this.now());
      });
      this._event('job-cancelled', jobId, { reason });
    } else {
      this.store.mutate((s) => {
        const j = s.jobs[jobId];
        j.cancellationRequested = true;
        j.cancellationRequestedAt = this.now();
      });
      this.executors.get(job.providerId)?.requestCancel?.(jobId);
      this._event('cancel-requested', jobId, { reason });
    }
    return this.store.state.jobs[jobId];
  }

  // Engage the kill-switch: no new dispatches; queued jobs are cancelled;
  // running/dispatched jobs get cancellation requests (they may still
  // complete — VDP-02). Returns what was affected.
  engageKillSwitch(reason) {
    const now = this.now();
    const cancelled = [];
    const cancelRequested = [];
    this.store.mutate((s) => {
      engageKillSwitch(s, reason, now);
      for (const job of Object.values(s.jobs)) {
        if (job.status === 'queued') {
          transition(job, 'cancelled', now);
          cancelled.push(job.id);
        } else if (job.status === 'dispatched' || job.status === 'running') {
          job.cancellationRequested = true;
          job.cancellationRequestedAt = now;
          cancelRequested.push(job.id);
        }
      }
    });
    for (const id of cancelRequested) {
      const job = this.store.state.jobs[id];
      this.executors.get(job.providerId)?.requestCancel?.(id);
    }
    this._event('kill-switch-engaged', null, {
      reason,
      cancelled: cancelled.length,
      cancelRequested: cancelRequested.length,
    });
    return { cancelled, cancelRequested };
  }

  disengageKillSwitch(reason = 'owner-resume') {
    this.store.mutate((s) => {
      disengageKillSwitch(s, reason, this.now());
    });
    this._event('kill-switch-disengaged', null, { reason });
  }

  killSwitchEngaged() {
    return isEngaged(this.store.state);
  }

  // -- timeouts -----------------------------------------------------------

  // Sweep dispatched/running jobs past their max generation time. A timed
  // out job is marked timed-out, its reservation is released, and it is
  // flagged for reconciliation — the provider may still charge for the
  // run that NOVA has given up on.
  checkTimeouts() {
    const now = this.now();
    const timedOut = [];
    this.store.mutate((s) => {
      for (const job of Object.values(s.jobs)) {
        if (job.status !== 'dispatched' && job.status !== 'running') continue;
        const started = startedClockAt(job);
        if (started === null) continue;
        if (now - started > job.timeoutMs) {
          transition(job, 'timed-out', now);
          job.reconciliationNeeded = true;
          if (job.reservationId) {
            releaseReservation(s, job.reservationId, 'job-timed-out', now);
          }
          timedOut.push(job.id);
        }
      }
    });
    for (const id of timedOut) this._event('job-timed-out', id);
    return timedOut;
  }

  // -- spending ceiling ---------------------------------------------------

  getSpendingCeiling() {
    return this.store.state.ceiling.valueUsd;
  }

  committedUsd() {
    return committedUsd(this.store.state);
  }

  // Raise (or lower) the global spending ceiling. This is an OWNER
  // DECISION, not a code default: it requires authorizedBy + reason, and
  // every change is recorded in the store's audit trail.
  setSpendingCeiling(valueUsd, { authorizedBy, reason } = {}) {
    if (typeof valueUsd !== 'number' || !Number.isFinite(valueUsd) || valueUsd < 0) {
      throw new Error('spending ceiling must be a finite number >= 0 (USD)');
    }
    if (!authorizedBy || !reason) {
      throw new Error(
        'changing the spending ceiling requires authorizedBy + reason (owner decision)',
      );
    }
    this.store.mutate((s) => {
      const previous = s.ceiling.valueUsd;
      s.ceiling.valueUsd = valueUsd;
      s.ceiling.changes.push({
        previousUsd: previous,
        valueUsd,
        authorizedBy,
        reason,
        at: this.now(),
      });
    });
    this._event('ceiling-changed', null, { valueUsd, authorizedBy });
    return this.store.state.ceiling.valueUsd;
  }

  // -- reconciliation -----------------------------------------------------

  // Compare provider statements against NOVA's records. Read-only on jobs;
  // the run itself is recorded in the store.
  reconcile(reports) {
    const result = reconcileReports(this.store.state.jobs, reports, this.now());
    this.store.mutate((s) => {
      s.reconciliations.push(result);
    });
    return result;
  }

  // Succeeded jobs with no provider statement at all.
  unreportedJobs(reportedJobIds) {
    return findUnreportedJobs(this.store.state.jobs, reportedJobIds);
  }

  // -- providers ----------------------------------------------------------

  registerProvider(def) {
    return this.registry.register(def);
  }

  // Wire an executor for a provider (Stage 2 registers real executors).
  // An executor needs start(job) -> Promise<report> and requestCancel(jobId).
  registerExecutor(providerId, executor) {
    if (typeof executor?.start !== 'function') {
      throw new Error('executor requires a start(job) function');
    }
    this.executors.set(providerId, executor);
    return executor;
  }

  providerStatus() {
    return this.registry.list().map((p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label,
      gpuType: p.gpuType,
      vramGb: p.vramGb,
      costModel: p.costModel,
      connected: p.connected,
      status: p.status,
      dispatchable: this.registry.dispatchable(p.id),
      activeJobs: this._activeJobsOn(p.id),
      maxConcurrentJobs: p.maxConcurrentJobs,
    }));
  }

  stats() {
    const byStatus = {};
    for (const job of Object.values(this.store.state.jobs)) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }
    return {
      jobs: Object.keys(this.store.state.jobs).length,
      byStatus,
      queueDepth: queueDepth(this.store.state),
      ceilingUsd: this.store.state.ceiling.valueUsd,
      committedUsd: committedUsd(this.store.state),
      killSwitchEngaged: isEngaged(this.store.state),
      inflight: this.inflight.size,
    };
  }

  // -- storage (NOVA Cloud Storage) ---------------------------------------
  //
  // The manager owns the store: it lands a job's output bytes there, hands
  // back a delivery reference, and runs the expiry sweep. The job record
  // holds REFERENCES only (outputRef + resultRef) — never media bytes
  // (O-27). Retention follows the store's namespace defaults: generated
  // outputs (outputs/media/text) expire 24h after creation; models, job
  // records and projects persist (owner direction, 24 Nov 2026 ~16:46).
  // See docs/storage/design.md §12 for the wiring + sweep-host choice.

  // Attach a NovaStorage instance. createGpuCloud() does this. A bare
  // GpuManager has no storage until attachStorage is called.
  attachStorage(storage) {
    const methods = ['put', 'get', 'head', 'delete', 'sweep', 'usage', 'issueDeliveryRef', 'redeemDeliveryRef', 'startSweepTimer', 'stopSweepTimer'];
    if (!storage || !methods.every((m) => typeof storage[m] === 'function')) {
      throw new Error('attachStorage requires a NovaStorage instance');
    }
    this.storage = storage;
    return storage;
  }

  _requireStorage() {
    if (!this.storage) {
      throw new Error('no storage attached — use createGpuCloud() or attachStorage() first');
    }
    return this.storage;
  }

  // Store a job's output bytes (Buffer, file path, or stream) in the
  // cloud store — default namespace 'outputs', the landing stage for a
  // fresh generation (24h TTL). Records { namespace, objectId, ... } on
  // the job as outputRef and returns the storage record. Storing a second
  // output for the same job replaces outputRef; the earlier object stays
  // in the store under its own TTL until it expires or is deleted.
  async storeJobOutput(jobId, { namespace = 'outputs', source, contentType = 'application/octet-stream', retention, ttlMs } = {}) {
    const storage = this._requireStorage();
    const job = this.store.state.jobs[jobId];
    if (!job) throw new Error(`unknown job ${jobId}`);
    const record = await storage.put({
      namespace,
      source,
      contentType,
      jobId,
      ...(retention !== undefined ? { retention } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    this.store.mutate((s) => {
      const j = s.jobs[jobId];
      j.outputRef = {
        namespace: record.namespace,
        objectId: record.objectId,
        sizeBytes: record.sizeBytes,
        contentType: record.contentType,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      };
      j.updatedAt = this.now();
    });
    this._event('job-output-stored', jobId, { namespace: record.namespace, objectId: record.objectId });
    return record;
  }

  // Retrieve a job's stored output as a verified stream (the engine
  // hash-checks every chunk before yielding it). When the output has
  // expired, the stale outputRef/resultRef are cleared and the
  // ObjectNotFoundError is rethrown.
  getJobOutput(jobId) {
    const storage = this._requireStorage();
    const outputRef = this._jobOutputRef(jobId);
    try {
      return storage.get({ namespace: outputRef.namespace, objectId: outputRef.objectId });
    } catch (err) {
      if (err?.name === 'ObjectNotFoundError') this._clearOutputRef(jobId);
      throw err;
    }
  }

  // Whole-output read as one Buffer. Small outputs only — large media
  // must stream through getJobOutput().
  async getJobOutputBuffer(jobId) {
    const storage = this._requireStorage();
    const outputRef = this._jobOutputRef(jobId);
    try {
      return await storage.getBuffer({ namespace: outputRef.namespace, objectId: outputRef.objectId });
    } catch (err) {
      if (err?.name === 'ObjectNotFoundError') this._clearOutputRef(jobId);
      throw err;
    }
  }

  // Metadata for a job's stored output, or null when the job has no
  // output (or it has expired — lazy expiry applies and the stale
  // references are cleared).
  headJobOutput(jobId) {
    const storage = this._requireStorage();
    const job = this.store.state.jobs[jobId];
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (!job.outputRef) return null;
    const record = storage.head({ namespace: job.outputRef.namespace, objectId: job.outputRef.objectId });
    if (!record) this._clearOutputRef(jobId);
    return record;
  }

  // Issue a delivery reference for a job's output and store it as the
  // job's resultRef — the opaque reference the design calls for, never
  // media bytes. Redeem it through storage.redeemDeliveryRef().
  // Async: issuing a ref mutates the store index, and index mutations
  // take the cross-process lock (Finding 10C) — the wait yields the loop.
  async issueJobDeliveryRef(jobId, { ttlMs, maxRedemptions } = {}) {
    const storage = this._requireStorage();
    const outputRef = this._jobOutputRef(jobId);
    const ref = await storage.issueDeliveryRef({
      namespace: outputRef.namespace,
      objectId: outputRef.objectId,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
    });
    this.store.mutate((s) => {
      const j = s.jobs[jobId];
      j.resultRef = ref.ref;
      j.updatedAt = this.now();
    });
    this._event('job-delivery-ref-issued', jobId);
    return ref;
  }

  // Delete a job's stored output for real (chunks + index record +
  // delivery references) and clear the job's outputRef/resultRef.
  // Returns true when an object was actually removed.
  async deleteJobOutput(jobId) {
    const storage = this._requireStorage();
    const job = this.store.state.jobs[jobId];
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (!job.outputRef) return false;
    const removed = await storage.delete(job.outputRef.namespace, job.outputRef.objectId);
    this._clearOutputRef(jobId);
    this._event('job-output-deleted', jobId);
    return removed;
  }

  // Usage accounting for the attached store (bytes + objects, per
  // namespace and total). Reporting only — no caps are enforced.
  storageUsage() {
    return this._requireStorage().usage();
  }

  async storageCapacity() {
    return this._requireStorage().capacity();
  }

  // Run the expiry sweep now (deletes expired objects for real).
  // Returns the sweep report.
  async runStorageSweep() {
    return this._requireStorage().sweep();
  }

  // Sweep timer, hosted on the manager: the manager is the long-lived
  // process that owns the store, so the timer starts and stops with it.
  // The timer is unref'd — it never holds a process open on its own.
  // The PRODUCTION host (Stage 4 API process, cron-triggered sweep, or
  // a dedicated daemon) is still an open owner decision; this is the
  // mechanism, not the deployment. See docs/storage/design.md §12.
  startStorageSweep(intervalMs = DEFAULT_SWEEP_INTERVAL_MS) {
    const storage = this._requireStorage();
    storage.startSweepTimer(intervalMs);
    this._event('storage-sweep-started', null, { intervalMs });
  }

  stopStorageSweep() {
    this._requireStorage().stopSweepTimer();
    this._event('storage-sweep-stopped', null);
  }

  _jobOutputRef(jobId) {
    const job = this.store.state.jobs[jobId];
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (!job.outputRef) throw new Error(`job ${jobId} has no stored output`);
    return job.outputRef;
  }

  _clearOutputRef(jobId) {
    this.store.mutate((s) => {
      const j = s.jobs[jobId];
      if (!j) return;
      j.outputRef = null;
      j.resultRef = null;
      j.updatedAt = this.now();
    });
  }

  // Wait until a job reaches a terminal state (test helper + Stage 4 use).
  async waitFor(jobId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.store.state.jobs[jobId];
      if (!job) throw new Error(`unknown job ${jobId}`);
      if (isTerminal(job)) return job;
      if (Date.now() > deadline) {
        throw new Error(`waitFor timed out for ${jobId} (status ${job.status})`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // -- internals ----------------------------------------------------------

  _activeJobsOn(providerId) {
    return Object.values(this.store.state.jobs).filter(
      (j) =>
        j.providerId === providerId &&
        (j.status === 'dispatched' || j.status === 'running'),
    ).length;
  }

  _releaseReservationForJob(state, job, reason, now) {
    if (job.reservationId) {
      releaseReservation(state, job.reservationId, reason, now);
    }
  }

  _failJob(jobId, error) {
    const now = this.now();
    this.store.mutate((s) => {
      const j = s.jobs[jobId];
      if (!j || isTerminal(j)) return;
      j.error = error;
      transition(j, 'failed', now);
      this._releaseReservationForJob(s, j, 'job-failed', now);
    });
    this._event('job-failed', jobId, { error });
    return this.store.state.jobs[jobId];
  }

  // Handle a provider completion report. Records the provider's own
  // numbers (seconds + cost) against NOVA's measured wall time, then
  // finalizes the job and releases its reservation.
  //
  // Two honest paths:
  // - Cancellation was requested: the job is marked cancelled, but the
  //   provider's outcome is preserved in cancelOutcome and the cost is
  //   kept for reconciliation (VDP-02).
  // - The job already went terminal (e.g. timed out): the report is kept
  //   in lateReports for reconciliation instead of being dropped — the
  //   provider may still have charged.
  _finalizeFromProvider(report) {
    const job = this.store.state.jobs[report.jobId];
    if (!job) {
      this._event('report-unknown-job', report.jobId);
      return null;
    }
    if (isTerminal(job)) {
      this.store.mutate((s) => {
        s.lateReports.push({ ...report, receivedAt: this.now() });
      });
      this._event('report-after-terminal', job.id, { status: job.status });
      return job;
    }
    const now = this.now();
    this.store.mutate((s) => {
      const j = s.jobs[report.jobId];
      j.cost.providerReportedUsd = report.costUsd ?? 0;
      j.cost.providerReportedSeconds = report.secondsUsed ?? null;
      j.cost.novaSeconds =
        j.startedAt !== null ? (now - j.startedAt) / 1000 : null;
      j.providerCompletedAt = report.completedAt ?? null;
      if (report.resultRef) j.resultRef = report.resultRef; // opaque ref only
      if (j.cancellationRequested) {
        j.cancelOutcome =
          report.status === 'succeeded' ? 'provider-completed' : 'provider-failed';
        if (report.error) j.error = report.error;
        transition(j, 'cancelled', now);
      } else if (report.status === 'succeeded') {
        transition(j, 'succeeded', now);
      } else {
        j.error = report.error ?? 'provider reported failure';
        transition(j, 'failed', now);
      }
      this._releaseReservationForJob(s, j, `job-${j.status}`, now);
    });
    const final = this.store.state.jobs[report.jobId];
    this._event('job-finalized', job.id, { status: final.status });
    return final;
  }

  _event(name, jobId, data = {}) {
    this.events.push({ name, jobId, at: this.now(), ...data });
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
  }
}
