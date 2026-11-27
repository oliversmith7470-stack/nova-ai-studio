// The real Kaggle CLI transport (Rev 4.8 §7): push/status/output against
// a stub `kaggle` binary on PATH. No real Kaggle call, no credential use,
// no spend — the stub records its invocations and answers with canned
// CLI output. The transport's credential gate is tested with fake test
// credentials (never real ones).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { KaggleCliTransport, kaggleCredentialPresent } from '../src/kaggle-transport.js';

const FAKE_ENV = {
  ...process.env,
  KAGGLE_USERNAME: 'test-owner',
  KAGGLE_KEY: 'test-key-never-real',
};

// A stub `kaggle` CLI: answers `kernels push/status/output` with canned
// output and records every invocation in $STUB_LOG. Behaviour is driven
// by $STUB_MODE: ok | push-fail | status-error | status-garbage |
// output-no-report | output-bad-report.
const STUB_SCRIPT = `#!/bin/sh
echo "$@" >> "$STUB_LOG"
case "$1 $2" in
  "kernels push")
    if [ "$STUB_MODE" = "push-fail" ]; then echo "push failed: quota" >&2; exit 1; fi
    echo "Kernel successfully pushed to: test-owner/nova-gpu-cloud-nova-job-stub"
    exit 0
    ;;
  "kernels status")
    case "$STUB_MODE" in
      "status-error") echo "KernelWorkerStatus.ERROR" ;;
      "status-garbage") echo "something entirely unparseable" ;;
      *) echo "KernelWorkerStatus.COMPLETE" ;;
    esac
    exit 0
    ;;
  "kernels output")
    # $4 is the -p dir, $5 is the kernel slug
    dir="$4"
    case "$STUB_MODE" in
      "output-no-report") exit 0 ;;
      "output-bad-report") echo "{not json" > "$dir/nova-job-stub.report.json"; exit 0 ;;
      *) echo '{"jobId":"nova-job-stub","status":"completed","peak_vram_gib":12.64}' > "$dir/nova-job-stub.report.json"; exit 0 ;;
    esac
    ;;
  *)
    echo "unknown command: $@" >&2; exit 2 ;;
esac
`;

async function makeStub(t, mode = 'ok') {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-kaggle-stub-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir);
  await writeFile(path.join(binDir, 'kaggle'), STUB_SCRIPT, { mode: 0o755 });
  await chmod(path.join(binDir, 'kaggle'), 0o755);
  const logPath = path.join(dir, 'stub.log');
  await writeFile(logPath, '');
  const env = {
    ...FAKE_ENV,
    PATH: `${binDir}:${process.env.PATH}`,
    STUB_LOG: logPath,
    STUB_MODE: mode,
  };
  return { dir, binDir, logPath, env };
}

function makeTransport(env, overrides = {}) {
  return new KaggleCliTransport({ env, ...overrides });
}

test('kaggleCredentialPresent: env pair counts; a missing key does not', () => {
  assert.equal(kaggleCredentialPresent({ env: FAKE_ENV }), true);
  assert.equal(kaggleCredentialPresent({ env: { ...FAKE_ENV, KAGGLE_KEY: '' } }), false);
  assert.equal(kaggleCredentialPresent({ env: {}, home: '/nonexistent-home' }), false);
});

test('construction throws without a credential (fail closed, never runs bare)', async (t) => {
  const { env } = await makeStub(t);
  const noCred = { ...env, KAGGLE_USERNAME: '', KAGGLE_KEY: '' };
  assert.throws(() => new KaggleCliTransport({ env: noCred, home: '/nonexistent-home' }), /requires the Kaggle credential/);
});

test('push parses the kernel slug from the CLI output', async (t) => {
  const { env, logPath } = await makeStub(t);
  const transport = makeTransport(env);
  const out = await transport.push('/tmp/some-package');
  assert.deepEqual(out, { ok: true, kernelId: 'test-owner/nova-gpu-cloud-nova-job-stub' });
  const log = await readFile(logPath, 'utf8');
  assert.ok(log.includes('kernels push -p /tmp/some-package --accelerator NvidiaTeslaT4 -t 43200'));
});

test('push failure is an error, never a success', async (t) => {
  const { env } = await makeStub(t, 'push-fail');
  const transport = makeTransport(env);
  await assert.rejects(() => transport.push('/tmp/some-package'), /kaggle CLI failed/);
});

test('status maps the KernelWorkerStatus enum (complete / error / unparseable)', async (t) => {
  const okStub = await makeStub(t);
  assert.deepEqual(await makeTransport(okStub.env).status('test-owner/nova-gpu-cloud-nova-job-stub'), { state: 'complete' });

  const errStub = await makeStub(t, 'status-error');
  assert.deepEqual(await makeTransport(errStub.env).status('test-owner/nova-gpu-cloud-nova-job-stub'), { state: 'error', error: 'kernel error' });

  const garbageStub = await makeStub(t, 'status-garbage');
  await assert.rejects(
    () => makeTransport(garbageStub.env).status('test-owner/nova-gpu-cloud-nova-job-stub'),
    /unparseable status/,
  );
});

test('output downloads the report and returns the parsed provider report', async (t) => {
  const { env, dir } = await makeStub(t);
  const transport = makeTransport(env, { outputRoot: path.join(dir, 'out') });
  const report = await transport.output('test-owner/nova-gpu-cloud-nova-job-stub');
  assert.equal(report.jobId, 'nova-job-stub');
  assert.equal(report.status, 'completed');
  assert.equal(report.peak_vram_gib, 12.64);
});

test('output without a report file is an error (executor retries, never succeeds on air)', async (t) => {
  const { env, dir } = await makeStub(t, 'output-no-report');
  const transport = makeTransport(env, { outputRoot: path.join(dir, 'out') });
  await assert.rejects(
    () => transport.output('test-owner/nova-gpu-cloud-nova-job-stub'),
    /no \.report\.json/,
  );
});

test('output with an unparseable report is an error', async (t) => {
  const { env, dir } = await makeStub(t, 'output-bad-report');
  const transport = makeTransport(env, { outputRoot: path.join(dir, 'out') });
  await assert.rejects(
    () => transport.output('test-owner/nova-gpu-cloud-nova-job-stub'),
    /unparseable report/,
  );
});

test('a missing kaggle binary is a configuration error, never a success', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-kaggle-nobin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...FAKE_ENV, PATH: dir }; // an empty PATH dir: no kaggle
  const transport = makeTransport(env);
  await assert.rejects(() => transport.push('/tmp/some-package'), /kaggle CLI failed/);
});
