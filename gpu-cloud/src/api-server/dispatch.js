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
import { CHECKPOINT_SHA256, requiredVramGb } from '../phase6/resource-profiles.js';
import {
  canonicaliseJson,
  canonicalRequestHash,
  isNexoraJobId,
} from './nexora-auth.js';
import { validateAttestation } from './nexora-attestation.js';
import { licenceSatisfiedFor } from './licence.js';
import { isNexoraHalted } from './nexora-halt.js';
import {
  commissioningAuthorised,
  consumeCommissioningPermit,
  expireCommissioningPermit,
} from './commissioning.js';
import {
  buildGatewayPolicy,
  effectivePrompt,
  InvalidJobError,
} from '../gateway-policy.js';
import { scanCredentialPatterns } from '../data-guard.js';
import { nextJob } from '../queue.js';
import { isEngaged } from '../kill-switch.js';
import { hasConsumedMarker } from './commissioning.js';

const JOB_ID_RE = /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// NEXORA-origin jobId namespacing (Kaggle design v13, §3 D-2.3): the
// NEXORA jobId is `nexora:<uuidv4>` — a different namespace from the
// Worker `nova-job-<uuid>`; the two never collide and a NEXORA job has
// no D1 record, so it never goes through the Worker submit path. The
// pattern (isNexoraJobId, from nexora-auth.js) is the shared UUIDv4
// rule (version 4, variant [89ab], lowercase hex only, fullmatch); a
// key may submit only its own namespace.

// NEXORA storage reservation (design §6.2): 200 MB per accepted job.
const NEXORA_STORAGE_BYTES = 200 * 1024 * 1024;

// Bounded personal queue slot (Rev 4.8 §14): 2 TOTAL across both
// personal origins. v13 §6.2 adds the per-origin cap: 1 per origin —
// a NEXORA submit is refused while its origin already holds its slot.
const PERSONAL_QUEUE_BOUND = 2;
const PER_ORIGIN_QUEUE_BOUND = 1;

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
  // v13 §6.2/§6.3 terminal + held states: a cancelled job reads as
  // failed to the Worker; a held job is still waiting (submitted).
  'cancelled-by-halt': 'failed',
  'cancelled-held': 'failed',
  'cancelled-by-human': 'failed',
  'device-mismatch': 'failed',
  'held-licence-undetermined': 'submitted',
  'held-activation-false': 'submitted',
  'held-activation-config-invalid': 'submitted',
  'held-activation-config-changed': 'submitted',
  'held-permit-marker-missing': 'submitted',
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
  // nexora (optional, Kaggle design v4): the NEXORA wiring —
  // { ledger, jobBudgetHours, isActivationValid,
  //   activationInvalidReason, activationFlags }. Without it,
  // submitNexora fails closed (503 no-capacity) and commissioning
  // authorisation is unavailable.
  //   ledger: a PerOriginLedger (manager store) — the sole authority
  //     for NEXORA acceptance arithmetic.
  //   jobBudgetHours: J, the budgeted hours per job (default 0.5).
  //   isActivationValid: () => boolean — the activation.conf strict
  //     re-verification latch (commissioning refuses when invalid).
  // stagingStore (optional, Kaggle design v13 §5.7): the push-model
  // staging store — keyframes arrive via POST /internal/stage and the
  // submit re-verifies their hashes from it. Without it, a NEXORA
  // submit fails closed (503 staging-unavailable).
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
    nexora = null,
    stagingStore = null,
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
    this.nexora = nexora && typeof nexora === 'object' ? nexora : null;
    this.stagingStore = stagingStore ?? null;
    // Kaggle design v13 §6.2: manager job ids whose NEXORA finaliser
    // is already attached. A queued NEXORA job may be placed later by
    // another submit's dispatch loop or by reEvaluateHeldJobs — the
    // finaliser attaches on ANY placement, exactly once.
    this._nexoraFinalized = new Set();
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

  // -- commissioning (Kaggle design v4, §3.5) ---------------------------

  // The commissioning predicate for one Worker-path submit: the permit
  // binds the canonical hash of the EXACT submit body (canonicalised
  // JSON — the body carries integers only, so the JS canonicalisation
  // matches; see nexora-auth.js::canonicaliseJson). A NEXORA-origin
  // request never reaches this helper (submitNexora does not consult
  // commissioning); the origin is 'nova' by construction here, and the
  // key id is the Worker key — 'nexora-v1' is refused by the predicate.
  _commissioningForRequest(body) {
    if (!this.nexora) return { ok: false, reason: 'no-permit' };
    const hash = canonicalRequestHash(canonicaliseJson(body));
    return commissioningAuthorised(this.apiState, {
      jobCanonicalHash: hash,
      origin: 'nova',
      keyId: 'worker',
      // The caller only reaches this helper from the not-activated
      // refusal branch, so the personal flag is false by construction.
      personalActivated: false,
      activationValid: typeof this.nexora.isActivationValid === 'function'
        ? this.nexora.isActivationValid()
        : true,
      checkpointSha256: CHECKPOINT_SHA256,
      // v13 §6.5: max_hours is a ceiling on the job's budgeted hours J.
      jobHours: this.nexora.jobBudgetHours ?? DEFAULT_JOB_BUDGET_HOURS,
      nowMs: this.now(),
    });
  }

  // -- headroom (Rev 2 §6.3) ----------------------------------------------

  _reservedHeadroomBytes() {
    return Object.values(this.apiState.state.headroomReservations || {})
      .reduce((sum, r) => sum + (r.bytes || 0), 0);
  }

  // Synchronous reserve: called inside the serialised submit section,
  // never after an await that another submit could interleave with.
  // `bytes` defaults to the per-execution headroom (50 MB); the NEXORA
  // path reserves 200 MB under its jobId instead.
  _reserveHeadroom(executionId, bytes = this.headroomBytes) {
    this.apiState.mutate((s) => {
      s.headroomReservations[executionId] = {
        bytes,
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

  // -- NEXORA submit (Kaggle design v4, §4 step 6, §5.2) ---------------
  //
  // POST /internal/submit for a NEXORA-authenticated request. A SEPARATE
  // method from submitExecutions (Worker path): NEXORA jobs have NO D1
  // record, so the Worker path's D1-record-first lookup would 404 them;
  // do not bend the Worker path. Order (brief §4, design §4 step 6):
  //   1. schema (audience personal, origin nexora, jobId nexora:<uuid>,
  //      LTX parameters exactly the Run 10 set);
  //   2. purpose declarations (owner_personal_work, authenticated_owner,
  //      third_party_work false, channel fields);
  //   3. attestation valid in the registry — BEFORE the idempotency
  //      lookup (an expired attestation refuses a duplicate with
  //      attestation-expired, §5.8);
  //   3b. licence gate (F-15): no rendering of any kind without a
  //      licence determination for the LTX checkpoint;
  //   4. mirrored halt clear + kill-switch/activation via the
  //      authorisation check (NEXORA jobs NEVER run under commissioning);
  //   5. quota ledger floor AND cap;
  //   6. storage: 200 MB reservable;
  //   7. staging fetch + SHA-256 verify per keyframe;
  //   8. idempotency (same jobId + same hash → 200 existing;
  //      different hash → 409);
  //   9. reserve personal queue slot (bound 2) + 200 MB + budgeted
  //      hours, create the manager job (jobId as idempotency key),
  //      dispatch;
  //   10. audit in the journal (never the prompt text).
  // Returns { status, body } for the HTTP layer.

  async submitNexora(body, bodyText = '') {
    const run = this._submitQueue.then(async () => {
      const out = await this._submitNexoraInner(body, bodyText);
      // T-V30: every refused NEXORA submit is recorded in the NOVA
      // audit (the operator log — the journal carries accepted jobs
      // only), so a refusal is visible on both sides. Audit logging
      // never fails a submit.
      if (out.status >= 400) {
        try {
          this.apiState.logOperator('nexora-submit-refused', {
            jobId: body?.jobId ?? null,
            status: out.status,
            error: out.body?.error ?? null,
            reason: out.body?.reason ?? null,
          });
        } catch { /* ignore */ }
      }
      return out;
    });
    this._submitQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  _validateNexoraSubmitBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return 'body must be an object';
    }
    if (body.audience !== 'personal') return 'audience must be personal';
    if (body.origin !== 'nexora') return 'origin must be nexora';
    if (!isNexoraJobId(body.jobId)) return 'invalid jobId';
    const ltx = body.ltx_parameters;
    if (!ltx || typeof ltx !== 'object' || Array.isArray(ltx)) {
      return 'ltx_parameters are required';
    }
    const ltxKeys = Object.keys(ltx).sort();
    const expectedKeys = ['engine', 'frames', 'guidance', 'height', 'seed', 'steps', 'width'];
    if (JSON.stringify(ltxKeys) !== JSON.stringify(expectedKeys)) {
      return 'ltx_parameters must be exactly the Run 10 set (engine, frames, width, height, steps, guidance, seed)';
    }
    if (ltx.engine !== 'ltx-video-2b') return 'ltx engine must be ltx-video-2b';
    if (ltx.frames !== 121) return 'ltx frames must be 121';
    if (ltx.width !== 1024) return 'ltx width must be 1024';
    if (ltx.height !== 576) return 'ltx height must be 576';
    if (ltx.steps !== 8) return 'ltx steps must be 8';
    if (ltx.guidance !== 1) return 'ltx guidance must be 1.0';
    if (ltx.seed !== 42) return 'ltx seed must be 42';
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return 'prompt is required';
    }
    const keyframes = body.keyframe_hashes;
    if (!keyframes || typeof keyframes !== 'object' || Array.isArray(keyframes)) {
      return 'keyframe_hashes are required';
    }
    if (!/^[0-9a-f]{64}$/i.test(keyframes.first || '')) {
      return 'keyframe_hashes.first must be a SHA-256 hex digest';
    }
    if (!/^[0-9a-f]{64}$/i.test(keyframes.last || '')) {
      return 'keyframe_hashes.last must be a SHA-256 hex digest';
    }
    if (typeof body.attestation_id !== 'string' || body.attestation_id.length === 0) {
      return 'attestation_id is required';
    }
    return null;
  }

  // -- v13 §6.2/§3.5: held-at-dispatch + origin pause -------------------
  // A NEXORA job is held at dispatch when its origin has a ledger
  // orphan (a reservation held past 24 h with a non-terminal job):
  // the origin is paused until the operator resolves the orphan.
  // The 'worker' origin maps to 'commissioning'-origin reservations —
  // the only NOVA-origin jobs that hold ledger reservations.
  _originPaused(origin) {
    if (!this.nexora?.ledger) return false;
    const wanted = origin === 'worker' ? 'commissioning' : origin;
    return this.nexora.ledger.findOrphans().some((r) => r.origin === wanted);
  }

  // Public wrapper for the route layer: the staging route refuses an
  // origin-paused origin after auth, before reading/staging anything.
  isOriginPaused(origin) {
    return this._originPaused(origin);
  }

  // Kaggle design v13 §5.7: sweep unreferenced staged files older than
  // 1 h — regardless of halt / pause / activation. Called by the
  // interval sweep in api-server.js; best-effort, returns the sweep
  // counts (or { deleted: 0, bytesFreed: 0 } with no store).
  sweepStaging() {
    if (!this.stagingStore) return { deleted: 0, bytesFreed: 0 };
    return this.stagingStore.sweepUnreferenced();
  }

  // The pre-handoff re-check (§6.2 v13): before the dispatcher hands
  // a personal job to the executor, re-check the licence record +
  // activation validity (NEXORA jobs: licence + activation validity +
  // flag; commissioning jobs: consumed marker + licence +
  // activation validity — the time conditions are NOT re-evaluated
  // and the permit file may be absent at dispatch). Returns null when
  // the job may dispatch, or the held reason ('held-...') when it must
  // wait. Ordinary personal jobs get the licence re-check only.
  _preHandoffHold(head) {
    if (head?.params?.audience !== 'personal') return null;
    const nexora = this.nexora;
    if (!nexora) return null;
    // Activation validity (the latch) — shared by every personal job.
    if (typeof nexora.isActivationValid === 'function' && !nexora.isActivationValid()) {
      const reason = typeof nexora.activationInvalidReason === 'function'
        ? nexora.activationInvalidReason()
        : null;
      return `held-${reason ?? 'activation-config-invalid'}`;
    }
    if (head.params.origin === 'nexora') {
      // NEXORA job: licence + flag.
      if (!licenceSatisfiedFor(this.apiState, CHECKPOINT_SHA256)) {
        return 'held-licence-undetermined';
      }
      const flags = typeof nexora.activationFlags === 'function' ? nexora.activationFlags() : null;
      if (flags && flags.personalProductionActivated !== true) {
        return 'held-activation-false';
      }
      return null;
    }
    // Worker-path personal job: find its journal entry to tell a
    // commissioning job (permit id recorded) from an ordinary one.
    const entryKey = head.params.executionId ?? head.params.jobId ?? null;
    const entry = entryKey ? this.journalEntry(entryKey) : null;
    if (entry?.commissioningPermitId) {
      // Commissioning job: the consumed marker must exist (it is the
      // proof this job consumed the permit); the licence must still
      // hold for the checkpoint; the flag is NOT re-checked (the
      // permit authorises in place of it) and the time conditions are
      // NOT re-evaluated (a permit that expires between acceptance
      // and push does not stop the push — T-V35).
      if (!hasConsumedMarker(this.apiState, entry.commissioningPermitId)) {
        return 'held-permit-marker-missing';
      }
      if (!licenceSatisfiedFor(this.apiState, CHECKPOINT_SHA256)) {
        return 'held-licence-undetermined';
      }
      return null;
    }
    // Ordinary personal job: licence only.
    if (!licenceSatisfiedFor(this.apiState, CHECKPOINT_SHA256)) {
      return 'held-licence-undetermined';
    }
    return null;
  }

  // Mark a manager job held in the dispatch journal (the manager job
  // itself stays 'queued' — the held state lives in the journal, and
  // the reservation is retained). The loop stops: a held head job
  // blocks the queue until it clears or is cancelled.
  _markJobHeld(head, reason) {
    const entryKey = head.params.origin === 'nexora'
      ? head.params.jobId
      : (head.params.executionId ?? head.params.jobId);
    if (!entryKey) return;
    this._journalMutate(entryKey, (e) => {
      e.state = reason;
      e.heldReason = reason;
      e.timestamps[reason] = this.now();
    });
    this.apiState.logEvent('personal-job-held', {
      jobId: head.params.jobId ?? head.params.executionId ?? head.id,
      managerJobId: head.id,
      origin: head.params.origin ?? 'worker',
      reason,
    });
  }

  // A job whose hold cause cleared returns to the plain queued state
  // the next time a dispatch loop reaches it — the journal must not
  // keep saying 'held-*' after the cause is gone (the job is still
  // queued; it simply waits for the executor now).
  _clearHeldState(head) {
    const entryKey = head.params.origin === 'nexora'
      ? head.params.jobId
      : (head.params.executionId ?? head.params.jobId);
    if (!entryKey) return;
    const entry = this.journalEntry(entryKey);
    if (!entry || typeof entry.state !== 'string' || !entry.state.startsWith('held-')) return;
    this._journalMutate(entryKey, (e) => {
      e.state = 'submitted';
      delete e.heldReason;
    });
  }

  // Dispatch one head-of-line job with the v13 pre-handoff re-check.
  // Returns the manager's result, except a held job returns
  // { dispatched: false, reason: 'held-...', jobId } WITHOUT calling
  // dispatchNext (the job stays queued at the head). On ANY placement
  // of a NEXORA job, attaches its ledger finaliser (exactly once).
  _dispatchPersonalNext() {
    if (isEngaged(this.manager.store.state)) {
      return { dispatched: false, reason: 'kill-switch-engaged' };
    }
    const head = nextJob(this.manager.store.state);
    if (!head) return { dispatched: false, reason: 'queue-empty' };
    const hold = this._preHandoffHold(head);
    if (hold) {
      this._markJobHeld(head, hold);
      return { dispatched: false, reason: hold, jobId: head.id };
    }
    this._clearHeldState(head);
    const r = this.manager.dispatchNext();
    if (r.dispatched) {
      this._onPersonalPlaced(head, r);
    }
    return r;
  }

  // A NEXORA job placed by ANY dispatch loop gets its ledger finaliser
  // (exactly once per manager job id) so its reservation settles on
  // the confirmed terminal state even when another submit placed it.
  _onPersonalPlaced(head, result) {
    if (head?.params?.origin !== 'nexora') return;
    if (!this.nexora?.ledger) return;
    const managerJobId = result.jobId;
    if (this._nexoraFinalized.has(managerJobId)) return;
    this._nexoraFinalized.add(managerJobId);
    const jobId = head.params.jobId;
    this._attachNexoraFinalizer(jobId, managerJobId, this.nexora);
  }

  // Re-evaluate every held personal job (operator + called from the
  // submit loop path): a held job whose cause cleared dispatches now;
  // one still held stays held (its reason updated when it changed).
  // Returns the held jobs' states after re-evaluation.
  reEvaluateHeldJobs() {
    const results = [];
    const journal = this.apiState.state.dispatchJournal || {};
    for (const [key, entry] of Object.entries(journal)) {
      if (typeof entry?.state !== 'string' || !entry.state.startsWith('held-')) continue;
      const jobId = entry.managerJobId ?? null;
      const job = jobId ? this.manager.getJob(jobId) : null;
      if (!job || job.status !== 'queued') {
        results.push({ key, jobId: entry.jobId ?? key, state: entry.state });
        continue;
      }
      // Only the head job can dispatch (head-of-line discipline).
      const head = nextJob(this.manager.store.state);
      if (!head || head.id !== job.id) {
        results.push({ key, jobId: entry.jobId ?? key, state: entry.state });
        continue;
      }
      const r = this._dispatchPersonalNext();
      const after = this.journalEntry(key);
      results.push({
        key,
        jobId: entry.jobId ?? key,
        state: after?.state ?? entry.state,
        dispatched: r.dispatched === true,
      });
    }
    return results;
  }

  // Operator cancel-held (audit-logged, evidence: the reason the job
  // was held): the manager job is cancelled, the ledger + headroom
  // reservations are released, the journal files 'cancelled-held'.
  // Never blocked by halt / kill-switch / pause — this is the
  // operator's escape hatch for a held job.
  cancelHeldJob(jobId, { reason = 'operator-cancel-held' } = {}) {
    const entry = this.journalEntry(jobId);
    if (!entry || typeof entry.state !== 'string' || !entry.state.startsWith('held-')) {
      return { ok: false, reason: 'not-held' };
    }
    const heldReason = entry.heldReason ?? entry.state;
    const managerJobId = entry.managerJobId ?? null;
    if (managerJobId) {
      this.manager.cancelJob(managerJobId, 'cancelled-held');
    }
    if (this.nexora?.ledger) {
      this.nexora.ledger.release({ jobId });
    }
    this._releaseHeadroom(jobId);
    // A cancelled-held job never reaches the finaliser, so its staged
    // references are released here.
    this.stagingStore?.unreferenceJob(jobId);
    this._journalMutate(jobId, (e) => {
      e.state = 'cancelled-held';
      e.timestamps['cancelled-held'] = this.now();
    });
    this.apiState.logOperator('nexora-held-cancelled', {
      jobId,
      held_reason: heldReason,
      reason,
    });
    this.apiState.logEvent('nexora-held-cancelled', {
      jobId,
      held_reason: heldReason,
      reason,
    });
    return { ok: true, jobId, heldReason };
  }

  // True when any job of this origin is held at dispatch (journal
  // state 'held-*'). 'worker' covers every non-NEXORA personal job.
  hasHeldJob(origin) {
    const journal = this.apiState.state.dispatchJournal || {};
    return Object.values(journal).some((e) => {
      if (typeof e?.state !== 'string' || !e.state.startsWith('held-')) return false;
      if (origin === 'nexora') return e.origin === 'nexora';
      if (origin === 'worker') return e.origin !== 'nexora';
      return true;
    });
  }

  async _submitNexoraInner(body, bodyText) {
    const nexora = this.nexora;
    // NEXORA acceptance requires the NEXORA wiring (ledger, staging);
    // without it the path fails closed.
    if (!nexora || !nexora.ledger) {
      return { status: 503, body: { error: 'no-capacity' } };
    }
    const jobBudgetHours = nexora.jobBudgetHours ?? 0.5;

    // (1) Schema.
    const schemaError = this._validateNexoraSubmitBody(body);
    if (schemaError) {
      // v13 §3 D-2.3: a jobId outside the caller's namespace (wrong
      // prefix, bad UUIDv4 shape, trailing newline) is 400
      // invalid-job-id, distinct from other schema failures.
      if (schemaError === 'invalid jobId') {
        return { status: 400, body: { error: 'invalid-job-id', message: schemaError } };
      }
      return { status: 400, body: { error: 'invalid-submit', message: schemaError } };
    }
    // (2) Purpose declarations (§5.4). Any other value → refused and
    // recorded in the audit (the refusal is journalled below via the
    // operator log — the journal carries no entry for a refused submit,
    // so the refusal is logged, not journalled).
    if (body.purpose !== 'owner_personal_work') {
      return { status: 400, body: { error: 'invalid-submit', message: 'purpose must be owner_personal_work' } };
    }
    if (body.requester !== 'authenticated_owner') {
      return { status: 400, body: { error: 'invalid-submit', message: 'requester must be authenticated_owner' } };
    }
    if (body.third_party_work !== false) {
      return { status: 400, body: { error: 'invalid-submit', message: 'third_party_work must be false' } };
    }
    if (typeof body.target_channel_id !== 'string' || body.target_channel_id.length === 0) {
      return { status: 400, body: { error: 'invalid-submit', message: 'target_channel_id is required' } };
    }
    if (body.target_channel_status !== 'non_monetised') {
      return { status: 400, body: { error: 'invalid-submit', message: 'target_channel_status must be non_monetised' } };
    }
    // (3) Duplicate-jobId lookup — BEFORE attestation (design §4
    // step 6 v13, §5.8): an identical re-submit returns the existing
    // state even when the attestation has since expired, and reconcile
    // via GET /internal/job needs no attestation at all. Same jobId +
    // same hash → 200 existing state, no new reservation, no new
    // manager job. Same jobId + different hash → 409
    // idempotency-conflict. A crash between manager creation and
    // journal write is repaired from the manager store, never a second
    // execution. The hash is SHA-256 over the raw request body (the
    // wire body IS the canonical JSON — see
    // nexora-auth.js::canonicalRequestHash). NOTE: the hash covers the
    // FULL submit payload INCLUDING attestation_id (the landed NEXORA
    // client hashes the full payload — see the v13 implementation
    // report); a re-submit under a FRESH attestation id therefore
    // hashes differently and 409s, while an identical re-submit
    // returns the existing state.
    const hash = canonicalRequestHash(bodyText);
    const entry = this.journalEntry(body.jobId);
    if (entry && entry.managerJobId && entry.state !== 'failed') {
      if (entry.canonical_request_hash === hash) {
        return { status: 200, body: this.nexoraJobState(body.jobId) };
      }
      return { status: 409, body: { error: 'idempotency-conflict', canonical_request_hash: hash } };
    }
    const byKey = this.manager.getJobByKey(body.jobId);
    if (byKey) {
      const storedHash = byKey.params?.canonicalRequestHash ?? null;
      if (storedHash === hash) {
        this._journalMutate(body.jobId, (e) => {
          e.jobId = body.jobId;
          e.managerJobId = byKey.id;
          e.executorId = byKey.providerId ?? null;
          e.state = 'slot-claimed';
          e.canonical_request_hash = hash;
          e['journal-repaired'] = true;
          e.timestamps['slot-claimed'] = this.now();
        });
        return { status: 200, body: this.nexoraJobState(body.jobId) };
      }
      return { status: 409, body: { error: 'idempotency-conflict', canonical_request_hash: hash } };
    }
    // (4) Attestation valid in the registry (NEXORA-origin only).
    const att = validateAttestation(this.apiState, {
      attestationId: body.attestation_id,
      clientId: 'nexora-service',
      nowMs: this.now(),
    });
    if (!att.ok) {
      return { status: 403, body: { error: 'attestation-refused', reason: att.reason } };
    }
    // (5) Licence gate (F-15 / §3.4): no rendering of any kind without
    // a licence determination for the LTX checkpoint — checked before
    // any resource is committed. The checkpoint is the SHA-256 pinned
    // in the run-10 template manifest, read server-side; a payload
    // checkpoint value is ignored.
    if (!licenceSatisfiedFor(this.apiState, CHECKPOINT_SHA256)) {
      return { status: 403, body: { error: 'licence-refused', reason: 'licence-undetermined' } };
    }
    // (6) Activation (F-6 / §4 step 6 v13): the NEXORA path checks the
    // flag and the config validity — NEVER commissioning (a live permit
    // does not authorise a NEXORA job, T-V17b). Flag false → 503
    // activation-false; config invalid → activation-config-invalid;
    // value changed since startup → activation-config-changed; no
    // personal executor → no-capacity.
    if (this.mode === 'production') {
      if (typeof nexora.isActivationValid === 'function' && !nexora.isActivationValid()) {
        const reason = typeof nexora.activationInvalidReason === 'function'
          ? nexora.activationInvalidReason()
          : null;
        return { status: 503, body: { error: reason ?? 'activation-config-invalid' } };
      }
      const flags = typeof nexora.activationFlags === 'function' ? nexora.activationFlags() : null;
      if (flags && flags.personalProductionActivated !== true) {
        return { status: 503, body: { error: 'activation-false' } };
      }
      if (!this._hasPersonalExecutor()) {
        return { status: 503, body: { error: 'no-capacity' } };
      }
    }
    // (7) Halt: the mirrored NEXORA halt, then the kill-switch. Either
    // refuses new submits; queued jobs are cancelled by the halt
    // setter, running kernels complete.
    if (isNexoraHalted(this.apiState)) {
      return { status: 503, body: { error: 'client-halted', reason: 'nexora-halted' } };
    }
    if (isEngaged(this.manager.store.state)) {
      return { status: 503, body: { error: 'client-halted', reason: 'kill-switch-engaged' } };
    }
    // (8) Origin-paused: a ledger orphan for this origin (a reservation
    // held past 24 h with a non-terminal job) pauses the origin until
    // the operator resolves it. Reported before queue-full when both
    // apply.
    if (this._originPaused('nexora')) {
      return { status: 503, body: { error: 'origin-paused', reason: 'origin-paused' } };
    }
    // (9) Per-origin slot cap (§6.2 v13): 1 in-flight job per origin.
    // The total bound (2 across both origins, Rev 4.8 §14) still holds
    // implicitly — 1 nexora + 1 worker = 2.
    if (nexora.ledger.personalQueueDepth('nexora') >= PER_ORIGIN_QUEUE_BOUND) {
      return { status: 503, body: { error: 'queue-full', reason: 'queue-full' } };
    }
    // (10) Storage: 200 MB must be reservable (the reservation itself
    // happens at step 12, together with the queue slot and the hours —
    // a failure here holds no quota reservation).
    let capacity;
    try {
      capacity = await this.manager.storageCapacity();
    } catch {
      return { status: 503, body: { error: 'storage-unavailable' } };
    }
    const usage = this.manager.storageUsage();
    const reserved = this._reservedHeadroomBytes();
    const totalBytes = capacity && Number.isFinite(capacity.totalBytes)
      ? capacity.totalBytes
      : null;
    if (totalBytes === null) {
      return { status: 503, body: { error: 'storage-unavailable' } };
    }
    const usableHeadroom = totalBytes - (usage.totalBytes || 0) - reserved;
    if (usableHeadroom < NEXORA_STORAGE_BYTES) {
      return { status: 503, body: { error: 'storage-unavailable' } };
    }
    // (11) Quota ledger: floor AND cap, both must hold — and the
    // reconciliation must be valid ('quota-unreconciled' otherwise).
    // The NOVA ledger is the sole authority; the NEXORA local counter
    // never authorises. The floor is checked before the cap (both
    // failing reports 'floor-reached').
    const admission = nexora.ledger.admitNexora({ jobHours: jobBudgetHours });
    if (!admission.ok) {
      return { status: 503, body: { error: 'quota-refused', reason: admission.reason } };
    }
    // (12) Staging verification (§5.7, push model): the payload's
    // keyframe hashes must have staged files for THIS jobId — the
    // client pushed them to POST /internal/stage before submitting.
    // Missing or wrong-job → 400 staging-failed /
    // keyframe-hash-mismatch. On acceptance the files leave the
    // quarantine (releaseForJob) so the sweep never deletes a live
    // job's keyframes; the reference is released when the job reaches
    // a terminal state (finaliser) or is cancelled (halt / cancel-held).
    // Without a staging store the submit fails closed.
    if (!this.stagingStore) {
      return { status: 503, body: { error: 'staging-unavailable' } };
    }
    const keyframeHashes = [body.keyframe_hashes.first, body.keyframe_hashes.last];
    const staged = this.stagingStore.verifyStagedForJob(body.jobId, keyframeHashes);
    if (!staged.ok) {
      return { status: staged.status, body: { error: staged.error, reason: staged.reason } };
    }
    this.stagingStore.releaseForJob(body.jobId, keyframeHashes);
    // (13) Reserve the 200 MB + the job's budgeted hours, then create
    // the manager job with the jobId as idempotency key — all inside
    // the serialised submit section. The per-origin slot was already
    // checked at step 9 (inside this same serialised section, so no
    // second job can take it between the check and the reserve).
    this._reserveHeadroom(body.jobId, NEXORA_STORAGE_BYTES);
    nexora.ledger.reserve({ jobId: body.jobId, origin: 'nexora', hours: jobBudgetHours });
    // Minimum VRAM from the measured Run 10 profile with the design's
    // owner-confirmed 1.50 GiB margin (14.14 GiB → 15.19 GB) — NOT the
    // repo's default 1.92 GiB margin (the Worker path's figure).
    const measuredMinVramGb = requiredVramGb({
      model: 'ltx-video-2b',
      resolution: '1024x576',
      frames: 121,
      steps: 8,
      decoderMode: 'single-pass',
      attentionBackend: 'default',
    }, { safetyMarginGib: 1.5 });
    const minVramGb = measuredMinVramGb ?? 12;
    let job;
    try {
      ({ job } = this.manager.submit({
        idempotencyKey: body.jobId,
        type: 'video',
        modelId: 'ltx-video-2b',
        prompt: body.prompt,
        params: {
          timeoutMs: this.jobTimeoutMs,
          minVramGb,
          estimatedSeconds: 300,
          executionId: body.jobId,
          jobId: body.jobId,
          // The audience + origin travel with the job so the
          // dispatcher, executor, and transport each re-check them; a
          // NEXORA job also carries its registry attestation id and
          // the session id recorded from the registry at submit (never
          // from the request), its purpose declarations, and its
          // canonical request hash. It carries NO nonCommercialPurpose,
          // NO ownerTokenId, and NO round-2 personalAttestation — the
          // two attestation systems are separate.
          audience: 'personal',
          origin: 'nexora',
          purpose: 'owner_personal_work',
          nexoraAttestationId: body.attestation_id,
          nexoraSessionId: att.record.session_id,
          targetChannelId: body.target_channel_id,
          targetChannelStatus: body.target_channel_status,
          keyframeHashes: { ...body.keyframe_hashes },
          canonicalRequestHash: hash,
        },
      }));
    } catch (err) {
      this._releaseHeadroom(body.jobId);
      nexora.ledger.release({ jobId: body.jobId });
      // The staged references were taken at step 12 — a manager.submit
      // throw means no job exists to own them, so release them here or
      // the files stay pinned past the sweep forever.
      this.stagingStore?.unreferenceJob(body.jobId);
      this._journalSetState(body.jobId, 'failed', { error: 'no-capacity' });
      return { status: 503, body: { error: 'no-capacity' } };
    }
    // (10) Audit: the journal records jobId, audience, origin,
    // attestation_id, purpose declarations, canonical request hash,
    // keyframe hashes, reservation, provider, outcome. Prompt text is
    // NEVER recorded. The manager job id is recorded HERE (not only
    // on placement): a queued-but-unplaced job's entry must already
    // carry it, or held-job operations (re-evaluate, cancel-held)
    // cannot find the manager job.
    this._journalMutate(body.jobId, (e) => {
      e.jobId = body.jobId;
      e.managerJobId = job.id;
      e.state = 'submitted';
      e.timestamps.submitted = this.now();
      e.audience = 'personal';
      e.origin = 'nexora';
      e.attestation_id = body.attestation_id;
      e.purpose = body.purpose;
      e.requester = body.requester;
      e.third_party_work = body.third_party_work;
      e.target_channel_id = body.target_channel_id;
      e.target_channel_status = body.target_channel_status;
      e.canonical_request_hash = hash;
      e.keyframe_hashes = { ...body.keyframe_hashes };
      e.reservation = { hours: jobBudgetHours, storageBytes: NEXORA_STORAGE_BYTES };
      e.provider = 'kaggle-t4';
    });
    // Dispatch until this job is placed, or a failure stops us. The
    // dispatcher takes the head-of-line job, so jobs queued ahead of
    // ours are dispatched first (one per call); the loop continues
    // until ours is placed. The pre-handoff re-check runs inside
    // _dispatchPersonalNext: a job held by a pre-handoff gate (licence
    // / activation) is marked held and the loop stops.
    let placed = null;
    let heldReason = null;
    for (let guard = 0; guard < 10; guard++) {
      const r = this._dispatchPersonalNext();
      if (r.dispatched) {
        if (r.jobId === job.id) {
          placed = r;
          break;
        }
        continue;
      }
      if (r.reason === 'queue-empty') break;
      if (typeof r.reason === 'string' && r.reason.startsWith('held-')) {
        heldReason = r.reason;
        break;
      }
      // Executor busy / no provider / kill-switch / any other
      // non-placement: stop the loop — the job stays queued (below).
      break;
    }
    if (heldReason) {
      // Held at dispatch (§6.2 v13): the journal already carries
      // 'held-<reason>' (written by _markJobHeld); the reservation is
      // RETAINED — it is released only on a confirmed terminal state
      // or operator resolve-orphan / cancel-held. 202, not 503: the
      // job exists and waits for its cause to clear.
      return {
        status: 202,
        body: {
          jobId: body.jobId,
          managerJobId: job.id,
          dispatchState: heldReason,
          canonical_request_hash: hash,
        },
      };
    }
    if (!placed) {
      // Not placed and not held (executor busy / no provider): the job
      // stays QUEUED with its reservation held (§6.2 v13 — the v4
      // dispatch-failure compensation violated this: a reservation is
      // released ONLY on a confirmed terminal state or operator
      // resolve-orphan. A later dispatch loop — another submit's, or
      // reEvaluateHeldJobs — places it, and the finaliser attaches on
      // that placement). 202, not 503: the job exists and waits.
      return {
        status: 202,
        body: {
          jobId: body.jobId,
          managerJobId: job.id,
          dispatchState: 'queued',
          canonical_request_hash: hash,
        },
      };
    }
    this._journalMutate(body.jobId, (e) => {
      e.managerJobId = job.id;
      e.executorId = placed.providerId;
      e.state = 'slot-claimed';
      e.timestamps['spending-reserved'] = this.now();
      e.timestamps['slot-claimed'] = this.now();
    });
    // The ledger finaliser was attached on placement inside
    // _dispatchPersonalNext (via _onPersonalPlaced) — exactly once
    // per manager job, even when another submit's loop placed it.
    return {
      status: 202,
      body: {
        jobId: body.jobId,
        managerJobId: job.id,
        dispatchState: 'slot-claimed',
        canonical_request_hash: hash,
      },
    };
  }

  // Staging fetch (§5.7): read the keyframe files from the NEXORA
  // loopback endpoint and verify the SHA-256 of each file against the
  // signed payload. Filenames are the NEXORA staging manifest names
  // (staging.py): slot "first" → file "first_frame", slot "last" →
  // file "last_frame". A mismatch fails the submit; no manager job is
  // created (T-V26). An unconfigured staging base URL (the NEXORA
  // staging server is unbuilt — P-14 follow-up) fails closed with
  // staging-unavailable.
  // The ledger finaliser for a NEXORA job: when the manager job reaches
  // a terminal state (the executor promise settles), release the 200 MB
  // headroom and settle the ledger reservation with the ACTUAL GPU
  // seconds when the provider reported them (else the budgeted hours).
  _attachNexoraFinalizer(jobId, managerJobId, nexora) {
    const done = this.manager.inflight.get(managerJobId);
    if (!done || typeof done.then !== 'function') return;
    done.then(
      (finalJob) => { void this._finalizeNexoraJob(jobId, finalJob, nexora); },
      () => { void this._finalizeNexoraJob(jobId, null, nexora); },
    );
  }

  _finalizeNexoraJob(jobId, finalJob, nexora) {
    this._releaseHeadroom(jobId);
    // Hours: the provider-reported seconds when the report carries
    // them, else the budgeted hours (the ledger's settle fallback).
    // (The executor normalizes a missing secondsUsed to 0, which the
    // ledger then treats as a reported 0 — a report that says nothing
    // about GPU time settles at consumed 0, per T-V39; the J fallback
    // applies when no figure reaches the ledger at all.)
    nexora.ledger.settle({
      jobId,
      secondsUsed: finalJob?.cost?.providerReportedSeconds ?? null,
    });
    // Terminal state: the staged files lose this job's reference, so
    // the sweep may delete them once they age out (design §5.7 — a
    // staged file is deleted only when no non-terminal job references
    // its hash).
    this.stagingStore?.unreferenceJob(jobId);
    const entry = this.journalEntry(jobId);
    if (!entry) return;
    // F-3 (v12 item 14): a terminal executor report files the journal
    // state for the two operator-filed terminal errors — a kernel
    // stopped by a human ('cancelled-by-human': the human files a
    // failed report via fileReport()), and a kernel that exited on an
    // nvidia-smi device mismatch ('device-mismatch': the operator
    // files it via fileReport(); the observed device travels in the
    // report). Neither is auto-retried; a deliberate retry uses a new
    // jobId. Any other terminal report keeps its state and only
    // records the outcome.
    const terminalError = finalJob?.error ?? null;
    if (terminalError === 'cancelled-by-human' || terminalError === 'device-mismatch') {
      this._journalMutate(jobId, (e) => {
        e.state = terminalError;
        e.outcome = finalJob?.status ?? 'terminal';
      });
    } else if (entry.state !== 'failed') {
      this._journalMutate(jobId, (e) => {
        e.outcome = finalJob?.status ?? 'terminal';
      });
    }
  }

  // The job state for GET /internal/job?jobId=&hash= and
  // GET /internal/jobs/<jobId> (§5.8 reconciliation) and for an
  // idempotent re-submit (200 existing state). Found → the job state +
  // canonical_request_hash + found: true; not found → null (the route
  // answers 404 { found: false }). The state is the manager job's
  // status when one exists, else the journal dispatch state.
  // `hash` (optional) is the caller's canonical request hash:
  // hash_match compares it with the stored canonical_request_hash
  // (null when no hash was passed — the path form never passes one).
  nexoraJobState(jobId, hash = null) {
    let entry = this.journalEntry(jobId);
    if (!entry) {
      // Worker jobs are journalled under execution ids, not jobIds —
      // scan for an entry whose jobId matches.
      for (const e of Object.values(this.apiState.state.dispatchJournal || {})) {
        if (e.jobId === jobId) {
          entry = e;
          break;
        }
      }
    }
    if (!entry) return null;
    const job = entry.managerJobId ? this.manager.getJob(entry.managerJobId) : null;
    const storedHash = entry.canonical_request_hash ?? null;
    return {
      found: true,
      jobId,
      state: job ? job.status : entry.state,
      dispatchState: entry.state,
      managerJobId: entry.managerJobId ?? null,
      canonical_request_hash: storedHash,
      hash_match: hash == null ? null : storedHash === hash,
      attestation_id: entry.attestation_id ?? null,
      origin: entry.origin ?? null,
      audience: entry.audience ?? null,
    };
  }

  // Cancel queued NEXORA jobs + release their reservations (T-V23,
  // mirrored halt; F-19 / §6.3 v13). Called by the operator halt
  // setter. Running kernels complete (no cancel exists); only queued
  // jobs are cancelled. The journal files 'cancelled-by-halt' (the
  // terminal state the NEXORA side records) — NOT 'failed' and NOT
  // 'nexora-halted'. Returns the NEXORA jobIds cancelled.
  cancelQueuedNexoraJobs() {
    const cancelled = [];
    if (!this.nexora?.ledger) return cancelled;
    for (const job of Object.values(this.manager.store.state.jobs || {})) {
      if (job?.params?.origin !== 'nexora') continue;
      if (job.status !== 'queued') continue;
      const nexoraJobId = job.params.jobId;
      this.manager.cancelJob(job.id, 'nexora-halt');
      this.nexora.ledger.release({ jobId: nexoraJobId });
      this._releaseHeadroom(nexoraJobId);
      // A halt-cancelled queued job never reaches the finaliser, so
      // its staged references are released here (its files are not
      // needed — the job will never dispatch).
      this.stagingStore?.unreferenceJob(nexoraJobId);
      this._journalSetState(nexoraJobId, 'cancelled-by-halt', { error: 'cancelled-by-halt' });
      this.apiState.logEvent('nexora-job-cancelled-by-halt', {
        jobId: nexoraJobId,
        managerJobId: job.id,
      });
      cancelled.push(nexoraJobId);
    }
    return cancelled;
  }

  async _submitExecutionsInner(body) {
    // FreeLLMAPI (A5 contract): the submit loads the stored D1 record by
    // body.jobId through the existing job-by-id lookup BEFORE the body is
    // validated, and the stored record — never the body prompt — is the
    // prompt that dispatches. A body that is not an object, or carries no
    // string jobId, has no job identity to look up and is refused 400
    // first; everything else is resolved from the stored record.
    // M2-P round 3 (reviewer re-review verdict §1): this lookup is also
    // the issuance check for the personal attestation's jobId binding.
    // A jobId with no D1 record — an id the Worker never issued — is
    // refused 404 below BEFORE any attestation is signed, so the API
    // can never sign an attestation for an unissued id. The Worker
    // enforces one job per id (D1 PRIMARY KEY + conditional creation +
    // the 409 on a different request under the same id), the API
    // re-checks the id's form (_validateSubmitBody) and its D1 record
    // here, and the attestation binds that same id — so a signed
    // attestation cannot be reused for a different job.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'invalid-submit', message: 'body must be an object' } };
    }
    if (typeof body.jobId !== 'string') {
      return { status: 400, body: { error: 'invalid-submit', message: 'invalid jobId' } };
    }
    // v13 §3 D-2.3: the jobId FORM is checked before the D1 lookup — a
    // jobId outside the Worker's namespace (e.g. `nexora:<uuid>` from a
    // Worker-signed request) is 400 invalid-job-id, never a 404 and
    // never a D1 read for an id that cannot have a record.
    if (!JOB_ID_RE.test(body.jobId)) {
      return { status: 400, body: { error: 'invalid-job-id', message: 'invalid jobId' } };
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
    if (invalid) {
      if (invalid === 'invalid jobId') {
        return { status: 400, body: { error: 'invalid-job-id', message: invalid } };
      }
      return { status: 400, body: { error: 'invalid-submit', message: invalid } };
    }

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
    // The commissioning permit for this submit (Kaggle design v4 §3.5):
    // set below when the authorisation check refuses with not-activated
    // and a live permit authorises this exact request; consumed only
    // after the manager jobs exist.
    let personalAttestation = null;
    let commissioningPermit = null;
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
      // with the API host's server-held signing secret. This jobId is the
      // D1-verified id loaded above, never a raw request value: the 404
      // above already refused an id with no D1 record. Without a
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
          // Commissioning (Kaggle design v4 §3.5): a NOVA-origin
          // personal submit under a live permit for this EXACT request
          // may proceed while the personal flag is off — but ONLY when
          // the refusal is not-activated. Any other refusal reason, any
          // other audience, and any NEXORA-origin request (this is the
          // Worker path; NEXORA submits go through submitNexora and
          // never consult commissioning) refuse here.
          if (audience === 'personal' && check?.reason === 'not-activated') {
            const comm = this._commissioningForRequest(body);
            if (comm.ok) {
              commissioningPermit = comm.permit;
            } else if (comm.reason === 'no-permit') {
              // F-6 / T-V40: the flag is off and NO permit authorises
              // this job — the refusal is the activation step, not
              // capacity. (A permit that EXISTS but fails — expired,
              // consumed, max-hours, licence — keeps 'no-capacity'
              // with its reason below.)
              return { status: 503, body: { error: 'activation-false' } };
            } else {
              // v13 §3.5/§6.5: surface the permit refusal reason
              // (e.g. max-hours-exceeded, licence-undetermined) — the
              // operator needs to know WHY the permit did not
              // authorise, and the refusal writes no consumed marker.
              return { status: 503, body: { error: 'no-capacity', reason: comm.reason } };
            }
          } else {
            return { status: 503, body: { error: 'no-capacity' } };
          }
        }
      }
      // Licence gate (v13 §3.4): EVERY personal job is refused
      // licence-undetermined unless a valid determination covers the
      // run-10 checkpoint. (Commissioning jobs already passed the
      // permit's licence check in _commissioningForRequest; this is
      // the same gate for ordinary personal jobs.) Production mode
      // only — the authorisation gate it extends is production-only
      // too.
      if (this.mode === 'production' && audience === 'personal'
        && !licenceSatisfiedFor(this.apiState, CHECKPOINT_SHA256)) {
        return { status: 503, body: { error: 'licence-refused', reason: 'licence-undetermined' } };
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
    // marker and is never trusted. A commissioning job also records its
    // permit id and the journal reason `m2p-commissioning`.
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
        if (commissioningPermit) {
          entry.commissioningPermitId = commissioningPermit.permit_id;
          entry.commissioningReason = 'm2p-commissioning';
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

    // The manager job id is recorded in the journal entry HERE (not
    // only on placement): a queued-but-unplaced job's entry must
    // already carry it, or held-job operations (re-evaluate,
    // cancel-held) cannot find the manager job.
    for (const { x, job } of submittedJobs) {
      this._journalMutate(x.executionId, (entry) => {
        entry.managerJobId = job.id;
      });
    }

    // Commissioning (v13 §3.5): the permit is consumed NOW that the
    // manager jobs exist (the point of no return — a failed submit
    // above never consumes it), and the job's budgeted hours are
    // reserved in the commissioning bucket: the permit draws from the
    // ORDINARY bucket only (v13 A-3); C_C counts in Q but not against
    // the NEXORA cap. The consumed marker is written in this same
    // serialised section as the manager-job creation above.
    if (commissioningPermit && this.nexora?.ledger) {
      consumeCommissioningPermit(this.apiState, commissioningPermit.permit_id, {
        jobId: body.jobId,
        nowMs: this.now(),
      });
      this.nexora.ledger.reserve({
        jobId: body.jobId,
        origin: 'commissioning',
        hours: this.nexora.jobBudgetHours ?? 0.5,
      });
    }

    // Dispatch until every submitted job is placed, or a failure stops us.
    // dispatchNext() places the head-of-line job; loop so each scene gets
    // its own slot claim in FIFO order. The loop runs through
    // _dispatchPersonalNext (v13 §6.2): the pre-handoff re-check may
    // HOLD a personal job instead of placing it — a held job is NOT a
    // failure (its journal state is already 'held-*'; it keeps its
    // reservation and waits).
    const placed = new Map(); // managerJobId -> { x, providerId }
    let dispatchFailure = null;
    let heldReason = null;
    for (let guard = 0; guard < submittedJobs.length + 2; guard++) {
      if (placed.size === submittedJobs.length) break;
      const r = this._dispatchPersonalNext();
      if (r.dispatched) {
        const found = submittedJobs.find(({ job }) => job.id === r.jobId);
        if (found) placed.set(r.jobId, { x: found.x, providerId: r.providerId });
        continue;
      }
      if (r.reason === 'queue-empty') break;
      if (typeof r.reason === 'string' && r.reason.startsWith('held-')) {
        heldReason = r.reason;
        break;
      }
      dispatchFailure = r;
      break;
    }

    if (placed.size !== submittedJobs.length) {
      const reason = heldReason
        ?? (dispatchFailure ? this._dispatchFailureError(dispatchFailure) : 'no-capacity');
      // Compensation (Rev 2 §10.3): release headroom, fail the unplaced
      // executions in D1, flag reconciliation. Placed executions keep
      // their slot claims (they are dispatched; the Worker is told only
      // about the failure if NOTHING was placed — see below). HELD
      // executions are skipped: they are not failures.
      for (const { x, job } of submittedJobs) {
        if (placed.has(job.id)) continue;
        const entry = this.journalEntry(x.executionId);
        if (entry?.state?.startsWith('held-')) continue;
        this._releaseHeadroom(x.executionId);
        this._journalSetState(x.executionId, 'failed', { error: reason });
        await this._failSceneInD1(body.jobId, x, reason);
      }
      if (placed.size === 0) {
        // Held, nothing placed: the job exists and waits — 202 with
        // the held dispatch state, not a 503.
        if (heldReason) {
          return { status: 202, body: { managerJobIds, dispatchState: heldReason } };
        }
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
    // Commissioning (v4 §3.5): a commissioning job's permit expires on
    // terminal state, and its ledger reservation settles with the actual
    // GPU seconds. The journal entry carries the permit id; ordinary
    // jobs have none and skip this entirely. (The permit is normally
    // already 'consumed' from submit — the expiry call is then a
    // no-op — but the settle must still run: the reservation is held
    // until this terminal state.)
    if (entry?.commissioningPermitId) {
      expireCommissioningPermit(this.apiState, entry.commissioningPermitId, this.now());
      if (this.nexora?.ledger) {
        this.nexora.ledger.settle({
          jobId: entry.jobId,
          secondsUsed: job.cost?.providerReportedSeconds ?? null,
        });
      }
    }
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
