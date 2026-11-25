// T31-10 — Reconciliation continues without an API restart.
// Rev 3.2 §B-3.2.7.2: the executor becomes unreachable and the job is
// marked reconciliation-needed; the API process is NOT restarted; the
// periodic timer (every 15 minutes, independent of the sweep timer)
// re-examines the job, and when the executor becomes reachable again
// the job resolves per the case table.
//
// No reconciliation timer exists in this repo: gpu-cloud/src/
// reconcile.js exports only reconcileReports() (pure report-matching,
// no timer, no executor queries, no list-pending-jobs), and no
// 15-minute timer or getExecutionState exists anywhere. The scenario
// cannot be staged, so the assertions are BLOCKED with that evidence.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, Recorder, runMain, seamPresent } from './harness.mjs';

const TITLE = 'Reconciliation continues without an API restart';

export async function run(rec) {
  const timerSeam = seamPresent(/reconciliation.*timer|15.*minute|900000|setInterval/);
  const pendingSeam = seamPresent(/list-pending-jobs|reconciliation-needed/);
  const reconcileSrc = fs.readFileSync(path.join(REPO, 'gpu-cloud', 'src', 'reconcile.js'), 'utf8');
  const exports = [...reconcileSrc.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  rec.note(`seam probe: reconciliation-timer text in ${timerSeam ?? 'nothing'}; list-pending-jobs/reconciliation-needed text in ${pendingSeam ?? 'nothing'}`);
  rec.note(`gpu-cloud/src/reconcile.js exports: ${exports.join(', ') || '(none)'} — pure functions, no timer, no executor query`);
  rec.blocked('C1', 'the periodic timer re-examines a reconciliation-needed job without an API restart', 'no reconciliation timer exists: reconcile.js has no timer and no executor query; the 15-minute interval is specified, not implemented');
  rec.blocked('C2', 'when the executor becomes reachable again the job resolves per the case table', 'same missing seam as C1 — there is no getExecutionState to become reachable again');
  rec.blocked('C3', 'a job in reconciliation-needed for 24 hours is escalated (operator-log entry + sweep-report flag) while both reservations remain held', 'same missing seam as C1, plus no operator log or sweep report exists');
  rec.blocked('C4', 'the reconciliation timer and the sweep timer are independent (a failing sweep does not stop reconciliation)', 'neither timer exists in this repo');
  rec.note('A manual confirm-accepted without executor evidence being refused, and a manual fail releasing both reservations exactly once (§B-3.2.7.3), likewise need the operator CLI surface (§11.6), which does not exist in this repo.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-10', TITLE, run);
}
