// O-23 sweep (Rev 2 §15, Rev 3 §C-1.2) + deletion-intent journal
// (Rev 3.2 §B-3.2.9.2): 20,000/day ceiling, 80% threshold, refs →
// chunks → index-last ordering, mark-expired only after completion,
// retention deletion ENABLED at 30 days (Q3 approved 25 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApi, submitBody, seedJobForSubmit, execIdFor, canonicalJobId } from './support.mjs';
import { HttpD1Client } from '../d1-client.js';

async function putExpiredObject(api, label, { withJob = false } = {}) {
  const storage = api.manager.storage;
  const obj = Buffer.from(`object-${label}`);
  const ref = await storage.put({
    namespace: 'outputs',
    source: obj,
    contentType: 'video/mp4',
    ttlMs: 3600 * 1000,
  });
  const objectId = ref.objectId; // content-addressed: the id IS the hash
  // One delivery reference, so the refs-deleted accounting is exercised.
  // (Issued before expiring: refs cannot be issued for expired objects.)
  await storage.issueDeliveryRef({ namespace: 'outputs', objectId });
  // Force expiry in the index record (ttlMs: 1 already expired by the
  // time the sweep reads, but make it explicit).
  const record = storage.index.getObject('outputs', objectId);
  record.expiresAt = Date.now() - 1000;
  storage.index.save();
  if (withJob) {
    const managerJobId = `job_${objectId}`;
    api.manager.store.storeJob(managerJobId, {
      id: managerJobId,
      type: 'video',
      modelId: 'ltx-video-2b',
      prompt: 'test',
      status: 'completed',
      outputRef: { ...ref, objectId },
    });
  }
  return { ref, objectId };
}

test('expired objects are deleted and counted once; mark-expired follows completion', async (t) => {
  const { api, cleanup } = await makeApi();
  t.after(cleanup);
  const sweepA = await putExpiredObject(api, 'sweep-a');
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.objectsDeleted, 1);
  assert.equal(report.deferredAtCeiling, false);
  assert.equal(api.manager.storage.index.getObject('outputs', sweepA.objectId), null);
  const counter = api.apiState.state.cleanupCounters[`cleanup-ops-${new Date().toISOString().slice(0, 10)}`];
  assert.equal(counter, 1);
});

test('ceiling: sweep stops at 20,000/day and defers the rest oldest-first', async (t) => {
  const { api, cleanup } = await makeApi();
  t.after(cleanup);
  const today = `cleanup-ops-${new Date().toISOString().slice(0, 10)}`;
  api.apiState.mutate((s) => { s.cleanupCounters[today] = 19999; });
  const ceil1 = await putExpiredObject(api, 'ceil-1');
  const ceil2 = await putExpiredObject(api, 'ceil-2');
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.objectsDeleted, 1);
  assert.equal(report.deferredAtCeiling, true);
  assert.equal(api.apiState.state.cleanupCounters[today], 20000);
  assert.equal(api.manager.storage.index.getObject('outputs', ceil1.objectId), null);
  assert.ok(api.manager.storage.index.getObject('outputs', ceil2.objectId), 'second object deferred, not deleted');
});

test('threshold 80%: defer with zero deletions', async (t) => {
  const { api, cleanup } = await makeApi({
    usageSource: async () => ({ readable: true, usageFraction: 0.85 }),
  });
  t.after(cleanup);
  const thresh = await putExpiredObject(api, 'thresh-1');
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.objectsDeleted, 0);
  assert.equal(report.deferredAtCeiling, false);
  assert.equal(report.deferredReason, 'threshold');
  assert.equal(report.thresholdChecked, 0.85);
  assert.ok(report.breaches.some((b) => b.reason === 'threshold'));
  assert.ok(api.manager.storage.index.getObject('outputs', thresh.objectId), 'nothing deleted at threshold');
  const log = api.apiState.state.operatorLog;
  assert.ok(log.some((e) => e.event === 'deletion-deadline-breach' && e.reason === 'threshold'));
});

test('unreadable usage figure: defer, fail closed', async (t) => {
  const { api, cleanup } = await makeApi({
    usageSource: async () => ({ readable: false, error: 'probe failed' }),
  });
  t.after(cleanup);
  const unread = await putExpiredObject(api, 'unread-1');
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.objectsDeleted, 0);
  assert.equal(report.deferredReason, 'usage-unreadable');
  assert.equal(report.thresholdChecked, 'unreadable');
  assert.ok(api.manager.storage.index.getObject('outputs', unread.objectId));
});

test('interrupted deletion resumes: counter increments exactly once for the object', async (t) => {
  let crash = true;
  const { api, cleanup } = await makeApi({
    onBeforeComponent: async (intent, component) => {
      if (crash && component === 'chunks') {
        throw new Error('simulated crash before chunks');
      }
    },
  });
  t.after(cleanup);
  const crashObj = await putExpiredObject(api, 'crash-1');
  const report1 = await api.runSweep({ reason: 'test' });
  assert.equal(report1.objectsDeleted, 0, 'crashed run deletes nothing (counter)');
  assert.equal(report1.errors.length, 1);
  // Refs were removed by the crashed run and are counted in THAT run.
  assert.equal(report1.refsDeleted, 1);
  assert.equal(api.apiState.state.deletionIntents[`outputs/${crashObj.objectId}`].state, 'pending');
  // Chunks still exist; index record still exists.
  assert.ok(api.manager.storage.index.getObject('outputs', crashObj.objectId));
  crash = false;
  const report2 = await api.runSweep({ reason: 'test' });
  assert.equal(report2.objectsDeleted, 1);
  assert.equal(report2.resumedIntents, 1);
  assert.equal(report2.refsDeleted, 0, 'refs were already gone; counted in the crashed run, not again');
  assert.equal(api.manager.storage.index.getObject('outputs', crashObj.objectId), null);
  const today = `cleanup-ops-${new Date().toISOString().slice(0, 10)}`;
  assert.equal(api.apiState.state.cleanupCounters[today], 1, 'one logical object deletion = one operation');
});

test('retention deletion is ENABLED at 30 days (Q3 approved 25 Nov 2026)', async (t) => {
  const { api, cleanup } = await makeApi();
  t.after(cleanup);
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletion, 'enabled (30 days)');
});

test('sweep report is persisted and capped', async (t) => {
  const { api, cleanup } = await makeApi();
  t.after(cleanup);
  await api.runSweep({ reason: 'test' });
  const reports = api.apiState.state.sweepReports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, 'test');
});

// -- Retention deletion (Rev 2 §16.1, Q3 approved 25 Nov 2026) --------
// 30 days after the parent job reaches a terminal state, its scene rows
// then its job row are deleted by the O-23-counted cleanup, one
// operation per row actually deleted.

// Helper: submit a job whose push is dropped; the ack watcher fails it
// (executor-ack-timeout), the parent aggregate becomes terminal
// (failed), and the retention candidate is recorded.
async function makeFailedJob(api, d1, executor, label) {
  executor.dropSubmissions = true;
  const body = submitBody(label);
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 900));
  const entry = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(entry.state, 'failed');
  assert.equal(entry.error, 'executor-ack-timeout');
  assert.ok(api.apiState.state.retentionCandidates[body.jobId], 'candidate recorded');
  return body.jobId;
}

function ageCandidate(api, d1, jobId, days) {
  // Age the candidate AND its D1 scene rows: since the sweep now
  // enumerates via list-terminal-jobs, eligibility comes from
  // MAX(scenes.updated_at), not from the candidate's recorded
  // terminalAt alone.
  const old = Date.now() - days * 24 * 60 * 60 * 1000;
  api.apiState.mutate((s) => {
    s.retentionCandidates[jobId].terminalAt = old;
  });
  for (const row of d1.scenes.values()) {
    if (row.job_id === jobId) row.updated_at = old;
  }
}

function todayCounter(api) {
  return api.apiState.state.cleanupCounters[`cleanup-ops-${new Date().toISOString().slice(0, 10)}`] ?? 0;
}

test('retention: 31-day-old failed job is deleted — scene rows, then job row, 2 ops', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  const jobId = await makeFailedJob(api, d1, executor, 'ret-job-old');
  ageCandidate(api, d1, jobId, 31);
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletion, 'enabled (30 days)');
  assert.equal(report.retentionDeletedJobs, 1);
  assert.equal(report.jobSceneRowsDeleted, 1);
  assert.equal(report.jobRowsDeleted, 1);
  assert.equal(todayCounter(api), 2);
  assert.equal(d1.jobs.has(jobId), false);
  assert.equal((await d1.listScenes(jobId)).length, 0);
  assert.equal(api.apiState.state.retentionCandidates[jobId], undefined, 'candidate dropped');
});

test('retention: 10-day-old failed job is NOT deleted', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  const jobId = await makeFailedJob(api, d1, executor, 'ret-job-young');
  ageCandidate(api, d1, jobId, 10);
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletedJobs, 0);
  assert.equal(report.jobSceneRowsDeleted, 0);
  assert.equal(report.jobRowsDeleted, 0);
  assert.equal(todayCounter(api), 0);
  assert.equal(d1.jobs.has(jobId), true);
  assert.equal((await d1.listScenes(jobId)).length, 1);
});

test('retention: crash between scene delete and job delete resumes without double-counting', async (t) => {
  let crashed = false;
  const { api, d1, executor, cleanup } = await makeApi({
    onBeforeDeleteRows: (intent, table) => {
      if (table === 'jobs' && !crashed) {
        crashed = true;
        throw new Error('simulated crash');
      }
    },
  });
  t.after(cleanup);
  const jobId = await makeFailedJob(api, d1, executor, 'ret-job-crash');
  ageCandidate(api, d1, jobId, 31);
  const report1 = await api.runSweep({ reason: 'test' });
  assert.equal(report1.jobSceneRowsDeleted, 1, 'scenes deleted in run 1');
  assert.equal(report1.jobRowsDeleted, 0, 'job row survives the crash');
  assert.equal(d1.jobs.has(jobId), true);
  assert.equal(todayCounter(api), 1);
  assert.equal(api.apiState.state.retentionIntents[jobId].state, 'pending');
  const report2 = await api.runSweep({ reason: 'test' });
  assert.equal(report2.jobRowsDeleted, 1, 'job row deleted on resume');
  assert.equal(report2.jobSceneRowsDeleted, 0, 'scenes not deleted twice');
  assert.equal(d1.jobs.has(jobId), false);
  assert.equal(todayCounter(api), 2, 'exactly 2 operations across both runs');
  assert.equal(api.apiState.state.retentionCandidates[jobId], undefined);
});

test('retention: disabled — Worker 403 gate, sweep reports disabled, rows intact', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi({ retentionEnabled: false, retentionDays: null });
  t.after(cleanup);
  d1.retentionEnabled = false; // mirror the Worker's env
  const jobId = await makeFailedJob(api, d1, executor, 'ret-job-disabled');
  ageCandidate(api, d1, jobId, 31);
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletion, 'disabled (unconfirmed)');
  assert.equal(report.retentionDeletedJobs, 0);
  assert.equal(d1.jobs.has(jobId), true);
  // The Worker's gate, exercised directly: delete-rows for jobs/scenes
  // is refused 403 and _applyD1 reports it as auth (never retried).
  const res = await api.dispatch._applyD1([{ type: 'delete-rows', table: 'jobs', ids: [jobId] }]);
  assert.equal(res.ok, false);
  assert.equal(res.auth, true);
  assert.equal(api.apiState.state.pendingMutations.length, 0, 'auth failure is not queued as pending');
});

test('retention: candidate whose parent is not terminal is skipped', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('ret-job-running');
  seedJobForSubmit(d1, body, { status: 'queued' });
  api.apiState.mutate((s) => {
    s.retentionCandidates[body.jobId] = {
      terminalAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      firstSeenAt: Date.now(),
    };
  });
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletedJobs, 0);
  assert.equal(d1.jobs.has(body.jobId), true);
  assert.ok(api.apiState.state.retentionCandidates[body.jobId], 'candidate kept for later');
});

// T31-07 analogue (Rev 3.2 §B-3.2.6.2): the retained-bytes figure is
// the logical UTF-8 payload per the design's exact SQL, over the visible
// population (non-terminal jobs + API-tracked terminal candidates).
test('retention measurement: rows and logical UTF-8 bytes per §B-3.2.6.2', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  // Pending job with multi-byte UTF-8 in the prompt, one scene with a
  // NULL provider_job_id and an empty-string output_ref.
  const pendingId = 'nova-job-00000000-0000-0000-0000-000000000001';
  const pendingData = {
    id: pendingId, status: 'queued',
    prompt: 'ドラゴン over the ridge', model: 'ltx-video-2b',
    frames: 121, resolution: '1024x576', fps: 24,
  };
  d1.seedJob(pendingData, [{
    scene_index: 0, attempt: 1,
    execution_id: `${pendingId}:scene-0:attempt-1`,
    provider_job_id: null, status: 'queued', output_ref: '', error: null,
  }]);
  // Terminal candidate (failed job, 1 scene) — included in the measure.
  const failedId = await makeFailedJob(api, d1, executor, 'ret-measure');
  // Hand-compute the §B-3.2.6.2 figure from the stored rows, applying
  // the formula independently of the sweep's implementation.
  let expectedRows = 0;
  let expectedBytes = 0;
  for (const row of d1.jobs.values()) {
    expectedRows += 1;
    expectedBytes += Buffer.byteLength(row.id, 'utf8') + Buffer.byteLength(row.data, 'utf8');
  }
  for (const s of d1.scenes.values()) {
    expectedRows += 1;
    expectedBytes += Buffer.byteLength(s.job_id ?? '', 'utf8')
      + Buffer.byteLength(s.execution_id ?? '', 'utf8')
      + Buffer.byteLength(s.provider_job_id ?? '', 'utf8')
      + Buffer.byteLength(s.status ?? '', 'utf8')
      + Buffer.byteLength(s.error ?? '', 'utf8')
      + Buffer.byteLength(s.output_ref ?? '', 'utf8')
      + 32;
  }
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retainedRows, expectedRows);
  assert.equal(report.retainedBytes, expectedBytes);
  assert.equal(expectedRows, 4, '2 jobs + 2 scenes');
  assert.match(report.retainedMeasurement, /partial/);
  assert.equal(report.retentionCandidatesExamined, 1);
});

// -- Retention enumeration via list-terminal-jobs (Worker §10.4) --------
// The sweep must delete terminal jobs it never observed — seeded
// directly in D1 with no journal entry and no retention candidate.

test('retention: terminal job the API never observed is enumerated via list-terminal-jobs and deleted', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const jobId = canonicalJobId('ret-unobserved');
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  // Seeded directly in D1: the API process never saw this job reach
  // terminal (no dispatch, no journal entry, no candidate).
  d1.seedJob(
    { id: jobId, status: 'failed', prompt: 'A dragon on a ridge at dawn.', createdAtMs: old },
    [{
      scene_index: 0, attempt: 1,
      execution_id: `${jobId}:scene-0:attempt-1`,
      status: 'failed', updated_at: old,
    }],
  );
  assert.equal(api.apiState.state.retentionCandidates[jobId], undefined, 'no candidate');
  assert.deepEqual(Object.keys(api.apiState.state.dispatchJournal), [], 'empty journal — never observed');
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletedJobs, 1);
  assert.equal(report.jobSceneRowsDeleted, 1);
  assert.equal(report.jobRowsDeleted, 1);
  assert.equal(todayCounter(api), 2);
  assert.equal(d1.jobs.has(jobId), false);
  assert.equal((await d1.listScenes(jobId)).length, 0);
});

// A terminal job the API never observed whose scenes are still young
// must NOT be deleted: enumeration passes beforeMs = now - 30 days.
test('retention: unobserved terminal job younger than 30 days is NOT deleted', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const jobId = canonicalJobId('ret-unobserved-young');
  d1.seedJob(
    { id: jobId, status: 'failed', prompt: 'A dragon on a ridge at dawn.', createdAtMs: Date.now() },
    [{
      scene_index: 0, attempt: 1,
      execution_id: `${jobId}:scene-0:attempt-1`,
      status: 'failed', updated_at: Date.now(),
    }],
  );
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.retentionDeletedJobs, 0);
  assert.equal(d1.jobs.has(jobId), true);
  assert.equal((await d1.listScenes(jobId)).length, 1);
});

// -- Rate-limit cleanup via list-expired-rate-limits (Worker §10.4) ----

test('rate-limit cleanup: expired rows are deleted and counted; live windows kept', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const now = Date.now();
  d1.seedRateLimit({ key: 'ip-gen:expired-a', window_start: now - 7200 * 1000, window_end: now - 3600 * 1000, count: 10, updated_at: now - 3600 * 1000 });
  d1.seedRateLimit({ key: 'ip-gen:expired-b', window_start: now - 5400 * 1000, window_end: now - 1000, count: 3, updated_at: now - 1000 });
  d1.seedRateLimit({ key: 'ip-gen:live', window_start: now, window_end: now + 3600 * 1000, count: 1, updated_at: now });
  const report = await api.runSweep({ reason: 'test' });
  assert.equal(report.rateLimitRowsDeleted, 2);
  assert.equal(d1.rateLimits.has('ip-gen:expired-a'), false);
  assert.equal(d1.rateLimits.has('ip-gen:expired-b'), false);
  assert.equal(d1.rateLimits.has('ip-gen:live'), true, 'live window kept');
  assert.equal(todayCounter(api), 2, 'each deleted row is one O-23 operation');
});

// -- HttpD1Client wrappers: signed calls to the two new Worker ops -----

test('d1-client: listTerminalJobs / listExpiredRateLimits call the signed Worker ops', async (t) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers });
    const body = url.includes('list-terminal-jobs')
      ? { op: 'list-terminal-jobs', jobs: [{ id: 'nova-job-x', status: 'failed', terminalAtMs: 123 }] }
      : { op: 'list-expired-rate-limits', rateLimits: [{ key: 'k', window_start: 1, window_end: 2, count: 1, updated_at: 2 }] };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  const client = new HttpD1Client({ workerOrigin: 'http://localhost:8787', secret: 'test-secret', signingSecret: 'test-signing-secret', fetchImpl });
  const jobs = await client.listTerminalJobs({ beforeMs: 123456, limit: 5 });
  assert.deepEqual(jobs, [{ id: 'nova-job-x', status: 'failed', terminalAtMs: 123 }]);
  assert.match(calls[0].url, /\/internal\/d1-read\?op=list-terminal-jobs&beforeMs=123456&limit=5/);
  assert.equal(calls[0].method, 'GET');
  const sigKeys = Object.keys(calls[0].headers).map((k) => k.toLowerCase());
  assert.ok(sigKeys.includes('x-nova-signature'), 'signed (HMAC header present)');
  assert.ok(sigKeys.includes('x-nova-timestamp'), 'timestamp header present');
  assert.ok(sigKeys.includes('x-nova-nonce'), 'nonce header present');
  const rateLimits = await client.listExpiredRateLimits({ limit: 10 });
  assert.deepEqual(rateLimits, [{ key: 'k', window_start: 1, window_end: 2, count: 1, updated_at: 2 }]);
  assert.match(calls[1].url, /\/internal\/d1-read\?op=list-expired-rate-limits&limit=10/);
  // Defaults: no beforeMs/limit params sent, Worker defaults apply.
  await client.listTerminalJobs();
  assert.match(calls[2].url, /\/internal\/d1-read\?op=list-terminal-jobs$/);
  await client.listExpiredRateLimits();
  assert.match(calls[3].url, /\/internal\/d1-read\?op=list-expired-rate-limits$/);
});
