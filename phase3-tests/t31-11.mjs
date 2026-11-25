// T31-11 — Duplicate JSON keys rejected.
// Rev 3.2 §B-3.2.10.3: the Worker parses the request body with a
// duplicate-key-detecting parse (JSON.parse alone is insufficient — it
// silently keeps the last value). A body with a duplicated key at the
// top level, and a body with a duplicated key inside a scene object:
// both rejected with 400, no job created, no hash computed. Detection
// must work at ANY depth, before validation and hashing.
import {
  boot, http, newJobId, newToken, authHeaders, jobRow,
  Recorder, runMain,
} from './harness.mjs';

const TITLE = 'Duplicate JSON keys rejected';

export async function run(rec, ctx) {
  const { mf, db } = await boot(); ctx.setMf(mf);
  const token = newToken();
  // Top-level duplicate: "prompt" appears twice.
  const jobA = newJobId();
  const rawTop = `{"jobId":"${jobA}","mode":"single","prompt":"first","prompt":"second","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`;
  const rTop = await http(mf, 'POST', '/api/generate', { rawBody: rawTop, contentType: 'application/json', headers: authHeaders(token) });
  if (rTop.status === 404) {
    rec.blocked('W1', 'W: top-level duplicate key is rejected with 400, no job created', `POST /api/generate is not implemented (HTTP 404 ${rTop.text.slice(0, 120)})`);
    rec.blocked('W2', 'W: nested duplicate key inside a scene object is rejected with 400, no job created', 'same missing route as W1');
  } else {
    rec.check('W1', 'W: top-level duplicate key is rejected with 400', rTop.status === 400, 400, { status: rTop.status, body: rTop.text.slice(0, 200) });
    rec.check('W1b', 'W: top-level duplicate creates no job row', (await jobRow(db, jobA)) === null, 'no row', await jobRow(db, jobA));
    // Nested duplicate: "prompt" twice inside scenes[0].
    const jobB = newJobId();
    const rawNested = `{"jobId":"${jobB}","mode":"plan","scenes":[{"index":0,"prompt":"first","prompt":"second"}],"model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`;
    const rNested = await http(mf, 'POST', '/api/generate', { rawBody: rawNested, contentType: 'application/json', headers: authHeaders(token) });
    rec.check('W2', 'W: nested duplicate key inside a scene object is rejected with 400', rNested.status === 400, 400, { status: rNested.status, body: rNested.text.slice(0, 200) });
    rec.check('W2b', 'W: nested duplicate creates no job row', (await jobRow(db, jobB)) === null, 'no row', await jobRow(db, jobB));
    // Control: the same bodies WITHOUT duplication must not be rejected
    // for the duplicate-key reason (they may fail later, e.g. capacity
    // — but must not fail as "duplicate key" and must not 400 here if
    // the route is implemented; a 202/503-capacity/429 is acceptable).
    const jobC = newJobId();
    const rawClean = `{"jobId":"${jobC}","mode":"single","prompt":"clean","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`;
    const rClean = await http(mf, 'POST', '/api/generate', { rawBody: rawClean, contentType: 'application/json', headers: authHeaders(token) });
    rec.check('W3', 'W: a clean body is NOT rejected with a duplicate-key 400 (control)', !(rClean.status === 400 && /duplicat/i.test(rClean.text)), 'not a duplicate-key 400', { status: rClean.status, body: rClean.text.slice(0, 200) });
  }
  rec.note('No S-layer exists for T31-11: duplicate-key detection is a Worker parse behaviour, not a database behaviour. "No hash computed" is not directly observable over HTTP; it is implied by "no job created" (the hash is stored only on the job record).');
  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-11', TITLE, run);
}
