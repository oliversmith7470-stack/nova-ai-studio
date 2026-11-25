# NOVA Phase 3 acceptance tests (T31-01–T31-17 + supporting tests)

Tests for the Phase 3 Website Integration design (FINAL CONSOLIDATED
APPROVAL — "APPROVED — DESIGN ONLY", 25 Nov 2026). They run against the
real `_worker.js` in local miniflare with an **in-memory D1** — never
against production D1 (`nova-motion-jobs`), never with a paid GPU
dispatch, never deployed. Code + tests only.

## Run

```sh
# from the repo root
node phase3-tests/run.mjs            # full suite, summary table
node phase3-tests/run.mjs t31-06     # one test (substring match)
node phase3-tests/t31-06.mjs         # one test file directly
```

Exit code: 0 all PASS, 1 any FAIL, 2 no FAIL but some BLOCKED.

`node_modules` in this directory is a symlink to `../a2-impl/node_modules`
(miniflare + workerd live there; Node v24).

## Two layers, kept distinct in every test

- **W-layer** (Worker wiring): HTTP against the real `_worker.js` in
  local miniflare. Generation requests go through the controlled-test
  gate (`NOVA_API_MODE=controlled-test`, `X-NOVA-TEST-KEY`) to a
  **stub API process** (`stub-api.mjs`, a Node HTTP server on
  127.0.0.1) that verifies the Worker's HMAC signature, answers
  `POST /internal/submit` idempotently on the execution ID, keeps a
  real dispatch journal, and answers `GET /internal/status`. Fail
  modes: `none`, `http500`, `drop` (job created, response lost).
- **S-layer** (SQL semantics): the design's exact SQL executed directly
  against the same local D1 (miniflare D1 = SQLite) — actual
  D1-equivalent semantics, never mocked affected-row counts (the
  T31-01 condition). S-layer boots use a minimal probe worker so
  results do not depend on `_worker.js` being parseable.

## Verdict rules

`Recorder`: FAIL if any assertion fails; else BLOCKED if any assertion
could not run (the implementation it needs is not present / not
reachable); else PASS. A test that cannot run is marked BLOCKED with
the reason — never passed, never weakened, and the implementation is
never edited to make a test pass.

## Files

| File | What it tests |
| --- | --- |
| `harness.mjs` | Shared harness: boot (real worker / probe worker / stub API), schema seed, HTTP, canonical-request builders + fixed hash vectors, creation batch (Rev 3.4), repair, completeness (Rev 3.5), HMAC signing, Recorder, runMain |
| `stub-api.mjs` | Stub API process (see above) |
| `t31-01.mjs` | Concurrent duplicate creation + §B-3.2.1.3 disambiguation (a)–(f) |
| `t31-02.mjs` | Crash after D1 insert (intent-recorded → retry → submitted); lost submit response resolves via status lookup |
| `t31-03.mjs` | Crash after manager dispatch (journal repair BLOCKED; GpuManager idempotency M1–M5) |
| `t31-04.mjs` | Late ack (terminal-state guard S1/S2; W1/W2 BLOCKED) |
| `t31-05.mjs` | `getExecutionState` six states (all BLOCKED — no implementation) |
| `t31-06.mjs` | Retention ceiling, sub-cases A/B/C (Rev 3.3) |
| `t31-07.mjs` | Retention bytes formula (§B-3.2.6.2); sweep report/alert BLOCKED |
| `t31-08.mjs` | Revocation (all BLOCKED — no API process / revocation record) |
| `t31-09.mjs` | Interrupted storage deletion (all BLOCKED — no deletion-intent/sweeper) |
| `t31-10.mjs` | Reconciliation without restart (all BLOCKED — no timer) |
| `t31-11.mjs` | Duplicate JSON keys (400) |
| `t31-12.mjs` | Canonical hashes (fixed vectors V1–V4, NFC/NFD, whitespace, raw-lexeme rejections) |
| `t31-13.mjs` | Duplicate at ceiling with incomplete scene set |
| `t31-14.mjs` | Fresh creation with pre-seeded orphan scene row (full rollback) |
| `t31-15.mjs` | Duplicate with complete set (byte-identical, no re-submit) |
| `t31-16.mjs` | Operator repair (`repair-scene-row`, ceiling guard, idempotence; signed `/internal/d1-apply`) |
| `t31-17.mjs` | Attempt-1 row missing but a later retry row exists (per-index completeness) |
| `t31-csp.mjs` | CSP: no-store + nonce-matched report-only CSP, zero inline handlers/styles |
| `t31-rate-limit.mjs` | First-use race (10/hour/IP) + per-token active cap (3) |
| `t31-retry.mjs` | `POST /api/retry` contract + simultaneous-retry race |
| `t31-routes.mjs` | Route inventory (new routes, old motion routes, capacity shape) |
| `run.mjs` | Runner (this file's script) |

## Fixed canonical vectors (SHA-256 over UTF-8 canonical bytes)

- V1 single `{"mode":"single","prompt":"A dragon over a ridge at dawn","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}` → `3f652ebf…06937e`
- V2 plan (two scenes) → `188780ac…cd5846`
- V3 Unicode `Un dragón — café ☕` → `5746aef5…b5fe7b`
- V4 quotes/backslash/newline/U+0001 → `db382525…c3b68fb`
- NFC `café` → `ad9946ab…96c30`; NFD → `1114d32c…9feef1`

## Notes / known tensions (see the test report for detail)

- T31-01 literal pair [202, 200]: observed [202, 202] with every
  no-duplicate invariant holding — the concurrent duplicate reads
  `intent-recorded` and is re-submitted per Rev 3.2 §B-3.2.2.2. The
  literal wording and the recovery rule conflict; needs reviewer
  clarification.
- Retry 400-vs-409 boundary: 409 only when the active latest attempt
  IS a retry (attempt > 1); a queued original attempt (attempt 1) is
  400. The implementation documents this reading in `_worker.js`.
- CSP is report-only at this stage (Rev 2 §13.2); the enforcing
  header is a separate later step.
- `GET /api/export/jobs` is implemented (minimal version; the design names it in the route inventory but specifies no contract — see the test report). `POST /api/motion-generate` and `GET /api/motion-status` are retired (404 "Unknown API path"); the frontend now calls `/api/generate` and `/api/status`.
- The `assets` miniflare option cannot test the Worker's CSP
  injection (it serves files itself, bypassing the Worker); the
  harness instead binds `ASSETS` to a custom fetch service serving
  the current `index.html`.
- `probe/` holds diagnostic scratch probes from development, not
  part of the suite.
