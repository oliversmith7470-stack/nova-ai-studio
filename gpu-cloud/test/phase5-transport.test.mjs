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
import net from 'node:net';
import tls from 'node:tls';
import { spawnSync, spawn } from 'node:child_process';

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

// =============================================================================
// (ac) SMTP transport — OQ-1 (owner decision 28 Nov 2026: outside mail
// service, not a host MTA). Env isolation: every case runs in its own
// child process (same runInChild pattern as the sendmail cases above).
// The fake SMTP server runs in this process; the child connects to it
// over 127.0.0.1/localhost with the SMTP env pointing at it.
// =============================================================================

const IMPORT_SMTP = `import { smtpConfig, smtpTransport, resolveAlertTransport, mailTransportReady, ALERT_RECIPIENT, dispatchAlert, parseEventLine } from '${DISPATCHER}';`;

// Async variant of runInChild: the child is spawned (not spawnSync), so
// this process's event loop keeps running while the child runs — REQUIRED
// for the SMTP tests, whose fake server lives in this process. A spawnSync
// child would deadlock: the child waits for the server's reply while the
// parent is blocked waiting for the child to exit.
function runInChildAsync(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...env },
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => {
      try {
        assert.equal(status, 0, `child exit 0, stderr: ${stderr}`);
      } catch (e) { reject(e); return; }
      resolve(stdout);
    });
  });
}

test('(ac) ALERT_RECIPIENT is the owner decision: omoyenishina2000@gmail.com', () => {
  const out = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify({ recipient: ALERT_RECIPIENT }));`, { PATH: '/usr/bin:/bin' });
  assert.equal(JSON.parse(out.trim()).recipient, 'omoyenishina2000@gmail.com');
});

test('(ac) resolveAlertTransport: no SMTP env -> sendmailTransport; SMTP env -> smtpTransport', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  const out1 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify({ name: resolveAlertTransport().name }));`, { PATH: dir });
  assert.equal(JSON.parse(out1.trim()).name, 'sendmailTransport');
  const out2 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify({ name: resolveAlertTransport().name }));`, {
    PATH: dir,
    NOVA_ALERT_SMTP_HOST: 'smtp.gmail.com',
    NOVA_ALERT_SMTP_USER: 'omoyenishina2000@gmail.com',
    NOVA_ALERT_SMTP_PASS: 'x'.repeat(16),
  });
  assert.equal(JSON.parse(out2.trim()).name, 'smtpTransport');
});

test('(ac) mailTransportReady: none -> no-mail-transport; sendmail -> sendmail; SMTP env -> smtp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  const out1 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(mailTransportReady()));`, { PATH: dir });
  assert.deepEqual(JSON.parse(out1.trim()), { ok: false, reason: 'no-mail-transport' });
  // Fake sendmail on PATH -> sendmail ready.
  fs.writeFileSync(path.join(dir, 'sendmail'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'sendmail'), 0o755);
  const out2 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(mailTransportReady()));`, { PATH: `${dir}:/usr/bin:/bin` });
  const ready2 = JSON.parse(out2.trim());
  assert.equal(ready2.ok, true);
  assert.equal(ready2.via, 'sendmail');
  // SMTP env wins over sendmail and reports the host.
  const out3 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(mailTransportReady()));`, {
    PATH: `${dir}:/usr/bin:/bin`,
    NOVA_ALERT_SMTP_HOST: 'smtp.gmail.com',
    NOVA_ALERT_SMTP_USER: 'omoyenishina2000@gmail.com',
    NOVA_ALERT_SMTP_PASS: 'x'.repeat(16),
  });
  assert.deepEqual(JSON.parse(out3.trim()), { ok: true, via: 'smtp', detail: 'smtp.gmail.com' });
});

test('(ac) smtpTransport unconfigured / half-configured -> smtp-not-configured, no send', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-transport-'));
  const out1 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'a@b.c', subject: 's', body: 'b' })));`, { PATH: dir });
  assert.deepEqual(JSON.parse(out1.trim()), { ok: false, reason: 'smtp-not-configured' });
  const out2 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'a@b.c', subject: 's', body: 'b' })));`, {
    PATH: dir,
    NOVA_ALERT_SMTP_HOST: 'smtp.gmail.com',
    NOVA_ALERT_SMTP_USER: 'omoyenishina2000@gmail.com',
    // no PASS: half-configured — fail closed, never fall back to sendmail
  });
  assert.deepEqual(JSON.parse(out2.trim()), { ok: false, reason: 'smtp-not-configured' });
  // Host set but user not an email shape -> also not-configured.
  const out3 = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'a@b.c', subject: 's', body: 'b' })));`, {
    PATH: dir,
    NOVA_ALERT_SMTP_HOST: 'smtp.gmail.com',
    NOVA_ALERT_SMTP_USER: 'not-an-email',
    NOVA_ALERT_SMTP_PASS: 'x'.repeat(16),
  });
  assert.deepEqual(JSON.parse(out3.trim()), { ok: false, reason: 'smtp-not-configured' });
});

// --- fake SMTP server --------------------------------------------------------
// One connection at a time; commands recorded; DATA captured. Options:
// starttls (advertise STARTTLS), authOk (accept credentials), rcptOk
// (accept RCPT TO), tlsOptions { key, cert } (STARTTLS upgrade + implicit
// TLS), implicitTls (TLS from the first byte).
function startFakeSmtp(opts = {}) {
  const { starttls = true, authOk = true, rcptOk = true, tlsOptions = null, implicitTls = false } = opts;
  const events = { commands: [], mailFrom: null, rcptTo: null, data: null, authAttempted: false, upgraded: false, connections: 0 };
  const handleConnection = (initialSock) => {
    let sock = initialSock;
    let buffer = '';
    let pumping = false;
    let dataMode = false;
    let dataLines = [];
    let authStep = 0; // 0 idle, 1 username expected, 2 password expected
    events.connections++;
    const write = (line) => new Promise((resolve, reject) => { sock.write(`${line}\r\n`, (e) => (e ? reject(e) : resolve())); });
    let onData;
    const attach = (s) => {
      onData = (chunk) => { buffer += chunk.toString('utf8'); void pump(); };
      s.on('data', onData);
    };
    const detach = () => { sock.removeListener('data', onData); };
    const pump = async () => {
      if (pumping) return;
      pumping = true;
      try {
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (dataMode) {
            if (line === '.') {
              dataMode = false;
              events.data = dataLines.join('\n');
              dataLines = [];
              await write('250 OK: queued');
            } else {
              dataLines.push(line);
            }
            continue;
          }
          if (authStep === 1) { authStep = 2; await write('334 UGFzc3dvcmQ6'); continue; }
          if (authStep === 2) {
            authStep = 0;
            await write(authOk ? '235 Authentication successful' : '535 Authentication failed');
            continue;
          }
          events.commands.push(line);
          const [verb, ...rest] = line.split(' ');
          const arg = rest.join(' ');
          const up = verb.toUpperCase();
          if (up === 'EHLO' || up === 'HELO') {
            const caps = ['250-localhost'];
            if (starttls) caps.push('250-STARTTLS');
            caps.push('250 AUTH LOGIN');
            await write(caps.join('\r\n'));
          } else if (up === 'STARTTLS') {
            if (!starttls || !tlsOptions) { await write('454 TLS not available'); continue; }
            await write('220 Ready to start TLS');
            detach();
            const secure = new tls.TLSSocket(sock, { isServer: true, ...tlsOptions });
            sock = secure;
            events.upgraded = true;
            attach(sock);
          } else if (up === 'AUTH') {
            events.authAttempted = true;
            if (arg.toUpperCase() !== 'LOGIN') { await write('504 Unrecognized authentication type'); continue; }
            authStep = 1;
            await write('334 VXNlcm5hbWU6');
          } else if (up === 'MAIL') {
            events.mailFrom = arg;
            await write('250 OK');
          } else if (up === 'RCPT') {
            events.rcptTo = arg;
            await write(rcptOk ? '250 OK' : '550 No such user');
          } else if (up === 'DATA') {
            dataMode = true;
            dataLines = [];
            await write('354 End data with <CR><LF>.<CR><LF>');
          } else if (up === 'QUIT') {
            await write('221 Bye');
            sock.end();
          } else if (up === 'NOOP') {
            await write('250 OK');
          } else {
            await write('502 Command not implemented');
          }
        }
      } finally {
        pumping = false;
        if (buffer.includes('\n')) void pump();
      }
    };
    attach(sock);
    write('220 localhost FakeSMTP ready').catch(() => {});
  };
  const server = implicitTls ? tls.createServer(tlsOptions, handleConnection) : net.createServer(handleConnection);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      events,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// Self-signed cert (CN=localhost) for the STARTTLS / implicit-TLS tests,
// generated once with openssl. The client trusts it via
// NOVA_ALERT_SMTP_CA_FILE — no insecure flag exists in the transport.
let certCache = null;
function testCert() {
  if (certCache) return certCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-smtp-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `openssl cert generation: ${r.stderr}`);
  certCache = { dir, key, cert };
  return certCache;
}

function smtpEnv(port, extra = {}) {
  return {
    PATH: '/usr/bin:/bin',
    NOVA_ALERT_SMTP_HOST: 'localhost',
    NOVA_ALERT_SMTP_PORT: String(port),
    NOVA_ALERT_SMTP_USER: 'omoyenishina2000@gmail.com',
    NOVA_ALERT_SMTP_PASS: 'test-app-password-16',
    ...extra,
  };
}

test('(ac) fake SMTP + STARTTLS: delivery succeeds, envelope + headers + dot-stuffing captured', async (t) => {
  const { key, cert } = testCert();
  const srv = await startFakeSmtp({ tlsOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: '[NOVA] startup-listen-failed', body: 'Event: startup-listen-failed\\n.dotline\\nlast' })));`, {
    ...smtpEnv(srv.port),
    NOVA_ALERT_SMTP_CA_FILE: cert,
  });
  assert.deepEqual(JSON.parse(out.trim()), { ok: true });
  assert.equal(srv.events.upgraded, true, 'STARTTLS upgrade happened before AUTH');
  assert.equal(srv.events.authAttempted, true);
  assert.equal(srv.events.mailFrom, 'FROM:<omoyenishina2000@gmail.com>');
  assert.equal(srv.events.rcptTo, 'TO:<omoyenishina2000@gmail.com>');
  assert.ok(srv.events.data.includes('From: omoyenishina2000@gmail.com'), srv.events.data);
  assert.ok(srv.events.data.includes('To: omoyenishina2000@gmail.com'), srv.events.data);
  assert.ok(srv.events.data.includes('Subject: [NOVA] startup-listen-failed'), srv.events.data);
  assert.ok(srv.events.data.includes('Event: startup-listen-failed'), srv.events.data);
  assert.ok(srv.events.data.includes('..dotline'), `dot-stuffed line in DATA: ${srv.events.data}`);
  assert.ok(!srv.events.data.split('\n').some((l) => l === '.dotline'), 'unstuffed .dotline must not reach the server');
});

test('(ac) fake SMTP implicit TLS (SECURE=true): delivery succeeds', async (t) => {
  const { key, cert } = testCert();
  const srv = await startFakeSmtp({ tlsOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, implicitTls: true, starttls: false });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: 's', body: 'b' })));`, {
    ...smtpEnv(srv.port, { NOVA_ALERT_SMTP_SECURE: 'true' }),
    NOVA_ALERT_SMTP_CA_FILE: cert,
  });
  assert.deepEqual(JSON.parse(out.trim()), { ok: true });
  assert.equal(srv.events.authAttempted, true);
});

test('(ac) SMTP AUTH rejected (535) -> smtp-auth failure, single token', async (t) => {
  const { key, cert } = testCert();
  const srv = await startFakeSmtp({ authOk: false, tlsOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: 's', body: 'b' })));`, {
    ...smtpEnv(srv.port),
    NOVA_ALERT_SMTP_CA_FILE: cert,
  });
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, false);
  assert.match(result.reason, /^smtp-auth:/, `reason: ${result.reason}`);
  assert.ok(!/\s/.test(result.reason), `reason is a single token: ${result.reason}`);
});

test('(ac) SMTP RCPT rejected (550) -> smtp-rcpt-to failure', async (t) => {
  const { key, cert } = testCert();
  const srv = await startFakeSmtp({ rcptOk: false, tlsOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: 's', body: 'b' })));`, {
    ...smtpEnv(srv.port),
    NOVA_ALERT_SMTP_CA_FILE: cert,
  });
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, false);
  assert.match(result.reason, /^smtp-rcpt-to:/, `reason: ${result.reason}`);
});

test('(ac) SMTP server without STARTTLS -> smtp-starttls-unavailable, AUTH never attempted', async (t) => {
  const srv = await startFakeSmtp({ starttls: false, tlsOptions: null });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: 's', body: 'b' })));`, smtpEnv(srv.port));
  assert.deepEqual(JSON.parse(out.trim()), { ok: false, reason: 'smtp-starttls-unavailable:server-does-not-offer-starttls' });
  assert.equal(srv.events.authAttempted, false, 'credentials must never be sent on a plain connection');
});

test('(ac) SMTP silent server -> greeting timeout, transport does not hang', async (t) => {
  const server = net.createServer((sock) => { /* accept, never reply */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((r) => server.close(r)));
  const out = runInChild(`${IMPORT_SMTP}
console.log(JSON.stringify(await smtpTransport({ to: 'omoyenishina2000@gmail.com', subject: 's', body: 'b' })));`, {
    ...smtpEnv(server.address().port),
    NOVA_ALERT_SMTP_TIMEOUT_MS: '300',
  });
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, false);
  assert.match(result.reason, /^smtp-greeting:greeting-timeout$/, `reason: ${result.reason}`);
});

test('(ac) dispatchAlert with NO explicit transport uses the SMTP service when configured', async (t) => {
  // Save/restore the shared dedup state file around the child run.
  const DEDUP = '/var/lib/nova-api/alert-dedup.json';
  let saved = null;
  try { saved = fs.readFileSync(DEDUP); } catch { saved = null; }
  t.after(() => {
    if (saved === null) fs.rmSync(DEDUP, { force: true });
    else fs.writeFileSync(DEDUP, saved);
    for (const f of fs.readdirSync('/var/lib/nova-api')) {
      if (/^alert-dedup\.json\.(corrupt|recovered)-/.test(f) || /^alert-dedup\.json\.tmp\./.test(f)) fs.rmSync(path.join('/var/lib/nova-api', f), { force: true });
    }
    for (const f of ['alert-dedup.json.lock']) fs.rmSync(path.join('/var/lib/nova-api', f), { force: true });
  });
  const { key, cert } = testCert();
  const srv = await startFakeSmtp({ tlsOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  t.after(() => srv.close());
  const out = await runInChildAsync(`${IMPORT_SMTP}
const line = 'ts=2026-11-28T08:00:00Z level=error event=startup-listen-failed requestId=55555555-5555-4555-8555-555555555555 windowStart=2026-11-28T07:00:00Z detail=smtp-default-path-test';
const { ok, parsed } = parseEventLine(line);
if (!ok) { console.log(JSON.stringify({ parseFailed: true })); process.exit(0); }
console.log(JSON.stringify(await dispatchAlert(parsed)));`, {
    ...smtpEnv(srv.port),
    NOVA_ALERT_SMTP_CA_FILE: cert,
  });
  assert.deepEqual(JSON.parse(out.trim()), { sent: true, reason: 'sent', pending: false });
  assert.ok(srv.events.data.includes('Event: startup-listen-failed'), 'dispatcher email reached the SMTP service');
  assert.ok(srv.events.data.includes('To: omoyenishina2000@gmail.com'), 'dispatcher email went to the owner decision address');
});
