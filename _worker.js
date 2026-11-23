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
 */

// ---------------------------------------------------------------- CORS

const ALLOWED_ORIGINS = [
  "https://nova-ai-studio-5r8o.netlify.app",
  "https://nova-ai-studio-cp5.pages.dev"
];

function corsHeaders(request, allowHeaders, allowMethods) {
  const headers = {
    "Content-Type": "application/json",
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

    // Protect an existing job from accidental replacement.
    const existing = await getJob(job.id);
    if (existing) {
      return {
        created: false,
        job: existing
      };
    }

    await db
      .prepare("INSERT INTO jobs (id, data) VALUES (?, ?)")
      .bind(job.id, JSON.stringify(job))
      .run();

    return {
      created: true,
      job
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

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
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
            temperature: 0.7,
            maxOutputTokens: 1200
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", result);
      return respond(502, {
        error: "The AI service could not complete your request. Please try again."
      });
    }

    const generatedText = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!generatedText) {
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

// ------------------------------------------------------ Motion generate
// From netlify/functions/motion-generate.mjs (Stage 3.2).
// Validation, status codes and messages unchanged; the hash and
// token helpers are the async Web Crypto versions above.

const UNAVAILABLE_MESSAGE =
  "NOVA received and saved your production job, but the Wan 2.2 provider is not configured yet. No video has been generated.";

function validPlan(plan) {
  if (!plan || typeof plan !== "object" ||
      Array.isArray(plan)) {
    return "A valid scene plan is required.";
  }

  if (!Array.isArray(plan.scenes) ||
      plan.scenes.length === 0 ||
      plan.scenes.length > 20) {
    return "The production plan must contain between 1 and 20 scenes.";
  }

  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];

    if (
      !scene ||
      typeof scene !== "object" ||
      (
        typeof scene.generationPrompt !== "string" &&
        typeof scene.prompt !== "string"
      )
    ) {
      return "Scene " + (i + 1) +
        " is missing a valid generation prompt.";
    }
  }

  return null;
}

function validateImage(imageDataUrl) {
  if (imageDataUrl == null) {
    return null;
  }

  if (
    typeof imageDataUrl !== "string" ||
    !/^data:image\/(png|jpeg|webp);base64,/i.test(
      imageDataUrl
    )
  ) {
    return "The reference image format is invalid.";
  }

  if (imageDataUrl.length > 7 * 1024 * 1024) {
    return "The reference image exceeds the allowed size.";
  }

  return null;
}

function buildScenes(plan) {
  return plan.scenes.map((scene, index) => ({
    index,
    title: scene.title || "Scene " + (index + 1),
    prompt: scene.generationPrompt || scene.prompt,
    direction: scene.direction || "",
    camera: scene.camera || "",
    motion: scene.motion || "",
    start: scene.start ?? null,
    end: scene.end ?? null,
    duration: scene.duration ?? null,
    status: "queued",
    providerJobId: null,
    videoUrl: null,
    error: null
  }));
}

async function handleMotionGenerate(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN",
    "POST, OPTIONS"
  );

  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return respond(405, {
      status: "failed",
      message: "Only POST requests are allowed."
    });
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return respond(400, {
      status: "failed",
      message: "Invalid JSON request."
    });
  }

  if (!body || typeof body !== "object" ||
      Array.isArray(body)) {
    return respond(400, {
      status: "failed",
      message: "Invalid production request."
    });
  }

  const jobId = body.jobId;

  if (!validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }

  const planError = validPlan(body.plan);

  if (planError) {
    return respond(400, {
      jobId,
      status: "failed",
      message: planError
    });
  }

  const imageError = validateImage(body.imageDataUrl);

  if (imageError) {
    return respond(
      imageError.includes("exceeds") ? 413 : 400,
      {
        jobId,
        status: "failed",
        message: imageError
      }
    );
  }

  const accessToken =
    request.headers.get("X-NOVA-JOB-TOKEN") || "";

  if (!/^[0-9a-f]{64}$/i.test(accessToken)) {
    return respond(400, {
      jobId,
      status: "failed",
      message:
        "A valid 64-character NOVA job access token is required."
    });
  }

  try {
    const jobStore = createJobStore(env.NOVA_DB);

    let job = await jobStore.getJob(jobId);

    if (job) {
      if (
        job.id !== jobId ||
        !(await tokenMatches(accessToken, job.accessTokenHash))
      ) {
        return respond(401, {
          jobId,
          status: "failed",
          message:
            "A valid NOVA job access token is required."
        });
      }
    } else {
      const now = new Date().toISOString();

      const newJob = {
        id: jobId,
        createdAt: now,
        updatedAt: now,
        status: "unavailable",
        provider: "wan22-modal",
        plan: body.plan,
        scenes: buildScenes(body.plan),
        accessTokenHash: await sha256Hex(accessToken),
        error: UNAVAILABLE_MESSAGE
      };

      const result = await jobStore.createJob(newJob);
      job = result.job;

      if (
        !job ||
        job.id !== jobId ||
        !(await tokenMatches(accessToken, job.accessTokenHash))
      ) {
        return respond(409, {
          jobId,
          status: "failed",
          message:
            "NOVA could not verify the existing job credentials. Please retry using the original job details."
        });
      }
    }

    return respond(503, {
      jobId: job.id,
      status: job.status,
      provider: job.provider,
      message: job.error || UNAVAILABLE_MESSAGE
    });

  } catch (error) {
    console.error(
      "[NOVA MOTION] Job creation/storage error:",
      error
    );

    return respond(500, {
      jobId,
      status: "failed",
      message:
        "NOVA could not save the production job. Please try again."
    });
  }
}

// -------------------------------------------------------- Motion status
// From netlify/functions/motion-status.mjs (Stage 3.2).
// Validation, status codes and messages unchanged.

async function handleMotionStatus(request, env) {
  const headers = corsHeaders(
    request,
    "Content-Type, X-NOVA-JOB-TOKEN",
    "GET, OPTIONS"
  );

  const respond = (status, data) =>
    new Response(JSON.stringify(data), { status, headers });

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

  try {
    const jobStore = createJobStore(env.NOVA_DB);
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return respond(404, {
        jobId,
        status: "not_found",
        message: "NOVA could not find this production job."
      });
    }

    const token =
      request.headers.get("X-NOVA-JOB-TOKEN") || "";

    if (!(await tokenMatches(token, job.accessTokenHash))) {
      return respond(401, {
        jobId,
        status: "unauthorized",
        message:
          "A valid NOVA job access token is required."
      });
    }

    return respond(200, {
      jobId: job.id,
      status: job.status,
      provider: job.provider,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      plan: job.plan,
      scenes: job.scenes,
      error: job.error || null
    });
  } catch (error) {
    console.error(
      "[NOVA MOTION] Job retrieval/storage error:",
      error
    );

    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not retrieve the production job."
    });
  }
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
    if (url.pathname === "/api/motion-generate") {
      return handleMotionGenerate(request, env);
    }
    if (url.pathname === "/api/motion-status") {
      return handleMotionStatus(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
