// T31-ROUTES — route inventory (Rev 2 §4.1/§4.2, Rev 3 §C-1.5).
//
//   New Phase 3 routes exist: POST /api/generate, GET /api/status,
//   GET /api/download, GET /api/capacity, POST /api/retry.
//   GET /api/export/jobs exists as the MINIMAL token-scoped listing
//   (no design spec exists for it anywhere in the approved design
//   set — Rev 3.2 §A-3.1.6.2 names it only in the route inventory;
//   see _worker.js handleExportJobs): 200 { jobs, total, limit,
//   offset } for the caller's token, 400 without a valid token.
//   Old routes are retired: POST /api/motion-generate and
//   GET /api/motion-status return 404 (Unknown API path) or 410.
//   GET /api/capacity in controlled-test mode returns the
//   controlled-test shape (engine ltx-video-2b, available true,
//   mode controlled-test); in production mode it returns
//   available false / no-production-capacity.
//   The 202-after-slot-claim shape (Rev 3.2 §B-3.2.8) is covered in
//   depth by T31-01 W1a–W1d and T31-02 W1/W4; here the capacity shape
//   and the route inventory are the assertions.

import {
  boot, http, newJobId, newToken, authHeaders, testKeyHeaders,
  generateBodySingle,
  Recorder, runMain,
} from './harness.mjs';
import { createStubApi } from './stub-api.mjs';

const TITLE = 'Route inventory: Phase 3 routes exist, old motion routes retired, capacity shape';

export async function run(rec) {
  const stub = createStubApi();
  await stub.start();
  try {
    // ---- Controlled-test mode.
    const { mf, db } = await boot({ api: stub });
    try {
      // GET /api/capacity — controlled-test shape.
      const cap = await http(mf, 'GET', '/api/capacity', {});
      rec.check('V1', 'routes: GET /api/capacity returns 200 in controlled-test mode', cap.status === 200, 200, { status: cap.status, body: cap.text.slice(0, 200) });
      const capJson = cap.json || {};
      rec.check('V2', 'routes: capacity body is the controlled-test shape (ltx-video-2b, available, mode controlled-test)', capJson.engine === 'ltx-video-2b' && capJson.available === true && capJson.mode === 'controlled-test', 'engine ltx-video-2b, available true, mode controlled-test', capJson);

      // POST /api/generate exists (a malformed body gets a 400, not a 404).
      const gen = await http(mf, 'POST', '/api/generate', { rawBody: '{"bad":true}', contentType: 'application/json', headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V3', 'routes: POST /api/generate exists (malformed body -> 400, not 404)', gen.status === 400, 400, { status: gen.status, body: gen.text.slice(0, 160) });

      // GET /api/status exists (unknown job -> 404 with a Phase 3 body,
      // not "Unknown API path").
      const st = await http(mf, 'GET', `/api/status?jobId=${newJobId()}`, { headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V4', 'routes: GET /api/status exists (unknown job -> 404, not Unknown API path)', st.status === 404 && !st.text.includes('Unknown API path'), '404, Phase 3 body', { status: st.status, body: st.text.slice(0, 160) });

      // GET /api/download exists (unknown job -> 404, not Unknown API path).
      const dl = await http(mf, 'GET', `/api/download?jobId=${newJobId()}`, { headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V5', 'routes: GET /api/download exists (unknown job -> 404, not Unknown API path)', dl.status === 404 && !dl.text.includes('Unknown API path'), '404, Phase 3 body', { status: dl.status, body: dl.text.slice(0, 160) });

      // POST /api/retry exists (unknown job -> 404, not Unknown API path).
      const rt = await http(mf, 'POST', '/api/retry', { rawBody: JSON.stringify({ jobId: newJobId(), sceneIndex: 0 }), contentType: 'application/json', headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V6', 'routes: POST /api/retry exists (unknown job -> 404, not Unknown API path)', rt.status === 404 && !rt.text.includes('Unknown API path'), '404, Phase 3 body', { status: rt.status, body: rt.text.slice(0, 160) });

      // GET /api/export/jobs — minimal token-scoped listing (no
      // design spec; see _worker.js handleExportJobs). A fresh token
      // owns no jobs: 200 with an empty list, not a 404.
      const ex = await http(mf, 'GET', '/api/export/jobs', { headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      const exJson = ex.json || {};
      rec.check('V7', 'routes: GET /api/export/jobs exists (200, { jobs, total, limit, offset }, empty for a fresh token)', ex.status === 200 && Array.isArray(exJson.jobs) && exJson.jobs.length === 0 && exJson.total === 0 && exJson.limit === 50 && exJson.offset === 0, '200, empty jobs list, total 0, limit 50, offset 0', { status: ex.status, body: ex.text.slice(0, 200) });

      // Old routes retired: POST /api/motion-generate, GET /api/motion-status.
      const oldGen = await http(mf, 'POST', '/api/motion-generate', { rawBody: JSON.stringify({ prompt: 'x' }), contentType: 'application/json', headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V8', 'routes: POST /api/motion-generate is retired (404 Unknown API path or 410)', oldGen.status === 404 || oldGen.status === 410, '404 or 410', { status: oldGen.status, body: oldGen.text.slice(0, 200) });
      const oldStatus = await http(mf, 'GET', `/api/motion-status?jobId=${newJobId()}`, {});
      rec.check('V9', 'routes: GET /api/motion-status is retired (404 Unknown API path or 410)', oldStatus.status === 404 || oldStatus.status === 410, '404 or 410', { status: oldStatus.status, body: oldStatus.text.slice(0, 200) });

      // The verbatim Wan 503 message is gone from generate responses.
      const g = await http(mf, 'POST', '/api/generate', { body: generateBodySingle(newJobId()), headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      rec.check('V10', 'routes: a generate response never carries the retired verbatim Wan 503 message', !g.text.includes('Wan') && !g.text.includes('wan2'), 'no Wan wording', { status: g.status, body: g.text.slice(0, 200) });

      // Export auth + token scoping: no token -> 400; a job created
      // under one token is listed for that token only.
      const exNoTok = await http(mf, 'GET', '/api/export/jobs', { headers: { ...testKeyHeaders() } });
      rec.check('V12', 'routes: GET /api/export/jobs without a job token -> 400', exNoTok.status === 400, '400', { status: exNoTok.status, body: exNoTok.text.slice(0, 160) });
      const scopedJobId = newJobId();
      const scopedToken = newToken();
      const scopedGen = await http(mf, 'POST', '/api/generate', { body: generateBodySingle(scopedJobId), headers: { ...authHeaders(scopedToken), ...testKeyHeaders() } });
      rec.check('V13a', 'routes: export-scope setup generate returns 202', scopedGen.status === 202, '202', { status: scopedGen.status, body: scopedGen.text.slice(0, 160) });
      const exMine = await http(mf, 'GET', '/api/export/jobs', { headers: { ...authHeaders(scopedToken), ...testKeyHeaders() } });
      const exMineJson = exMine.json || {};
      rec.check('V13b', 'routes: GET /api/export/jobs lists the caller\'s own job', exMine.status === 200 && exMineJson.total === 1 && Array.isArray(exMineJson.jobs) && exMineJson.jobs.length === 1 && exMineJson.jobs[0].jobId === scopedJobId && exMineJson.jobs[0].status === 'queued', '200, total 1, own jobId listed', { status: exMine.status, body: exMine.text.slice(0, 200) });
      const exOther = await http(mf, 'GET', '/api/export/jobs', { headers: { ...authHeaders(newToken()), ...testKeyHeaders() } });
      const exOtherJson = exOther.json || {};
      rec.check('V13c', 'routes: GET /api/export/jobs lists nothing for a different token', exOther.status === 200 && exOtherJson.total === 0 && Array.isArray(exOtherJson.jobs) && exOtherJson.jobs.length === 0, '200, total 0', { status: exOther.status, body: exOther.text.slice(0, 200) });
      void db;
    } finally {
      await mf.dispose();
    }

    // ---- Production mode: capacity reports no production capacity.
    const { mf: mfP } = await boot();
    try {
      const capP = await http(mfP, 'GET', '/api/capacity', {});
      const capPJson = capP.json || {};
      rec.check('V11', 'routes: GET /api/capacity in production mode returns available false / no-production-capacity', capP.status === 200 && capPJson.available === false && capPJson.reason === 'no-production-capacity', 'available false, no-production-capacity', { status: capP.status, body: capP.text.slice(0, 200) });
    } finally {
      await mfP.dispose();
    }
  } finally {
    await stub.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-ROUTES', TITLE, run);
}
