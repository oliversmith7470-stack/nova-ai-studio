# NOVA Gemini fix — 25 November 2026

**Order:** Shina, 25 Nov ~00:37 WAT — resolve the NOVA Gemini issue overnight.
NEXORA's Gemini works, so NOVA's must too: find what NEXORA does that NOVA
does not, and make the corrections.

**Outcome:** the fault was found, proven live, and fixed in the working tree.
The live site is still broken — it serves the old code — and stays broken
until Shina authorises a deployment in the morning.

## 1. What was wrong

NOVA's Writing Studio (`POST /api/gemini` on `nova-ai-studio-cp5.pages.dev`)
returned 502 for every generation. The 23–24 Nov investigation had already
shown Google returning 503 for `gemini-3.8-flash` and called it an outage.
Tonight's live tests prove it is not a passing outage and not a key problem:
**the model itself is unusable, and NOVA's handler has no timeout, so when
Google hangs the site hangs too.**

Live evidence, 25 Nov ~00:45–00:55 WAT (all direct calls to Google, using
the NEXORA key for the *shape* tests only — both keys are on the same
account/project, oliversmith7470 / 675422881296; the Pages secret was never
read or extracted):

| # | Request | Result |
|---|---------|--------|
| A | NEXORA shape on `gemini-3.5-flash` (control) | **HTTP 200 in 23.1 s**, finishReason STOP, text returned |
| B | NOVA shape on `gemini-3.8-flash` | **ReadTimeout after 60 s** — Google never answered |
| B2 | Same as B, repeat | **HTTP 503 in 5.9 s** — "This model is currently experiencing high demand" |
| C | NEXORA shape on `gemini-3.8-flash` | **HTTP 400** — "Thinking level MINIMAL is not supported for this model" |
| D | NOVA shape on `gemini-3.5-flash` | **HTTP 200 in 5.3 s**, STOP, text returned (459 thinking tokens) |
| E | Bare request on `gemini-3.8-flash` (no generationConfig) | **ReadTimeout after 60 s** |
| F | NEXORA shape on `gemini-3.5-flash` (second run) | **HTTP 200 in 18.2 s**, STOP, text returned |
| Live 1 | POST the live site's `/api/gemini` | **HTTP 502 in 6.6 s** (Google 503'd fast) |
| Live 2 | Same, repeat | **HTTP 000 — no response at all in 60 s** (the worker hung with Google) |

Conclusions from the tests:

1. **The model is the fault, not the request shape.** `gemini-3.8-flash`
   failed 3 of 3 in two different ways (503 overload, 60 s+ hang) — and
   failed even with no generation config at all (E). `gemini-3.5-flash`
   succeeded 3 of 3 across both shapes (A, D, F).
2. **NEXORA's shape does NOT transfer to 3.8-flash.** Test C proves it:
   `thinkingLevel: MINIMAL` is a 400 on 3.8-flash. Copying NEXORA's
   request body alone would have traded a 503 for a 400. The model and
   the shape must change together.
3. **The missing timeout is a live, user-facing defect.** The worker's
   `fetch` had no `AbortSignal`, so a hanging Google call hangs the
   worker indefinitely — Live 2 answered nothing for 60 s. Worse than
   the 502: the user gets no error at all.
4. **The key is not the cause.** Google answers with model-level errors
   (503, 400) and hangs — an invalid key fails fast with 400/401/403.
   The 23 Nov migration review had already verified the worker reaches
   Google and that the Netlify function with the known-good key returned
   the identical 502. The key rotation (new "NOVA API KEY" in the Pages
   secret, 24 Nov) is therefore not a fix for this issue — but the new
   key still only takes effect on the next deployment.
5. **The stale deployment is not the cause either** — it is a second,
   separate fact: the live site predates the key rotation, but the old
   keys are valid, so redeploying the *old* code would still fail. The
   code fix below is what makes the next deployment work.

## 2. NEXORA vs NOVA — the diff

| Field | NEXORA (works) — `nexora/ai/providers.py`, `GeminiProvider` | NOVA (broken) — `_worker.js`, `handleGemini` |
|---|---|---|
| Endpoint | `…/v1beta/models/{model}:generateContent` | Same v1beta path |
| Model | `gemini-3.5-flash` (`config/settings.py:35`) | `gemini-3.8-flash` (hardcoded) |
| Auth | `x-goog-api-key` header | Same |
| `generationConfig` | `{ maxOutputTokens: 1500, thinkingConfig: { thinkingLevel: "MINIMAL" } }` — no temperature | `{ temperature: 0.7, maxOutputTokens: 1200 }` — no thinking config |
| Timeout | 60 s (`httpx`, `timeout=60`) | **None** — unbounded `fetch` |
| Empty response | Distinguishes `finishReason`: `MAX_TOKENS` raised as its own error; no-candidates raised as safety-block | Generic 502, no finish-reason logging |
| Upstream non-OK | `AIProviderError` with the HTTP status | Generic 502 for every status |
| Token accounting | `usageMetadata` recorded in `ai_runs` | None (no audit table in the worker) |

What NEXORA does that NOVA did not: **a working model, a thinking-capped
request shape, a timeout, and finish-reason-aware error handling.** The
first two are the fix; the last two are the hardening the live evidence
demands.

## 3. Corrections made (working tree only)

### 3.1 `_worker.js` — `handleGemini` (the live path)

- Model: `gemini-3.8-flash` → **`gemini-3.5-flash`** (constant
  `GEMINI_MODEL`).
- Request shape: now exactly NEXORA's proven shape —
  `maxOutputTokens: 1500`, `thinkingConfig: { thinkingLevel: "MINIMAL" }`,
  temperature removed.
- Timeout: `signal: AbortSignal.timeout(28000)` on the Google fetch.
  28 s sits inside the ~30 s practical browser/proxy ceiling (the v6
  router draft's verified reasoning) and above Google's observed
  successful replies (5–23 s). A timeout or network failure now returns
  502 with "Gemini is temporarily unavailable. Please try again in a few
  minutes." instead of hanging or falling through to a 500.
- Upstream errors: 429 / 5xx now return the temporary-unavailable 502
  message (v6 router wording); other 4xx keep the generic 502 message.
  The log line now includes the upstream status.
- Empty responses: the `finishReason` is logged (NEXORA's distinction —
  `MAX_TOKENS` means the model spent its budget thinking); the
  user-facing message is unchanged.
- Unchanged: validation (400s), the missing-key 500, the closeout P5
  read-once body pattern, CORS, the `{ text }` success shape.

### 3.2 `netlify/functions/gemini.js` — same fix

Identical handler, identical bug (it returned the same 502 on 23 Nov).
Same model, shape, timeout, and error handling applied. As part of the
same edit it also adopts the read-once body pattern — the migration
review had flagged its `response.json()`-before-`ok`-check as a minor
concern (a non-JSON error body surfaced as 500 instead of 502).

### 3.3 `gemini-function/gemini.js` — kept in sync

This file was byte-identical to the Netlify function before the fix; the
fixed file was copied over it so the two do not drift. Verified
byte-identical after the copy.

### 3.4 `cloudflare-deploy/test_worker_closeout.mjs` — new P6 tests

Eight new checks plus two source guards, in the existing harness style
(stubbed fetch, no network):

| Check | Proves |
|---|---|
| P6.a | Request targets `gemini-3.5-flash:generateContent` |
| P6.b | Request shape is NEXORA's proven shape (1500 tokens, MINIMAL thinking, no temperature) |
| P6.c | The fetch carries a live `AbortSignal` |
| P6.d | OK + valid JSON → 200, body exactly `{ text }` |
| P6.e | Upstream 503 → 502 with the temporary-unavailable message |
| P6.f | Upstream 400 → 502 with the generic message (not temporary) |
| P6.g | Fetch abort (timeout) → 502 temporary, never a hang or 500 |
| P6.h | 200 with `MAX_TOKENS` and no text → 502 empty-response message |
| SRC.4 | No generateContent URL targets `gemini-3.8-flash` |
| SRC.5 | `AbortSignal.timeout` present on the Gemini fetch |

### Not changed (deliberately)

- The router drafts `gemini-function/gemini-router-draft-v*.js` (v1–v6)
  still reference `gemini-3.8-flash`. They are drafts, not live code;
  v6 remains parked. If v6 is ever revived it needs the same model
  change — noted here, not done, to keep this fix to live code.
- No retry/backoff: NEXORA has none, and the evidence does not call for
  one. A retry against an overloaded model would only add load.
- No OpenAI fallback: that needs an `OPENAI_API_KEY` Shina has not
  provided; out of scope.
- No frontend change: `index.html` only calls `/api/gemini` and carries
  no model reference.
- No key, secret, or Cloudflare configuration touched. No live database
  touched.

## 4. Test results

- **Closeout harness** (`cloudflare-deploy/test_worker_closeout.mjs`):
  **37/37 passed, exit 0** — the 27 pre-existing checks (P2–P5 + SRC.1–3)
  all still pass, plus the 10 new P6/SRC.4–5 checks. (One fix during the
  run: SRC.4 first failed on the literal model name in the fix comment
  itself; the guard was corrected to check the generateContent URL
  instead of the bare string.)
- **A2 suite** (`a2-impl`, `npm run test:all`): **exit 0 — every test
  file passed** (the `&&` chain completes only if all pass; tail of the
  run shows test20 104/104, test3 17/17, test5 28/28, test12 69/69,
  test15 19/19, s13-core 46/46, s13-admin 61/61). No regression from a
  change that does not touch the A2 worker.
- **Syntax**: `node --check` clean on `_worker.js` and
  `netlify/functions/gemini.js`.
- **Diff check**: `git diff --check` clean. Tracked diff is `_worker.js`
  (closeout P2–P5 + this fix) and `netlify/functions/gemini.js` (this
  fix only); the two pre-existing motion-file modifications are
  untouched. `gemini-function/` and `cloudflare-deploy/` are untracked
  directories, as before.
- **Live verification of the fix is NOT possible yet** — the live site
  still serves the old code. That is the deployment gate below.

## 5. What still needs Shina (morning)

1. **Deployment authorisation.** The fix is in the working tree only.
   The live site will keep returning 502 / hanging until a deployment
   ships the new `_worker.js`. Deployment is a separate authorisation —
   not given, not assumed.
2. **The two-success live gate.** After deployment, two successful live
   generations through the site's Writing Studio are needed before the
   fix is called proven (the standing retest rule). Note the new key
   ("NOVA API KEY") also only takes effect on that deployment.
3. **Optional, his call:** whether the parked v6 router draft should be
   updated to `gemini-3.5-flash` as well, or left parked.

## 6. Confirmation

- Nothing committed, nothing pushed, nothing deployed.
- No keys created, deleted, rotated, or read out — the NEXORA key was
  used only in-memory for the live shape tests and appears nowhere in
  this report, in any log, or in any file written tonight.
- No Cloudflare Pages configuration changed. No live database touched.
- Test scripts used for the live shape tests live in `/tmp` only
  (`/tmp/nova-gemini-shape-test.py`, `/tmp/nova-gemini-shape-test2.py`)
  and contain no credentials.

## 7. Deployment + two-success live gate — 25 November 2026, ~07:48 WAT

**Authorisation:** Shina, 25 Nov ~07:46 WAT ("Deploy Gemini fix").

**Deployment method:** `cloudflare-deploy/pages_deploy.py` (direct-upload
Pages API, the repo's established route), account
`9dc0c3393c8a97d62933e874f3778402`, project `nova-ai-studio`,
`index.html` + `--worker-file _worker.js` (Advanced Mode bundle).
Token verified active first (`/user/tokens/verify`, id `50ac988f…`,
status active). Netlify untouched entirely (credits exhausted until
22 Dec; B1-02 retires the Netlify Gemini route at the first Netlify
deploy on/after 22 Dec).

**Deployment result:** `d06565c1-e0eb-493c-9188-74226cadea93`,
environment `production`, created `2026-11-25T06:48:20Z`, stage
`deploy` success. URL:
`https://d06565c1.nova-ai-studio-cp5.pages.dev` (production alias
`nova-ai-studio-cp5.pages.dev`). Previous production deployment was
`0c569360` (23 Nov 22:49 UTC).

**Live verification of the deploy:** `GET /` returned HTTP 200,
387,701 bytes, sha256
`d1d9023feb2e32120cd61cf4e096193eea79578556489763cca927b120497e84`
— byte-identical to the local `index.html` (`cmp` silent).

**Two-success live gate — PASSED (2/2):**

| Gate | Prompt | Result |
|------|--------|--------|
| 1 | "Write one vivid sentence about a dragon circling a golden mountain at dawn." | **HTTP 200 in 1.67 s** — `{"text": "As the first violet blushes of dawn pierced the mist, a dragon of burnished copper spiraled silently around the peak, its massive, leathery wings catching the light until both beast and golden mountain burned like a single, radiant flame."}` |
| 2 | "Write one sentence describing a lighthouse keeper who hears a strange song from the sea at midnight." | **HTTP 200 in 1.17 s** — `{"text": "As the clock struck midnight, Arthur froze on the gallery deck of the light tower, the roaring gale swallowed by a haunting, ethereal melody drifting up from the black depths of the sea."}` |

Both through the live site's `POST /api/gemini` (Writing Studio
endpoint). The fix is now proven live: the new "NOVA API KEY" in the
Pages secret also takes effect on this deployment, since the deployed
worker reads `env.GEMINI_API_KEY`.

**Confirmation:** nothing committed, nothing pushed, no code changed
(HEAD still `2c97ca3`; the same four modified files as before the
deploy — `_worker.js`, `netlify/functions/gemini.js`, plus the two
pre-existing motion-file modifications — `git diff --check` clean).
No secrets touched. No Netlify deployment. No live database touched.
