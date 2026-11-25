// T31-06 — Retention ceiling never exceeded under concurrency, for the
// request's actual footprint. Rev 3.3 §C-3.3.2.2 (amended T31-06).
// Three sub-cases, each with concurrent identical-shape generation
// requests, against actual database semantics (not mocked counts):
//   A: seed 99,995; concurrent 1-parent+4-scene requests (footprint 5):
//      exactly one complete request succeeds, others 503, total 100,000,
//      no partial records.
//   B: seed 99,998; concurrent single-generation requests (footprint 2):
//      exactly one succeeds, total 100,000, others 503, no partials.
//   C: seed 99,996; 4-scene plan (footprint 5): every request 503, no
//      parent or scene row created at all.
//
// S-layer runs the exact Rev 3.4 creation batch concurrently (the
// "503" verdict is the batch refusing: parentChanges 0 + no row +
// diagnostic read 'retention'). W-layer repeats the same shapes over
// HTTP POST /api/generate.
import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodyPlan, generateBodySingle, creationBatch, seedFiller,
  retainedTotal, sceneRows, jobRow, diagnoseLimit, sha256Hex,
  Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Retention ceiling never exceeded under concurrency (footprint)';

async function noPartialRows(db, jobIds) {
  // No parent without all of its scene rows; no scene row without parent.
  for (const id of jobIds) {
    const parent = await jobRow(db, id);
    const scenes = await sceneRows(db, id);
    if (parent && scenes.length === 0) return `parent ${id} has no scenes`;
    if (!parent && scenes.length > 0) return `orphan scenes for ${id}`;
  }
  return null;
}

async function runSubcase(rec, tag, seedTotal, shape, concurrency) {
  const { mf, db } = await boot({ probe: true });
  try {
    // Seed exactly: half jobs, half scenes (rounded), to seedTotal.
    const seedJobs = Math.floor(seedTotal / 2);
    await seedFiller(db, seedJobs, seedTotal - seedJobs);
    const seeded = await retainedTotal(db);
    if (seeded !== seedTotal) {
      rec.blocked(`${tag}-seed`, `${tag}: seed to exactly ${seedTotal} retained rows`, `seeded ${seeded}, not ${seedTotal}`);
      return;
    }
    const attempts = [];
    for (let i = 0; i < concurrency; i++) {
      const jobId = newJobId(); const token = newToken();
      attempts.push({ jobId, token });
    }
    const results = await Promise.all(attempts.map(({ jobId, token }) =>
      shape === 'plan4'
        ? creationBatch(db, { jobId, token, n: 4, planScenes: [{ index: 0, prompt: 's0' }, { index: 1, prompt: 's1' }, { index: 2, prompt: 's2' }, { index: 3, prompt: 's3' }] })
        : creationBatch(db, { jobId, token, n: 1, prompt: 'single' })));
    const succeeded = results.filter((r) => r.ok && r.parentChanges === 1);
    const refused = results.filter((r) => r.ok && r.parentChanges === 0 && !r.row);
    const total = await retainedTotal(db);
    const expectedFootprint = shape === 'plan4' ? 5 : 2;
    if (tag === 'C') {
      rec.check(`${tag}-S1`, `S-${tag}: every request is refused (footprint ${expectedFootprint} does not fit at ${seedTotal})`, refused.length === concurrency && succeeded.length === 0, `${concurrency} refused, 0 succeeded`, `${refused.length} refused, ${succeeded.length} succeeded`);
      rec.check(`${tag}-S2`, `S-${tag}: no parent or scene row is created at all`, total === seedTotal, seedTotal, total);
    } else {
      rec.check(`${tag}-S1`, `S-${tag}: exactly one complete request succeeds`, succeeded.length === 1 && succeeded[0].sceneChanges.every((c) => c === 1), '1 succeeded, all scenes 1', { succeeded: succeeded.length, sceneChanges: succeeded[0]?.sceneChanges });
      rec.check(`${tag}-S2`, `S-${tag}: every other request is refused (retention, not cap)`, refused.length === concurrency - 1, concurrency - 1, refused.length);
      const diags = await Promise.all(attempts.filter((_, i) => results[i].ok && results[i].parentChanges === 0).map(({ token }) => diagnoseLimit(db, sha256Hex(token), shape === 'plan4' ? 4 : 1)));
      rec.check(`${tag}-S3`, `S-${tag}: every refusal diagnoses as retention-backlog`, diags.every((d) => d === 'retention'), 'all retention', diags);
      rec.check(`${tag}-S4`, `S-${tag}: retained total is exactly 100,000`, total === 100000, 100000, total);
      const partial = await noPartialRows(db, attempts.map((a) => a.jobId));
      rec.check(`${tag}-S5`, `S-${tag}: no partial job or scene records exist`, partial === null, 'none', partial);
    }
  } finally {
    await mf.dispose();
  }
}

async function runWSubcase(rec, tag, seedTotal, shape, concurrency) {
  const stub = createStubApi();
  await stub.start();
  const { mf, db } = await boot({ api: stub });
  try {
    const seedJobs = Math.floor(seedTotal / 2);
    await seedFiller(db, seedJobs, seedTotal - seedJobs);
    const attempts = [];
    for (let i = 0; i < concurrency; i++) attempts.push({ jobId: newJobId(), token: newToken() });
    const results = await Promise.all(attempts.map(({ jobId, token }) =>
      http(mf, 'POST', '/api/generate', {
        body: shape === 'plan4' ? generateBodyPlan(jobId, 4) : generateBodySingle(jobId),
        headers: { ...authHeaders(token), ...testKeyHeaders() },
      })));
    if (results.every((r) => r.status === 404)) {
      rec.blocked(`${tag}-W1`, `W-${tag}: concurrent ${shape} generation requests at the boundary`, `POST /api/generate is not implemented (HTTP 404 ${results[0].text.slice(0, 120)})`);
      return;
    }
    const ok202 = results.filter((r) => r.status === 202).length;
    const refused503 = results.filter((r) => {
      if (r.status !== 503) return false;
      try { if (JSON.parse(r.text || '{}')?.error === 'retention-backlog') return true; } catch { /* non-JSON */ }
      return /retention-backlog/.test(r.text);
    }).length;
    const total = await retainedTotal(db);
    if (tag === 'C') {
      rec.check(`${tag}-W1`, `W-${tag}: every request receives 503 retention-backlog`, refused503 === concurrency, `${concurrency} x 503 retention-backlog`, results.map((r) => r.status));
      rec.check(`${tag}-W2`, `W-${tag}: no parent or scene row is created`, total === seedTotal, seedTotal, total);
    } else {
      rec.check(`${tag}-W1`, `W-${tag}: exactly one request is accepted (202)`, ok202 === 1, 1, ok202);
      rec.check(`${tag}-W2`, `W-${tag}: every other request receives 503 retention-backlog`, refused503 === concurrency - 1, concurrency - 1, refused503);
      rec.check(`${tag}-W3`, `W-${tag}: retained total is exactly 100,000`, total === 100000, 100000, total);
    }
  } finally {
    await mf.dispose();
    await stub.stop();
  }
}

export async function run(rec) {
  await runSubcase(rec, 'A', 99995, 'plan4', 5);
  await runSubcase(rec, 'B', 99998, 'single', 5);
  await runSubcase(rec, 'C', 99996, 'plan4', 5);
  await runWSubcase(rec, 'A', 99995, 'plan4', 5);
  await runWSubcase(rec, 'B', 99998, 'single', 5);
  await runWSubcase(rec, 'C', 99996, 'plan4', 5);
  rec.note('S-layer "503" = the creation batch refusing (parentChanges 0, no row, diagnostic read retention). The HTTP 503 retention-backlog response itself is a W-layer behaviour and is asserted only where the Worker implements generation.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-06', TITLE, run);
}
