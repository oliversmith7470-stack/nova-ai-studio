-- NOVA AI Studio — Phase 3 D1 schema (Rev 2 §8, Rev 3 §C-1.1/§C-1.6, Rev 3.2 §B-3.2.5/§B-3.2.6,
-- Rev 3.4 §C-3.4.1).
--
-- ADDITIVE ONLY: the existing `jobs` table is unchanged in shape
-- (id TEXT PRIMARY KEY, data TEXT NOT NULL). Apply with `wrangler d1 execute`
-- against the LOCAL preview/test database first; never against the production
-- database (nova-motion-jobs) without the separate deployment authorisation.
-- The Worker creates no tables at runtime; this file is the schema record.
--
-- VERIFIED PRODUCTION STATE (proofs workstream, 25 Nov 2026, read-only via
-- cf_api.py): production nova-motion-jobs currently has ONLY the `jobs`
-- table (CREATE TABLE jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)) plus
-- Cloudflare-internal _cf_KV — NO `scenes` table, NO `rate_limits` table.
-- This file therefore creates them (CREATE TABLE IF NOT EXISTS) so they
-- exist before any Phase 3 path touching them can run. FIRST DEPLOYMENT
-- MUST run this schema against production; until then every Phase 3 path
-- that reads/writes `scenes` or `rate_limits` fails closed (500, no partial
-- state). Nothing in this file has been applied to production.

-- jobs: unchanged shape. The `data` JSON carries the Phase 3 fields:
--   status, mode ("single"|"plan"), prompt | scenes [{index, prompt}],
--   model, frames, resolution, fps, engine, accessTokenHash,
--   requestIdentityHash, requestIdentityVersion ("canonical-request-v1"),
--   dispatchState ("intent-recorded"|"submitted"), creationToken
--   (fresh crypto.randomUUID() per creation attempt, never returned),
--   mode ("controlled-test" when created in controlled-test mode),
--   createdAt / updatedAt (ISO), createdAtMs (unix ms), expiresAt.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- scenes: one row per scene execution (attempt). Rev 2 §8.2.
-- Primary key (job_id, scene_index, attempt). execution_id is UNIQUE.
-- No foreign key from scenes to jobs (Rev 3.5 §C-3.5.3.2): an orphan scene
-- row is insertable in test setup only; the design prevents partial creation.
CREATE TABLE IF NOT EXISTS scenes (
  job_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  provider_job_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  output_ref TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, scene_index, attempt)
);
CREATE INDEX IF NOT EXISTS idx_scenes_job ON scenes (job_id);

-- rate_limits: atomic counters, Rev 3 §C-1.6 (single-statement upsert).
-- key is `ip-<scope>:<hmac-sha256(ip, salt)>` (raw IP never stored).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- hmac_nonces: replay store for Worker-verified HMAC callbacks
-- (POST /internal/d1-apply, GET /internal/d1-read). Rev 3 §C-1.10:
-- a nonce is recorded ONLY after the signature verifies. Rows expire
-- (validity window + 5 minutes) and are pruned best-effort on verify.
CREATE TABLE IF NOT EXISTS hmac_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- d1_apply_requests: response replay for POST /internal/d1-apply
-- (Rev 3 §C-1.1). A repeated requestId returns the stored outcome without
-- re-applying. Mutations are idempotent by construction as well, so a
-- double apply could not double-apply state even if the record were lost.
CREATE TABLE IF NOT EXISTS d1_apply_requests (
  request_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
