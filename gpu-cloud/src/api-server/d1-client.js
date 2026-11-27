// NOVA AI Studio — Phase 3 API process: D1 client (Worker-sole-D1-access).
//
// Rev 3 §C-1.1: the Pages Worker is the ONLY process that reads or writes
// D1. The API process never holds Cloudflare credentials, never calls the
// D1 API, and never touches a D1 database directly. Every D1 need goes
// through signed Worker endpoints:
//   POST /internal/d1-apply  { requestId, mutations: [...] }
//   GET  /internal/d1-read   ?op=get-job|list-scenes|list-expired-scenes|list-pending-jobs|list-terminal-jobs|list-expired-rate-limits
// Signed with the same HMAC scheme as §11 (API signs, Worker verifies).
// The commit point is the Worker's successful batch response. If a
// callback fails (5xx, timeout, network), the mutation is recorded
// PENDING in the API state store and replayed at startup reconciliation
// (same requestId — the Worker replays by requestId and the mutations
// are idempotent by construction, so a replay cannot double-apply).
// A 401 is NEVER retried: it is a credential error, surfaced to the
// operator log immediately.
//
// Worker-origin rule (Rev 3 §C-1.7, applied here to the API process's
// own configuration of the Worker origin): the origin must be a
// resolvable hostname — a literal IP is rejected, EXCEPT a loopback
// address (127.0.0.1 / ::1 / localhost), which the controlled-test
// harness uses for the local miniflare Worker. A non-loopback literal
// IP is a configuration error and the API process refuses to start.

import { randomUUID } from 'node:crypto';
import { signApiCall } from './auth.js';

export class D1AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'D1AuthError';
    this.code = 'D1_AUTH';
  }
}

export class D1RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'D1RetryableError';
    this.code = 'D1_RETRYABLE';
  }
}

const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;

export function validateWorkerOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error('NOVA_WORKER_ORIGIN is required (the Worker origin for D1 callbacks)');
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`NOVA_WORKER_ORIGIN is not a valid URL: ${origin}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('NOVA_WORKER_ORIGIN must be http(s)');
  }
  const host = url.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (!isLoopback && (IPV4_RE.test(host) || (host.includes(':') && /^[0-9a-fA-F:]+$/.test(host)))) {
    throw new Error('NOVA_WORKER_ORIGIN must be a hostname, not a literal IP address (Rev 3 §C-1.7)');
  }
  return origin.replace(/\/+$/, '');
}

export class HttpD1Client {
  constructor({ workerOrigin, secret, signingSecret = '', fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.origin = validateWorkerOrigin(workerOrigin);
    this.secret = secret;
    // Two-secret request authentication (Rev 4.8 §8): the signing secret
    // keys the HMAC; the transport secret is only presented. A missing
    // signing secret fails at _call time (fail closed) rather than at
    // construction, so a controlled-test server that never calls D1 can
    // still be constructed — but no D1 callback is ever signed without it.
    this.signingSecret = signingSecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _call(method, path, bodyObj) {
    const bodyText = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    if (typeof this.signingSecret !== 'string' || this.signingSecret.length === 0) {
      throw new D1AuthError(
        'NOVA_SIGNING_SECRET is required to sign D1 callbacks (two-secret request authentication, Rev 4.8 §8)',
      );
    }
    const headers = signApiCall(this.secret, this.signingSecret, method, path, bodyText);
    let res;
    try {
      res = await this.fetchImpl(this.origin + path, {
        method,
        headers,
        body: method === 'GET' ? undefined : bodyText,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new D1RetryableError(
        `D1 callback failed: ${err && err.name ? err.name : 'network'}`,
      );
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.status === 401) {
      throw new D1AuthError('Worker rejected the API secret (401) — operator error, never retried');
    }
    if (res.status >= 500 || res.status === 408) {
      throw new D1RetryableError(`D1 callback returned ${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new D1RetryableError(`D1 callback returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return json;
  }

  // Apply a mutation batch. Returns the Worker's { requestId, results }.
  // `requestId` is caller-supplied for replay stability; a fresh UUID is
  // generated when omitted.
  async d1Apply(mutations, requestId = randomUUID()) {
    return this._call('POST', '/internal/d1-apply', { requestId, mutations });
  }

  // Named read operations only (Rev 3 §C-1.1). No arbitrary SQL.
  async d1Read(op, params = {}) {
    const qs = new URLSearchParams({ op, ...params }).toString();
    return this._call('GET', `/internal/d1-read?${qs}`);
  }

  async getJob(jobId) {
    const res = await this.d1Read('get-job', { jobId });
    return res && res.job ? res.job : null;
  }

  async listScenes(jobId) {
    const res = await this.d1Read('list-scenes', { jobId });
    return (res && res.scenes) || [];
  }

  async listExpiredScenes() {
    const res = await this.d1Read('list-expired-scenes');
    return (res && res.scenes) || [];
  }

  async listPendingJobs() {
    const res = await this.d1Read('list-pending-jobs');
    return (res && res.jobs) || [];
  }

  // Retention enumeration (Worker impl-notes §10.4): terminal jobs,
  // oldest-terminal-first. `beforeMs` bounds the eligible set (the
  // sweep passes now - retentionMs); with `beforeMs`, rows with a null
  // terminalAtMs are excluded by the Worker. `limit` defaults to 100
  // on the Worker, clamped 1..500. Returns [{ id, status, terminalAtMs }]
  // — never the full job data blob.
  async listTerminalJobs({ beforeMs, limit } = {}) {
    const params = {};
    if (beforeMs !== undefined && beforeMs !== null) params.beforeMs = String(beforeMs);
    if (limit !== undefined && limit !== null) params.limit = String(limit);
    const res = await this.d1Read('list-terminal-jobs', params);
    return (res && res.jobs) || [];
  }

  // Rate-limit cleanup enumeration (Worker impl-notes §10.4): expired
  // rows (window_end <= now), oldest expiry first. `limit` defaults to
  // 100 on the Worker, clamped 1..500. Returns
  // [{ key, window_start, window_end, count, updated_at }].
  async listExpiredRateLimits({ limit } = {}) {
    const params = {};
    if (limit !== undefined && limit !== null) params.limit = String(limit);
    const res = await this.d1Read('list-expired-rate-limits', params);
    return (res && res.rateLimits) || [];
  }
}
