# Retention scheduler — GitHub Actions route

**Date:** 25 November 2026
**Status:** Implemented in the working tree only — NOT committed, pushed, or deployed. No secret has been generated or stored anywhere.
**Decision:** GitHub Actions scheduler (owner's choice, 25 Nov ~22:48 WAT) over a separate Cloudflare Worker.

## Why this exists

Cloudflare Pages Functions do **not** support cron triggers. The
`scheduled()` handler in `_worker.js` (15-minute reconciliation + 24-hour
escalation) can never fire on a Pages deployment, and the account has no
Worker service to attach a trigger to (verified 25 Nov ~22:45: the Workers
API lists zero services; the old script name
`pages-worker--24812122-production` was an unverified record and the
dashboard returns "Failed to find Worker" for it). The correction is
recorded in `architecture/phase3-deployment-e2e-2026-11-25.md` §4.

## Mechanism

1. **Endpoint — `POST /internal/reconcile` in `_worker.js`.** It runs the
   SAME `handleScheduled()` reconciliation as `scheduled()` — retention
   measurement + alert, retention deletion of >30-day terminal job/scene
   rows (only while retention is enabled with a period set), completeness
   flagging, 24-hour escalation — and returns its summary as JSON
   (`ok`, `retainedRows`, `retainedBytes`, `retentionBacklogAlert`,
   `retentionDeletion` `{enabled, days, deletedJobs, deletedScenes}`,
   `jobsChecked`, `incompleteFlagged`, `escalated`, `errors`).
   `handleScheduled()` was refactored to return that summary; the logic
   itself is unchanged and is not duplicated anywhere.
2. **Trigger — `.github/workflows/retention-reconcile.yml`.** Runs every
   15 minutes (`*/15 * * * *`) plus a manual `workflow_dispatch` trigger
   for verification. Each run POSTs to
   `https://nova-ai-studio-cp5.pages.dev/internal/reconcile` with the
   secret in an `Authorization: Bearer` header, prints the endpoint's
   summary, and fails the run (exit 1) on any non-200 response.
3. **`scheduled()` is KEPT** as a thin wrapper over `handleScheduled()`.
   It never fires on Pages, but removing it would have forced rewriting
   the worker suite's retention coverage (which calls it directly) for
   zero behavioural gain, and it keeps the reconciliation callable if the
   site ever moves to Workers. Every step of `handleScheduled()` is
   idempotent (conditional deletes, set-once flags), so a duplicate run
   — a late GitHub run, a retried POST, or a future Worker cron trigger
   alongside this workflow — is safe. The code comment on the wrapper
   states plainly that it is not a live path on Pages.

## The secret

**Name: `CRON_SECRET`** — one shared secret, set in exactly two places
with the SAME value:

| Place | How it is set | Who sets it |
|---|---|---|
| GitHub repository Actions secret | Repo → Settings → Secrets and variables → Actions → New repository secret, name `CRON_SECRET` | The owner (only he can add repo secrets) |
| Cloudflare Pages production env var | Pages project `nova-ai-studio` → Settings → Environment variables → Production → `CRON_SECRET` (same value), then redeploy so the new binding takes effect | The owner in the dashboard, or Muse via the Pages API (the deploy token sets env vars) |

Generate it fresh (e.g. 32 random bytes, hex or base64). Never reuse
another secret (not `NOVA_API_SECRET`, not the Gemini key). Never put
the value in code, in the workflow file, in a doc, in chat, or in a URL
— header only. The workflow passes it as `${{ secrets.CRON_SECRET }}`;
GitHub masks it in logs. The endpoint never logs it and never echoes
it back.

## Why the endpoint is safe

- **Possession of the secret is the only authenticator**, compared in
  constant time (`secretsEqual`, no early exit on mismatch), against
  the `Authorization: Bearer <secret>` header only. A secret in a URL
  or body would leak into logs; headers do not.
- **Fail closed, three ways:** secret unset on the Pages side → `503
  cron_secret_unset` (the workflow fails loudly instead of silently
  doing nothing); wrong or missing secret → `401 unauthorised` with no
  further detail; no D1 binding → `500 service unavailable`. No path
  runs reconciliation without a correct secret.
- **No CORS exposure:** the endpoint sets no CORS headers at all
  (`Access-Control-Allow-Origin` is never emitted), so no browser can
  read its responses cross-origin. GitHub Actions uses curl, which
  needs no CORS.
- **No arbitrary input:** the request body is ignored entirely. The
  only thing the caller controls is whether the fixed, parameterised
  reconciliation SQL runs — the same SQL `scheduled()` has always run.
  There is no user data, no ID, no parameter to inject through.
- **Bounded work:** each run is bounded by the reconciliation itself
  (200 non-terminal jobs per pass, conditional deletes only). The
  cadence is fixed at 96 runs/day; no rate limit is needed or applied.
- **Not on the public surface:** the route is `/internal/*` (not
  `/api/*`), it is not listed in the site's public docs or the About
  page, and the worker's CORS allow-list does not apply to it.

## Failure modes

- **GitHub runs late.** Scheduled runs can start minutes late under
  load. Harmless: reconciliation is a sweep, not a deadline — a late
  run still prunes everything eligible, and the next run catches the
  rest.
- **GitHub disables the workflow.** GitHub automatically disables
  scheduled workflows in a repository with no activity for 60 days.
  Symptom: runs simply stop appearing. Fix: push any commit to the
  repo, or re-enable the workflow in Actions. The operator check below
  catches this (no runs in the last hour = investigate).
- **Endpoint down / 5xx.** The workflow step exits 1 and the run is
  marked failed. Retention rows accumulate until the next successful
  run; the 100,000-row ceiling and the backlog alert (10,000 rows /
  10 MB) still guard generation. Nothing is deleted by a failed run.
- **Secret mismatch (401) or secret unset (503).** The run fails with
  that status in the log. 401 = the GitHub secret does not match the
  Pages variable (rotate one side to match). 503 `cron_secret_unset` =
  the Pages variable was never set, or the deploy predates it (env vars
  bind at deploy time — set the var, then redeploy).
- **Partial failure inside a run.** `handleScheduled()` logs per-step
  failures and counts them in `summary.errors`; the run still returns
  200 with the counts it did complete. Check `errors` in the run log:
  a run with `errors > 0` deserves a look at the Worker logs, but the
  rows it did delete stay deleted (each step commits independently).
- **Duplicate runs.** Safe by construction (see the `scheduled()`
  paragraph above): a second run in the same window deletes nothing
  further.

## Operator verification after deploy

1. Set `CRON_SECRET` in both places (same value), then redeploy the
   Pages project so the new env var binds.
2. In GitHub → Actions → "Retention reconcile" → **Run workflow**
   (the `workflow_dispatch` trigger). The run must go green and print
   a 200 summary, e.g. `{"ok":true,"retainedRows":…,"retentionDeletion":
   {"enabled":true,"days":30,"deletedJobs":0,"deletedScenes":0},…}`.
   A 401 means the two secrets differ; a 503 `cron_secret_unset`
   means the Pages var is missing or the deploy predates it.
3. Wait one scheduled tick (≤15 min) and confirm a scheduled run
   appears in the Actions history and goes green.
4. Spot-check D1: `retainedRows` in the summaries should stay well
   under the 10,000-row alert threshold; `deletedJobs` should rise
   only when >30-day terminal jobs exist.
5. Ongoing: if no successful run appears for over an hour, check the
   Actions history first (workflow disabled? secret rotated?), then
   the Worker logs.

## What remains (each on the owner's word)

Commit → push → deploy (so the endpoint exists live) → set
`CRON_SECRET` in both places (owner's hand for the GitHub secret) →
redeploy after the Pages var is set → manual `workflow_dispatch` run
→ confirm the scheduled cadence. Stage 7 stays blocked on its own
track; this change does not touch it.
