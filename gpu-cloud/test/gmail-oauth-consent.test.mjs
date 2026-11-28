// gmail-oauth-consent.test.mjs — attended consent helper for the Gmail API
// alert transport (OQ-1 path B). The refresh token is written directly
// into the credential file by the script and must NEVER appear in its
// stdout/stderr — the exchange test asserts that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';

// Async spawn: the fake token server lives in THIS process, so the child
// must run async — a spawnSync child would deadlock (the child waits for
// the server's reply while the parent is blocked waiting for the child).
function runScriptAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'gpu-cloud/scripts/gmail-oauth-consent.mjs');

function startFakeTokenServer({ refreshToken = 'fake-refresh-token-1' } = {}) {
  const events = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      events.requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'fake-access-token-1',
        refresh_token: refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.send',
        expires_in: 3599,
        token_type: 'Bearer',
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    events,
    close: () => new Promise((r) => server.close(r)),
  })));
}

test('buildAuthUrl: Google auth endpoint, send-only scope, offline access, localhost redirect', async () => {
  const { buildAuthUrl, GMAIL_SEND_SCOPE } = await import(SCRIPT);
  assert.equal(GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.send');
  const url = buildAuthUrl({ clientId: 'test-client.apps.googleusercontent.com', state: 'statetest123' });
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.send');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), 'statetest123');
});

test('storeInEnvFile: appends once, replaces on re-store, preserves other lines', async () => {
  const { storeInEnvFile, readEnvFile } = await import(SCRIPT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-consent-'));
  const envFile = path.join(dir, 'api.env');
  fs.writeFileSync(envFile, 'NOVA_ALERT_GMAIL_CLIENT_ID=test-client\nOTHER_KEY=keep-me\n');
  storeInEnvFile(envFile, 'NOVA_ALERT_GMAIL_REFRESH_TOKEN', 'token-one');
  let parsed = readEnvFile(envFile);
  assert.equal(parsed.NOVA_ALERT_GMAIL_REFRESH_TOKEN, 'token-one');
  assert.equal(parsed.OTHER_KEY, 'keep-me');
  assert.equal(parsed.NOVA_ALERT_GMAIL_CLIENT_ID, 'test-client');
  storeInEnvFile(envFile, 'NOVA_ALERT_GMAIL_REFRESH_TOKEN', 'token-two');
  parsed = readEnvFile(envFile);
  assert.equal(parsed.NOVA_ALERT_GMAIL_REFRESH_TOKEN, 'token-two');
  const occurrences = fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.startsWith('NOVA_ALERT_GMAIL_REFRESH_TOKEN=')).length;
  assert.equal(occurrences, 1, 'exactly one refresh-token line after re-store');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exchange CLI: code exchanged, refresh token stored in the file, never printed', async (t) => {
  const srv = await startFakeTokenServer();
  t.after(() => srv.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'api.env');
  fs.writeFileSync(envFile, 'NOVA_ALERT_GMAIL_CLIENT_ID=test-client\n');
  const r = await runScriptAsync(['exchange', 'http://localhost/?code=fake-code-123&state=whatever'], {
    ...process.env,
    NOVA_ALERT_GMAIL_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    NOVA_ALERT_GMAIL_CLIENT_SECRET: 'test-client-secret',
    NOVA_ALERT_GMAIL_TOKEN_URL: `http://127.0.0.1:${srv.port}/token`,
    NOVA_API_ENV: envFile,
  });
  assert.equal(r.status, 0, `exchange exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /EXCHANGE OK/);
  assert.match(r.stdout, /REFRESH_TOKEN STORED/);
  assert.ok(!r.stdout.includes('fake-refresh-token-1'), 'the refresh token value must never appear on stdout');
  assert.ok(!r.stderr.includes('fake-refresh-token-1'), 'the refresh token value must never appear on stderr');
  assert.ok(r.stdout.includes('https://www.googleapis.com/auth/gmail.send'), 'the granted scope is reported');
  const stored = fs.readFileSync(envFile, 'utf8');
  assert.ok(stored.includes('NOVA_ALERT_GMAIL_REFRESH_TOKEN=fake-refresh-token-1'), 'the refresh token reached the credential file');
  assert.equal(srv.events.requests.length, 1);
  const form = srv.events.requests[0].body;
  assert.ok(form.includes('grant_type=authorization_code'), 'code grant used');
  assert.ok(form.includes('code=fake-code-123'), 'the pasted code was exchanged');
  assert.ok(form.includes('redirect_uri=http%3A%2F%2Flocalhost'), 'localhost redirect used');
});

test('exchange CLI: owner-denied redirect URL -> exit 1, nothing stored', async (t) => {
  const srv = await startFakeTokenServer();
  t.after(() => srv.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'api.env');
  fs.writeFileSync(envFile, '');
  const r = spawnSync(process.execPath, [SCRIPT, 'exchange', 'http://localhost/?error=access_denied&state=x'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NOVA_ALERT_GMAIL_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      NOVA_ALERT_GMAIL_CLIENT_SECRET: 'test-client-secret',
      NOVA_ALERT_GMAIL_TOKEN_URL: `http://127.0.0.1:${srv.port}/token`,
      NOVA_API_ENV: envFile,
    },
  });
  assert.notEqual(r.status, 0, 'denied consent exits non-zero');
  assert.equal(srv.events.requests.length, 0, 'no exchange was attempted');
  assert.equal(fs.readFileSync(envFile, 'utf8').trim(), '', 'nothing was stored');
});

test('auth-url-only CLI: prints AUTH_URL + STATE, exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'auth-url-only'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NOVA_ALERT_GMAIL_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      NOVA_ALERT_GMAIL_CLIENT_SECRET: 'test-client-secret',
    },
  });
  assert.equal(r.status, 0, `auth-url-only exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /AUTH_URL: https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(r.stdout, /STATE: [0-9a-f]{32}/);
  assert.ok(r.stdout.includes('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send'), 'send-only scope in the URL');
});
