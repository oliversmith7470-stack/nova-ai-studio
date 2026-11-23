/*
 * NOVA MOTION — Persistent Job Status
 * Stage 3.2
 *
 * Retrieves the authoritative server-side job record.
 * Requires the job's separate access token.
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
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const jobId =
    event.queryStringParameters?.jobId;

  if (!jobStore.validJobId(jobId)) {
    return respond(400, {
      status: "failed",
      message: "A valid NOVA job ID is required."
    });
  }

  try {
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return respond(404, {
        jobId,
        status: "not_found",
        message: "NOVA could not find this production job."
      });
    }

    const token = getToken(event);

    if (!tokenMatches(token, job.accessTokenHash)) {
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
    return respond(500, {
      jobId,
      status: "failed",
      message: "NOVA could not retrieve the production job."
    });
  }
};
