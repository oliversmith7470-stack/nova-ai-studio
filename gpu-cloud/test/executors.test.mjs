// NOVA Personal GPU Cloud — Stage 2: executor contract tests.
//
// Both executors implement the manager's contract (start(job) ->
// Promise<final report>; requestCancel(jobId) -> boolean) and the
// Stage 2 rules: VDP-06 refusal, hours-budget cutoff, honest cancel,
// fileReport for the manual channel, and a simulated Kaggle transport
// for the automated channel. No live GPU is involved anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeCloud,
  connectProvider,
  disableMock,
  submitStage2Job,
  completionReport,
} from './stage2-support.mjs';
import { fileReport } from '../src/setup.js';

// A simulated Kaggle CLI transport: push succeeds, status reports
// 'running' N times then 'complete', output returns the given report.
function simulatedTransport({ runningPolls = 2, report, pushError = null } = {}) {
  let polls = 0;
  return {
    pushes: [],
    push(packageDir) {
      this.pushes.push(packageDir);
      if (pushError) return Promise.resolve({ ok: false, error: pushError });
      return Promise.resolve({ ok: true, kernelId: 'owner/nova-gpu-cloud-test' });
    },
    status() {
      polls += 1;
      return Promise.resolve(
        polls <= runningPolls ? { state: 'running' } : { state: 'complete' },
      );
    },
    output() {
      return Promise.resolve(report);
    },
  };
}

function stage2Job(id = 'job-exec-1') {
  return {
    id,
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a synthetic test dragon flies over a test valley',
    params: { stage2Test: true, testImage: 'synthetic' },
  };
}

test('Kaggle without a transport prepares the package and waits for a report', async (t) => {
  const cloud = makeCloud(t);
  const promise = cloud.kaggle.start(stage2Job());
  // The promise must stay pending (no transport, no report yet).
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'start() must stay pending on the manual channel');
  assert.deepEqual(cloud.kaggle.pendingJobs(), ['job-exec-1']);

  const dir = path.join(cloud.packageDir, 'job-exec-1');
  assert.ok(fs.existsSync(path.join(dir, 'notebook.ipynb')), 'notebook written');
  assert.ok(fs.existsSync(path.join(dir, 'staging-manifest.json')), 'manifest written');
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'instructions written');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'kernel-metadata.json'), 'utf8'));
  assert.equal(meta.enable_gpu, true);
  assert.equal(meta.enable_internet, false);
  assert.equal(meta.code_file, 'notebook.ipynb');
  assert.deepEqual(meta.dataset_sources, ['<kaggle-username>/wan22-ti2v-5b']);
  const submission = cloud.kaggle.submissions.get('job-exec-1');
  assert.equal(submission.channel, 'kaggle-cli-human');
  assert.equal(submission.kernelId, null);

  // Filing the report resolves the promise with the final report.
  const filed = cloud.kaggle.fileReport(completionReport('job-exec-1', 'kaggle-t4'));
  assert.equal(filed.filed, true);
  const report = await promise;
  assert.equal(report.status, 'succeeded');
  assert.equal(report.secondsUsed, 600);
  assert.deepEqual(cloud.kaggle.pendingJobs(), []);
});

test('Colab prepares the package (manual channel only) and waits for a report', async (t) => {
  const cloud = makeCloud(t);
  const promise = cloud.colab.start(stage2Job('job-exec-2'));
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  const dir = path.join(cloud.packageDir, 'job-exec-2');
  assert.ok(fs.existsSync(path.join(dir, 'notebook.ipynb')));
  assert.ok(fs.existsSync(path.join(dir, 'INSTRUCTIONS.md')));
  const instructions = fs.readFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'utf8');
  assert.match(instructions, /NO official API/);
  assert.match(instructions, /KEEP THE BROWSER OPEN/);
  const notebook = fs.readFileSync(path.join(dir, 'notebook.ipynb'), 'utf8');
  assert.match(notebook, /snapshot_download/);
  const submission = cloud.colab.submissions.get('job-exec-2');
  assert.equal(submission.channel, 'human-manual');

  const filed = cloud.colab.fileReport(completionReport('job-exec-2', 'colab-t4'));
  assert.equal(filed.filed, true);
  assert.equal((await promise).status, 'succeeded');
});

test('a simulated Kaggle transport pushes, polls, and completes the job', async (t) => {
  const job = stage2Job('job-exec-3');
  const transport = simulatedTransport({
    runningPolls: 2,
    report: completionReport('job-exec-3', 'kaggle-t4', { secondsUsed: 900 }),
  });
  const cloud = makeCloud(t, { kaggleTransport: transport });
  // Short polls for the test (production default is 60 s).
  cloud.kaggle.pollIntervalMs = 5;
  const report = await cloud.kaggle.start(job);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.secondsUsed, 900);
  assert.equal(transport.pushes.length, 1);
  assert.equal(cloud.kaggle.submissions.get('job-exec-3').channel, 'kaggle-cli');
  assert.equal(cloud.kaggle.submissions.get('job-exec-3').kernelId, 'owner/nova-gpu-cloud-test');
  // Hours were recorded against the weekly budget.
  assert.equal(cloud.hoursTracker.usage('kaggle-t4').hoursUsed, 0.25);
});

test('a failed transport push resolves a failed report (never throws)', async (t) => {
  const transport = simulatedTransport({ pushError: 'kaggle: 401 unauthorized' });
  const cloud = makeCloud(t, { kaggleTransport: transport });
  const report = await cloud.kaggle.start(stage2Job('job-exec-4'));
  assert.equal(report.status, 'failed');
  assert.match(report.error, /kaggle kernels push failed: kaggle: 401 unauthorized/);
});

test('a transport that throws synchronously still resolves a failed report', async (t) => {
  const transport = {
    push() { throw new Error('sync boom'); },
    status() { return Promise.resolve({ state: 'running' }); },
    output() { return Promise.resolve({}); },
  };
  const cloud = makeCloud(t, { kaggleTransport: transport });
  // start() must RESOLVE (not throw) — the latent Stage 1 bug is a sync
  // throw escaping dispatchNext as a JobTransitionError.
  const report = await cloud.kaggle.start(stage2Job('job-exec-5'));
  assert.equal(report.status, 'failed');
  assert.match(report.error, /sync boom/);
});

test('VDP-06: an unmarked job is refused as a failed report', async (t) => {
  const cloud = makeCloud(t);
  const unmarked = {
    id: 'job-exec-6',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a dragon',
    params: {},
  };
  const report = await cloud.kaggle.start(unmarked);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /^data-boundary: /);
  assert.equal(cloud.kaggle.pendingJobs().length, 0);
  assert.ok(!fs.existsSync(path.join(cloud.packageDir, 'job-exec-6')), 'no package for a refused job');
});

test('VDP-06: a job carrying user media is refused by both executors', async (t) => {
  const cloud = makeCloud(t);
  const bad = {
    id: 'job-exec-7',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'animate my photo',
    params: { stage2Test: true, userImage: 'photo.png' },
  };
  for (const ex of [cloud.kaggle, cloud.colab]) {
    const report = await ex.start({ ...bad, id: `job-exec-7-${ex.providerId}` });
    assert.equal(report.status, 'failed');
    assert.match(report.error, /data-boundary: .*userImage/);
  }
});

test('an unknown model is refused as a failed report', async (t) => {
  const cloud = makeCloud(t);
  const report = await cloud.kaggle.start({
    id: 'job-exec-8',
    modelId: 'no-such-model',
    prompt: 'x',
    params: { stage2Test: true },
  });
  assert.equal(report.status, 'failed');
  assert.match(report.error, /no-staging-manifest/);
});

test('the hours budget cuts off dispatch at the executor level', async (t) => {
  const cloud = makeCloud(t);
  cloud.hoursTracker.recordUsage('kaggle-t4', 30 * 3600); // whole week spent
  const report = await cloud.kaggle.start(stage2Job('job-exec-9'));
  assert.equal(report.status, 'failed');
  assert.match(report.error, /hours-budget-exhausted: 30\.00h of 30h/);
});

test('requestCancel returns false for both executors (no cancel channel)', async (t) => {
  const cloud = makeCloud(t);
  const p1 = cloud.kaggle.start(stage2Job('job-exec-10'));
  const p2 = cloud.colab.start(stage2Job('job-exec-11'));
  assert.equal(await cloud.kaggle.requestCancel('job-exec-10'), false);
  assert.equal(await cloud.colab.requestCancel('job-exec-11'), false);
  assert.equal(await cloud.kaggle.requestCancel('unknown-job'), false);
  cloud.kaggle.fileReport(completionReport('job-exec-10', 'kaggle-t4', { status: 'failed', error: 'cancelled-by-human' }));
  cloud.colab.fileReport(completionReport('job-exec-11', 'colab-t4', { status: 'failed', error: 'cancelled-by-human' }));
  await p1;
  await p2;
});

test('cancel through the manager keeps the job running until the report lands (VDP-02)', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'kaggle-t4');
  disableMock(cloud);
  const { job } = submitStage2Job(cloud.manager, 'key-cancel-1');
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.providerId, 'kaggle-t4');
  assert.equal(cloud.manager.getJob(job.id).status, 'running');
  // The executor writes the package asynchronously — wait until the
  // job's start() promise is pending before filing a report.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(cloud.kaggle.pendingJobs(), [job.id]);

  // The owner cancels. No cancel channel exists, so the job keeps
  // running with the request recorded — it is NOT silently cancelled.
  cloud.manager.cancelJob(job.id, 'owner-cancel');
  const running = cloud.manager.getJob(job.id);
  assert.equal(running.status, 'running');
  assert.equal(running.cancellationRequested, true);

  // The run completes anyway; the outcome is preserved as cancelOutcome.
  const { filed, job: final } = await fileReport(
    cloud.manager,
    cloud.kaggle,
    completionReport(job.id, 'kaggle-t4'),
  );
  assert.equal(filed, true);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.cancelOutcome, 'provider-completed');
  assert.equal(final.cost.providerReportedSeconds, 600);
});

test('fileReport for an unknown job is not filed', (t) => {
  const cloud = makeCloud(t);
  const r = cloud.kaggle.fileReport(completionReport('no-such-job', 'kaggle-t4'));
  assert.deepEqual(r, { filed: false, reason: 'no-pending-job' });
});

test('fileReport coerces an invalid report status to failed', async (t) => {
  const cloud = makeCloud(t);
  const promise = cloud.kaggle.start(stage2Job('job-exec-12'));
  await new Promise((r) => setTimeout(r, 10));
  const filed = cloud.kaggle.fileReport({
    jobId: 'job-exec-12',
    providerId: 'kaggle-t4',
    status: 'running', // not a final status — must not finalize as success
    secondsUsed: 10,
    costUsd: 0,
    completedAt: Date.now(),
    resultRef: null,
    error: null,
  });
  assert.equal(filed.filed, true);
  assert.equal(filed.status, 'failed');
  const report = await promise;
  assert.equal(report.status, 'failed');
  assert.match(report.error, /invalid report status "running"/);
});

test('the staging prep test gates dispatch when a local staging dir is supplied', async (t) => {
  // An empty staging dir fails the prep test (files missing).
  const os = await import('node:os');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cloud-staging-'));
  t.after(() => fs.rmSync(stagingDir, { recursive: true, force: true }));
  const cloud = makeCloud(t, { stagingRootDir: stagingDir });
  const report = await cloud.kaggle.start(stage2Job('job-exec-13'));
  assert.equal(report.status, 'failed');
  assert.match(report.error, /staging-prep-failed/);
  assert.match(report.error, /diffusion_pytorch_model-00001-of-00003\.safetensors/);
});
