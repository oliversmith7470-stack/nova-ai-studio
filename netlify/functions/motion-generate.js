/*
 * NOVA MOTION — Persistent Job Gateway
 * Stage 3.2
 *
 * NOVA owns the job ID, production plan and job record.
 * Netlify Blobs provides persistent server-side storage.
 *
 * No external video provider is called in this stage.
 */

const crypto = require("crypto");
const jobStore = require("./lib/nova-job-store");

const ALLOWED_ORIGIN =
  "https://nova-ai-studio-5r8o.netlify.app";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "Content-Type, X-NOVA-JOB-TOKEN",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const UNAVAILABLE_MESSAGE =
  "NOVA received and saved your production job, but the Wan 2.2 provider is not configured yet. No video has been generated.";

function respond(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
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

function getToken(event) {
  const headers = event.headers || {};

  return headers["x-nova-job-token"] ||
    headers["X-NOVA-JOB-TOKEN"] ||
    "";
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, {
      status: "failed",
      message: "Only POST requests are allowed."
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
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

  try {
    let job = await jobStore.getJob(jobId);
    let accessToken = null;

    if (!job) {
      accessToken = crypto.randomBytes(32).toString("hex");

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

      if (!result.created) {
        accessToken = null;
      }
    }

    if (!job || job.id !== jobId) {
      return respond(500, {
        jobId,
        status: "failed",
        message: "NOVA could not verify the saved job."
      });
    }

    if (accessToken === null) {
      const suppliedToken = getToken(event);

      if (!tokenMatches(suppliedToken, job.accessTokenHash)) {
        return respond(401, {
          jobId,
          status: "failed",
          message:
            "A valid NOVA job access token is required."
        });
      }
    }

    const response = {
      jobId: job.id,
      status: job.status,
      provider: job.provider,
      message: job.error || UNAVAILABLE_MESSAGE
    };

    if (accessToken) {
      response.accessToken = accessToken;
    }

    return respond(503, response);
  } catch (error) {
    return respond(500, {
      jobId,
      status: "failed",
      message:
        "NOVA could not save the production job. Please try again."
    });
  }
};
