// Phase 3 proof 01 — D1 batch() rollback + statement ordering (LOCAL miniflare only).
//
// What it proves (reviewer-confirmed property, §B-3.2.1.2 / §B-3.2.18):
//   batch() executes statements sequentially as ONE transaction, returns
//   results in statement order, and rolls the whole batch back if any
//   statement fails.
//
// Method: programmatic miniflare (same pattern as a2-impl/test/harness.mjs),
// in-memory D1 (d1Persist: false), schema per Rev 2 §8:
//   jobs(id TEXT PRIMARY KEY, data TEXT)
//   scenes(job_id TEXT, scene_index INTEGER, attempt INTEGER,
//          execution_id TEXT UNIQUE, provider_job_id TEXT NULL,
//          status TEXT, error TEXT NULL, output_ref TEXT NULL,
//          expires_at INTEGER NULL, updated_at INTEGER,
//          PRIMARY KEY(job_id, scene_index, attempt))
// No network, no remote database, no production resource.
//
// Run:  cd ~/workspace/nova-ai-studio/a2-impl && node ../../nova-ai-studio/phase3-proofs/proof-01-batch-rollback-ordering.mjs
//   (or from the repo root: node phase3-proofs/proof-01-batch-rollback-ordering.mjs
//    — the script resolves the a2-impl node_modules itself)
// Exit 0 = all assertions passed; non-zero = a proof assertion failed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const A2_IMPL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'a2-impl');
// Resolve miniflare from a2-impl/node_modules (this script lives outside that package).
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
  d1Databases: { PROOF_DB: 'phase3-proof-01' },
  d1Persist: false,
  compatibilityDate: '2025-01-01',
});
const db = await mf.getD1Database('PROOF_DB');
await db.exec(JOBS_DDL);
await db.exec(SCENES_DDL);

// --- Test A: a later statement fails (PRIMARY KEY conflict) -> whole batch rolls back.
const jobData = JSON.stringify({ status: 'queued', dispatchState: 'intent-recorded' });
let batchThrew = false;
let batchError = '';
try {
  await db.batch([
    db.prepare(`INSERT INTO jobs (id, data) VALUES (?, ?)`).bind('job-rollback-1', jobData),
    db.prepare(
      `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at)
       VALUES (?, 0, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?)`
    ).bind('job-rollback-1', 'job-rollback-1:scene-0:attempt-1', 1795000000000),
    // Deliberate duplicate: same (job_id, scene_index, attempt) as statement 2.
    db.prepare(
      `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at)
       VALUES (?, 0, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?)`
    ).bind('job-rollback-1', 'job-rollback-1:scene-0:attempt-1-dup', 1795000000000),
  ]);
} catch (e) {
  batchThrew = true;
  batchError = String(e && e.message ? e.message : e);
}
check('P01-A1', 'failing batch throws (statement error surfaces)', batchThrew, true, batchThrew);
console.log(`         batch error: ${batchError.slice(0, 200)}`);
const afterJobs = await db.prepare(`SELECT COUNT(*) AS n FROM jobs`).first();
const afterScenes = await db.prepare(`SELECT COUNT(*) AS n FROM scenes`).first();
check('P01-A2', 'rollback: no jobs row from statement 1 remains', afterJobs.n === 0, 0, afterJobs.n);
check('P01-A3', 'rollback: no scenes row from statement 2 remains', afterScenes.n === 0, 0, afterScenes.n);

// --- Test B: results come back in statement order.
const ordered = await db.batch([
  db.prepare(`INSERT INTO jobs (id, data) VALUES (?, ?)`).bind('job-order-1', jobData),
  db.prepare(`SELECT COUNT(*) AS n FROM jobs`),
  db.prepare(`INSERT INTO jobs (id, data) VALUES (?, ?)`).bind('job-order-2', jobData),
  db.prepare(`SELECT id FROM jobs ORDER BY id`),
]);
check('P01-B1', 'batch returns one result per statement, in order', ordered.length === 4, 4, ordered.length);
check('P01-B2', 'results[0] is the first insert (changes=1)', ordered[0].meta?.changes === 1, 1, ordered[0].meta?.changes);
check('P01-B3', 'results[1] sees exactly the first insert (count=1)', ordered[1].results?.[0]?.n === 1, 1, ordered[1].results?.[0]?.n);
check('P01-B4', 'results[2] is the second insert (changes=1)', ordered[2].meta?.changes === 1, 1, ordered[2].meta?.changes);
check('P01-B5', 'results[3] sees both rows, in order', JSON.stringify(ordered[3].results?.map((r) => r.id)) === JSON.stringify(['job-order-1', 'job-order-2']), ['job-order-1', 'job-order-2'], ordered[3].results?.map((r) => r.id));

// --- Test C: the design's creation batch shape (§B-3.2.1.2): conditional insert + read-back,
// with a duplicate jobId the insert is a no-op and the read-back returns the existing row.
const created = await db.batch([
  db.prepare(`INSERT INTO jobs (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?)`).bind('job-dup-1', jobData, 'job-dup-1'),
  db.prepare(`SELECT id, data FROM jobs WHERE id = ?`).bind('job-dup-1'),
]);
check('P01-C1', 'fresh create: changes=1 and read-back returns the row', created[0].meta?.changes === 1 && created[1].results?.length === 1, true, { changes: created[0].meta?.changes, rows: created[1].results?.length });
const dup = await db.batch([
  db.prepare(`INSERT INTO jobs (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?)`).bind('job-dup-1', jobData, 'job-dup-1'),
  db.prepare(`SELECT id, data FROM jobs WHERE id = ?`).bind('job-dup-1'),
]);
check('P01-C2', 'duplicate create: changes=0, read-back still returns the one existing row', dup[0].meta?.changes === 0 && dup[1].results?.length === 1, true, { changes: dup[0].meta?.changes, rows: dup[1].results?.length });
const dupCount = await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE id = ?`).bind('job-dup-1').first();
check('P01-C3', 'duplicate create left exactly one row', dupCount.n === 1, 1, dupCount.n);

await mf.dispose();
const passed = results.filter((r) => r.pass).length;
console.log(`\nproof-01: ${passed}/${results.length} assertions passed.`);
console.log('environment: local miniflare in-memory D1 only; no remote database touched.');
process.exit(passed === results.length ? 0 : 1);
