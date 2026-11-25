# Phase 3 implementation-time proofs — 25 Nov 2026

Read-only proof work for NOVA AI Studio Phase 3 Website Integration, under
Shina's 25 Nov 2026 17:14 WAT implementation authorisation (code + tests
only). No implementation file was edited; no commit, push, or deploy was
made; no live-database write, paid GPU dispatch, or production activation
occurred. The record document is
`../architecture/phase3-implementation-proofs-2026-11-25.md`.

## How to run

Run from the repo root (`~/workspace/nova-ai-studio`):

| Proof | Script | Exit code meaning |
|---|---|---|
| 01 D1 batch() rollback + ordering | `node phase3-proofs/proof-01-batch-rollback-ordering.mjs` | 0 = all 11 assertions passed |
| 02 22-statement batch | `node phase3-proofs/proof-02-batch-22-statements.mjs` | 0 = all 9 assertions passed |
| 03 Deployed production schema (read-only) | `bash phase3-proofs/proof-03-prod-schema-readonly.sh` | 0 = schema metadata read; writes `proof-03-output.json` (D1 list) + `proof-03-schema.json` (sqlite_master) |
| 04 Kaggle kernel status query | `bash phase3-proofs/proof-04-kaggle-kernel-status.sh` | 0 = status returned for all 3 kernels |
| 05 Attachment A(e) licence wording | `bash phase3-proofs/proof-05-licence-wording.sh` | 0 = local-record check as expected; verified wording printed |
| 06 A2 account-wide usage figure | `bash phase3-proofs/proof-06-a2-usage-source.sh` | **2 = NOT VERIFIABLE** (no measurable source in this environment) |
| 07 5s revocation / 60s ack timings | `bash phase3-proofs/proof-07-timing-measurements.sh` | **2 = NOT VERIFIABLE** (no deployed executor to measure) |

## Environment notes

- Proofs 01–02 use programmatic miniflare (from `a2-impl/node_modules`,
  same pattern as `a2-impl/test/harness.mjs`) with an in-memory D1
  (`d1Persist: false`). They never touch the remote test database
  `nova-a2-test`, let alone production. One miniflare quirk found while
  writing them: `db.exec()` rejects multi-line DDL ("incomplete input"),
  so the schema DDL in these scripts is single-line; `prepare()` with
  multi-line SQL works fine.
- Proof 03 uses the existing Cloudflare helper
  (`~/workspace/custom-connectors/custom.cloudflare/bin/cf_api.py`). Its
  only query is `SELECT type, name, sql FROM sqlite_master ...` — schema
  metadata, no row data. The response records `changed_db: false`,
  `rows_written: 0`.
- Proof 04 uses the repo's Kaggle CLI (`gpu-cloud/.venv-kaggle`,
  kaggle-api 2.2.5) and the `~/.kaggle/access_token` credential the repo
  already uses. Status polls only — no push, no dispatch, no quota spent.
- Proof 05 verifies wording against the primary licence text at
  https://huggingface.co/Lightricks/LTX-Video/raw/main/LTX-Video-Open-Weights-License-0.X.txt
  (read 25 Nov 2026). The repo's own licensing file concerns the different
  LTX-2.x Community License and holds no Attachment A text.

## Outcomes (25 Nov 2026)

- PASSED: 01, 02, 03, 04, 05 (04 and 05 with notes — see the record).
- NOT VERIFIABLE: 06, 07 (blockers recorded; no figures fabricated).
- FAILED: none.
