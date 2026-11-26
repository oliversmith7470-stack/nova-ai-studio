// phase5-wrapper.test.mjs — §15 tests (ab) + (y) for run-health-check.sh.
// Method: copy the fixed wrapper to a temp dir and sed-replace the LOCK path
// and the probe path (and the flock/node paths for the missing-binary cases);
// the probe is a stub NODE script exiting $STUB_EXIT. Diagnostics are
// captured with a fake `logger` earlier in PATH that appends to a file
// (the wrapper invokes bare `logger`). No file named `9` may be created.
// The installed-wrapper test runs the real installed wrapper/probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WRAPPER_SRC = path.join(REPO_ROOT, 'gpu-cloud/src/api-server/run-health-check.sh');

// Build one sandboxed wrapper copy: returns { dir, wrapper, logFile, lockPath }.
// replacements: array of [from, to] applied to the wrapper text.
function sandboxWrapper(t, replacements = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const logFile = path.join(dir, 'logger.log');
  fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`);
  fs.chmodSync(path.join(bin, 'logger'), 0o755);
  const lockPath = path.join(dir, 'health-check.lock');
  const probePath = path.join(dir, 'stub-probe.mjs');
  fs.writeFileSync(probePath, `process.exit(Number(process.env.STUB_EXIT ?? '0'));\n`);
  let text = fs.readFileSync(WRAPPER_SRC, 'utf8');
  text = text.replaceAll('LOCK=/var/lib/nova-api/health-check.lock', `LOCK=${lockPath}`);
  text = text.replaceAll('/opt/nova-ai-studio/src/api-server/health-check.js', probePath);
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  const wrapper = path.join(dir, 'run-health-check.sh');
  fs.writeFileSync(wrapper, text);
  fs.chmodSync(wrapper, 0o755);
  return { dir, bin, wrapper, logFile, lockPath, probePath };
}

function runWrapper(s, stubExit, extraEnv = {}) {
  return spawnSync('sh', [s.wrapper], {
    encoding: 'utf8',
    cwd: s.dir,
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, STUB_EXIT: String(stubExit), ...extraEnv },
    timeout: 15000,
  });
}

function loggerLines(s) {
  try { return fs.readFileSync(s.logFile, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

test('(ab) wrapper exit-code contract: probe 0/1/7/42 pass through exactly', (t) => {
  const s = sandboxWrapper(t);
  for (const code of [0, 1, 7, 42]) {
    const r = runWrapper(s, code);
    assert.equal(r.status, code, `stub probe ${code} -> wrapper ${r.status} (stderr: ${r.stderr})`);
    assert.equal(loggerLines(s).length, 0, `probe ${code}: no wrapper diagnostic`);
    assert.equal(fs.existsSync(path.join(s.dir, '9')), false, 'no file named 9 created');
  }
});

test('(ab) wrapper contention: held lock -> exit 0 + health-check-skipped-overlap', async (t) => {
  const s = sandboxWrapper(t);
  const { flockExNb, flockUn } = await import('../src/api-server/flock-binding.mjs');
  const fd = fs.openSync(s.lockPath, 'a');
  assert.equal(flockExNb(fd), true);
  try {
    const r = runWrapper(s, 0);
    assert.equal(r.status, 0, `held lock -> exit 0, got ${r.status}`);
    const lines = loggerLines(s);
    assert.equal(lines.length, 1, `exactly one diagnostic, got ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes('event=health-check-skipped-overlap'), lines[0]);
    assert.ok(lines[0].includes('detail=probe-already-running'), lines[0]);
    assert.ok(lines[0].includes('level=warn'), lines[0]);
  } finally { flockUn(fd); fs.closeSync(fd); }
  // After release the probe runs again (passthrough).
  const r2 = runWrapper(s, 1);
  assert.equal(r2.status, 1, 'free lock -> probe exit 1 passes through (never 2)');
  assert.equal(fs.existsSync(path.join(s.dir, '9')), false, 'no file named 9 created');
});

test('(ab) wrapper infrastructure failures: lock unopenable / flock missing / node missing / probe unreadable -> exit 2', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-wrapper-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const logFile = path.join(dir, 'logger.log');
  fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`);
  fs.chmodSync(path.join(bin, 'logger'), 0o755);
  const probePath = path.join(dir, 'stub-probe.mjs');
  fs.writeFileSync(probePath, `process.exit(0);\n`);
  const mkWrapper = (lockValue) => {
    let text = fs.readFileSync(WRAPPER_SRC, 'utf8');
    text = text.replaceAll('LOCK=/var/lib/nova-api/health-check.lock', `LOCK=${lockValue}`);
    text = text.replaceAll('/opt/nova-ai-studio/src/api-server/health-check.js', probePath);
    const w = path.join(dir, 'run-health-check.sh');
    fs.writeFileSync(w, text);
    fs.chmodSync(w, 0o755);
    return w;
  };
  const run = (wrapper) => spawnSync('sh', [wrapper], { encoding: 'utf8', cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000 });
  const lines = () => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

  const wBadLock = mkWrapper('/nonexistent-dir-xyz/health-check.lock');
  const r1 = run(wBadLock);
  assert.equal(r1.status, 2, `lock unopenable -> exit 2, got ${r1.status}`);
  assert.ok(lines().some((l) => l.includes('event=health-check-wrapper-failed') && l.includes('detail=lock-file-unopenable')), JSON.stringify(lines()));

  // flock binary missing.
  let text = fs.readFileSync(WRAPPER_SRC, 'utf8');
  text = text.replaceAll('LOCK=/var/lib/nova-api/health-check.lock', `LOCK=${path.join(dir, 'health-check.lock')}`);
  text = text.replaceAll('/opt/nova-ai-studio/src/api-server/health-check.js', probePath);
  text = text.replaceAll('/usr/bin/flock', '/nonexistent/flock');
  const wNoFlock = path.join(dir, 'run-noflock.sh');
  fs.writeFileSync(wNoFlock, text);
  fs.chmodSync(wNoFlock, 0o755);
  const r2 = run(wNoFlock);
  assert.equal(r2.status, 2, `flock missing -> exit 2, got ${r2.status}`);
  assert.ok(lines().some((l) => l.includes('event=health-check-wrapper-failed') && l.includes('detail=flock-binary-missing')), JSON.stringify(lines()));

  // node binary missing.
  text = fs.readFileSync(WRAPPER_SRC, 'utf8');
  text = text.replaceAll('LOCK=/var/lib/nova-api/health-check.lock', `LOCK=${path.join(dir, 'health-check.lock')}`);
  text = text.replaceAll('/opt/nova-ai-studio/src/api-server/health-check.js', probePath);
  text = text.replaceAll('/usr/bin/node', '/nonexistent/node');
  const wNoNode = path.join(dir, 'run-nonode.sh');
  fs.writeFileSync(wNoNode, text);
  fs.chmodSync(wNoNode, 0o755);
  const r3 = run(wNoNode);
  assert.equal(r3.status, 2, `node missing -> exit 2, got ${r3.status}`);
  assert.ok(lines().some((l) => l.includes('event=health-check-wrapper-failed') && l.includes('detail=node-binary-missing')), JSON.stringify(lines()));

  // Probe script unreadable (path does not exist).
  text = fs.readFileSync(WRAPPER_SRC, 'utf8');
  text = text.replaceAll('LOCK=/var/lib/nova-api/health-check.lock', `LOCK=${path.join(dir, 'health-check.lock')}`);
  text = text.replaceAll('/opt/nova-ai-studio/src/api-server/health-check.js', path.join(dir, 'no-such-probe.mjs'));
  const wNoProbe = path.join(dir, 'run-noprobe.sh');
  fs.writeFileSync(wNoProbe, text);
  fs.chmodSync(wNoProbe, 0o755);
  const r4 = run(wNoProbe);
  assert.equal(r4.status, 2, `probe unreadable -> exit 2, got ${r4.status}`);
  assert.ok(lines().some((l) => l.includes('event=health-check-wrapper-failed') && l.includes('detail=probe-script-unreadable')), JSON.stringify(lines()));
  assert.equal(fs.existsSync(path.join(dir, '9')), false, 'no file named 9 created in any failure case');
});

test('(ab) wrapper holds the lock while the probe runs (second wrapper sees contention)', async (t) => {
  const s = sandboxWrapper(t);
  // Stub probe that sleeps 3 s then exits 0.
  fs.writeFileSync(s.probePath, `await new Promise((r) => setTimeout(r, 3000)); process.exit(0);\n`);
  const first = spawn('sh', [s.wrapper], { env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` }, stdio: 'ignore' });
  const firstDone = new Promise((resolveFirst) => first.on('close', resolveFirst));
  await new Promise((r) => setTimeout(r, 800)); // let the first wrapper acquire the lock and start the probe
  const second = runWrapper(s, 0);
  assert.equal(second.status, 0, 'second wrapper exits 0 on contention');
  assert.ok(loggerLines(s).some((l) => l.includes('event=health-check-skipped-overlap')), 'second wrapper logged the skip');
  const firstCode = await firstDone;
  assert.equal(firstCode, 0, 'first wrapper completes with the probe status');
});

// NOTE: the installed-wrapper test (real wrapper + real probe under systemd
// paths) lives in phase5-installed.test.mjs, not here: it writes the shared
// /var/lib/nova-api state files, so it must run sequentially under the
// installed gate, never in parallel with phase5-alert.test.mjs. This file's
// sandboxed tests touch only temp dirs and are parallel-safe.
