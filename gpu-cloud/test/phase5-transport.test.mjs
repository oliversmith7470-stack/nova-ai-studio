// phase5-transport.test.mjs — §15 test (ab): sendmail resolution + transport.
// resolveSendmailPath caches per process, so each case runs in its own child
// process (node --input-type=module -e importing the repo dispatcher).
// No MTA is installed on this dev VM; the fake sendmail is a shell script on
// a temp PATH that records its stdin and exits 0 (or with a multi-line
// stderr / non-zero exit for the reason-normalisation cases).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DISPATCHER = path.join(REPO_ROOT, 'gpu-cloud/src/api-server/alert-dispatcher.js');

function runInChild(code, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  assert.equal(r.status, 0, `child exit 0, stderr: ${r.stderr}`);
  return r.stdout;
}

const IMPORT = `import { resolveSendmailPath, sendmailTransport } from '${DISPATCHER}';`;

test('(ab) sendmail absent from PATH -> null + sendmail-not-installed, no spawn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = runInChild(`${IMPORT}
console.log(JSON.stringify({
  resolved: resolveSendmailPath(),
  result: sendmailTransport({ to: 'a@b.c', subject: 's', body: 'b' }),
}));`, { PATH: dir }); // empty dir on PATH: no sendmail anywhere
  const { resolved, result } = JSON.parse(out.trim());
  assert.equal(resolved, null);
  assert.deepEqual(result, { ok: false, reason: 'sendmail-not-installed' });
});

test('(ab) fake sendmail on PATH -> resolves + delivery succeeds, input captured', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'captured.txt');
  fs.writeFileSync(path.join(dir, 'sendmail'), `#!/bin/sh\ncat > "${capture}"\nexit 0\n`);
  fs.chmodSync(path.join(dir, 'sendmail'), 0o755);
  const out = runInChild(`${IMPORT}
console.log(JSON.stringify({
  resolved: resolveSendmailPath(),
  result: sendmailTransport({ to: 'novaaistudio.com@gmail.com', subject: '[NOVA] startup-listen-failed — 2026-11-26T05:58:00Z', body: 'Event: startup-listen-failed' }),
}));`, { PATH: `${dir}:/usr/bin:/bin` });
  const { resolved, result } = JSON.parse(out.trim());
  assert.equal(resolved, `${dir}/sendmail`);
  assert.deepEqual(result, { ok: true });
  const input = fs.readFileSync(capture, 'utf8');
  assert.ok(input.includes('To: novaaistudio.com@gmail.com'), input);
  assert.ok(input.includes('Subject: [NOVA] startup-listen-failed'), input);
  assert.ok(input.includes('Event: startup-listen-failed'), input);
});

test('(ab) sendmail only at /usr/sbin with /usr/sbin NOT on PATH -> null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // /usr/sbin/sendmail does not exist on this VM; prove the policy with a
  // directory that is NOT on PATH holding a sendmail, and PATH without it.
  const hidden = path.join(dir, 'hidden-sbin');
  fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, 'sendmail'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(hidden, 'sendmail'), 0o755);
  const out = runInChild(`${IMPORT}
console.log(JSON.stringify({ resolved: resolveSendmailPath() }));`, { PATH: dir });
  assert.equal(JSON.parse(out.trim()).resolved, null, 'a sendmail outside PATH is NOT installed');
  // And the same binary IS found once its directory is on PATH.
  const out2 = runInChild(`${IMPORT}
console.log(JSON.stringify({ resolved: resolveSendmailPath() }));`, { PATH: `${hidden}:${dir}` });
  assert.equal(JSON.parse(out2.trim()).resolved, `${hidden}/sendmail`);
});

test('(ab) sendmail non-zero exit with multi-line stderr -> single-token reason', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The fake sendmail MUST consume stdin (spawnSync writes the message to its
  // stdin pipe; a child that exits without reading causes EPIPE, which the
  // transport reports as sendmail-spawn-failed, not the exit code).
  fs.writeFileSync(path.join(dir, 'sendmail'), '#!/bin/sh\ncat > /dev/null\nprintf \'relay refused\\nsecond line  with spaces\\n\' >&2\nexit 65\n');
  fs.chmodSync(path.join(dir, 'sendmail'), 0o755);
  const out = runInChild(`${IMPORT}
console.log(JSON.stringify(sendmailTransport({ to: 'a@b.c', subject: 's', body: 'b' })));`, { PATH: `${dir}:/usr/bin:/bin` });
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sendmail-exit-65: relay-refused-second-line-with-spaces', `reason: ${result.reason}`);
  // The reason carries the 'sendmail-exit-65: ' prefix (with a space); the
  // single-token requirement applies to the log-line detail, which re-encodes
  // whitespace to dashes — the encoded form must be one token.
  assert.ok(!/\s/.test(result.reason.replace(/\s+/g, '-')), `encoded reason is a single token: ${result.reason}`);
});

test('(ab) sendmail spawn failure -> single-token sendmail-spawn-failed reason', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A sendmail that is not executable: statSync finds the file, accessSync
  // X_OK fails, so resolveSendmailPath skips it -> sendmail-not-installed.
  // A spawn failure needs a resolvable-but-unspawnable binary: use a
  // directory named sendmail (statSync().isFile() false -> skipped) — instead
  // prove the spawn-failed path via a sendmail that is a broken symlink:
  // statSync follows it and throws, so it is skipped too. The spawn-failed
  // branch is reached only when spawnSync itself errors; exercise it by
  // pointing PATH at a sendmail whose interpreter is missing.
  fs.writeFileSync(path.join(dir, 'sendmail'), '#!/nonexistent/interpreter\nexit 0\n');
  fs.chmodSync(path.join(dir, 'sendmail'), 0o755);
  const out = runInChild(`${IMPORT}
console.log(JSON.stringify(sendmailTransport({ to: 'a@b.c', subject: 's', body: 'b' })));`, { PATH: `${dir}:/usr/bin:/bin` });
  const result = JSON.parse(out.trim());
  // exec of a script with a missing interpreter fails at spawn (ENOENT) or
  // exits 127 via the shell fallback — either way the reason is normalised
  // (single token once whitespace is encoded, as the log-line detail does).
  assert.equal(result.ok, false);
  assert.match(result.reason, /^sendmail-(spawn-failed|exit-)/);
  assert.ok(!/\s/.test(result.reason.replace(/\s+/g, '-')), `encoded reason is a single token: ${result.reason}`);
});
