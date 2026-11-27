// NOVA FreeLLMAPI — benchmark harness tests (approved v5 design, §4b/B3/B4).
//
// Record-only assertions: a run writes its verdict + a benchmark.json
// manifest under the scratch root and exits 0 when unavailable; image and
// audio are blocked by their own gates (B1 / B4); the harness never
// imports the store or dispatch modules and never writes outside the
// scratch root; the audio gate is independent of image state (NOVA-06).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(__dirname, '..', 'scripts', 'freellmapi-benchmark.mjs');
const SCRATCH_ROOT = path.join(__dirname, '..', 'benchmark-scratch');

async function runHarness(args = [], env = {}) {
  const { stdout, stderr } = await execFileAsync('node', [HARNESS, ...args], {
    env: { ...process.env, ...env },
    timeout: 30000,
  }).catch((err) => {
    // execFile rejects on a non-zero exit; the harness exits 0 for
    // unavailable runs, so a rejection here is a real failure — surface it.
    throw new Error(`harness failed: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
  });
  assert.equal(stderr, '', 'the harness must not write to stderr on a clean run');
  return stdout.trim();
}

function manifestPathFrom(stdout) {
  const m = /— (\S+benchmark\.json)$/.exec(stdout);
  assert.ok(m, `no manifest path in harness output: ${stdout}`);
  return m[1];
}

function readManifest(stdout) {
  return JSON.parse(fs.readFileSync(manifestPathFrom(stdout), 'utf8'));
}

function cleanupRun(stdout) {
  const manifest = manifestPathFrom(stdout);
  const runDir = path.dirname(manifest);
  assert.ok(runDir.startsWith(SCRATCH_ROOT), `run dir ${runDir} is outside the scratch root`);
  fs.rmSync(runDir, { recursive: true, force: true });
}

test('flag off: the run reports unavailable with the specific reason and exits 0', async () => {
  const stdout = await runHarness(['--mode', 'text'], { NOVA_GATEWAY_BENCHMARK: 'false' });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.reason, 'benchmark-flag-off');
  assert.deepEqual(manifest.probes, []);
  cleanupRun(stdout);
});

test('image benchmarking is blocked (B1) even with the flag on', async () => {
  const stdout = await runHarness(['--mode', 'image'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.reason, 'image-benchmark-blocked');
  assert.deepEqual(manifest.probes, []);
  cleanupRun(stdout);
});

test('audio benchmarking is blocked by its own gate (B4), independent of image', async () => {
  const stdout = await runHarness(['--mode', 'audio'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.reason, 'audio-benchmark-blocked');
  assert.notEqual(manifest.reason, 'image-benchmark-blocked');
  cleanupRun(stdout);
});

test('audio gate does not depend on image-benchmark state (NOVA-06)', async () => {
  // No image benchmark has ever succeeded in this scratch root (and the
  // audio run must not read one): the audio verdict is the same with an
  // empty scratch root as with an image manifest present.
  const imageRun = await runHarness(['--mode', 'image'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const imageManifest = readManifest(imageRun);
  assert.equal(imageManifest.reason, 'image-benchmark-blocked');
  const audioRun = await runHarness(['--mode', 'audio'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const audioManifest = readManifest(audioRun);
  assert.equal(audioManifest.reason, 'audio-benchmark-blocked');
  cleanupRun(imageRun);
  cleanupRun(audioRun);
});

test('text mode without a key reports unavailable (gateway-api-key-missing) and exits 0', async () => {
  const stdout = await runHarness(['--mode', 'text'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: '',
  });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.reason, 'gateway-api-key-missing');
  cleanupRun(stdout);
});

test('text mode with a key but a dead gateway reports unavailable (gateway-unavailable)', async () => {
  const stdout = await runHarness(['--mode', 'text', '--base-url', 'http://127.0.0.1:1'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.reason, 'gateway-unavailable');
  cleanupRun(stdout);
});

test('text mode against a live stub gateway completes with probes recorded', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': 'google/gemini-3.5-flash-lite' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Enhanced probe text.' } }],
        model: 'gemini-3.5-flash-lite',
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stdout = await runHarness(['--mode', 'text', '--base-url', baseUrl], {
      NOVA_GATEWAY_BENCHMARK: 'true',
      NOVA_GATEWAY_API_KEY: 'test-key',
    });
    const manifest = readManifest(stdout);
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.probes.length, 3);
    for (const probe of manifest.probes) {
      assert.equal(probe.ok, true);
      assert.equal(probe.routedVia, 'google/gemini-3.5-flash-lite');
      assert.ok(probe.outputChars > 0);
      assert.ok(typeof probe.latencyMs === 'number');
    }
    assert.equal(requests.length, 4, 'dashboard liveness check + 3 probes');
    const posts = requests.filter((body) => body.length > 0);
    assert.equal(posts.length, 3);
    cleanupRun(stdout);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the harness never imports the store or dispatch modules and writes only under the scratch root', () => {
  const source = fs.readFileSync(HARNESS, 'utf8');
  assert.ok(source.includes('gateway-client.js'), 'the harness may use the gateway client');
  for (const forbidden of ['gpu-manager', 'dispatch.js', 'store.js', 'api-server.js', 'gateway-authorization']) {
    assert.ok(!source.includes(forbidden), `harness must not reference ${forbidden}`);
  }
  // Every benchmark.json under the scratch root is inside a run dir.
  const runDirs = fs.existsSync(SCRATCH_ROOT) ? fs.readdirSync(SCRATCH_ROOT) : [];
  for (const dir of runDirs) {
    assert.match(dir, /^[0-9a-f]+-\d{8}-\d{6}$/, `unexpected scratch entry ${dir}`);
  }
});

test('benchmark output never enters production job storage (no resultRef points at the scratch root)', async () => {
  // A benchmark run writes only its manifest; nothing in the manager
  // store can reference it — the harness has no path to the store.
  const stdout = await runHarness(['--mode', 'image'], {
    NOVA_GATEWAY_BENCHMARK: 'true',
    NOVA_GATEWAY_API_KEY: 'test-key',
  });
  const manifest = readManifest(stdout);
  assert.equal(manifest.status, 'unavailable');
  const runDir = path.dirname(manifestPathFrom(stdout));
  const files = fs.readdirSync(runDir);
  assert.deepEqual(files, ['benchmark.json']);
  cleanupRun(stdout);
});
