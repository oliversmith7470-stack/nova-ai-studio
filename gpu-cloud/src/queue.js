// NOVA Personal GPU Cloud — Stage 1: queue ordering.
//
// FIFO with priority: higher priority first; ties break by submission
// order (the monotonic `seq` assigned at submit time, so ordering never
// depends on wall-clock granularity).
//
// Head-of-line note: the dispatcher takes the FIRST queued job and, if no
// provider can run it, stops — it does not skip ahead to a later job.
// Skipping is a Stage 2+ decision (it changes fairness guarantees).

export function queuedJobs(state) {
  return Object.values(state.jobs)
    .filter((j) => j.status === 'queued')
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
}

export function queueDepth(state) {
  return Object.values(state.jobs).filter((j) => j.status === 'queued').length;
}

export function nextJob(state) {
  return queuedJobs(state)[0] ?? null;
}
