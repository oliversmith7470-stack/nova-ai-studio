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
//   node gpu-cloud/src/api-admin.mjs --data-dir <dir> --activation-config-path <path> <command> [args]
//     --activation-config-path overrides the activation.conf location
//     (default /etc/nova-api/activation.conf); useful on a host whose
//     conf lives elsewhere, or for verifying the commands against a
//     staging conf. The file must still pass the §3.3 strict
//     verification (0440, root-owned parent, expected owner/group).
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
//
// Kaggle design v13 (NEXORA connection) operator commands — the API
// process must be STOPPED before any of these runs, like every other
// mutating command above:
//   reconcile-quota --kaggle-remaining-hours <h>
//     Operator reconciliation (§6.2): record the Kaggle-side remaining
//     hours (from `kaggle quota`) so admission can compute Q. Without
//     a valid reconciliation every NEXORA submit is refused
//     'quota-unreconciled'.
//   issue-permit --job-hash <sha256> --max-hours <h>
//                --licence-ref <determination-id>
//                --authorisation-ref <ref> [--expires-at-ms <ms>]
//     Issue a commissioning permit (§3.5, file-based). Refuses while
//     any NOVA-origin job is in orphan-check or held at dispatch
//     (P-15). The permit authorises ONE commissioning job (the
//     canonical hash of its submit body) for at most max-hours.
//   cancel-held --job-id <id> --reason <text>
//     Cancel a job held at dispatch (§6.2). Never blocked by halt /
//     kill-switch / pause; the hold reason is the audit evidence.
//     Releases the hours, slot, and storage reservations.
//   record-revisit-decision --kind <kind> [--detail <text>]
//     Record a revisit decision (§5.4) so a live NEXORA halt may be
//     cleared. Kinds: initial-declaration | kaggle-confirmation |
//     channels-kept-off-kaggle. Clearing a halt without one throws.

import { createApiServer } from './api-server.js';
import { DEFAULT_API_DATA_DIR } from './api-server.js';
import { FakeControlledExecutor } from './api-server/fake-executor.js';
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
  | reconcile-quota | issue-permit | cancel-held | record-revisit-decision
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
    activationConfigPath: args['activation-config-path'] ?? undefined,
    // Controlled-test mode requires an explicitly supplied
    // controlled-test executor (Rev 3 §C-1.4) — the fake executor is
    // registered so the manager can resolve in-flight jobs. Production
    // mode takes none (production executors are registered by the
    // service's own startup configuration).
    ...(mode === 'controlled-test' ? { executor: new FakeControlledExecutor() } : {}),
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
    // Kaggle design v13 (§6.2): operator reconciliation — record the
    // Kaggle-side remaining hours (from `kaggle quota`).
    if (command === 'reconcile-quota') {
      const hours = Number(args['kaggle-remaining-hours']);
      if (!Number.isFinite(hours) || hours < 0) {
        console.error('--kaggle-remaining-hours <h> is required (a non-negative number)'); process.exit(2);
      }
      const out = api.reconcileQuota({ kaggleRemainingHours: hours });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    // Kaggle design v13 (§3.5): issue a commissioning permit.
    if (command === 'issue-permit') {
      if (!args['job-hash'] || !args['max-hours'] || !args['licence-ref'] || !args['authorisation-ref']) {
        console.error('--job-hash, --max-hours, --licence-ref and --authorisation-ref are required'); process.exit(2);
      }
      const maxHours = Number(args['max-hours']);
      if (!Number.isFinite(maxHours) || maxHours <= 0) {
        console.error('--max-hours must be a positive number'); process.exit(2);
      }
      const out = api.createCommissioningPermit({
        jobCanonicalHash: args['job-hash'],
        maxHours,
        licenceDeterminationRef: args['licence-ref'],
        authorisationRef: args['authorisation-ref'],
        authorisedBy: args['authorised-by'] ?? 'operator',
        expiresAtMs: args['expires-at-ms'] !== undefined ? Number(args['expires-at-ms']) : undefined,
      });
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(1);
      return;
    }
    // Kaggle design v13 (§6.2): cancel a job held at dispatch.
    if (command === 'cancel-held') {
      if (!args['job-id'] || !args.reason) {
        console.error('--job-id and --reason are required'); process.exit(2);
      }
      const out = api.cancelHeldJob(args['job-id'], {
        reason: args.reason,
        operator: args.operator ?? 'operator',
      });
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(1);
      return;
    }
    // Kaggle design v13 (§5.4): record a revisit decision so a live
    // halt may be cleared.
    if (command === 'record-revisit-decision') {
      if (!args.kind) {
        console.error('--kind is required (initial-declaration | kaggle-confirmation | channels-kept-off-kaggle)'); process.exit(2);
      }
      const out = api.recordRevisitDecision({
        kind: args.kind,
        detail: args.detail ?? '',
        recordedBy: args['recorded-by'] ?? 'operator',
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
