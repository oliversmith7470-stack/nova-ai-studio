// NOVA Personal GPU Cloud — Stage 1: mock provider.
//
// The ONLY working provider in Stage 1. It simulates a GPU run in-process:
// start() accepts the job synchronously and resolves a provider report
// after a short latency. No network, no GPU, no cost.
//
// Honest cancellation (VDP-02): requestCancel() records the request and
// returns true, but the in-flight run still resolves with its own outcome
// — exactly like a real GPU provider, where a kill cannot guarantee a
// running job stops or that an accepted job is not charged. The manager
// routes that late outcome through the cancel-requested path.

export class MockProvider {
  constructor(definition, { latencyMs = 5, outcome = 'succeed', secondsUsed = null } = {}) {
    this.definition = definition;
    this.latencyMs = latencyMs;
    this.outcome = outcome; // 'succeed' | 'fail'
    this.secondsUsed = secondsUsed; // fixed simulated runtime, or null for measured
    this.nextOutcome = null; // one-shot override via failNext()
    this.cancelRequests = new Set();
    this.startedJobs = [];
  }

  get id() {
    return this.definition.id;
  }

  // Accept a job. Returns a promise resolving to a provider report.
  start(job) {
    this.startedJobs.push(job.id);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      // unref: a simulated run must never hold the process open (a timed-out
      // job's mock timer outliving the test run is a simulator artefact,
      // not real work).
      const timer = setTimeout(() => {
        const outcome = this.nextOutcome ?? this.outcome;
        this.nextOutcome = null;
        const succeeded = outcome === 'succeed';
        resolve({
          jobId: job.id,
          providerId: this.id,
          status: succeeded ? 'succeeded' : 'failed',
          secondsUsed:
            this.secondsUsed ?? Math.max(0.001, (Date.now() - startedAt) / 1000),
          costUsd: 0, // mock is free, like the free tiers it stands in for
          completedAt: Date.now(),
          // Opaque delivery reference only — NEVER media bytes (O-27).
          resultRef: succeeded ? `mock://transient/${job.id}` : null,
          error: succeeded ? null : 'mock simulated failure',
        });
      }, this.latencyMs);
      timer.unref?.();
    });
  }

  // Make the NEXT run fail (one-shot, for tests).
  failNext() {
    this.nextOutcome = 'fail';
  }

  // Record a cancellation request. The in-flight run still resolves with
  // its own outcome — the honest VDP-02 rule.
  requestCancel(jobId) {
    this.cancelRequests.add(jobId);
    return true;
  }
}
