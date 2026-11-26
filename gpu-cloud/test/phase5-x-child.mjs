// Helper child for the §15 (x) reset-race tests (NOT a test file itself).
// Runs ONE api.start() in its own process and stays listening until SIGTERM.
// NOVA_STARTUP_STATE_DIR must be set in the child's environment BEFORE it
// starts (startup-attempts.js reads it at import time). The parent test
// holds the counter lock, watches for this child's reset flock process,
// performs the interleave mutation, then releases the lock — the child's
// reset then runs against the mutated counter. The reset's flock is a
// synchronous spawnSync inside start(), so the interleave CANNOT be driven
// from inside the API process itself: the event loop is blocked while the
// reset waits, and only a separate process can act in that window.
//
// Usage: node phase5-x-child.mjs <dataDir>
// Prints `LISTENING <port>` on stdout after start() resolves (i.e. after the
// post-listen reset has run). All [api-server] log lines go to stdout/stderr.

import { createApiServer } from '../src/api-server.js';

const dataDir = process.argv[2];
const d1 = {
  async d1Apply() { return {}; },
  async d1Read() { return {}; },
  async getJob() { return null; },
  async listScenes() { return []; },
  async listExpiredScenes() { return []; },
  async listPendingJobs() { return []; },
  async listTerminalJobs() { return []; },
  async listExpiredRateLimits() { return []; },
};
const api = createApiServer({
  mode: 'production',
  secret: 'phase5-x-test-secret',
  d1Client: d1,
  host: '127.0.0.1',
  port: 0,
  dataDir,
  sweepIntervalMs: 60 * 60 * 1000,
  reconcileIntervalMs: 60 * 60 * 1000,
});
const info = await api.start();
console.log(`LISTENING ${info.port}`);
