# Known exceptions — NOVA GPU Cloud test suite

## 1. Workerd / Miniflare startup failure (api-server set: 60/61)

Status: KNOWN PRE-EXISTING EXCEPTION. Do not mark the test passing, do not
remove it from the suite, and do not change gateway or storage behaviour to
work around it. The failing test is listed here so the red mark is
explainable, not hidden.

### Failing test

- File: `src/api-server/test/api-worker.test.mjs:139`
- Test: `end-to-end: generate -> 202 -> accept -> fileReport -> succeeded -> download identical bytes`
- Set result (verified 27 Nov 2026, commit 5067f4f): 61 tests, 60 pass, 1 fail.
  Every other test in the set passes, including the full generate/accept/
  fileReport flow exercised without the Worker (e.g. `completion: fileReport
  validates, stores output, marks the scene succeeded`).

### Complete error

```
MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start.
There was likely a problem with the workerd binary or your configuration.
Runtime stderr:
workerd/jsg/util.c++:374: error: e = kj/filesystem.c++:319: failed: expected parts.size() > 0 [0 > 0]; can't use ".." to break out of starting directory
service core:user:: Uncaught Error: internal error; reference = fkrns4o66jf6od3qf7d6du6m
```

(The `reference = …` id varies per run; the error text is identical every
time. An earlier run on 27 Nov reported reference
`aikm30340j8qt08u388vr8jq` with the same message.)

The failure happens at Miniflare/workerd STARTUP, before any test assertion
runs: `Miniflare` construction / `#waitForReady` throws at
`api-worker.test.mjs:139` (`await mf.getD1Database` / dispatch path), so the
end-to-end test never executes a single HTTP call.

### Miniflare configuration in use (test-only)

`src/api-server/test/api-worker.test.mjs:122-138`:

```js
const mf = new Miniflare({
  root: ROOT, // repo root (path.resolve from src/api-server/test, ../../../..)
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: path.join(ROOT, '_worker.js'),
  d1Databases: { NOVA_DB: `nova-api-e2e-${Date.now()}` },
  d1Persist: false,
  compatibilityDate: '2025-01-01',
  bindings: { NOVA_API_SECRET, NOVA_API_MODE: 'controlled-test', NOVA_TEST_KEY,
              NOVA_IP_HASH_SALT, NOVA_API_ORIGIN },
});
```

`_worker.js` is a single-file module at the repo root with no `../` imports
(verified by grep). Which configured path workerd rejects as escaping the
starting directory has NOT been identified from the error text alone; that
diagnosis is still open. The reviewer's prescribed direction (ChatGPT, chat
6b095532, 27 Nov 2026): inspect the Miniflare/workerd configuration, replace
any parent-directory-relative path with an explicitly resolved path inside an
approved test root, and keep the working directory deterministic.

### Why it is pre-existing

- The identical failure (same test, same error, api-server set 60/61) was
  recorded at the Rev 4.9 verification on 26 Nov 2026 and at the Phase 6
  verification on 27 Nov 2026 — both BEFORE commit be69bc4 (FreeLLMAPI
  gateway-use). No gateway code is involved: the gateway flags are OFF, and
  the failure occurs at workerd startup before any gateway code executes.
- The failing test file is unchanged by be69bc4 and by the 5067f4f fixes.

### Is the same runtime configuration used in production? NO.

Production does NOT use Miniflare. The site is deployed to Cloudflare Pages
by direct upload (`cloudflare-deploy/pages_deploy_multi.py`, Cloudflare
Pages API) and runs on Cloudflare's real Workers runtime on the edge.
Miniflare exists only in this test file as a local emulator. This failure
therefore blocks a local end-to-end test only; it is not evidence of a
production runtime problem. The deployed Worker is verified separately by
live deployment health checks (see the release-gate report).

## 2. Staging-directory reuse invariant (10C follow-up)

Reviewer question (ChatGPT, chat 6b095532, 27 Nov 2026): after the runner
identifies a staging directory as stale, can an upload refresh or reuse that
directory before the runner deletes it? If yes, a fresh eligibility check
immediately before deletion is required; if no, document the invariant.

Answer, verified against the code on 27 Nov 2026 (commit 5067f4f): **reuse is
impossible by design. No code change was made; this note is the record.**

- Every `put()` mints a fresh staging id: `const uploadId = \`up_${randomUUID()}\``
  (`src/storage/engine.js:224`). The id is never supplied by a caller, never
  returned to any API client, and never persisted anywhere.
- The only writers to a staging directory live inside that same `put()` call:
  `writeStagingChunk(uploadId, …)` while streaming, then `finalizeStaging`
  (renames the chunks out and removes the staging directory) or
  `discardStaging` on any error path. After `put()` returns or throws, the
  staging directory no longer exists.
- No resume API exists. `writeStagingChunk` has exactly one caller
  (`put()`'s internal `flushChunk`); no code path anywhere re-opens, appends
  to, or refreshes an existing staging directory (verified by grep over
  `src/`).
- A directory can therefore only become stale if its `put()` crashed or was
  abandoned mid-stream (stale threshold `STAGING_MAX_AGE_MS` = 1 hour,
  `src/storage/engine.js:66`). A crashed put's upload id lived only in the
  dead call's memory and can never be presented again, so the directory
  cannot become active between the stale scan and the delete.
- Consequence: the second TOCTOU window the reviewer raised (stale selection
  → reactivation → delete of live data) is not exploitable. Fix B (per-entry
  ENOENT handling in `listStaleStaging`, commit 5067f4f) fully addresses the
  observed 10C failure. If a future change ever introduces resumable uploads
  or caller-supplied staging ids, this invariant MUST be re-verified first
  and a revalidation-before-delete check added at that time.
