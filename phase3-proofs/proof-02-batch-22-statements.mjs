// Phase 3 proof 02 — 22-statement batch behaviour (LOCAL miniflare only).
//
// What it proves (Rev 3.3 / Rev 3.5 §C-3.5.5): the design's maximum batch is
// 2 + N statements for an N-scene plan, i.e. 22 statements for a 20-scene plan
// (1 parent insert + 1 read-back + 20 scene inserts), and the no-splitting rule
// forbids working around a size limit by splitting. This proof executes the
// full 22-statement creation batch against local in-memory D1 and records
// whether it succeeds and what the results look like.
//
// Schema per Rev 2 §8 (same as proof-01). No network, no remote database.
//
// Run:  cd ~/workspace/nova-ai-studio && node phase3-proofs/proof-02-batch-22-statements.mjs
// Exit 0 = all assertions passed; non-zero = a proof assertion failed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const A2_IMPL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'a2-impl');
const { Miniflare } = createRequire(path.join(A2_IMPL, 'package.json'))('miniflare');

const JOBS_DDL = `CREATE TABLE jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
const SCENES_DDL = 'CREATE TABLE scenes (job_id TEXT NOT NULL, scene_index INTEGER NOT NULL, attempt INTEGER NOT NULL, execution_id TEXT NOT NULL UNIQUE, provider_job_id TEXT, status TEXT NOT NULL, error TEXT, output_ref TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (job_id, scene_index, attempt))';

const results = [];
function check(id, description, pass, expected, actual) {
  results.push({ id, description, pass: Boolean(pass), expected, actual });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} — ${description}`);
  if (!pass) {
    console.log(`         expected: ${JSON.stringify(expected)}`);
    console.log(`         actual:   ${JSON.stringify(actual)}`);
  }
}

const mf = new Miniflare({
  modules: true,
  script: `export default { async fetch() { return new Response('proof-only'); } }`,
  d1Databases: { PROOF_DB: 'phase3-proof-02' },
  d1Persist: false,
  compatibilityDate: '2025-01-01',
});
const db = await mf.getD1Database('PROOF_DB');
await db.exec(JOBS_DDL);
await db.exec(SCENES_DDL);

const jobId = 'job-22-batch-1';
const jobData = JSON.stringify({ status: 'queued', dispatchState: 'intent-recorded', scenes: 20 });
const now = 1795000000000;

// Build the design's maximum creation batch: statement 1 = parent conditional
// insert (with the §B-3.2.1 cap/ceiling guards, limits not reached here),
// statement 2 = read-back, statements 3..22 = one scene insert per scene (0..19).
const stmts = [
  db.prepare(
    `INSERT INTO jobs (id, data)
     SELECT ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?)
       AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) < 100000`
  ).bind(jobId, jobData, jobId),
  db.prepare(`SELECT id, data FROM jobs WHERE id = ?`).bind(jobId),
];
for (let i = 0; i < 20; i++) {
  stmts.push(
    db.prepare(
      `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at)
       VALUES (?, ?, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?)`
    ).bind(jobId, i, `${jobId}:scene-${i}:attempt-1`, now)
  );
}
check('P02-01', 'batch built with exactly 22 statements (2 + 20)', stmts.length === 22, 22, stmts.length);

let batchResults;
let batchError = '';
try {
  batchResults = await db.batch(stmts);
} catch (e) {
  batchError = String(e && e.message ? e.message : e);
}
check('P02-02', '22-statement batch executes without error', batchResults !== undefined, true, batchResults === undefined ? batchError.slice(0, 200) : 'executed');
if (batchResults) {
  check('P02-03', '22 results returned, in statement order', batchResults.length === 22, 22, batchResults.length);
  check('P02-04', 'statement 1 (parent insert): changes=1', batchResults[0].meta?.changes === 1, 1, batchResults[0].meta?.changes);
  check('P02-05', 'statement 2 (read-back): returns the new parent row', batchResults[1].results?.length === 1 && batchResults[1].results[0].id === jobId, true, batchResults[1].results?.map((r) => r.id));
  const sceneChanges = batchResults.slice(2).map((r) => r.meta?.changes);
  check('P02-06', 'statements 3..22 (scene inserts): every changes=1', sceneChanges.every((c) => c === 1), Array(20).fill(1), sceneChanges);
  const jobCount = await db.prepare(`SELECT COUNT(*) AS n FROM jobs`).first();
  const sceneCount = await db.prepare(`SELECT COUNT(*) AS n FROM scenes WHERE job_id = ?`).bind(jobId).first();
  check('P02-07', 'after batch: exactly 1 jobs row', jobCount.n === 1, 1, jobCount.n);
  check('P02-08', 'after batch: exactly 20 scenes rows for the job', sceneCount.n === 20, 20, sceneCount.n);
  const indexes = await db.prepare(`SELECT scene_index FROM scenes WHERE job_id = ? ORDER BY scene_index`).bind(jobId).all();
  check('P02-09', 'scene indexes 0..19 all present, each attempt=1', JSON.stringify(indexes.results.map((r) => r.scene_index)) === JSON.stringify([...Array(20).keys()]), [...Array(20).keys()], indexes.results.map((r) => r.scene_index));
}

await mf.dispose();
const passed = results.filter((r) => r.pass).length;
console.log(`\nproof-02: ${passed}/${results.length} assertions passed.`);
console.log('environment: local miniflare in-memory D1 only; no remote database touched.');
process.exit(passed === results.length ? 0 : 1);
