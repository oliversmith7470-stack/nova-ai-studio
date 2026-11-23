/*
 * NOVA MOTION — Independent Job Gateway
 * Stage 3.1B
 *
 * NOVA owns the job ID and production plan.
 * This endpoint validates and acknowledges the job.
 *
 * No external provider calls are made in this stage.
 */

const ALLOWED_ORIGIN =
  "https://nova-ai-studio-5r8o.netlify.app";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
}

function validJobId(id) {
  return typeof id === "string" &&
    /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function validatePlan(plan) {
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
      typeof scene.generationPrompt !== "string" &&
      typeof scene.prompt !== "string"
    ) {
      return "Scene " + (i + 1) +
        " is missing a valid generation prompt.";
    }
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

  if (!validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }

  const planError = validatePlan(body.plan);

  if (planError) {
    return respond(400, {
      jobId,
      status: "failed",
      message: planError
    });
  }

  /*
   * Image bytes are not forwarded to a provider in 3.1B.
   * Validate the optional reference image format and size.
   */

  if (body.imageDataUrl != null) {
    if (
      typeof body.imageDataUrl !== "string" ||
      !/^data:image\/(png|jpeg|webp);base64,/i.test(
        body.imageDataUrl
      )
    ) {
      return respond(400, {
        jobId,
        status: "failed",
        message: "The reference image format is invalid."
      });
    }

    if (body.imageDataUrl.length > 7 * 1024 * 1024) {
      return respond(413, {
        jobId,
        status: "failed",
        message: "The reference image exceeds the allowed size."
      });
    }
  }

  /*
   * Important:
   * Never accept browser-submitted status,
   * providerJobId, videoUrl or completion claims.
   *
   * No provider has been dispatched.
   */

  return respond(503, {
    jobId,
    status: "unavailable",
    provider: "wan22-modal",
    message:
      "NOVA received and validated your production job, but the Wan 2.2 provider is not configured yet. No video has been generated."
  });
};
