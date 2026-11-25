// T31-RATE-LIMIT — Rev 3 §C-1.6 / Rev 2 §14.1 rate limits.
//
//   (a) First-use race: 20 concurrent generation requests (distinct
//       jobIds, distinct tokens, so the per-token active cap of 3 is
//       NOT the binding constraint) against the per-IP generation limit
//       of 10/hour (PHASE3_GEN_LIMIT_PER_HOUR) — exactly 10 accepted
//       (202) and 10 refused with 429 + Retry-After, with exactly one
//       rate_limits row whose count is 10.
//   (b) Active-cap race: 5 concurrent generation requests under ONE
//       token (per-token active-job cap 3, enforced atomically by the
//       creation batch's conditional parent insert) — at most 3 jobs
//       created; the rest refused with 429 + Retry-After: 60.
//   (c) The generation rate limit is per-IP: a second IP (a second
//       miniflare instance is NOT a second IP here — the IP is the
//       request's; this harness uses distinct tokens and observes the
//       per-IP counter directly instead).
//
// The rate-limit scope key is `ip-gen:<hmac(ip, salt)>`; the raw IP is
// never stored. All requests go through the controlled-test gate with
// the stub API process so accepted requests can complete their submit.

import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodySingle, retainedTotal, jobRow, sceneRows,
  Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Rate limits: first-use race (10/hour/IP) + per-token active cap (3)';

export async function run(rec) {
  const stub = createStubApi();
  await stub.start();
  try {
    const { mf, db } = await boot({ api: stub });

    // ---- (a) first-use race: 20 distinct tokens, 20 distinct jobs.
    const attempts = Array.from({ length: 20 }, () => ({ jobId: newJobId(), token: newToken() }));
    const results = await Promise.all(attempts.map(({ jobId, token }) =>
      http(mf, 'POST', '/api/generate', {
        body: generateBodySingle(jobId),
        headers: { ...authHeaders(token), ...testKeyHeaders() },
      })));
    const accepted = results.filter((r) => r.status === 202);
    const refused = results.filter((r) => r.status === 429);
    const acceptedJobs = [];
    for (let i = 0; i < attempts.length; i++) {
      if (results[i].status === 202) acceptedJobs.push(attempts[i].jobId);
    }
    rec.check('R1', 'first-use race: exactly 10 of 20 concurrent generations accepted (202)', accepted.length === 10, 10, accepted.length);
    rec.check('R2', 'first-use race: the other 10 refused with 429', refused.length === 10, 10, refused.length);
    rec.check('R3', 'first-use race: every 429 carries a Retry-After header', refused.every((r) => (r.headers['retry-after'] || '') !== ''), 'Retry-After on all 429s', refused.map((r) => r.headers['retry-after']));
    const rlRows = await db.prepare('SELECT key, count FROM rate_limits').all();
    const genRows = (rlRows.results || []).filter((r) => String(r.key).startsWith('ip-gen:'));
    rec.check('R4', 'first-use race: exactly one gen-scope rate_limits row, count 10', genRows.length === 1 && Number(genRows[0].count) === 10, '1 row, count 10', genRows);
    // Accepted jobs really exist with scene rows; refused ones do not.
    let createdOk = 0;
    for (const jobId of acceptedJobs) {
      if (await jobRow(db, jobId)) createdOk++;
    }
    rec.check('R5', 'first-use race: every accepted request created its D1 job', createdOk === acceptedJobs.length, acceptedJobs.length, createdOk);
    let refusedCreated = 0;
    for (let i = 0; i < attempts.length; i++) {
      if (results[i].status === 429 && await jobRow(db, attempts[i].jobId)) refusedCreated++;
    }
    rec.check('R6', 'first-use race: no refused request created a D1 job', refusedCreated === 0, 0, refusedCreated);
    await mf.dispose();

    // ---- (b) active-cap race: 5 concurrent requests, ONE token.
    // Fresh boot (fresh rate window) so the gen limit does not bind.
    const { mf: mf2, db: db2 } = await boot({ api: stub });
    try {
      const capToken = newToken();
      const capAttempts = Array.from({ length: 5 }, () => newJobId());
      const capResults = await Promise.all(capAttempts.map((jobId) =>
        http(mf2, 'POST', '/api/generate', {
          body: generateBodySingle(jobId),
          headers: { ...authHeaders(capToken), ...testKeyHeaders() },
        })));
      const capAccepted = capResults.filter((r) => r.status === 202);
      const capRefused = capResults.filter((r) => r.status === 429);
      let capCreated = 0;
      for (const jobId of capAttempts) {
        if (await jobRow(db2, jobId)) capCreated++;
      }
      rec.check('R7', 'active-cap race: at most 3 jobs created under one token', capCreated <= 3, '≤ 3', capCreated);
      rec.check('R8', 'active-cap race: exactly 3 accepted and 2 refused with 429 (Retry-After: 60)', capAccepted.length === 3 && capRefused.length === 2 && capRefused.every((r) => r.headers['retry-after'] === '60'), '3 × 202, 2 × 429 Retry-After 60', { accepted: capAccepted.length, refused: capRefused.length, retryAfter: capRefused.map((r) => r.headers['retry-after']) });
      rec.check('R9', 'active-cap race: every accepted job has its scene row', (await Promise.all(capAttempts.map(async (jobId, i) => capResults[i].status === 202 ? (await sceneRows(db2, jobId)).length : 1))).every((n) => n === 1), '1 scene row each', 'checked');
      void retainedTotal;
    } finally {
      await mf2.dispose();
    }
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-RATE-LIMIT', TITLE, run);
}
