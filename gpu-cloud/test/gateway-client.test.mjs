// NOVA FreeLLMAPI — gateway client unit tests (approved v5 design, A3/A4/§7).
//
// The client is exercised against a stub HTTP server on 127.0.0.1, never
// the live gateway: success and failure shapes, the 1 MiB streaming cap,
// the 30 s timeout, the never-follow redirect rule, loopback + allowlist
// enforcement, and the readiness + override evaluation shared spec. No
// credential or prompt fragment may appear in any thrown error.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createGatewayClient,
  checkGatewayReadiness,
  evaluateUnifyOverrides,
  GatewayEnhancementError,
  GatewayConfigError,
  APPROVED_TEXT_MODELS,
} from '../src/gateway-client.js';

const API_KEY = 'test-gateway-key';
const PROMPT = 'A dragon on a ridge at dawn.';
const GOOGLE_PIN = 'google:gemini-3.5-flash-lite';
const GROQ_PIN = 'groq:qwen/qwen3.8-27b';
// X-Routed-Via uses the platform/model SLASH form, not the colon pin.
const GOOGLE_ROUTED = 'google/gemini-3.5-flash-lite';
const GROQ_ROUTED = 'groq/qwen/qwen3.8-27b';

function chatBody({ content = 'Enhanced prompt text.', model = 'gemini-3.5-flash-lite', routedVia = GOOGLE_ROUTED } = {}) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

// A stub gateway: records every request; the handler decides the response.
async function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, requests.length, requests[requests.length - 1]);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function okJson(res, body, { status = 200, routedVia = GOOGLE_ROUTED } = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Routed-Via': routedVia });
  res.end(body);
}

test('success returns content, reported model and the verified routed-via', async () => {
  const stub = await startStub((req, res) => okJson(res, chatBody()));
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    const result = await client.enhance(PROMPT);
    assert.equal(result.content, 'Enhanced prompt text.');
    assert.equal(result.reportedModel, 'gemini-3.5-flash-lite');
    assert.equal(result.routedVia, GOOGLE_ROUTED);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    const body = JSON.parse(req.body);
    assert.equal(body.model, GOOGLE_PIN);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(body.messages[0].content.includes(PROMPT));
    assert.ok(body.messages[0].content.includes('Rewrite the following video generation prompt'));
  } finally {
    await stub.close();
  }
});

test('success without a usage field still returns content', async () => {
  const stub = await startStub((req, res) => {
    const body = JSON.parse(chatBody());
    delete body.usage;
    okJson(res, JSON.stringify(body));
  });
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    const result = await client.enhance(PROMPT);
    assert.equal(result.content, 'Enhanced prompt text.');
    assert.equal(result.routedVia, GOOGLE_ROUTED);
  } finally {
    await stub.close();
  }
});

test('empty content throws and makes no second request', async () => {
  const stub = await startStub((req, res) => okJson(res, chatBody({ content: '' })));
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /no content/);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test('429, 401 and 500 throw without retrying', async () => {
  for (const status of [429, 401, 500]) {
    const stub = await startStub((req, res) => okJson(res, 'error', { status }));
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
      await assert.rejects(() => client.enhance(PROMPT), /gateway enhancement failed/);
      assert.equal(stub.requests.length, 1, `status ${status} must not retry`);
    } finally {
      await stub.close();
    }
  }
});

test('connection refused throws without a credential or prompt in the error', async () => {
  const stub = await startStub((req, res) => okJson(res, chatBody()));
  const deadUrl = stub.baseUrl;
  await stub.close();
  const client = createGatewayClient({ baseUrl: deadUrl, apiKey: API_KEY, model: GOOGLE_PIN });
  let caught = null;
  try {
    await client.enhance(PROMPT);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GatewayEnhancementError);
  assert.ok(!caught.message.includes(API_KEY), 'error must not contain the API key');
  assert.ok(!caught.message.includes(PROMPT), 'error must not contain the prompt');
});

test('malformed JSON throws', async () => {
  const stub = await startStub((req, res) => okJson(res, '{not json'));
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /not JSON/);
  } finally {
    await stub.close();
  }
});

test('malformed response shapes throw', async () => {
  const shapes = [
    JSON.stringify({}),
    JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{ message: {} }] }),
    JSON.stringify({ choices: [{ message: { content: 42 } }] }),
    // Note: whitespace-only content is a non-empty string and is accepted
    // by the client's contract (non-empty, not non-blank).
  ];
  for (const body of shapes) {
    const stub = await startStub((req, res) => okJson(res, body));
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
      await assert.rejects(() => client.enhance(PROMPT), GatewayEnhancementError);
    } finally {
      await stub.close();
    }
  }
});

test('a hanging gateway times out (no indefinite wait)', async () => {
  const stub = await startStub(() => {
    // Never respond.
  });
  try {
    // 500 ms, not 50: under the full parallel suite the event loop can be
    // busy enough that a 50 ms budget fires before the stub even registers
    // the request (the rejection itself passed; only the request count
    // failed). 500 ms still proves the client never waits indefinitely.
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN, timeoutMs: 500 });
    await assert.rejects(() => client.enhance(PROMPT), /timed out/);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test('a 3xx redirect is never followed', async () => {
  let secondHit = 0;
  const stub = await startStub((req, res, count) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    } else {
      secondHit += 1;
      okJson(res, chatBody());
    }
  });
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /redirect/);
    assert.equal(secondHit, 0, 'the redirect target must never be fetched');
  } finally {
    await stub.close();
  }
});

test('a response over 1 MiB is rejected while streaming', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': GOOGLE_PIN });
    // 2 MiB of payload in chunks; the client must abort before consuming it all.
    const chunk = Buffer.alloc(64 * 1024, 'x');
    for (let i = 0; i < 32; i++) res.write(chunk);
    res.end();
  });
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /exceeds size limit/);
  } finally {
    await stub.close();
  }
});

test('a mismatched X-Routed-Via discards the response', async () => {
  const stub = await startStub((req, res) => okJson(res, chatBody(), { routedVia: GROQ_ROUTED }));
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /upstream unverified/);
  } finally {
    await stub.close();
  }
});

test('a missing X-Routed-Via discards the response', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatBody());
  });
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance(PROMPT), /upstream unverified/);
  } finally {
    await stub.close();
  }
});

test('factory: no API key returns null (client disabled)', () => {
  assert.equal(createGatewayClient({ baseUrl: 'http://127.0.0.1:3001', apiKey: '' }), null);
  assert.equal(createGatewayClient({ baseUrl: 'http://127.0.0.1:3001' }), null);
});

test('factory: loopback enforcement rejects localhost and non-loopback', () => {
  for (const baseUrl of [
    'http://localhost:3001',
    'https://example.com',
    'http://192.168.1.10:3001',
    'http://10.0.0.5:3001',
    'not-a-url',
    'ftp://127.0.0.1:3001',
  ]) {
    assert.throws(() => createGatewayClient({ baseUrl, apiKey: API_KEY }), GatewayConfigError, baseUrl);
  }
  // Literal loopback IPs are accepted (the factory does not connect).
  assert.ok(createGatewayClient({ baseUrl: 'http://127.0.0.1:3001', apiKey: API_KEY }));
  assert.ok(createGatewayClient({ baseUrl: 'http://[::1]:3001', apiKey: API_KEY }));
});

test('factory: only the approved colon-form pins are allowlisted', () => {
  for (const model of ['auto', 'gemini-3.5-flash-lite', 'google:gemini-3.5-flash', 'groq:llama-3.1-8b', 'openai:gpt-4o', '']) {
    assert.throws(() => createGatewayClient({ baseUrl: 'http://127.0.0.1:3001', apiKey: API_KEY, model }), GatewayConfigError, model);
  }
  assert.deepEqual([...APPROVED_TEXT_MODELS], [GOOGLE_PIN, GROQ_PIN]);
  assert.ok(createGatewayClient({ baseUrl: 'http://127.0.0.1:3001', apiKey: API_KEY, model: GROQ_PIN }));
});

test('readiness: both pins answering is ready; a failing pin is not', async () => {
  const good = await startStub((req, res, count, record) => {
    const body = JSON.parse(record.body ?? '{}');
    if (body.model === GOOGLE_PIN) {
      okJson(res, JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'mango' } }],
        model: 'gemini-3.5-flash-lite',
      }), { routedVia: GOOGLE_ROUTED });
    } else {
      okJson(res, JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'mango' } }],
        model: 'qwen/qwen3.8-27b',
      }), { routedVia: GROQ_ROUTED });
    }
  });
  try {
    const ready = await checkGatewayReadiness({ baseUrl: good.baseUrl, apiKey: API_KEY });
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.checks.map((c) => c.name), [
      `chat:${GOOGLE_PIN}`, `chat:${GROQ_PIN}`, 'unify-overrides',
    ]);
    // The readiness probes use max_tokens 10 and the tiny probe prompt.
    assert.equal(good.requests.length, 2);
    for (const req of good.requests) {
      const body = JSON.parse(req.body);
      assert.equal(body.max_tokens, 10);
      assert.equal(body.messages[0].content, 'Say the word mango and nothing else.');
    }
  } finally {
    await good.close();
  }

  const bad = await startStub((req, res, count, record) => {
    const body = JSON.parse(record.body ?? '{}');
    if (body.model === GOOGLE_PIN) {
      okJson(res, JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'mango' } }],
        model: 'gemini-3.5-flash-lite',
      }), { routedVia: GOOGLE_ROUTED });
    } else {
      okJson(res, 'unavailable', { status: 503 });
    }
  });
  try {
    const notReady = await checkGatewayReadiness({ baseUrl: bad.baseUrl, apiKey: API_KEY });
    assert.equal(notReady.ok, false);
    const groqCheck = notReady.checks.find((c) => c.name === `chat:${GROQ_PIN}`);
    assert.equal(groqCheck.ok, false);
    // A 503 on one pin produces no second request for that pin.
    assert.equal(bad.requests.filter((r) => JSON.parse(r.body).model === GROQ_PIN).length, 1);
  } finally {
    await bad.close();
  }
});

test('readiness: a gateway that 401s without a key is not ready', async () => {
  const stub = await startStub((req, res, count, record) => {
    if (record.headers.authorization !== `Bearer ${API_KEY}`) {
      okJson(res, 'unauthorized', { status: 401 });
      return;
    }
    const body = JSON.parse(record.body ?? '{}');
    okJson(res, JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'mango' } }],
      model: body.model === GOOGLE_PIN ? 'gemini-3.5-flash-lite' : 'qwen/qwen3.8-27b',
    }), { routedVia: body.model === GOOGLE_PIN ? GOOGLE_ROUTED : GROQ_ROUTED });
  });
  try {
    const result = await checkGatewayReadiness({ baseUrl: stub.baseUrl, apiKey: '' });
    assert.equal(result.ok, false);
    assert.equal(result.checks[0].name, `chat:${GOOGLE_PIN}`);
    assert.equal(result.checks[0].reason, 'http-401');
  } finally {
    await stub.close();
  }
});

test('override evaluation: absent is fine; valid merges/splits pass; unsafe overrides fail', () => {
  assert.deepEqual(evaluateUnifyOverrides(null), { ok: true });
  assert.deepEqual(evaluateUnifyOverrides(undefined), { ok: true });
  assert.equal(evaluateUnifyOverrides({ merges: [], splits: [] }).ok, true);
  // Merging an approved keyed row into its own approved group is safe.
  assert.equal(evaluateUnifyOverrides({
    merges: [{ into: 'gemini-3.5-flash-lite', keys: ['google:gemini-3.5-flash-lite'] }],
    splits: [],
  }).ok, true);
  // Splitting a non-approved member is safe.
  assert.equal(evaluateUnifyOverrides({
    merges: [],
    splits: [{ member: 'some-other-model', groupKey: 'g' }],
  }).ok, true);
  // Merging an approved keyed row AWAY from its group fails.
  assert.equal(evaluateUnifyOverrides({
    merges: [{ into: 'some-other-group', keys: ['google:gemini-3.5-flash-lite'] }],
    splits: [],
  }).ok, false);
  // Splitting an approved keyed row out of its group fails.
  assert.equal(evaluateUnifyOverrides({
    merges: [],
    splits: [{ member: 'google:gemini-3.5-flash-lite', groupKey: 'g' }],
  }).ok, false);
  // Merging a keyless row into an approved group fails.
  assert.equal(evaluateUnifyOverrides({
    merges: [{ into: 'gemini-3.5-flash-lite', keys: ['a-display-name'] }],
    splits: [],
  }).ok, false);
  // Unrecognized shapes fail closed.
  assert.equal(evaluateUnifyOverrides({ merges: 'nope' }).ok, false);
  assert.equal(evaluateUnifyOverrides({ merges: [{ into: 'x', keys: [] }] }).ok, false);
  assert.equal(evaluateUnifyOverrides({ unknownField: 1 }).ok, false);
});
