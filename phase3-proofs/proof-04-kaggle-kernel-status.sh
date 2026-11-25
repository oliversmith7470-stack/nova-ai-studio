#!/usr/bin/env bash
# Phase 3 proof 04 — Kaggle kernel status query: existence + status vocabulary.
#
# What it attempts: run the design's specified status query
# (`kaggle kernels status <slug>`, §B-3.2.3.3) against a REAL historical
# kernel slug from the repo record
# (oliversmithh/nova-gpu-cloud-smoke-20261124-02, cited in
# architecture/smoke-blocker-review-reply-verbatim-2026-11-24.md:190)
# using the repo's Kaggle CLI (gpu-cloud/.venv-kaggle, kaggle-api 2.2.5).
# This is a READ-ONLY status poll: it creates no kernel, pushes nothing,
# spends no quota, and dispatches no job.
#
# Run:  bash phase3-proofs/proof-04-kaggle-kernel-status.sh
# Exit 0 = a status string was returned (vocabulary observed);
# exit 2 = NOT VERIFIABLE (exact blocker printed).

set -u
cd "$(dirname "$0")/.." || exit 2
KAGGLE="gpu-cloud/.venv-kaggle/bin/kaggle"
# Kernels confirmed to exist via `kaggle kernels list --mine` (25 Nov 2026):
#   oliversmithh/nova-gpu-cloud-smoke-20261124-01
#   oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01
#   oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01
# NOTE: the slug cited in architecture/smoke-blocker-review-reply-verbatim-2026-11-24.md:190
# (oliversmithh/nova-gpu-cloud-smoke-20261124-02) returns 401/403
# "Permission 'kernels.get' was denied" — it is not in the owner's kernel
# list. The default slug below is the -01 kernel from that same smoke run.
SLUGS="${*:-oliversmithh/nova-gpu-cloud-smoke-20261124-01 oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01 oliversmithh/nova-gpu-cloud-ltx-proof-20261124-01}"

echo "== proof-04: kaggle CLI version =="
"$KAGGLE" --version 2>&1
echo "== proof-04: status queries (read-only, no dispatch, no quota) =="
ok=0; fail=0
for s in $SLUGS; do
  echo "slug: $s"
  if timeout 120 "$KAGGLE" kernels status "$s" 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); fi
done
echo "== proof-04: $ok status(es) returned, $fail failed =="
echo "Vocabulary: the CLI prints KernelWorkerStatus.<MEMBER>; the enum (kagglesdk/kernels/types/kernels_enums.py) is QUEUED=0, RUNNING=1, COMPLETE=2, ERROR=3, CANCEL_REQUESTED=4, CANCEL_ACKNOWLEDGED=5, NEW_SCRIPT=6."
echo "Observed live 25 Nov 2026: KernelWorkerStatus.COMPLETE (smoke-01, ltx-proof) and KernelWorkerStatus.ERROR (fun-inp-proof). QUEUED/RUNNING/CANCEL_*/NEW_SCRIPT are enum members only — not observed live (no kernel is in those states)."
[ "$fail" -eq 0 ]
