#!/usr/bin/env bash
# Phase 3 proof 07 — 5-second revocation propagation / 60-second acknowledgement
# window: is ANY measurement possible locally?
#
# What the two measurements need (design §B-3.2.4.2 / §B-3.2.8):
#  - Revocation: TWO API processes sharing ONE manager store, a revocation
#    record written to that store, and timed rejection of the old secret on
#    both processes (T31-08 is the designated proof).
#  - Acknowledgement window: a DEPLOYED executor (controlled-test: a real
#    Kaggle kernel push) with a recorded push timestamp and a first
#    status-query report of accepted/running (T31-05 / §B-3.2.8).
#
# This script checks for every precondition: a running API process, a
# manager store, a deployed executor, and a two-process deployment — on
# this machine and in the repo. Nothing here measures anything: it
# establishes whether measurement is possible at all.
#
# Run:  bash phase3-proofs/proof-07-timing-measurements.sh
# Exit 2 = NOT VERIFIABLE (no deployed executor / API process exists to
# measure against; the measurements need deployment + a live executor).

set -u
cd "$(dirname "$0")/.." || exit 2
echo "== proof-07: running API process (gpu-cloud/src/api-server.js)? =="
ps aux | grep -E "api-server|gpu-manager" | grep -v grep || echo "none running"
echo "== proof-07: listening sockets on this machine? =="
(ss -ltn 2>/dev/null | tail -n +2) || echo "ss unavailable or no listeners"
echo "== proof-07: deployed executor / manager store present? =="
ls gpu-cloud/systemd/ 2>/dev/null
echo "(only nova-storage-runner.service exists; no api-server service, no deployed manager store)"
echo "== proof-07: two-process deployment? =="
echo "No. Production Phase 3 has a SINGLE API process by design (§B-3.2.4.2); the two-process case exists only as the T31-08 test setup, which itself needs the deployed manager store."
echo "== proof-07 verdict: NOT VERIFIABLE =="
echo "Blocker: no deployed executor and no running API process exist in this environment — the API process, manager store and executor live on the GPU host / deployment that Phase 3 has not deployed (deployment unauthorised). A 5-second revocation propagation interval and a 60-second acknowledgement window cannot be measured against a local miniflare harness or a static file: both are timings of a live distributed system. No figures are fabricated. Designated proofs: T31-08 (revocation) and the real-executor timing evidence (§B-3.2.8), both requiring deployment + a live executor."
exit 2
