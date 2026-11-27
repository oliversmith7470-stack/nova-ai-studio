// NOVA Personal GPU Cloud — Stage 2: end-to-end integration tests.
//
// The full manager flow with the Stage 2 executors registered: both real
// providers start not-connected (Part B flips them), a manual Kaggle run
// completes through fileReport, a manual Colab run completes the same
// way, and the weekly budget cutoff works at both the registry level
// (dispatcher stops assigning) and the executor level (refusal).

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('both real providers start not-connected and never receive a job', (t) => {
  const cloud = makeCloud(t);
  const status = Object.fromEntries(
    cloud.manager.providerStatus().map((p) => [p.id, p]),
  );
  assert.equal(status['kaggle-t4'].connected, false);
  assert.equal(status['kaggle-t4'].status, 'not-connected');
  assert.equal(status['kaggle-t4'].dispatchable, false);
  assert.equal(status['colab-t4'].connected, false);
  assert.equal(status['colab-t4'].status, 'not-connected');
  assert.equal(status['colab-t4'].dispatchable, false);
  // The executors ARE registered (the manager can call them) — the
  // registry gate, not a missing executor, is what blocks dispatch.
  assert.ok(cloud.manager.executors.has('kaggle-t4'));
  assert.ok(cloud.manager.executors.has('colab-t4'));
  // A Stage 2 job therefore goes to the mock (the only dispatchable
  // provider that supports the model), never to a real provider.
  const { job } = submitStage2Job(cloud.manager, 'key-int-1');
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.providerId, 'mock-t4');
  void job;
});

test('a manual Kaggle run completes end to end through the manager', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'kaggle-t4');
  disableMock(cloud);
  // Round 2: the job must carry an explicitly personal audience to
  // route to the personal provider and pass the executor's check.
  const { job } = submitStage2Job(cloud.manager, 'key-int-2', { params: { audience: 'personal' } });
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.providerId, 'kaggle-t4');
  assert.equal(cloud.manager.getJob(job.id).status, 'running');
  assert.ok(fs.existsSync(path.join(cloud.packageDir, job.id, 'notebook.ipynb')));
  await sleep(10);

  // The human ran the notebook and files the report.
  const { filed, job: final } = await fileReport(
    cloud.manager,
    cloud.kaggle,
    completionReport(job.id, 'kaggle-t4', { secondsUsed: 1200 }),
  );
  assert.equal(filed, true);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.cost.providerReportedSeconds, 1200);
  assert.equal(final.resultRef, `manual-download:${job.id}.mp4`);
  // 1200 s = 1/3 h recorded against Kaggle's 30 h week.
  assert.equal(cloud.hoursTracker.usage('kaggle-t4').hoursUsed, 1200 / 3600);
});

test('a manual Colab run completes end to end through the manager', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'colab-t4');
  disableMock(cloud);
  const { job } = submitStage2Job(cloud.manager, 'key-int-3');
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.providerId, 'colab-t4');
  await sleep(10);

  // Colab could not offer a GPU — the human reports that honestly.
  const { filed, job: final } = await fileReport(
    cloud.manager,
    cloud.colab,
    completionReport(job.id, 'colab-t4', {
      status: 'failed',
      secondsUsed: 0,
      error: 'colab-gpu-unavailable',
      resultRef: null,
    }),
  );
  assert.equal(filed, true);
  assert.equal(final.status, 'failed');
  assert.equal(final.error, 'colab-gpu-unavailable');
  assert.equal(cloud.hoursTracker.usage('colab-t4').hoursUsed, 0);
});

test('a spent weekly budget stops the dispatcher (registry level)', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'kaggle-t4');
  disableMock(cloud);
  // Spend the whole week via a completed job's accounting.
  cloud.hoursTracker.recordUsage('kaggle-t4', 30 * 3600);
  // The registry flip happens when a completion is recorded; simulate
  // the startup reconciliation that also applies it.
  const { syncBudgetStatus } = await import('../src/hours.js');
  syncBudgetStatus(cloud.registry, cloud.hoursTracker, 'kaggle-t4');
  assert.equal(cloud.registry.dispatchable('kaggle-t4'), false);

  const { job } = submitStage2Job(cloud.manager, 'key-int-4');
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, false);
  assert.equal(dispatched.reason, 'no-provider');
  // The job stays QUEUED (not failed) — the week will roll over.
  assert.equal(cloud.manager.getJob(job.id).status, 'queued');
});

test('a spent budget is refused at the executor level if dispatch happens anyway', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'kaggle-t4');
  disableMock(cloud);
  // Spend the budget WITHOUT flipping the registry (a race the
  // executor's own check must still catch).
  cloud.hoursTracker.recordUsage('kaggle-t4', 30 * 3600);
  // Registry still says available (the flip has not run yet).
  assert.equal(cloud.registry.dispatchable('kaggle-t4'), true);

  const { job } = submitStage2Job(cloud.manager, 'key-int-5', { params: { audience: 'personal' } });
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  // The executor refuses; the manager finalizes the job failed.
  const final = await cloud.manager.waitFor(job.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /hours-budget-exhausted/);
});

test('a refused job (VDP-06) fails through the manager and releases its reservation', async (t) => {
  const cloud = makeCloud(t);
  connectProvider(cloud, 'kaggle-t4');
  disableMock(cloud);
  const { job } = cloud.manager.submit({
    idempotencyKey: 'key-int-6',
    type: 'video',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'animate this photo of me',
    // Round 2: an explicit personal audience routes the job to the
    // personal executor — where the boundary still refuses it (the
    // test's point); a missing audience would never reach it.
    params: { userImage: 'photo.png', audience: 'personal' }, // NOT a Stage 2 synthetic job
  });
  const dispatched = cloud.manager.dispatchNext();
  assert.equal(dispatched.dispatched, true);
  const final = await cloud.manager.waitFor(job.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /data-boundary/);
  // The reservation was released (no committed spend remains).
  assert.equal(cloud.manager.committedUsd(), 0);
  assert.ok(!fs.existsSync(path.join(cloud.packageDir, job.id)), 'no package for a refused job');
});

test('the Stage 2 ceiling stays 0 and paid providers are never dispatched', (t) => {
  const cloud = makeCloud(t);
  assert.equal(cloud.manager.getSpendingCeiling(), 0);
  const status = Object.fromEntries(
    cloud.manager.providerStatus().map((p) => [p.id, p]),
  );
  assert.equal(status['runpod-4090'].dispatchable, false);
});
