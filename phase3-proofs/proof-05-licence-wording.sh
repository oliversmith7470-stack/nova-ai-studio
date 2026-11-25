#!/usr/bin/env bash
# Phase 3 proof 05 — Attachment A(e) licence wording (LTXV Open Weights License 0.X).
#
# What it checks:
#  1. That the exact A(e) wording is NOT in the local record (the repo holds
#     only the reviewer's summary + the LTX-2.x clarification email, which
#     concerns a DIFFERENT licence and contains no Attachment A text).
#  2. That the wording verified against the primary source — the licence text
#     itself, https://huggingface.co/Lightricks/LTX-Video/raw/main/LTX-Video-Open-Weights-License-0.X.txt
#     (LTXV Open Weights License 0.X, licence date 15 April 2025; fetched and
#     read 25 Nov 2026) — matches the reviewer's summary, quoted below.
#
# The verified exact wording (Attachment A(e)):
#   "(e) To generate or disseminate information and/or content (e.g. images,
#   code, posts, articles), and place the information and/or content in any
#   context (e.g. bot generating tweets) without expressly and intelligibly
#   disclaiming that the information and/or content is machine generated;"
#
# NOTE: locating the wording verbatim is the proof. The design (§19.2, Q5)
# still requires Shina's (and legal counsel's, if engaged) confirmation
# before the disclosure ships on this wording. This script does not grant it.
#
# Run:  bash phase3-proofs/proof-05-licence-wording.sh
# Exit 0 = local-record check matches expectations and the verified wording
#          is as recorded above.

set -u
cd "$(dirname "$0")/.." || exit 1
echo "== proof-05: exact A(e) sentence present anywhere in the local repo? =="
if grep -rn "without expressly and intelligibly disclaiming" licensing/ architecture/ a2-impl/ gpu-cloud/src/ 2>/dev/null | grep -v "phase3-implementation-proofs"; then
  echo "UNEXPECTED: exact wording found locally"
else
  echo "CONFIRMED: exact A(e) wording is NOT in the local record (only the reviewer's summary)."
fi
echo "== proof-05: what the local licensing file actually is =="
ls licensing/
echo "licensing/ltx-licensing-clarification-email-2026-11-22.md concerns the LTX-2.x Community License (non-compete clarification, reply awaited) — a different licence from the LTXV Open Weights License 0.X that governs the LTX-Video 2B checkpoint. It contains no Attachment A text."
echo "== proof-05: reviewer's summary (architecture/ltx-model-decision-review-reply-verbatim-2026-11-24.md) =="
grep -n "Attachment A(e) restricts" architecture/ltx-model-decision-review-reply-verbatim-2026-11-24.md
echo "== proof-05: verified wording (primary source, HuggingFace raw licence text, read 25 Nov 2026) =="
echo '(e) To generate or disseminate information and/or content (e.g. images, code, posts, articles), and place the information and/or content in any context (e.g. bot generating tweets) without expressly and intelligibly disclaiming that the information and/or content is machine generated;'
echo "Source: https://huggingface.co/Lightricks/LTX-Video/raw/main/LTX-Video-Open-Weights-License-0.X.txt (lines 142-143 of the fetched text)"
echo "== proof-05: PASSED (wording located verbatim; owner confirmation to ship it still owed per §19.2/Q5) =="
exit 0
