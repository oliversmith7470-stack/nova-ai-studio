// NOVA AI Studio — Phase 3 Website Integration acceptance tests.
//
// Shared harness for T31-01–T31-17 (Rev 3.2 §B-3.2.13, as amended by
// Rev 3.3 §C-3.3.2, Rev 3.4 §C-3.4.3, Rev 3.5 §C-3.5.2).
//
// Design authority: Rev 2 (base) + Rev 3 + Rev 3.1 + Rev 3.2 + Rev 3.3 +
// Rev 3.4 + Rev 3.5, FINAL CONSOLIDATED APPROVAL "APPROVED — DESIGN ONLY"
// (architecture/phase3-final-consolidated-approval-2026-11-25.md).
// Implementation authorised by Shina 25 Nov 2026 17:14 WAT — code + tests
// only. No deployment, no live-database writes, no paid GPU dispatch.
//
// Two layers, kept distinct in every test file:
//   W-layer (Worker wiring): HTTP against the real _worker.js booted in
//     local miniflare with an in-memory D1 (binding NOVA_DB). Proves the
//     Worker wires the design behaviour.
//   S-layer (SQL semantics): the design's exact SQL statements executed
//     directly against the same local D1 via mf.getD1Database().
//     Proves the batch/transaction/ceiling/marker semantics against
//     ACTUAL D1-equivalent semantics (miniflare D1 = SQLite, the same
//     engine family as D1), never mocked affected-row counts (T31-01
//     condition, §A-3.1.5.3 / §B-3.2.13). An S-layer PASS proves the
//     design SQL; it does NOT prove the Worker uses that SQL — only a
//     W-layer PASS proves that.
//
// Verdict rules (per test): FAIL if any assertion failed (implementation
// present, behaviour wrong); else BLOCKED if any assertion could not be
// executed (required seam/endpoint absent — do NOT mark passed, do NOT
// weaken the test); else PASS.
//
// miniflare is resolved from a2-impl/node_modules (the established
// harness location); this directory carries a node_modules symlink so
// `import ... from 'miniflare'` resolves.

import { Miniflare } from 'miniflare';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKER_PATH = path.join(REPO, '_worker.js');
export const ASSETS_DIR = path.join(REPO, 'phase3-tests', 'assets'); // fresh copy of ../../index.html, refreshed per boot

export const CEILING = 100000;
export const ALERT_ROWS = 10000;
export const ALERT_BYTES = 10 * 1024 * 1024;

// Controlled-test credentials (TEST-ONLY values, never production).
// The Worker reads them from env bindings; the stub API process and
// the signing helper use the same values.
export const TEST_API_SECRET = 'phase3-test-api-secret-0123456789abcdef';
export const TEST_KEY = 'phase3-test-key-0123456789abcdef';

export function testKeyHeaders() {
  return { 'X-NOVA-TEST-KEY': TEST_KEY };
}

// Sign an API-process -> Worker internal call, mirroring the Worker's
// own signApiCall exactly (§11 / Rev 3 §C-1.10): canonical string
// METHOD\npath\ntimestamp\nnonce\nbodyHash, HMAC-SHA-256 hex.
export function signInternalCall(secret, method, path, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return {
    'X-NOVA-API-SECRET': secret,
    'X-NOVA-SIGNATURE': signature,
    'X-NOVA-TIMESTAMP': timestamp,
    'X-NOVA-NONCE': nonce,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------- boot

export const PROBE_PATH = path.join(REPO, 'phase3-tests', 'probe', 'worker.mjs');

// boot(): the real _worker.js (W-layer). boot({ probe: true }): the
// minimal probe worker (S-layer only) — same in-memory D1, no
// application logic, so SQL-semantics results do not depend on
// _worker.js being parseable while the implementation workstream edits it.
// boot({ api: stub }): the Worker is bound to a stub API process
// (controlled-test mode: NOVA_API_MODE=controlled-test, origin +
// secret + test key) so generation can proceed end-to-end locally.
export async function boot(opts = {}) {
  return bootWith({ assets: false, probe: !!opts.probe, api: opts.api ?? null, bindings: opts.bindings ?? {} });
}

// HTML/CSP tests ONLY. The `assets` miniflare option is UNUSABLE for
// this: it serves files itself and the request never reaches the
// Worker (its GET / returned Cache-Control: public, max-age=0 with no
// nonce). Instead the Worker is bound to a custom fetch service
// (serviceBindings accept a plain Node function) that serves the
// CURRENT repo index.html for / and /index.html — so the request DOES
// reach _worker.js, which fetches env.ASSETS and applies its nonce
// injection + headers (serveAssetWithCsp). The served HTML is read
// fresh from disk on every boot.
export async function bootWithAssets() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const assetsFetch = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not Found', { status: 404 });
  };
  return bootWith({ assets: false, serviceBindings: { ASSETS: assetsFetch } });
}

async function bootWith({ assets, probe, api, bindings = {}, serviceBindings = {} }) {
  const mf = new Miniflare({
    modules: true,
    root: REPO, // workerd forbids paths escaping its starting dir
    scriptPath: probe ? PROBE_PATH : WORKER_PATH,
    d1Databases: { NOVA_DB: 'nova-phase3-test' },
    d1Persist: false, // in-memory: fresh every run, never production D1
    compatibilityDate: '2025-01-01',
    serviceBindings,
    bindings: {
      ...(api ? {
        NOVA_API_MODE: 'controlled-test',
        NOVA_API_ORIGIN: api.origin,
        NOVA_API_SECRET: TEST_API_SECRET,
        NOVA_TEST_KEY: TEST_KEY,
      } : {}),
      ...bindings,
    },
    // Static assets: only index.html (fresh copy), so the CSP tests can
    // fetch the real SPA. The whole repo cannot be the assets dir (a
    // 26 MB pack file exceeds the 25 MiB asset limit).
    ...(assets ? { assets: { directory: ASSETS_DIR, binding: 'ASSETS' } } : {}),
  });
  const db = await mf.getD1Database('NOVA_DB');
  await seedSchema(db);
  // Warm-up: force Worker + workerd to initialise before timing tests.
  await mf.dispatchFetch('http://test.invalid/api/capacity');
  return { mf, db };
}

export async function seedSchema(db) {
  // Rev 2 §8 schema (jobs unchanged in shape; scenes + rate_limits additive).
  // No foreign key from scenes to jobs (Rev 3.5 §C-3.5.3.2) — orphan scene
  // rows are insertable via direct SQL in test setup.
  // D1 exec() accepts one statement per call, single-line only.
  await db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  await db.exec('CREATE TABLE IF NOT EXISTS scenes (job_id TEXT, scene_index INTEGER, attempt INTEGER, execution_id TEXT UNIQUE, provider_job_id TEXT, status TEXT, error TEXT, output_ref TEXT, expires_at INTEGER, updated_at INTEGER, PRIMARY KEY (job_id, scene_index, attempt))');
  await db.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER, window_end INTEGER, count INTEGER, updated_at INTEGER)');
  // HMAC nonce store for /internal/* verification (the Worker INSERTs
  // here but never creates the table — the schema must provide it).
  await db.exec('CREATE TABLE IF NOT EXISTS hmac_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER)');
  // Response-replay store for POST /internal/d1-apply (Rev 3 §C-1.1):
  // a repeated requestId returns the stored outcome without re-applying.
  await db.exec('CREATE TABLE IF NOT EXISTS d1_apply_requests (request_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_scenes_job ON scenes (job_id)');
}

// ---------------------------------------------------------------- HTTP

export async function http(mf, method, urlPath, opts = {}) {
  const init = { method, headers: { ...(opts.headers ?? {}) } };
  if (opts.rawBody !== undefined) {
    init.body = opts.rawBody; // string | Uint8Array — sent verbatim
    if (opts.contentType) init.headers['content-type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await mf.dispatchFetch(`http://test.invalid${urlPath}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, text, json };
}

// ---------------------------------------------------------------- ids / tokens / canonical

export function newJobId() {
  return `nova-job-${crypto.randomUUID()}`;
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-hex job token
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalSingle(prompt) {
  // Fixed field order §A-3.1.1.2: mode, prompt, model, frames, resolution, fps.
  return JSON.stringify({ mode: 'single', prompt, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 });
}

export function canonicalPlan(scenes) {
  // Each scene: exactly { index, prompt } in that order, ascending index.
  const ordered = [...scenes].sort((a, b) => a.index - b.index)
    .map((s) => ({ index: s.index, prompt: s.prompt }));
  return JSON.stringify({ mode: 'plan', scenes: ordered, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 });
}

export function generateBodySingle(jobId, prompt = 'A dragon over a ridge at dawn') {
  return { jobId, mode: 'single', prompt, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 };
}

export function generateBodyPlan(jobId, n, baseIndex = 0) {
  const scenes = [];
  for (let i = 0; i < n; i++) scenes.push({ index: baseIndex + i, prompt: `Scene ${baseIndex + i} prompt` });
  return { jobId, mode: 'plan', scenes, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 };
}

export function authHeaders(token) {
  return { 'X-NOVA-JOB-TOKEN': token };
}

// ---------------------------------------------------------------- D1 helpers

export async function retainedTotal(db) {
  const row = await db.prepare(
    'SELECT (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS n',
  ).first();
  return row.n;
}

export async function retainedBytes(db) {
  // Exact §B-3.2.6.2 SQL — the one definition for alert check + sweep report.
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS retained_rows,
      (SELECT COALESCE(SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(data AS BLOB))), 0)
         FROM jobs)
      + (SELECT COALESCE(SUM(
            LENGTH(CAST(job_id AS BLOB))
            + LENGTH(CAST(execution_id AS BLOB))
            + LENGTH(CAST(COALESCE(provider_job_id, '') AS BLOB))
            + LENGTH(CAST(status AS BLOB))
            + LENGTH(CAST(COALESCE(error, '') AS BLOB))
            + LENGTH(CAST(COALESCE(output_ref, '') AS BLOB))
            + 32
          ), 0)
         FROM scenes) AS retained_bytes`).first();
  return { rows: row.retained_rows, bytes: row.retained_bytes };
}

export async function jobRow(db, jobId) {
  return db.prepare('SELECT id, data FROM jobs WHERE id = ?').bind(jobId).first();
}

export async function sceneRows(db, jobId) {
  const r = await db.prepare(
    'SELECT job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at FROM scenes WHERE job_id = ? ORDER BY scene_index, attempt',
  ).bind(jobId).all();
  return r.results;
}

export async function jobData(db, jobId) {
  const row = await jobRow(db, jobId);
  return row ? JSON.parse(row.data) : null;
}

// Bulk filler: insert exactly `nJobs` filler jobs and `nScenes` filler
// scenes via recursive CTEs (measured: 100k rows in ~150 ms). Filler
// data is '{}' so no filler row matches any token's accessTokenHash.
export async function seedFiller(db, nJobs, nScenes) {
  if (nJobs > 0) {
    await db.exec(`INSERT INTO jobs (id, data) SELECT 'seed-job-' || n, '{}' FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < ${nJobs}) SELECT n FROM c)`);
  }
  if (nScenes > 0) {
    await db.exec(`INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) SELECT 'seed-parent', (n-1) % 20, ((n-1) / 20) + 1, 'seed-parent:scene-' || ((n-1) % 20) || ':attempt-' || (((n-1) / 20) + 1), NULL, 'queued', NULL, NULL, NULL, 1700000000000 FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < ${nScenes}) SELECT n FROM c)`);
  }
}

// Seed one job (parent + scene rows) via direct SQL — test setup only.
export async function seedJob(db, opts) {
  const {
    jobId, token, dispatchState = 'intent-recorded', status = 'queued',
    scenes = [], // [{index, attempt, status, executionId?, providerJobId?}]
    plan = null, createdAt = new Date().toISOString(),
  } = opts;
  const tokenHash = sha256Hex(token);
  const reqHash = plan
    ? sha256Hex(canonicalPlan(plan))
    : sha256Hex(canonicalSingle(plan?.prompt ?? 'A dragon over a ridge at dawn'));
  const data = {
    id: jobId, createdAt, updatedAt: createdAt, status, dispatchState,
    accessTokenHash: tokenHash, requestIdentityHash: reqHash,
    requestIdentityVersion: 'canonical-request-v1',
    creationToken: crypto.randomUUID(), engine: 'ltx-video-2b',
    ...(plan ? { mode: 'plan', scenes: plan, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 }
            : { mode: 'single', prompt: 'A dragon over a ridge at dawn', model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 }),
  };
  await db.prepare('INSERT INTO jobs (id, data) VALUES (?, ?)')
    .bind(jobId, JSON.stringify(data)).run();
  for (const s of scenes) {
    await db.prepare(`INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
        status, error, output_ref, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
      .bind(jobId, s.index, s.attempt,
        s.executionId ?? `${jobId}:scene-${s.index}:attempt-${s.attempt}`,
        s.providerJobId ?? null, s.status ?? 'queued', Date.now()).run();
  }
  return { data, tokenHash, reqHash };
}

// ---------------------------------------------------------------- design SQL

// The Rev 3.4 creation batch (§C-3.4.1.2, as amended from Rev 3.3
// §C-3.3.1.2): 2 + N statements, built entirely before submission.
// Statement 1 reserves the COMPLETE footprint (1 + N <= 100000) and
// carries the per-token active cap (< 3) and the NOT EXISTS duplicate
// guard. Statements 2..N+1 are marker-gated scene inserts (no NOT
// EXISTS — a fresh-path conflict fails with a PRIMARY KEY violation and
// rolls the whole batch back; a duplicate-path marker mismatch is a
// silent no-op). Statement N+2 reads the parent back.
export async function creationBatch(db, opts) {
  const { jobId, token, n, planScenes, prompt, now = Date.now(), creationToken = crypto.randomUUID() } = opts;
  const tokenHash = sha256Hex(token);
  const reqHash = planScenes
    ? sha256Hex(canonicalPlan(planScenes))
    : sha256Hex(canonicalSingle(prompt ?? 'A dragon over a ridge at dawn'));
  const data = {
    id: jobId, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    status: 'queued', dispatchState: 'intent-recorded',
    accessTokenHash: tokenHash, requestIdentityHash: reqHash,
    requestIdentityVersion: 'canonical-request-v1', creationToken, engine: 'ltx-video-2b',
    ...(planScenes
      ? { mode: 'plan', scenes: planScenes, model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 }
      : { mode: 'single', prompt: prompt ?? 'A dragon over a ridge at dawn', model: 'ltx-video-2b', frames: 121, resolution: '1024x576', fps: 24 }),
  };
  const stmts = [];
  stmts.push(db.prepare(`INSERT INTO jobs (id, data)
    SELECT ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?)
      AND (SELECT COUNT(*) FROM jobs
           WHERE json_extract(data, '$.accessTokenHash') = ?
             AND json_extract(data, '$.status')
                 NOT IN ('succeeded','failed','timed-out','cancelled','expired')) < 3
      AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) + 1 + ? <= 100000`)
    .bind(jobId, JSON.stringify(data), jobId, tokenHash, n));
  const indexes = planScenes ? planScenes.map((s) => s.index) : [0];
  for (const idx of indexes) {
    stmts.push(db.prepare(`INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
        status, error, output_ref, expires_at, updated_at)
        SELECT ?, ?, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?
        WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?
                      AND json_extract(data, '$.creationToken') = ?)`)
      .bind(jobId, idx, `${jobId}:scene-${idx}:attempt-1`, now, jobId, creationToken));
  }
  stmts.push(db.prepare('SELECT id, data FROM jobs WHERE id = ?').bind(jobId));
  try {
    const results = await db.batch(stmts);
    return {
      ok: true, creationToken,
      parentChanges: results[0]?.meta?.changes ?? null,
      sceneChanges: results.slice(1, 1 + n).map((r) => r?.meta?.changes ?? null),
      row: results[1 + n]?.results?.[0] ?? null,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), creationToken };
  }
}

// Diagnostic read (§B-3.2.1.2 as amended §C-3.3.1.2): limit attribution
// only — never a correctness mechanism. Returns 'retention' | 'cap' | 'unexpected'.
export async function diagnoseLimit(db, tokenHash, n) {
  const total = await retainedTotal(db);
  if (total + 1 + n > CEILING) return 'retention';
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM jobs
    WHERE json_extract(data, '$.accessTokenHash') = ?
      AND json_extract(data, '$.status')
          NOT IN ('succeeded','failed','timed-out','cancelled','expired')`)
    .bind(tokenHash).first();
  if (row.c >= 3) return 'cap';
  return 'unexpected';
}

// Rev 3.4 §C-3.4.2.2 repair-scene-row mutation: one guarded row.
export async function repairSceneRow(db, jobId, sceneIndex, now = Date.now()) {
  const stmts = [db.prepare(`INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
      status, error, output_ref, expires_at, updated_at)
      SELECT ?, ?, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?
      WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM scenes
                        WHERE job_id = ? AND scene_index = ? AND attempt = 1)
        AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) < 100000`)
    .bind(jobId, sceneIndex, `${jobId}:scene-${sceneIndex}:attempt-1`, now, jobId, jobId, sceneIndex)];
  try {
    const results = await db.batch(stmts);
    return { ok: true, changes: results[0]?.meta?.changes ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// Rev 3.5 §C-3.5.1.2 completeness: per-index attempt-1 presence, never
// a row count. Retry rows (attempt >= 2) are never substitutes.
export async function checkCompleteness(db, jobId, expectedIndexes) {
  const rows = await sceneRows(db, jobId);
  const attempt1 = new Set(rows.filter((r) => r.attempt === 1).map((r) => r.scene_index));
  const missing = expectedIndexes.filter((i) => !attempt1.has(i));
  return { complete: missing.length === 0, missing, totalRows: rows.length, attempt1: [...attempt1].sort((a, b) => a - b) };
}

// §B-3.2.2.3 mark-submitted batch: dispatchState guard (one-way) +
// provider_job_id set where NULL (idempotent).
export async function markSubmitted(db, jobId, providerJobIds) {
  // providerJobIds: [{sceneIndex, attempt, providerJobId}]
  const stmts = [db.prepare(`UPDATE jobs SET data = json_set(data, '$.dispatchState', 'submitted')
      WHERE id = ? AND json_extract(data, '$.dispatchState') = 'intent-recorded'`).bind(jobId)];
  for (const p of providerJobIds) {
    stmts.push(db.prepare(`UPDATE scenes SET provider_job_id = ?
        WHERE job_id = ? AND scene_index = ? AND attempt = ?
          AND provider_job_id IS NULL`).bind(p.providerJobId, jobId, p.sceneIndex, p.attempt));
  }
  const results = await db.batch(stmts);
  return { jobChanges: results[0]?.meta?.changes ?? null, sceneChanges: results.slice(1).map((r) => r?.meta?.changes ?? null) };
}

// ---------------------------------------------------------------- recorder

export class Recorder {
  constructor(testId, title) {
    this.testId = testId;
    this.title = title;
    this.assertions = [];
    this.notes = [];
    this.started = Date.now();
  }

  check(id, description, pass, expected, actual) {
    this.assertions.push({ id, description, status: pass ? 'pass' : 'fail', expected, actual });
    return Boolean(pass);
  }

  blocked(id, description, reason) {
    this.assertions.push({ id, description, status: 'blocked', expected: 'runnable assertion', actual: `BLOCKED: ${reason}` });
  }

  note(text) {
    this.notes.push(text);
  }

  get verdict() {
    if (this.assertions.some((a) => a.status === 'fail')) return 'FAIL';
    if (this.assertions.some((a) => a.status === 'blocked')) return 'BLOCKED';
    if (this.assertions.length === 0) return 'BLOCKED';
    return 'PASS';
  }

  summary() {
    const p = this.assertions.filter((a) => a.status === 'pass').length;
    const f = this.assertions.filter((a) => a.status === 'fail').length;
    const b = this.assertions.filter((a) => a.status === 'blocked').length;
    return {
      test: this.testId, title: this.title, verdict: this.verdict,
      passed: p, failed: f, blocked: b, total: this.assertions.length,
      durationMs: Date.now() - this.started,
      assertions: this.assertions, notes: this.notes,
    };
  }

  print() {
    const s = this.summary();
    console.log(`\n== ${s.test} — ${s.title} ==`);
    console.log(`VERDICT: ${s.verdict} (${s.passed} pass / ${s.failed} fail / ${s.blocked} blocked, ${s.durationMs} ms)`);
    for (const a of s.assertions) {
      console.log(`  [${a.status.toUpperCase()}] ${a.id} — ${a.description}`);
      if (a.status !== 'pass') {
        console.log(`         expected: ${JSON.stringify(a.expected)}`);
        console.log(`         actual:   ${JSON.stringify(a.actual)}`);
      }
    }
    for (const n of s.notes) console.log(`  (note) ${n}`);
    return s;
  }
}

// Run a test file's main() when executed directly: prints the JSON
// summary as the last line, exits 0 PASS / 1 FAIL / 2 BLOCKED.
export async function runMain(testId, title, fn) {
  const rec = new Recorder(testId, title);
  let mf = null;
  try {
    await fn(rec, { setMf: (v) => { mf = v; } });
  } catch (error) {
    const msg = String(error?.stack ?? error);
    if (/ERR_MODULE_PARSE|ERR_RUNTIME_FAILURE/.test(msg)) {
      // The Worker (or the runtime) could not start, so the W-layer
      // assertions in this file could not run at all. That is a
      // cannot-run condition (BLOCKED), not a test bug — the S-layer
      // assertions already recorded stand on their own. The boot
      // failure itself is reported verbatim in the test report.
      rec.blocked('worker-boot', 'real _worker.js boots in miniflare (W-layer runnable)', `boot failed: ${msg.slice(0, 400)}`);
    } else {
      rec.check('harness-error', 'test file completed without throwing', false, 'no throw', msg.slice(0, 2000));
    }
  } finally {
    if (mf) { try { await mf.dispose(); } catch { /* ignore */ } }
  }
  const s = rec.print();
  console.log(`__PHASE3_RESULT__ ${JSON.stringify(s)}`);
  process.exit(s.verdict === 'PASS' ? 0 : s.verdict === 'FAIL' ? 1 : 2);
}

// Source-grep probe: does the repo contain a runnable seam for a
// design component? Used to evidence BLOCKED verdicts honestly.
export function seamPresent(pattern) {
  const roots = [
    path.join(REPO, '_worker.js'),
    path.join(REPO, 'gpu-cloud', 'src', 'gpu-manager.js'),
    path.join(REPO, 'gpu-cloud', 'src', 'reconcile.js'),
    path.join(REPO, 'gpu-cloud', 'src', 'store.js'),
    path.join(REPO, 'gpu-cloud', 'src', 'storage', 'engine.js'),
  ];
  for (const f of roots) {
    try {
      if (pattern.test(fs.readFileSync(f, 'utf8'))) return f;
    } catch { /* missing file */ }
  }
  return null;
}
