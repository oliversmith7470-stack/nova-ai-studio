// T31-RETRY — POST /api/retry contract (Rev 2 §4.2, Rev 3 §B-3.2.8/§C-1.5).
//
//   202 { jobId, sceneIndex, attempt, executionId, status: "queued",
//        dispatchState } for a retryable scene (latest attempt failed /
//        timed-out), with the new attempt row inserted and dispatched
//        exactly once (stub journal).
//   404 unknown jobId; 404 scene index not in the plan; 401 token
//        mismatch; 400 scene not retryable (latest attempt queued /
//        succeeded); 400 cancelled job; 410 expired job; 409 a retry
//        already in flight (seeded); 409 simultaneous retries — exactly
//        one 202, one 409; 429 when the per-token active cap (3) is hit
//        by other active jobs.
//   Precondition order per the design: 404 job/scene, 401 token, 400
//   not retryable / cancelled, 409 already in flight, 410 expired,
//   429 rate limit. (The implementation checks 410 after 409 and the
//   cancelled check after 410 — an unreachable corner: a cancelled job
//   has no in-flight scene — noted, not asserted.)
//
// NOTE: the per-IP generation rate limit is 10/hour and counts every
// retry call that reaches it, so the sections run in SEPARATE boots
// (fresh D1, fresh rate window) — 5 calls, 5 calls, 1 call.

import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  seedJob, sceneRows,
  Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'POST /api/retry: 202/400/401/404/409/410/429 contract + simultaneous-retry race';

const PLAN = [{ index: 0, prompt: 'Scene 0 prompt' }, { index: 1, prompt: 'Scene 1 prompt' }];

function retryBody(jobId, sceneIndex) {
  return JSON.stringify({ jobId, sceneIndex });
}

export async function run(rec) {
  const stub = createStubApi();
  await stub.start();
  try {
    const headers = (tok) => ({ ...authHeaders(tok), ...testKeyHeaders(), 'Content-Type': 'application/json' });
    const call = (mf, jobId, sceneIndex, tok) =>
      http(mf, 'POST', '/api/retry', { rawBody: retryBody(jobId, sceneIndex), contentType: 'application/json', headers: headers(tok) });

    // ---- Boot 1: 404 / 401 / 400-not-retryable / 202 happy path.
    {
      const { mf, db } = await boot({ api: stub });
      try {
        const noJob = newJobId();
        const r404 = await call(mf, noJob, 0, newToken());
        rec.check('Y1', 'retry: unknown jobId returns 404', r404.status === 404, 404, { status: r404.status, body: r404.text.slice(0, 160) });

        const jobA = newJobId(); const tokA = newToken();
        await seedJob(db, { jobId: jobA, token: tokA, plan: PLAN, scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
          { index: 1, attempt: 1, status: 'queued' },
        ] });

        const r404s = await call(mf, jobA, 7, tokA);
        rec.check('Y2', 'retry: scene index not in the plan returns 404', r404s.status === 404, 404, { status: r404s.status, body: r404s.text.slice(0, 160) });

        const r401 = await call(mf, jobA, 0, newToken());
        rec.check('Y3', 'retry: wrong access token returns 401', r401.status === 401, 401, { status: r401.status, body: r401.text.slice(0, 160) });

        // NOTE — precondition ORDER (Rev 3 §C-1.5 lists 400 "not
        // retryable" before 409 "already in flight"). The two checks
        // overlap for an ACTIVE latest attempt, and the implementation
        // resolves it by the 409 message's own wording — "a RETRY is
        // already in flight": 409 only when the active latest attempt
        // IS a retry (attempt > 1). A queued ORIGINAL attempt
        // (attempt 1, never failed) is not a retry in flight — the
        // scene is simply not retryable (400). This reading also makes
        // the §C-1.5 simultaneous-retry acceptance test deterministic:
        // the second simultaneous request reads the winner's in-flight
        // attempt-2 and gets 409. Asserted here as implemented; the
        // 400-vs-409 boundary is a reviewer-clarification item if the
        // design meant 409 for ANY active latest attempt.
        const r400 = await call(mf, jobA, 1, tokA);
        rec.check('Y4', 'retry: scene whose latest (original) attempt is queued returns 400 (not retryable — no retry in flight)', r400.status === 400, 400, { status: r400.status, body: r400.text.slice(0, 160) });

        const jobA2 = newJobId(); const tokA2 = newToken();
        await seedJob(db, { jobId: jobA2, token: tokA2, plan: PLAN, scenes: [
          { index: 0, attempt: 1, status: 'succeeded' },
        ] });
        const r400b = await call(mf, jobA2, 0, tokA2);
        rec.check('Y4b', 'retry: scene whose latest attempt succeeded returns 400 (not retryable, not in flight)', r400b.status === 400, 400, { status: r400b.status, body: r400b.text.slice(0, 160) });

        const r202 = await call(mf, jobA, 0, tokA);
        const body202 = r202.json || {};
        rec.check('Y5', 'retry: failed scene returns 202 with attempt 2 + executionId + dispatchState', r202.status === 202 && body202.attempt === 2 && body202.executionId === `${jobA}:scene-0:attempt-2` && typeof body202.dispatchState === 'string', { status: 202, attempt: 2, dispatchState: 'string' }, { status: r202.status, body: r202.text.slice(0, 300) });
        const rowsAfter = await sceneRows(db, jobA);
        rec.check('Y6', 'retry: the new attempt-2 row exists in D1 (queued)', rowsAfter.some((r) => r.scene_index === 0 && r.attempt === 2 && r.status === 'queued'), 'row (0,2) queued', rowsAfter.map((r) => `${r.scene_index}:${r.attempt}:${r.status}`));
        rec.check('Y7', 'retry: the new attempt was dispatched exactly once (stub journal)', stub.submissionsFor(`${jobA}:scene-0:attempt-2`).length === 1, 1, stub.submissionsFor(`${jobA}:scene-0:attempt-2`).length);
      } finally {
        await mf.dispose();
      }
    }

    // ---- Boot 2: 409 seeded in-flight / 410 expired / 400 cancelled /
    // simultaneous-retry race.
    {
      const { mf, db } = await boot({ api: stub });
      try {
        // Reachable in-flight state: the LATEST attempt IS a retry
        // (attempt 2) and is dispatched — a retry is already in flight.
        // (An earlier attempt queued + a later attempt failed is not
        // reachable — attempt N+1 is created only after attempt N
        // failed/timed out — so it is not seeded here.)
        const jobB = newJobId(); const tokB = newToken();
        await seedJob(db, { jobId: jobB, token: tokB, plan: PLAN, scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
          { index: 0, attempt: 2, status: 'dispatched' },
          { index: 1, attempt: 1, status: 'failed', error: 'boom' },
        ] });
        const r409 = await call(mf, jobB, 0, tokB);
        rec.check('Y8', 'retry: a retry already in flight (latest attempt is a dispatched retry, attempt 2) returns 409', r409.status === 409, 409, { status: r409.status, body: r409.text.slice(0, 160) });

        const jobC = newJobId(); const tokC = newToken();
        await seedJob(db, { jobId: jobC, token: tokC, plan: PLAN, status: 'expired', scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
        ] });
        const r410 = await call(mf, jobC, 0, tokC);
        rec.check('Y9', 'retry: expired job returns 410', r410.status === 410, 410, { status: r410.status, body: r410.text.slice(0, 160) });

        const jobD = newJobId(); const tokD = newToken();
        await seedJob(db, { jobId: jobD, token: tokD, plan: PLAN, status: 'cancelled', scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
        ] });
        const r400c = await call(mf, jobD, 0, tokD);
        rec.check('Y10', 'retry: cancelled job returns 400', r400c.status === 400, 400, { status: r400c.status, body: r400c.text.slice(0, 160) });

        const jobE = newJobId(); const tokE = newToken();
        await seedJob(db, { jobId: jobE, token: tokE, plan: PLAN, scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
        ] });
        const [e1, e2] = await Promise.all([
          call(mf, jobE, 0, tokE),
          call(mf, jobE, 0, tokE),
        ]);
        const pair = [e1.status, e2.status].sort();
        rec.check('Y11', 'retry: simultaneous retries yield exactly one 202 and one 409', pair[0] === 202 && pair[1] === 409, '[202, 409]', pair);
        const eRows = (await sceneRows(db, jobE)).filter((r) => r.scene_index === 0 && r.attempt === 2);
        rec.check('Y12', 'retry: the race created exactly one attempt-2 row', eRows.length === 1, 1, eRows.length);
        rec.check('Y13', 'retry: the race dispatched the new attempt exactly once', stub.submissionsFor(`${jobE}:scene-0:attempt-2`).length === 1, 1, stub.submissionsFor(`${jobE}:scene-0:attempt-2`).length);
      } finally {
        await mf.dispose();
      }
    }

    // ---- Boot 3: 429 active-cap.
    {
      const { mf, db } = await boot({ api: stub });
      try {
        const tokF = newToken();
        for (let i = 0; i < 3; i++) {
          const j = newJobId();
          await seedJob(db, { jobId: j, token: tokF, plan: PLAN, scenes: [{ index: 0, attempt: 1, status: 'queued' }] });
        }
        const jobF = newJobId();
        await seedJob(db, { jobId: jobF, token: tokF, plan: PLAN, scenes: [
          { index: 0, attempt: 1, status: 'failed', error: 'boom' },
        ] });
        const r429 = await call(mf, jobF, 0, tokF);
        rec.check('Y14', 'retry: 3 other active jobs under the token returns 429 with Retry-After: 60', r429.status === 429 && r429.headers['retry-after'] === '60', '429 + Retry-After 60', { status: r429.status, retryAfter: r429.headers['retry-after'], body: r429.text.slice(0, 160) });
        const fRows = (await sceneRows(db, jobF)).filter((r) => r.scene_index === 0 && r.attempt === 2);
        rec.check('Y15', 'retry: the 429 refused retry created no attempt-2 row', fRows.length === 0, 0, fRows.length);
      } finally {
        await mf.dispose();
      }
    }
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-RETRY', TITLE, run);
}
