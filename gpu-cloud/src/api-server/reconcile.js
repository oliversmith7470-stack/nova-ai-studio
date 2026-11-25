// NOVA AI Studio — Phase 3 API process: reconciliation.
//
// Rev 3.2 §B-3.2.7 (periodic reconciliation timer) + Rev 2 §10.4
// (startup reconciliation), Rev 3.4 §C-3.4.2 (incomplete scene sets),
// Rev 3.5 §C-3.5.1 (per-index attempt-1 completeness).
//
// The API process runs a DEDICATED reconciliation timer every 15
// minutes, INDEPENDENT of the sweep timer (a sweep failure does not stop
// reconciliation) and independent of process startup. Each run examines,
// through /internal/d1-read `list-pending-jobs` and the dispatch journal:
//   1. Jobs in reconciliation-needed (executor unreachable at ack time).
//   2. Jobs in slot-claimed whose 60-second acknowledgement window has
//      expired without acceptance.
//   3. Jobs with dispatchState "intent-recorded" younger than the job
//      timeout — recovered by re-submit with the identical idempotency
//      keys (recovery path 2; path 1 is the client's retry).
//   4. Scene-set completeness, PER-INDEX at attempt 1 (Rev 3.5): a job
//      is complete iff, for every scene index in the validated plan,
//      exactly one row exists with that job_id, that scene_index and
//      attempt = 1. Retry rows (attempt ≥ 2) are NEVER substitutes. A
//      total row count is never a completeness check.
//
// BOUNDARY with the Worker's scheduled() handler (see the impl-notes
// doc §3): the Worker does the D1-side items — retention measurement +
// alert, completeness flagging INTO D1, and the 24-hour escalation
// flagging into D1. The API timer does the EXECUTOR-side items —
// getExecutionState queries, reservation release, dispatch recovery,
// storage deletion (via the sweep, not here). The API timer NEVER marks
// D1 scenes expired and NEVER deletes D1 rows. It reads the Worker's
// incompleteSceneSet flag (via list-pending-jobs job data) and suspends
// dispatch recovery for flagged jobs until the operator repair verifies
// the set complete.
//
// Escalation: a job in reconciliation-needed for 24 hours is escalated —
// an operator-log entry + a flag in the run summary. Escalation changes
// NOTHING about the job's state or its reservations; it is visibility,
// not resolution. Reservations are NEVER released because reconciliation
// has taken too long: elapsed time alone never releases a reservation
// and never fails a job. A reservation is released only on a recorded
// executor answer (no such job) or on an explicit manual fail decision.

import { JOB_TIMEOUT_MS, RECONCILIATION_ESCALATION_MS } from './constants.js';

// Completeness (Rev 3.5 §C-3.5.1.2): per-index attempt-1 presence.
// planIndexes: the plan's index set (from the validated request as
// stored in the job record). sceneRows: rows with { scene_index, attempt }.
// Returns the missing indexes (empty = complete). A retry row never
// substitutes for a missing attempt-1 row.
export function findMissingAttempt1Indexes(planIndexes, sceneRows) {
  const present = new Set();
  for (const r of sceneRows || []) {
    if (r.attempt === 1) present.add(r.scene_index);
  }
  return (planIndexes || []).filter((i) => !present.has(i));
}

export function planIndexesFromJobData(jobData) {
  if (!jobData) return [];
  if (jobData.mode === 'plan' && Array.isArray(jobData.scenes)) {
    return jobData.scenes.map((s) => s.index);
  }
  return [0];
}

export class ReconciliationRunner {
  constructor({
    manager,
    d1Client,
    apiState,
    dispatch,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    escalationMs = RECONCILIATION_ESCALATION_MS,
    now = () => Date.now(),
  } = {}) {
    if (!manager) throw new Error('ReconciliationRunner requires a GpuManager');
    if (!d1Client) throw new Error('ReconciliationRunner requires a d1Client');
    if (!apiState) throw new Error('ReconciliationRunner requires an ApiStateStore');
    if (!dispatch) throw new Error('ReconciliationRunner requires a DispatchManager');
    this.manager = manager;
    this.d1Client = d1Client;
    this.apiState = apiState;
    this.dispatch = dispatch;
    this.jobTimeoutMs = jobTimeoutMs;
    this.escalationMs = escalationMs;
    this.now = now;
  }

  async runReconciliation({ source = 'timer' } = {}) {
    const nowMs = this.now();
    const summary = {
      at: nowMs,
      source,
      examined: 0,
      resolved: 0,
      stillUncertain: 0,
      recovered: [],
      failed: [],
      incomplete: [],
      escalated: [],
      timedOut: [],
      errors: [],
    };

    // Manager-side timeouts first: jobs past the 30-minute video default
    // are timed out by the manager (reservation released, flagged for
    // reconciliation); mirror the outcome to D1.
    try {
      const timedOut = this.manager.checkTimeouts();
      for (const managerJobId of timedOut) {
        const entry = Object.values(this.apiState.state.dispatchJournal || {})
          .find((e) => e.managerJobId === managerJobId);
        if (!entry) continue;
        summary.timedOut.push(entry.executionId);
        if (entry.state !== 'failed') {
          this.dispatch._journalSetState(entry.executionId, 'failed', { error: 'timed-out' });
        }
        this.dispatch._releaseHeadroom(entry.executionId);
        await this.dispatch._applyD1([{
          type: 'scene-update', jobId: entry.jobId, sceneIndex: entry.sceneIndex,
          attempt: entry.attempt, status: 'timed-out', error: 'timed-out',
          outputRef: null, expiresAt: null,
        }]);
      }
    } catch (err) {
      summary.errors.push(`checkTimeouts: ${err && err.message ? err.message : err}`);
    }

    // Replay pending D1 mutations (same requestId — Worker replays by
    // requestId; mutations are idempotent by construction).
    try {
      await this.dispatch.replayPendingMutations();
    } catch (err) {
      summary.errors.push(`replay pending mutations: ${err && err.message ? err.message : err}`);
    }

    let pendingJobs;
    try {
      pendingJobs = await this.d1Client.listPendingJobs();
    } catch (err) {
      summary.errors.push(`list-pending-jobs: ${err && err.message ? err.message : err}`);
      this._persistSummary(summary);
      return summary;
    }

    for (const row of pendingJobs) {
      let jobData;
      try {
        jobData = JSON.parse(row.data);
      } catch {
        continue;
      }
      summary.examined += 1;
      const jobId = row.id;

      // (4) Completeness, per-index attempt 1 — before any recovery.
      let scenes = [];
      try {
        scenes = await this.d1Client.listScenes(jobId);
      } catch (err) {
        summary.errors.push(`list-scenes ${jobId}: ${err && err.message ? err.message : err}`);
        continue;
      }
      const expected = planIndexesFromJobData(jobData);
      const missing = findMissingAttempt1Indexes(expected, scenes);
      const workerFlagged = jobData.incompleteSceneSet !== undefined;
      if (missing.length > 0 || workerFlagged) {
        const missingIndexes = missing.length > 0
          ? missing
          : (Array.isArray(jobData.incompleteSceneSet) ? jobData.incompleteSceneSet : []);
        summary.incomplete.push({ jobId, missingIndexes });
        this.apiState.mutate((s) => {
          s.incompleteSceneSets[jobId] = { missingIndexes, flaggedAt: nowMs };
        });
        this.apiState.logOperator('incomplete-scene-set', { jobId, missingIndexes });
        // Dispatch recovery is SUSPENDED for this job until the repair
        // verifies the set complete (Rev 3.4 §C-3.4.2.2).
        continue;
      } else if (this.apiState.state.incompleteSceneSets[jobId]) {
        this.apiState.mutate((s) => { delete s.incompleteSceneSets[jobId]; });
      }

      // (3) Intent-recorded jobs: recover by re-submit (path 2) while
      // younger than the job timeout; fail as dispatch-interrupted when
      // older (the retained Rev 2 §10.4 rule 3, now limited to aged jobs).
      if (jobData.dispatchState === 'intent-recorded') {
        const createdAtMs = Number(jobData.createdAtMs) || 0;
        if (createdAtMs > 0 && nowMs - createdAtMs > this.jobTimeoutMs) {
          for (const s of scenes.filter((x) => x.attempt === 1)) {
            await this.dispatch._applyD1([{
              type: 'scene-update', jobId, sceneIndex: s.scene_index, attempt: 1,
              status: 'failed', error: 'dispatch-interrupted', outputRef: null, expiresAt: null,
            }]);
          }
          summary.failed.push({ jobId, reason: 'dispatch-interrupted' });
          this.apiState.logOperator('intent-recorded-expired', { jobId });
        } else {
          const recovered = await this._recoverIntentJob(jobData, scenes);
          if (recovered) summary.recovered.push(jobId);
          else summary.stillUncertain += 1;
        }
        continue;
      }

      // (1)+(2) Executor-state reconciliation for this job's executions.
      for (const s of scenes) {
        const entry = this.dispatch.journalEntry(s.execution_id);
        if (!entry) continue;
        if (entry.state === 'failed' || entry.state === 'executor-accepted' || entry.state === 'dispatched') {
          continue;
        }
        const action = this.dispatch.reconcileExecution(s.execution_id, source);
        if (action === 'accepted' || action === 'accepted-completed') {
          summary.resolved += 1;
          this._clearReconciliation(s.execution_id);
        } else if (action === 'failed-never-received' || action === 'failed-executor') {
          summary.failed.push({ jobId, executionId: s.execution_id });
          this._clearReconciliation(s.execution_id);
        } else if (action === 'reconciliation-needed' || action === 'waiting') {
          summary.stillUncertain += 1;
        }
        this._maybeEscalate(entry, summary);
      }
    }

    // Escalation sweep over reconciliation state, including jobs whose
    // D1 row is no longer pending (their state still must not change).
    for (const [executionId, rec] of Object.entries(this.apiState.state.reconciliation || {})) {
      const entry = this.dispatch.journalEntry(executionId);
      if (!entry) continue;
      this._maybeEscalate(entry, summary);
    }

    this._persistSummary(summary);
    return summary;
  }

  _clearReconciliation(executionId) {
    this.apiState.mutate((s) => { delete s.reconciliation[executionId]; });
  }

  _maybeEscalate(entry, summary) {
    // Escalation applies only while the execution is still in
    // reconciliation-needed. A resolved entry's record is cleared by
    // the caller; this guard covers any path that left one behind.
    if (entry.state !== 'reconciliation-needed') return;
    const rec = this.apiState.state.reconciliation[entry.executionId];
    if (!rec || rec.escalated) return;
    const firstAt = rec.firstAt ?? rec.lastAt ?? this.now();
    if (this.now() - firstAt < this.escalationMs) return;
    this.apiState.mutate((s) => {
      const r = s.reconciliation[entry.executionId];
      if (r) r.escalated = true;
    });
    summary.escalated.push(entry.executionId);
    this.apiState.logOperator('reconciliation-escalated', {
      executionId: entry.executionId,
      note: 'visibility only — state and reservations unchanged',
    });
  }

  _persistSummary(summary) {
    this.apiState.mutate((s) => {
      s.lastReconciliationSummary = summary;
    });
  }

  // Recovery path 2: re-submit an intent-recorded job with the identical
  // idempotency keys, then request mark-submitted. The manager's
  // idempotency on the key guarantees at most one manager job per
  // execution ID, whether recovery runs via path 1, path 2, or both.
  async _recoverIntentJob(jobData, scenes) {
    const attempt1 = scenes.filter((s) => s.attempt === 1);
    if (attempt1.length === 0) return false;
    const sceneExecutions = attempt1.map((s) => ({
      sceneIndex: s.scene_index,
      attempt: 1,
      executionId: s.execution_id,
      idempotencyKey: s.execution_id,
    }));
    const body = {
      jobId: jobData.id,
      mode: jobData.mode,
      model: 'ltx-video-2b',
      frames: 121,
      resolution: '1024x576',
      fps: 24,
      deploymentMode: this.dispatch.mode,
      sceneExecutions,
    };
    if (jobData.mode === 'single') body.prompt = jobData.prompt;
    else body.scenes = jobData.scenes;
    const res = await this.dispatch.submitExecutions(body);
    if (res.status !== 202) return false;
    const executions = sceneExecutions.map((x, i) => ({
      sceneIndex: x.sceneIndex,
      attempt: x.attempt,
      providerJobId: res.body.managerJobIds[i],
    })).filter((x) => x.providerJobId);
    if (executions.length === 0) return false;
    const applied = await this.dispatch._applyD1([{
      type: 'mark-submitted', jobId: jobData.id, executions,
    }]);
    return applied.ok;
  }

  // -- safe manual resolution (Rev 3.2 §B-3.2.7.3) ------------------------
  //
  // Host-local operator command only (CLI, never an HTTP endpoint).
  // confirm-accepted is permitted ONLY with executor evidence of
  // accepted, running, or completed. fail is permitted with evidence of
  // never-received, or with the operator's explicit recorded decision
  // when the executor remains unreachable after escalation. A manual
  // resolution is recorded as a single operator-log entry — never as an
  // executor event.

  async manualResolve({ executionId, decision, evidence = {}, operator = 'operator' }) {
    const entry = this.dispatch.journalEntry(executionId);
    if (!entry) throw new Error(`unknown execution ${executionId}`);
    if (decision === 'confirm-accepted') {
      const state = evidence.executorState;
      if (!['accepted', 'running', 'completed'].includes(state)) {
        throw new Error('confirm-accepted requires executor evidence of accepted, running, or completed');
      }
      this.dispatch._journalSetState(executionId, 'executor-accepted', {
        executorState: state, evidence, manual: true,
      });
      this.dispatch._journalSetState(executionId, 'dispatched');
      this.apiState.mutate((s) => { delete s.reconciliation[executionId]; });
      this.apiState.logOperator('manual-resolution', {
        executionId, decision, evidence, operator,
      });
      return { executionId, decision, state: 'dispatched' };
    }
    if (decision === 'fail') {
      const state = evidence.executorState;
      const unreachableAfterEscalation = evidence.unreachable === true
        && evidence.escalated === true;
      if (state !== 'never-received' && !unreachableAfterEscalation) {
        throw new Error('fail requires evidence of never-received, or unreachable-after-escalation with an explicit operator decision');
      }
      const reason = state === 'never-received' ? 'executor-ack-timeout' : 'manual-fail';
      await this.dispatch._failExecution(entry, reason, 'manual-resolution');
      this.apiState.mutate((s) => { delete s.reconciliation[executionId]; });
      this.apiState.logOperator('manual-resolution', {
        executionId, decision, evidence, operator, reason,
      });
      return { executionId, decision, state: 'failed', reason };
    }
    throw new Error(`unknown decision ${decision}`);
  }

  // -- operator scene-set repair (Rev 3.4 §C-3.4.2.2) --------------------
  //
  // Host-local operator command only. Step 1: fresh read, derive missing
  // indexes from the stored plan (per-index, not count-based). Step 2:
  // one guarded repair-scene-row per missing index, ascending, each its
  // own batch. A ceiling refusal stops the procedure at that row.
  // Step 3: verification — every expected index present at attempt 1.
  // The repair never fails the job and never deletes anything.

  async repairSceneSet(jobId, { operator = 'operator' } = {}) {
    const job = await this.d1Client.getJob(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    const jobData = JSON.parse(job.data);
    const expected = planIndexesFromJobData(jobData);
    let scenes = await this.d1Client.listScenes(jobId);
    let missing = findMissingAttempt1Indexes(expected, scenes);
    if (missing.length === 0) return { jobId, status: 'already-complete' };

    const repaired = [];
    let refused = null;
    for (const idx of missing) {
      const res = await this.dispatch._applyD1([{
        type: 'repair-scene-row', jobId, sceneIndex: idx,
      }]);
      if (!res.ok) {
        refused = { sceneIndex: idx, reason: res.auth ? 'd1-auth' : 'd1-pending' };
        break;
      }
      const changes = res.result && res.result.results
        ? res.result.results[0] && res.result.results[0].changes
        : null;
      if (changes === 0) {
        // Idempotent no-op (row appeared concurrently) or ceiling
        // refusal — disambiguate by re-reading.
        scenes = await this.d1Client.listScenes(jobId);
        const nowPresent = findMissingAttempt1Indexes(expected, scenes);
        if (nowPresent.includes(idx)) {
          refused = { sceneIndex: idx, reason: 'retention-ceiling' };
          break;
        }
      }
      repaired.push(idx);
    }

    scenes = await this.d1Client.listScenes(jobId);
    missing = findMissingAttempt1Indexes(expected, scenes);
    if (missing.length === 0) {
      this.apiState.mutate((s) => { delete s.incompleteSceneSets[jobId]; });
      this.apiState.logOperator('scene-set-repaired', {
        jobId, repairedIndexes: repaired, operator,
      });
      return { jobId, status: 'repaired', repairedIndexes: repaired };
    }
    this.apiState.mutate((s) => {
      s.incompleteSceneSets[jobId] = { missingIndexes: missing, flaggedAt: this.now() };
    });
    this.apiState.logOperator('scene-set-repair-refused', {
      jobId, missingIndexes: missing, refused, operator,
    });
    return { jobId, status: 'still-incomplete', missingIndexes: missing, refused };
  }
}
