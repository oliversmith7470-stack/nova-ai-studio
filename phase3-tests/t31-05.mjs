// T31-05 — Executor status independently verifiable.
// Rev 3.2 §B-3.2.3.3: for a known execution ID, getExecutionState
// returns each of the six states (never-received, accepted, running,
// completed, failed, unknown) from the corresponding executor
// condition, and the state is obtained from the executor status query —
// never from the fileReport channel.
//
// getExecutionState has NO runnable implementation in this repo: the
// function name occurs nowhere in _worker.js or gpu-cloud/src, the
// LTX executor module (gpu-cloud/src/engines/ltx-executor.js, Rev 2
// §7) does not exist (engines/ holds only fun-inp.js), and the Kaggle
// kernel status query the design relies on is explicitly unverified
// (§B-3.2.18). This test therefore records the missing seam as
// evidence and marks every assertion BLOCKED — it does not invent a
// substitute executor.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, Recorder, runMain, seamPresent } from './harness.mjs';

const TITLE = 'Executor status independently verifiable';

export async function run(rec) {
  const states = ['never-received', 'accepted', 'running', 'completed', 'failed', 'unknown'];
  const seam = seamPresent(/getExecutionState/);
  const ltxExecutor = fs.existsSync(path.join(REPO, 'gpu-cloud', 'src', 'engines', 'ltx-executor.js'));
  const enginesDir = fs.readdirSync(path.join(REPO, 'gpu-cloud', 'src', 'engines'));
  rec.note(`engines dir contents: ${enginesDir.join(', ')}; ltx-executor.js present: ${ltxExecutor}`);
  for (const s of states) {
    rec.blocked(`E-${s}`, `getExecutionState returns "${s}" from the corresponding executor condition`, seam ? `getExecutionState text found in ${seam} (unexpected — needs a runnable check)` : 'no getExecutionState implementation exists in this repo');
  }
  rec.blocked('E-src', 'the state is obtained from the executor status query, never from the fileReport channel', 'no status-query implementation exists to distinguish from fileReport; the Kaggle kernel status query itself is unverified per §B-3.2.18');
  rec.note('The fileReport channel exists in the design as the completion report only (Rev 2 §7). Nothing in this repo reads executor status from it either — but with no status query at all, the "never from fileReport" assertion has no runnable subject and is BLOCKED, not passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-05', TITLE, run);
}
