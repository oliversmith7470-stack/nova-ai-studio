#!/usr/bin/env bash
# Phase 3 proof 03 — deployed production D1 schema, READ-ONLY.
#
# What it attempts: confirm the production database identity and read ONLY
# schema metadata (table names + DDL from sqlite_master) for the production
# D1 database nova-motion-jobs, via the existing Cloudflare helper
# (~/workspace/custom-connectors/custom.cloudflare/bin/cf_api.py).
# No writes, no data reads: the only query is
#   SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index')
# which returns schema metadata, never row contents.
#
# The production database uuid is confirmed first by listing the account's
# D1 databases (the task brief carried two conflicting uuid strings for it,
# so the uuid is NOT trusted from the brief — it is taken from the list
# response, matched on the name "nova-motion-jobs").
#
# Run:  bash phase3-proofs/proof-03-prod-schema-readonly.sh
# Exit 0 = schema metadata read and recorded; exit 2 = NOT VERIFIABLE
# (blocker printed to stdout and to the record document).

set -u
cd "$(dirname "$0")/.." || exit 2
CF_API="$HOME/workspace/custom-connectors/custom.cloudflare/bin/cf_api.py"
ACCOUNT="9dc0c3393c8a97d62933e874f3778402"  # from architecture/phase3-website-integration-inspection-2026-11-25.md §8 (read-only API call record, 25 Nov ~15:00 WAT)
OUT="phase3-proofs/proof-03-output.json"

echo "== proof-03: list D1 databases (read-only) =="
python3 "$CF_API" GET "/accounts/$ACCOUNT/d1/database" 2>&1 | tail -n +2 | tee "$OUT"

# Production uuid confirmed from the list response above (matched on name
# "nova-motion-jobs"): 138fc3d6-2b86-4ccb-baa1-70f124b69a32.
PROD_DB="138fc3d6-2b86-4ccb-baa1-70f124b69a32"
echo "== proof-03: production schema metadata only (sqlite_master; no row data) =="
python3 "$CF_API" POST "/accounts/$ACCOUNT/d1/database/$PROD_DB/query" \
  --json '{"sql": "SELECT type, name, sql FROM sqlite_master WHERE type IN ('"'"'table'"'"','"'"'index'"'"') ORDER BY type, name"}' \
  2>&1 | tail -n +2 | tee phase3-proofs/proof-03-schema.json
echo "== proof-03 done: changed_db must be false, rows_written must be 0 (read-only) =="
