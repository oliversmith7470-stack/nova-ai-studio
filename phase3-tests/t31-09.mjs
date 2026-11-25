// T31-09 — Interrupted storage deletion is recoverable.
// Rev 3.2 §B-3.2.9.2: delete an object; crash the sweeper mid-deletion
// (after the references, before the chunks); restart; the deletion
// resumes from the intent, completes without error, the object is fully
// gone, and the daily counter increments by exactly one.
//
// The deletion-intent journal, the sweeper, and the daily O-23 counter
// have NO runnable implementation in this repo: "deletion-intent"
// occurs nowhere in gpu-cloud/src or _worker.js, and no sweep timer
// exists. The crash-and-resume scenario cannot be staged, so the
// assertions are BLOCKED with that evidence. One observable deviation
// is recorded as a note: the existing storage engine deletes in the
// order chunks -> index -> refs, while the design requires
// refs -> chunks -> index (refs first so no redemption of a partially
// deleted object can occur).
import fs from 'node:fs';
import path from 'node:path';
import { REPO, Recorder, runMain, seamPresent } from './harness.mjs';

const TITLE = 'Interrupted storage deletion is recoverable';

export async function run(rec) {
  const intentSeam = seamPresent(/deletion-intent|deletionIntent/);
  const sweepSeam = seamPresent(/startStorageSweep|sweep.*15|setInterval/);
  rec.note(`seam probe: deletion-intent text in ${intentSeam ?? 'nothing'}; sweep-timer text in ${sweepSeam ?? 'nothing'}`);
  const engine = fs.readFileSync(path.join(REPO, 'gpu-cloud', 'src', 'storage', 'engine.js'), 'utf8');
  const del = engine.match(/async delete\(namespace, objectId\) \{[\s\S]*?\n  \}/)?.[0] ?? '(delete method not found)';
  rec.note(`existing storage engine delete() order (from gpu-cloud/src/storage/engine.js): ${del.replace(/\s+/g, ' ').slice(0, 300)}`);
  rec.blocked('D1', 'deletion resumes from the intent after a mid-deletion crash and completes without error', 'no deletion-intent journal exists in this repo: "deletion-intent" occurs nowhere in gpu-cloud/src or _worker.js, and no sweeper hosts the deletion');
  rec.blocked('D2', 'the object is fully gone after the resumed deletion', 'same missing seam as D1');
  rec.blocked('D3', 'the daily counter increments by exactly one for the completed intent (zero while pending)', 'no daily O-23 counter implementation exists in this repo');
  rec.blocked('D4', 'deletion of an already-deleted component is a no-op, never an error', 'same missing seam as D1 — the resume/idempotency path is unimplemented');
  rec.note('OBSERVATION (not a verdict): the existing engine.delete() deletes chunks, then the index entry, then the refs. The design (§B-3.2.9.2) requires refs first, chunks second, index last. If the sweeper is built on this engine method unchanged, the ordering requirement is violated.');
  rec.note('UPDATE 25 Nov ~18:21 WAT (Q3 APPROVED, retention enabled/30 days): the Worker-side D1 analogue of the §B-3.2.9 ordering is now implemented in _worker.js handleScheduled — scene rows first, parent job row last, and a parent left behind by an interrupted deletion is resumed by the next sweep (fallback age from jobs.data $.updatedAt) — covered by the RET.1g/RET.1h checks in cloudflare-deploy/test_worker_phase3.mjs. The STORAGE-side deletion-intent journal itself (refs/chunks/index components, the daily O-23 counter, the sweeper) is still unimplemented and belongs to the API-process workstream (gpu-cloud/src); D1–D4 above therefore stay BLOCKED, unchanged by this change.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-09', TITLE, run);
}
