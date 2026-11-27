// NOVA Personal GPU Cloud — Stage 2: executor base.
//
// Both Stage 2 executors implement the manager's executor contract
// (see gpu-manager.js dispatchNext + mock-provider.js):
//
//   start(job) -> Promise<provider report>
//     { jobId, providerId, status, secondsUsed, costUsd, completedAt,
//       resultRef, error }
//   requestCancel(jobId) -> Promise<boolean>  (a request, not a guarantee)
//
// THE PROMISE IS THE COMPLETION CHANNEL. dispatchNext marks the job
// dispatched -> running the moment start() is called, and finalizes it
// ONLY when the returned promise resolves (_finalizeFromProvider). A
// report with status 'running' would be treated as a FAILED completion
// (anything not 'succeeded' finalizes as failed) — so start() must NEVER
// resolve with a 'running' report. It resolves with the FINAL report
// (succeeded/failed) and stays pending until the provider completes.
//
// That shapes the two channels:
//   - AUTOMATED (Kaggle with a transport): start() pushes the kernel and
//     polls in the background; the promise resolves when the run ends.
//   - MANUAL (Colab always; Kaggle without a transport): start() writes
//     the job package and returns a promise that stays pending until the
//     operator files the provider's completion report via
//     fileReport(report) — the human downloads the report JSON from the
//     notebook output and files it. The manager process must stay
//     running while a manual job is out: a restart loses the pending
//     promise (documented in docs/connection-layer.md §6; a persistent
//     pending-report queue is a Stage 3 item).
//
// Contract discipline (from the Stage 2 research — see
// docs/connection-layer.md §5 for the latent Stage 1 bug this avoids):
// start() NEVER throws synchronously. Every refusal resolves as a FAILED
// report. A synchronous throw inside dispatchNext would escape as a
// JobTransitionError instead of a clean provider-start-failed result.
// The base class enforces this by wrapping the whole start() in a
// try/catch that resolves a failed report on any unexpected error.
//
// start() checks, in order:
//   1. VDP-06 data boundary (data-guard.js) — refuse, never warn.
//   2. Weekly hours budget (hours.js) — refuse when spent.
//   3. Staging manifest for job.modelId — refuse when unknown.
//   4. Local staging prep test, ONLY when a stagingRootDir was supplied
//      (the operator staged the files locally first) — refuse on failure.
//   5. Subclass submit() — writes the job package and returns the
//      channel + reference. Then the deferred promise is created; the
//      subclass may start background polling (Kaggle with a transport).
//
// requestCancel() is HONEST: the free tiers offer no programmatic cancel
// (Kaggle has no CLI cancel command; Colab has no API at all), so it
// returns false. The manager still records the cancellation request; if
// the run completes anyway, its outcome is preserved as cancelOutcome
// (VDP-02) when the report is filed. A human who stops a run files a
// failed report (error: cancelled-by-human) via fileReport.
//
// recordCompletion(report) runs when the final report resolves: it
// records the GPU seconds against the weekly budget and, if the budget
// is now spent, flips the provider's registry status to 'unavailable'
// so the dispatcher stops assigning work.

import fs from 'node:fs';
import path from 'node:path';

import { checkStage2Safe } from './data-guard.js';
import { syncBudgetStatus } from './hours.js';
import { getStagingManifest, runPreparationTest } from './staging.js';

export class BaseExecutor {
  constructor({
    providerId,
    hoursTracker = null,
    registry = null,
    route = 'official',
    stagingRootDir = null,
    packageDir,
    attestationVerifier = null,
    nexoraAttestationVerifier = null,
  } = {}) {
    if (!providerId) throw new Error('executor requires providerId');
    if (!packageDir) throw new Error('executor requires packageDir');
    this.providerId = providerId;
    // Rev 4.8 §5.3/§7: the audience this executor serves, or null when
    // the executor is audience-agnostic (controlled-test fakes). The
    // Kaggle executor sets 'personal'; a subclass that serves public
    // production sets 'public'. _start() refuses a missing, unknown, or
    // mismatched job audience when one is declared — only an explicitly
    // matching audience proceeds. An audience-agnostic executor (null)
    // performs no audience check; that is the retained controlled-test
    // path, and it must never be used for a production executor.
    this.audience = null;
    // M2-P round 2: the verifier for the server-generated personal
    // attestation, bound to the API host's signing secrets by the API
    // factory. Null means no attestation can verify — a personal job
    // then fails the VDP-06 boundary (fail closed). Controlled-test
    // executors legitimately carry null: they run stage2Test jobs only.
    this.attestationVerifier = typeof attestationVerifier === 'function' ? attestationVerifier : null;
    // Kaggle design v4 §5.3: the verifier for the NEXORA attestation
    // registry, bound to the API host's attestation registry by the API
    // factory. Null means no NEXORA job can verify — fail closed. The
    // two verifiers are separate: the round-2 verifier checks the
    // HMAC-signed Worker-side attestation; this one checks the registry
    // record (existence + client/session binding + not-revoked +
    // current version). A NEXORA job carries no round-2 attestation
    // and must never be given one.
    this.nexoraAttestationVerifier = typeof nexoraAttestationVerifier === 'function' ? nexoraAttestationVerifier : null;
    this.hoursTracker = hoursTracker;
    this.registry = registry;
    this.route = route;
    this.stagingRootDir = stagingRootDir;
    this.packageDir = packageDir;
    // jobId -> submission info (channel, ref, startedAt). Used by
    // requestCancel and by the audit trail.
    this.submissions = new Map();
    // jobId -> { resolve, submission } for jobs whose start() promise is
    // still pending (manual channel, or polling in progress).
    this.pending = new Map();
  }

  // -- The manager's executor contract ------------------------------------

  async start(job) {
    // NEVER throw synchronously — resolve a failed report instead.
    try {
      return await this._start(job);
    } catch (err) {
      return this._failed(job, `executor-error: ${err.message}`);
    }
  }

  async _start(job) {
    // 1. VDP-06 data boundary. The personal marker is the signed
    // server-generated attestation, verified here through the injected
    // verifier (null verifier = no personal job can verify — fail
    // closed); stage2Test jobs need no verifier. A NEXORA-origin
    // personal job verifies through the injected NEXORA registry
    // verifier instead (null = no NEXORA job can verify — fail closed).
    const safe = checkStage2Safe(job, {
      attestationVerifier: this.attestationVerifier,
      nexoraAttestationVerifier: this.nexoraAttestationVerifier,
    });
    if (!safe.ok) {
      return this._failed(job, `data-boundary: ${safe.reason}`);
    }

    // 1b. Audience enforcement (Rev 4.8 §5.3/§7, layer 2 — executor;
    // M2-P round 2, reviewer-prescribed strict check). An executor with
    // a declared audience accepts ONLY a job whose audience explicitly
    // matches it. A missing, unknown, or mismatched audience refuses
    // with `audience-mismatch` — no execution, no reservation. The old
    // allowance for a job with NO audience (treated as a
    // legacy/controlled-test caller) is removed: a production job
    // without an audience cannot reach this executor, and a direct
    // caller without one is refused here instead of trusted.
    const jobAudience = job?.params?.audience;

    if (this.audience && jobAudience !== this.audience) {
      return this._failed(
        job,
        `audience-mismatch: executor requires ${this.audience}, received ${jobAudience ?? 'missing'}`,
      );
    }

    // 2. Weekly hours budget (second line of defence — the dispatcher's
    // registry check is the first). Also reconciles the registry status
    // with the budget (week rollover restores a spent provider).
    if (this.hoursTracker) {
      const usage = this.registry
        ? syncBudgetStatus(this.registry, this.hoursTracker, this.providerId)
        : this.hoursTracker.checkWeek(this.providerId);
      if (usage.tracked && usage.spent) {
        return this._failed(
          job,
          `hours-budget-exhausted: ${usage.hoursUsed.toFixed(2)}h of ` +
          `${usage.hoursBudget}h used this week`,
        );
      }
    }

    // 3. Staging manifest for the job's model.
    let manifest;
    try {
      manifest = getStagingManifest(job.modelId, this.route);
    } catch {
      return this._failed(
        job,
        `no-staging-manifest: no Stage 2 staging manifest for model ` +
        `"${job.modelId}" route "${this.route}"`,
      );
    }

    // 4. Local staging prep test, when a local staging dir was supplied.
    if (this.stagingRootDir) {
      const prep = runPreparationTest(manifest, {
        rootDir: this.stagingRootDir,
        offline: true,
      });
      if (!prep.pass) {
        const missing = prep.missing.length
          ? ` missing: ${prep.missing.join(', ')}`
          : '';
        const truncated = prep.truncated.length
          ? ` truncated: ${prep.truncated.map((t) => t.path).join(', ')}`
          : '';
        return this._failed(
          job,
          `staging-prep-failed: the local staging directory did not pass ` +
          `the VDP-04 preparation test.${missing}${truncated}`,
        );
      }
    }

    // 5. Subclass submit: write the job package, return the channel.
    // A throw here (e.g. a failed transport push) is caught by start()
    // and becomes a failed report — the manager finalizes the job failed
    // and releases the reservation.
    const submission = await this.submit(job, manifest);
    const record = { ...submission, startedAt: Date.now() };
    this.submissions.set(job.id, record);

    // The promise stays pending until the provider completes: either the
    // subclass polls (Kaggle with a transport) or the operator files the
    // report (fileReport). The manager marks the job running and waits.
    const deferred = new Promise((resolve) => {
      this.pending.set(job.id, { resolve, submission: record });
    });
    this.afterSubmit(job, manifest, record);
    return deferred;
  }

  // Subclass hook: write the job package and return
  // { channel, packageDir, ...channel-specific refs }.
  // May be async. Must not throw for an expected refusal — resolve or
  // throw only on a genuine I/O failure (the base catches it).
  async submit(_job, _manifest) {
    throw new Error('submit() must be implemented by the executor subclass');
  }

  // Subclass hook called after the deferred promise is created (e.g. to
  // start background polling). Default: nothing — the manual channel
  // waits for fileReport.
  afterSubmit(_job, _manifest, _submission) {
    // no-op
  }

  // Honest cancel: no free tier offers a programmatic cancel, so this
  // returns false. The manager records the cancellation request anyway;
  // the human stops the run (web UI / browser) and files a failed
  // report, whose outcome is preserved as cancelOutcome (VDP-02).
  async requestCancel(_jobId) {
    return false;
  }

  // -- The manual channel ---------------------------------------------------
  //
  // File a provider completion report (the report JSON the notebook
  // writes, downloaded by the human). Resolves the job's pending start()
  // promise, which finalizes the job in the manager. Returns
  // { filed: true, jobId, status } or { filed: false, reason }.
  // A report for a job with no pending promise (unknown job, already
  // filed, or the manager restarted since dispatch) is NOT filed —
  // returning false is honest; silently dropping it would not be.
  fileReport(report) {
    const pending = this.pending.get(report?.jobId);
    if (!pending) {
      return { filed: false, reason: 'no-pending-job' };
    }
    const normalized = this._normalizeReport(report);
    this._resolve(report.jobId, normalized);
    return { filed: true, jobId: report.jobId, status: normalized.status };
  }

  // Jobs whose start() promise is still pending (out on a provider or
  // awaiting a human report). Observability for the operator.
  pendingJobs() {
    return [...this.pending.keys()];
  }

  // -- Completion accounting ------------------------------------------------
  //
  // Called when the final report resolves: records GPU seconds against
  // the weekly budget and flips the registry status if the budget is now
  // spent.
  recordCompletion(report) {
    if (!this.hoursTracker) return null;
    const seconds = typeof report.secondsUsed === 'number' ? report.secondsUsed : 0;
    const usage = this.hoursTracker.recordUsage(this.providerId, seconds);
    if (usage.tracked && usage.spent && this.registry) {
      this.registry.setStatus(this.providerId, 'unavailable');
    }
    return usage;
  }

  // -- Internals ---------------------------------------------------------------

  // Resolve a pending job with its final report (records hours first).
  _resolve(jobId, report) {
    const pending = this.pending.get(jobId);
    if (!pending) return false;
    this.pending.delete(jobId);
    this.recordCompletion(report);
    pending.resolve(report);
    return true;
  }

  // Normalize a provider report into the contract shape. A status other
  // than 'succeeded'/'failed' is coerced to 'failed' with an error
  // saying so — a malformed report must not finalize as a success.
  _normalizeReport(report) {
    const status = report.status === 'succeeded' ? 'succeeded' : 'failed';
    const error =
      report.status === 'succeeded'
        ? null
        : report.error ??
          (report.status === 'failed'
            ? 'provider reported failure'
            : `invalid report status "${report.status}" (expected succeeded/failed)`);
    return {
      jobId: report.jobId,
      providerId: this.providerId,
      status,
      secondsUsed: typeof report.secondsUsed === 'number' ? report.secondsUsed : 0,
      costUsd: typeof report.costUsd === 'number' ? report.costUsd : 0,
      completedAt: report.completedAt ?? Date.now(),
      resultRef: report.resultRef ?? null,
      error,
    };
  }

  _failed(job, error) {
    return {
      jobId: job.id,
      providerId: this.providerId,
      status: 'failed',
      secondsUsed: 0,
      costUsd: 0,
      completedAt: Date.now(),
      resultRef: null,
      error,
    };
  }

  // Create (and clean) the per-job package directory.
  _packageDirFor(jobId) {
    const dir = path.join(this.packageDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _writeFile(dir, name, content) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content, 'utf8');
    return full;
  }
}
