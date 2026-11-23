/*
 * NOVA MOTION — Persistent Job Gateway
 * Stage 3.2 — Netlify Functions v2
 *
 * NOVA owns the job ID, production plan and job record.
 * Netlify Blobs provides persistent server-side storage.
 * No external video provider is called in this stage.
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const jobStore = require("./lib/nova-job-store.js");

const ALLOWED_ORIGIN =
  "https://nova-ai-studio-5r8o.netlify.app";

const UNAVAILABLE_MESSAGE =
  "NOVA received and saved your production job, but the Wan 2.2 provider is not configured yet. No video has been generated.";

function headers() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers":
      "Content-Type, X-NOVA-JOB-TOKEN",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function respond(statusCode, data) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: headers()
  });
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function tokenMatches(token, storedHash) {
  if (
    typeof token !== "string" ||
    typeof storedHash !== "string"
  ) {
    return false;
  }

  const suppliedHash = Buffer.from(hashToken(token), "hex");
  const expectedHash = Buffer.from(storedHash, "hex");

  return suppliedHash.length === expectedHash.length &&
    crypto.timingSafeEqual(suppliedHash, expectedHash);
}

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

export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: headers()
    });
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

  if (!jobStore.validJobId(jobId)) {
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
    let job = await jobStore.getJob(jobId);

    if (job) {
      if (
        job.id !== jobId ||
        !tokenMatches(accessToken, job.accessTokenHash)
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
        accessTokenHash: hashToken(accessToken),
        error: UNAVAILABLE_MESSAGE
      };

      const result = await jobStore.createJob(newJob);
      job = result.job;

      if (
        !job ||
        job.id !== jobId ||
        !tokenMatches(accessToken, job.accessTokenHash)
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
};
