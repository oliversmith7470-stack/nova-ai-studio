#!/usr/bin/env bash
# Phase 3 proof 06 — A2 account-wide usage figure: is there a measurable source?
#
# The design (Rev 2 §15.3) requires, before each sweep batch, the
# "account-wide usage figure defined in the A2 cost document (the usage
# source for test 12 — account-wide usage O-12/O-13)". The A2 cost document
# (a2-design/a2-zero-cost-compliance.md §8) defines that figure as four
# items, the first of which is "Measured baseline usage — the existing
# workload's consumption before A2 ..., measured from the provider's usage
# reporting, not estimated", and the third is total projected account usage
# including every other workload on the account.
#
# This script checks whether any such measurable source is available from
# this environment: (a) the cost document's own status for that figure,
# (b) any usage-reporting endpoint/query established in the Cloudflare
# connector docs or anywhere in the repo.
#
# Run:  bash phase3-proofs/proof-06-a2-usage-source.sh
# Exit 2 = NOT VERIFIABLE (no measurable source available from this
# environment; no figure produced). Exit 0 would mean a figure was found.

set -u
cd "$(dirname "$0")/.." || exit 2
echo "== proof-06: A2 cost document's own status for total account usage =="
grep -n "total account usage unmeasured" a2-design/a2-zero-cost-compliance.md | head -3
grep -n "Account-wide cost" a2-design/a2-zero-cost-compliance.md | head -3
echo "== proof-06: any usage-reporting endpoint in the Cloudflare connector doc? =="
grep -ri "usage\|graphql\|analytics" workspace/custom-connectors/custom.cloudflare/CONNECTOR.md 2>/dev/null | head -5
grep -ri "usage\|graphql" "$HOME/workspace/custom-connectors/custom.cloudflare/CONNECTOR.md" 2>/dev/null | head -5
echo "(empty = no usage endpoint documented in the connector)"
echo "== proof-06: any usage-reporting API query/endpoint established anywhere in the repo? =="
echo "(looking for a concrete GraphQL/analytics query or usage API path, not prose mentions of 'usage reporting')"
grep -rn "graphql" a2-design/ gpu-cloud/docs/ architecture/ "$HOME/workspace/custom-connectors/custom.cloudflare/" 2>/dev/null | grep -v backups | head -5
grep -rn "analytics-api\|/usage" a2-design/ gpu-cloud/docs/ architecture/ "$HOME/workspace/custom-connectors/custom.cloudflare/" 2>/dev/null | grep -v backups | head -5
echo "(empty = no concrete usage query/endpoint established)"
echo "== proof-06 verdict: NOT VERIFIABLE =="
echo "Blocker: the A2 cost document itself records total account usage as UNMEASURED (O-12/O-13, §8 item 3); AC2 test 12 is PARTIAL and AC2 is NOT PASSED. No usage-reporting endpoint or query is established in the Cloudflare connector docs or anywhere in the repo, so no account-wide usage figure can be read from this environment and no figure is produced. The design's fail-closed rule (§15.3) therefore applies: a sweep that cannot read the figure defers."
exit 2
