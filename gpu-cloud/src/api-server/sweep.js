// NOVA AI Studio — Phase 3 API process: O-23 sweep + 24-hour deletion.
//
// Rev 2 §9.2 (physical deletion) + §15 (O-23) as corrected by Rev 3
// §C-1.2 (precedence) and Rev 3.2 §B-3.2.9 (deletion-intent journal):
//
//   - Access expiry (§9.1) is UNCONDITIONAL and is enforced at every
//     read path, independently of this sweep. A deferred object is never
//     served. Physical deletion is a SEPARATE, conditional commitment:
//     within 1 hour past expiry PROVIDED the deletion system is running
//     and O-23 has not deferred deletion. O-23 TAKES PRECEDENCE: when the
//     daily ceiling is reached, the 80% threshold defers, the usage
//     figure is unreadable, or the process was down, the deadline is
//     SUSPENDED — recorded as a deadline breach, never silently broken,
//     never met by violating O-23.
//   - One cleanup operation = one deleted object, one deleted D1 row
//     (job/scene/rate-limit), or one deleted temp file. Delivery-ref
//     deletions are reported as `refs deleted` (informational, excluded
//     from the daily counter) and count inside their object's single
//     operation — never separately, never as D1 rows.
//   - Daily counter `cleanup-ops-<YYYY-MM-DD>` is persisted in the API
//     state and is the enforcement mechanism, not an after-the-fact
//     report. At 20,000 the sweep STOPS mid-run, records how many objects
//     remain, marks the run `deferred-at-ceiling`, and deletes nothing
//     further that day. Remaining deletions are deferred to the next
//     day's sweep, oldest expiry first.
//   - 80% account-wide threshold: before each sweep batch the usage
//     figure is read from the injected usage source. At or above 80% the
//     sweep defers (zero deletions, recorded). If the figure cannot be
//     read, the sweep defers as well — fail closed, never delete blind.
//     The production usage source is the A2 cost document's account-wide
//     reporting (still PARTIAL under test 12 — conditional, Rev 3 §C-3
//     Q6); the default source here reports unreadable, so a deployment
//     without a configured source deletes nothing. That is the specified
//     fail-closed behaviour, not a bug.
//   - Deletion is NOT atomic across components. Before deleting anything
//     the sweeper writes a deletion-intent record (refs → chunks → index
//     order; index last so a crash leaves the object discoverable for
//     resume). Deleting an absent component is a no-op, never an error.
//     One logical object deletion is ONE cleanup operation even when
//     recovery spans several runs: the counter increments by exactly one
//     per intent COMPLETED in that run; a still-pending intent counts 0.
//   - mark-expired (D1) is issued ONLY after the object's deletion
//     intent completes. If the process crashes after deletion but before
//     the D1 update, startup catch-up finds the intent completed with
//     the scene row still non-expired and issues mark-expired then.
//   - Retention record deletion is DISABLED until Shina confirms Q3
//     (Rev 3.1 §A-3.1.3): `job_record_retention_enabled = false`,
//     `job_record_retention_days` unset. Every sweep report records
//     `retention-deletion: disabled (unconfirmed)`. The 24-hour output
//     clock is independent and stays active.
//   - Temp files older than 1 hour are deleted by the sweep (§16.3).

import fs from 'node:fs';
import path from 'node:path';
import {
  CLEANUP_DAILY_CEILING,
  CLEANUP_USAGE_THRESHOLD,
  RETENTION_ALERT_ROWS,
  RETENTION_ALERT_BYTES,
  RETENTION_DAYS,
} from './constants.js';

const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

// Parent-aggregate terminal statuses (Worker list-pending-jobs exclusion
// set): only these jobs are eligible for retention deletion.
const TERMINAL_JOB_STATUSES = new Set([
  'succeeded', 'partial_failed', 'failed', 'cancelled', 'expired',
]);

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class SweepRunner {
  constructor({
    manager,
    d1Client,
    apiState,
    dispatch,
    usageSource = null, // () => { readable: boolean, usageFraction?: number } | null
    retentionEnabled = false,
    retentionDays = null,
    now = () => Date.now(),
    onBeforeComponent = null, // test hook: (intent, component) => void; may throw to simulate a crash
    onBeforeDeleteRows = null, // test hook: (intent, table) => void; may throw to simulate a crash mid-retention-deletion
  } = {}) {
    if (!manager) throw new Error('SweepRunner requires a GpuManager');
    if (!d1Client) throw new Error('SweepRunner requires a d1Client');
    if (!apiState) throw new Error('SweepRunner requires an ApiStateStore');
    this.manager = manager;
    this.d1Client = d1Client;
    this.apiState = apiState;
    this.dispatch = dispatch ?? null;
    this.usageSource = usageSource;
    this.retentionEnabled = retentionEnabled;
    this.retentionDays = retentionDays;
    this.now = now;
    this.onBeforeComponent = onBeforeComponent;
    this.onBeforeDeleteRows = onBeforeDeleteRows;
  }

  dailyCounterKey(nowMs) {
    return `cleanup-ops-${dayKey(nowMs)}`;
  }

  dailyCount(nowMs) {
    return this.apiState.state.cleanupCounters[this.dailyCounterKey(nowMs)] ?? 0;
  }

  _incrementDailyCounter(nowMs, n = 1) {
    this.apiState.mutate((s) => {
      const key = this.dailyCounterKey(nowMs);
      s.cleanupCounters[key] = (s.cleanupCounters[key] ?? 0) + n;
    });
  }

  // -- deletion intents (Rev 3.2 §B-3.2.9.2) -------------------------------

  _intentKey(namespace, objectId) {
    return `${namespace}/${objectId}`;
  }

  _writeIntent(namespace, objectId) {
    const key = this._intentKey(namespace, objectId);
    const intent = {
      type: 'deletion-intent',
      objectId,
      namespace,
      components: ['refs', 'chunks', 'index'],
      state: 'pending',
      startedAt: this.now(),
      completedAt: null,
    };
    this.apiState.mutate((s) => {
      s.deletionIntents[key] = intent;
    });
    return intent;
  }

  _completeIntent(namespace, objectId) {
    const key = this._intentKey(namespace, objectId);
    this.apiState.mutate((s) => {
      const intent = s.deletionIntents[key];
      if (intent) {
        intent.state = 'completed';
        intent.completedAt = this.now();
      }
    });
  }

  // Delete one object's components in order: refs → chunks → index.
  // `tally` receives refsDeleted immediately when the refs step runs,
  // so refs removed by a run that later crashes are still counted in
  // THAT run (Rev 3.2 §B-3.2.9.3). Returns { completed: boolean }.
  // A component already absent is a no-op. A throw from the fault hook
  // (simulated crash) leaves the intent pending for resume.
  async _deleteObjectComponents(namespace, objectId, tally = null) {
    const storage = this.manager.storage;
    const index = storage.index;
    const key = this._intentKey(namespace, objectId);
    let intent = this.apiState.state.deletionIntents[key];
    if (!intent) intent = this._writeIntent(namespace, objectId);
    if (intent.state === 'completed') return { completed: true };

    const step = async (component, fn) => {
      if (this.onBeforeComponent) await this.onBeforeComponent(intent, component);
      return fn();
    };

    // 1. Delivery references first — no redemption of a partially
    //    deleted object can occur after this.
    const refsDeleted = await step('refs', () => index.deleteRefsForObject(namespace, objectId));
    if (tally) tally.refsDeleted = (tally.refsDeleted ?? 0) + refsDeleted;
    // 2. Chunks.
    await step('chunks', () => storage.backend.deleteObjectChunks(namespace, objectId));
    // 3. Index entry last — the record of the object's existence.
    await step('index', () => index.deleteObject(namespace, objectId));

    this._completeIntent(namespace, objectId);
    return { completed: true };
  }

  async _resumePendingIntents(report) {
    const pending = Object.values(this.apiState.state.deletionIntents || {})
      .filter((i) => i.state === 'pending')
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const intent of pending) {
      if (this.dailyCount(this.now()) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        break;
      }
      try {
        await this._deleteObjectComponents(intent.namespace, intent.objectId, report);
        this._incrementDailyCounter(this.now(), 1);
        report.objectsDeleted += 1;
        report.resumedIntents += 1;
        await this._markExpiredForObject(intent.namespace, intent.objectId, report);
      } catch (err) {
        // Crash mid-deletion: intent stays pending; resume next run.
        report.errors.push(`resume ${intent.namespace}/${intent.objectId}: ${err && err.message ? err.message : err}`);
        break;
      }
    }
  }

  async _markExpiredForObject(namespace, objectId, report) {
    // Find the D1 scene(s) whose stored output is this object, via the
    // manager job that holds the outputRef.
    const jobs = Object.values(this.manager.store.state.jobs || {});
    const job = jobs.find(
      (j) => j.outputRef && j.outputRef.namespace === namespace && j.outputRef.objectId === objectId,
    );
    if (!job) return;
    // The D1 scene rows are found by provider_job_id through list-scenes
    // of the parent job — the parent jobId is the execution's jobId,
    // recoverable from the journal by managerJobId.
    const entry = Object.values(this.apiState.state.dispatchJournal || {})
      .find((e) => e.managerJobId === job.id);
    if (!entry) return;
    if (!this.dispatch) return;
    const res = await this.dispatch._applyD1([{
      type: 'mark-expired', jobId: entry.jobId, sceneIndexes: [entry.sceneIndex],
    }]);
    if (res.ok) report.markExpiredIssued += 1;
    else report.markExpiredPending += 1;
  }

  // -- the sweep -----------------------------------------------------------

  async runSweep({ reason = 'interval' } = {}) {
    const nowMs = this.now();
    const report = {
      at: nowMs,
      reason,
      objectsDeleted: 0,
      refsDeleted: 0,
      tempFilesDeleted: 0,
      rateLimitRowsDeleted: 0,
      jobSceneRowsDeleted: 0,
      jobRowsDeleted: 0,
      retentionCandidatesExamined: 0,
      retentionDeletedJobs: 0,
      resumedIntents: 0,
      markExpiredIssued: 0,
      markExpiredPending: 0,
      dailyCounter: this.dailyCount(nowMs),
      ceiling: CLEANUP_DAILY_CEILING,
      deferredAtCeiling: false,
      deferredReason: null,
      thresholdChecked: null,
      retentionDeletion: 'disabled (unconfirmed)',
      retentionAuthRefused: false,
      retainedRows: null,
      retainedBytes: null,
      retainedMeasurement: null,
      breaches: [],
      errors: [],
      durationMs: 0,
    };
    const started = Date.now();

    // Retention gate (Rev 3.1 §A-3.1.3): disabled until Q3 is confirmed.
    if (this.retentionEnabled && this.retentionDays !== null) {
      report.retentionDeletion = `enabled (${this.retentionDays} days)`;
    }

    // 80% threshold check (Rev 2 §15.3): fail closed when unreadable.
    let usage = null;
    try {
      usage = this.usageSource ? await this.usageSource() : null;
    } catch {
      usage = null;
    }
    if (!usage || usage.readable !== true || typeof usage.usageFraction !== 'number') {
      report.thresholdChecked = 'unreadable';
      report.deferredReason = 'usage-unreadable';
      this._recordBreach(report, 'usage-unreadable', 0, null);
      this._finishReport(report, started);
      return report;
    }
    report.thresholdChecked = usage.usageFraction;
    if (usage.usageFraction >= CLEANUP_USAGE_THRESHOLD) {
      report.deferredReason = 'threshold';
      this._recordBreach(report, 'threshold', 0, null);
      this._finishReport(report, started);
      return report;
    }

    // Resume interrupted deletions first (oldest intent first).
    await this._resumePendingIntents(report);
    if (report.deferredAtCeiling) {
      this._recordBreach(report, 'ceiling', 0, null);
      this._finishReport(report, started);
      return report;
    }

    // Expired objects, oldest expiry first (Rev 2 §15.2 deferral order).
    const expired = this.manager.storage.index.listExpired(nowMs)
      .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
    let remaining = 0;
    for (const record of expired) {
      if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        remaining = expired.length - expired.indexOf(record);
        break;
      }
      try {
        await this._deleteObjectComponents(record.namespace, record.objectId, report);
        this._incrementDailyCounter(nowMs, 1);
        report.objectsDeleted += 1;
        await this._markExpiredForObject(record.namespace, record.objectId, report);
      } catch (err) {
        report.errors.push(`delete ${record.namespace}/${record.objectId}: ${err && err.message ? err.message : err}`);
        break;
      }
    }
    if (report.deferredAtCeiling) {
      const oldest = expired.length > 0 ? expired[0].expiresAt : null;
      this._recordBreach(report, 'ceiling', remaining, oldest);
    }

    // Temp files older than 1 hour (§16.3), each one cleanup operation.
    await this._sweepTempFiles(nowMs, report);

    // Retention deletion (Rev 2 §16.1, Q3 approved 25 Nov 2026): job and
    // scene rows 30 days after the parent job reached a terminal state,
    // deleted by the O-23-counted cleanup. The sweep enumerates the
    // full terminal population via list-terminal-jobs (Worker
    // impl-notes §10.4), not just journal-observed jobs.
    await this._runRetentionDeletion(nowMs, report);

    // Expired rate-limit rows (§14.3/§15), enumerated via
    // list-expired-rate-limits (Worker impl-notes §10.4). Independent
    // of the Q3 job-retention gate: rate-limit cleanup runs even when
    // job retention is disabled.
    await this._runRateLimitCleanup(nowMs, report);

    // Retained totals, best-effort (see notes doc §6: the Worker d1-read
    // surface cannot return the full jobs+scenes population, so this is
    // a partial measurement — non-terminal jobs plus the API-tracked
    // terminal candidates — labelled as such; the alert below fires on
    // the partial figure, never as a claim about the full population).
    try {
      const measured = await this._measureRetained();
      report.retainedRows = measured.rows;
      report.retainedBytes = measured.bytes;
      report.retainedMeasurement = measured.label;
      if (measured.rows >= RETENTION_ALERT_ROWS || measured.bytes >= RETENTION_ALERT_BYTES) {
        this.apiState.logOperator('retention-backlog-alert', {
          retainedRows: measured.rows,
          retainedBytes: measured.bytes,
          measurement: measured.label,
        });
        report.breaches.push({ reason: 'retention-alert', rows: measured.rows, bytes: measured.bytes });
      }
    } catch (err) {
      report.errors.push(`retention measurement: ${err && err.message ? err.message : err}`);
    }

    // 1-hour deletion bound: any object still expired-and-present after
    // this run is a suspended-deadline breach (§C-1.2).
    const stillExpired = this.manager.storage.index.listExpired(nowMs);
    const overdue = stillExpired.filter((r) => nowMs - (r.expiresAt ?? nowMs) > 60 * 60 * 1000);
    if (overdue.length > 0 && !report.deferredAtCeiling && !report.deferredReason) {
      this._recordBreach(report, 'sweep-incomplete', overdue.length,
        Math.min(...overdue.map((r) => r.expiresAt ?? nowMs)));
    }

    this._finishReport(report, started);
    return report;
  }

  _recordBreach(report, reason, count, oldestExpiry) {
    const breach = {
      reason, count, oldestExpiry,
      at: this.now(),
      note: 'Physical-deletion deadline suspended (O-23 precedence, Rev 3 §C-1.2). Access expiry (§9.1) is unaffected.',
    };
    report.breaches.push(breach);
    this.apiState.logOperator('deletion-deadline-breach', breach);
  }

  async _sweepTempFiles(nowMs, report) {
    const tempFiles = { ...(this.apiState.state.tempFiles || {}) };
    for (const [filePath, meta] of Object.entries(tempFiles)) {
      if (nowMs - (meta.createdAt ?? 0) <= TEMP_MAX_AGE_MS) continue;
      if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        break;
      }
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // A missing temp file is already gone — still drop the registry entry.
      }
      this.apiState.mutate((s) => { delete s.tempFiles[filePath]; });
      this._incrementDailyCounter(nowMs, 1);
      report.tempFilesDeleted += 1;
    }
  }

  // -- retention deletion (Rev 2 §16.1, Q3 approved 25 Nov 2026) --------
  //
  // A job's rows are deleted 30 days after the parent job reached a
  // terminal state, by the O-23-counted cleanup: each deleted D1 row is
  // one cleanup operation (§15.1), subject to the same 20,000/day
  // ceiling and the same threshold gate as storage deletion.
  //
  // Order per job: storage objects first (deletion-intent journal,
  // refs → chunks → index-last — usually a no-op, since outputs expire
  // after 24 h, long before day 30), then scene rows, then the job row.
  // Scenes are always deleted before their parent job row.
  //
  // Enumeration (Worker impl-notes §10.4): the sweep enumerates the
  // full eligible terminal population via list-terminal-jobs
  // (beforeMs = now - retentionMs), UNION journal-observed retention
  // candidates. The candidates are kept as a second source because
  // they are also the crash-resume path: a deletion interrupted after
  // its scene rows were deleted leaves a terminal job with no scene
  // rows (terminalAtMs null), which the beforeMs enumeration excludes,
  // so enumeration alone could never resume it. A terminal job with no
  // scene rows AND no candidate remains invisible to this sweep (the
  // Worker-side scheduled() sweep covers it via its get-job fallback);
  // that residual gap is recorded in the impl-notes doc, not hidden.
  //
  // Crash safety: a retention-deletion intent is written BEFORE any row
  // is deleted. A crash between the scene delete and the job delete
  // leaves the intent pending; the next run resumes it. DELETE is
  // idempotent on ids, and the counter increments ONLY by the mutation's
  // `changes` (rows actually deleted), so a resumed deletion never
  // double-counts.

  _seedRetentionCandidatesFromJournal() {
    for (const entry of Object.values(this.apiState.state.dispatchJournal || {})) {
      if (entry.state !== 'failed' && !entry.terminalAt) continue;
      const terminalAt = entry.terminalAt
        ?? (entry.timestamps && entry.timestamps.failed)
        ?? null;
      if (terminalAt === null) continue;
      this.apiState.mutate((s) => {
        if (!s.retentionCandidates[entry.jobId]) {
          s.retentionCandidates[entry.jobId] = { terminalAt, firstSeenAt: this.now() };
        }
      });
    }
  }

  async _runRetentionDeletion(nowMs, report) {
    if (!this.retentionEnabled || this.retentionDays === null) {
      report.retentionDeletion = 'disabled (unconfirmed)';
      return;
    }
    report.retentionDeletion = `enabled (${this.retentionDays} days)`;
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    this._seedRetentionCandidatesFromJournal();

    // Worklist = union of two sources, deduplicated by jobId:
    // (a) the FULL eligible terminal population from D1, enumerated via
    // list-terminal-jobs with beforeMs = now - retentionMs (Worker
    // impl-notes §10.4). The Worker's terminal age is MAX(scenes
    // .updated_at), so these rows are eligible by construction.
    // (b) journal-observed retention candidates. Kept as a second
    // source because it is also the crash-resume path: a deletion
    // interrupted after its scene rows were deleted leaves a terminal
    // job with NO scene rows, whose terminalAtMs is then null — and
    // with beforeMs the Worker excludes null-terminalAtMs rows, so
    // enumeration alone can never resume it. The candidate's own
    // terminalAt is the age gate for candidate-only rows.
    const worklist = new Map(); // jobId -> { jobId, terminalAtMs, candidateTerminalAt }
    if (typeof this.d1Client.listTerminalJobs === 'function') {
      try {
        const beforeMs = nowMs - retentionMs;
        for (;;) {
          const batch = await this.d1Client.listTerminalJobs({ beforeMs, limit: 100 });
          if (!batch || batch.length === 0) break;
          let added = 0;
          for (const row of batch) {
            if (!row || !row.id || worklist.has(row.id)) continue;
            worklist.set(row.id, {
              jobId: row.id,
              terminalAtMs: row.terminalAtMs ?? null,
              candidateTerminalAt: undefined,
            });
            added += 1;
          }
          if (batch.length < 100 || added === 0) break;
        }
      } catch (err) {
        // Enumeration failure must not abort retention entirely: the
        // candidate path below still runs. The failure is recorded.
        report.errors.push(`retention enumeration (list-terminal-jobs) failed: ${err && err.message ? err.message : err}`);
      }
    } else {
      report.errors.push('retention enumeration unavailable: d1Client has no listTerminalJobs');
    }
    const candidates = Object.entries(this.apiState.state.retentionCandidates || {})
      .sort((a, b) => (a[1].terminalAt ?? 0) - (b[1].terminalAt ?? 0));
    for (const [jobId, cand] of candidates) {
      const existing = worklist.get(jobId);
      if (existing) existing.candidateTerminalAt = cand.terminalAt;
      else {
        worklist.set(jobId, {
          jobId,
          terminalAtMs: null,
          candidateTerminalAt: cand.terminalAt,
        });
      }
    }

    // Oldest first, by whichever terminal timestamp the entry carries.
    const ordered = [...worklist.values()].sort((a, b) => {
      const ta = a.terminalAtMs ?? a.candidateTerminalAt ?? 0;
      const tb = b.terminalAtMs ?? b.candidateTerminalAt ?? 0;
      return ta - tb;
    });
    for (const item of ordered) {
      if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        break;
      }
      report.retentionCandidatesExamined += 1;
      // Enumerated rows already satisfy beforeMs. Candidate-only rows
      // are gated on the candidate's observed terminal time.
      if (item.terminalAtMs === null && item.candidateTerminalAt !== undefined) {
        if ((item.candidateTerminalAt ?? Infinity) > nowMs - retentionMs) continue;
      }
      await this._deleteRetentionJob(item.jobId, nowMs, report);
      if (report.retentionAuthRefused) break;
    }
  }

  // Rate-limit cleanup (Rev 2 §14.3/§15): expired rate-limit window
  // rows are deleted by the O-23-counted cleanup, one operation per
  // row actually deleted. Enumerated via list-expired-rate-limits
  // (Worker impl-notes §10.4); previously there was no enumeration op,
  // so rateLimitRowsDeleted stayed 0. Runs even when job retention is
  // disabled — it is §15 cleanup, not Q3 retention. Subject to the
  // same daily ceiling and threshold gate as the rest of the sweep
  // (the threshold check already ran in runSweep). A failed delete
  // (non-auth) is recorded via _applyD1's pending queue for replay and
  // counts 0 here; an auth refusal stops the cleanup for this run.
  async _runRateLimitCleanup(nowMs, report) {
    if (!this.dispatch) {
      report.errors.push('rate-limit cleanup: no dispatch client, skipped');
      return;
    }
    if (typeof this.d1Client.listExpiredRateLimits !== 'function') {
      report.errors.push('rate-limit cleanup unavailable: d1Client has no listExpiredRateLimits');
      return;
    }
    try {
      for (;;) {
        if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
          report.deferredAtCeiling = true;
          break;
        }
        const rows = await this.d1Client.listExpiredRateLimits({ limit: 100 });
        if (!rows || rows.length === 0) break;
        const keys = rows.map((r) => r && r.key).filter(Boolean);
        if (keys.length === 0) break;
        const res = await this.dispatch._applyD1([{ type: 'delete-rows', table: 'rate_limits', ids: keys }]);
        if (!res.ok) {
          if (res.auth) report.retentionAuthRefused = true;
          report.errors.push(`rate-limit cleanup: delete-rows failed${res.auth ? ' (auth refused)' : ''}`);
          break;
        }
        const changes = res.result && res.result.results
          && res.result.results[0] && typeof res.result.results[0].changes === 'number'
          ? res.result.results[0].changes
          : 0;
        if (changes > 0) {
          this._incrementDailyCounter(nowMs, changes);
          report.rateLimitRowsDeleted += changes;
        }
        if (rows.length < 100) break;
      }
    } catch (err) {
      report.errors.push(`rate-limit cleanup failed: ${err && err.message ? err.message : err}`);
    }
  }

  async _deleteRetentionJob(jobId, nowMs, report) {
    // Fresh read: confirm the parent is terminal before deleting
    // anything. A candidate whose parent is not (or no longer) terminal
    // is left alone — it may become terminal later.
    let job;
    try {
      job = await this.d1Client.getJob(jobId);
    } catch (err) {
      report.errors.push(`retention ${jobId}: get-job failed: ${err && err.message ? err.message : err}`);
      return;
    }
    if (!job) {
      // The job row is already gone (deleted elsewhere): drop the
      // candidate and its intent, nothing to count.
      this.apiState.mutate((s) => {
        delete s.retentionCandidates[jobId];
        delete s.retentionIntents[jobId];
      });
      return;
    }
    let data;
    try {
      data = JSON.parse(job.data);
    } catch {
      report.errors.push(`retention ${jobId}: job data is not JSON`);
      return;
    }
    if (!TERMINAL_JOB_STATUSES.has(data.status)) return;

    let scenes;
    try {
      scenes = await this.d1Client.listScenes(jobId);
    } catch (err) {
      report.errors.push(`retention ${jobId}: list-scenes failed: ${err && err.message ? err.message : err}`);
      return;
    }

    const intentKey = jobId;
    let intent = this.apiState.state.retentionIntents[intentKey];
    if (!intent) {
      intent = {
        type: 'retention-deletion',
        jobId,
        state: 'pending',
        scenesDeleted: 0,
        jobDeleted: false,
        startedAt: nowMs,
        completedAt: null,
      };
      this.apiState.mutate((s) => { s.retentionIntents[intentKey] = intent; });
    }
    if (intent.state === 'completed') {
      this.apiState.mutate((s) => {
        delete s.retentionCandidates[jobId];
        delete s.retentionIntents[jobId];
      });
      return;
    }

    // 1. Storage objects first, via the deletion-intent journal.
    for (const s of scenes) {
      if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        return;
      }
      const entry = this.dispatch ? this.dispatch.journalEntry(s.execution_id) : null;
      const managerJob = entry && entry.managerJobId ? this.manager.getJob(entry.managerJobId) : null;
      const outputRef = managerJob && managerJob.outputRef ? managerJob.outputRef : null;
      if (!outputRef || !outputRef.namespace || !outputRef.objectId) continue;
      if (!this.manager.storage.index.getObject(outputRef.namespace, outputRef.objectId)) continue;
      try {
        await this._deleteObjectComponents(outputRef.namespace, outputRef.objectId, report);
        this._incrementDailyCounter(nowMs, 1);
        report.objectsDeleted += 1;
      } catch (err) {
        report.errors.push(`retention ${jobId}: object delete failed: ${err && err.message ? err.message : err}`);
        return;
      }
    }

    // 2. Scene rows (by execution_id), then the job row. Each deleted
    // row is one O-23 operation, counted by the mutation's `changes`.
    const deleteRows = async (table, ids) => {
      if (ids.length === 0) return { ok: true, changes: 0 };
      if (this.dailyCount(nowMs) >= CLEANUP_DAILY_CEILING) {
        report.deferredAtCeiling = true;
        return { ok: false, ceiling: true, changes: 0 };
      }
      try {
        if (this.onBeforeDeleteRows) await this.onBeforeDeleteRows(intent, table);
      } catch {
        // Test hook simulating a crash mid-deletion: the batch never
        // ran. Per-job failure, not a sweep abort — the intent stays
        // pending and the next run resumes it.
        return { ok: false, hook: true, changes: 0 };
      }
      const res = await this.dispatch._applyD1([{ type: 'delete-rows', table, ids }]);
      if (!res.ok) {
        if (res.auth) report.retentionAuthRefused = true;
        return { ok: false, auth: !!res.auth, changes: 0 };
      }
      const changes = res.result && res.result.results
        && res.result.results[0] && typeof res.result.results[0].changes === 'number'
        ? res.result.results[0].changes
        : 0;
      return { ok: true, changes };
    };

    if (!intent.jobDeleted) {
      const sceneIds = scenes.map((s) => s.execution_id).filter(Boolean);
      if (sceneIds.length > 0) {
        const r = await deleteRows('scenes', sceneIds);
        if (!r.ok) {
          report.errors.push(`retention ${jobId}: scene delete failed${r.auth ? ' (auth refused)' : ''}`);
          return;
        }
        if (r.changes > 0) {
          this._incrementDailyCounter(nowMs, r.changes);
          report.jobSceneRowsDeleted += r.changes;
          this.apiState.mutate((s) => {
            const it = s.retentionIntents[intentKey];
            if (it) it.scenesDeleted = (it.scenesDeleted ?? 0) + r.changes;
          });
        }
      }
      const r = await deleteRows('jobs', [jobId]);
      if (!r.ok) {
        report.errors.push(`retention ${jobId}: job delete failed${r.auth ? ' (auth refused)' : ''}`);
        return;
      }
      if (r.changes > 0) {
        this._incrementDailyCounter(nowMs, r.changes);
        report.jobRowsDeleted += r.changes;
      }
      this.apiState.mutate((s) => {
        const it = s.retentionIntents[intentKey];
        if (it) {
          it.jobDeleted = true;
          it.state = 'completed';
          it.completedAt = this.now();
        }
        delete s.retentionCandidates[jobId];
      });
      report.retentionDeletedJobs += 1;
    }
  }

  // Logical UTF-8 payload measurement (Rev 3.2 §B-3.2.6.2) over the
  // jobs+scenes rows the API process can see. PARTIAL: the visible
  // population is non-terminal jobs (list-pending-jobs, limit 100) PLUS
  // the API-tracked terminal candidates; terminal jobs outside the API
  // view are not counted. The report labels it; it is never presented
  // as the full retained population (the Worker scheduled() computes the
  // exact figure on D1).
  async _measureRetained() {
    const seen = new Set();
    const rows = [];
    const pending = await this.d1Client.listPendingJobs();
    for (const row of pending) {
      if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    for (const jobId of Object.keys(this.apiState.state.retentionCandidates || {})) {
      if (seen.has(jobId)) continue;
      try {
        const job = await this.d1Client.getJob(jobId);
        if (job) { seen.add(jobId); rows.push(job); }
      } catch {
        // A candidate whose job cannot be read is skipped, not fatal.
      }
    }
    let rowCount = 0;
    let bytes = 0;
    for (const row of rows) {
      rowCount += 1;
      bytes += Buffer.byteLength(row.id ?? '', 'utf8')
        + Buffer.byteLength(typeof row.data === 'string' ? row.data : JSON.stringify(row.data ?? ''), 'utf8');
      const scenes = await this.d1Client.listScenes(row.id);
      for (const s of scenes) {
        rowCount += 1;
        bytes += Buffer.byteLength(s.job_id ?? '', 'utf8')
          + Buffer.byteLength(s.execution_id ?? '', 'utf8')
          + Buffer.byteLength(s.provider_job_id ?? '', 'utf8')
          + Buffer.byteLength(s.status ?? '', 'utf8')
          + Buffer.byteLength(s.error ?? '', 'utf8')
          + Buffer.byteLength(s.output_ref ?? '', 'utf8')
          + 32;
      }
    }
    return { rows: rowCount, bytes, label: 'partial: non-terminal jobs (list-pending-jobs, limit 100) + API-tracked terminal candidates' };
  }

  registerTempFile(filePath, jobId) {
    this.apiState.mutate((s) => {
      s.tempFiles[filePath] = { jobId, createdAt: this.now() };
    });
  }

  _finishReport(report, started) {
    report.durationMs = Date.now() - started;
    report.dailyCounter = this.dailyCount(this.now());
    this.apiState.mutate((s) => {
      s.sweepReports.push(report);
      if (s.sweepReports.length > 50) s.sweepReports.splice(0, s.sweepReports.length - 50);
    });
  }
}
