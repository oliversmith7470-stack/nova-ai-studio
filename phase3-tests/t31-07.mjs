// T31-07 — Retention measurement with the defined byte formula.
// Rev 3.2 §B-3.2.6.2: retained_bytes is the LOGICAL UTF-8 payload —
// per row, the UTF-8 byte lengths of all TEXT columns plus 8 bytes per
// INTEGER column. Exact SQL is the one definition for the alert check
// and the sweep report. Seed rows with known content (multi-byte UTF-8,
// NULL nullable columns, empty-string output_ref); assert the reported
// retained_bytes equals the hand-computed figure, and that the sweep
// report and the alert check return the identical figure.
import {
  boot, retainedBytes, retainedTotal, jobData, sceneRows, http,
  signInternalCall, TEST_API_SECRET, Recorder, runMain,
} from './harness.mjs';

const TITLE = 'Retention measurement with the defined byte formula';

// Independent hand computation (JS, not the SQL under test): TEXT cols
// by UTF-8 byte length, NULL as 0, 8 bytes per INTEGER column.
// jobs: id + data (TEXT only, no INTEGER cols).
// scenes: job_id + execution_id + provider_job_id + status + error +
//   output_ref (TEXT) + 4 INTEGER cols (scene_index, attempt,
//   expires_at, updated_at) x 8 = 32.
function jobBytes(id, data) {
  return Buffer.byteLength(id, 'utf8') + Buffer.byteLength(data, 'utf8');
}
function sceneBytes(row) {
  const text = (v) => (v === null || v === undefined ? 0 : Buffer.byteLength(String(v), 'utf8'));
  return text(row.job_id) + text(row.execution_id) + text(row.provider_job_id)
    + text(row.status) + text(row.error) + text(row.output_ref) + 32;
}

export async function run(rec, ctx) {
  const { mf, db } = await boot({ probe: true }); ctx.setMf(mf);
  // Fixed hand-computed case (values verified at authoring time):
  // jobs row id 'j1' (2) + data '{"a":"é"}' (10) = 12.
  // scenes row job_id 'j1' (2) + execution_id 'e1' (2) + provider NULL
  // (0) + status 'queued' (6) + error NULL (0) + output_ref '' (0)
  // + 32 = 42.
  rec.check('H1', 'hand computation: jobs row is 12 bytes', jobBytes('j1', '{"a":"é"}') === 12, 12, jobBytes('j1', '{"a":"é"}'));
  rec.check('H2', 'hand computation: scenes row is 42 bytes', sceneBytes({ job_id: 'j1', execution_id: 'e1', provider_job_id: null, status: 'queued', error: null, output_ref: '' }) === 42, 42, sceneBytes({ job_id: 'j1', execution_id: 'e1', provider_job_id: null, status: 'queued', error: null, output_ref: '' }));

  // Seeded rows with known content.
  const jobRows = [
    { id: 'job-utf8', data: '{"prompt":"Un dragón — café ☕","status":"queued"}' },
    { id: 'job-ascii', data: '{"status":"succeeded"}' },
  ];
  const sceneRowsSeed = [
    // Multi-byte UTF-8 in execution_id-adjacent text + NULL nullables.
    { job_id: 'job-utf8', scene_index: 0, attempt: 1, execution_id: 'job-utf8:scene-0:attempt-1', provider_job_id: null, status: 'queued', error: null, output_ref: null, expires_at: null, updated_at: 1700000000000 },
    // Empty-string output_ref (0 bytes, not NULL) + multi-byte error text.
    { job_id: 'job-utf8', scene_index: 1, attempt: 1, execution_id: 'job-utf8:scene-1:attempt-1', provider_job_id: 'mgr-☕', status: 'failed', error: 'échec — ☕', output_ref: '', expires_at: null, updated_at: 1700000000001 },
    // Retry row (attempt 2) with a provider id and output ref.
    { job_id: 'job-ascii', scene_index: 0, attempt: 2, execution_id: 'job-ascii:scene-0:attempt-2', provider_job_id: 'mgr-9', status: 'succeeded', error: null, output_ref: 'ref-abc', expires_at: 1700086400000, updated_at: 1700000000002 },
  ];
  for (const j of jobRows) {
    await db.prepare('INSERT INTO jobs (id, data) VALUES (?, ?)').bind(j.id, j.data).run();
  }
  for (const s of sceneRowsSeed) {
    await db.prepare('INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(s.job_id, s.scene_index, s.attempt, s.execution_id, s.provider_job_id, s.status, s.error, s.output_ref, s.expires_at, s.updated_at).run();
  }
  const expectedRows = jobRows.length + sceneRowsSeed.length;
  const expectedBytes = jobRows.reduce((a, j) => a + jobBytes(j.id, j.data), 0)
    + sceneRowsSeed.reduce((a, s) => a + sceneBytes(s), 0);
  const got = await retainedBytes(db);
  rec.check('S1', 'S: reported retained_rows equals the hand-counted sum', got.rows === expectedRows, expectedRows, got.rows);
  rec.check('S2', 'S: reported retained_bytes equals the hand-computed logical UTF-8 payload', got.bytes === expectedBytes, expectedBytes, got.bytes);
  // The same SQL run twice returns the identical figure (the alert
  // check and the sweep report run this exact query — one definition).
  const got2 = await retainedBytes(db);
  rec.check('S3', 'S: the identical figure is returned on a repeat run of the same query', got2.bytes === got.bytes && got2.rows === got.rows, got, got2);
  // rate_limits rows are NOT in the counted population (§B-3.2.5.2).
  await db.prepare('INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind('token:abc', 1700000000000, 1700003600000, 7, 1700000000000).run();
  const got3 = await retainedBytes(db);
  rec.check('S4', 'S: a rate_limits row changes neither retained_rows nor retained_bytes', got3.rows === expectedRows && got3.bytes === expectedBytes, { rows: expectedRows, bytes: expectedBytes }, got3);
  rec.blocked('W1', 'W: the sweep report and the alert check return the identical retained_bytes figure', 'no sweep report or alert-check surface exists in the Worker: no /api/* route reports retained_bytes, and no sweep runs in this harness');
  rec.blocked('W2', 'W: the alert fires at the byte threshold (10 MB) before the row threshold when rows are large, and the figure is labelled "logical UTF-8 payload" (never physical storage)', 'same missing surface as W1 — no alert check or sweep report is implemented');
  rec.note('The byte figure is the logical payload by construction (§B-3.2.6.2): the SQL sums LENGTH(CAST(x AS BLOB)) + 32 per scenes row. No physical-storage claim is made anywhere in the SQL or this test.');

  // ---- W-layer: retention deletion at 30 days (owner decision 25 Nov
  // ~18:21 WAT, Q3 APPROVED). The Worker boots with enabled=true +
  // days=30 set explicitly (Rev 3.1 §A-3.1.3.3); scheduled() is invoked
  // directly against the miniflare D1 (no dispatchScheduled in this
  // harness). This is the W-layer counterpart of the RET checks in
  // cloudflare-deploy/test_worker_phase3.mjs.
  const RETENTION_BINDINGS = {
    NOVA_API_SECRET: TEST_API_SECRET,
    NOVA_JOB_RECORD_RETENTION_ENABLED: 'true',
    NOVA_JOB_RECORD_RETENTION_DAYS: '30',
  };
  const w = await boot({ bindings: RETENTION_BINDINGS });
  try {
    const wdb = w.db;
    const DAY = 86400000;
    const wNow = Date.now();
    const seedW = async (jobId, status, sceneStatus, ageMs) => {
      await wdb.prepare('INSERT INTO jobs (id, data) VALUES (?, ?)').bind(jobId, JSON.stringify({
        id: jobId, createdAt: new Date(wNow - ageMs).toISOString(),
        updatedAt: new Date(wNow - ageMs).toISOString(),
        createdAtMs: wNow - ageMs, status, mode: 'single', engine: 'ltx-video-2b',
        prompt: 'retention seed', accessTokenHash: 'x', requestIdentityHash: 'x',
        requestIdentityVersion: 'canonical-request-v1', dispatchState: 'submitted',
        creationToken: '00000000-0000-4000-8000-000000000000', deploymentMode: 'controlled-test',
      })).run();
      await wdb.prepare(
        'INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, 0, 1, ?, NULL, ?, NULL, NULL, NULL, ?)',
      ).bind(jobId, `${jobId}:scene-0:attempt-1`, sceneStatus, wNow - ageMs).run();
    };
    await seedW('job-ret-old', 'succeeded', 'succeeded', 40 * DAY);
    await seedW('job-ret-young', 'succeeded', 'succeeded', 10 * DAY);
    const before = await retainedTotal(wdb);
    const mod = await import('../_worker.js');
    const pending = [];
    await mod.default.scheduled(
      { scheduledTime: Date.now(), cron: '*/15 * * * *' },
      { NOVA_DB: wdb, ...RETENTION_BINDINGS },
      { waitUntil: (p) => pending.push(p) },
    );
    await Promise.all(pending);
    rec.check('W3', 'W: scheduled() with retention enabled/30 deletes the 40-day terminal job + scene and retains the 10-day job',
      (await jobData(wdb, 'job-ret-old')) === null && (await sceneRows(wdb, 'job-ret-old')).length === 0
        && (await jobData(wdb, 'job-ret-young')) !== null && (await sceneRows(wdb, 'job-ret-young')).length === 1,
      'old gone, young kept', { oldJob: await jobData(wdb, 'job-ret-old'), youngJob: (await jobData(wdb, 'job-ret-young')) !== null });
    const after = await retainedTotal(wdb);
    rec.check('W4', 'W: retained total drops by exactly the 2 deleted rows (ceiling accounting, §B-3.2.5.2)', after === before - 2, before - 2, after);
    // Signed delete-rows on jobs with retention enabled -> 200, row gone.
    const delBody = JSON.stringify({ requestId: 'ret-w5', mutations: [{ type: 'delete-rows', table: 'jobs', ids: ['job-ret-young'] }] });
    const r = await http(w.mf, 'POST', '/internal/d1-apply', {
      rawBody: delBody,
      headers: signInternalCall(TEST_API_SECRET, 'POST', '/internal/d1-apply', delBody),
      contentType: 'application/json',
    });
    rec.check('W5', 'W: signed delete-rows on jobs with retention enabled -> 200 and the row is gone',
      r.status === 200 && (await jobData(wdb, 'job-ret-young')) === null, 200, r.status);
    // Retention enumeration ops (additions 25 Nov ~18:21+ WAT — design
    // gap, impl notes §10.4): list-terminal-jobs + list-expired-rate-limits.
    await seedW('job-enum-old', 'succeeded', 'succeeded', 40 * DAY);
    await seedW('job-enum-young', 'failed', 'failed', 10 * DAY);
    await seedW('job-enum-active', 'running', 'running', 40 * DAY);
    await wdb.prepare('INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('ip-hour:expired', wNow - 2 * 3600000, wNow - 3600000, 7, wNow - 3600000).run();
    await wdb.prepare('INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('ip-hour:active', wNow - 1800000, wNow + 1800000, 3, wNow - 1800000).run();
    const enumRes = await http(w.mf, 'GET', '/internal/d1-read?op=list-terminal-jobs', {
      headers: signInternalCall(TEST_API_SECRET, 'GET', '/internal/d1-read?op=list-terminal-jobs', ''),
    });
    const enumJobs = (enumRes.json && enumRes.json.jobs) || [];
    const enumIds = enumJobs.map((j) => j.id);
    const enumOld = enumJobs.find((j) => j.id === 'job-enum-old');
    rec.check('W6', 'W: signed list-terminal-jobs lists terminal jobs oldest-first with terminalAtMs, non-terminal excluded',
      enumRes.status === 200 && enumIds.includes('job-enum-old') && enumIds.includes('job-enum-young')
        && !enumIds.includes('job-enum-active')
        && enumIds.indexOf('job-enum-old') < enumIds.indexOf('job-enum-young')
        && enumOld && Math.abs(enumOld.terminalAtMs - (wNow - 40 * DAY)) < 60000
        && enumJobs.every((j) => !('data' in j)),
      'old+young listed, active excluded, old first', { status: enumRes.status, ids: enumIds });
    const rlRes = await http(w.mf, 'GET', '/internal/d1-read?op=list-expired-rate-limits', {
      headers: signInternalCall(TEST_API_SECRET, 'GET', '/internal/d1-read?op=list-expired-rate-limits', ''),
    });
    rec.check('W7', 'W: signed list-expired-rate-limits returns only the expired row',
      rlRes.status === 200 && rlRes.json && Array.isArray(rlRes.json.rateLimits)
        && rlRes.json.rateLimits.length === 1 && rlRes.json.rateLimits[0].key === 'ip-hour:expired',
      '1 expired row', { status: rlRes.status, rows: rlRes.json && rlRes.json.rateLimits });
  } finally {
    await w.mf.dispose();
  }

  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-07', TITLE, run);
}
