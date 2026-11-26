// NOVA AI Studio — Phase 3 API process: host-local operator CLI.
//
// Rev 2 §11.6: there is NO admin HTTP endpoint on the API process.
// Operator actions (revocation, manual resolution, scene-set repair,
// sweep, file-report, status) are performed by this script on the API
// host itself, by an operator who can read the API secret and the
// api-state file. Never expose this script over HTTP. Never run it
// from a browser. The API process must be STOPPED before any command
// that mutates the manager store or the api-state file runs, except
// `status` (read-only).
//
// Usage:
//   node gpu-cloud/src/api-admin.mjs --data-dir <dir> <command> [args]
//
// Commands:
//   status
//     Read-only summary: mode, journal counts, pending intents,
//     reconciliation state, today's O-23 counter.
//   revoke-secret --secret <value> [--revoked-by <name>] [--reason <text>]
//     Record a revocation in the manager store + api-state file.
//     The operator must then: set the new secret, update the Worker
//     secret, and verify with a signed health-check + an old-secret
//     request that is rejected 401 (Rev 3.2 §B-3.2.4.2).
//   resolve --execution-id <id> --decision confirm-accepted|fail
//           --evidence '{"executorState":"accepted"}'
//     Manual resolution (Rev 3.2 §B-3.2.7.3). confirm-accepted requires
//     executor evidence of accepted/running/completed; fail requires
//     never-received evidence or unreachable-after-escalation.
//   repair-scene-set --job-id <id>
//     Operator repair of an incomplete scene set (Rev 3.4 §C-3.4.2.2).
//   sweep-now
//     Run one O-23 sweep now (catch-up ordering applies).
//   file-report --execution-id <id> --output <path>
//     Deliver a completed executor output for an execution (operator
//     channel; the executor normally reports via fileReport itself).
//     The file must pass the §18 MP4 validation before it is stored.

import { createApiServer } from './api-server.js';
import { DEFAULT_API_DATA_DIR } from './api-server.js';
import { readFile } from 'node:fs/promises';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) args[key.slice(0, eq)] = key.slice(eq + 1);
      else args[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.error(`Usage: node gpu-cloud/src/api-admin.mjs [--data-dir <dir>] <command> [args]

Commands: status | revoke-secret | resolve | repair-scene-set | sweep-now | file-report
Stop the API process before any command except status. See the header of this file.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (!command) { usage(); process.exit(2); }
  const dataDir = args['data-dir'] ?? process.env.NOVA_API_DATA_DIR ?? DEFAULT_API_DATA_DIR;
  const mode = process.env.NOVA_API_MODE ?? 'controlled-test';
  const secret = process.env.NOVA_API_SECRET ?? '';
  if (!secret && command !== 'status') {
    console.error('NOVA_API_SECRET is required for mutating commands.');
    process.exit(2);
  }

  // Mutating commands run against the manager store WITHOUT starting
  // the HTTP server and WITHOUT starting a timer; the fake executor is
  // still registered in controlled-test mode so the manager can resolve
  // in-flight jobs. The process must otherwise be stopped (this script
  // owns the store while it runs).
  const api = createApiServer({
    mode,
    secret: secret || 'status-only-placeholder',
    dataDir,
    d1Client: {
      async d1Apply() { throw new Error('api-admin: no Worker origin configured — D1 mutations are unavailable'); },
      async d1Read() { throw new Error('api-admin: no Worker origin configured — D1 reads are unavailable'); },
      async getJob() { throw new Error('api-admin: no Worker origin configured'); },
      async listScenes() { throw new Error('api-admin: no Worker origin configured'); },
      async listPendingJobs() { return []; },
      async listExpiredScenes() { return []; },
    },
    workerOrigin: 'http://localhost',
  });

  try {
    if (command === 'status') {
      const s = api.apiState.state;
      const journal = Object.values(s.dispatchJournal || {});
      const counts = {};
      for (const e of journal) counts[e.state] = (counts[e.state] ?? 0) + 1;
      console.log(JSON.stringify({
        mode: api.config.mode,
        journal: { total: journal.length, byState: counts },
        pendingDeletionIntents: Object.values(s.deletionIntents || {}).filter((i) => i.state === 'pending').length,
        reconciliation: Object.keys(s.reconciliation || {}).length,
        incompleteSceneSets: Object.keys(s.incompleteSceneSets || {}).length,
        cleanupCounters: s.cleanupCounters ?? {},
        lastSweep: s.lastSweepSummary ?? null,
        lastReconciliation: s.lastReconciliationSummary ?? null,
        operatorLog: (s.operatorLog || []).slice(-5),
      }, null, 2));
      return;
    }
    if (command === 'revoke-secret') {
      if (!args.secret) { console.error('--secret is required'); process.exit(2); }
      const out = api.revokeSecret({
        secret: args.secret,
        revokedBy: args['revoked-by'] ?? 'operator',
        reason: args.reason ?? 'manual revocation',
      });
      console.log(JSON.stringify(out, null, 2));
      console.log('Next: set the new secret, update the Worker secret, then verify with a signed health-check and confirm the old secret is rejected 401.');
      return;
    }
    if (command === 'resolve') {
      if (!args['execution-id'] || !args.decision) {
        console.error('--execution-id and --decision are required'); process.exit(2);
      }
      const evidence = args.evidence ? JSON.parse(args.evidence) : {};
      const out = await api.manualResolve({
        executionId: args['execution-id'],
        decision: args.decision,
        evidence,
        operator: args.operator ?? 'operator',
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (command === 'repair-scene-set') {
      if (!args['job-id']) { console.error('--job-id is required'); process.exit(2); }
      const out = await api.repairSceneSet(args['job-id'], { operator: args.operator ?? 'operator' });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (command === 'sweep-now') {
      const out = await api.runSweep({ reason: 'manual' });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (command === 'file-report') {
      if (!args['execution-id'] || !args.output) {
        console.error('--execution-id and --output are required'); process.exit(2);
      }
      const buf = await readFile(args.output);
      const out = await api.fileReport(args['execution-id'], {
        status: 'complete', output: buf, outputName: args.output.split('/').pop(),
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.error(`unknown command ${command}`);
    usage();
    process.exit(2);
  } finally {
    await api.stop();
  }
}

main().catch((err) => {
  console.error('api-admin failed:', err && err.message);
  process.exit(1);
});
