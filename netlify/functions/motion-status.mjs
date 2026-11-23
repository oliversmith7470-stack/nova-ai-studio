/*
 * NOVA MOTION — Persistent Job Status
 * Stage 3.2 — Netlify Functions v2
 *
 * Retrieves the authoritative server-side job record.
 * Requires the job's separate access token.
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const jobStore = require("./lib/nova-job-store.js");

const ALLOWED_ORIGIN =
  "https://nova-ai-studio-5r8o.netlify.app";

function headers() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers":
      "Content-Type, X-NOVA-JOB-TOKEN",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
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

export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: headers()
    });
  }

  if (request.method !== "GET") {
    return respond(405, {
      status: "failed",
      message: "Only GET requests are allowed."
    });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");

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

    const token =
      request.headers.get("X-NOVA-JOB-TOKEN") || "";

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
};
