// gmail-oauth-consent.mjs — attended OAuth consent for the NOVA Gmail API
// alert transport (OQ-1 path B, 28 Nov 2026).
//
// The Gmail API transport needs its own OAuth client + refresh token on
// the host. This script runs the attended consent flow, in the same
// pattern as the NEXORA OAuth rounds (AUTH_URL -> owner signs in and
// consents -> owner pastes the redirect URL back -> code exchanged
// shell-side immediately; codes live minutes, single-use).
//
//   node gmail-oauth-consent.mjs auth-url
//     Prints AUTH_URL and waits on stdin for the pasted redirect URL.
//     On exchange success the refresh token is written DIRECTLY into
//     the host credential file (/etc/nova-api/api.env, or $NOVA_API_ENV)
//     as NOVA_ALERT_GMAIL_REFRESH_TOKEN — it is NEVER printed, never
//     returned in any output. Only "REFRESH_TOKEN STORED" + safe
//     metadata (scopes, expiry) is printed.
//
//   node gmail-oauth-consent.mjs auth-url-only
//     Prints AUTH_URL and exits (for a caller that drives the exchange
//     itself). The state is printed alongside so the caller can verify
//     it; the state is single-use and bound to this invocation only
//     when the same process also performs the exchange — for
//     `auth-url-only` the caller MUST verify the state itself.
//
//   node gmail-oauth-consent.mjs exchange '<redirect-url>'
//     Exchanges a pasted redirect URL for tokens and stores the refresh
//     token as above. The state check is skipped in this mode (the URL
//     was produced by a different process) — the caller must have
//     verified the state, or accepted the risk; the code is still
//     single-use and short-lived.
//
// Client credentials come from the environment (NOVA_ALERT_GMAIL_CLIENT_ID
// / NOVA_ALERT_GMAIL_CLIENT_SECRET) or from the api.env file itself.
// Scope is gmail.send ONLY (send-only — cannot read mail).
// Redirect URI is http://localhost (loopback; the owner pastes the full
// redirect URL back, the cloud browser rejects loopback navigation).
// Client type: Desktop app (no redirect URI needs pre-registering).
//
// The token endpoint is overridable for tests only via
// NOVA_ALERT_GMAIL_TOKEN_URL (plain http accepted only for a loopback
// host — same rule as the dispatcher).
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, chownSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
export const GMAIL_REDIRECT_URI = 'http://localhost';
export const API_ENV_DEFAULT = '/etc/nova-api/api.env';

// Reads KEY=VALUE lines (no shell, no expansion). Later lines win.
export function readEnvFile(path) {
  const out = {};
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return out; throw e; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadClientCredentials({ apiEnvPath = process.env.NOVA_API_ENV ?? API_ENV_DEFAULT } = {}) {
  const fromFile = readEnvFile(apiEnvPath);
  const clientId = process.env.NOVA_ALERT_GMAIL_CLIENT_ID ?? fromFile.NOVA_ALERT_GMAIL_CLIENT_ID ?? '';
  const clientSecret = process.env.NOVA_ALERT_GMAIL_CLIENT_SECRET ?? fromFile.NOVA_ALERT_GMAIL_CLIENT_SECRET ?? '';
  return { clientId, clientSecret, apiEnvPath };
}

export function buildAuthUrl({ clientId, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: 'code',
    scope: GMAIL_SEND_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
}

function tokenEndpoint() {
  const raw = (process.env.NOVA_ALERT_GMAIL_TOKEN_URL ?? '').trim();
  if (raw === '') return GMAIL_TOKEN_URL_DEFAULT;
  let url;
  try { url = new URL(raw); } catch { throw new Error('gmail-oauth-consent: NOVA_ALERT_GMAIL_TOKEN_URL is not a URL'); }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('gmail-oauth-consent: token endpoint must be https, or http to a loopback host');
  }
  return url.href.replace(/\/$/, '');
}

function postForm(url, form) {
  const mod = url.startsWith('https://') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(form)) },
      signal: AbortSignal.timeout(30000),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text === '' ? null : JSON.parse(text); } catch { return reject(new Error(`token endpoint returned non-JSON (http ${res.statusCode ?? 0})`)); }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(form);
    req.end();
  });
}

// Exchanges an authorisation code for tokens. Returns { accessToken,
// refreshToken, scope, expiresIn }. The refresh token is the value the
// caller must store in the host credential file — never print it.
export async function exchangeCode({ code, clientId, clientSecret }) {
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: GMAIL_REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();
  const { status, json } = await postForm(tokenEndpoint(), form);
  if (status !== 200 || !json || typeof json.access_token !== 'string') {
    throw new Error(`code exchange failed (http ${status})`);
  }
  if (typeof json.refresh_token !== 'string' || json.refresh_token === '') {
    throw new Error('code exchange returned no refresh_token — re-consent with prompt=consent (access_type=offline) and retry');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    scope: typeof json.scope === 'string' ? json.scope : '',
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
  };
}

// Upserts ONE key in the api.env file (preserves every other line and
// its order; appends when absent). Creates the file (0600 root) when
// missing. The value is written, never returned or printed.
export function storeInEnvFile(apiEnvPath, key, value) {
  let lines = [];
  try { lines = readFileSync(apiEnvPath, 'utf8').split('\n'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let replaced = false;
  lines = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) { replaced = true; return `${key}=${value}`; }
    return line;
  });
  if (!replaced) lines.push(`${key}=${value}`);
  mkdirSync(dirname(apiEnvPath), { recursive: true });
  writeFileSync(apiEnvPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(apiEnvPath, 0o640); } catch { /* best-effort: filesystem may not support it */ }
  try { chownSync(apiEnvPath, 0, 0); } catch { /* best-effort: not root */ }
}

function parseRedirectUrl(line) {
  let url;
  try { url = new URL(line.trim()); } catch { return { ok: false, reason: 'not-a-url' }; }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return { ok: false, reason: `owner-denied-or-error:${error}` };
  if (!code) return { ok: false, reason: 'no-code-in-url' };
  return { ok: true, code, state };
}

async function runAuthUrl() {
  const { clientId, clientSecret, apiEnvPath } = loadClientCredentials();
  if (!clientId || !clientSecret) {
    console.error('ERROR: NOVA_ALERT_GMAIL_CLIENT_ID / NOVA_ALERT_GMAIL_CLIENT_SECRET are not set (env or api.env). Create the Desktop-app OAuth client on the dedicated NOVA Cloud project first.');
    process.exit(1);
  }
  const state = randomBytes(16).toString('hex');
  const url = buildAuthUrl({ clientId, state });
  console.log(`AUTH_URL: ${url}`);
  console.log('READY: open the URL, sign in as omoyenishina2000@gmail.com, consent to send mail only, then paste the redirect URL back (one line) and press Enter.');
  const line = await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) { process.stdin.pause(); resolve(buf.split('\n')[0]); }
    });
    process.stdin.on('end', () => resolve(buf.split('\n')[0] ?? ''));
  });
  if (!line.trim()) { console.error('ABORTED: no redirect URL received.'); process.exit(1); }
  const parsed = parseRedirectUrl(line);
  if (!parsed.ok) { console.error(`ERROR: ${parsed.reason}.`); process.exit(1); }
  if (parsed.state !== state) { console.error('ERROR: state mismatch; not exchanging.'); process.exit(1); }
  let tokens;
  try {
    tokens = await exchangeCode({ code: parsed.code, clientId, clientSecret });
  } catch (e) {
    console.error(`EXCHANGE FAILED: ${e.message}`);
    process.exit(1);
  }
  storeInEnvFile(apiEnvPath, 'NOVA_ALERT_GMAIL_REFRESH_TOKEN', tokens.refreshToken);
  console.log(`EXCHANGE OK: access token length ${tokens.accessToken.length}, scopes "${tokens.scope}", expires_in ${tokens.expiresIn ?? 'unknown'}.`);
  console.log(`REFRESH_TOKEN STORED in ${apiEnvPath} as NOVA_ALERT_GMAIL_REFRESH_TOKEN (value not shown).`);
}

async function runAuthUrlOnly() {
  const { clientId, clientSecret } = loadClientCredentials();
  if (!clientId || !clientSecret) {
    console.error('ERROR: NOVA_ALERT_GMAIL_CLIENT_ID / NOVA_ALERT_GMAIL_CLIENT_SECRET are not set (env or api.env).');
    process.exit(1);
  }
  const state = randomBytes(16).toString('hex');
  console.log(`AUTH_URL: ${buildAuthUrl({ clientId, state })}`);
  console.log(`STATE: ${state}`);
}

async function runExchange(redirectUrl) {
  const { clientId, clientSecret, apiEnvPath } = loadClientCredentials();
  if (!clientId || !clientSecret) {
    console.error('ERROR: NOVA_ALERT_GMAIL_CLIENT_ID / NOVA_ALERT_GMAIL_CLIENT_SECRET are not set (env or api.env).');
    process.exit(1);
  }
  const parsed = parseRedirectUrl(redirectUrl);
  if (!parsed.ok) { console.error(`ERROR: ${parsed.reason}.`); process.exit(1); }
  let tokens;
  try {
    tokens = await exchangeCode({ code: parsed.code, clientId, clientSecret });
  } catch (e) {
    console.error(`EXCHANGE FAILED: ${e.message}`);
    process.exit(1);
  }
  storeInEnvFile(apiEnvPath, 'NOVA_ALERT_GMAIL_REFRESH_TOKEN', tokens.refreshToken);
  console.log(`EXCHANGE OK: access token length ${tokens.accessToken.length}, scopes "${tokens.scope}", expires_in ${tokens.expiresIn ?? 'unknown'}.`);
  console.log(`REFRESH_TOKEN STORED in ${apiEnvPath} as NOVA_ALERT_GMAIL_REFRESH_TOKEN (value not shown).`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [,, op, ...args] = process.argv;
  if (op === 'auth-url') { await runAuthUrl(); }
  else if (op === 'auth-url-only') { await runAuthUrlOnly(); }
  else if (op === 'exchange') {
    if (!args[0]) { console.error('ERROR: exchange needs the pasted redirect URL as its argument.'); process.exit(1); }
    await runExchange(args[0]);
  } else {
    console.error(`ERROR: unknown op: ${op ?? ''} (use auth-url | auth-url-only | exchange '<redirect-url>')`);
    process.exit(1);
  }
}
