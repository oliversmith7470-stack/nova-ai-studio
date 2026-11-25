#!/usr/bin/env node
// NOVA AI Studio — repair-scene-set (operator-invoked ONLY, Rev 3.4 §C-3.4.2.2).
//
// Repairs an incomplete initial scene set for one job: reads the job's stored
// plan and current scene rows through the Worker's signed /internal/d1-read,
// inserts exactly the missing attempt-1 rows one at a time through the signed
// /internal/d1-apply `repair-scene-row` mutation (each row independently
// guarded by the single-row ceiling condition, retained + 1 <= 100000), then
// re-reads and verifies completeness (per-index attempt-1, Rev 3.5 §C-3.5.1.2).
//
// This is a HOST-LOCAL OPERATOR COMMAND. It is never an HTTP endpoint and
// never runs inside the Worker. Dispatch recovery for the job stays suspended
// until this procedure verifies the set complete.
//
// Usage:
//   node bin/repair-scene-set.mjs --worker-origin https://<pages-dev-origin> \
//       --job-id nova-job-<uuid> [--api-secret <secret>] [--dry-run]
//
// The API secret may come from --api-secret or the NOVA_API_SECRET env var.
// It is read from the operator's secure store, never committed, never logged.
// --dry-run reports the missing indexes and stops before any mutation.
//
// Exit codes: 0 = set complete (repaired or already complete); 1 = usage /
// auth / network error; 2 = repair refused at the ceiling or still
// incomplete after the attempt (job stays flagged; retry after cleanup).

import { createHmac, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const API_SECRET = process.env.NOVA_API_SECRET || null;

function usage() {
  console.error(
    "Usage: node bin/repair-scene-set.mjs --worker-origin <origin> --job-id <nova-job-uuid> [--api-secret <secret>] [--dry-run]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--worker-origin") args.workerOrigin = argv[++i];
    else if (a === "--job-id") args.jobId = argv[++i];
    else if (a === "--api-secret") args.apiSecret = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else usage();
  }
  if (!args.workerOrigin || !args.jobId) usage();
  if (!/^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.jobId)) {
    console.error("repair-scene-set: --job-id must be a valid NOVA job ID.");
    process.exit(1);
  }
  return args;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function signHeaders(secret, method, path, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replace(/-/g, "");
  const bodyHash = sha256Hex(bodyText);
  const canonical = [method, path, timestamp, nonce, bodyHash].join("\n");
  const signature = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return {
    "X-NOVA-API-SECRET": secret,
    "X-NOVA-SIGNATURE": signature,
    "X-NOVA-TIMESTAMP": timestamp,
    "X-NOVA-NONCE": nonce,
    "Content-Type": "application/json"
  };
}

async function signedFetch(origin, secret, method, path, bodyObj) {
  const bodyText = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const res = await fetch(origin + path, {
    method,
    headers: signHeaders(secret, method, path, bodyText),
    body: method === "GET" ? undefined : bodyText,
    signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function planIndexes(job) {
  if (job.mode === "plan" && Array.isArray(job.scenes)) {
    return job.scenes.map((s) => s.index);
  }
  return [0];
}

function missingAttempt1Indexes(expected, sceneRows) {
  const present = new Set();
  for (const r of sceneRows) {
    if (r.attempt === 1) present.add(r.scene_index);
  }
  return expected.filter((idx) => !present.has(idx));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secret = args.apiSecret || API_SECRET;
  if (!secret) {
    console.error("repair-scene-set: no API secret — pass --api-secret or set NOVA_API_SECRET.");
    process.exit(1);
  }
  const origin = args.workerOrigin.replace(/\/+$/, "");
  const jobId = args.jobId;

  // Step 1 — fresh read (Rev 3.4 §C-3.4.2.2).
  const jobRes = await signedFetch(origin, secret, "GET", `/internal/d1-read?op=get-job&jobId=${encodeURIComponent(jobId)}`);
  if (jobRes.status === 401) {
    console.error("repair-scene-set: Worker rejected the signature (401). Check the API secret.");
    process.exit(1);
  }
  if (jobRes.status !== 200 || !jobRes.json || !jobRes.json.job) {
    console.error(`repair-scene-set: could not read job ${jobId} (HTTP ${jobRes.status}).`);
    process.exit(1);
  }
  const job = JSON.parse(jobRes.json.job.data);
  const scenesRes = await signedFetch(origin, secret, "GET", `/internal/d1-read?op=list-scenes&jobId=${encodeURIComponent(jobId)}`);
  if (scenesRes.status !== 200 || !scenesRes.json) {
    console.error(`repair-scene-set: could not list scenes for ${jobId} (HTTP ${scenesRes.status}).`);
    process.exit(1);
  }
  const expected = planIndexes(job);
  let missing = missingAttempt1Indexes(expected, scenesRes.json.scenes || []);
  console.log(`repair-scene-set: job ${jobId} expected indexes [${expected.join(", ")}], missing attempt-1: [${missing.join(", ")}]`);
  if (missing.length === 0) {
    console.log("repair-scene-set: already complete — nothing to do.");
    return 0;
  }
  if (args.dryRun) {
    console.log("repair-scene-set: --dry-run — no mutations sent.");
    return 2;
  }

  // Step 2 — one guarded row at a time, ascending index order.
  const repaired = [];
  for (const idx of [...missing].sort((a, b) => a - b)) {
    const applyRes = await signedFetch(origin, secret, "POST", "/internal/d1-apply", {
      requestId: randomUUID(),
      mutations: [{ type: "repair-scene-row", jobId, sceneIndex: idx }]
    });
    if (applyRes.status === 401) {
      console.error("repair-scene-set: Worker rejected the signature (401) mid-repair.");
      return 1;
    }
    if (applyRes.status !== 200 || !applyRes.json) {
      console.error(`repair-scene-set: d1-apply failed for scene ${idx} (HTTP ${applyRes.status}).`);
      return 1;
    }
    const outcome = (applyRes.json.results || [])[0];
    if (!outcome || outcome.changes !== 1) {
      // Ceiling refusal (or a concurrent repair won the row): stop here.
      console.error(
        `scene-set-repair-refused jobId=${jobId} sceneIndex=${idx} ` +
          `changes=${outcome ? outcome.changes : "null"} — job stays flagged incomplete.`
      );
      return 2;
    }
    repaired.push(idx);
    console.log(`repair-scene-set: inserted scene ${idx} attempt 1.`);
  }

  // Step 3 — verification: every expected index present at attempt 1.
  const verifyRes = await signedFetch(origin, secret, "GET", `/internal/d1-read?op=list-scenes&jobId=${encodeURIComponent(jobId)}`);
  if (verifyRes.status !== 200 || !verifyRes.json) {
    console.error("repair-scene-set: verification re-read failed.");
    return 1;
  }
  missing = missingAttempt1Indexes(expected, verifyRes.json.scenes || []);
  if (missing.length > 0) {
    console.error(
      `repair-scene-set: still incomplete after repair — missing [${missing.join(", ")}]. Job stays flagged.`
    );
    return 2;
  }
  console.log(
    `scene-set-repaired jobId=${jobId} repaired indexes=[${repaired.join(", ")}] — dispatch recovery may resume.`
  );
  return 0;
}

process.exitCode = await main();
