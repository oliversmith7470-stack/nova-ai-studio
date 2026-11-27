// NOVA Personal GPU Cloud — Phase 6 Workstream A + C (CPU-side):
// persistent model worker lifecycle tests.
//
// Fake modelRunner + fake clock only. No GPU, no network, no package
// installs, no paid route, no Veo/Flow/Wan. Gate 3 of the Phase 6 design
// (§19): model loads once per lifecycle, warm jobs reuse the loaded
// model, per-job resources are released, failures isolate, load failure
// fails closed, restart reloads + re-verifies, health failures mark the
// worker failed/unavailable, nothing is accepted while starting/
// draining/failed, config mismatches are refused, and no prompt text or
// credential value ever reaches events or error strings.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unlink as fsUnlink } from 'node:fs/promises';
import {
  PersistentWorker,
  PINNED_BASELINE,
} from '../src/phase6/persistent-worker.js';

function makeClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fake modelRunner. Behaviour hooks are assignable after creation:
//   loadBehavior: 'throw' | fn(spec) -> loaded model
//   runBehavior: fn(model, job, ctx) -> { resultRef, measurements }
//   warmupBehavior, healthBehavior: fn -> bool, cancelBehavior: fn -> bool,
//   releaseBehavior: fn(id)
function makeRunner({ clock, behavior = {} } = {}) {
  const calls = {
    load: 0,
    warmup: 0,
    runJob: 0,
    unload: 0,
    healthCheck: 0,
    cancel: 0,
    releaseAllocation: 0,
  };
  const seenModels = [];
  const runner = {
    calls,
    seenModels,
    loadBehavior: behavior.load,
    runBehavior: behavior.runJob,
    warmupBehavior: behavior.warmup,
    healthBehavior: behavior.healthCheck,
    cancelBehavior: behavior.cancel,
    releaseBehavior: behavior.releaseAllocation,
    async load(spec) {
      calls.load += 1;
      if (clock) clock.advance(120);
      if (this.loadBehavior === 'throw') throw new Error('load boom');
      if (typeof this.loadBehavior === 'function') {
        return this.loadBehavior(spec);
      }
      return { checkpointSha256: spec.checkpointSha256, precision: 'fp16' };
    },
    async warmup(model) {
      calls.warmup += 1;
      if (clock) clock.advance(30);
      if (typeof this.warmupBehavior === 'function') {
        return this.warmupBehavior(model);
      }
    },
    async runJob(model, job, ctx) {
      calls.runJob += 1;
      seenModels.push(model);
      if (typeof this.runBehavior === 'function') {
        return this.runBehavior(model, job, ctx);
      }
      return {
        resultRef: `phase6://output/${job.id}`,
        measurements: {
          generationMs: 32600,
          decodeMs: 13100,
          exportMs: 3700,
          peakMemoryGib: 12.64,
        },
      };
    },
    async unload() {
      calls.unload += 1;
    },
    async healthCheck(model) {
      calls.healthCheck += 1;
      if (typeof this.healthBehavior === 'function') {
        return this.healthBehavior(model);
      }
      return true;
    },
    cancel(jobId) {
      calls.cancel += 1;
      if (typeof this.cancelBehavior === 'function') {
        return this.cancelBehavior(jobId);
      }
      return true;
    },
    async releaseAllocation(id) {
      calls.releaseAllocation += 1;
      if (typeof this.releaseBehavior === 'function') {
        return this.releaseBehavior(id);
      }
    },
  };
  return runner;
}

let jobSeq = 0;
function baseJob(over = {}) {
  jobSeq += 1;
  const { params, ...rest } = over;
  return {
    id: `job_test_${jobSeq}`,
    idempotencyKey: `key-${jobSeq}`,
    type: 'video',
    modelId: 'ltx-video-2b',
    prompt: 'a dragon over the sea',
    params: {
      frames: 121,
      width: 1024,
      height: 576,
      steps: 8,
      fps: 24,
      seed: 42,
      guidance: 1.0,
      ...params,
    },
    ...rest,
  };
}

function makeWorker({ runner, clock, flags, modelSpec, unlink } = {}) {
  const c = clock ?? makeClock();
  const r = runner ?? makeRunner({ clock: c });
  const worker = new PersistentWorker({
    providerId: 'phase6-test-ltx',
    modelRunner: r,
    modelSpec: modelSpec ?? { ...PINNED_BASELINE },
    flags: flags ?? {},
    clock: c,
    ...(unlink ? { unlink } : {}),
  });
  return { worker, runner: r, clock: c };
}

async function readyWorker(opts = {}) {
  const s = makeWorker(opts);
  assert.equal(await s.worker.startWorker(), true, 'worker should become ready');
  assert.equal(s.worker.state, 'ready');
  return s;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-worker-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempFile(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'per-job temp data');
  return p;
}

const flush = () => new Promise((r) => setImmediate(r));

test('model loads once per lifecycle across 3 jobs; warm jobs reuse the same loaded model', async () => {
  const { worker, runner } = await readyWorker();
  assert.equal(runner.calls.load, 1);
  assert.equal(runner.calls.warmup, 1);

  const reports = [];
  for (let i = 0; i < 3; i += 1) {
    reports.push(await worker.start(baseJob()));
  }
  for (const report of reports) {
    assert.equal(report.status, 'succeeded');
    assert.match(report.resultRef, /^phase6:\/\/output\//);
    assert.equal(report.providerId, 'phase6-test-ltx');
    assert.equal(report.costUsd, 0);
  }
  assert.equal(runner.calls.load, 1, 'model must not reload per job');
  assert.equal(runner.seenModels.length, 3);
  assert.equal(runner.seenModels[0], runner.seenModels[1]);
  assert.equal(runner.seenModels[1], runner.seenModels[2]);
  assert.equal(worker.jobsCompleted, 3);
  assert.equal(worker.jobsFailed, 0);
  assert.equal(worker.state, 'ready');
});

test('per-job temp files removed on success and allocations released', async (t) => {
  const dir = tempDir(t);
  const { worker, runner } = await readyWorker();
  const fileA = tempFile(dir, 'latents-a.tmp');
  const fileB = tempFile(dir, 'frames-b.tmp');
  runner.runBehavior = async (model, job, ctx) => {
    ctx.registerTempFile(fileA);
    ctx.registerTempFile(fileB);
    ctx.registerAllocation('alloc-1');
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const job = baseJob();
  const report = await worker.start(job);
  assert.equal(report.status, 'succeeded');
  assert.equal(fs.existsSync(fileA), false);
  assert.equal(fs.existsSync(fileB), false);
  assert.equal(runner.calls.releaseAllocation, 1);
  const record = worker.jobRecords.get(job.id);
  assert.deepEqual(record.tempFiles, [fileA, fileB]);
  assert.deepEqual(record.cleanupFailures, []);
  assert.equal(record.status, 'succeeded');
});

test('per-job temp files removed on failure; job failure does not corrupt the next job', async (t) => {
  const dir = tempDir(t);
  const { worker, runner } = await readyWorker();
  const file = tempFile(dir, 'latents-fail.tmp');
  let first = true;
  runner.runBehavior = async (model, job, ctx) => {
    ctx.registerTempFile(file);
    if (first) {
      first = false;
      throw new Error('sampling failed');
    }
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const bad = await worker.start(baseJob());
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /sampling failed/);
  assert.equal(fs.existsSync(file), false, 'temp file removed even on failure');
  assert.equal(worker.state, 'ready', 'worker survives a job failure with a passing health check');
  assert.equal(worker.jobsFailed, 1);

  const good = await worker.start(baseJob());
  assert.equal(good.status, 'succeeded');
  assert.equal(worker.jobsCompleted, 1);
  assert.equal(worker.state, 'ready');
});

test('model-load failure prevents readiness and startJob fails closed', async () => {
  const { worker, runner } = makeWorker();
  runner.loadBehavior = 'throw';
  assert.equal(await worker.startWorker(), false);
  assert.equal(worker.state, 'failed');
  assert.equal(runner.calls.load, 1);
  assert.equal(worker.modelReloadCount, 0);

  // start() never throws: it resolves a failed report.
  const report = await worker.start(baseJob());
  assert.equal(report.status, 'failed');
  assert.match(report.error, /worker-not-ready: failed/);
  assert.equal(runner.calls.runJob, 0, 'no job ran on a failed worker');
  assert.equal(worker.jobsFailed, 0, 'a refused job is not an executed failure');
});

test('restart reloads + re-verifies from scratch (load count increments)', async () => {
  const { worker, runner } = makeWorker();
  runner.loadBehavior = 'throw';
  assert.equal(await worker.startWorker(), false);
  assert.equal(worker.state, 'failed');

  runner.loadBehavior = undefined;
  assert.equal(await worker.startWorker(), true);
  assert.equal(worker.state, 'ready');
  assert.equal(worker.restarts, 1);
  assert.equal(runner.calls.load, 2, 'restart reloads the model');
  assert.equal(worker.modelReloadCount, 1);
  assert.equal(worker.modelLoadCount, 2);

  const report = await worker.start(baseJob());
  assert.equal(report.status, 'succeeded');
  assert.equal(runner.calls.load, 2, 'warm job does not reload');
});

test('checkpoint sha and dtype are verified at load, never re-hashed per job', async () => {
  const badSha = makeWorker();
  badSha.runner.loadBehavior = async (spec) => ({
    checkpointSha256: 'deadbeef',
    precision: 'fp16',
  });
  assert.equal(await badSha.worker.startWorker(), false);
  assert.equal(badSha.worker.state, 'failed');

  const badDtype = makeWorker();
  badDtype.runner.loadBehavior = async (spec) => ({
    checkpointSha256: spec.checkpointSha256,
    precision: 'bf16',
  });
  assert.equal(await badDtype.worker.startWorker(), false);
  assert.equal(badDtype.worker.state, 'failed');

  // The good path: load is called exactly once across jobs (no re-hash).
  const { worker, runner } = await readyWorker();
  await worker.start(baseJob());
  await worker.start(baseJob());
  assert.equal(runner.calls.load, 1);
});

test('health becomes failed on a failed check; unavailable before start and after stop', async () => {
  const { worker, runner } = makeWorker();
  assert.equal(worker.state, 'unavailable');
  assert.equal(await worker.runHealthCheck(), false, 'no check passes before start');

  assert.equal(await worker.startWorker(), true);
  runner.healthBehavior = () => false;
  assert.equal(await worker.runHealthCheck(), false);
  assert.equal(worker.state, 'failed');
  assert.equal(runner.calls.unload, 1, 'suspect model is unloaded');

  runner.healthBehavior = () => true;
  assert.equal(await worker.startWorker(), true);
  assert.equal(await worker.stopWorker(), true);
  assert.equal(worker.state, 'unavailable');
  assert.equal(runner.calls.unload, 2);
});

test('no job accepted while starting', async () => {
  const { worker, runner } = makeWorker();
  const gate = deferred();
  runner.loadBehavior = async (spec) => {
    await gate.promise;
    return { checkpointSha256: spec.checkpointSha256, precision: 'fp16' };
  };
  const starting = worker.startWorker();
  assert.equal(worker.state, 'starting');
  const report = await worker.start(baseJob());
  assert.equal(report.status, 'failed');
  assert.match(report.error, /worker-not-ready: starting/);
  gate.resolve();
  assert.equal(await starting, true);
  assert.equal(worker.state, 'ready');
});

test('drain finishes the in-flight job, accepts nothing new, and resumes on startWorker', async () => {
  const { worker, runner } = await readyWorker();
  const gate = deferred();
  runner.runBehavior = async (model, job, ctx) => {
    await gate.promise;
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const first = worker.start(baseJob());
  assert.equal(worker.state, 'busy');
  assert.equal(worker.drain(), true);
  assert.equal(worker.state, 'draining');

  const refused = await worker.start(baseJob());
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /worker-not-ready: draining/);

  gate.resolve();
  const report = await first;
  assert.equal(report.status, 'succeeded');
  assert.equal(worker.state, 'draining', 'drained worker stays drained after the job');
  assert.equal(await worker.startWorker(), true, 'startWorker resumes a drained worker');
  assert.equal(worker.state, 'ready');
  assert.equal(runner.calls.load, 1, 'resume does not reload the model');
});

test('no job accepted while failed; stopWorker unloads and refuses new jobs', async () => {
  const { worker, runner } = await readyWorker();
  assert.equal(await worker.stopWorker(), true);
  assert.equal(worker.state, 'unavailable');
  assert.equal(runner.calls.unload, 1);
  const refused = await worker.start(baseJob());
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /worker-not-ready: unavailable/);

  // A start after stop is a fresh load, not a failure restart.
  assert.equal(await worker.startWorker(), true);
  assert.equal(runner.calls.load, 2);
  assert.equal(worker.modelReloadCount, 1);
  assert.equal(worker.restarts, 0);
});

test('config mismatch is refused, never silently run', async () => {
  const { worker, runner } = await readyWorker();
  const cases = [
    [{ modelId: 'wan2.1-1.3b' }, /model "wan2\.1-1\.3b" != pinned "ltx-video-2b"/],
    [{ params: { frames: 49 } }, /frames 49 != pinned 121/],
    [{ params: { width: 512, height: 288 } }, /width 512 != pinned 1024/],
    [{ params: { resolution: '512x288' } }, /resolution "512x288" != pinned "1024x576"/],
    [{ params: { steps: 4 } }, /steps 4 != pinned 8/],
    [{ params: { fps: 30 } }, /fps 30 != pinned 24/],
    [{ params: { seed: 7 } }, /seed 7 != pinned 42/],
    [{ params: { guidance: 2.5 } }, /guidance 2\.5 != pinned 1/],
    [{ params: { precision: 'bf16' } }, /precision "bf16" != pinned "fp16"/],
  ];
  for (const [over, pattern] of cases) {
    const report = await worker.start(baseJob(over));
    assert.equal(report.status, 'failed');
    assert.match(report.error, /config-mismatch/);
    assert.match(report.error, pattern);
  }
  assert.equal(runner.calls.runJob, 0, 'no mismatched job ever ran');
  assert.equal(worker.jobsFailed, 0, 'refusals are not executed failures');
  assert.equal(worker.state, 'ready', 'refusals leave the worker ready');
});

test('no prompt text and no credential values in events or error strings', async () => {
  const { worker, runner } = await readyWorker();
  const prompt = 'SECRET-PROMPT-DRAGON-9f3a7';
  runner.runBehavior = async () => {
    throw new Error(`boom for ${prompt} api_key=sk-live-XYZ123 token=tok-abc password=hunter2`);
  };
  const job = baseJob({ prompt });
  const report = await worker.start(job);
  assert.equal(report.status, 'failed');
  assert.equal(report.error.includes(prompt), false, 'prompt must not leak into the error');
  assert.equal(report.error.includes('sk-live-XYZ123'), false);
  assert.equal(report.error.includes('tok-abc'), false);
  assert.equal(report.error.includes('hunter2'), false);
  assert.match(report.error, /api_key=\[redacted\]/);
  const eventsJson = JSON.stringify(worker.events);
  assert.equal(eventsJson.includes(prompt), false, 'prompt must not leak into events');
  assert.equal(eventsJson.includes('sk-live-XYZ123'), false);
  for (const event of worker.events) {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'event', 'jobId']);
  }
  const record = worker.jobRecords.get(job.id);
  assert.equal(record.error.includes(prompt), false);
});

test('cancel records the request and returns honestly', async () => {
  // No cancel mechanism on the runner: honest false.
  const noCancel = await readyWorker();
  delete noCancel.runner.cancel;
  assert.equal(noCancel.worker.requestCancel('job_unknown'), false);
  assert.ok(noCancel.worker.cancelRequests.has('job_unknown'));

  // In-flight job with a runner cancel: the runner's answer is returned.
  const { worker, runner } = await readyWorker();
  const gate = deferred();
  runner.runBehavior = async (model, job, ctx) => {
    await gate.promise;
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const job = baseJob();
  const running = worker.start(job);
  assert.equal(worker.requestCancel(job.id), true);
  assert.ok(worker.cancelRequests.has(job.id));
  assert.equal(worker.activeContexts.get(job.id).isCancelled(), true);
  gate.resolve();
  const report = await running;
  assert.equal(report.status, 'succeeded', 'a completed run keeps its outcome (VDP-02)');

  // A runner cancel that refuses returns false honestly.
  runner.cancelBehavior = () => false;
  const gate2 = deferred();
  runner.runBehavior = async (model, j, ctx) => {
    await gate2.promise;
    return { resultRef: `phase6://output/${j.id}`, measurements: null };
  };
  const job2 = baseJob();
  const running2 = worker.start(job2);
  assert.equal(worker.requestCancel(job2.id), false);
  gate2.resolve();
  await running2;
});

test('fileReport and reportFailure resolve pending promises correctly', async () => {
  const { worker, runner } = await readyWorker();
  const gate = deferred();
  runner.runBehavior = async (model, job, ctx) => {
    await gate.promise;
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };

  const job1 = baseJob();
  const pending1 = worker.start(job1);
  const filed = worker.fileReport({
    jobId: job1.id,
    status: 'succeeded',
    resultRef: 'phase6://filed/1',
  });
  assert.deepEqual(filed, { filed: true, jobId: job1.id, status: 'succeeded' });
  const report1 = await pending1;
  assert.equal(report1.status, 'succeeded');
  assert.equal(report1.resultRef, 'phase6://filed/1');
  assert.deepEqual(worker.lastReport(job1.id), report1);
  gate.resolve();
  await flush();
  assert.equal(worker.state, 'ready', 'the filed job still cleans up and frees the worker');

  const gate2 = deferred();
  runner.runBehavior = async (model, job, ctx) => {
    await gate2.promise;
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const job2 = baseJob();
  const pending2 = worker.start(job2);
  assert.equal(worker.reportFailure(job2.id, 'operator aborted'), true);
  const report2 = await pending2;
  assert.equal(report2.status, 'failed');
  assert.equal(report2.error, 'operator aborted');
  gate2.resolve();
  await flush();
  assert.equal(worker.state, 'ready');

  assert.equal(worker.reportFailure('job_nope', 'x'), false);
  assert.deepEqual(worker.fileReport({ jobId: 'job_nope', status: 'succeeded' }), {
    filed: false,
    reason: 'no-pending-job',
  });
  assert.equal(worker.lastReport('job_nope'), null);
});

test('getExecutionState covers accepted/running/completed/failed/never-received', async () => {
  const { worker, runner } = await readyWorker();
  assert.deepEqual(worker.getExecutionState('exec_nope'), {
    state: 'never-received',
    evidence: { raw: null },
  });
  const gate = deferred();
  runner.runBehavior = async (model, job, ctx) => {
    await gate.promise;
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const job = baseJob();
  const running = worker.start(job);
  assert.equal(worker.getExecutionState(job.idempotencyKey).state, 'running');
  gate.resolve();
  const report = await running;
  assert.equal(report.status, 'succeeded');
  assert.equal(worker.getExecutionState(job.idempotencyKey).state, 'completed');

  runner.runBehavior = async () => {
    throw new Error('decode failed');
  };
  const bad = baseJob();
  const failed = await worker.start(bad);
  assert.equal(failed.status, 'failed');
  assert.equal(worker.getExecutionState(bad.idempotencyKey).state, 'failed');
});

test('cuda-oom / cuda-corrupt mark the worker failed; a failing post-job health check does too', async () => {
  for (const code of ['cuda-oom', 'cuda-corrupt']) {
    const { worker, runner } = await readyWorker();
    const err = new Error(`GPU blew up (${code})`);
    err.code = code;
    runner.runBehavior = async () => {
      throw err;
    };
    const report = await worker.start(baseJob());
    assert.equal(report.status, 'failed');
    assert.match(report.error, new RegExp(`^${code}:`));
    assert.equal(worker.state, 'failed', `${code} must not be assumed repairable`);
    assert.equal(runner.calls.unload, 1);
    const refused = await worker.start(baseJob());
    assert.match(refused.error, /worker-not-ready: failed/);
  }

  const { worker, runner } = await readyWorker();
  runner.healthBehavior = () => false;
  runner.runBehavior = async () => {
    throw new Error('ordinary job failure');
  };
  await worker.start(baseJob());
  assert.equal(worker.state, 'failed', 'a failed post-job health check fails the worker');
});

test('job-end audit lists release failures, never silent', async (t) => {
  const dir = tempDir(t);
  const good = tempFile(dir, 'good.tmp');
  const bad = tempFile(dir, 'bad.tmp');
  const failingUnlink = async (p) => {
    if (p.endsWith('bad.tmp')) throw new Error('unlink boom');
    return fsUnlink(p);
  };
  const { worker, runner } = await readyWorker({ unlink: failingUnlink });
  runner.releaseBehavior = async (id) => {
    if (id === 'alloc-bad') throw new Error('release boom');
  };
  runner.runBehavior = async (model, job, ctx) => {
    ctx.registerTempFile(good);
    ctx.registerTempFile(bad);
    ctx.registerAllocation('alloc-ok');
    ctx.registerAllocation('alloc-bad');
    return { resultRef: `phase6://output/${job.id}`, measurements: null };
  };
  const job = baseJob();
  const report = await worker.start(job);
  assert.equal(report.status, 'succeeded');
  assert.equal(fs.existsSync(good), false);
  assert.equal(fs.existsSync(bad), true, 'the failed unlink leaves the file (audited, not hidden)');
  const record = worker.jobRecords.get(job.id);
  assert.equal(record.cleanupFailures.length, 2);
  assert.deepEqual(
    record.cleanupFailures.map((f) => f.kind).sort(),
    ['allocation', 'temp-file'],
  );
  assert.ok(worker.events.some((e) => e.event === 'job-cleanup-failed'));
  assert.equal(worker.state, 'ready');
});

test('metrics counters are accurate; no invented measurements', async () => {
  const { worker, runner } = await readyWorker();
  // Fake clock advanced 120ms on load + 30ms on warm-up.
  assert.equal(worker.modelLoadMs, 120);
  assert.equal(worker.warmupMs, 30);
  assert.equal(worker.processStartToReadyMs, 150);
  assert.equal(worker.modelLoadCount, 1);
  assert.equal(worker.modelReloadCount, 0);
  assert.equal(worker.restarts, 0);
  assert.equal(worker.peakMemoryGib, null, 'no peak reported yet');

  await worker.start(baseJob());
  await worker.start(baseJob());
  runner.runBehavior = async () => {
    throw new Error('job failed');
  };
  await worker.start(baseJob());
  assert.equal(worker.jobsCompleted, 2);
  assert.equal(worker.jobsFailed, 1);
  assert.equal(worker.peakMemoryGib, 12.64);
  assert.deepEqual(worker.lastJobTimings, {
    generationMs: null,
    decodeMs: null,
    exportMs: null,
  }, 'a failed job reports no timings');

  runner.runBehavior = undefined;
  await worker.start(baseJob());
  assert.deepEqual(worker.lastJobTimings, {
    generationMs: 32600,
    decodeMs: 13100,
    exportMs: 3700,
  });

  // A runner that reports no measurements leaves timings null.
  runner.runBehavior = async (model, job, ctx) => ({
    resultRef: `phase6://output/${job.id}`,
  });
  const job = baseJob();
  await worker.start(job);
  const record = worker.jobRecords.get(job.id);
  assert.equal(record.generationMs, null);
  assert.equal(record.decodeMs, null);
  assert.equal(record.exportMs, null);
  assert.equal(record.peakMemoryGib, null);
});

test('flags disable the worker; constructor rejects credential fields', async () => {
  const disabled = makeWorker({ flags: { persistentWorker: false } });
  assert.equal(await disabled.worker.startWorker(), false);
  assert.equal(disabled.worker.state, 'unavailable');

  const disabled2 = makeWorker({ flags: { persistentWorkerEnabled: false } });
  assert.equal(await disabled2.worker.startWorker(), false);
  assert.equal(disabled2.worker.state, 'unavailable');

  const runner = makeRunner({});
  assert.throws(
    () => new PersistentWorker({ providerId: 'x', modelRunner: runner, apiKey: 'sk-x' }),
    /credential field "apiKey"/,
  );
  assert.throws(
    () =>
      new PersistentWorker({
        providerId: 'x',
        modelRunner: runner,
        modelSpec: { ...PINNED_BASELINE, token: 't' },
      }),
    /credential field "token"/,
  );
  assert.throws(
    () => new PersistentWorker({ providerId: 'x', modelRunner: {} }),
    /modelRunner\.load/,
  );
  assert.throws(
    () => new PersistentWorker({ modelRunner: runner }),
    /requires providerId/,
  );
});

test('start() never throws and startJob is the same entry point', async () => {
  const { worker } = makeWorker();
  // Unstarted worker: start() resolves a failed report, it does not throw.
  await assert.doesNotReject(worker.start(baseJob()));
  const refused = await worker.start(baseJob());
  assert.equal(refused.status, 'failed');

  assert.equal(await worker.startWorker(), true);
  const viaAlias = await worker.startJob(baseJob());
  assert.equal(viaAlias.status, 'succeeded');
  const viaStart = await worker.start(baseJob());
  assert.equal(viaStart.status, 'succeeded');
});
