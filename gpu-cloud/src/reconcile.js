// NOVA Personal GPU Cloud — Stage 1: reconciliation.
//
// Compares provider-reported usage (a later provider statement: a usage
// export, a billing statement, or a second report) against NOVA's own job
// records, and flags every mismatch. Reconciliation is READ-ONLY: it
// never rewrites a job record — it produces a report the owner (or Stage 4
// automation) acts on.
//
// Mismatch kinds:
//   unknown-job            — the provider reported a job NOVA has no record of
//   provider-mismatch      — the report names a different provider than NOVA's record
//   job-not-terminal       — the provider reported a job NOVA still has in flight
//   status-mismatch        — provider outcome differs from NOVA's terminal status
//   cost-mismatch          — provider cost differs from what NOVA recorded at completion
//   seconds-mismatch       — provider runtime differs from what NOVA recorded
//   charged-for-failed-job — the provider charged for a job NOVA has as failed
//
// A cancellation-requested job that the provider completed anyway
// (cancelOutcome 'provider-completed') is NOT a status mismatch: NOVA
// marks it cancelled, the provider marks it succeeded, and both records
// are true — the cost is real and must be reconciled, not hidden.

import { isTerminal } from './job.js';

const COST_EPSILON_USD = 1e-9;
const SECONDS_EPSILON = 0.5; // provider and NOVA clocks measure differently

export function reconcileReports(jobsById, reports, now) {
  const mismatches = [];
  let matched = 0;
  let checked = 0;

  for (const report of reports) {
    checked += 1;
    const before = mismatches.length;
    const job = jobsById[report.jobId];

    if (!job) {
      mismatches.push({
        kind: 'unknown-job',
        jobId: report.jobId,
        providerId: report.providerId ?? null,
      });
      continue;
    }

    // Only meaningful once the job has a provider (a queued job has none —
    // its flag is job-not-terminal, below, not a provider mismatch).
    if (job.providerId !== null && job.providerId !== report.providerId) {
      mismatches.push({
        kind: 'provider-mismatch',
        jobId: job.id,
        nova: job.providerId,
        provider: report.providerId,
      });
    }

    if (!isTerminal(job)) {
      mismatches.push({
        kind: 'job-not-terminal',
        jobId: job.id,
        status: job.status,
      });
      continue;
    }

    const cancelCompleted =
      job.status === 'cancelled' && job.cancelOutcome === 'provider-completed';
    if (job.status !== report.status && !cancelCompleted) {
      mismatches.push({
        kind: 'status-mismatch',
        jobId: job.id,
        nova: job.status,
        provider: report.status,
      });
    }

    if (
      job.cost.providerReportedUsd !== null &&
      typeof report.costUsd === 'number' &&
      Math.abs(job.cost.providerReportedUsd - report.costUsd) > COST_EPSILON_USD
    ) {
      mismatches.push({
        kind: 'cost-mismatch',
        jobId: job.id,
        nova: job.cost.providerReportedUsd,
        provider: report.costUsd,
      });
    }

    if (
      job.cost.providerReportedSeconds !== null &&
      typeof report.secondsUsed === 'number' &&
      Math.abs(job.cost.providerReportedSeconds - report.secondsUsed) >
        SECONDS_EPSILON
    ) {
      mismatches.push({
        kind: 'seconds-mismatch',
        jobId: job.id,
        nova: job.cost.providerReportedSeconds,
        provider: report.secondsUsed,
      });
    }

    if (job.status === 'failed' && (report.costUsd ?? 0) > 0) {
      mismatches.push({
        kind: 'charged-for-failed-job',
        jobId: job.id,
        costUsd: report.costUsd,
      });
    }

    if (mismatches.length === before) matched += 1;
  }

  return { checked, matched, mismatched: checked - matched, mismatches, at: now };
}

// Jobs NOVA has as succeeded but which appear in NO provider statement.
// A missing statement is itself a mismatch worth chasing — the provider
// may bill later, or the completion may never have happened.
export function findUnreportedJobs(jobsById, reportedJobIds) {
  const reported = new Set(reportedJobIds);
  return Object.values(jobsById)
    .filter((j) => j.status === 'succeeded' && !reported.has(j.id))
    .map((j) => j.id);
}
