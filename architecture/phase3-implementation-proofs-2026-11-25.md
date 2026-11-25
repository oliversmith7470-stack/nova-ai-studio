# NOVA AI Studio — Phase 3 Implementation-Time Proofs (25 November 2026)

- **Date:** 25 November 2026 (~17:17–18:00 WAT)
- **Authority:** Shina's implementation authorisation, 25 Nov 2026 17:14 WAT (code + tests only). Design: FINAL CONSOLIDATED APPROVAL — "APPROVED — DESIGN ONLY" (`architecture/phase3-final-consolidated-approval-2026-11-25.md`).
- **Scope of this record:** the seven implementation-time proofs the Phase 3 reviewer named as outstanding verification gates. This is a proof record, NOT a design approval, NOT a deployment, and NOT production verification.
- **Boundaries kept:** no implementation file was edited (read-only on `_worker.js`, `index.html`, D1 schema, test files); nothing committed, pushed, or deployed; no write to any D1 database (production `nova-motion-jobs` or test `nova-a2-test`); no Kaggle/paid GPU job dispatched. Proofs 01–02 ran against local miniflare in-memory D1 only. Proof 03 was read-only schema metadata. Proof 04 was read-only status polls.
- **Proof scripts:** `phase3-proofs/` (each proof as its own script + `README.md` on how to run it). Evidence files from the live calls: `phase3-proofs/proof-03-output.json`, `phase3-proofs/proof-03-schema.json`.

## Summary

| # | Proof | Outcome |
|---|---|---|
| 1 | D1 `batch()` rollback + statement ordering (local miniflare) | **PASSED** (11/11 assertions) |
| 2 | 22-statement batch behaviour (local miniflare) | **PASSED** (9/9 assertions) |
| 3 | Deployed production schema (read-only) | **PASSED** — with a material finding (see §3) |
| 4 | Kaggle kernel status query + vocabulary | **PASSED** — with a vocabulary correction (see §4) |
| 5 | Attachment A(e) licence wording | **PASSED** (wording located verbatim; owner confirmation to ship still owed) |
| 6 | A2 account-wide usage figure | **NOT VERIFIABLE** (no measurable source in this environment) |
| 7 | 5-second revocation propagation / 60-second acknowledgement window | **NOT VERIFIABLE** (no deployed executor to measure) |

Counts: **5 passed, 0 failed, 2 not verifiable.**

---

## 1. D1 `batch()` rollback + statement ordering — PASSED

- **Script:** `phase3-proofs/proof-01-batch-rollback-ordering.mjs`
- **Command:** `cd ~/workspace/nova-ai-studio && node phase3-proofs/proof-01-batch-rollback-ordering.mjs`
- **Setup:** programmatic miniflare (from `a2-impl/node_modules`, same pattern as `a2-impl/test/harness.mjs`), in-memory D1 (`d1Persist: false`), schema per Rev 2 §8: `jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL)`; `scenes(job_id, scene_index, attempt, execution_id UNIQUE, provider_job_id, status, error, output_ref, expires_at, updated_at, PRIMARY KEY(job_id, scene_index, attempt))`. No network, no remote database.
- **What was attempted:**
  - (A) A 3-statement batch — insert job, insert scene row, insert a duplicate scene row with the same `(job_id, scene_index, attempt)` primary key — to force a statement failure on the last statement.
  - (B) A 4-statement batch (insert, `SELECT COUNT(*)`, insert, `SELECT id ... ORDER BY id`) to check result ordering.
  - (C) The design's §B-3.2.1.2 creation-batch shape: conditional insert (`INSERT ... SELECT ... WHERE NOT EXISTS`) + read-back, run once fresh and once as a duplicate.
- **Exact evidence (stdout, 25 Nov 2026):** all 11 assertions passed, exit 0.
  - A: batch threw `D1_ERROR: UNIQUE constraint failed: scenes.job_id, scenes.scene_index, scenes.attempt: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`; afterwards `SELECT COUNT(*)` returned **0 jobs and 0 scenes** — the rows from statements 1 and 2 did not survive.
  - B: 4 results returned; `results[0].meta.changes = 1`; `results[1]` count = 1; `results[2].meta.changes = 1`; `results[3]` = `["job-order-1", "job-order-2"]` — results in statement order, each seeing the effects of the statements before it.
  - C: fresh create `changes = 1` with the read-back returning the row; duplicate create `changes = 0` with the read-back returning the one existing row; exactly 1 row left.
- **Outcome: PASSED.** The reviewer-confirmed property (§B-3.2.1.2) holds against local miniflare D1: sequential single-transaction execution, results in statement order, whole-batch rollback on statement failure.
- **Note:** miniflare's `db.exec()` rejects multi-line DDL ("incomplete input: SQLITE_ERROR"), so the scripts use single-line DDL. `prepare()` with multi-line SQL works. This is a harness quirk, not a D1 finding.

## 2. 22-statement batch behaviour — PASSED

- **Script:** `phase3-proofs/proof-02-batch-22-statements.mjs`
- **Command:** `cd ~/workspace/nova-ai-studio && node phase3-proofs/proof-02-batch-22-statements.mjs`
- **Setup:** same local miniflare in-memory D1 and Rev 2 §8 schema as proof 01.
- **What was attempted:** the design's maximum creation batch (Rev 3.3 / Rev 3.5 §C-3.5.5: 2 + N, i.e. 22 statements for a 20-scene plan): statement 1 = parent conditional insert with the §B-3.2.1 cap/ceiling guards (limits not reached), statement 2 = read-back, statements 3–22 = one scene insert per scene index 0–19.
- **Exact evidence (stdout, 25 Nov 2026):** all 9 assertions passed, exit 0. The 22-statement batch executed without error; 22 results returned in order; statement 1 `changes = 1`; statement 2 returned the new parent row; statements 3–22 each `changes = 1`; afterwards exactly 1 `jobs` row and exactly 20 `scenes` rows, indexes 0–19 each at attempt 1.
- **Outcome: PASSED.** The maximum 22-statement batch executes against local miniflare D1 and produces the expected rows and result shape. (This is local D1 semantics; it does not by itself prove the same against the remote D1 service.)

## 3. Deployed production schema — PASSED (read-only), with a material finding

- **Script:** `phase3-proofs/proof-03-prod-schema-readonly.sh` (evidence: `phase3-proofs/proof-03-output.json`, `phase3-proofs/proof-03-schema.json`)
- **Commands:**
  - `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_api.py GET /accounts/9dc0c3393c8a97d62933e874f3778402/d1/database` (account ID from the read-only inspection record `architecture/phase3-website-integration-inspection-2026-11-25.md` §8)
  - `python3 .../cf_api.py POST /accounts/9dc0c3393c8a97d62933e874f3778402/d1/database/138fc3d6-2b86-4ccb-baa1-70f124b69a32/query --json '{"sql": "SELECT type, name, sql FROM sqlite_master WHERE type IN ('"'"'table'"'"','"'"'index'"'"') ORDER BY type, name"}'`
- **What was attempted:** read-only schema-metadata check of the production D1 database. The brief carried two conflicting production uuid strings, so the uuid was NOT trusted from the brief: it was taken from the list response, matched on the name `nova-motion-jobs`. The only query was against `sqlite_master` (table/index names + DDL) — schema metadata, never row contents.
- **Exact evidence:**
  - List response (`success: true`, 2 databases): `nova-a2-test` uuid `2f007da2-f9db-4f83-ac68-782571dbbd8e`; **`nova-motion-jobs` uuid `138fc3d6-2b86-4ccb-baa1-70f124b69a32`**, created 2026-11-23T21:16:35.173Z. (The brief's second uuid string was the correct one.)
  - Schema query response (`success: true`, served by `v3-prod`, `changed_db: false`, `rows_written: 0`, `size_after: 28672` — unchanged, confirming read-only): exactly three entries —
    - index `sqlite_autoindex_jobs_1`
    - table `_cf_KV` — `CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID` (Cloudflare-internal)
    - table `jobs` — `CREATE TABLE jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)`
- **Outcome: PASSED** (the read was performed; the schema was obtained).
- **Material finding:** the deployed production schema contains **only the `jobs` table**. There is **no `scenes` table and no `rate_limits` table** — the two additive tables Rev 2 §8 requires Phase 3 to add. The deployed `jobs` DDL does match Rev 2 §8 (`id TEXT PRIMARY KEY, data TEXT NOT NULL`). Implementation must therefore create `scenes` and `rate_limits` (per the design's additive-table plan) before any Phase 3 code path that touches them can run against production; T31-14/T31-17-style tests that assume those tables exist will fail against the deployed schema as it stands. (Side note: the list endpoint reported `num_tables: 0` for both databases, which contradicts the actual schema — the `sqlite_master` query, not the list figure, is authoritative.)
- **No writes were made and no data was read.** Nothing beyond schema metadata was requested.

## 4. Kaggle kernel status query + status vocabulary — PASSED, with a vocabulary correction

- **Script:** `phase3-proofs/proof-04-kaggle-kernel-status.sh`
- **Commands (repo Kaggle CLI, `gpu-cloud/.venv-kaggle/bin/kaggle`, kaggle-api 2.2.5; read-only status polls only — no push, no dispatch, no quota spent):**
  - `kaggle kernels status oliversmithh/nova-gpu-cloud-smoke-20261124-01` → `oliversmithh/nova-gpu-cloud-smoke-20261124-01 has status "KernelWorkerStatus.COMPLETE"` (exit 0)
  - `kaggle kernels status oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01` → `... has status "KernelWorkerStatus.ERROR"` (exit 0)
  - `kaggle kernels status oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01` → `... has status "KernelWorkerStatus.COMPLETE"` (exit 0)
  - `kaggle kernels list --mine` confirmed the three slugs above are the owner's kernels (author "Oliver Smithh"); the slug cited in `architecture/smoke-blocker-review-reply-verbatim-2026-11-24.md:190` (`oliversmithh/nova-gpu-cloud-smoke-20261124-02`) is NOT in the owner's list and returns 401/403 `Cannot access kernel ... (Permission 'kernels.get' was denied)` — that slug appears to be wrong or inaccessible, not a query failure.
- **Vocabulary (from the installed SDK source, `kagglesdk/kernels/types/kernels_enums.py`, class `KernelWorkerStatus`):** `QUEUED = 0, RUNNING = 1, COMPLETE = 2, ERROR = 3, CANCEL_REQUESTED = 4, CANCEL_ACKNOWLEDGED = 5, NEW_SCRIPT = 6`. The CLI prints the prefixed form (`KernelWorkerStatus.COMPLETE`), and the SDK's `kernels_status` returns that enum (via `ApiGetKernelSessionStatusRequest` / `get_kernel_session_status`).
- **Outcome: PASSED** — the status query exists, authenticates with the repo's existing `~/.kaggle/access_token` credential, and returns a status for real kernels.
- **Correction the design needs:** the design (§B-3.2.3.3) assumes the bare vocabulary `QUEUED / RUNNING / COMPLETE / ERROR`. The wire values are the prefixed `KernelWorkerStatus.*` forms, and there are **three additional states the design's six-state mapping does not account for**: `CANCEL_REQUESTED`, `CANCEL_ACKNOWLEDGED`, `NEW_SCRIPT`. The `getExecutionState` mapping must strip the prefix and decide what `CANCEL_*` / `NEW_SCRIPT` map to (or treat them as `unknown`) — otherwise a status string comparison against bare `QUEUED`/`RUNNING`/etc. will never match. Observed live: `COMPLETE` (×2) and `ERROR` (×1). `QUEUED`/`RUNNING` were confirmed as enum members only — no kernel was in those states at proof time, so their live strings were not observed (they follow the same `KernelWorkerStatus.<MEMBER>` pattern).

## 5. Attachment A(e) licence wording — PASSED

- **Script:** `phase3-proofs/proof-05-licence-wording.sh`
- **What was attempted:** (a) check whether the exact A(e) wording exists anywhere in the local repo; (b) verify it against the primary source, the licence text itself.
- **Exact evidence:**
  - (a) `grep -rn "without expressly and intelligibly disclaiming" licensing/ architecture/ a2-impl/ gpu-cloud/src/` — **no match**: the exact wording is NOT in the local record; only the reviewer's summary exists (`architecture/ltx-model-decision-review-reply-verbatim-2026-11-24.md:77`). The repo's only licensing file, `licensing/ltx-licensing-clarification-email-2026-11-22.md`, concerns the **LTX-2.x Community License** (non-compete clarification, reply awaited) — a different licence from the LTXV Open Weights License 0.X that governs the LTX-Video 2B checkpoint — and contains no Attachment A text.
  - (b) Primary source read 25 Nov 2026: https://huggingface.co/Lightricks/LTX-Video/raw/main/LTX-Video-Open-Weights-License-0.X.txt — "LTXV Open Weights License 0.X, License date: April 15, 2025", lines 142–143 of the fetched text. The exact wording is:
    > "(e) To generate or disseminate information and/or content (e.g. images, code, posts, articles), and place the information and/or content in any context (e.g. bot generating tweets) without expressly and intelligibly disclaiming that the information and/or content is machine generated;"
  - This matches the reviewer's summary exactly. §§3.1 and 4 were also confirmed in the same text (lines 61–63, 76–79).
- **Outcome: PASSED** — the exact Attachment A(e) wording is now located verbatim from the actual licence text.
- **Still owed (not granted by this proof):** the design (§19.2, Q5) requires Shina's confirmation (and legal counsel's, if he engages one) before the disclosure ships on this wording. This proof locates the wording; it does not authorise shipping it.

## 6. A2 account-wide usage figure — NOT VERIFIABLE

- **Script:** `phase3-proofs/proof-06-a2-usage-source.sh` (exit 2 by design)
- **What was attempted:** find the actual measurable usage source the design requires (Rev 2 §15.3: "the account-wide usage figure defined in the A2 cost document", i.e. the provider's usage reporting per `a2-design/a2-zero-cost-compliance.md` §8 items 1–4) — or establish that no such source is available from this environment.
- **Exact evidence:**
  - The A2 cost document itself records total account usage as **unmeasured**: "total account usage unmeasured (§8 item 3)" (`a2-zero-cost-compliance.md:643`); "figures are an UPPER BOUND on true headroom (total account usage unmeasured, O-12/O-13)" (`:1295`). AC2 test 12 is PARTIAL; AC2 is NOT PASSED.
  - No usage-reporting endpoint is documented in the Cloudflare connector doc (`~/workspace/custom-connectors/custom.cloudflare/CONNECTOR.md` — no `usage`/`graphql`/`analytics` endpoint), and no concrete usage query (GraphQL/analytics API) is established anywhere in `a2-design/`, `gpu-cloud/docs/`, or `architecture/` (prose mentions of "usage reporting" exist; no query does).
- **Outcome: NOT VERIFIABLE. Blocker:** no measurable account-wide usage source is available from this environment, and no figure was produced (none fabricated). The design's fail-closed rule (§15.3) therefore applies: a sweep that cannot read the figure defers. Establishing the source is AC2 test 12's work, not this proof's.

## 7. 5-second revocation propagation / 60-second acknowledgement window — NOT VERIFIABLE

- **Script:** `phase3-proofs/proof-07-timing-measurements.sh` (exit 2 by design)
- **What was attempted:** establish whether ANY measurement of either timing is possible locally — checking for a running API process, listening sockets, a deployed executor / manager store, and a two-process deployment.
- **Exact evidence (25 Nov 2026):** no `api-server`/`gpu-manager` process running on this machine; no listening sockets at all (`ss -ltn` empty); `gpu-cloud/systemd/` contains only `README.md`, `install.sh`, `nova-storage-runner.service` — no api-server service, no deployed manager store. Production Phase 3 has a single API process by design (§B-3.2.4.2); the two-process case exists only as the T31-08 test setup, which itself needs the deployed manager store.
- **Outcome: NOT VERIFIABLE. Blocker:** no deployed executor and no running API process exist in this environment — the API process, manager store, and executor live on the GPU host / deployment that Phase 3 has not deployed (deployment unauthorised). A 5-second revocation propagation interval and a 60-second acknowledgement window are timings of a live distributed system; they cannot be measured against a local miniflare harness or a static file. No figures were fabricated. Designated proofs remain T31-08 (revocation, two processes sharing one manager store) and the real-executor timing evidence for the 60-second window (§B-3.2.8), both requiring deployment + a live executor.

---

## What this record does NOT claim

- No approval, deployment, or production verification is claimed. The design approval ("APPROVED — DESIGN ONLY") is unchanged; implementation authorisation (code + tests only) is unchanged; deployment, live-database writes, paid GPU dispatch, and production activation remain unauthorised.
- Proofs 01–02 prove D1 `batch()` semantics against **local miniflare D1**, not against the remote D1 service.
- Proof 03 proves the deployed production schema **as read**; it does not authorise changing it.
- Proof 04 proves the Kaggle status query works; it does not dispatch anything and does not prove the executor integration end to end.
- Proof 05 locates the licence wording; it does not authorise shipping the disclosure (owner confirmation still owed per §19.2/Q5).
- Proofs 06–07 remain open: the A2 usage figure needs AC2 test 12's measurable source; the two timings need a deployed executor.

— End of record. —
