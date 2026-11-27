// NOVA FreeLLMAPI — submit-handler tests (approved v5 design, A5/§7).
//
// POST /internal/submit loads the stored D1 record by body.jobId BEFORE
// validating the body, resolves the effective prompt from the stored
// record (never the body prompt), and refuses credential-pattern
// effective prompts. Plan mode is unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeApi,
  submitBody,
  seedJobForSubmit,
  execIdFor,
} from '../src/api-server/test/support.mjs';

const STORED_PROMPT = 'A dragon on a ridge at dawn, as stored.';
const ENHANCED_PROMPT = 'A grey dragon with ember cracks circles a mountain ridge at dawn, wings spread wide.';

// Seed a D1 record with extra stored fields (e.g. an enhanced prompt) —
// seedJobForSubmit only seeds the plain shape.
function seedStoredJob(d1, body, extra = {}) {
  const data = {
    id: body.jobId,
    mode: body.mode,
    status: 'queued',
    createdAtMs: Date.now(),
    ...(body.mode === 'single' ? { prompt: body.prompt } : { scenes: body.scenes }),
    sceneExecutions: body.sceneExecutions,
    ...extra,
  };
  const rows = body.sceneExecutions.map((x) => ({
    scene_index: x.sceneIndex,
    attempt: x.attempt,
    execution_id: x.executionId,
    status: 'queued',
  }));
  d1.seedJob(data, rows);
  return data;
}

async function submit(api, body) {
  return api.dispatch.submitExecutions(body);
}

test('a missing stored record is 404 and the body prompt never substitutes', async () => {
  const { api, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-missing');
    const res = await submit(api, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
    assert.equal(api.manager.getJobByKey(execIdFor(body)), null);
  } finally {
    await cleanup();
  }
});

test('a mismatched stored record (data.id differs) is 404', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-mismatch');
    const other = submitBody('submit-mismatch-other');
    // Seed a record whose data.id is a DIFFERENT job id.
    seedStoredJob(d1, { ...body, jobId: other.jobId });
    const res = await submit(api, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
  } finally {
    await cleanup();
  }
});

test('an unloadable stored record (data is not JSON) is 404', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-unloadable');
    d1.jobs.set(body.jobId, { id: body.jobId, data: '{not json' });
    const res = await submit(api, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
  } finally {
    await cleanup();
  }
});

test('a D1 lookup failure is 502 d1-unavailable', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-d1-down');
    d1.getJob = async () => { throw new Error('d1 exploded'); };
    const res = await submit(api, body);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'd1-unavailable' });
  } finally {
    await cleanup();
  }
});

test('the D1 lookup runs before body validation: missing record + invalid model is 404, not 400', async () => {
  const { api, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-order');
    body.model = 'not-a-model';
    const res = await submit(api, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
  } finally {
    await cleanup();
  }
});

test('single mode dispatches the STORED prompt, never the body prompt', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-stored-wins');
    seedJobForSubmit(d1, { ...body, prompt: STORED_PROMPT });
    body.prompt = 'A completely different body prompt.';
    const res = await submit(api, body);
    assert.equal(res.status, 202);
    const job = api.manager.getJobByKey(execIdFor(body));
    assert.ok(job);
    assert.equal(job.prompt, STORED_PROMPT);
    assert.equal(job.promptSource, 'user');
  } finally {
    await cleanup();
  }
});

test('plan mode is unchanged: scene prompts come from body.scenes', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-plan', { mode: 'plan', scenes: 2 });
    seedJobForSubmit(d1, body);
    const res = await submit(api, body);
    assert.equal(res.status, 202);
    for (let i = 0; i < 2; i++) {
      const job = api.manager.getJobByKey(execIdFor(body, i));
      assert.ok(job);
      assert.equal(job.prompt, `Scene ${i}.`);
    }
  } finally {
    await cleanup();
  }
});

test('production + a stored enhanced record is refused 400 (resolver throws)', async () => {
  const { api, d1, cleanup } = await makeApi({ mode: 'production', executor: false });
  try {
    const body = submitBody('submit-prod-enhanced');
    seedStoredJob(d1, body, { promptSource: 'enhanced', enhancedPrompt: ENHANCED_PROMPT });
    const res = await submit(api, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid-submit');
    assert.match(res.body.message, /prohibited in production/);
  } finally {
    await cleanup();
  }
});

test('sandbox without authorization + a stored enhanced record is refused 400', async () => {
  const { api, d1, cleanup } = await makeApi({ environment: 'sandbox' });
  try {
    const body = submitBody('submit-sandbox-noauth');
    seedStoredJob(d1, body, { promptSource: 'enhanced', enhancedPrompt: ENHANCED_PROMPT });
    const res = await submit(api, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid-submit');
    assert.match(res.body.message, /not authorized/);
  } finally {
    await cleanup();
  }
});

test('sandbox with authorization + a stored enhanced record dispatches the enhanced prompt', async () => {
  const { api, d1, cleanup } = await makeApi({ environment: 'sandbox' });
  try {
    const body = submitBody('submit-sandbox-auth');
    api.authorizationStore.create({
      jobIds: [body.jobId],
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      projectId: 'nova-ai-studio',
      environmentId: 'nova-api',
      ownerId: 'nova-owner',
    });
    seedStoredJob(d1, body, { promptSource: 'enhanced', enhancedPrompt: ENHANCED_PROMPT });
    const res = await submit(api, body);
    assert.equal(res.status, 202);
    const job = api.manager.getJobByKey(execIdFor(body));
    assert.ok(job);
    assert.equal(job.prompt, ENHANCED_PROMPT);
  } finally {
    await cleanup();
  }
});

test('a credential pattern in the resolved effective prompt is refused 400', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-dataguard');
    seedJobForSubmit(d1, { ...body, prompt: 'Use this key sk-abcdefgh12345678 in the scene.' });
    const res = await submit(api, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid-submit');
    assert.match(res.body.message, /data guard/);
    assert.equal(api.manager.getJobByKey(execIdFor(body)), null);
  } finally {
    await cleanup();
  }
});

test('a credential pattern in the BODY prompt alone does not block the submit (the body prompt is never used)', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-body-ignored');
    seedJobForSubmit(d1, { ...body, prompt: STORED_PROMPT });
    body.prompt = 'Use this key sk-abcdefgh12345678 in the scene.';
    const res = await submit(api, body);
    assert.equal(res.status, 202);
    assert.equal(api.manager.getJobByKey(execIdFor(body)).prompt, STORED_PROMPT);
  } finally {
    await cleanup();
  }
});

test('body validation still runs after the lookup: a bad model is 400', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-bad-model');
    seedJobForSubmit(d1, body);
    body.model = 'not-a-model';
    const res = await submit(api, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid-submit');
  } finally {
    await cleanup();
  }
});

test('a single-mode record without a stored prompt is 404', async () => {
  const { api, d1, cleanup } = await makeApi();
  try {
    const body = submitBody('submit-no-prompt');
    const data = {
      id: body.jobId,
      mode: 'single',
      status: 'queued',
      createdAtMs: Date.now(),
      sceneExecutions: body.sceneExecutions,
    };
    d1.seedJob(data, body.sceneExecutions.map((x) => ({
      scene_index: x.sceneIndex, attempt: x.attempt, execution_id: x.executionId, status: 'queued',
    })));
    const res = await submit(api, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
  } finally {
    await cleanup();
  }
});
