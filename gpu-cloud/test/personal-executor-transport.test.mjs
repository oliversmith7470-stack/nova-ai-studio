// The personal executor's Kaggle transport wiring: createPersonalExecutor
// must build the LTX executor with a REAL KaggleCliTransport (not the
// old null human channel), and a submit through it must reach the
// transport — otherwise start() hangs on a pending promise that only a
// manual fileReport could ever settle. No live Kaggle execution, no
// credential use, no spend: the credential is fake test values, the CLI
// boundary is a recording stub transport, and the real transport is
// only ever constructed (never invoked) to prove the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createPersonalExecutor, DEFAULT_KAGGLE_BIN } from '../src/api-server.js';
import { KaggleCliTransport } from '../src/kaggle-transport.js';
import { getStagingManifest } from '../src/staging.js';

// Fake test credentials (never real ones). The env pair satisfies the
// credential gate without any credential file being consulted — home
// points at a directory that does not exist.
const FAKE_ENV = {
  ...process.env,
  KAGGLE_USERNAME: 'test-owner',
  KAGGLE_KEY: 'test-key-never-real',
};
const NO_HOME = '/nonexistent-home-xyz';

async function makePackageDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-personal-transport-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'packages');
}

function baseArgs(packageDir, overrides = {}) {
  return {
    personalExecutorId: 'kaggle-t4',
    ownerTokenConfigured: true,
    packageDir,
    env: FAKE_ENV,
    home: NO_HOME,
    ...overrides,
  };
}

// A recording stub transport: answers push/status/output from memory and
// records every push. It never shells out — no Kaggle CLI is invoked.
function makeStubTransport(jobId) {
  const calls = { push: [], status: [], output: [] };
  const transport = {
    calls,
    async push(dir) {
      calls.push.push(dir);
      return { ok: true, kernelId: `test-owner/nova-gpu-cloud-${jobId}` };
    },
    async status(kernelId) {
      calls.status.push(kernelId);
      return { state: 'complete' };
    },
    async output(kernelId) {
      calls.output.push(kernelId);
      return { jobId, status: 'succeeded', secondsUsed: 600, costUsd: 0, resultRef: null };
    },
  };
  return transport;
}

function makeJob(id) {
  return {
    id,
    modelId: 'ltx-video-2b',
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    audience: 'personal',
    params: { stage2Test: true, audience: 'personal' },
  };
}

test('factory wires a real KaggleCliTransport (not null) with the default venv binary', async (t) => {
  const packageDir = await makePackageDir(t);
  const reg = createPersonalExecutor(baseArgs(packageDir));
  assert.ok(reg, 'factory must register the personal executor');
  assert.equal(reg.providerId, 'kaggle-t4');
  // The wiring itself: a real transport, not the old null human channel.
  assert.ok(reg.executor.transport instanceof KaggleCliTransport);
  assert.notEqual(reg.executor.transport, null);
  assert.equal(reg.executor.transport.kaggleBin, DEFAULT_KAGGLE_BIN);
  assert.equal(reg.executor.transport.kaggleBin, '/var/lib/nova-api/.venv-kaggle/bin/kaggle');
  // The username rides the kernel metadata id.
  assert.equal(reg.executor.kaggleUsername, 'test-owner');
  assert.equal(reg.executor.audience, 'personal');
});

test('kaggleBin precedence: explicit option beats NOVA_KAGGLE_BIN env beats default', async (t) => {
  const packageDir = await makePackageDir(t);
  const explicit = createPersonalExecutor(baseArgs(packageDir, {
    kaggleBin: '/opt/custom/bin/kaggle',
    env: { ...FAKE_ENV, NOVA_KAGGLE_BIN: '/env/bin/kaggle' },
  }));
  assert.equal(explicit.executor.transport.kaggleBin, '/opt/custom/bin/kaggle');

  const fromEnv = createPersonalExecutor(baseArgs(packageDir, {
    env: { ...FAKE_ENV, NOVA_KAGGLE_BIN: '/env/bin/kaggle' },
  }));
  assert.equal(fromEnv.executor.transport.kaggleBin, '/env/bin/kaggle');

  const fallback = createPersonalExecutor(baseArgs(packageDir));
  assert.equal(fallback.executor.transport.kaggleBin, DEFAULT_KAGGLE_BIN);
});

test('kaggleUsername precedence: explicit option beats KAGGLE_USERNAME env', async (t) => {
  const packageDir = await makePackageDir(t);
  const explicit = createPersonalExecutor(baseArgs(packageDir, { kaggleUsername: 'opt-owner' }));
  assert.equal(explicit.executor.kaggleUsername, 'opt-owner');
  const fromEnv = createPersonalExecutor(baseArgs(packageDir));
  assert.equal(fromEnv.executor.kaggleUsername, 'test-owner');
});

test('factory still refuses without a credential, even with an injected transport (fail closed)', async (t) => {
  const packageDir = await makePackageDir(t);
  const noCredEnv = { ...FAKE_ENV, KAGGLE_USERNAME: '', KAGGLE_KEY: '' };
  const stub = makeStubTransport('nova-job-no-cred');
  // An injected transport never bypasses the credential gate.
  assert.equal(
    createPersonalExecutor(baseArgs(packageDir, { env: noCredEnv, home: NO_HOME, transport: stub })),
    null,
  );
  // The other gates are unchanged: owner token, id, package dir.
  assert.equal(createPersonalExecutor(baseArgs(packageDir, { ownerTokenConfigured: false })), null);
  assert.equal(createPersonalExecutor(baseArgs(packageDir, { personalExecutorId: 'wan' })), null);
  assert.equal(createPersonalExecutor(baseArgs(packageDir, { personalExecutorId: '' })), null);
  assert.equal(createPersonalExecutor(baseArgs(packageDir, { packageDir: '' })), null);
});

test('submit through the factory-built executor reaches the transport (no real Kaggle call)', async (t) => {
  const packageDir = await makePackageDir(t);
  const jobId = 'nova-job-wire-submit';
  const stub = makeStubTransport(jobId);
  const reg = createPersonalExecutor(baseArgs(packageDir, {
    transport: stub,
    pollIntervalMs: 10,
  }));
  assert.ok(reg);
  const manifest = getStagingManifest('ltx-video-2b');
  const out = await reg.executor.submit(makeJob(jobId), manifest);
  // The push reached the transport with the package dir — the dispatch
  // path is live, not the human channel.
  assert.deepEqual(stub.calls.push, [path.join(packageDir, jobId)]);
  assert.equal(out.channel, 'kaggle-cli');
  assert.equal(out.kernelId, `test-owner/nova-gpu-cloud-${jobId}`);
  // The kernel metadata carries the owner's username, not the placeholder.
  const meta = JSON.parse(await readFile(path.join(packageDir, jobId, 'kernel-metadata.json'), 'utf8'));
  assert.equal(meta.id, `test-owner/nova-gpu-cloud-${jobId}`);
});

test('start() resolves through the transport instead of hanging on the pending promise', async (t) => {
  const packageDir = await makePackageDir(t);
  const jobId = 'nova-job-wire-start';
  const stub = makeStubTransport(jobId);
  const reg = createPersonalExecutor(baseArgs(packageDir, {
    transport: stub,
    pollIntervalMs: 10,
  }));
  assert.ok(reg);
  // The old null-transport executor never resolves start() — only a
  // manual fileReport settles it. With the transport wired, the poll
  // completes the job. The race timeout fails the test if the hang is
  // back: start() must settle well inside 5 s with a 10 ms poll.
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('start() did not resolve — the null-transport hang is back')),
      5000,
    );
    timer.unref?.();
  });
  const report = await Promise.race([reg.executor.start(makeJob(jobId)), timeout]);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.jobId, jobId);
  assert.equal(report.secondsUsed, 600);
  assert.deepEqual(reg.executor.pendingJobs(), []);
  // The transport saw the whole lifecycle: push, then status, then output.
  assert.equal(stub.calls.push.length, 1);
  assert.ok(stub.calls.status.length >= 1);
  assert.equal(stub.calls.output.length, 1);
});
