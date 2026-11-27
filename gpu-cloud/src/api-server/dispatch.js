// NOVA AI Studio — Phase 3 API process: dispatch manager.
//
// Owns the manager-job lifecycle for one execution at a time:
//   spending-reserved → slot-claimed → executor-accepted → dispatched
// (Rev 3.1 §A-3.1.2.2, Rev 3.2 §B-3.2.8).
//
// The 202 rule (Rev 3.2 §B-3.2.8): the Worker returns 202 AFTER the
// spending reservation exists AND the slot is claimed. Executor
// acceptance is confirmed asynchronously and reported through status;
// it is NOT a precondition of the 202. /internal/submit therefore
// returns after slot-claim (inside the Worker's 10 s submit timeout),
// carrying dispatchState "slot-claimed" — or "executor-accepted" when
// acceptance already arrived before the response.
//
// Acknowledgement (Rev 3.1 §A-3.1.2.2, corrected by Rev 3.2 §B-3.2.3):
// acceptance is the status query FIRST reporting the execution as
// accepted-or-running — NOT the submission acknowledgement (push
// success / start() return), and NEVER the fileReport (the completion
// report). The 60-second window runs from the submission acknowledgement.
// On timeout the API process RECONCILES FIRST (never blindly
// redispatches an uncertain execution):
//   accepted|running  -> executor-accepted, dispatched, proceed
//   never-received    -> release both reservations (idempotent), fail
//                        with executor-ack-timeout, no second dispatch
//   unknown           -> reconciliation-needed, keep both reservations,
//                        do NOT redispatch, do NOT fail; the 15-minute
//                        reconciliation timer resolves it
//   completed         -> execution finished without a fileReport: stay
//                        awaiting the report, do NOT fail, do NOT redispatch
//   failed            -> release both reservations, fail with the
//                        executor's reason (executor-cancelled for
//                        CANCEL_ACKNOWLEDGED)
// A late acknowledgement after a legitimate terminal decision is recorded
// in lateReports and NEVER reverses the decision (Rev 3.2 §B-3.2.8.2).
//
// Capacity + headroom (Rev 2 §6.1, §6.3): the capacity check and the
// 50 MB headroom reservation happen in one guarded section. Node is
// single-threaded but the capacity probe is async, so submissions are
// serialised through a promise chain — no two submits can interleave
// between the capacity read and the reservation write.
//
// The API process talks to D1 ONLY through the Worker's signed internal
// endpoints (Rev 3 §C-1.1) via the injected d1Client. It never opens its
// own D1 connection.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACK_WINDOW_MS,
  JOB_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  PROVEN_MODEL,
  PROVEN_FRAMES,
  PROVEN_RESOLUTION,
  PROVEN_FPS,
} from './constants.js';
import { normalizeExecutorState, kaggleCancelReason } from './kaggle-status.js';
import { D1AuthError, D1RetryableError } from './d1-client.js';
import { checkRunnerHeartbeat } from './runner-heartbeat.js';
import { NON_COMMERCIAL_PURPOSES } from './activation.js';
import { signPersonalAttestation } from './attestation.js';
import { requiredVramGb } from '../phase6/resource-profiles.js';
import {
  buildGatewayPolicy,
  effectivePrompt,
  InvalidJobError,
} from '../gateway-policy.js';
import { scanCredentialPatterns } from '../data-guard.js';

const JOB_ID_RE = /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Parent-aggregate terminal statuses (Worker list-pending-jobs exclusion
// set, Rev 3 §C-1.3): the statuses after which the 30-day retention
// clock runs (Rev 2 §16.1).
const TERMINAL_JOB_STATUSES = new Set([
  'succeeded', 'partial_failed', 'failed', 'cancelled', 'expired',
]);

// The journal state the Worker understands (Rev 3 §C-1.8): the Worker
// decides from journal.state in {submitted, reservation, dispatched,
// provider-ack, failed}. Our internal dispatchState is richer; the
// status endpoint maps it to the Worker's vocabulary so a lost-response
// lookup resolves correctly.
const WORKER_STATE_FOR_DISPATCH_STATE = {
  'submitted': 'submitted',
  'spending-reserved': 'reservation',
  'slot-claimed': 'dispatched',
  'executor-accepted': 'provider-ack',
  'dispatched': 'dispatched',
  'failed': 'failed',
  'reconciliation-needed': 'submitted',
};

export class DispatchManager {
  // Executor registry (Rev 4.9 §4): the manager routes by the provider id
  // it actually reserved, so this class takes an executor REGISTRY keyed by
  // provider id — productionExecutors + personalExecutors (Maps), or a
  // single merged `executors` Map — instead of one executor object. The
  // legacy single `executor` option is still accepted (controlled-test
  // mode and existing callers): it is registered under its own id and
  // remains the fallback for executions recorded before the registry
  // existed. An explicitly-passed EMPTY registry is legitimate: production
  // mode with no production executor starts in the no-capacity state and
  // every production submit fails closed with 503 no-capacity. Passing
  // neither an executor nor any registry is a programming error and throws.
  // runnerHealthPath (optional): when set, every submit revalidates the
  // storage-runner heartbeat (Rev 4.9 §6/F-6a) and refuses 503
  // storage-full while the runner is unhealthy; when unset the gate is
  // skipped (direct-construction callers that own no runner).
  // authorisationCheck (optional, Rev 4.8 §6): async (audience) =>
  // { authorised, reason } — the §4.2 authorisation calculation against
  // live state, supplied by the API factory after construction (it closes
  // over the manager, dispatch, and activation state). When null, the
  // submit-time activation-flag revalidation is skipped (tests and
  // direct-construction callers); production servers always set it.
  // ownerTokenId (optional): the configured owner-token identifier
  // (NOVA_OWNER_TOKEN_ID). A personal submit's ownerTokenId must match
  // it when configured; null means the host is unconfigured and no
  // personal submit can be authorised.
  // attestationSigningSecret (optional, M2-P round 2): the API host's
  // server-held signing secret (NOVA_SIGNING_SECRET) the dispatcher
  // uses to generate the personal attestation at submit time. Without
  // it the API cannot generate an attestation, so a personal submit is
  // refused (fail closed) — the API never trusts an incoming
  // nonCommercialAttested boolean, and never accepts a personal submit
  // it cannot attest itself.
  constructor({
    manager,
    executor,
    executors,
    productionExecutors,
    personalExecutors,
    runnerHealthPath = null,
    d1Client,
    apiState,
    gatewayPolicy = null,
    mode = 'controlled-test',
    ackWindowMs = ACK_WINDOW_MS,
    ackPollMs = 1000,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    headroomBytes = MAX_OUTPUT_BYTES,
    validateOutput = null,
    authorisationCheck = null,
    ownerTokenId = null,
    attestationSigningSecret = null,
    now = () => Date.now(),
  } = {}) {
    if (!manager) throw new Error('DispatchManager requires a GpuManager');
    if (!d1Client) throw new Error('DispatchManager requires a d1Client');
    if (!apiState) throw new Error('DispatchManager requires an ApiStateStore');
    this.manager = manager;
    this.executors = new Map();
    this.productionExecutorIds = new Set();
    this.personalExecutorIds = new Set();
    let registryArg = false;
    const mergeRegistry = (map, ids) => {
      if (map === undefined || map === null) return;
      registryArg = true;
      const entries = map instanceof Map ? map.entries() : Object.entries(map);
      for (const [id, ex] of entries) {
        if (typeof ex?.start !== 'function') throw new Error(`DispatchManager registry entry ${id} requires a start(job) function`);
        this.executors.set(id, ex);
        if (ids) ids.add(id);
      }
    };
    mergeRegistry(executors, null);
    mergeRegistry(productionExecutors, this.productionExecutorIds);
    mergeRegistry(personalExecutors, this.personalExecutorIds);
    if (executor) {
      if (typeof executor?.start !== 'function') throw new Error('DispatchManager requires an executor with a start(job) function');
      this.executor = executor;
      // Executor identity: BaseExecutor-family executors carry providerId,
      // the controlled-test fake carries id.
      const legacyId = executor.providerId ?? executor.id ?? null;
      if (legacyId && !this.executors.has(legacyId)) this.executors.set(legacyId, executor);
    } else {
      this.executor = this.executors.size === 1 ? [...this.executors.values()][0] : null;
    }
    if (!this.executor && this.executors.size === 0 && !registryArg) {
      throw new Error('DispatchManager requires an executor or executor registry');
    }
    this.runnerHealthPath = runnerHealthPath;
    this.d1Client = d1Client;
    this.apiState = apiState;
    this.authorisationCheck = typeof authorisationCheck === 'function' ? authorisationCheck : null;
    this.ownerTokenId = typeof ownerTokenId === 'string' && ownerTokenId.length > 0 ? ownerTokenId : null;
    this.attestationSigningSecret = typeof attestationSigningSecret === 'string' && attestationSigningSecret.length > 0 ? attestationSigningSecret : null;
    // FreeLLMAPI (A5): the gateway policy for submit-time prompt
    // resolution. Defaults to the production policy (fail closed: no
    // enhancement in production, no authorization store).
    this.gatewayPolicy = gatewayPolicy ?? buildGatewayPolicy({});
    this.mode = mode;
    this.ackWindowMs = ackWindowMs;
    this.ackPollMs = ackPollMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.headroomBytes = headroomBytes;
    this.validateOutput = validateOutput;
    this.now = now;
    this._submitQueue = Promise.resolve();
    this._ackTimer = null;
  }

  // -- executor resolution (Rev 4.9 §4) -----------------------------------

  // The executor for one execution: the provider id the manager actually
  // reserved, recorded as entry.executorId at slot-claim. Falls back to
  // the legacy single executor ONLY when the entry carries no provider id
  // (pre-registry executions). When the entry carries a provider id that
  // is not registered, returns null — the caller treats that as unknown;
  // a supplied-but-unknown provider id must NEVER fall back to the legacy
  // executor (Rev 4.9, ChatGPT correction 4A).
  _executorForExecution(executionId) {
    const entry = this.journalEntry(executionId);
    if (entry?.executorId) {
      return this.executors.get(entry.executorId) ?? null;
    }
    return this.executor;
  }

  // The executor for a provider id: the legacy fallback applies ONLY
  // when there is NO provider id at all. A supplied provider id that is
  // not registered returns null — the caller treats that as unknown
  // (Rev 4.9, ChatGPT correction 4A).
  _executorForProvider(providerId) {
    if (providerId) {
      return this.executors.get(providerId) ?? null;
    }
    return this.executor;
  }

  // True when at least one production executor is registered. The
  // production submit gate is registry-aware, not unconditional: with the
  // empty Rev 4.9 allowlist it is false and production submits fail closed
  // with 503 no-capacity — the correct honest state, not a fake dispatch.
  _hasProductionExecutor() {
    return this.productionExecutorIds.size > 0;
  }

  // True when at least one personal executor is registered (Rev 4.8 §6).
  _hasPersonalExecutor() {
    return this.personalExecutorIds.size > 0;
  }

  // Set (or replace) the submit-time authorisation callback (Rev 4.8
  // §6): async (audience) => { authorised, reason }. The API factory
  // sets it after construction because it closes over the live manager,
  // dispatch, and activation state. A non-function clears it.
  setAuthorisationCheck(fn) {
    this.authorisationCheck = typeof fn === 'function' ? fn : null;
  }

  // -- journal ------------------------------------------------------------

  journalEntry(executionId) {
    this.apiState.reloadIfChanged();
    return this.apiState.state.dispatchJournal[executionId] ?? null;
  }

  _journalMutate(executionId, fn) {
    this.apiState.mutate((s) => {
      const entry = s.dispatchJournal[executionId] ?? {
        executionId,
        state: 'submitted',
        timestamps: {},
      };
      fn(entry);
      s.dispatchJournal[executionId] = entry;
    });
    return this.journalEntry(executionId);
  }

  _journalSetState(executionId, dispatchState, extra = {}) {
    return this._journalMutate(executionId, (entry) => {
      entry.state = dispatchState;
      entry.timestamps[dispatchState] = this.now();
      Object.assign(entry, extra);
    });
  }

  // -- D1 mutations (pending on failure, replayed at startup) -------------

  async _applyD1(mutations) {
    const requestId = randomUUID();
    try {
      const res = await this.d1Client.d1Apply(mutations, requestId);
      return { ok: true, result: res };
    } catch (err) {
      if (err instanceof D1AuthError) {
        this.apiState.logOperator('d1-apply-auth-failed', {
          requestId, error: err.message,
        });
        return { ok: false, auth: true };
      }
      // Retryable (5xx / timeout / network): record PENDING, replay later.
      this.apiState.mutate((s) => {
        s.pendingMutations.push({
          requestId,
          mutations,
          tries: 1,
          lastError: err && err.message ? err.message : String(err),
          createdAt: this.now(),
        });
      });
      this.apiState.logOperator('d1-mutation-pending', { requestId });
      return { ok: false, pending: true };
    }
  }

  async replayPendingMutations() {
    const pending = [...(this.apiState.state.pendingMutations || [])];
    let replayed = 0;
    let stillPending = 0;
    for (const item of pending) {
      try {
        await this.d1Client.d1Apply(item.mutations, item.requestId);
        this.apiState.mutate((s) => {
          s.pendingMutations = s.pendingMutations.filter(
            (p) => p.requestId !== item.requestId,
          );
        });
        replayed++;
      } catch (err) {
        if (err instanceof D1AuthError) {
          this.apiState.logOperator('d1-replay-auth-failed', { requestId: item.requestId });
          stillPending++;
          continue;
        }
        this.apiState.mutate((s) => {
          const p = s.pendingMutations.find((x) => x.requestId === item.requestId);
          if (p) {
            p.tries += 1;
            p.lastError = err && err.message ? err.message : String(err);
          }
        });
        stillPending++;
      }
    }
    return { replayed, stillPending };
  }

  // -- validation ---------------------------------------------------------

  _validateSubmitBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return 'body must be an object';
    }
    if (!JOB_ID_RE.test(body.jobId || '')) return 'invalid jobId';
    if (body.mode !== 'single' && body.mode !== 'plan') return 'invalid mode';
    if (body.model !== PROVEN_MODEL) return 'only ltx-video-2b is available';
    if (body.frames !== PROVEN_FRAMES) return 'frames must be 121';
    if (body.resolution !== PROVEN_RESOLUTION) return 'resolution must be 1024x576';
    if (body.fps !== PROVEN_FPS) return 'fps must be 24';
    if (body.mode === 'single' && typeof body.prompt !== 'string') {
      return 'prompt is required for mode single';
    }
    if (body.mode === 'plan' && !Array.isArray(body.scenes)) {
      return 'scenes are required for mode plan';
    }
    if (!Array.isArray(body.sceneExecutions) || body.sceneExecutions.length === 0) {
      return 'sceneExecutions are required';
    }
    if (body.sceneExecutions.length > 20) return 'at most 20 scene executions';
    for (const x of body.sceneExecutions) {
      if (!Number.isInteger(x.sceneIndex) || x.sceneIndex < 0 || x.sceneIndex > 19) {
        return 'sceneIndex must be an integer 0-19';
      }
      if (!Number.isInteger(x.attempt) || x.attempt < 1) return 'attempt must be >= 1';
      const expected = `${body.jobId}:scene-${x.sceneIndex}:attempt-${x.attempt}`;
      if (x.executionId !== expected) return `executionId must be ${expected}`;
      if (x.idempotencyKey !== expected) return 'idempotencyKey must equal the executionId';
    }
    return null;
  }

  // -- headroom (Rev 2 §6.3) ----------------------------------------------

  _reservedHeadroomBytes() {
    return Object.values(this.apiState.state.headroomReservations || {})
      .reduce((sum, r) => sum + (r.bytes || 0), 0);
  }

  // Synchronous reserve: called inside the serialised submit section,
  // never after an await that another submit could interleave with.
  _reserveHeadroom(executionId) {
    this.apiState.mutate((s) => {
      s.headroomReservations[executionId] = {
        bytes: this.headroomBytes,
        reservedAt: this.now(),
      };
    });
  }

  _releaseHeadroom(executionId) {
    this.apiState.mutate((s) => {
      delete s.headroomReservations[executionId];
    });
  }

  // -- submit -------------------------------------------------------------
  //
  // POST /internal/submit. Returns { status, body } for the HTTP layer.
  // Success: 202 { managerJobIds, dispatchState } — dispatchState is
  // "slot-claimed", or "executor-accepted" when acceptance already
  // arrived before the response. Capacity errors: 503 with
  // { error: "no-capacity" | "no-executor" | "ceiling" | "storage-full" }
  // (the Worker's named errors, Rev 2 §3.4). Validation errors: 400.

  async submitExecutions(body) {
    // Serialise the guarded section (capacity read + headroom reserve +
    // manager submit + dispatch) so two concurrent submits cannot
    // over-commit the last slot or the last 50 MB.
    const run = this._submitQueue.then(() => this._submitExecutionsInner(body));
    this._submitQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _submitExecutionsInner(body) {
    // FreeLLMAPI (A5 contract): the submit loads the stored D1 record by
    // body.jobId through the existing job-by-id lookup BEFORE the body is
    // validated, and the stored record — never the body prompt — is the
    // prompt that dispatches. A body that is not an object, or carries no
    // string jobId, has no job identity to look up and is refused 400
    // first; everything else is resolved from the stored record.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'invalid-submit', message: 'body must be an object' } };
    }
    if (typeof body.jobId !== 'string') {
      return { status: 400, body: { error: 'invalid-submit', message: 'invalid jobId' } };
    }
    let storedRecord;
    try {
      storedRecord = await this.d1Client.getJob(body.jobId);
    } catch {
      // The existing parentStatus shape: a D1 lookup failure is 502
      // d1-unavailable, never a blind retry and never a dispatch.
      return { status: 502, body: { error: 'd1-unavailable' } };
    }
    const storedData = this._parseStoredJobData(storedRecord);
    if (!storedRecord || !storedData || storedRecord.id !== body.jobId || storedData.id !== body.jobId) {
      // Missing, unloadable, or mismatched stored record: the body prompt
      // never substitutes for it — the existing not-found response.
      return { status: 404, body: { error: 'not-found' } };
    }
    let resolvedPrompt = null; // single mode: the resolved effective prompt
    if (body.mode === 'single') {
      if (typeof storedData.prompt !== 'string') {
        return { status: 404, body: { error: 'not-found' } };
      }
      try {
        resolvedPrompt = effectivePrompt(storedData, this.gatewayPolicy);
      } catch (err) {
        if (err instanceof InvalidJobError) {
          return { status: 400, body: { error: 'invalid-submit', message: err.message } };
        }
        throw err;
      }
      if (scanCredentialPatterns(resolvedPrompt)) {
        return { status: 400, body: { error: 'invalid-submit', message: 'prompt failed the data guard' } };
      }
    }

    const invalid = this._validateSubmitBody(body);
    if (invalid) return { status: 400, body: { error: 'invalid-submit', message: invalid } };

    // Audience validation (Rev 4.8 §5.2/§5.3): in production mode the
    // audience is mandatory ('public' | 'personal'); a missing or
    // unknown audience is 400 — its absence is a malformed request, not
    // a default to public. In controlled-test mode the audience is
    // optional (legacy callers); when present it must still be valid.
    const audience = body.audience ?? null;
    if (this.mode === 'production') {
      if (audience !== 'public' && audience !== 'personal') {
        return { status: 400, body: { error: 'invalid-submit', message: 'audience is required: public | personal' } };
      }
    } else if (audience !== null && audience !== 'public' && audience !== 'personal') {
      return { status: 400, body: { error: 'invalid-submit', message: 'audience must be public | personal' } };
    }

    // Mode gate (Rev 3 §C-1.4): the deployment mode is a property of the
    // deployment, never of a request. A controlled-test submission to a
    // production-mode process (or vice versa) is refused as no capacity.
    if (body.deploymentMode && body.deploymentMode !== this.mode) {
      return { status: 503, body: { error: 'no-capacity' } };
    }
    // The server-generated personal attestation for this submit (M2-P
    // round 2): created below, only for a personal submit that passes
    // the purpose + token-identifier checks, and carried into the
    // journal entry and the manager job. A refused submit discards it.
    let personalAttestation = null;
    if (this.mode === 'production') {
      // Rev 4.9 §4, audience-aware (Rev 4.8 §5.3): a public submit needs
      // a registered permitted production executor; a personal submit
      // needs the registered personal executor. The old unconditional
      // gate refused personal submits even with a personal executor
      // registered — that was the personal path closed by construction.
      // With the empty Rev 4.9 allowlist, public generation is honestly
      // unavailable; with no personal executor, personal generation is
      // honestly unavailable. Either way: 503 no-capacity, fail closed.
      if (audience === 'personal') {
        if (!this._hasPersonalExecutor()) {
          return { status: 503, body: { error: 'no-capacity' } };
        }
      } else if (!this._hasProductionExecutor()) {
        return { status: 503, body: { error: 'no-capacity' } };
      }
      // Non-commercial attestation (Rev 4.8 §12, M2-P round 2): the API
      // NEVER trusts an incoming nonCommercialAttested boolean — an
      // incoming boolean is ignored outright, and a personal submit
      // carrying one but no explicit purpose is still refused. The
      // attestation is generated HERE, server-side, only after the
      // Worker-authenticated submit passes the checks below: it binds
      // the verified owner-token identifier, the explicitly selected
      // purpose (one of the five — no default), and this job id, signed
      // with the API host's server-held signing secret. Without a
      // signing secret configured the API cannot generate one, so a
      // personal submit is refused (503, fail closed). The token
      // identifier must match the host's configured identifier when one
      // is configured — a submit attested under a different token
      // generation is not the owner's current attestation.
      if (audience === 'personal') {
        if (this.attestationSigningSecret === null) {
          return { status: 503, body: { error: 'no-capacity' } };
        }
        if (!NON_COMMERCIAL_PURPOSES.includes(body.nonCommercialPurpose)) {
          return { status: 400, body: { error: 'invalid-submit', message: `nonCommercialPurpose must be one of: ${NON_COMMERCIAL_PURPOSES.join(', ')}` } };
        }
        if (typeof body.ownerTokenId !== 'string' || body.ownerTokenId.length === 0) {
          return { status: 400, body: { error: 'invalid-submit', message: 'ownerTokenId is required for personal submissions' } };
        }
        if (this.ownerTokenId !== null && body.ownerTokenId !== this.ownerTokenId) {
          return { status: 400, body: { error: 'invalid-submit', message: 'ownerTokenId does not match the configured token identifier' } };
        }
        personalAttestation = signPersonalAttestation({
          ownerTokenId: body.ownerTokenId,
          purpose: body.nonCommercialPurpose,
          jobId: body.jobId,
          attestedAt: this.now(),
        }, this.attestationSigningSecret);
      }
      // Authorisation revalidation at acceptance (Rev 4.8 §6): the
      // §4.2 calculation (flag for this audience, kill-switch, quota
      // above floor, storage health) is re-checked live before any
      // reservation is made. A refusal holds nothing.
      if (this.authorisationCheck) {
        let check;
        try {
          check = await this.authorisationCheck(audience);
        } catch {
          return { status: 503, body: { error: 'no-capacity' } };
        }
        if (!check || check.authorised !== true) {
          return { status: 503, body: { error: 'no-capacity' } };
        }
      }
    }

    // Storage-runner heartbeat gate (Rev 4.9 §6, §14 Stage 2): every submit
    // revalidates the live heartbeat. A missing, unreadable, failed, or
    // older-than-two-hours heartbeat refuses the submit with 503
    // capacity_unavailable / storage-full; in-flight work is not cancelled.
    // The gate runs inside the serialised submit section, before any
    // reservation is made, so a refusal holds nothing.
    if (this.runnerHealthPath) {
      const heartbeat = checkRunnerHeartbeat(this.runnerHealthPath, this.now());
      if (!heartbeat.healthy) {
        return { status: 503, body: { error: 'storage-full' } };
      }
    }

    const executions = body.sceneExecutions;
    const prompts = new Map();
    if (body.mode === 'single') {
      // A5: single-mode manager jobs get the resolved prompt from the
      // stored record. The body prompt is never used for dispatch.
      for (const x of executions) prompts.set(x.executionId, resolvedPrompt);
    } else {
      const byIndex = new Map((body.scenes || []).map((s) => [s.index, s.prompt]));
      for (const x of executions) prompts.set(x.executionId, byIndex.get(x.sceneIndex) ?? '');
    }

    // Idempotency: an execution already in the journal with a manager job
    // returns the existing manager job — never a second job, never a
    // second dispatch (Rev 2 §5.2, §10.3).
    const managerJobIds = new Array(executions.length).fill(null);
    const missing = [];
    executions.forEach((x, i) => {
      const entry = this.journalEntry(x.executionId);
      if (entry && entry.managerJobId && entry.state !== 'failed') {
        managerJobIds[i] = entry.managerJobId;
      } else {
        missing.push({ x, i });
      }
    });
    if (missing.length === 0) {
      const dispatchState = this._aggregateDispatchState(executions);
      return { status: 202, body: { managerJobIds, dispatchState } };
    }

    // Journal repair (Rev 3.2 §B-3.2.2.2): the manager store is
    // authoritative for whether a manager job exists; the journal is
    // repaired to match it. A re-submit whose manager job already exists
    // (crash between manager creation and journal write) is repaired,
    // flagged journal-repaired, and never creates a second execution.
    for (const { x, i } of missing) {
      const existing = this.manager.getJobByKey(x.executionId);
      if (existing) {
        managerJobIds[i] = existing.id;
        this._journalMutate(x.executionId, (entry) => {
          entry.jobId = body.jobId;
          entry.sceneIndex = x.sceneIndex;
          entry.attempt = x.attempt;
          entry.managerJobId = existing.id;
          entry.executorId = existing.providerId ?? null;
          entry.state = 'slot-claimed';
          entry['journal-repaired'] = true;
          entry.timestamps['slot-claimed'] = this.now();
        });
      }
    }
    const stillMissing = missing.filter(({ i }) => managerJobIds[i] === null);
    if (stillMissing.length === 0) {
      return {
        status: 202,
        body: { managerJobIds, dispatchState: this._aggregateDispatchState(executions) },
      };
    }

    // Capacity + headroom, one guarded section (no await inside).
    // usableHeadroom = storageCapacity() - storageUsage() - reserved.
    let capacity;
    try {
      capacity = await this.manager.storageCapacity();
    } catch {
      return { status: 503, body: { error: 'storage-full' } };
    }
    const usage = this.manager.storageUsage();
    const reserved = this._reservedHeadroomBytes();
    const totalBytes = capacity && Number.isFinite(capacity.totalBytes)
      ? capacity.totalBytes
      : null;
    if (totalBytes === null) {
      // Capacity unmeasurable: fail closed, never accept blind (§15.3 rule
      // applied to storage headroom as well).
      return { status: 503, body: { error: 'storage-full' } };
    }
    const usableHeadroom = totalBytes - (usage.totalBytes || 0) - reserved;
    if (usableHeadroom < this.headroomBytes * stillMissing.length) {
      return { status: 503, body: { error: 'storage-full' } };
    }
    // Reserve synchronously — no await between this check and the reserve.
    for (const { x } of stillMissing) this._reserveHeadroom(x.executionId);

    // Record the submission in the journal before dispatch. The audience
    // and (for personal jobs) the server-generated signed attestation,
    // purpose, and token identifier are recorded here so the job's audit
    // record carries them from intake (§5.2, §12). The incoming
    // nonCommercialAttested boolean is never recorded — it is not a
    // marker and is never trusted.
    for (const { x } of stillMissing) {
      this._journalMutate(x.executionId, (entry) => {
        entry.jobId = body.jobId;
        entry.sceneIndex = x.sceneIndex;
        entry.attempt = x.attempt;
        entry.state = 'submitted';
        entry.timestamps.submitted = this.now();
        if (audience !== null) entry.audience = audience;
        if (audience === 'personal') {
          entry.personalAttestation = personalAttestation;
          entry.nonCommercialPurpose = body.nonCommercialPurpose;
          entry.ownerTokenId = body.ownerTokenId;
        }
      });
    }

    // Manager submit (idempotent on the execution ID) + dispatch loop.
    // Phase 6 Workstream G: the minimum VRAM comes from the measured
    // resource profile for the submitted config, not the old hardcoded
    // 12 GB. No measured profile covers the config (unreachable today —
    // validation pins the covered 121-frame config): keep 12 rather
    // than refuse a previously-accepted submit on this path.
    const measuredMinVramGb = requiredVramGb({
      model: body.model,
      resolution: body.resolution,
      frames: body.frames,
      steps: 8,
      decoderMode: 'single-pass',
      attentionBackend: 'default',
    });
    const minVramGb = measuredMinVramGb ?? 12;
    const submittedJobs = [];
    try {
      for (const { x } of stillMissing) {
        const { job } = this.manager.submit({
          idempotencyKey: x.executionId,
          type: 'video',
          modelId: PROVEN_MODEL,
          prompt: prompts.get(x.executionId) ?? '',
          params: {
            timeoutMs: this.jobTimeoutMs,
            minVramGb,
            estimatedSeconds: 300,
            executionId: x.executionId,
            jobId: body.jobId,
            sceneIndex: x.sceneIndex,
            // Rev 4.8 §5.3/§12: the audience travels with the job so the
            // dispatcher, executor, and transport each re-check it; a
            // personal job also carries its server-generated signed
            // attestation, purpose, and token identifier in the job
            // record (never an incoming nonCommercialAttested boolean).
            ...(audience !== null ? { audience } : {}),
            ...(audience === 'personal' ? {
              personalAttestation,
              nonCommercialPurpose: body.nonCommercialPurpose,
              ownerTokenId: body.ownerTokenId,
            } : {}),
          },
        });
        submittedJobs.push({ x, job });
      }
    } catch (err) {
      for (const { x } of stillMissing) this._releaseHeadroom(x.executionId);
      const reason = err && err.name === 'QueueFullError' ? 'no-capacity' : 'no-capacity';
      for (const { x } of stillMissing) {
        this._journalSetState(x.executionId, 'failed', { error: reason });
      }
      return { status: 503, body: { error: reason } };
    }

    // Dispatch until every submitted job is placed, or a failure stops us.
    // dispatchNext() places the head-of-line job; loop so each scene gets
    // its own slot claim in FIFO order.
    const placed = new Map(); // managerJobId -> { x, providerId }
    let dispatchFailure = null;
    for (let guard = 0; guard < submittedJobs.length + 2; guard++) {
      if (placed.size === submittedJobs.length) break;
      const r = this.manager.dispatchNext();
      if (r.dispatched) {
        const found = submittedJobs.find(({ job }) => job.id === r.jobId);
        if (found) placed.set(r.jobId, { x: found.x, providerId: r.providerId });
        continue;
      }
      if (r.reason === 'queue-empty') break;
      dispatchFailure = r;
      break;
    }

    if (placed.size !== submittedJobs.length) {
      const reason = dispatchFailure
        ? this._dispatchFailureError(dispatchFailure)
        : 'no-capacity';
      // Compensation (Rev 2 §10.3): release headroom, fail the unplaced
      // executions in D1, flag reconciliation. Placed executions keep
      // their slot claims (they are dispatched; the Worker is told only
      // about the failure if NOTHING was placed — see below).
      for (const { x, job } of submittedJobs) {
        if (placed.has(job.id)) continue;
        this._releaseHeadroom(x.executionId);
        this._journalSetState(x.executionId, 'failed', { error: reason });
        await this._failSceneInD1(body.jobId, x, reason);
      }
      if (placed.size === 0) {
        return { status: 503, body: { error: reason } };
      }
      // Partial placement: report the placed jobs; the failed scenes are
      // already failed in D1 and the journal. The Worker marks them failed
      // from the D1 record on its next status read.
      for (const [managerJobId, { x }] of placed) {
        const idx = executions.findIndex((e) => e.executionId === x.executionId);
        managerJobIds[idx] = managerJobId;
      }
      return {
        status: 202,
        body: { managerJobIds, dispatchState: 'slot-claimed', partialFailure: reason },
      };
    }

    // Slot-claimed for every execution: spending reservation (created by
    // dispatchNext before dispatch) + named executor assignment.
    for (const [managerJobId, { x, providerId }] of placed) {
      const idx = executions.findIndex((e) => e.executionId === x.executionId);
      managerJobIds[idx] = managerJobId;
      // Rev 4.9 §4: the submission record comes from the executor for the
      // provider the manager actually reserved — never from a single
      // assumed executor.
      const placedExecutor = this._executorForProvider(providerId);
      const submission = placedExecutor?.submissions
        ? placedExecutor.submissions.get(managerJobId)
        : null;
      this._journalMutate(x.executionId, (entry) => {
        entry.managerJobId = managerJobId;
        entry.executorId = providerId;
        entry.kernelSlug = submission ? submission.kernelSlug ?? null : null;
        entry.submissionAckAt = submission ? submission.submittedAt ?? this.now() : this.now();
        entry.state = 'slot-claimed';
        entry.timestamps['spending-reserved'] = this.now();
        entry.timestamps['slot-claimed'] = this.now();
      });
      this._attachFinalizer(x, managerJobId);
    }

    // One immediate acceptance probe: if the status query already reports
    // accepted/running, record executor-accepted now and return it.
    let allAccepted = true;
    for (const { x } of stillMissing) {
      const entry = this.journalEntry(x.executionId);
      if (!entry || entry.state !== 'slot-claimed') { allAccepted = false; continue; }
      const execState = this._queryExecutor(x.executionId);
      if (execState.state === 'accepted' || execState.state === 'running') {
        this._journalSetState(x.executionId, 'executor-accepted', {
          executorState: execState.state, evidence: execState.evidence,
        });
        this._journalSetState(x.executionId, 'dispatched');
      } else if (execState.state === 'completed') {
        // Finished without a fileReport: acceptance is implied; await the
        // report, do NOT fail, do NOT redispatch (§B-3.2.3.2).
        this._journalSetState(x.executionId, 'executor-accepted', {
          executorState: 'completed', evidence: execState.evidence,
        });
        this._journalSetState(x.executionId, 'dispatched');
      } else {
        allAccepted = false;
      }
    }
    if (!allAccepted) this._startAckWatcher();

    return {
      status: 202,
      body: {
        managerJobIds,
        dispatchState: allAccepted ? 'executor-accepted' : 'slot-claimed',
      },
    };
  }

  _aggregateDispatchState(executions) {
    const states = executions.map((x) => {
      const e = this.journalEntry(x.executionId);
      return e ? e.state : 'submitted';
    });
    if (states.every((s) => s === 'executor-accepted' || s === 'dispatched')) {
      return 'executor-accepted';
    }
    return 'slot-claimed';
  }

  _dispatchFailureError(r) {
    switch (r.reason) {
      case 'no-executor':
      case 'provider-start-failed':
        return 'no-executor';
      case 'ceiling-exceeded':
        return 'ceiling';
      case 'invalid-job':
        // FreeLLMAPI (A5): the resolver refused the job at dispatch
        // (production + enhanced, or sandbox without authorization).
        // The job is already failed; the submit reports the refusal.
        return 'invalid-job';
      case 'kill-switch-engaged':
      case 'no-provider':
      case 'queue-empty':
      default:
        return 'no-capacity';
    }
  }

  // Parse a stored D1 job record's data payload. Returns the parsed
  // object, or null when the record is missing or unloadable (A5).
  _parseStoredJobData(record) {
    if (!record || typeof record.data !== 'string') return null;
    try {
      const data = JSON.parse(record.data);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  async _failSceneInD1(jobId, x, reason) {
    await this._applyD1([{
      type: 'scene-update',
      jobId,
      sceneIndex: x.sceneIndex,
      attempt: x.attempt,
      status: 'failed',
      error: reason,
      outputRef: null,
      expiresAt: null,
    }]);
  }

  // -- executor state query (authoritative, at the source) ----------------

  _queryExecutor(executionId) {
    // Rev 4.9 §4: state is queried from the executor for the provider
    // reserved for THIS execution — a different provider's executor must
    // never answer for it.
    const executor = this._executorForExecution(executionId);
    if (!executor || typeof executor.getExecutionState !== 'function') {
      return { state: 'unknown', evidence: { raw: null } };
    }
    try {
      const res = executor.getExecutionState(executionId);
      if (res && typeof res.state === 'string') return res;
    } catch (err) {
      return { state: 'unknown', evidence: { queryError: String(err && err.message ? err.message : err) } };
    }
    return { state: 'unknown', evidence: { raw: null } };
  }

  // Apply one executor-state answer to a journal entry (the §A-3.1.2.3
  // case table, as amended by §B-3.2.3.2). Returns the action taken.
  // Never blindly redispatches; never reverses a terminal decision.
  _applyExecutorState(entry, execState, source) {
    const executionId = entry.executionId;
    // Terminal already decided: a late acceptance is evidence, not a
    // command (Rev 3.2 §B-3.2.8.2). Record it, change nothing.
    if (entry.state === 'failed') {
      if (execState.state === 'accepted' || execState.state === 'running' || execState.state === 'completed') {
        this._recordLateReport(entry, execState, source);
      }
      return 'late-ignored';
    }
    if (entry.state === 'executor-accepted' || entry.state === 'dispatched') {
      return 'already-accepted';
    }
    switch (execState.state) {
      case 'accepted':
      case 'running':
        this._journalSetState(executionId, 'executor-accepted', {
          executorState: execState.state, evidence: execState.evidence,
        });
        this._journalSetState(executionId, 'dispatched');
        return 'accepted';
      case 'completed':
        this._journalSetState(executionId, 'executor-accepted', {
          executorState: 'completed', evidence: execState.evidence,
        });
        this._journalSetState(executionId, 'dispatched');
        return 'accepted-completed';
      case 'never-received':
        this._failExecution(entry, 'executor-ack-timeout', source);
        return 'failed-never-received';
      case 'failed': {
        const reason = kaggleCancelReason(execState.evidence && execState.evidence.raw)
          || 'executor-failed';
        this._failExecution(entry, reason, source);
        return 'failed-executor';
      }
      case 'unknown':
      default: {
        // Still inside the window: keep waiting. Past the window: mark
        // reconciliation-needed, keep both reservations, do NOT fail.
        const ackAt = entry.submissionAckAt ?? entry.timestamps['slot-claimed'] ?? this.now();
        if (this.now() - ackAt > this.ackWindowMs) {
          this._journalSetState(executionId, 'reconciliation-needed', {
            executorState: 'unknown', evidence: execState.evidence,
          });
          this._setReconciliation(entry, source);
          return 'reconciliation-needed';
        }
        return 'waiting';
      }
    }
  }

  _recordLateReport(entry, execState, source) {
    this.manager.store.mutate((s) => {
      if (!Array.isArray(s.lateReports)) s.lateReports = [];
      s.lateReports.push({
        executionId: entry.executionId,
        jobId: entry.jobId,
        state: execState.state,
        evidence: execState.evidence ?? null,
        receivedAt: this.now(),
        source,
        note: 'late acknowledgement after terminal decision; state unchanged',
      });
    });
    this.apiState.logOperator('late-acknowledgement', {
      executionId: entry.executionId,
      executorState: execState.state,
      source,
    });
  }

  _setReconciliation(entry, source) {
    this.apiState.mutate((s) => {
      const rec = s.reconciliation[entry.executionId]
        ?? { attempts: 0, firstAt: this.now(), lastAt: null, escalated: false };
      if (rec.firstAt === undefined || rec.firstAt === null) rec.firstAt = this.now();
      rec.attempts += 1;
      rec.lastAt = this.now();
      s.reconciliation[entry.executionId] = rec;
    });
    this.apiState.logOperator('reconciliation-needed', {
      executionId: entry.executionId, source,
    });
  }

  // Fail an execution: release both reservations idempotently, fail the
  // manager job (via the executor's failure path so the start promise
  // resolves and the manager finalises + releases its reservation), fail
  // the D1 scene row, journal failed. No second dispatch ever occurs for
  // this execution ID.
  async _failExecution(entry, reason, source) {
    const executionId = entry.executionId;
    if (entry.reservationsReleased) {
      // Idempotent release: a second release with the same identity is a
      // no-op, recorded once (Rev 3.1 §A-3.1.2.2).
      this._journalSetState(executionId, 'failed', { error: reason });
      return;
    }
    this._releaseHeadroom(executionId);
    const managerJobId = entry.managerJobId;
    if (managerJobId) {
      let resolved = false;
      // Rev 4.9 §4: the failure is reported through the executor that ran
      // this execution (the reserved provider's executor), not a single
      // assumed executor.
      const executor = this._executorForExecution(executionId);
      if (executor && typeof executor.reportFailure === 'function') {
        try { resolved = executor.reportFailure(managerJobId, reason); } catch { resolved = false; }
      }
      if (!resolved) {
        const job = this.manager.getJob(managerJobId);
        if (job && job.status !== 'succeeded' && job.status !== 'failed'
          && job.status !== 'cancelled' && job.status !== 'timed-out') {
          try { this.manager._failJob(managerJobId, reason); } catch { /* best effort */ }
        }
      }
    }
    this._journalMutate(executionId, (e) => {
      e.state = 'failed';
      e.error = reason;
      e.reservationsReleased = true;
      e.timestamps.failed = this.now();
    });
    this.apiState.logOperator('execution-failed', { executionId, reason, source });
    await this._failSceneInD1(entry.jobId, {
      sceneIndex: entry.sceneIndex, attempt: entry.attempt,
    }, reason);
    // The parent may now be terminal (the manager finaliser also records
    // it when it runs; this covers the case where nothing was pending and
    // no finaliser runs).
    await this._recordTerminalIfTerminal(entry.jobId);
  }

  // -- acknowledgement watcher --------------------------------------------

  _startAckWatcher() {
    if (this._ackTimer) return;
    this._ackTimer = setInterval(() => {
      void this._pollAckWatcher();
    }, this.ackPollMs);
    if (typeof this._ackTimer.unref === 'function') this._ackTimer.unref();
  }

  _stopAckWatcherIfIdle() {
    const pending = Object.values(this.apiState.state.dispatchJournal || {})
      .some((e) => e.state === 'slot-claimed' || e.state === 'spending-reserved' || e.state === 'submitted');
    if (!pending && this._ackTimer) {
      clearInterval(this._ackTimer);
      this._ackTimer = null;
    }
  }

  async _pollAckWatcher() {
    const entries = Object.values(this.apiState.state.dispatchJournal || {})
      .filter((e) => e.state === 'slot-claimed' || e.state === 'spending-reserved' || e.state === 'submitted');
    for (const entry of entries) {
      const execState = this._queryExecutor(entry.executionId);
      this._applyExecutorState(entry, execState, 'ack-watcher');
    }
    this._stopAckWatcherIfIdle();
  }

  // Called by the reconciliation timer (and startup reconciliation) for
  // one execution: re-query and apply the case table. Returns the action.
  // A FAILED entry is still queried: a late acceptance after the
  // terminal decision must be recorded in lateReports (Rev 3.2
  // §B-3.2.8.2), and that can only happen by asking the executor.
  // An already-accepted/dispatched entry is settled — the executor's
  // later state does not change it.
  reconcileExecution(executionId, source = 'reconciliation-timer') {
    const entry = this.journalEntry(executionId);
    if (!entry) return 'absent';
    if (entry.state === 'executor-accepted' || entry.state === 'dispatched') {
      return 'settled';
    }
    const execState = this._queryExecutor(executionId);
    const action = this._applyExecutorState(entry, execState, source);
    if (action === 'waiting') {
      // Still inside the window at reconcile time: record the attempt.
      this._setReconciliation(entry, source);
    }
    return action;
  }

  // -- completion ---------------------------------------------------------
  //
  // The manager finalises the job when the executor's start() promise
  // resolves (fileReport / reportFailure). This finalizer runs after
  // that: validate the output, store it, issue the delivery ref, and
  // update D1. Validation runs BEFORE storage (§18).

  _attachFinalizer(x, managerJobId) {
    const done = this.manager.inflight.get(managerJobId);
    if (!done || typeof done.then !== 'function') return;
    done.then(
      () => { void this._finalizeExecution(x, managerJobId); },
      () => { void this._finalizeExecution(x, managerJobId); },
    );
  }

  async _finalizeExecution(x, managerJobId) {
    await this._finalizeExecutionInner(x, managerJobId);
    // Whatever the outcome, the parent may now be terminal: record the
    // retention candidate (first observation wins; the sweep re-checks
    // the aggregate before deleting anything). The execution object
    // carries no jobId — it lives on the journal entry (same pattern the
    // inner finaliser uses for its D1 calls).
    const entry = this.journalEntry(x.executionId);
    await this._recordTerminalIfTerminal(entry ? entry.jobId : x.jobId);
  }

  // Retention candidate recording (Rev 2 §16.1, Q3 approved 25 Nov
  // 2026): when the parent aggregate is terminal, record the job with
  // terminalAt = now. The aggregate is read back from D1 after the
  // scene update, so the clock starts at the PARENT's terminal
  // transition, not the first scene's. A failure to read D1 here is
  // non-fatal: the sweep's journal backfill re-derives the candidate on
  // the next run.
  async _recordTerminalIfTerminal(jobId) {
    if (!jobId) return;
    let job;
    try {
      job = await this.d1Client.getJob(jobId);
    } catch {
      return;
    }
    if (!job) return;
    let data;
    try {
      data = JSON.parse(job.data);
    } catch {
      return;
    }
    if (!TERMINAL_JOB_STATUSES.has(data.status)) return;
    this.apiState.mutate((s) => {
      if (!s.retentionCandidates[jobId]) {
        s.retentionCandidates[jobId] = { terminalAt: this.now(), firstSeenAt: this.now() };
      }
    });
  }

  async _finalizeExecutionInner(x, managerJobId) {
    const entry = this.journalEntry(x.executionId);
    const job = this.manager.getJob(managerJobId);
    if (!job) return;
    if (job.status === 'cancelled') {
      this._releaseHeadroom(x.executionId);
      if (entry && entry.state !== 'failed') {
        this._journalSetState(x.executionId, 'failed', { error: 'cancelled' });
      }
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: 'cancelled', error: job.cancelOutcome ?? null,
        outputRef: null, expiresAt: null,
      }]);
      return;
    }
    if (job.status !== 'succeeded') {
      // Failed / timed-out at the manager: mirror to D1, release headroom.
      this._releaseHeadroom(x.executionId);
      if (entry && entry.state !== 'failed') {
        this._journalSetState(x.executionId, 'failed', { error: job.error ?? 'executor-failed' });
      }
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: job.status === 'timed-out' ? 'timed-out' : 'failed',
        error: job.error ?? 'executor-failed', outputRef: null, expiresAt: null,
      }]);
      return;
    }
    // Manager succeeded: the output must still validate before storage.
    // Rev 4.9 §4: the completion report comes from the executor that ran
    // this execution (the reserved provider's executor).
    const executor = this._executorForExecution(x.executionId);
    const report = executor?.lastReport
      ? executor.lastReport(managerJobId)
      : null;
    const outputPath = report ? report.outputPath : null;
    if (!outputPath) {
      this._releaseHeadroom(x.executionId);
      const reason = 'validation-missing-output';
      if (entry) this._journalSetState(x.executionId, 'failed', { error: reason });
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: 'failed', error: reason, outputRef: null, expiresAt: null,
      }]);
      this.apiState.logOperator('validation-failed', {
        executionId: x.executionId, reason,
        note: 'manager job succeeded but no output file was filed',
      });
      return;
    }
    let validation;
    try {
      validation = this.validateOutput
        ? await this.validateOutput(outputPath)
        : { ok: false, error: 'validation-unavailable' };
    } catch (err) {
      validation = { ok: false, error: 'validation-error' };
    }
    if (!validation.ok) {
      this._releaseHeadroom(x.executionId);
      const reason = validation.error || 'validation-failed';
      if (entry) this._journalSetState(x.executionId, 'failed', { error: reason });
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: 'failed', error: reason, outputRef: null, expiresAt: null,
      }]);
      this.apiState.logOperator('validation-failed', { executionId: x.executionId, reason });
      return;
    }
    // Valid: store, issue the delivery ref, update D1. The headroom
    // reservation is released and replaced by the real object accounting.
    try {
      const record = await this.manager.storeJobOutput(managerJobId, {
        namespace: 'outputs',
        source: outputPath,
        contentType: 'video/mp4',
      });
      const ref = await this.manager.issueJobDeliveryRef(managerJobId, {});
      this._releaseHeadroom(x.executionId);
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: 'succeeded', error: null,
        outputRef: ref.ref, expiresAt: record.expiresAt,
      }]);
      if (entry) {
        this._journalMutate(x.executionId, (e) => {
          e.outputRef = ref.ref;
          e.expiresAt = record.expiresAt;
          e.sha256 = validation.sha256 ?? null;
        });
      }
    } catch (err) {
      this._releaseHeadroom(x.executionId);
      const reason = 'storage-failed';
      if (entry) this._journalSetState(x.executionId, 'failed', { error: reason });
      await this._applyD1([{
        type: 'scene-update', jobId: entry ? entry.jobId : x.jobId, sceneIndex: x.sceneIndex,
        attempt: x.attempt, status: 'failed', error: reason, outputRef: null, expiresAt: null,
      }]);
      this.apiState.logOperator('storage-failed', {
        executionId: x.executionId, error: err && err.message ? err.message : String(err),
      });
    }
  }

  // -- status lookups (Rev 3 §C-1.8) --------------------------------------
  //
  // Execution-level lookup (for uncertain-submission resolution): the
  // Worker's vocabulary in `state`, our internal dispatchState alongside,
  // plus the six-state executorState when known.

  executionStatus(executionId) {
    const entry = this.journalEntry(executionId);
    if (!entry) return null;
    const execState = (entry.state === 'slot-claimed' || entry.state === 'reconciliation-needed')
      ? this._queryExecutor(executionId)
      : null;
    return {
      executionId: entry.executionId,
      jobId: entry.jobId,
      sceneIndex: entry.sceneIndex,
      attempt: entry.attempt,
      state: WORKER_STATE_FOR_DISPATCH_STATE[entry.state] ?? 'submitted',
      dispatchState: entry.state,
      executorState: entry.executorState
        ?? (execState ? execState.state : undefined),
      managerJobId: entry.managerJobId ?? null,
      executorId: entry.executorId ?? null,
      error: entry.error ?? null,
      timestamps: entry.timestamps ?? {},
    };
  }

  async parentStatus(jobId) {
    const job = await this.d1Client.getJob(jobId);
    const scenes = await this.d1Client.listScenes(jobId);
    const jobData = job ? JSON.parse(job.data) : null;
    const byExecution = new Map();
    for (const s of scenes) byExecution.set(s.execution_id, s);
    const out = [];
    for (const s of scenes) {
      const entry = this.journalEntry(s.execution_id);
      out.push({
        executionId: s.execution_id,
        sceneIndex: s.scene_index,
        attempt: s.attempt,
        status: s.status,
        managerJobId: s.provider_job_id ?? (entry ? entry.managerJobId : null),
        error: s.error ?? null,
        expiresAt: s.expires_at ?? null,
        dispatchState: entry ? entry.state : undefined,
      });
    }
    return {
      jobId,
      aggregateStatus: jobData ? jobData.status : null,
      scenes: out,
    };
  }

  // -- cancel (Rev 2 §3.4) -------------------------------------------------

  async cancelExecution(jobId, executionId) {
    const entry = this.journalEntry(executionId);
    if (!entry || entry.jobId !== jobId) return { status: 404, body: { error: 'not-found' } };
    const managerJobId = entry.managerJobId;
    if (!managerJobId) {
      return { status: 404, body: { error: 'not-dispatched' } };
    }
    const job = this.manager.getJob(managerJobId);
    if (!job) return { status: 404, body: { error: 'not-found' } };
    this.manager.cancelJob(managerJobId, 'owner-cancel');
    const cancelled = job.status === 'cancelled';
    this._journalMutate(executionId, (e) => {
      e.cancelRequestedAt = this.now();
      e.cancelOutcome = job.cancelOutcome ?? null;
    });
    if (cancelled) {
      // The manager job terminalised as cancelled immediately (it was
      // still queued — no finaliser will run for it, since no inflight
      // promise exists). The API process must do the D1 update and the
      // headroom release itself here, or the scene would stay queued in
      // D1 forever.
      this._releaseHeadroom(executionId);
      this._journalSetState(executionId, 'failed', { error: 'cancelled' });
      await this._applyD1([{
        type: 'scene-update', jobId, sceneIndex: entry.sceneIndex,
        attempt: entry.attempt, status: 'cancelled', error: job.cancelOutcome ?? null,
        outputRef: null, expiresAt: null,
      }]);
      await this._recordTerminalIfTerminal(jobId);
    }
    return {
      status: 200,
      body: {
        jobId,
        executionId,
        status: cancelled ? 'cancelled' : 'cancel-requested',
        cancelOutcome: job.cancelOutcome ?? null,
      },
    };
  }

  // -- operator completion channel (CLI-only, never HTTP) ------------------
  //
  // File a provider completion report for one execution (the manual
  // fileReport channel, Rev 2 §7). The report's outputPath is the
  // generated file to validate + store. Returns the executor's filing
  // outcome. Admin operations are CLI-only (Rev 2 §11.6).
  //
  // Operator reports arrive two ways: with `outputPath` (a file already
  // on this host, e.g. handed over by the executor) or with `output`
  // (a Buffer, e.g. from the admin CLI). A Buffer is written to a temp
  // file first — the validator and the storage engine both work from
  // paths — and the temp file is registered in the api-state temp-file
  // registry so the sweep removes it after 1 hour (§16.3) even if the
  // validation fails. Status vocabulary: the executor wire uses
  // "complete" (KernelWorkerStatus.COMPLETE); the manager contract uses
  // "succeeded". This boundary maps "complete" → "succeeded" so the
  // operator channel can speak the wire word.

  async fileReportForExecution(executionId, report) {
    const entry = this.journalEntry(executionId);
    if (!entry || !entry.managerJobId) {
      return { filed: false, reason: 'no-such-execution' };
    }
    let outputPath = report.outputPath ?? null;
    if (!outputPath && report.output) {
      const buf = Buffer.isBuffer(report.output)
        ? report.output
        : Buffer.from(report.output);
      outputPath = path.join(os.tmpdir(), `nova-output-${executionId}-${randomUUID()}.mp4`);
      await fs.promises.writeFile(outputPath, buf);
      this.apiState.mutate((s) => {
        s.tempFiles[outputPath] = { jobId: entry.jobId, createdAt: this.now() };
      });
    }
    const status = report.status === 'complete' || report.status === 'succeeded'
      ? 'succeeded'
      : 'failed';
    // Rev 4.9 §4: the report is filed with the executor that ran this
    // execution (the reserved provider's executor).
    const executor = this._executorForExecution(executionId);
    if (!executor || typeof executor.fileReport !== 'function') {
      return { filed: false, reason: 'no-executor-for-provider' };
    }
    return executor.fileReport({
      ...report,
      status,
      outputPath,
      jobId: entry.managerJobId,
    });
  }

  stop() {
    if (this._ackTimer) {
      clearInterval(this._ackTimer);
      this._ackTimer = null;
    }
  }
}
