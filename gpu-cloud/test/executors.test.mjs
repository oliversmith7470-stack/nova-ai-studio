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
  tempDir,
  makeCloud,
  connectProvider,
  disableMock,
  submitStage2Job,
  completionReport,
} from './stage2-support.mjs';
import { fileReport } from '../src/setup.js';
import { KaggleExecutor } from '../src/kaggle-executor.js';
import { BaseExecutor } from '../src/executor-base.js';
import { getStagingManifest } from '../src/staging.js';

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
    // Round 2: a job reaching the Kaggle executor must carry an
    // EXPLICIT audience — a missing audience is refused with
    // audience-mismatch before any other check.
    params: { stage2Test: true, testImage: 'synthetic', audience: 'personal' },
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
    // Round 2: an explicit personal audience, so the job passes the
    // audience check and reaches the manifest check it is testing.
    params: { stage2Test: true, audience: 'personal' },
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
  // Round 2: an explicit personal audience routes the job to the
  // personal provider.
  const { job } = submitStage2Job(cloud.manager, 'key-cancel-1', { params: { audience: 'personal' } });
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

// -- Audience enforcement, M2-P round 2 (reviewer-prescribed strict check) --
// The Kaggle executor serves the personal audience exclusively. At the
// executor layer (_start) only an explicitly personal audience proceeds;
// at the transport layer (submit) the same rule applies. A missing,
// unknown, or mismatched audience refuses with audience-mismatch — no
// execution, no reservation, no package. The jobs below carry the
// stage2Test marker so the VDP-06 boundary passes and the audience
// check is what is exercised.

function audienceJob(audience, id = 'job-aud-1') {
  const params = { stage2Test: true, testImage: 'synthetic' };
  if (audience !== undefined) params.audience = audience;
  return {
    id,
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a synthetic test dragon flies over a test valley',
    params,
  };
}

test('executor layer: public / missing / unknown audiences refuse with audience-mismatch', async (t) => {
  const cloud = makeCloud(t);
  for (const [label, audience, received] of [
    ['public', 'public', 'public'],
    ['missing', undefined, 'missing'],
    ['unknown', 'owner', 'owner'],
  ]) {
    const report = await cloud.kaggle.start(audienceJob(audience, `job-aud-${label}`));
    assert.equal(report.status, 'failed', label);
    assert.match(
      report.error,
      new RegExp(`^audience-mismatch: executor requires personal, received ${received}$`),
      label,
    );
  }
});

test('executor layer: an explicitly personal audience proceeds past the audience check', async (t) => {
  const cloud = makeCloud(t);
  const job = audienceJob('personal', 'job-aud-personal');
  const promise = cloud.kaggle.start(job);
  // The promise must stay pending (no transport, no report yet) — it
  // does NOT resolve to a failed report — and the package must have
  // been written, proving the job passed the audience check into submit.
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false);
  assert.ok(fs.existsSync(path.join(cloud.packageDir, job.id, 'notebook.ipynb')));
});

test('transport layer: KaggleExecutor.submit accepts only personal; public / missing / unknown throw audience-mismatch', async (t) => {
  const dir = tempDir(t);
  const executor = new KaggleExecutor({ packageDir: path.join(dir, 'packages') });
  assert.equal(executor.audience, 'personal');
  const manifest = getStagingManifest('wan2.2-ti2v-5b');
  const out = await executor.submit(audienceJob('personal', 'job-sub-personal'), manifest);
  assert.equal(out.channel, 'kaggle-cli-human');
  for (const audience of ['public', undefined, 'owner']) {
    const job = audienceJob(audience, `job-sub-${audience ?? 'missing'}`);
    await assert.rejects(
      () => executor.submit(job, manifest),
      /audience-mismatch: Kaggle transport requires personal audience/,
      `audience ${audience ?? 'missing'} should throw`,
    );
  }
});

test('audience-agnostic executors (this.audience null) keep no audience check — the controlled-test path is retained', async (t) => {
  const dir = tempDir(t);
  let submitted = false;
  class AgnosticExecutor extends BaseExecutor {
    constructor(opts) { super({ providerId: 'test-agnostic', ...opts }); }
    async submit() {
      submitted = true;
      return { channel: 'test-agnostic', packageDir: path.join(this.packageDir, 'x') };
    }
  }
  const executor = new AgnosticExecutor({ packageDir: path.join(dir, 'packages') });
  assert.equal(executor.audience, null);
  // A public-audience stage2Test job reaches submit: the null-audience
  // executor performs no audience check.
  const promise = executor.start(audienceJob('public', 'job-agnostic'));
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(submitted, true);
  assert.equal(settled, false);
});
