// NOVA FreeLLMAPI — routing-security tests (approved v5 design, NOVA-03/§7).
//
// Mirror of the NEXORA family, adapted: only the two colon-form pins are
// ever sent; a 503 for the pinned platform produces no second request; a
// mismatched X-Routed-Via discards the enhancement; a non-loopback base
// URL is rejected; a missing key means no HTTP request is attempted; the
// readiness check fails on unsafe unify overrides.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createGatewayClient,
  checkGatewayReadiness,
  GatewayConfigError,
} from '../src/gateway-client.js';
import { createApiServer } from '../src/api-server.js';
import { MemoryD1Client } from '../src/api-server/test/support.mjs';
import { FakeControlledExecutor } from '../src/api-server/fake-executor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_KEY = 'test-gateway-key';
const GOOGLE_PIN = 'google:gemini-3.5-flash-lite';
const GROQ_PIN = 'groq:qwen/qwen3.8-27b';
const GOOGLE_ROUTED = 'google/gemini-3.5-flash-lite';
const GROQ_ROUTED = 'groq/qwen/qwen3.8-27b';

function chatBody({ content = 'ok', model = 'gemini-3.5-flash-lite' } = {}) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    model,
  });
}

async function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);
      handler(req, res, record);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the client sends only the two colon-form identifiers, never a bare id, slash form, auto, or OVH', async () => {
  // Construction rejects every non-colon form.
  for (const model of ['gemini-3.5-flash-lite', 'google/gemini-3.5-flash-lite', 'auto', 'ovh:Qwen3.5-397B-A17B', 'groq:qwen/qwen3.8-27b'.replace('groq:', 'ovh:')]) {
    assert.throws(() => createGatewayClient({ baseUrl: 'http://127.0.0.1:3001', apiKey: API_KEY, model }), GatewayConfigError, model);
  }
  // And the wire carries exactly the colon pin for each approved model.
  for (const [pin, routed] of [[GOOGLE_PIN, GOOGLE_ROUTED], [GROQ_PIN, GROQ_ROUTED]]) {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': routed });
      res.end(chatBody({ model: pin.split(':')[1] }));
    });
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: pin });
      const result = await client.enhance('A dragon on a ridge.');
      assert.equal(result.routedVia, routed);
      assert.equal(JSON.parse(stub.requests[0].body).model, pin);
    } finally {
      await stub.close();
    }
  }
});

test('a 503 for the pinned platform produces no second request to any other platform', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('unavailable');
  });
  try {
    const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
    await assert.rejects(() => client.enhance('A dragon on a ridge.'), /gateway enhancement failed/);
    assert.equal(stub.requests.length, 1);
    assert.equal(JSON.parse(stub.requests[0].body).model, GOOGLE_PIN);
  } finally {
    await stub.close();
  }
});

test('a mismatched X-Routed-Via — wrong platform OR wrong model on the same platform — discards the enhancement', async () => {
  // Wrong platform: google pin, groq routed-via.
  {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': GROQ_ROUTED });
      res.end(chatBody());
    });
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
      await assert.rejects(() => client.enhance('A dragon on a ridge.'), /upstream unverified/);
    } finally {
      await stub.close();
    }
  }
  // Wrong model on the same platform: google pin, a different google model.
  {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': 'google/gemini-3.5-flash' });
      res.end(chatBody({ model: 'gemini-3.5-flash' }));
    });
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
      await assert.rejects(() => client.enhance('A dragon on a ridge.'), /upstream unverified/);
    } finally {
      await stub.close();
    }
  }
  // Absent header discards too.
  {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(chatBody());
    });
    try {
      const client = createGatewayClient({ baseUrl: stub.baseUrl, apiKey: API_KEY, model: GOOGLE_PIN });
      await assert.rejects(() => client.enhance('A dragon on a ridge.'), /upstream unverified/);
    } finally {
      await stub.close();
    }
  }
});

test('a non-loopback base URL is rejected at construction, including localhost', () => {
  for (const baseUrl of [
    'http://localhost:3001',
    'http://example.com',
    'http://192.168.1.10:3001',
    'https://127.0.0.1:3001', // loopback IP but not plain http — rejected: the gateway is http-only loopback
  ]) {
    assert.throws(() => createGatewayClient({ baseUrl, apiKey: API_KEY }), GatewayConfigError, baseUrl);
  }
});

test('a missing unified key means no HTTP request is attempted (server level)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-nokey-'));
  const api = createApiServer({
    mode: 'controlled-test',
    secret: 'test-secret',
    dataDir: dir,
    d1Client: new MemoryD1Client(),
    executor: new FakeControlledExecutor(),
    environment: 'development',
    gatewayEnhancement: true,
    gatewayApiKey: '',
  });
  try {
    assert.equal(api.gatewayClient, null, 'no key means the client is disabled, so no request can be attempted');
  } finally {
    await api.stop().catch(() => {});
  }
});

test('readiness fails when an override splits an approved keyed row out of its group', async () => {
  const stub = await startStub((req, res, record) => {
    const body = JSON.parse(record.body ?? '{}');
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': body.model === GOOGLE_PIN ? GOOGLE_ROUTED : GROQ_ROUTED });
    res.end(chatBody({ model: body.model === GOOGLE_PIN ? 'gemini-3.5-flash-lite' : 'qwen/qwen3.8-27b' }));
  });
  try {
    const result = await checkGatewayReadiness({
      baseUrl: stub.baseUrl,
      apiKey: API_KEY,
      getOverrides: async () => ({
        merges: [],
        splits: [{ member: 'google:gemini-3.5-flash-lite', groupKey: 'other' }],
      }),
    });
    assert.equal(result.ok, false);
    const overrideCheck = result.checks.find((c) => c.name === 'unify-overrides');
    assert.equal(overrideCheck.ok, false);
    assert.equal(overrideCheck.reason, 'keyed-split');
    // Both pins were still probed before the override evaluation.
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test('readiness fails when an override merges a keyless row into an approved group', async () => {
  const stub = await startStub((req, res, record) => {
    const body = JSON.parse(record.body ?? '{}');
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': body.model === GOOGLE_PIN ? GOOGLE_ROUTED : GROQ_ROUTED });
    res.end(chatBody({ model: body.model === GOOGLE_PIN ? 'gemini-3.5-flash-lite' : 'qwen/qwen3.8-27b' }));
  });
  try {
    const result = await checkGatewayReadiness({
      baseUrl: stub.baseUrl,
      apiKey: API_KEY,
      getOverrides: async () => ({
        merges: [{ into: 'gemini-3.5-flash-lite', keys: ['a-display-name'] }],
        splits: [],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((c) => c.name === 'unify-overrides').reason, 'keyless-merge');
  } finally {
    await stub.close();
  }
});

test('readiness with a non-loopback base URL fails without any request', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatBody());
  });
  try {
    const result = await checkGatewayReadiness({ baseUrl: 'http://example.com', apiKey: API_KEY });
    assert.equal(result.ok, false);
    assert.equal(result.checks[0].name, 'base-url');
    assert.equal(result.checks[0].reason, 'invalid-base-url');
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});
