/*
 * NOVA AI STUDIO — Cloudflare Pages Worker (Advanced Mode)
 * Migration milestone, 23 Nov 2026: Netlify Functions -> Cloudflare Pages.
 * Authorized by Shina ("Do the migration now on my word").
 *
 * Single-file module Worker. It routes /api/* to the three NOVA handlers
 * and falls through to the static assets (env.ASSETS) for everything else.
 *
 * Contract preserved exactly from the Netlify functions:
 * - Same validation, same status codes, same response messages, including
 *   the verbatim 503 ("NOVA received and saved your production job, but
 *   the Wan 2.2 provider is not configured yet. No video has been
 *   generated.").
 * - Same token scheme: browser-supplied 64-hex token in
 *   X-NOVA-JOB-TOKEN, never rotated, only the SHA-256 hash stored.
 * - Same plan rules: 1-20 scenes, each with a generation prompt;
 *   image <= 7 MB, png/jpeg/webp data URL.
 * - Same job store interface: getJob / createJob / updateJob.
 *
 * Runtime swaps (the only logic changes):
 * - node:crypto SHA-256 -> Web Crypto crypto.subtle.digest (async).
 * - Buffer hex handling -> Uint8Array via hexToBytes.
 * - crypto.timingSafeEqual -> hand-written constant-time compare.
 * - Netlify Blobs store -> Cloudflare D1 (binding NOVA_DB, table jobs).
 * - process.env.GEMINI_API_KEY -> env.GEMINI_API_KEY (Pages secret).
 * - CORS: single Netlify origin -> allow-list (Netlify + Pages origins).
 *
 * Bindings required on the Pages project:
 * - NOVA_DB: D1 database with table jobs (id TEXT PRIMARY KEY, data TEXT).
 * - GEMINI_API_KEY: secret, re-entered (cannot be read out of Netlify).
 * - ASSETS: automatic in Advanced Mode (static files).
 *
 * Closeout Rev 3 (24 Nov 2026, approved plan; implementation
 * authorized, no commit/push/deploy): P2 unknown-API 404 +
 * Vary: Origin; P3 1 MB record-size guard (-> 413); P4 atomic
 * INSERT OR IGNORE job creation; P5 read-once Gemini body
 * parsing. P1 (Gemini access) remains gated on the user's
 * billing/quota verification and security decision.
 *
 * Phase 3 retirement (25 Nov 2026, Rev 2 §4.1): the motion routes
 * above (/api/motion-generate, /api/motion-status) and the verbatim
 * Wan 503 are RETIRED — the "Contract preserved exactly" paragraph
 * no longer holds for them. The frontend now uses POST /api/generate
 * + GET /api/status, whose contract is defined by the Phase 3 design
 * (see the PHASE 3 header below). /api/gemini is untouched.
 */

// ---------------------------------------------------------------- CORS

const ALLOWED_ORIGINS = [
  "https://nova-ai-studio-5r8o.netlify.app",
  "https://nova-ai-studio-cp5.pages.dev"
];

function corsHeaders(request, allowHeaders, allowMethods) {
  const headers = {
    "Content-Type": "application/json",
    "Vary": "Origin",
    // Phase 3, Rev 2 §12.1: security headers on all API responses.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Allow-Methods": allowMethods
  };
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// -------------------------------------------------------------- Crypto

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Constant-time byte comparison (Workers has no timingSafeEqual).
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function tokenMatches(token, storedHash) {
  if (
    typeof token !== "string" ||
    typeof storedHash !== "string"
  ) {
    return false;
  }
  const suppliedHash = hexToBytes(await sha256Hex(token));
  const expectedHash = hexToBytes(storedHash);
  return timingSafeEqual(suppliedHash, expectedHash);
}

// --------------------------------------------------------- Job store
// D1 adapter. Same interface as the Netlify Blobs adapter
// (netlify/functions/lib/nova-job-store.js): validJobId, getJob,
// createJob (create-if-absent), updateJob (read-modify-write,
// stamps updatedAt). D1 is strongly consistent, so the 7-9 s
// Blobs read-after-write lag class does not apply here.

const JOB_ID_RE = /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validJobId(id) {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

// Closeout P3: D1's row limit is 2,000,000 bytes. Guard at 1 MB —
// far above real records (~700 bytes) with headroom for the id
// and JSON overhead — so an oversized record is rejected with a
// clear 413 before INSERT/UPDATE, never a 500 from D1.
const MAX_JOB_RECORD_BYTES = 1000000;

function checkRecordSize(job) {
  const bytes = new TextEncoder().encode(JSON.stringify(job)).length;
  if (bytes > MAX_JOB_RECORD_BYTES) {
    const error = new Error(
      "The production record exceeds the allowed size."
    );
    error.code = "RECORD_TOO_LARGE";
    throw error;
  }
}

function createJobStore(db) {
  async function getJob(jobId) {
    if (!validJobId(jobId)) {
      return null;
    }
    const row = await db
      .prepare("SELECT data FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    if (!row) {
      return null;
    }
    return JSON.parse(row.data);
  }

  async function createJob(job) {
    if (!job || !validJobId(job.id)) {
      throw new Error("Invalid NOVA job record.");
    }

    // Closeout P3: reject oversized records before any write.
    checkRecordSize(job);

    // Closeout P4: atomic create-if-absent. A single INSERT OR IGNORE
    // plus a re-read replaces the old check-then-act, so concurrent
    // duplicate creates cannot 500 on the primary-key constraint.
    // meta.changes: 1 = inserted, 0 = ignored (row already existed).
    // If meta is unavailable, `created` is null — informational only;
    // the handler reads result.job + the token check, never `created`.
    const result = await db
      .prepare("INSERT OR IGNORE INTO jobs (id, data) VALUES (?, ?)")
      .bind(job.id, JSON.stringify(job))
      .run();

    const changes =
      result && result.meta && typeof result.meta.changes === "number"
        ? result.meta.changes
        : null;

    const stored = await getJob(job.id);
    if (!stored) {
      throw new Error("NOVA could not save the production job.");
    }

    return {
      created: changes === null ? null : changes === 1,
      job: stored
    };
  }

  async function updateJob(jobId, updater) {
    if (!validJobId(jobId) || typeof updater !== "function") {
      throw new Error("Invalid job update request.");
    }

    const current = await getJob(jobId);
    if (!current) {
      return null;
    }

    const updated = updater(current);
    if (!updated || updated.id !== jobId) {
      throw new Error("The updated job record is invalid.");
    }

    updated.updatedAt = new Date().toISOString();

    // Closeout P3: the guard lives in the store layer, so it
    // protects every writer, present and future.
    checkRecordSize(updated);

    await db
      .prepare("UPDATE jobs SET data = ? WHERE id = ?")
      .bind(JSON.stringify(updated), jobId)
      .run();

    return updated;
  }

  return { validJobId, getJob, createJob, updateJob };
}

// -------------------------------------------------------------- Gemini
// From netlify/functions/gemini.js (v1 handler -> fetch handler).
// Logic, validation, model, status codes and messages unchanged.

async function handleGemini(request, env) {
  const headers = corsHeaders(request, "Content-Type", "POST, OPTIONS");

  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });

  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  if (request.method !== "POST") {
    return respond(405, { error: "Only POST requests are allowed." });
  }

  try {
    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {
      return respond(500, { error: "AI service is not configured." });
    }

    const text = await request.text();
    const body = JSON.parse(text || "{}");
    const prompt = typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";

    if (!prompt) {
      return respond(400, { error: "Please enter a writing prompt." });
    }

    if (prompt.length > 4000) {
      return respond(400, {
        error: "Your prompt is too long. Maximum is 4,000 characters."
      });
    }

    // Gemini fix (25 Nov 2026 — see gpu-cloud/docs/nova-gemini-fix-2026-11-25.md).
    // gemini-3.8-flash is unusable: Google returned 503 "high demand"
    // or hung past 60 s on 3 of 3 live attempts. gemini-3.5-flash with
    // NEXORA's exact request shape succeeded 3 of 3 live. NEXORA's
    // thinkingConfig does NOT transfer to 3.8-flash (400
    // INVALID_ARGUMENT: MINIMAL unsupported there), so the model and
    // the shape change together — never one without the other.
    const GEMINI_MODEL = "gemini-3.5-flash";
    // 28 s deadline: Google's successful replies took 5–23 s live;
    // 28 s sits inside the ~30 s practical browser/proxy ceiling (the
    // v6 router draft's verified reasoning). Without a timeout the
    // worker hangs as long as Google does — the live site was observed
    // answering nothing at all for 60 s+ on 25 Nov.
    const GEMINI_TIMEOUT_MS = 28000;

    let response;
    let responseText;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }],
            generationConfig: {
              maxOutputTokens: 1500,
              thinkingConfig: {
                thinkingLevel: "MINIMAL"
              }
            }
          }),
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
        }
      );

      // Closeout P5: read the body ONCE as text, then parse the saved
      // text. response.json() consumes the body, so a json()-then-
      // text() fallback is unsafe — a failed parse could leave
      // response.text() failing too.
      responseText = await response.text();
    } catch (fetchError) {
      // Timeout (abort) or network failure — temporary by nature.
      console.error("Gemini request failed:", fetchError.name, fetchError.message);
      return respond(502, {
        error: "Gemini is temporarily unavailable. Please try again in a few minutes."
      });
    }

    if (!response.ok) {
      console.error("Gemini API error:", response.status, responseText.slice(0, 500));
      // 429 / 5xx are temporary (overload, rate limit) — say so
      // instead of the generic failure message (v6 router wording).
      if (response.status === 429 || response.status >= 500) {
        return respond(502, {
          error: "Gemini is temporarily unavailable. Please try again in a few minutes."
        });
      }
      return respond(502, {
        error: "The AI service could not complete your request. Please try again."
      });
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      console.error("Gemini API returned invalid JSON.");
      return respond(502, {
        error: "The AI service could not complete your request. Please try again."
      });
    }

    const candidate = result.candidates?.[0];
    const generatedText = candidate?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!generatedText) {
      // Log the finish reason (NEXORA's distinction): MAX_TOKENS means
      // the model spent its budget thinking instead of answering.
      console.error(
        "Gemini API returned an empty response. Finish reason:",
        candidate?.finishReason ?? "unknown"
      );
      return respond(502, {
        error: "The AI returned an empty response. Please try again."
      });
    }

    return respond(200, { text: generatedText });

  } catch (error) {
    console.error("Function error:", error);

    return respond(500, {
      error: "Something went wrong. Please try again."
    });
  }
}

// ------------------------------------------- Retired routes (25 Nov 2026)
// Rev 2 §4.1: /api/motion-generate and /api/motion-status are RETIRED.
// The frontend was retargeted in the same change (assets/js/main.js now
// posts to POST /api/generate and polls GET /api/status), so no live
// caller remains. Both paths now fall through to the "Unknown API path"
// 404 below. The old handlers (handleMotionGenerate, handleMotionStatus),
// their validation helpers (validPlan, validateImage, buildScenes) and
// the verbatim Wan 503 message (UNAVAILABLE_MESSAGE) were removed with
// them — the message is retired, not relocated: the Phase 3
// /api/generate path returns the honest capacity 503 (Rev 2 §4.2/§6.4)
// and never carries Wan wording (T31-ROUTES V10). The shared job-store
// layer (createJobStore / checkRecordSize) is retained: its record-size
// guard still protects the Phase 3 creation path (handleGenerate) and
// is still pinned by the closeout P3.5 source guard. /api/gemini is
// untouched.


// ====================================================== PHASE 3 (25 Nov 2026)
// Website Integration, Rev 2 as corrected by Rev 3–3.5 (FINAL CONSOLIDATED
// APPROVAL — "APPROVED — DESIGN ONLY"; implementation authorised by Shina
// 25 Nov 2026 17:14 WAT, code + tests only — no commit, push, deploy, live
// database writes, paid GPU dispatch, or production activation).
//
// SCOPE of this block: Worker/API + D1 core only.
// - POST /api/generate, GET /api/status, GET /api/download, GET /api/capacity,
//   GET /api/export/jobs, POST /api/retry, POST /internal/d1-apply,
//   GET /internal/d1-read, POST /internal/reconcile (GitHub Actions
//   scheduler route, 25 Nov 2026 — the live 15-minute trigger),
//   scheduled() (same reconciliation + 24h escalation, D1 side — kept as
//   a thin wrapper; NEVER fires on Pages, which has no cron triggers).
// - Worker-sole-D1-access (Rev 3 §C-1.1); canonical-request-v1 (Rev 3.1
//   §A-3.1.1 + Rev 3.2 §B-3.2.10); atomic rate limits (Rev 3 §C-1.6);
//   creation batch 2+N with footprint rule + creationToken (Rev 3.3 §C-3.3.1,
//   Rev 3.4 §C-3.4.1); per-index attempt-1 completeness (Rev 3.5 §C-3.5.1);
//   controlled-test mode only (Rev 3 §C-1.4); retention ENABLED, 30 days
//   (owner decision 25 Nov ~18:21 WAT, Q3 APPROVED — supersedes the
//   Rev 3.1 §A-3.1.3 disabled state: job_record_retention_enabled = true,
//   job_record_retention_days = 30).
// - The API process (gpu-cloud/src/api-server.js), the LTX executor, the
//   frontend, CSP remediation, and the About page are other workstreams'
//   files and are NOT touched here. The Worker calls the API process over
//   signed HTTPS (§3.4/§11); when no API origin is configured there is no
//   production capacity and generation returns the honest 503 (§6.4).
// - The old /api/motion-generate + /api/motion-status routes were RETIRED
//   25 Nov 2026 per Rev 2 §4.1, in the same change that retargeted the
//   frontend to /api/generate + /api/status (assets/js/main.js). The
//   verbatim Wan 503 message was retired with them. /api/gemini is untouched.
//
// Environment (deployment configuration, never hardcoded):
// - NOVA_API_ORIGIN: API-process origin; a resolvable HOSTNAME is mandatory
//   (Rev 3 §C-1.7 — a literal IP is rejected, the API is treated as
//   unconfigured). NOVA_API_SECRET: shared HMAC secret (current).
//   NOVA_API_SECRET_PREVIOUS: previous secret during rotation overlap.
// - NOVA_API_MODE: "controlled-test" | "production" (default production).
//   NOVA_TEST_KEY: preview-only test credential (controlled-test mode only).
// - NOVA_IP_HASH_SALT: salt for keyed-hash IP storage (§14.3).
// - NOVA_JOB_RECORD_RETENTION_ENABLED ("true"/"false", default "false"),
//   NOVA_JOB_RECORD_RETENTION_DAYS (owner-confirmed "30" since 25 Nov ~18:21 WAT).

const PHASE3_MAX_BODY_BYTES = 16384; // Rev 2 §5.1: 16 KB -> 413
const PHASE3_GEN_LIMIT_PER_HOUR = 10; // Rev 2 §14.1 (provisional)
const PHASE3_POLL_LIMIT_PER_MIN = 60; // Rev 2 §14.1 (provisional)
const PHASE3_ACTIVE_JOB_CAP = 3; // Rev 2 §14.1 / Rev 3 §C-1.6
const PHASE3_RETENTION_CEILING_ROWS = 100000; // Rev 3.1 §A-3.1.4.2
const PHASE3_RETENTION_ALERT_ROWS = 10000; // Rev 3.1 §A-3.1.4.2
const PHASE3_RETENTION_ALERT_BYTES = 10 * 1024 * 1024;
const PHASE3_JOB_TIMEOUT_MS = 30 * 60 * 1000; // Rev 2 §6.3 video default
const PHASE3_ACK_WINDOW_MS = 60 * 1000; // Rev 3.1 §A-3.1.2.2 (API side)
const PHASE3_SUBMIT_TIMEOUT_MS = 10000; // Rev 2 §3.5
const PHASE3_STATUS_TIMEOUT_MS = 5000; // Rev 2 §3.5
const PHASE3_DOWNLOAD_IDLE_TIMEOUT_MS = 30000; // Rev 2 §3.5

const CANONICAL_REQUEST_VERSION = "canonical-request-v1";

function phase3ApiMode(env) {
  return env.NOVA_API_MODE === "controlled-test"
    ? "controlled-test"
    : "production";
}

function phase3RetentionEnabled(env) {
  return env.NOVA_JOB_RECORD_RETENTION_ENABLED === "true";
}

function phase3RetentionDays(env) {
  const n = Number(env.NOVA_JOB_RECORD_RETENTION_DAYS);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ------------------------------------------------- Strict JSON parsing
// Rev 3.2 §B-3.2.10: duplicate keys rejected at any depth before validation
// and hashing; strict integer lexemes; lone surrogates rejected; non-UTF-8
// rejected (fatal TextDecoder, applied by the caller before this parse).
// A hand parser is used because JSON.parse silently keeps the last value
// for a duplicated key. Returns { value, lexemes: Map<path, raw lexeme> }.
// Throws an Error with code "BAD_JSON" on any malformed input.

function parseStrictJson(text) {
  let i = 0;
  const n = text.length;
  const lexemes = new Map();

  function err(message) {
    const e = new Error(message);
    e.code = "BAD_JSON";
    throw e;
  }
  function skipWs() {
    while (
      i < n &&
      (text[i] === " " || text[i] === "\t" ||
        text[i] === "\n" || text[i] === "\r")
    ) {
      i++;
    }
  }
  function checkStringSurrogates(s, path) {
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = k + 1 < s.length ? s.charCodeAt(k + 1) : 0;
        if (!(d >= 0xdc00 && d <= 0xdfff)) {
          err("lone surrogate in string at " + path);
        }
        k++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        err("lone surrogate in string at " + path);
      }
    }
  }
  function parseString(path) {
    // text[i] === '"'
    i++;
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        checkStringSurrogates(out, path);
        return out;
      }
      if (c === "\\") {
        i++;
        if (i >= n) err("unterminated escape in string");
        const e = text[i];
        if (e === '"' || e === "\\" || e === "/") {
          out += e;
          i++;
        } else if (e === "b") {
          out += "\b";
          i++;
        } else if (e === "f") {
          out += "\f";
          i++;
        } else if (e === "n") {
          out += "\n";
          i++;
        } else if (e === "r") {
          out += "\r";
          i++;
        } else if (e === "t") {
          out += "\t";
          i++;
        } else if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            err("bad unicode escape in string");
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          err("bad escape in string");
        }
      } else {
        if (text.charCodeAt(i) < 0x20) {
          err("unescaped control character in string");
        }
        out += c;
        i++;
      }
    }
    err("unterminated string");
  }
  function parseNumber(path) {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") {
      i++;
    } else if (text[i] >= "1" && text[i] <= "9") {
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    } else {
      err("bad number at " + path);
    }
    if (text[i] === ".") {
      i++;
      if (!(text[i] >= "0" && text[i] <= "9")) err("bad number at " + path);
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!(text[i] >= "0" && text[i] <= "9")) err("bad number at " + path);
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    const lex = text.slice(start, i);
    lexemes.set(path, lex);
    return Number(lex);
  }
  function parseValue(path, depth) {
    if (depth > 100) err("nesting too deep");
    skipWs();
    if (i >= n) err("unexpected end of input");
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      const seen = new Set();
      skipWs();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      while (true) {
        skipWs();
        if (text[i] !== '"') err("expected object key at " + path);
        const key = parseString(path);
        if (seen.has(key)) err("duplicate key: " + key);
        seen.add(key);
        skipWs();
        if (text[i] !== ":") err("expected ':' at " + path);
        i++;
        obj[key] = parseValue(path ? path + "." + key : key, depth + 1);
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        err("expected ',' or '}' at " + path);
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      skipWs();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      let idx = 0;
      while (true) {
        arr.push(parseValue(path + "[" + idx + "]", depth + 1));
        idx++;
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        err("expected ',' or ']' at " + path);
      }
    }
    if (c === '"') return parseString(path);
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber(path);
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    err("unexpected token at " + path);
  }

  const value = parseValue("", 0);
  skipWs();
  if (i !== n) err("trailing content after JSON value");
  return { value, lexemes };
}

// Strict integer validation against the RAW JSON number lexeme
// (Rev 3.2 §B-3.2.10.3): 24.0, 2.4e1, and booleans are all rejected even
// though they denote integers. `value` must be a JS number and integer,
// and its lexeme must match plain decimal integers only.
function isStrictInteger(parsed, path, value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  const lex = parsed.lexemes.get(path);
  return typeof lex === "string" && /^-?(0|[1-9][0-9]*)$/.test(lex);
}

// ------------------------------------------- Canonical request identity
// Rev 3.1 §A-3.1.1.2 + Rev 3.2 §B-3.2.10.2: canonical-request-v1.
// JSON, UTF-8, compact separators, keys in the FIXED order below (not
// alphabetical). jobId and the job token are NOT part of the canonical
// form. Reference implementation of the bytes: JSON.stringify applied to
// the value built in fixed field order (non-ASCII emitted raw UTF-8,
// exact JSON.stringify escaping, no normalisation, whitespace verbatim).

const GENERATE_ALLOWED_SINGLE = new Set([
  "jobId", "mode", "prompt", "model", "frames", "resolution", "fps"
]);
const GENERATE_ALLOWED_PLAN = new Set([
  "jobId", "mode", "scenes", "model", "frames", "resolution", "fps"
]);

function buildCanonicalRequest(normalized) {
  let obj;
  if (normalized.mode === "single") {
    obj = {
      mode: "single",
      prompt: normalized.prompt,
      model: "ltx-video-2b",
      frames: 121,
      resolution: "1024x576",
      fps: 24
    };
  } else {
    obj = {
      mode: "plan",
      scenes: normalized.scenes.map((s) => ({
        index: s.index,
        prompt: s.prompt
      })),
      model: "ltx-video-2b",
      frames: 121,
      resolution: "1024x576",
      fps: 24
    };
  }
  return JSON.stringify(obj);
}

// Validates a parsed POST /api/generate body. Returns { ok: true,
// normalized, canonical } or { ok: false, status, message }.
// `normalized` = { jobId, mode, prompt?, scenes: [{ index, prompt }] }.
function validateGenerateBody(parsed) {
  const body = parsed.value;
  const bad = (message) => ({ ok: false, status: 400, message });

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("Invalid production request.");
  }
  if (!validJobId(body.jobId)) {
    return bad("A valid NOVA job ID is required.");
  }
  if (body.mode !== "single" && body.mode !== "plan") {
    return bad("A valid generation mode is required.");
  }
  const allowed =
    body.mode === "single" ? GENERATE_ALLOWED_SINGLE : GENERATE_ALLOWED_PLAN;
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return bad("Unexpected field: " + key + ".");
    }
  }
  // Every canonical field is required; missing and null both fail here.
  const required =
    body.mode === "single"
      ? ["prompt", "model", "frames", "resolution", "fps"]
      : ["scenes", "model", "frames", "resolution", "fps"];
  for (const field of required) {
    if (!(field in body) || body[field] === null || body[field] === undefined) {
      return bad("Missing required field: " + field + ".");
    }
  }
  if (body.model !== "ltx-video-2b") {
    return bad("Only LTX-Video 2B is available.");
  }
  if (!isStrictInteger(parsed, "frames", body.frames) || body.frames !== 121) {
    return bad("frames must be 121.");
  }
  if (body.resolution !== "1024x576") {
    return bad("resolution must be 1024x576.");
  }
  if (!isStrictInteger(parsed, "fps", body.fps) || body.fps !== 24) {
    return bad("fps must be 24.");
  }

  const checkPrompt = (prompt, label) => {
    if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > 2000) {
      return label + " must be between 1 and 2,000 characters.";
    }
    if (prompt.trim().length === 0) {
      return label + " must not be blank.";
    }
    return null;
  };

  if (body.mode === "single") {
    const promptError = checkPrompt(body.prompt, "prompt");
    if (promptError) return bad(promptError);
    return {
      ok: true,
      normalized: {
        jobId: body.jobId,
        mode: "single",
        prompt: body.prompt,
        scenes: [{ index: 0, prompt: body.prompt }]
      }
    };
  }

  if (!Array.isArray(body.scenes) || body.scenes.length < 1 ||
      body.scenes.length > 20) {
    return bad("The production plan must contain between 1 and 20 scenes.");
  }
  const scenes = [];
  let prevIndex = -1;
  for (let s = 0; s < body.scenes.length; s++) {
    const scene = body.scenes[s];
    const path = "scenes[" + s + "]";
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return bad("Scene " + (s + 1) + " is invalid.");
    }
    for (const key of Object.keys(scene)) {
      if (key !== "index" && key !== "prompt") {
        return bad("Unexpected field in scene " + (s + 1) + ": " + key + ".");
      }
    }
    if (!("index" in scene) || !("prompt" in scene) ||
        scene.index === null || scene.prompt === null) {
      return bad("Scene " + (s + 1) + " requires index and prompt.");
    }
    if (!isStrictInteger(parsed, path + ".index", scene.index) ||
        scene.index < 0 || scene.index > 19) {
      return bad("Scene " + (s + 1) + " has an invalid index.");
    }
    if (scene.index <= prevIndex) {
      return bad("Scene indexes must be unique and in ascending order.");
    }
    prevIndex = scene.index;
    const promptError = checkPrompt(
      scene.prompt, "Scene " + scene.index + " prompt");
    if (promptError) return bad(promptError);
    scenes.push({ index: scene.index, prompt: scene.prompt });
  }
  return {
    ok: true,
    normalized: { jobId: body.jobId, mode: "plan", scenes }
  };
}

// ------------------------------------------------------- HMAC (Rev 2 §11)
// Canonical request: METHOD + "\n" + PATH (incl. query) + "\n" + TIMESTAMP
// (unix seconds) + "\n" + NONCE (128-bit hex) + "\n" + SHA256_HEX(BODY).
// HMAC-SHA-256 with the shared secret. Verification order (Rev 3 §C-1.10):
// (1) secret present, (2) signature present and well-formed, (3) timestamp
// within ±60 s, (4) signature verifies (constant-time), (5) nonce unseen —
// recorded as used ONLY after step 4 passes, so a failed request can never
// burn a nonce, (6) body parses and validates. Any failure -> 401 with
// { error: "unauthorised" } and no further detail.

async function hmacSha256Hex(keyText, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Worker as signer (Worker -> API process). Returns the headers to send.
async function signApiCall(secret, method, path, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = [...nonceBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const bodyHash = await sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join("\n");
  const signature = await hmacSha256Hex(secret, canonical);
  return {
    "X-NOVA-API-SECRET": secret,
    "X-NOVA-SIGNATURE": signature,
    "X-NOVA-TIMESTAMP": timestamp,
    "X-NOVA-NONCE": nonce,
    "Content-Type": "application/json"
  };
}

// Worker as verifier (API process -> Worker, /internal/*).
// Returns { ok: true } or { ok: false, step } (step is logged, never
// returned to the caller). Supports the rotation overlap: the presented
// secret may be the current or the previous secret.
async function verifyInternalAuth(request, env, bodyText) {
  const db = env.NOVA_DB;
  if (!db) return { ok: false, step: 1 };
  const secrets = [env.NOVA_API_SECRET, env.NOVA_API_SECRET_PREVIOUS]
    .filter((s) => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, step: 1 };

  // (1) secret present: the presented secret must match a configured one.
  // Compared by hash so the comparison itself is constant-time.
  const presented = request.headers.get("X-NOVA-API-SECRET") || "";
  let presentedMatches = false;
  if (typeof presented === "string" && presented.length > 0) {
    const presentedHash = await sha256Hex(presented);
    for (const s of secrets) {
      if (timingSafeEqual(hexToBytes(presentedHash), hexToBytes(await sha256Hex(s)))) {
        presentedMatches = true;
      }
    }
  }
  if (!presentedMatches) return { ok: false, step: 1 };

  // (2) signature present and well-formed; nonce present and well-formed.
  const signature = request.headers.get("X-NOVA-SIGNATURE") || "";
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, step: 2 };
  const nonce = request.headers.get("X-NOVA-NONCE") || "";
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, step: 2 };

  // (3) timestamp within ±60 seconds.
  const timestamp = request.headers.get("X-NOVA-TIMESTAMP") || "";
  if (!/^[0-9]+$/.test(timestamp)) return { ok: false, step: 3 };
  const ts = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 60) return { ok: false, step: 3 };

  // (4) signature verifies (constant-time). Verified against the presented
  // secret, which step 1 already established is a configured secret.
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const bodyHash = await sha256Hex(bodyText);
  const canonical = [request.method, path, timestamp, nonce, bodyHash].join("\n");
  const expected = await hmacSha256Hex(presented, canonical);
  if (!timingSafeEqual(hexToBytes(expected), hexToBytes(signature))) {
    return { ok: false, step: 4 };
  }

  // (5) nonce unseen — consumed ONLY now, after the signature verified.
  try {
    const res = await db
      .prepare(
        "INSERT OR IGNORE INTO hmac_nonces (nonce, expires_at) VALUES (?, ?)"
      )
      .bind(nonce, (ts + 360) * 1000)
      .run();
    const changes =
      res && res.meta && typeof res.meta.changes === "number"
        ? res.meta.changes
        : 0;
    if (changes !== 1) return { ok: false, step: 5 };
    // Best-effort prune of expired nonces; a prune failure never fails auth.
    try {
      await db
        .prepare("DELETE FROM hmac_nonces WHERE expires_at < ?")
        .bind(Date.now())
        .run();
    } catch {
      // ignore
    }
  } catch {
    return { ok: false, step: 5 };
  }
  return { ok: true };
}

// ------------------------------------------- Kaggle status vocabulary
// DESIGN-MAPPING DECISION (proofs workstream, verified live via Kaggle CLI,
// 25 Nov 2026 — recorded here for the coordinator's final report).
// The wire vocabulary is the prefixed enum `KernelWorkerStatus.*` with
// SEVEN members: QUEUED, RUNNING, COMPLETE, ERROR, CANCEL_REQUESTED,
// CANCEL_ACKNOWLEDGED, NEW_SCRIPT. The design (Rev 3.2 §B-3.2.3.3) assumes
// bare QUEUED/RUNNING/COMPLETE/ERROR and defines six getExecutionState
// states: never-received, accepted, running, completed, failed, unknown.
// This function strips the `KernelWorkerStatus.` prefix and maps all seven
// wire members onto the six design states, FAIL-CLOSED:
//   - QUEUED -> accepted (capacity committed, queued).
//   - RUNNING -> running.
//   - COMPLETE -> completed (finished; still awaits its fileReport to
//     finalise — a completed status never finalises a job on its own).
//   - ERROR -> failed (terminal failure).
//   - CANCEL_REQUESTED -> unknown: a cancel is in flight and the outcome is
//     uncertain — the execution may still complete or be cancelled. It is
//     NOT treated as accepted and NOT treated as failed; reconciliation
//     holds both reservations and waits. Mapping it to failed would release
//     reservations for a job that may still run.
//   - CANCEL_ACKNOWLEDGED -> failed (reason: executor-cancelled): the
//     platform has acknowledged the cancellation, so the execution will
//     not run — a definitive terminal non-success. The failure reason is
//     recorded as a cancellation, not an error, so the operator log shows
//     what actually happened. Safe to release reservations and fail the job.
//   - NEW_SCRIPT -> unknown: the script was received but is not yet queued
//     — acceptance is unconfirmed. Mapping it to never-received would fail
//     a job that exists and may still queue; holding as unknown lets the
//     60-second window and the periodic reconciliation resolve it.
//   - Anything else, or an absent value -> unknown (fail-closed default).
// The authoritative mapping lives where the Kaggle query is executed (the
// API-process executor, another workstream — it MUST apply this same table
// at the source). This Worker-side copy is defence-in-depth: the Worker's
// execution-level status resolution normalises any state it receives
// through this table before deciding, so a raw prefixed value can never be
// misread as an acceptance. No Kaggle job was dispatched to test this.

const KAGGLE_STATUS_MAP = {
  QUEUED: "accepted",
  RUNNING: "running",
  COMPLETE: "completed",
  ERROR: "failed",
  CANCEL_REQUESTED: "unknown",
  CANCEL_ACKNOWLEDGED: "failed",
  NEW_SCRIPT: "unknown"
};

function normalizeExecutorState(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  let value = raw;
  const prefix = "KernelWorkerStatus.";
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  value = value.toUpperCase();
  return KAGGLE_STATUS_MAP[value] || "unknown";
}

function kaggleCancelReason(raw) {
  if (typeof raw !== "string") return null;
  let value = raw;
  const prefix = "KernelWorkerStatus.";
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  return value.toUpperCase() === "CANCEL_ACKNOWLEDGED"
    ? "executor-cancelled"
    : null;
}

// ------------------------------------------------- Atomic rate limiting
// Rev 3 §C-1.6: ONE single-statement upsert handles first-use,
// current-window, expired-window, and limit-reached. The outcome is read
// from meta.changes AFTER the statement completes — never used to build
// another statement in the same batch. changes 1 -> allowed; 0 -> 429.

async function rateLimitCheck(db, key, windowMs, limit, nowMs) {
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const windowEnd = windowStart + windowMs;
  const res = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, window_end, count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         window_start = CASE WHEN rate_limits.window_end <= excluded.window_start
                             THEN excluded.window_start ELSE rate_limits.window_start END,
         window_end = CASE WHEN rate_limits.window_end <= excluded.window_start
                           THEN excluded.window_end ELSE rate_limits.window_end END,
         count = CASE WHEN rate_limits.window_end <= excluded.window_start
                      THEN 1 ELSE rate_limits.count + 1 END,
         updated_at = excluded.updated_at
       WHERE (rate_limits.window_end <= excluded.window_start)
          OR (rate_limits.count < ?)`
    )
    .bind(key, windowStart, windowEnd, nowMs, limit)
    .run();
  const changes =
    res && res.meta && typeof res.meta.changes === "number"
      ? res.meta.changes
      : 0;
  if (changes === 1) return { allowed: true, retryAfter: 0 };
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((windowEnd - nowMs) / 1000))
  };
}

// Keyed-hash IP storage (Rev 2 §14.3): the raw IP is NEVER stored. The
// Worker reads the client IP from CF-Connecting-IP only; X-Forwarded-For
// is never trusted. A missing header (local test) hashes as "unknown".
async function ipRateKey(env, request, scope) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const salt = env.NOVA_IP_HASH_SALT || "nova-ip-hash-salt-v1";
  const hash = await hmacSha256Hex(salt, ip);
  return "ip-" + scope + ":" + hash;
}

// ------------------------------------------------- Retention measurement
// Rev 3.2 §B-3.2.6.2: the retained-bytes figure is the LOGICAL UTF-8
// payload of jobs + scenes (never claimed as physical storage). Exact SQL,
// used identically by the alert check and the sweep report. Counted
// population (Rev 3.2 §B-3.2.5.2): ALL jobs + scenes rows, terminal and
// non-terminal alike; rate_limits excluded.

const RETENTION_MEASURE_SQL = `
  SELECT
    (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS retained_rows,
    (SELECT COALESCE(SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(data AS BLOB))), 0)
       FROM jobs)
    + (SELECT COALESCE(SUM(
          LENGTH(CAST(job_id AS BLOB))
          + LENGTH(CAST(execution_id AS BLOB))
          + LENGTH(CAST(COALESCE(provider_job_id, '') AS BLOB))
          + LENGTH(CAST(status AS BLOB))
          + LENGTH(CAST(COALESCE(error, '') AS BLOB))
          + LENGTH(CAST(COALESCE(output_ref, '') AS BLOB))
          + 32
        ), 0)
       FROM scenes) AS retained_bytes`;

async function measureRetention(db) {
  const row = await db.prepare(RETENTION_MEASURE_SQL).first();
  return {
    retainedRows: row ? Number(row.retained_rows) || 0 : 0,
    retainedBytes: row ? Number(row.retained_bytes) || 0 : 0
  };
}

async function countRetainedRows(db) {
  const row = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS total"
    )
    .first();
  return row ? Number(row.total) || 0 : 0;
}

// ------------------------------------------- Aggregate recompute (SQL)
// Rev 3 §C-1.3 statement 2, verbatim: the parent aggregate is recomputed
// in SQL from the LATEST attempt per scene index. Never moves backwards
// from running to queued; never overwrites a terminal parent (cancelled /
// expired); a retry's queued row moves partial_failed -> running. Bind
// [jobId, jobId, jobId].

const AGGREGATE_RECOMPUTE_SQL = `
  WITH latest AS (
    SELECT scene_index, MAX(attempt) AS max_attempt
    FROM scenes WHERE job_id = ? GROUP BY scene_index
  ),
  cur AS (
    SELECT s.status AS st FROM scenes s
    JOIN latest l ON l.scene_index = s.scene_index AND l.max_attempt = s.attempt
    WHERE s.job_id = ?
  )
  UPDATE jobs SET data = json_set(data, '$.status', (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM cur WHERE st IN ('dispatched','running')) THEN 'running'
      WHEN EXISTS (SELECT 1 FROM cur WHERE st = 'queued')
       AND EXISTS (SELECT 1 FROM cur WHERE st = 'succeeded') THEN 'running'
      WHEN NOT EXISTS (SELECT 1 FROM cur WHERE st <> 'succeeded') THEN 'succeeded'
      WHEN EXISTS (SELECT 1 FROM cur WHERE st = 'succeeded')
       AND EXISTS (SELECT 1 FROM cur WHERE st IN ('failed','timed-out','cancelled')) THEN 'partial_failed'
      WHEN NOT EXISTS (SELECT 1 FROM cur WHERE st NOT IN ('failed','timed-out','cancelled')) THEN 'failed'
      ELSE 'queued'
    END
  ))
  WHERE id = ?
    AND json_extract(data, '$.status') NOT IN ('cancelled','expired')`;

// Scene statuses that are terminal for the aggregate / retry rules.
const SCENE_TERMINAL = new Set(["succeeded", "failed", "timed-out", "cancelled"]);
const PARENT_TERMINAL = new Set([
  "succeeded", "partial_failed", "failed", "cancelled", "expired"
]);

// Completeness (Rev 3.5 §C-3.5.1.2): a job's initial scene set is complete
// iff, for EVERY expected scene index, exactly one row exists with that
// job_id, that scene_index, and attempt = 1. Retry rows (attempt >= 2)
// are NEVER substitutes. A total row count is never a completeness check.
function findMissingAttempt1Indexes(expectedIndexes, sceneRows) {
  const present = new Set();
  for (const row of sceneRows) {
    if (row.attempt === 1) present.add(row.scene_index);
  }
  return expectedIndexes.filter((idx) => !present.has(idx));
}

function planIndexesFromJob(job) {
  if (job.mode === "plan" && Array.isArray(job.scenes)) {
    return job.scenes.map((s) => s.index);
  }
  return [0];
}

// ------------------------------------------- Worker -> API process
// Rev 2 §3.4/§3.5 + Rev 3 §C-1.7: a resolvable HOSTNAME is mandatory for
// the API origin. A literal IPv4/IPv6 address is NOT permitted (Workers
// subrequests require a hostname URL) — such an origin is treated as
// unconfigured, the API is unreachable, and generation returns the honest
// 503. `localhost` is a hostname, not a literal IP, and is permitted (the
// controlled-test harness uses it). The origin is a deployment parameter,
// never hardcoded, never guessed.

function apiOrigin(env) {
  const origin = env.NOVA_API_ORIGIN;
  if (typeof origin !== "string" || origin.length === 0) return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname;
  const ipv4 = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
  const ipv6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;
  if (ipv4.test(host)) return null;
  if (host.includes(":") && ipv6.test(host)) return null;
  return origin.replace(/\/+$/, "");
}

// One signed call to the API process. Returns { status, json, text } or
// throws { code: "TIMEOUT" | "NETWORK", message }. A 401 is never retried
// by the caller (Rev 2 §3.5): it is a credential error.
async function callApi(env, method, path, bodyObj, timeoutMs) {
  const origin = apiOrigin(env);
  const secret = env.NOVA_API_SECRET;
  if (!origin || !secret) {
    const e = new Error("API process is not configured.");
    e.code = "NOT_CONFIGURED";
    throw e;
  }
  const bodyText = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const headers = await signApiCall(secret, method, path, bodyText);
  let response;
  try {
    response = await fetch(origin + path, {
      method,
      headers,
      body: method === "GET" ? undefined : bodyText,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const err = new Error("API call failed: " + (e && e.name ? e.name : "network"));
    err.code = e && e.name === "TimeoutError" ? "TIMEOUT" : "NETWORK";
    throw err;
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

// POST /internal/submit (Rev 2 §3.4, Rev 3.2 §B-3.2.8): the response
// carries dispatchState "slot-claimed" (or "executor-accepted" when
// acceptance already arrived). The 202 is returned after the spending
// reservation exists AND the slot is claimed — executor acceptance is
// confirmed asynchronously and reported through status, not a precondition
// of the 202. A spending reservation alone is never sufficient for a 202.
async function submitToApi(env, job, executions, deploymentMode) {
  const body = {
    jobId: job.id,
    mode: job.mode,
    model: "ltx-video-2b",
    frames: 121,
    resolution: "1024x576",
    fps: 24,
    deploymentMode,
    sceneExecutions: executions.map((x) => ({
      sceneIndex: x.sceneIndex,
      attempt: x.attempt,
      executionId: x.executionId,
      idempotencyKey: x.executionId
    }))
  };
  if (job.mode === "single") {
    body.prompt = job.prompt;
  } else {
    body.scenes = job.scenes;
  }
  return callApi(env, "POST", "/internal/submit", body, PHASE3_SUBMIT_TIMEOUT_MS);
}

// Execution-level status lookup (Rev 3 §C-1.8). The idempotency key IS the
// execution ID (§5.2). This is the endpoint the Worker uses to resolve an
// uncertain submission — never the parent aggregation endpoint, which
// cannot identify one execution. Returns the parsed body or null.
async function lookupExecution(env, executionId) {
  const path =
    "/internal/status?executionId=" + encodeURIComponent(executionId);
  const res = await callApi(env, "GET", path, undefined, PHASE3_STATUS_TIMEOUT_MS);
  if (res.status === 404) return { absent: true };
  if (res.status !== 200 || !res.json) return null;
  return res.json;
}

// Resolve an uncertain submission (Rev 3.1 §A-3.1.2.3, Rev 3.2 §B-3.2.3).
// Called once, after a submit whose outcome is unknown (timeout / network
// / 5xx). Never blindly re-submits. Returns one of:
//   { decision: "proceed" }            — journal shows dispatched/provider-ack
//   { decision: "resubmit" }           — journal shows submitted/reservation
//                                        with no manager job, or absent
//   { decision: "failed", reason }     — journal shows failed
//   { decision: "unknown" }            — executor unreachable / lookup failed;
//                                        hold, do not fail, do not redispatch
// The state value is normalised through normalizeExecutorState() first, so
// a raw KernelWorkerStatus.* value from the API process is interpreted
// fail-closed rather than misread (see the mapping decision above).
function decideFromJournalState(journal) {
  if (!journal || journal.absent) return { decision: "resubmit" };
  const raw = journal.state || journal.executorState || "";
  const journalStates = new Set([
    "submitted", "reservation", "dispatched", "provider-ack", "failed"
  ]);
  if (journalStates.has(raw)) {
    if (raw === "dispatched" || raw === "provider-ack") {
      return { decision: "proceed" };
    }
    if (raw === "failed") {
      return { decision: "failed", reason: journal.error || "dispatch-failed" };
    }
    return { decision: "resubmit" }; // submitted / reservation
  }
  // Not a journal state: interpret it as an executor state, fail-closed.
  const exec = normalizeExecutorState(raw);
  if (exec === "accepted" || exec === "running") {
    return { decision: "proceed" };
  }
  if (exec === "failed") {
    return {
      decision: "failed",
      reason: kaggleCancelReason(raw) || journal.error || "executor-failed"
    };
  }
  if (exec === "completed") {
    // Finished without a fileReport: await the report, do not fail,
    // do not re-dispatch (Rev 3.2 §B-3.2.3.2).
    return { decision: "unknown" };
  }
  return { decision: "unknown" }; // unknown / never-received handled below
}

async function resolveUncertainSubmission(env, executions) {
  // Every execution of the one submit must agree; a single "unknown"
  // holds the whole submission (reconcile-first, never guess). Manager job
  // IDs seen in the journal are collected so a "proceed" decision can
  // still record provider_job_id on the scene rows.
  const managerJobIds = {};
  let sawResubmit = false;
  let dispatchState = "slot-claimed";
  for (const x of executions) {
    let journal;
    try {
      journal = await lookupExecution(env, x.executionId);
    } catch {
      return { decision: "unknown" };
    }
    if (journal === null) return { decision: "unknown" };
    if (journal.absent) {
      sawResubmit = true;
      continue;
    }
    if (journal.managerJobId) managerJobIds[x.executionId] = journal.managerJobId;
    const d = decideFromJournalState(journal);
    if (d.decision === "failed") return d;
    if (d.decision === "unknown") return { decision: "unknown" };
    if (d.decision === "resubmit") sawResubmit = true;
    if (d.decision === "proceed") {
      if (journal.state === "provider-ack") dispatchState = "executor-accepted";
    }
    // "proceed" for this execution: keep checking the rest.
  }
  if (sawResubmit) return { decision: "resubmit" };
  return { decision: "proceed", managerJobIds, dispatchState };
}

// ------------------------------------------------- Creation batch (D1)
// Rev 3.2 §B-3.2.1 + Rev 3.3 §C-3.3.1 + Rev 3.4 §C-3.4.1: ONE D1 batch()
// of exactly 2+N statements, constructed ENTIRELY before submission.
// Statement 1: combined conditional parent insert — (a) no row with this
// jobId, (b) per-token active-job cap < 3, (c) COMPLETE footprint fits:
// existing retained rows + 1 + N <= 100000. Statements 2..N+1: one
// marker-gated scene insert per initial scene row (attempt 1, deterministic
// execution ID). NO NOT EXISTS on the scene inserts: on the fresh path the
// marker matches, so an insert either inserts exactly one row or fails
// with a PRIMARY KEY violation that rolls the whole batch back; on the
// duplicate path the fresh marker matches no stored parent, so every scene
// insert is a no-op by construction. Statement N+2: read-back of the parent
// row. If a statement fails, the whole batch rolls back (no partial state).

function buildCreationBatch(db, jobData, scenes, creationToken) {
  const n = scenes.length;
  const stmts = [];
  stmts.push(
    db
      .prepare(
        `INSERT INTO jobs (id, data)
         SELECT ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?)
           AND (SELECT COUNT(*) FROM jobs
                WHERE json_extract(data, '$.accessTokenHash') = ?
                  AND json_extract(data, '$.status')
                      NOT IN ('succeeded','failed','timed-out','cancelled','expired')) < 3
           AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) + 1 + ? <= 100000`
      )
      .bind(
        jobData.id,
        JSON.stringify(jobData),
        jobData.id,
        jobData.accessTokenHash,
        n
      )
  );
  for (const scene of scenes) {
    const executionId =
      jobData.id + ":scene-" + scene.index + ":attempt-1";
    stmts.push(
      db
        .prepare(
          `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
                              status, error, output_ref, expires_at, updated_at)
           SELECT ?, ?, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?
           WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?
                         AND json_extract(data, '$.creationToken') = ?)`
        )
        .bind(
          jobData.id,
          scene.index,
          executionId,
          jobData.createdAtMs,
          jobData.id,
          creationToken
        )
    );
  }
  stmts.push(
    db.prepare("SELECT id, data FROM jobs WHERE id = ?").bind(jobData.id)
  );
  return stmts;
}

// Mark a job + its scenes failed after a dispatch failure (compensation,
// Rev 2 §10.3): one batch — per-scene conditional failure updates, the
// SQL-side aggregate recompute, and the reconciliation flag. No
// read-modify-write: every statement is conditional SQL.
async function markJobFailed(db, jobId, sceneIndexes, reason, nowMs) {
  const stmts = [];
  for (const idx of sceneIndexes) {
    stmts.push(
      db
        .prepare(
          `UPDATE scenes SET status = 'failed', error = ?, updated_at = ?
           WHERE job_id = ? AND scene_index = ? AND attempt = (
             SELECT MAX(attempt) FROM scenes WHERE job_id = ? AND scene_index = ?)
             AND status NOT IN ('succeeded','failed','timed-out','cancelled')`
        )
        .bind(reason, nowMs, jobId, idx, jobId, idx)
    );
  }
  stmts.push(db.prepare(AGGREGATE_RECOMPUTE_SQL).bind(jobId, jobId, jobId));
  stmts.push(
    db
      .prepare(
        "UPDATE jobs SET data = json_set(data, '$.reconciliationNeeded', 1, '$.updatedAt', ?) WHERE id = ?"
      )
      .bind(new Date(nowMs).toISOString(), jobId)
  );
  await db.batch(stmts);
}

// After a successful submit: job dispatchState -> "submitted" and each
// scene's provider_job_id set (Rev 3.2 §B-3.2.2.3). One batch, both
// transitions one-way / idempotent (dispatchState guard; provider_job_id
// IS NULL guard). Returns true when the job transition applied.
async function markSubmitted(db, jobId, executions) {
  const stmts = [
    db
      .prepare(
        "UPDATE jobs SET data = json_set(data, '$.dispatchState', 'submitted') WHERE id = ? AND json_extract(data, '$.dispatchState') = 'intent-recorded'"
      )
      .bind(jobId)
  ];
  for (const x of executions) {
    stmts.push(
      db
        .prepare(
          "UPDATE scenes SET provider_job_id = ? WHERE job_id = ? AND scene_index = ? AND attempt = ? AND provider_job_id IS NULL"
        )
        .bind(x.providerJobId, jobId, x.sceneIndex, x.attempt)
    );
  }
  await db.batch(stmts);
  // Verify by re-reading: every execution's scene row must now carry a
  // provider_job_id. The jobs UPDATE is a no-op when dispatchState is
  // already "submitted" (re-submit / retry paths), so its change count
  // cannot be the success signal — the scene rows are.
  const rows = await db
    .prepare(
      "SELECT scene_index, attempt, provider_job_id FROM scenes WHERE job_id = ?"
    )
    .bind(jobId)
    .all();
  const byKey = new Map();
  for (const r of (rows && rows.results) || []) {
    byKey.set(r.scene_index + ":" + r.attempt, r.provider_job_id);
  }
  return executions.every(
    (x) =>
      byKey.get(x.sceneIndex + ":" + x.attempt) !== null &&
      byKey.get(x.sceneIndex + ":" + x.attempt) !== undefined
  );
}

// Read the request body as raw bytes with the 16 KB guard and fatal UTF-8
// decoding (Rev 2 §5.1, Rev 3.2 §B-3.2.10.2). Returns { text } or
// { error: { status, message } }.
async function readRawBody(request) {
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return { error: { status: 400, message: "Invalid request body." } };
  }
  if (buf.byteLength > PHASE3_MAX_BODY_BYTES) {
    return {
      error: {
        status: 413,
        message: "The request body exceeds the allowed size."
      }
    };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return {
      error: { status: 400, message: "The request body is not valid UTF-8." }
    };
  }
  return { text };
}

// Controlled-test mode gate (Rev 3 §C-1.4). The mode is a property of the
// deployment, never of a request: no request parameter, header, or body
// field can enable it. Returns null when the request may proceed, or
// { status, body } to return immediately.
// - production + test key presented -> 401 (no test credential exists there)
// - controlled-test + test key presented but wrong -> 401
// - controlled-test + no test key -> 503 (a public request)
// - production (any request) -> 503 (no production capacity authorised)
function controlledTestGate(request, env) {
  const mode = phase3ApiMode(env);
  const presented = request.headers.get("X-NOVA-TEST-KEY");
  if (mode === "production") {
    if (presented) {
      return {
        status: 401,
        body: { error: "unauthorised" }
      };
    }
    return {
      status: 503,
      body: {
        error: "capacity_unavailable",
        message:
          "No video generation capacity is available right now. Please try again in a few minutes.",
        retryAfterSeconds: 120
      }
    };
  }
  // controlled-test mode
  if (!presented) {
    return {
      status: 503,
      body: {
        error: "capacity_unavailable",
        message:
          "No video generation capacity is available right now. Please try again in a few minutes.",
        retryAfterSeconds: 120
      }
    };
  }
  const expected = env.NOVA_TEST_KEY;
  if (
    typeof expected !== "string" ||
    expected.length === 0 ||
    presented.length !== expected.length ||
    !timingSafeEqual(
      new TextEncoder().encode(presented),
      new TextEncoder().encode(expected)
    )
  ) {
    return { status: 401, body: { error: "unauthorised" } };
  }
  return null;
}

// Build the GET /api/status body (Rev 2 §4.2) from a job record + its
// scene rows. One entry per planned scene index, latest attempt only.
// While a retry is active the retried scene reports retrying: true and the
// parent reports running (Rev 3 §C-1.5 communication rule).
async function buildStatusBody(db, job, nowMs) {
  const rows = await db
    .prepare(
      `SELECT scene_index, attempt, execution_id, provider_job_id, status,
              error, output_ref, expires_at, updated_at
       FROM scenes WHERE job_id = ? ORDER BY scene_index ASC, attempt ASC`
    )
    .bind(job.id)
    .all();
  const sceneRows = (rows && rows.results) || [];
  const latest = new Map();
  for (const r of sceneRows) {
    const cur = latest.get(r.scene_index);
    if (!cur || r.attempt > cur.attempt) latest.set(r.scene_index, r);
  }
  const scenes = [];
  let expiresAt = null;
  for (const idx of planIndexesFromJob(job)) {
    const r = latest.get(idx);
    if (!r) {
      // Incomplete initial scene set (Rev 3.4/3.5): surfaced honestly.
      scenes.push({
        index: idx,
        attempt: 1,
        executionId: job.id + ":scene-" + idx + ":attempt-1",
        status: "missing",
        error: "Scene row missing.",
        expiresAt: null,
        retrying: false,
        downloadUrl: null
      });
      continue;
    }
    const exp = r.expires_at === null || r.expires_at === undefined
      ? null
      : r.expires_at;
    if (exp !== null && (expiresAt === null || exp > expiresAt)) {
      expiresAt = exp;
    }
    const earlierFailed = sceneRows.some(
      (x) =>
        x.scene_index === idx &&
        x.attempt < r.attempt &&
        (x.status === "failed" || x.status === "timed-out")
    );
    const retrying =
      r.attempt > 1 &&
      earlierFailed &&
      (r.status === "queued" ||
        r.status === "dispatched" ||
        r.status === "running");
    const downloadable =
      r.status === "succeeded" &&
      r.output_ref &&
      exp !== null &&
      exp > nowMs;
    scenes.push({
      index: idx,
      attempt: r.attempt,
      executionId: r.execution_id,
      status: r.status,
      error: r.error || null,
      expiresAt: exp,
      retrying,
      downloadUrl: downloadable
        ? "/api/download?jobId=" + job.id + "&scene=" + idx
        : null
    });
  }
  const firstReady = scenes.find((s) => s.downloadUrl);
  return {
    jobId: job.id,
    status: job.status,
    engine: job.engine || "ltx-video-2b",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress:
      job.status === "running"
        ? { stage: "generating", framesTotal: 121 }
        : null,
    expiresAt,
    downloadUrl: firstReady ? firstReady.downloadUrl : null,
    error: job.error || null,
    scenes,
    dispatchState: job.dispatchState || null,
    ...(job.deploymentMode === "controlled-test"
      ? { mode: "controlled-test" }
      : {})
  };
}

function capacityUnavailableBody() {
  return {
    error: "capacity_unavailable",
    message:
      "No video generation capacity is available right now. Please try again in a few minutes.",
    retryAfterSeconds: 120
  };
}

// Complete a dispatch after a successful /internal/submit: mark-submitted,
// then the 202 (Rev 3.2 §B-3.2.8 — 202 after slot-claim, never before).
async function completeDispatch(env, job, executions, submitJson, nowMs) {
  const managerJobIds = Array.isArray(submitJson && submitJson.managerJobIds)
    ? submitJson.managerJobIds
    : [];
  const execs = executions.map((x, i) => ({
    ...x,
    providerJobId: managerJobIds[i] !== undefined ? managerJobIds[i] : null
  }));
  let marked = false;
  try {
    marked = await markSubmitted(env.NOVA_DB, job.id, execs);
  } catch (e) {
    console.error("[NOVA] mark-submitted failed:", e && e.message);
    marked = false;
  }
  if (!marked) {
    // The job is dispatched; recovery (duplicate path / reconciliation)
    // converges the record later. Never send a 202 for a job whose
    // submitted state could not be recorded.
    return {
      status: 500,
      body: {
        jobId: job.id,
        status: "failed",
        message: "NOVA could not save the production job. Please try again."
      }
    };
  }
  return {
    status: 202,
    body: {
      jobId: job.id,
      status: "queued",
      engine: "ltx-video-2b",
      createdAt: job.createdAt,
      expiresAt: null,
      dispatchState:
        submitJson && submitJson.dispatchState
          ? submitJson.dispatchState
          : "slot-claimed"
    }
  };
}

// Dispatch attempt with unknown-outcome handling (Rev 3.1 §A-3.1.2.3).
// Returns { status, body, extraHeaders? }.
async function attemptDispatch(env, job, executions, nowMs) {
  const db = env.NOVA_DB;
  const cap503 = () => ({ status: 503, body: capacityUnavailableBody() });
  const unknown503 = () => ({
    status: 503,
    body: {
      ...capacityUnavailableBody(),
      message:
        "The generation request could not be confirmed. Please retry with the same job ID."
    }
  });

  const handleUnknown = async () => {
    let resolution;
    try {
      resolution = await resolveUncertainSubmission(env, executions);
    } catch {
      resolution = { decision: "unknown" };
    }
    if (resolution.decision === "proceed") {
      return completeDispatch(
        env,
        job,
        executions,
        {
          managerJobIds: executions.map(
            (x) => (resolution.managerJobIds || {})[x.executionId] || null
          ),
          dispatchState: resolution.dispatchState || "slot-claimed"
        },
        nowMs
      );
    }
    if (resolution.decision === "resubmit") {
      // Exactly one identical re-submit (idempotent on the execution ID).
      let retry;
      try {
        retry = await submitToApi(env, job, executions, phase3ApiMode(env));
      } catch {
        return unknown503();
      }
      if (retry.status === 200 || retry.status === 202) {
        return completeDispatch(env, job, executions, retry.json, nowMs);
      }
      if (retry.status === 401) {
        console.error("[NOVA] API process rejected the Worker secret (401).");
        return {
          status: 500,
          body: {
            jobId: job.id,
            status: "failed",
            message: "Service unavailable. Please try again."
          }
        };
      }
      if (
        retry.json &&
        ["no-capacity", "no-executor", "ceiling", "storage-full"].includes(
          retry.json.error
        )
      ) {
        try {
          await markJobFailed(
            db,
            job.id,
            executions.map((x) => x.sceneIndex),
            retry.json.error,
            nowMs
          );
        } catch {
          // compensation best-effort; the record stays intent-recorded
        }
        return cap503();
      }
      return unknown503();
    }
    if (resolution.decision === "failed") {
      try {
        await markJobFailed(
          db,
          job.id,
          executions.map((x) => x.sceneIndex),
          resolution.reason || "dispatch-failed",
          nowMs
        );
      } catch {
        // best-effort
      }
      return {
        status: 500,
        body: {
          jobId: job.id,
          status: "failed",
          message: "NOVA could not start the production job. Please try again."
        }
      };
    }
    return unknown503();
  };

  let submit;
  try {
    submit = await submitToApi(env, job, executions, phase3ApiMode(env));
  } catch (e) {
    if (e && e.code === "NOT_CONFIGURED") return cap503();
    return handleUnknown();
  }
  if (submit.status === 401) {
    console.error("[NOVA] API process rejected the Worker secret (401).");
    return {
      status: 500,
      body: {
        jobId: job.id,
        status: "failed",
        message: "Service unavailable. Please try again."
      }
    };
  }
  if (submit.status === 200 || submit.status === 202) {
    return completeDispatch(env, job, executions, submit.json, nowMs);
  }
  if (
    submit.json &&
    ["no-capacity", "no-executor", "ceiling", "storage-full"].includes(
      submit.json.error
    )
  ) {
    try {
      await markJobFailed(
        db,
        job.id,
        executions.map((x) => x.sceneIndex),
        submit.json.error,
        nowMs
      );
    } catch {
      // best-effort
    }
    return cap503();
  }
  return handleUnknown();
}

// Poll a job row until its dispatchState becomes "submitted" (or the
// budget runs out). Used by the duplicate path to tell a simultaneous
// duplicate (the winner's dispatch is still in flight) from a retry after
// a dead attempt (T31-01 vs T31-02, Rev 3.2 §B-3.2.1.1/§B-3.2.2.2).
// I/O-bound polling only; returns false on a missing row or bad JSON.
async function waitForSubmitted(db, jobId, budgetMs) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    let row;
    try {
      row = await db
        .prepare("SELECT data FROM jobs WHERE id = ?")
        .bind(jobId)
        .first();
    } catch {
      return false;
    }
    if (!row) return false;
    try {
      if (JSON.parse(row.data).dispatchState === "submitted") return true;
    } catch {
      return false;
    }
  }
  return false;
}

// ------------------------------------------------- POST /api/generate
// Rev 2 §4.2 + §5.1, Rev 3 §C-1.4/§C-1.6/§C-2.1/§C-2.2, Rev 3.1 §A-3.1.1,
// Rev 3.2 §B-3.2.1/§B-3.2.2/§B-3.2.8, Rev 3.3 §C-3.3.1, Rev 3.4 §C-3.4.1,
// Rev 3.5 §C-3.5.1.

async function handleGenerate(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN, X-NOVA-TEST-KEY",
    "POST, OPTIONS"
  );
  const respond = (status, data, extra) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, ...(extra || {}) }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return respond(405, {
      status: "failed",
      message: "Only POST requests are allowed."
    });
  }

  const raw = await readRawBody(request);
  if (raw.error) {
    return respond(raw.error.status, {
      status: "failed",
      message: raw.error.message
    });
  }
  let parsed;
  try {
    parsed = parseStrictJson(raw.text);
  } catch {
    return respond(400, { status: "failed", message: "Invalid JSON request." });
  }
  const v = validateGenerateBody(parsed);
  if (!v.ok) {
    return respond(400, {
      jobId:
        parsed.value && typeof parsed.value.jobId === "string"
          ? parsed.value.jobId
          : undefined,
      status: "failed",
      message: v.message
    });
  }
  const normalized = v.normalized;
  const jobId = normalized.jobId;

  const token = request.headers.get("X-NOVA-JOB-TOKEN") || "";
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return respond(400, {
      jobId,
      status: "failed",
      message: "A valid 64-character NOVA job access token is required."
    });
  }

  // Controlled-test mode gate (deployment fact, never a request field).
  const gate = controlledTestGate(request, env);
  if (gate) {
    return respond(gate.status, { jobId, status: "failed", ...gate.body });
  }

  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not save the production job. Please try again."
    });
  }
  const nowMs = Date.now();

  // Per-IP generation limit (10/hour, atomic upsert).
  const ipKey = await ipRateKey(env, request, "gen");
  const rl = await rateLimitCheck(
    db,
    ipKey,
    3600000,
    PHASE3_GEN_LIMIT_PER_HOUR,
    nowMs
  );
  if (!rl.allowed) {
    return respond(
      429,
      {
        jobId,
        status: "failed",
        message: "Rate limit exceeded. Please try again later."
      },
      { "Retry-After": String(rl.retryAfter) }
    );
  }

  // No API origin (or a literal-IP origin) means no dispatch path exists:
  // the honest 503, and NO job record is created (Rev 2 §6.1 step 1).
  if (!apiOrigin(env) || !env.NOVA_API_SECRET) {
    console.error("[NOVA] generate: API process origin not configured.");
    return respond(503, { jobId, ...capacityUnavailableBody() });
  }

  const tokenHash = await sha256Hex(token);
  const canonical = buildCanonicalRequest(normalized);
  const requestIdentityHash = await sha256Hex(canonical);
  const creationToken = crypto.randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const jobData = {
    id: jobId,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdAtMs: nowMs,
    status: "queued",
    mode: normalized.mode,
    engine: "ltx-video-2b",
    model: "ltx-video-2b",
    frames: 121,
    resolution: "1024x576",
    fps: 24,
    accessTokenHash: tokenHash,
    requestIdentityHash,
    requestIdentityVersion: CANONICAL_REQUEST_VERSION,
    dispatchState: "intent-recorded",
    creationToken,
    deploymentMode: phase3ApiMode(env)
  };
  if (normalized.mode === "single") {
    jobData.prompt = normalized.prompt;
  } else {
    jobData.scenes = normalized.scenes;
  }
  try {
    checkRecordSize(jobData);
  } catch (e) {
    if (e && e.code === "RECORD_TOO_LARGE") {
      return respond(413, {
        jobId,
        status: "failed",
        message: "The production record exceeds the allowed size."
      });
    }
    throw e;
  }

  const executions = normalized.scenes.map((s) => ({
    sceneIndex: s.index,
    attempt: 1,
    executionId: jobId + ":scene-" + s.index + ":attempt-1"
  }));

  let results;
  try {
    results = await db.batch(
      buildCreationBatch(db, jobData, normalized.scenes, creationToken)
    );
  } catch (e) {
    // A statement failed: the whole batch rolled back; no partial state.
    console.error("[NOVA] creation batch failed:", e && e.message);
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not save the production job. Please try again."
    });
  }

  const parentChanges =
    results && results[0] && results[0].meta
      ? results[0].meta.changes
      : 0;
  const readBack =
    results && results.length > 0
      ? results[results.length - 1].results &&
        results[results.length - 1].results[0]
      : null;

  if (parentChanges === 1) {
    // Fresh creation. Defence-in-depth assertion (Rev 3.4 §C-3.4.1.2):
    // every scene insert must report changes = 1. It is NOT the atomicity
    // mechanism (the PRIMARY KEY rollback is) — if it ever trips, a relied-on
    // D1 property does not hold: do not dispatch, alert, return 500.
    let allInserted = true;
    for (let k = 1; k <= normalized.scenes.length; k++) {
      const c =
        results[k] && results[k].meta ? results[k].meta.changes : 0;
      if (c !== 1) allInserted = false;
    }
    if (!allInserted) {
      console.error(
        "[NOVA] creation scene-insert tripwire: jobId=" + jobId +
          " — a scene insert reported changes != 1 after the parent insert. " +
          "Flagged incomplete-scene-set; NOT dispatching; escalate for re-review."
      );
      try {
        await db
          .prepare(
            "UPDATE jobs SET data = json_set(data, '$.incompleteSceneSet', 1) WHERE id = ?"
          )
          .bind(jobId)
          .run();
      } catch {
        // best-effort flagging
      }
      return respond(500, {
        jobId,
        status: "failed",
        message: "NOVA could not save the production job. Please try again."
      });
    }
    const out = await attemptDispatch(env, jobData, executions, nowMs);
    return respond(out.status, out.body, out.extraHeaders);
  }

  if (readBack) {
    // Duplicate path (Rev 3 §C-2.1): ownership, then request identity.
    const existing = JSON.parse(readBack.data);
    if (!(await tokenMatches(token, existing.accessTokenHash))) {
      return respond(401, {
        jobId,
        status: "failed",
        message: "A valid NOVA job access token is required."
      });
    }
    if (existing.requestIdentityHash !== requestIdentityHash) {
      return respond(409, {
        jobId,
        status: "failed",
        error: "conflict",
        message: "jobId already used with a different request"
      });
    }
    // Creation-path verification (Rev 3.5 §C-3.5.1.2): per-index attempt-1.
    const sceneRows = await db
      .prepare("SELECT scene_index, attempt FROM scenes WHERE job_id = ?")
      .bind(jobId)
      .all();
    const missing = findMissingAttempt1Indexes(
      planIndexesFromJob(existing),
      (sceneRows && sceneRows.results) || []
    );
    if (missing.length > 0) {
      console.error(
        "[NOVA] incomplete-scene-set jobId=" + jobId +
          " missing indexes=" + missing.join(",") +
          " — duplicate returned unchanged; dispatch recovery suspended."
      );
      return respond(200, await buildStatusBody(db, existing, nowMs));
    }
    if (existing.dispatchState === "submitted") {
      return respond(200, await buildStatusBody(db, existing, nowMs));
    }
    // intent-recorded + complete scene set. Two cases share this state,
    // and the design treats them differently:
    // (a) a SIMULTANEOUS duplicate (T31-01, Rev 3.2 §B-3.2.1.1): "The
    // loser of a simultaneous race follows the duplicate path, never the
    // creation path" — the existing job is returned (200) and no second
    // manager job is created. (b) a LATER retry after the original
    // attempt died (T31-02, Rev 3.2 §B-3.2.2.2): recovery path 1 —
    // re-submit with the identical idempotency keys.
    // The two are told apart by waiting, briefly and boundedly, for the
    // in-flight dispatch to settle: the winner marks "submitted" within
    // its submit round trip (well under a second normally). If the row
    // becomes "submitted" during the wait, this is case (a) -> 200. If
    // it is still "intent-recorded" after the wait, the original attempt
    // is dead -> case (b), recovery path 1 below. The wait is I/O only
    // (100 ms polls); a dead attempt costs the retry at most the budget.
    const settled = await waitForSubmitted(db, jobId, 5000);
    if (settled) {
      const freshRow = await db
        .prepare("SELECT id, data FROM jobs WHERE id = ?")
        .bind(jobId)
        .first();
      return respond(
        200,
        await buildStatusBody(
          db,
          freshRow ? JSON.parse(freshRow.data) : existing,
          nowMs
        )
      );
    }
    // intent-recorded + complete scene set, original attempt dead:
    // recovery path 1 — re-submit with the identical idempotency keys
    // (Rev 3.2 §B-3.2.2.2).
    const retryExecutions = planIndexesFromJob(existing).map((idx) => ({
      sceneIndex: idx,
      attempt: 1,
      executionId: jobId + ":scene-" + idx + ":attempt-1"
    }));
    const out = await attemptDispatch(env, existing, retryExecutions, nowMs);
    return respond(out.status, out.body, out.extraHeaders);
  }

  // changes = 0 and no row: a limit fired. Diagnostic read only — the
  // outcome (a refusal either way) rests on statement 1 alone.
  const retained = await countRetainedRows(db);
  if (retained + 1 + normalized.scenes.length > PHASE3_RETENTION_CEILING_ROWS) {
    console.error(
      "[NOVA] retention-backlog refusal jobId=" + jobId +
        " retained=" + retained
    );
    return respond(503, {
      jobId,
      error: "retention-backlog",
      message:
        "NOVA cannot accept new generations right now. Please try again later.",
      retryAfterSeconds: 120
    });
  }
  const activeRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM jobs
       WHERE json_extract(data, '$.accessTokenHash') = ?
         AND json_extract(data, '$.status')
             NOT IN ('succeeded','failed','timed-out','cancelled','expired')`
    )
    .bind(tokenHash)
    .first();
  if (activeRow && Number(activeRow.c) >= PHASE3_ACTIVE_JOB_CAP) {
    return respond(
      429,
      {
        jobId,
        status: "failed",
        message: "Too many active jobs for this token. Please try again later."
      },
      { "Retry-After": "60" }
    );
  }
  return respond(500, {
    jobId,
    status: "failed",
    message: "NOVA could not save the production job. Please try again."
  });
}

// --------------------------------------------------- POST /api/retry
// Rev 3 §C-1.5 + Rev 3.2 §B-3.2.5/§B-3.2.8: retry one failed/timed-out
// scene as a NEW attempt (new execution ID, old attempt untouched).
// Preconditions in order: job exists (404); token (401); scene exists
// (404); latest attempt terminal failed/timed-out (400); no active attempt
// (409); parent not expired (410), not cancelled (400). A retry counts
// toward the per-IP generation limit and the per-token active-job cap.

async function handleRetry(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN, X-NOVA-TEST-KEY",
    "POST, OPTIONS"
  );
  const respond = (status, data, extra) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, ...(extra || {}) }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return respond(405, {
      status: "failed",
      message: "Only POST requests are allowed."
    });
  }

  const raw = await readRawBody(request);
  if (raw.error) {
    return respond(raw.error.status, {
      status: "failed",
      message: raw.error.message
    });
  }
  let parsed;
  try {
    parsed = parseStrictJson(raw.text);
  } catch {
    return respond(400, { status: "failed", message: "Invalid JSON request." });
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respond(400, { status: "failed", message: "Invalid retry request." });
  }
  const jobId = body.jobId;
  if (!validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }
  if (
    !isStrictInteger(parsed, "sceneIndex", body.sceneIndex) ||
    body.sceneIndex < 0 ||
    body.sceneIndex > 19
  ) {
    return respond(400, {
      jobId,
      status: "failed",
      message: "A valid scene index is required."
    });
  }
  const sceneIndex = body.sceneIndex;

  const token = request.headers.get("X-NOVA-JOB-TOKEN") || "";
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return respond(400, {
      jobId,
      status: "failed",
      message: "A valid 64-character NOVA job access token is required."
    });
  }

  const gate = controlledTestGate(request, env);
  if (gate) {
    return respond(gate.status, { jobId, status: "failed", ...gate.body });
  }

  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not save the production job. Please try again."
    });
  }
  const nowMs = Date.now();

  const ipKey = await ipRateKey(env, request, "gen");
  const rl = await rateLimitCheck(
    db,
    ipKey,
    3600000,
    PHASE3_GEN_LIMIT_PER_HOUR,
    nowMs
  );
  if (!rl.allowed) {
    return respond(
      429,
      {
        jobId,
        status: "failed",
        message: "Rate limit exceeded. Please try again later."
      },
      { "Retry-After": String(rl.retryAfter) }
    );
  }

  if (!apiOrigin(env) || !env.NOVA_API_SECRET) {
    console.error("[NOVA] retry: API process origin not configured.");
    return respond(503, { jobId, ...capacityUnavailableBody() });
  }

  const jobRow = await db
    .prepare("SELECT id, data FROM jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (!jobRow) {
    return respond(404, {
      jobId,
      status: "not_found",
      message: "NOVA could not find this production job."
    });
  }
  const job = JSON.parse(jobRow.data);
  if (!(await tokenMatches(token, job.accessTokenHash))) {
    return respond(401, {
      jobId,
      status: "failed",
      message: "A valid NOVA job access token is required."
    });
  }
  if (!planIndexesFromJob(job).includes(sceneIndex)) {
    return respond(404, {
      jobId,
      status: "not_found",
      message: "NOVA could not find this scene."
    });
  }
  const sceneRows = await db
    .prepare(
      `SELECT scene_index, attempt, status FROM scenes
       WHERE job_id = ? AND scene_index = ? ORDER BY attempt ASC`
    )
    .bind(jobId, sceneIndex)
    .all();
  const rows = (sceneRows && sceneRows.results) || [];
  if (rows.length === 0) {
    return respond(404, {
      jobId,
      status: "not_found",
      message: "NOVA could not find this scene."
    });
  }
  const latest = rows[rows.length - 1];
  // Rev 3 §C-1.5 lists the preconditions in order, but the two state
  // checks overlap when the latest attempt is in flight, and the 409's own
  // message names what it guards: "a RETRY is already in flight for this
  // scene". A queued/dispatched/running latest attempt is a retry in
  // flight only when it IS a retry (attempt > 1) — that is the
  // simultaneous-retry case, and reading it this way makes the §C-1.5
  // acceptance test deterministic ("two simultaneous retries ... exactly
  // one succeeds (202) and the other receives 409"): whichever request
  // reads second sees the winner's in-flight retry attempt and gets 409.
  // A queued ORIGINAL attempt (attempt 1, never failed) is not a retry
  // in flight — the scene is simply not retryable, and the first check
  // (latest attempt failed/timed-out, else 400) answers it. A succeeded
  // latest attempt likewise falls through to the 400.
  if (
    ["queued", "dispatched", "running"].includes(latest.status) &&
    latest.attempt > 1
  ) {
    return respond(409, {
      jobId,
      status: "failed",
      message: "A retry is already in flight for this scene."
    });
  }
  if (latest.status !== "failed" && latest.status !== "timed-out") {
    return respond(400, {
      jobId,
      status: "failed",
      message: "Scene is not in a retryable state."
    });
  }
  if (job.status === "expired") {
    return respond(410, {
      jobId,
      status: "failed",
      message: "This video expired after 24 hours."
    });
  }
  if (job.status === "cancelled") {
    return respond(400, {
      jobId,
      status: "failed",
      message: "Job is cancelled."
    });
  }

  // The retry counts as a new active job for the per-token cap (§C-1.5):
  // active jobs for this token excluding this job must be below the cap.
  const tokenHash = await sha256Hex(token);
  const activeRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM jobs
       WHERE json_extract(data, '$.accessTokenHash') = ?
         AND id != ?
         AND json_extract(data, '$.status')
             NOT IN ('succeeded','failed','timed-out','cancelled','expired')`
    )
    .bind(tokenHash, jobId)
    .first();
  if (activeRow && Number(activeRow.c) >= PHASE3_ACTIVE_JOB_CAP) {
    return respond(
      429,
      {
        jobId,
        status: "failed",
        message: "Too many active jobs for this token. Please try again later."
      },
      { "Retry-After": "60" }
    );
  }

  const attempt = latest.attempt + 1;
  const executionId = jobId + ":scene-" + sceneIndex + ":attempt-" + attempt;
  let results;
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
                              status, error, output_ref, expires_at, updated_at)
           SELECT ?, ?, ?, ?, NULL, 'queued', NULL, NULL, NULL, ?
           WHERE NOT EXISTS (SELECT 1 FROM scenes
                             WHERE job_id = ? AND scene_index = ? AND attempt = ?)
             AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) < 100000`
        )
        .bind(
          jobId, sceneIndex, attempt, executionId, nowMs,
          jobId, sceneIndex, attempt
        ),
      db.prepare(AGGREGATE_RECOMPUTE_SQL).bind(jobId, jobId, jobId)
    ]);
  } catch (e) {
    console.error("[NOVA] retry insert failed:", e && e.message);
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not save the production job. Please try again."
    });
  }
  const inserted =
    results && results[0] && results[0].meta ? results[0].meta.changes : 0;
  if (inserted !== 1) {
    // Either the attempt row already exists (a concurrent retry won) or
    // the ceiling refused it. Disambiguate by reading the row.
    const existing = await db
      .prepare(
        "SELECT execution_id FROM scenes WHERE job_id = ? AND scene_index = ? AND attempt = ?"
      )
      .bind(jobId, sceneIndex, attempt)
      .first();
    if (existing) {
      return respond(409, {
        jobId,
        status: "failed",
        message: "A retry is already in flight for this scene."
      });
    }
    const retained = await countRetainedRows(db);
    if (retained >= PHASE3_RETENTION_CEILING_ROWS) {
      console.error(
        "[NOVA] retention-backlog refusal on retry jobId=" + jobId +
          " retained=" + retained
      );
      return respond(503, {
        jobId,
        error: "retention-backlog",
        message:
          "NOVA cannot accept new generations right now. Please try again later.",
        retryAfterSeconds: 120
      });
    }
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not save the production job. Please try again."
    });
  }

  // Dispatch the new attempt. The retry 202 gains dispatchState (§B-3.2.8).
  const execution = { sceneIndex, attempt, executionId };
  const out = await attemptDispatch(
    env,
    job,
    [execution],
    nowMs
  );
  if (out.status === 202) {
    return respond(202, {
      jobId,
      sceneIndex,
      attempt,
      executionId,
      status: "queued",
      dispatchState: out.body.dispatchState || "slot-claimed"
    });
  }
  return respond(out.status, out.body, out.extraHeaders);
}

// -------------------------------------------------- GET /api/status
// Rev 2 §4.2: conditional requests via ETag (updatedAt); 304 on match.
// Per-IP poll limit 60/minute (Rev 2 §14.1).

async function handlePhase3Status(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN",
    "GET, OPTIONS"
  );
  const respond = (status, data, extra) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, ...(extra || {}) }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }

  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not retrieve the production job."
    });
  }
  const nowMs = Date.now();
  const ipKey = await ipRateKey(env, request, "poll");
  const rl = await rateLimitCheck(
    db,
    ipKey,
    60000,
    PHASE3_POLL_LIMIT_PER_MIN,
    nowMs
  );
  if (!rl.allowed) {
    return respond(
      429,
      {
        jobId,
        status: "failed",
        message: "Rate limit exceeded. Please try again later."
      },
      { "Retry-After": String(rl.retryAfter) }
    );
  }

  const row = await db
    .prepare("SELECT id, data FROM jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (!row) {
    return respond(404, {
      jobId,
      status: "not_found",
      message: "NOVA could not find this production job."
    });
  }
  const job = JSON.parse(row.data);
  const token = request.headers.get("X-NOVA-JOB-TOKEN") || "";
  if (!(await tokenMatches(token, job.accessTokenHash))) {
    return respond(401, {
      jobId,
      status: "unauthorized",
      message: "A valid NOVA job access token is required."
    });
  }

  const etag = '"' + (job.updatedAt || job.createdAt || "") + '"';
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const body = await buildStatusBody(db, job, nowMs);
  return respond(200, body, { ETag: etag });
}

// ------------------------------------------------ GET /api/download
// Rev 2 §4.2: access-expiry check runs BEFORE any byte is served (§9.1).
// Expired -> 410, no API call, no bytes. The Worker redeems the delivery
// ref through the API process and streams the response through; it never
// buffers the whole file. Idle timeout 30 s with no bytes received (§3.5).

async function handleDownload(request, env) {
  const headers = {
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  const respond = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, "Content-Type": "application/json" }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }
  const sceneParam = url.searchParams.get("scene") || "0";
  if (!/^(0|[1-9][0-9]*)$/.test(sceneParam)) {
    return respond(400, {
      jobId,
      status: "failed",
      message: "A valid scene index is required."
    });
  }
  const sceneIndex = Number(sceneParam);
  if (sceneIndex < 0 || sceneIndex > 19) {
    return respond(400, {
      jobId,
      status: "failed",
      message: "A valid scene index is required."
    });
  }

  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not retrieve the production job."
    });
  }
  const nowMs = Date.now();
  const jobRow = await db
    .prepare("SELECT id, data FROM jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (!jobRow) {
    return respond(404, {
      jobId,
      status: "not_found",
      message: "NOVA could not find this production job."
    });
  }
  const job = JSON.parse(jobRow.data);
  const token = request.headers.get("X-NOVA-JOB-TOKEN") || "";
  if (!(await tokenMatches(token, job.accessTokenHash))) {
    return respond(401, {
      jobId,
      status: "unauthorized",
      message: "A valid NOVA job access token is required."
    });
  }
  const sceneRow = await db
    .prepare(
      `SELECT scene_index, attempt, execution_id, status, error, output_ref, expires_at
       FROM scenes WHERE job_id = ? AND scene_index = ? ORDER BY attempt DESC LIMIT 1`
    )
    .bind(jobId, sceneIndex)
    .first();
  if (!sceneRow) {
    return respond(404, {
      jobId,
      status: "failed",
      message: "NOVA could not find output for this scene."
    });
  }
  // Access expiry first: never served after expiry, even if the object
  // still physically exists (§9.1).
  if (
    job.status === "expired" ||
    (sceneRow.expires_at !== null &&
      sceneRow.expires_at !== undefined &&
      sceneRow.expires_at <= nowMs)
  ) {
    return respond(410, {
      jobId,
      status: "failed",
      message: "This video expired after 24 hours."
    });
  }
  if (sceneRow.status !== "succeeded" || !sceneRow.output_ref) {
    return respond(404, {
      jobId,
      status: "failed",
      message: "NOVA could not find output for this scene."
    });
  }

  const apiBase = apiOrigin(env);
  const secret = env.NOVA_API_SECRET;
  if (!apiBase || !secret) {
    console.error("[NOVA] download: API process origin not configured.");
    return respond(503, {
      jobId,
      status: "failed",
      message: "Download is temporarily unavailable."
    });
  }
  const apiPath =
    "/internal/download?jobId=" +
    encodeURIComponent(jobId) +
    "&executionId=" +
    encodeURIComponent(sceneRow.execution_id);
  const controller = new AbortController();
  let upstream;
  try {
    upstream = await fetch(apiBase + apiPath, {
      method: "GET",
      headers: await signApiCall(secret, "GET", apiPath, ""),
      signal: controller.signal
    });
  } catch (e) {
    console.error("[NOVA] download fetch failed:", e && e.name);
    return respond(502, {
      jobId,
      status: "failed",
      message: "Download is temporarily unavailable."
    });
  }
  if (upstream.status === 404) {
    return respond(404, {
      jobId,
      status: "failed",
      message: "NOVA could not find output for this scene."
    });
  }
  if (upstream.status === 410) {
    return respond(410, {
      jobId,
      status: "failed",
      message: "This video expired after 24 hours."
    });
  }
  if (upstream.status === 401) {
    console.error("[NOVA] download: API process rejected the Worker secret (401).");
    return respond(500, {
      jobId,
      status: "failed",
      message: "Service unavailable. Please try again."
    });
  }
  if (!upstream.ok || !upstream.body) {
    return respond(502, {
      jobId,
      status: "failed",
      message: "Download is temporarily unavailable."
    });
  }

  // Stream through with a 30 s idle timeout: the timer resets on every
  // chunk received, so a slow-but-moving 50 MB stream is not cut off.
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(),
      PHASE3_DOWNLOAD_IDLE_TIMEOUT_MS
    );
  };
  armIdle();
  const stream = new ReadableStream({
    async start(c) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          c.enqueue(value);
        }
        c.close();
      } catch (e) {
        c.error(e);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },
    cancel() {
      controller.abort();
      if (idleTimer) clearTimeout(idleTimer);
    }
  });
  const outHeaders = {
    ...headers,
    "Content-Type": "video/mp4",
    "Content-Disposition":
      'attachment; filename="nova-' + jobId + "-scene-" + sceneIndex + '.mp4"'
  };
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) outHeaders["Content-Length"] = contentLength;
  return new Response(stream, { status: 200, headers: outHeaders });
}

// ------------------------------------------------ GET /api/capacity
// Rev 2 §4.2/§6.4 + Rev 3 §C-1.4: public, unauthenticated, rate-limited.
// In production, available is false with reason "no-production-capacity"
// until production capacity is authorised. In controlled-test mode the
// response is available: true ONLY with mode: "controlled-test" — never
// available: true without it. The badge shows "Controlled test", never
// "Available". No live capacity probe exists on the Worker side: the
// design assigns capacity reporting to the API process's worker registry
// (§6.1) but defines no Worker->API capacity endpoint, so the Worker
// answers from its configured deployment mode (see impl notes).

async function handleCapacity(request, env) {
  const headers = corsHeaders(request, "Content-Type", "GET, OPTIONS");
  const respond = (status, data, extra) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, ...(extra || {}) }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const db = env.NOVA_DB;
  const nowMs = Date.now();
  let queueDepth = 0;
  if (db) {
    const ipKey = await ipRateKey(env, request, "cap");
    const rl = await rateLimitCheck(
      db,
      ipKey,
      60000,
      PHASE3_POLL_LIMIT_PER_MIN,
      nowMs
    );
    if (!rl.allowed) {
      return respond(
        429,
        {
          status: "failed",
          message: "Rate limit exceeded. Please try again later."
        },
        { "Retry-After": String(rl.retryAfter) }
      );
    }
    try {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM jobs
           WHERE json_extract(data, '$.status')
               NOT IN ('succeeded','partial_failed','failed','cancelled','expired')`
        )
        .first();
      queueDepth = row ? Number(row.c) || 0 : 0;
    } catch {
      queueDepth = 0;
    }
  }

  if (phase3ApiMode(env) === "controlled-test") {
    return respond(200, {
      engine: "ltx-video-2b",
      available: true,
      mode: "controlled-test",
      reason: "controlled-test-only",
      queueDepth,
      message: "Controlled test only — this is not public generation capacity."
    });
  }
  return respond(200, {
    engine: "ltx-video-2b",
    available: false,
    reason: "no-production-capacity",
    queueDepth,
    message: "No production generation capacity is authorised yet."
  });
}

// ------------------------------------------- GET /api/export/jobs
// MINIMAL route — NO design spec exists for it anywhere in the approved
// design set. Rev 2 names no export endpoint in §4.2, and Rev 3.2
// §A-3.1.6.2 / the reviewer package list it only as one of the "three
// authorised new routes" for the route inventory — no auth, shape, or
// pagination is specified. This is therefore the minimal version the
// T31-ROUTES test expects (route exists, token-scoped listing), and it
// is documented as such here and in the test report; a fuller export
// contract (fields, filters, format) needs a design decision first.
// Contract (minimal, implemented 25 Nov 2026):
// - GET only (other methods -> 405); OPTIONS -> 204.
// - Auth: the caller's 64-hex X-NOVA-JOB-TOKEN is required (400 if
//   missing/malformed, same rule as /api/generate). Only jobs whose
//   stored accessTokenHash matches that token are listed — a caller
//   can never enumerate another caller's jobs. No prompt, scene, or
//   token material is ever returned.
// - Poll rate limit (60/min/IP, same scope as /api/status) -> 429.
// - Pagination: ?limit= (default 50, clamped 1..100), ?offset=
//   (default 0, must be >= 0); invalid values -> 400.
// - Scan bound: at most the 500 most recently created job rows are
//   examined, so the listing cannot scan the whole 100,000-row
//   ceiling on every call. `total` counts matches within that window.
// - Response: 200 { jobs: [{ jobId, status, engine, mode, createdAt,
//   updatedAt }], total, limit, offset }, newest first. Per-scene
//   detail (expiry, download URLs) stays on GET /api/status.
async function handleExportJobs(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN",
    "GET, OPTIONS"
  );
  const respond = (status, data, extra) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, ...(extra || {}) }
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const token = request.headers.get("X-NOVA-JOB-TOKEN") || "";
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return respond(400, {
      status: "failed",
      message: "A valid 64-character NOVA job access token is required."
    });
  }

  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, {
      status: "failed",
      message: "NOVA could not retrieve the production jobs."
    });
  }
  const nowMs = Date.now();
  const ipKey = await ipRateKey(env, request, "poll");
  const rl = await rateLimitCheck(
    db,
    ipKey,
    60000,
    PHASE3_POLL_LIMIT_PER_MIN,
    nowMs
  );
  if (!rl.allowed) {
    return respond(
      429,
      {
        status: "failed",
        message: "Rate limit exceeded. Please try again later."
      },
      { "Retry-After": String(rl.retryAfter) }
    );
  }

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  let limit = 50;
  let offset = 0;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit)) {
      return respond(400, {
        status: "failed",
        message: "limit must be an integer."
      });
    }
    limit = Math.min(100, Math.max(1, limit));
  }
  if (offsetRaw !== null) {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      return respond(400, {
        status: "failed",
        message: "offset must be a non-negative integer."
      });
    }
  }

  const tokenHash = await sha256Hex(token);
  const rows = await db
    .prepare("SELECT id, data FROM jobs ORDER BY rowid DESC LIMIT 500")
    .all();
  const mine = [];
  for (const row of (rows && rows.results) || []) {
    let job;
    try {
      job = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (job.accessTokenHash !== tokenHash) continue;
    mine.push({
      jobId: job.id,
      status: job.status,
      engine: job.engine || "ltx-video-2b",
      mode: job.mode || null,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null
    });
  }
  return respond(200, {
    jobs: mine.slice(offset, offset + limit),
    total: mine.length,
    limit,
    offset
  });
}

// --------------------------------------- POST /internal/d1-apply
// Rev 3 §C-1.1 (Worker-sole-D1-access) + §B-3.2.2 (mark-submitted) +
// Rev 3.4 §C-3.4.2.2 (repair-scene-row): the API process reaches D1 ONLY
// through this endpoint. The body is { requestId, mutations: [...] }.
// Each mutation is one of a FIXED enumerated set; the Worker maps each to
// its own fixed, parameterised SQL. No arbitrary SQL is accepted. The whole
// batch applies as one D1 batch() transaction; the commit point is the
// Worker's successful response. A repeated requestId returns the stored
// outcome without re-applying; mutations are idempotent by construction
// as well, so a double apply could not double-apply state.
// Auth: same HMAC scheme as §11, reverse direction (API signs, Worker
// verifies, §C-1.10 order — nonce consumed only after signature verifies).
// A call without a valid signature is 401 and touches nothing.

const D1_APPLY_SCENE_STATUSES = new Set([
  "queued", "dispatched", "running", "succeeded",
  "failed", "timed-out", "cancelled"
]);

function buildD1ApplyStatements(db, mutations, nowMs) {
  // Returns { stmts, results: [{type}] } or throws { code, message }.
  // Validation runs BEFORE any statement is built, so a bad mutation
  // rejects the whole call with nothing applied.
  const stmts = [];
  const results = [];
  for (const m of mutations) {
    if (!m || typeof m !== "object" || typeof m.type !== "string") {
      const e = new Error("Invalid mutation.");
      e.code = "BAD_MUTATION";
      throw e;
    }
    if (m.type === "scene-update") {
      if (
        !validJobId(m.jobId) ||
        !Number.isInteger(m.sceneIndex) ||
        m.sceneIndex < 0 ||
        m.sceneIndex > 19 ||
        !Number.isInteger(m.attempt) ||
        m.attempt < 1 ||
        !D1_APPLY_SCENE_STATUSES.has(m.status)
      ) {
        const e = new Error("Invalid scene-update mutation.");
        e.code = "BAD_MUTATION";
        throw e;
      }
      stmts.push(
        db
          .prepare(
            `UPDATE scenes
             SET status = ?, error = ?, output_ref = ?, expires_at = ?, updated_at = ?
             WHERE job_id = ? AND scene_index = ? AND attempt = ?
               AND status NOT IN ('succeeded','failed','timed-out','cancelled')`
          )
          .bind(
            m.status,
            m.error !== undefined ? m.error : null,
            m.outputRef !== undefined ? m.outputRef : null,
            m.expiresAt !== undefined ? m.expiresAt : null,
            nowMs,
            m.jobId,
            m.sceneIndex,
            m.attempt
          )
      );
      stmts.push(
        db.prepare(AGGREGATE_RECOMPUTE_SQL).bind(m.jobId, m.jobId, m.jobId)
      );
      results.push({ type: "scene-update" });
    } else if (m.type === "mark-expired") {
      if (
        !validJobId(m.jobId) ||
        !Array.isArray(m.sceneIndexes) ||
        m.sceneIndexes.length === 0 ||
        m.sceneIndexes.some(
          (i) => !Number.isInteger(i) || i < 0 || i > 19
        )
      ) {
        const e = new Error("Invalid mark-expired mutation.");
        e.code = "BAD_MUTATION";
        throw e;
      }
      for (const idx of m.sceneIndexes) {
        stmts.push(
          db
            .prepare(
              `UPDATE scenes SET status = 'expired', output_ref = NULL, updated_at = ?
               WHERE job_id = ? AND scene_index = ? AND status = 'succeeded'`
            )
            .bind(nowMs, m.jobId, idx)
        );
      }
      // Parent becomes expired only when every scene is in a terminal
      // state and at least one scene expired in this batch.
      stmts.push(
        db
          .prepare(
            `UPDATE jobs SET data = json_set(data, '$.status', 'expired', '$.updatedAt', ?)
             WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM scenes WHERE job_id = ?
                 AND status NOT IN ('expired','failed','timed-out','cancelled'))
               AND EXISTS (SELECT 1 FROM scenes WHERE job_id = ? AND status = 'expired')`
          )
          .bind(new Date(nowMs).toISOString(), m.jobId, m.jobId, m.jobId)
      );
      results.push({ type: "mark-expired" });
    } else if (m.type === "delete-rows") {
      // Explicit table + IDs only. Unknown table -> 400, touches nothing.
      // Job/scene record deletion for retention reasons is gated in
      // handleD1Apply (Rev 3.1 §A-3.1.3.2 as amended by the owner decision
      // 25 Nov ~18:21 WAT: retention ENABLED, 30 days): allowed only while
      // enabled with a period set. rate_limits rows (expired windows) are
      // always deletable. Age eligibility of a retained row is the
      // caller's (sweep's) responsibility once retention is enabled.
      const tables = { jobs: "id", scenes: "execution_id", rate_limits: "key" };
      if (
        !Object.prototype.hasOwnProperty.call(tables, m.table) ||
        !Array.isArray(m.ids) ||
        m.ids.length === 0 ||
        m.ids.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        const e = new Error("Invalid delete-rows mutation.");
        e.code = "BAD_MUTATION";
        throw e;
      }
      results.push({ type: "delete-rows" });
      // The retention gate is enforced in handleD1Apply (it needs env),
      // before the batch is submitted; the statement is built here.
      const col = tables[m.table];
      const placeholders = m.ids.map(() => "?").join(",");
      stmts.push(
        db
          .prepare(
            "DELETE FROM " + m.table + " WHERE " + col + " IN (" + placeholders + ")"
          )
          .bind(...m.ids)
      );
    } else if (m.type === "mark-submitted") {
      if (
        !validJobId(m.jobId) ||
        !Array.isArray(m.executions) ||
        m.executions.length === 0 ||
        m.executions.some(
          (x) =>
            !x ||
            !Number.isInteger(x.sceneIndex) ||
            x.sceneIndex < 0 ||
            x.sceneIndex > 19 ||
            !Number.isInteger(x.attempt) ||
            x.attempt < 1 ||
            typeof x.providerJobId !== "string"
        )
      ) {
        const e = new Error("Invalid mark-submitted mutation.");
        e.code = "BAD_MUTATION";
        throw e;
      }
      stmts.push(
        db
          .prepare(
            "UPDATE jobs SET data = json_set(data, '$.dispatchState', 'submitted') WHERE id = ? AND json_extract(data, '$.dispatchState') = 'intent-recorded'"
          )
          .bind(m.jobId)
      );
      for (const x of m.executions) {
        stmts.push(
          db
            .prepare(
              "UPDATE scenes SET provider_job_id = ? WHERE job_id = ? AND scene_index = ? AND attempt = ? AND provider_job_id IS NULL"
            )
            .bind(x.providerJobId, m.jobId, x.sceneIndex, x.attempt)
        );
      }
      results.push({ type: "mark-submitted" });
    } else if (m.type === "repair-scene-row") {
      // Rev 3.4 §C-3.4.2.2: exactly one initial scene row (attempt 1),
      // guarded by the accepted single-row ceiling condition
      // (retained + 1 <= 100000). NOT EXISTS makes it idempotent.
      if (
        !validJobId(m.jobId) ||
        !Number.isInteger(m.sceneIndex) ||
        m.sceneIndex < 0 ||
        m.sceneIndex > 19
      ) {
        const e = new Error("Invalid repair-scene-row mutation.");
        e.code = "BAD_MUTATION";
        throw e;
      }
      const executionId = m.jobId + ":scene-" + m.sceneIndex + ":attempt-1";
      stmts.push(
        db
          .prepare(
            `INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id,
                                status, error, output_ref, expires_at, updated_at)
             SELECT ?, ?, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?
             WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?)
               AND NOT EXISTS (SELECT 1 FROM scenes
                               WHERE job_id = ? AND scene_index = ? AND attempt = 1)
               AND (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) < 100000`
          )
          .bind(
            m.jobId,
            m.sceneIndex,
            executionId,
            nowMs,
            m.jobId,
            m.jobId,
            m.sceneIndex
          )
      );
      results.push({ type: "repair-scene-row" });
    } else {
      const e = new Error("Unknown mutation type: " + m.type + ".");
      e.code = "BAD_MUTATION";
      throw e;
    }
  }
  return { stmts, results };
}

async function handleD1Apply(request, env) {
  const headers = corsHeaders(request, "Content-Type", "POST, OPTIONS");
  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return respond(405, { error: "Only POST requests are allowed." });
  }
  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, { error: "service unavailable" });
  }

  const raw = await readRawBody(request);
  if (raw.error) {
    return respond(raw.error.status, { error: "unauthorised" });
  }
  // Verification order §C-1.10: signature first (steps 1–5), body
  // parsing/validation only after (step 6). A failure returns 401 with
  // { error: "unauthorised" } and no further detail.
  const auth = await verifyInternalAuth(request, env, raw.text);
  if (!auth.ok) {
    console.error("[NOVA] /internal/d1-apply rejected at step " + auth.step);
    return respond(401, { error: "unauthorised" });
  }

  let parsed;
  try {
    parsed = parseStrictJson(raw.text);
  } catch {
    return respond(400, { error: "Invalid JSON request." });
  }
  const body = parsed.value;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.requestId !== "string" ||
    body.requestId.length === 0 ||
    !Array.isArray(body.mutations) ||
    body.mutations.length === 0 ||
    body.mutations.length > 25
  ) {
    return respond(400, { error: "Invalid d1-apply request." });
  }

  // Idempotency: a repeated requestId returns the stored outcome.
  const prior = await db
    .prepare("SELECT result_json FROM d1_apply_requests WHERE request_id = ?")
    .bind(body.requestId)
    .first();
  if (prior) {
    return respond(200, JSON.parse(prior.result_json));
  }

  // Retention gate for delete-rows on jobs/scenes (Rev 3.1 §A-3.1.3.2 as
  // amended by the owner decision 25 Nov ~18:21 WAT: retention ENABLED,
  // 30 days). Deletion is allowed only while enabled AND a period is set;
  // otherwise no job/scene row is deleted.
  for (const m of body.mutations) {
    if (
      m &&
      m.type === "delete-rows" &&
      (m.table === "jobs" || m.table === "scenes") &&
      (!phase3RetentionEnabled(env) || phase3RetentionDays(env) === null)
    ) {
      return respond(403, {
        error: "retention-deletion-disabled",
        message: !phase3RetentionEnabled(env)
          ? "Job record retention is disabled; job/scene records are not deleted."
          : "Job record retention period is unset; job/scene records are not deleted."
      });
    }
  }

  const nowMs = Date.now();
  let built;
  try {
    built = buildD1ApplyStatements(db, body.mutations, nowMs);
  } catch (e) {
    if (e && e.code === "BAD_MUTATION") {
      return respond(400, { error: e.message });
    }
    throw e;
  }

  let batchResults;
  try {
    batchResults = await db.batch(built.stmts);
  } catch (e) {
    console.error("[NOVA] /internal/d1-apply batch failed:", e && e.message);
    return respond(500, { error: "d1-apply failed" });
  }
  // Per-mutation outcomes: changes of the mutation's first statement.
  // (A scene-update contributes two statements; its outcome is the
  // first statement's change count.)
  const outcomes = [];
  let stmtIdx = 0;
  for (const m of body.mutations) {
    const first = batchResults[stmtIdx];
    outcomes.push({
      type: m.type,
      changes:
        first && first.meta && typeof first.meta.changes === "number"
          ? first.meta.changes
          : null
    });
    stmtIdx +=
      m.type === "scene-update"
        ? 2
        : m.type === "mark-expired"
          ? m.sceneIndexes.length + 1
          : m.type === "mark-submitted"
            ? 1 + m.executions.length
            : 1;
  }
  const result = { requestId: body.requestId, results: outcomes };
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO d1_apply_requests (request_id, result_json, created_at) VALUES (?, ?, ?)"
      )
      .bind(body.requestId, JSON.stringify(result), nowMs)
      .run();
  } catch {
    // The mutations already committed; the replay record is best-effort.
  }
  return respond(200, result);
}

// ----------------------------------------- GET /internal/d1-read
// Rev 3 §C-1.1: fixed, named read operations only. No arbitrary SQL.
// Auth: same HMAC verification as /internal/d1-apply (GET, empty body).
// Ops: get-job, list-scenes, list-expired-scenes, list-pending-jobs
// (§C-1.1) + list-terminal-jobs and list-expired-rate-limits (additions
// 25 Nov ~18:21+ WAT closing the retention-enumeration design gap —
// impl notes §10.4).

async function handleD1Read(request, env) {
  const headers = corsHeaders(request, "Content-Type", "GET, OPTIONS");
  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return respond(405, { error: "Only GET requests are allowed." });
  }
  const db = env.NOVA_DB;
  if (!db) {
    return respond(500, { error: "service unavailable" });
  }

  const auth = await verifyInternalAuth(request, env, "");
  if (!auth.ok) {
    console.error("[NOVA] /internal/d1-read rejected at step " + auth.step);
    return respond(401, { error: "unauthorised" });
  }

  const url = new URL(request.url);
  const op = url.searchParams.get("op");
  const jobId = url.searchParams.get("jobId");
  const nowMs = Date.now();

  if (op === "get-job") {
    if (!validJobId(jobId)) {
      return respond(400, { error: "A valid NOVA job ID is required." });
    }
    const row = await db
      .prepare("SELECT id, data FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    return respond(200, { op, job: row || null });
  }
  if (op === "list-scenes") {
    if (!validJobId(jobId)) {
      return respond(400, { error: "A valid NOVA job ID is required." });
    }
    const rows = await db
      .prepare(
        `SELECT job_id, scene_index, attempt, execution_id, provider_job_id,
                status, error, output_ref, expires_at, updated_at
         FROM scenes WHERE job_id = ? ORDER BY scene_index ASC, attempt ASC`
      )
      .bind(jobId)
      .all();
    return respond(200, { op, scenes: (rows && rows.results) || [] });
  }
  if (op === "list-expired-scenes") {
    const rows = await db
      .prepare(
        `SELECT job_id, scene_index, attempt, execution_id, provider_job_id,
                status, error, output_ref, expires_at, updated_at
         FROM scenes WHERE status = 'succeeded'
           AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY expires_at ASC LIMIT 500`
      )
      .bind(nowMs)
      .all();
    return respond(200, { op, scenes: (rows && rows.results) || [] });
  }
  if (op === "list-pending-jobs") {
    const rows = await db
      .prepare(
        `SELECT id, data FROM jobs
         WHERE json_extract(data, '$.status')
           NOT IN ('succeeded','partial_failed','failed','cancelled','expired')
         ORDER BY id ASC LIMIT 100`
      )
      .all();
    return respond(200, { op, jobs: (rows && rows.results) || [] });
  }
  if (op === "list-terminal-jobs") {
    // Retention enumeration (ADDITION 25 Nov ~18:21+ WAT — design gap,
    // see impl notes §10.4). The design's §C-1.1 inventory has no op
    // listing terminal jobs, so the API sweep could only delete jobs it
    // had itself observed reaching terminal. Returns terminal jobs,
    // oldest-terminal-first, bounded. Only id/status/terminalAtMs are
    // returned (never the full data blob — a list op must not bulk-expose
    // prompts). terminalAtMs is MAX(scenes.updated_at), the same
    // terminal-age measure the Worker's own scheduled() sweep uses
    // (§10.1); null for a terminal job with no scene rows (the caller
    // falls back to a get-job read). Optional beforeMs bounds the scan
    // (the sweep passes now - retentionMs for the eligible set; with
    // beforeMs, null-terminalAtMs rows are excluded). Optional limit
    // (default 100, clamped 1..500).
    const limitRaw = url.searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return respond(400, { error: "Invalid limit." });
      }
      limit = n;
    }
    const beforeRaw = url.searchParams.get("beforeMs");
    let beforeMs = null;
    if (beforeRaw !== null) {
      const n = Number(beforeRaw);
      if (!Number.isInteger(n) || n < 0) {
        return respond(400, { error: "Invalid beforeMs." });
      }
      beforeMs = n;
    }
    const terminalList = [...PARENT_TERMINAL].map((s) => "'" + s + "'").join(",");
    const baseSql =
      `SELECT j.id AS id, json_extract(j.data, '$.status') AS status,
              MAX(s.updated_at) AS terminal_at_ms
       FROM jobs j LEFT JOIN scenes s ON s.job_id = j.id
       WHERE json_extract(j.data, '$.status') IN (${terminalList})
       GROUP BY j.id`;
    const rows =
      beforeMs === null
        ? await db
            .prepare(
              baseSql +
                ` ORDER BY (terminal_at_ms IS NULL), terminal_at_ms ASC LIMIT ?`
            )
            .bind(limit)
            .all()
        : await db
            .prepare(
              baseSql +
                ` HAVING MAX(s.updated_at) < ? ORDER BY terminal_at_ms ASC LIMIT ?`
            )
            .bind(beforeMs, limit)
            .all();
    const jobs = ((rows && rows.results) || []).map((r) => ({
      id: r.id,
      status: r.status,
      terminalAtMs:
        r.terminal_at_ms === null || r.terminal_at_ms === undefined
          ? null
          : Number(r.terminal_at_ms)
    }));
    return respond(200, { op, jobs });
  }
  if (op === "list-expired-rate-limits") {
    // Rate-limit cleanup enumeration (ADDITION 25 Nov ~18:21+ WAT —
    // design gap, see impl notes §10.4). §14.3/§15 provide for expired
    // rate-limit rows to be deleted by cleanup, and §C-1.1 delete-rows
    // already allows the rate_limits table, but no d1-read op enumerates
    // the expired rows, so the API sweep's rateLimitRowsDeleted stayed 0.
    // Returns expired rows (window_end <= now), oldest expiry first,
    // bounded. Optional limit (default 100, clamped 1..500).
    const limitRaw = url.searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return respond(400, { error: "Invalid limit." });
      }
      limit = n;
    }
    const rows = await db
      .prepare(
        `SELECT key, window_start, window_end, count, updated_at
         FROM rate_limits WHERE window_end <= ?
         ORDER BY window_end ASC LIMIT ?`
      )
      .bind(nowMs, limit)
      .all();
    return respond(200, { op, rateLimits: (rows && rows.results) || [] });
  }
  return respond(400, { error: "Unknown read operation." });
}

// --------------------------------------- POST /internal/reconcile
// GitHub Actions scheduler route (25 Nov 2026): Pages Functions have no
// cron triggers, so the 15-minute reconciliation cannot be driven by a
// cron trigger on this deployment. A GitHub Actions workflow
// (.github/workflows/retention-reconcile.yml) POSTs here every 15
// minutes instead. Auth: shared secret CRON_SECRET (a Pages production
// env var), compared in constant time against the `Authorization:
// Bearer <secret>` header. Fail closed: secret unset -> 503, wrong or
// missing secret -> 401, no D1 binding -> 500. The request body is
// ignored. No CORS headers are set — no browser ever calls this
// endpoint; curl does not need CORS. Runs the SAME handleScheduled()
// reconciliation as scheduled() and returns its summary as JSON, so a
// failed run is visible in the workflow log and the operator can verify
// each run's counts.

function secretsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  let diff = ae.length ^ be.length;
  const n = Math.max(ae.length, be.length);
  for (let i = 0; i < n; i++) {
    diff |= (ae[i] || 0) ^ (be[i] || 0);
  }
  return diff === 0;
}

async function handleReconcile(request, env) {
  const headers = {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff"
  };
  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });
  if (request.method !== "POST") {
    return respond(405, { error: "Only POST requests are allowed." });
  }
  const configured = env.CRON_SECRET;
  if (typeof configured !== "string" || configured.length === 0) {
    return respond(503, { error: "cron_secret_unset" });
  }
  const auth = request.headers.get("Authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secretsEqual(presented, configured)) {
    console.error("[NOVA] /internal/reconcile rejected: bad or missing secret");
    return respond(401, { error: "unauthorised" });
  }
  if (!env.NOVA_DB) {
    return respond(500, { error: "service unavailable" });
  }
  const summary = await handleScheduled(null, env);
  return respond(200, summary);
}

// ------------------------------------------------- scheduled()
// The 15-minute reconciliation timer, D1 side (Rev 3.2 §B-3.2.7, Rev 3.5
// §C-3.5.1.2), plus the 24-hour escalation. The Worker can only do the
// D1-side items: completeness flagging (per-index attempt-1), retention
// measurement + alert, retention deletion of eligible job/scene rows
// (only while retention is enabled with a period set — owner decision
// 25 Nov ~18:21 WAT, 30 days), and escalation logging. Executor-state
// reconciliation (getExecutionState, reservation release, dispatch
// recovery) is the API process's timer — it owns the executor, the
// dispatch journal, and storage. The Worker NEVER marks scenes expired:
// mark-expired follows storage deletion (§B-3.2.9), which only the API
// process can confirm.

async function handleScheduled(event, env) {
  const db = env.NOVA_DB;
  // Summary returned to the caller (the GitHub Actions endpoint reports
  // it as JSON; the scheduled() wrapper ignores it). Counts are
  // best-effort: per-row failures are logged at the call site, while
  // `errors` counts only the step-level failures that abort a whole step.
  const summary = {
    ok: true,
    retainedRows: null,
    retainedBytes: null,
    retentionBacklogAlert: false,
    retentionDeletion: {
      enabled: phase3RetentionEnabled(env),
      days: phase3RetentionDays(env),
      deletedJobs: 0,
      deletedScenes: 0
    },
    jobsChecked: 0,
    incompleteFlagged: 0,
    escalated: 0,
    errors: 0
  };
  if (!db) return { ...summary, ok: false, error: "no_database" };
  const nowMs = Date.now();

  // 1. Retention measurement + alert (Rev 3.1 §A-3.1.4.2, Rev 3.2 §B-3.2.6).
  try {
    const m = await measureRetention(db);
    summary.retainedRows = m.retainedRows;
    summary.retainedBytes = m.retainedBytes;
    console.log(
      "[NOVA scheduled] retained rows=" + m.retainedRows +
        " bytes=" + m.retainedBytes + " (logical UTF-8 payload)"
    );
    if (
      m.retainedRows >= PHASE3_RETENTION_ALERT_ROWS ||
      m.retainedBytes >= PHASE3_RETENTION_ALERT_BYTES
    ) {
      summary.retentionBacklogAlert = true;
      console.log(
        "[NOVA scheduled] retention-backlog-alert rows=" + m.retainedRows +
          " bytes=" + m.retainedBytes
      );
    }
    if (!phase3RetentionEnabled(env)) {
      console.log(
        "[NOVA scheduled] retention-deletion: disabled (unconfirmed)"
      );
    } else if (phase3RetentionDays(env) === null) {
      console.log(
        "[NOVA scheduled] retention-deletion: enabled but no retention period set (job_record_retention_days unset)"
      );
    }
  } catch (e) {
    console.error("[NOVA scheduled] retention measurement failed:", e && e.message);
    summary.errors++;
  }

  // 1b. Retention deletion (owner decision 25 Nov ~18:21 WAT: Q3 APPROVED,
  // job_record_retention_enabled = true, job_record_retention_days = 30;
  // Rev 3.1 §A-3.1.3.2 as amended by that decision). A job/scene record is
  // eligible only once its parent job's terminal state is MORE than N days
  // old. Terminal age is measured from MAX(scenes.updated_at) — the last
  // scene transition, hence the parent's terminal-transition time.
  // (jobs.data $.updatedAt is NOT used for jobs WITH scenes: the Phase 3
  // SQL paths do not maintain it on status transitions, so it can predate
  // the terminal state by days.) Order: oldest first. Per job, scene rows
  // first, the parent job row LAST — the D1 analogue of the §B-3.2.9
  // journal order (refs -> chunks -> index-last): the parent row
  // is the index of the job's existence, so a crash between the two steps
  // leaves the job discoverable for resume by the next sweep (its scenes
  // delete is then a no-op). A terminal job with NO scene rows is deleted
  // on a fallback age — jobs.data $.updatedAt — because in production a
  // job with no scenes can only exist after an interrupted two-step
  // deletion (creation is atomic: parent + scenes together), and leaving
  // it would orphan the parent forever, against the §B-3.2.9 resume rule.
  // If that fallback timestamp is missing or unparseable, the job is
  // retained (fail closed). The storage-side journal itself (§B-3.2.9)
  // is API-process-owned and is not implemented here.
  // Deletions are D1 rows; the O-23 daily counter lives in the API
  // process (manager store) and counts them from the operator-log
  // figures below.
  if (phase3RetentionEnabled(env) && phase3RetentionDays(env) !== null) {
    const days = phase3RetentionDays(env);
    const cutoffMs = nowMs - days * 24 * 3600 * 1000;
    try {
      const terminalList = [...PARENT_TERMINAL].map((s) => "'" + s + "'").join(",");
      const eligible = await db
        .prepare(
          `SELECT j.id AS id, MAX(s.updated_at) AS last_update
           FROM jobs j JOIN scenes s ON s.job_id = j.id
           WHERE json_extract(j.data, '$.status') IN (${terminalList})
           GROUP BY j.id
           HAVING MAX(s.updated_at) < ?
           ORDER BY MAX(s.updated_at) ASC`
        )
        .bind(cutoffMs)
        .all();
      let deletedJobs = 0;
      let deletedScenes = 0;
      for (const row of (eligible && eligible.results) || []) {
        try {
          const sd = await db
            .prepare("DELETE FROM scenes WHERE job_id = ?")
            .bind(row.id)
            .run();
          const jd = await db
            .prepare("DELETE FROM jobs WHERE id = ?")
            .bind(row.id)
            .run();
          deletedScenes +=
            sd && sd.meta && typeof sd.meta.changes === "number" ? sd.meta.changes : 0;
          deletedJobs +=
            jd && jd.meta && typeof jd.meta.changes === "number" ? jd.meta.changes : 0;
        } catch (e) {
          console.error(
            "[NOVA scheduled] retention deletion failed for " + row.id + ":",
            e && e.message
          );
        }
      }
      // Fallback: terminal jobs with NO scene rows (only reachable via an
      // interrupted two-step deletion — creation is atomic). Age falls back
      // to jobs.data $.updatedAt; missing/unparseable -> retained.
      try {
        const orphans = await db
          .prepare(
            `SELECT id, json_extract(data, '$.updatedAt') AS updated_at
             FROM jobs
             WHERE json_extract(data, '$.status') IN (${terminalList})
               AND NOT EXISTS (SELECT 1 FROM scenes WHERE job_id = jobs.id)`
          )
          .all();
        for (const row of (orphans && orphans.results) || []) {
          const t = Date.parse(row.updated_at || "");
          if (!Number.isFinite(t) || nowMs - t <= days * 24 * 3600 * 1000) continue;
          try {
            const jd = await db
              .prepare("DELETE FROM jobs WHERE id = ?")
              .bind(row.id)
              .run();
            deletedJobs +=
              jd && jd.meta && typeof jd.meta.changes === "number" ? jd.meta.changes : 0;
          } catch (e) {
            console.error(
              "[NOVA scheduled] retention deletion failed for " + row.id + ":",
              e && e.message
            );
          }
        }
      } catch (e) {
        console.error("[NOVA scheduled] retention orphan scan failed:", e && e.message);
      }
      console.log(
        "[NOVA scheduled] retention-deletion: enabled (" + days + " days), deleted " +
          deletedJobs + " job records, " + deletedScenes + " scene rows"
      );
      summary.retentionDeletion.deletedJobs = deletedJobs;
      summary.retentionDeletion.deletedScenes = deletedScenes;
    } catch (e) {
      console.error("[NOVA scheduled] retention deletion failed:", e && e.message);
      summary.errors++;
    }
  }

  // 2. Completeness check for non-terminal jobs + 24h escalation.
  let jobs;
  try {
    const res = await db
      .prepare(
        `SELECT id, data FROM jobs
         WHERE json_extract(data, '$.status')
           NOT IN ('succeeded','partial_failed','failed','cancelled','expired')
         ORDER BY id ASC LIMIT 200`
      )
      .all();
    jobs = (res && res.results) || [];
    summary.jobsChecked = jobs.length;
  } catch (e) {
    console.error("[NOVA scheduled] pending-jobs read failed:", e && e.message);
    summary.errors++;
    return summary;
  }
  for (const row of jobs) {
    let job;
    try {
      job = JSON.parse(row.data);
    } catch {
      continue;
    }
    try {
      const sceneRows = await db
        .prepare("SELECT scene_index, attempt FROM scenes WHERE job_id = ?")
        .bind(row.id)
        .all();
      const missing = findMissingAttempt1Indexes(
        planIndexesFromJob(job),
        (sceneRows && sceneRows.results) || []
      );
      if (missing.length > 0) {
        summary.incompleteFlagged++;
        console.log(
          "[NOVA scheduled] incomplete-scene-set jobId=" + row.id +
            " missing indexes=" + missing.join(",")
        );
        await db
          .prepare(
            "UPDATE jobs SET data = json_set(data, '$.incompleteSceneSet', json(?)) WHERE id = ?"
          )
          .bind(JSON.stringify(missing), row.id)
          .run();
      } else if (job.incompleteSceneSet !== undefined) {
        await db
          .prepare(
            "UPDATE jobs SET data = json_remove(data, '$.incompleteSceneSet') WHERE id = ?"
          )
          .bind(row.id)
          .run();
      }
    } catch (e) {
      console.error(
        "[NOVA scheduled] completeness check failed for " + row.id + ":",
        e && e.message
      );
      summary.errors++;
    }
    // 24-hour escalation (Rev 3.2 §B-3.2.7.2): intent-recorded or
    // reconciliation-needed jobs older than 24h are escalated (visibility
    // only — state and reservations never change on elapsed time alone).
    try {
      const createdAtMs = Number(job.createdAtMs) || 0;
      const needsEscalation =
        createdAtMs > 0 &&
        nowMs - createdAtMs >= 24 * 3600 * 1000 &&
        (job.dispatchState === "intent-recorded" ||
          job.reconciliationNeeded === 1) &&
        job.reconciliationEscalated !== 1;
      if (needsEscalation) {
        summary.escalated++;
        console.log(
          "[NOVA scheduled] reconciliation-escalated jobId=" + row.id +
            " dispatchState=" + job.dispatchState
        );
        await db
          .prepare(
            "UPDATE jobs SET data = json_set(data, '$.reconciliationEscalated', 1) WHERE id = ?"
          )
          .bind(row.id)
          .run();
      }
    } catch (e) {
      console.error(
        "[NOVA scheduled] escalation check failed for " + row.id + ":",
        e && e.message
      );
      summary.errors++;
    }
  }
  return summary;
}

// ------------------------------------------- CSP: nonce injection (HTML)
// Rev 2 §13 + Rev 3 §C-1.9 (Pages workstream inventory, 25 Nov 2026:
// index.html split to 1,652 lines, inline script extracted to
// assets/js/main.js, all 92 inline handlers delegated to data-nova-*
// attributes, all 9 inline style= attributes removed; one <style> block
// per page remains; about.html has no <script> tag at all).
//
// Per-response nonce: a fresh cryptographically random nonce is generated
// for every HTML response, injected into every <script> and <style> tag,
// and set in the CSP header with that same value for scripts and styles.
// DECISION (recorded): the external script is NONCED — 'self' is NOT added
// to script-src. Under `script-src 'nonce-…' 'strict-dynamic'`, host
// sources are ignored by supporting browsers, so adding 'self' would not
// authorise the un-nonced script and would only weaken the policy.
// Cache-Control: no-store is set on EVERY HTML response carrying a nonce
// (Rev 3 §C-1.9(e)) — no public/max-age, so a stale nonce can never be
// replayed with its header.
// REPORT-ONLY (Rev 2 §13.2): the policy ships as
// Content-Security-Policy-Report-Only with report-uri /api/csp-report.
// The ENFORCING Content-Security-Policy header is NOT set here:
// enforcement is a separate step after a full report-only pass with zero
// violations, and is NOT claimed by this implementation.

function freshCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function serveAssetWithCsp(request, env) {
  const res = await env.ASSETS.fetch(request);
  const contentType = res.headers.get("Content-Type") || "";
  if (request.method !== "GET" || !contentType.includes("text/html")) {
    return res;
  }
  const nonce = freshCspNonce();
  let html = await res.text();
  // Nonce every <script> and <style> tag that does not already carry one.
  // (index.html: one external <script src="assets/js/main.js"> + one
  // <style>; about.html: one <style>, no script.)
  html = html.replace(
    /<script(?![^>]*\bnonce\s*=)/gi,
    '<script nonce="' + nonce + '"'
  );
  html = html.replace(
    /<style(?![^>]*\bnonce\s*=)/gi,
    '<style nonce="' + nonce + '"'
  );
  const csp =
    "default-src 'self'; " +
    "script-src 'nonce-" + nonce + "' 'strict-dynamic'; " +
    "style-src 'nonce-" + nonce + "'; " +
    "img-src 'self' data:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "report-uri /api/csp-report";
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy-Report-Only", csp);
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status: res.status, headers });
}

// ------------------------------------------- POST /api/csp-report
// Rev 2 §13.2: records ONLY the violated directive and the page URL —
// no request bodies, no user data, no IP addresses. Rate-limited to 60
// reports per minute per IP (violations are counted, not stored in full).

async function handleCspReport(request, env) {
  const headers = corsHeaders(request, "Content-Type", "POST, OPTIONS");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests are allowed." }), {
      status: 405,
      headers
    });
  }
  const db = env.NOVA_DB;
  if (db) {
    const ipKey = await ipRateKey(env, request, "csp");
    const rl = await rateLimitCheck(db, ipKey, 60000, 60, Date.now());
    if (!rl.allowed) {
      return new Response(null, {
        status: 429,
        headers: { ...headers, "Retry-After": String(rl.retryAfter) }
      });
    }
  }
  try {
    const raw = await readRawBody(request);
    if (!raw.error) {
      const parsed = parseStrictJson(raw.text);
      const report =
        parsed.value && typeof parsed.value === "object"
          ? parsed.value["csp-report"]
          : null;
      if (report && typeof report === "object") {
        console.log(
          "[NOVA CSP] violated-directive=" +
            (report["violated-directive"] || "?") +
            " document-uri=" +
            (report["document-uri"] || "?")
        );
      }
    }
  } catch {
    // A malformed report is still a 204: the endpoint must never fail
    // the page that is reporting.
  }
  return new Response(null, { status: 204, headers });
}

// --------------------------------------------------------------- Router
// /api/* goes to the NOVA handlers; everything else serves the
// static assets, exactly as the Pages static hosting did before.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/gemini") {
      return handleGemini(request, env);
    }

    // Phase 3 (Rev 2 §4.2, Rev 3 §C-1.1/§C-1.5). The old
    // /api/motion-generate + /api/motion-status routes were retired
    // 25 Nov 2026 (Rev 2 §4.1) and fall through to the "Unknown API
    // path" 404 below.
    if (url.pathname === "/api/generate") {
      return handleGenerate(request, env);
    }
    if (url.pathname === "/api/status") {
      return handlePhase3Status(request, env);
    }
    if (url.pathname === "/api/download") {
      return handleDownload(request, env);
    }
    if (url.pathname === "/api/capacity") {
      return handleCapacity(request, env);
    }
    if (url.pathname === "/api/export/jobs") {
      return handleExportJobs(request, env);
    }
    if (url.pathname === "/api/retry") {
      return handleRetry(request, env);
    }
    if (url.pathname === "/internal/d1-apply") {
      return handleD1Apply(request, env);
    }
    if (url.pathname === "/internal/d1-read") {
      return handleD1Read(request, env);
    }
    if (url.pathname === "/internal/reconcile") {
      return handleReconcile(request, env);
    }
    if (url.pathname === "/api/csp-report") {
      return handleCspReport(request, env);
    }

    // Closeout P2: unknown API paths get a machine-readable 404,
    // not the SPA HTML (a 200 HTML page is not an API answer).
    if (url.pathname.startsWith("/api/")) {
      const headers = corsHeaders(
        request,
        "Content-Type, X-NOVA-JOB-TOKEN",
        "GET, POST, OPTIONS"
      );
      return new Response(
        JSON.stringify({ error: "Unknown API path." }),
        { status: 404, headers }
      );
    }

    // Static assets. HTML responses go through the CSP nonce injection
    // (per-response nonce + report-only CSP + Cache-Control: no-store);
    // every other asset passes through untouched.
    return serveAssetWithCsp(request, env);
  },

  // Phase 3 scheduled handler: the 15-minute reconciliation timer
  // (D1 side) + 24h escalation. NOTE (25 Nov 2026): this NEVER fires on
  // a Pages deployment — Pages Functions have no cron triggers, and the
  // account has no Worker service to attach one to (verified: the
  // Workers API lists zero services; the old script name was never
  // verified). The live trigger is the GitHub Actions workflow POSTing
  // to /internal/reconcile, which runs the same handleScheduled(). This
  // export is KEPT as a thin wrapper: the worker test suite exercises
  // it directly, the reconciliation stays callable if the site ever
  // moves to Workers, and every step of handleScheduled is idempotent
  // (conditional deletes, set-once flags), so a duplicate run is safe.
  // Do NOT treat it as a live path on Pages.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};
