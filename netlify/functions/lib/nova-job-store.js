/*
 * NOVA MOTION — Persistent Job Store
 * Stage 3.2
 *
 * NOVA owns the job schema and storage interface.
 * Netlify Blobs is the first storage adapter.
 *
 * This module does not execute video generation.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "nova-motion-jobs";

function getJobStore() {
  return getStore(STORE_NAME);
}

function validJobId(id) {
  return typeof id === "string" &&
    /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function getJob(jobId) {
  if (!validJobId(jobId)) {
    return null;
  }

  const store = getJobStore();

  return await store.get(jobId, {
    type: "json"
  });
}

async function createJob(job) {
  if (!job || !validJobId(job.id)) {
    throw new Error("Invalid NOVA job record.");
  }

  const store = getJobStore();

  // Protect an existing job from accidental replacement.
  const existing = await store.get(job.id, {
    type: "json"
  });

  if (existing) {
    return {
      created: false,
      job: existing
    };
  }

  await store.setJSON(job.id, job);

  return {
    created: true,
    job
  };
}

async function updateJob(jobId, updater) {
  if (!validJobId(jobId) || typeof updater !== "function") {
    throw new Error("Invalid job update request.");
  }

  const store = getJobStore();

  const current = await store.get(jobId, {
    type: "json"
  });

  if (!current) {
    return null;
  }

  const updated = updater(current);

  if (!updated || updated.id !== jobId) {
    throw new Error("The updated job record is invalid.");
  }

  updated.updatedAt = new Date().toISOString();

  await store.setJSON(jobId, updated);

  return updated;
}

module.exports = {
  validJobId,
  getJob,
  createJob,
  updateJob
};
