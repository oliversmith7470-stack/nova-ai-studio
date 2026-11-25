// NOVA AI Studio — Phase 3 API process: controlled-test (fake) executor.
//
// This is the ONLY executor the API process registers in controlled-test
// mode (Rev 3 §C-1.4 gate 3). It is a FAKE executor for local testing:
// no Kaggle dispatch, no paid GPU, no network. It implements the manager
// executor contract — start(job) -> Promise<report>, requestCancel(jobId)
// — plus the Phase 3 executor surface the API process needs:
//   getExecutionState(executionId) -> { state, evidence }   (Rev 3.2 §B-3.2.3.3)
//   fileReport(report)             (the manual completion channel, Rev 2 §7)
//   reportFailure(managerJobId, error)  (ack-timeout failure path)
//
// Behaviour:
//   - start(job) records the submission acknowledgement immediately
//     (the kernel-push-success equivalent: the package was received) and
//     returns a promise that stays pending until fileReport() or
//     reportFailure() resolves it. start() NEVER throws synchronously.
//   - The executor's live state is a scripted wire value per execution
//     (default: `KernelWorkerStatus.QUEUED`). Tests drive the wire value
//     to exercise every getExecutionState branch. The AUTHORITATIVE
//     mapping from wire value to the six-state vocabulary lives in
//     kaggle-status.js and is applied HERE, at the source — never in the
//     caller, never from the fileReport channel.
//   - requestCancel() returns false honestly: Kaggle has no CLI cancel
//     (Stage 2 record). The cancellation request is recorded; the run
//     finishes or times out; the manager's VDP-02 semantics apply
//     (outcome in cancelOutcome, cost kept).
//   - The kernel slug recorded at submission acknowledgement is
//     `controlled-test/<executionId>` — a stable execution-ID → slug
//     mapping for the status query, as §B-3.2.3.3 requires the journal to
//     record (slug, push timestamp, execution ID → slug mapping).
//
// The real Kaggle status query (kaggle kernels status <slug>) is NOT
// wired here: no live Kaggle call is authorised in this workstream, and
// the design records the query as unverified (§B-3.2.18). When a real
// executor is wired, it must call queryExecutionState() (kaggle-status.js)
// with its own status function — the mapping stays identical.

import { normalizeExecutorState, kaggleCancelReason, mapStatusQuery } from './kaggle-status.js';

export class FakeControlledExecutor {
  constructor({ defaultWireState = 'KernelWorkerStatus.QUEUED' } = {}) {
    this.id = 'controlled-test-ltx';
    this.defaultWireState = defaultWireState;
    // executionId -> { wireState, kernelSlug, submittedAt, managerJobId }
    this.executions = new Map();
    // managerJobId -> { resolve, executionId }
    this.pending = new Map();
    // managerJobId -> submission record (like BaseExecutor.submissions)
    this.submissions = new Map();
    this.cancelRequests = new Set();
    this.startedJobs = [];
    // Test hooks (never set in production — there is no production
    // executor here at all):
    //   dropSubmissions = true: start() returns a pending promise but
    //     records NO execution — the push was lost; the executor never
    //     saw it (getExecutionState -> never-received).
    this.dropSubmissions = false;
    // managerJobId -> last filed report (completion pipeline reads the
    // outputPath from here; the manager's finalizer resolves to the job
    // record, not the report).
    this.lastReports = new Map();
  }

  // Manager contract: start(job) -> Promise<report>. Never throws.
  async start(job) {
    try {
      return await this._start(job);
    } catch (err) {
      return {
        jobId: job.id,
        providerId: this.id,
        status: 'failed',
        secondsUsed: 0,
        costUsd: 0,
        completedAt: Date.now(),
        resultRef: null,
        error: `executor-error: ${err && err.message ? err.message : err}`,
      };
    }
  }

  _start(job) {
    const executionId = job.params && job.params.executionId
      ? job.params.executionId
      : job.idempotencyKey;
    if (this.dropSubmissions) {
      // Lost push: no execution record exists, but the start() promise
      // still pends — the manager believes the submission succeeded.
      // getExecutionState therefore answers never-received.
      const deferred = new Promise((resolve) => {
        this.pending.set(job.id, { resolve, executionId });
      });
      return deferred;
    }
    const kernelSlug = `controlled-test/${executionId}`;
    const record = {
      executionId,
      managerJobId: job.id,
      kernelSlug,
      wireState: this.defaultWireState,
      submittedAt: Date.now(),
      startedAt: Date.now(),
    };
    this.executions.set(executionId, record);
    this.submissions.set(job.id, record);
    this.startedJobs.push(job.id);
    const deferred = new Promise((resolve) => {
      this.pending.set(job.id, { resolve, executionId });
    });
    return deferred;
  }

  // -- Phase 3 executor surface -------------------------------------------

  // Authoritative live state (Rev 3.2 §B-3.2.3.3). The state comes from
  // the status query (here: the scripted wire value), NEVER from the
  // fileReport channel.
  getExecutionState(executionId) {
    const rec = this.executions.get(executionId);
    if (!rec) return { state: 'never-received', evidence: { raw: null } };
    return mapStatusQuery({ raw: rec.wireState });
  }

  // Raw wire value, for tests and for the Worker defence-in-depth copy.
  getWireState(executionId) {
    const rec = this.executions.get(executionId);
    return rec ? rec.wireState : null;
  }

  // Drive the scripted wire state for one execution (tests only).
  // Accepts a bare member (QUEUED) or the prefixed form.
  setWireState(executionId, rawWireValue) {
    const rec = this.executions.get(executionId);
    if (!rec) throw new Error(`unknown execution ${executionId}`);
    rec.wireState = rawWireValue;
    return rec;
  }

  setDefaultWireState(rawWireValue) {
    this.defaultWireState = rawWireValue;
  }

  // Inject an execution record as if the push arrived late (tests only):
  // the executor now knows the execution, after the API process already
  // made a terminal decision about it. Used for the late-acknowledgement
  // test (Rev 3.2 §B-3.2.8.2).
  injectExecution(executionId, wireState = this.defaultWireState) {
    const record = {
      executionId,
      managerJobId: null,
      kernelSlug: `controlled-test/${executionId}`,
      wireState,
      submittedAt: Date.now(),
      startedAt: Date.now(),
    };
    this.executions.set(executionId, record);
    return record;
  }

  // The manual completion channel (Rev 2 §7): file a provider completion
  // report. Resolves the pending start() promise, which finalises the
  // manager job. Returns { filed: true } or { filed: false, reason }.
  // A report for a job with no pending promise is NOT filed (honest).
  // `outputPath` (test-only) carries the validated-output file the API
  // process stores; a real executor's report carries its own output ref.
  fileReport(report) {
    const pending = this.pending.get(report && report.jobId);
    if (!pending) return { filed: false, reason: 'no-pending-job' };
    const normalized = {
      jobId: report.jobId,
      providerId: this.id,
      status: report.status === 'succeeded' ? 'succeeded' : 'failed',
      secondsUsed: typeof report.secondsUsed === 'number' ? report.secondsUsed : 0,
      costUsd: 0,
      completedAt: report.completedAt ?? Date.now(),
      resultRef: report.status === 'succeeded' ? (report.resultRef ?? null) : null,
      error: report.status === 'succeeded' ? null : (report.error ?? 'executor reported failure'),
      outputPath: report.outputPath ?? null,
      measurements: report.measurements ?? null,
    };
    this.lastReports.set(report.jobId, normalized);
    this.pending.delete(report.jobId);
    pending.resolve(normalized);
    return { filed: true, jobId: report.jobId, status: normalized.status };
  }

  lastReport(managerJobId) {
    return this.lastReports.get(managerJobId) ?? null;
  }

  // Resolve a pending job as failed without a completion report (used by
  // the ack-timeout never-received / executor-failed path, Rev 3.2
  // §B-3.2.3.2). Returns false when nothing was pending.
  reportFailure(managerJobId, error) {
    const pending = this.pending.get(managerJobId);
    if (!pending) return false;
    this.pending.delete(managerJobId);
    const report = {
      jobId: managerJobId,
      providerId: this.id,
      status: 'failed',
      secondsUsed: 0,
      costUsd: 0,
      completedAt: Date.now(),
      resultRef: null,
      error,
    };
    this.lastReports.set(managerJobId, report);
    pending.resolve(report);
    return true;
  }

  pendingJobs() {
    return [...this.pending.keys()];
  }

  // Honest cancel: no CLI cancel exists for the controlled-test channel.
  requestCancel(jobId) {
    this.cancelRequests.add(jobId);
    return false;
  }

  // Helpers the API process uses for the journal (evidence, not decisions).
  submissionRecord(executionId) {
    return this.executions.get(executionId) ?? null;
  }

  cancelReasonFor(executionId) {
    const rec = this.executions.get(executionId);
    return rec ? kaggleCancelReason(rec.wireState) : null;
  }

  normalizedStateFor(executionId) {
    const rec = this.executions.get(executionId);
    return rec ? normalizeExecutorState(rec.wireState) : 'unknown';
  }
}
