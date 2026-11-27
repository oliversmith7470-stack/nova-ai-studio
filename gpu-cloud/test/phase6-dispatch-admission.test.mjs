// Phase 6 Workstream G — dispatch admission.
//
// The dispatch manager derives minVramGb from the measured resource
// profile for the submitted 121-frame config (15.64 GB), so a 16 GB
// provider admits and a 12 GB provider never dispatches. Built the same
// way as src/api-server/test/dispatch.test.mjs, via its support harness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApi, submitBody, seedJobForSubmit, execIdFor } from '../src/api-server/test/support.mjs';

test('121f video submit carries minVramGb 15.64 from the measured profile', async (t) => {
  const { api, d1, cleanup } = await makeApi();
  t.after(cleanup);
  const body = submitBody('phase6-admit-121f');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 202);
  assert.equal(res.body.managerJobIds.length, 1);
  const jobs = api.manager.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, res.body.managerJobIds[0]);
  // (12.64 + 1.92) GiB = 15.64 GB — the measured requirement, not the old 12.
  assert.equal(jobs[0].minVramGb, 15.64);
  assert.equal(jobs[0].params.minVramGb, 15.64);
  assert.equal(jobs[0].modelId, 'ltx-video-2b');
});

test('a 12 GB-only provider never dispatches the 121f job', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  // The only dispatchable provider is now a 12 GB card: the measured
  // 15.64 GB requirement exceeds it, so providerSupports refuses
  // (the O-1 trap — under the old hardcoded 12 it would have admitted
  // and OOMed at the 12.64 GiB decode peak).
  api.manager.registry.get('controlled-test-ltx').vramGb = 12;
  const body = submitBody('phase6-refuse-12gb');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no-capacity');
  // The manager job was created with the measured requirement, but it
  // was never dispatched: still queued, executor never started it.
  const jobs = api.manager.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].minVramGb, 15.64);
  assert.equal(jobs[0].status, 'queued');
  assert.equal(executor.startedJobs.length, 0);
  // The scene was failed in D1 with no-capacity; nothing was placed.
  const scene = (await d1.listScenes(body.jobId))[0];
  assert.equal(scene.status, 'failed');
  assert.equal(scene.error, 'no-capacity');
  const entry = api.dispatch.journalEntry(execIdFor(body));
  assert.equal(entry.state, 'failed');
  assert.equal(entry.error, 'no-capacity');
});

test('a 15 GB-only provider also refuses the 121f job', async (t) => {
  const { api, d1, executor, cleanup } = await makeApi();
  t.after(cleanup);
  api.manager.registry.get('controlled-test-ltx').vramGb = 15;
  const body = submitBody('phase6-refuse-15gb');
  seedJobForSubmit(d1, body);
  const res = await api.dispatch.submitExecutions(body);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no-capacity');
  assert.equal(executor.startedJobs.length, 0);
  assert.equal(api.manager.listJobs()[0].minVramGb, 15.64);
});
