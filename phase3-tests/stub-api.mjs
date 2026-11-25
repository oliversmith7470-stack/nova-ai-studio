// Stub API process for the Phase 3 controlled-test harness.
//
// The Worker calls the API process at NOVA_API_ORIGIN (Rev 2 §3.4/§3.5,
// Rev 3 §C-1.7 — localhost is permitted as the controlled-test origin).
// No real API process exists in this repo, so this minimal in-process
// HTTP server stands in for it. It is a FAITHFUL stand-in, not a mock
// that weakens the tests:
//
// - It verifies the Worker's HMAC signature on every call with the
//   same scheme the Worker uses (§11: X-NOVA-API-SECRET,
//   X-NOVA-SIGNATURE over METHOD\npath\ntimestamp\nonce\nbodyHash,
//   timestamp ±60 s, 32-hex nonce consumed exactly once). A bad
//   signature is 401 — the Worker must sign correctly to proceed.
// - POST /internal/submit creates manager jobs IDEMPOTENTLY on the
//   execution ID (the idempotency key, §5.2): a repeat submit with the
//   same key returns the existing manager job ID and creates nothing.
//   Every creation is appended to the dispatch journal, which tests
//   read directly — "exactly one submission" is counted from the real
//   journal, never asserted from a stubbed counter.
// - GET /internal/status?executionId= answers from the journal
//   (the §C-1.8 execution-level lookup): 404 { absent: true } for an
//   unknown execution, else the journal state + managerJobId. The
//   executor state for an execution can be overridden per test
//   (setExecutorState) to drive the uncertain-submission resolution.
// - It NEVER touches D1. All D1 state is the Worker's, asserted
//   against the real local D1.
// - failMode 'drop' destroys the socket after creating the manager
//   job(s) — the lost-response case (§A-3.1.2.3): the Worker must
//   resolve via the status lookup, never blindly re-submit.
// - failMode 'http500' answers 500 to every submit.
//
// Usage: const stub = createStubApi(); await stub.start();
//   boot({ api: stub }) binds the Worker to it; stub.stop() afterwards.
//   stub.origin is http://localhost:<ephemeral port>.

import http from 'node:http';
import crypto from 'node:crypto';

export const TEST_API_SECRET = 'phase3-test-api-secret-0123456789abcdef';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createStubApi() {
  const managerJobs = new Map(); // executionId -> { managerJobId, state }
  const journal = []; // { executionId, managerJobId, state, at } — one entry per creation
  const seenNonces = new Set();
  const executorStates = new Map(); // executionId -> state override for /internal/status
  let counter = 0;
  let failMode = 'none';
  let authFailures = 0;
  let submitCalls = 0;
  let server = null;
  let port = null;

  function verifyAuth(req, bodyText) {
    const presented = req.headers['x-nova-api-secret'] || '';
    if (presented !== TEST_API_SECRET) return false;
    const signature = req.headers['x-nova-signature'] || '';
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    const nonce = req.headers['x-nova-nonce'] || '';
    if (!/^[0-9a-f]{32}$/i.test(nonce)) return false;
    if (seenNonces.has(nonce)) return false;
    const timestamp = req.headers['x-nova-timestamp'] || '';
    if (!/^[0-9]+$/.test(timestamp)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) return false;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname + url.search;
    const canonical = [req.method, path, timestamp, nonce, sha256Hex(bodyText)].join('\n');
    const expected = crypto.createHmac('sha256', presented).update(canonical, 'utf8').digest('hex');
    if (!timingSafeEqualHex(expected, signature)) return false;
    seenNonces.add(nonce);
    return true;
  }

  function send(res, status, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let bodyText = '';
    try {
      bodyText = await readBody(req);
    } catch {
      res.writeHead(400); res.end(); return;
    }
    if (!verifyAuth(req, bodyText)) {
      authFailures++;
      send(res, 401, { error: 'unauthorised' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/submit') {
      submitCalls++;
      if (failMode === 'http500') {
        send(res, 500, { error: 'stub failure' });
        return;
      }
      let body;
      try {
        body = JSON.parse(bodyText || '{}');
      } catch {
        send(res, 400, { error: 'bad json' });
        return;
      }
      const executions = Array.isArray(body.sceneExecutions) ? body.sceneExecutions : [];
      const managerJobIds = [];
      for (const x of executions) {
        const key = x.idempotencyKey || x.executionId;
        let job = managerJobs.get(key);
        if (!job) {
          counter++;
          job = { managerJobId: `stub-mgr-${counter}`, state: 'dispatched' };
          managerJobs.set(key, job);
          journal.push({ executionId: key, managerJobId: job.managerJobId, state: 'dispatched', at: Date.now() });
        }
        managerJobIds.push(job.managerJobId);
      }
      if (failMode === 'drop') {
        // Job(s) created and journalled; the response is lost.
        req.socket.destroy();
        return;
      }
      send(res, 200, { managerJobIds, dispatchState: 'slot-claimed' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/internal/status') {
      const executionId = url.searchParams.get('executionId');
      const job = executionId ? managerJobs.get(executionId) : undefined;
      if (!job) {
        send(res, 404, { absent: true });
        return;
      }
      send(res, 200, {
        executionId,
        state: executorStates.get(executionId) ?? job.state,
        managerJobId: job.managerJobId,
      });
      return;
    }
    send(res, 404, { error: 'unknown stub route' });
  });

  return {
    get origin() { return `http://localhost:${port}`; },
    get journal() { return journal; },
    get managerJobs() { return managerJobs; },
    get submitCalls() { return submitCalls; },
    get authFailures() { return authFailures; },
    setFailMode(mode) { failMode = mode; },
    setExecutorState(executionId, state) { executorStates.set(executionId, state); },
    submissionsFor(executionId) { return journal.filter((j) => j.executionId === executionId); },
    async start() {
      await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
    },
    async stop() {
      await new Promise((resolve) => { server.close(() => resolve()); });
    },
  };
}
