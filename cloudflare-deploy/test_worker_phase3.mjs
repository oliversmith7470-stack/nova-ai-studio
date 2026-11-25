// NOVA Phase 3 — Worker/API + D1 core tests (Rev 2 + Rev 3–3.5, T31-01–T31-17
// subset owned by this workstream).
//
// Runs the REAL _worker.js under miniflare with a LOCAL in-memory D1
// (d1Persist: false — fresh every run, never the production database
// nova-motion-jobs) and a fake API process on localhost (Node http server)
// that verifies the Worker's HMAC signatures and plays the dispatch
// journal. All race/concurrency tests run against real SQLite semantics,
// never mocked affected-row counts (Rev 3.1 §A-3.1.5.3).
//
// Usage (from the repo root): node cloudflare-deploy/test_worker_phase3.mjs
// Exit 0 when every check passes, 1 otherwise.

import { createRequire } from "node:module";
const requireA2 = createRequire(new URL("../a2-impl/package.json", import.meta.url));
const { Miniflare } = requireA2("miniflare");
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Run the repair CLI as a child process WITHOUT blocking this process's
// event loop (the proxy shim below runs in this process — spawnSync would
// deadlock: the child waits on the proxy while the parent waits on the child).
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.on("error", (e) => resolve({ status: -1, stdout, stderr: String(e && e.message) }));
  });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "http://test.invalid";
// NOTE: miniflare's `assets` option must NOT be used here: with it set,
// dispatchFetch routes /api/* through the assets manifest (404) instead
// of the Worker. HTML/CSP behaviour is therefore tested by importing the
// Worker module directly with a stub ASSETS fetcher (see the CSP section
// below), which exercises the same serveAssetWithCsp code path.
const TEST_SECRET = "phase3-test-api-secret";
const TEST_KEY = "phase3-test-key";
const TEST_SALT = "phase3-test-salt";

// ------------------------------------------------------------- helpers

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name} — ${detail}`);
  }
}

const sha256Hex = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const newJobId = () => "nova-job-" + randomUUID();
const newToken = () => randomBytes(32).toString("hex");

// Canonical request (reference implementation, Rev 3.1 §A-3.1.1.2).
function canonicalFor(body) {
  if (body.mode === "single") {
    return JSON.stringify({
      mode: "single",
      prompt: body.prompt,
      model: "ltx-video-2b",
      frames: 121,
      resolution: "1024x576",
      fps: 24
    });
  }
  return JSON.stringify({
    mode: "plan",
    scenes: body.scenes.map((s) => ({ index: s.index, prompt: s.prompt })),
    model: "ltx-video-2b",
    frames: 121,
    resolution: "1024x576",
    fps: 24
  });
}

// ------------------------------------------------------- fake API process

class FakeApi {
  constructor(secret) {
    this.secret = secret;
    this.journal = new Map(); // executionId -> { executionId, jobId, sceneIndex, attempt, state, managerJobId, error }
    this.managerJobs = new Map(); // executionId -> managerJobId
    this.submissions = []; // every submit call (executionIds)
    this.signatureFailures = 0;
    this.submitBehavior = "ok"; // ok | no-capacity | error500 | timeout | unauth
    this.journalOverride = null; // fn(executionId) -> journal entry | null (404)
    this.downloadBehavior = "ok"; // ok | missing | gone
    this.nextMgr = 1;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return this.server.address().port;
  }

  close() {
    this.server.close();
  }

  verify(req, bodyText) {
    const secret = req.headers["x-nova-api-secret"];
    const sig = req.headers["x-nova-signature"];
    const ts = req.headers["x-nova-timestamp"];
    const nonce = req.headers["x-nova-nonce"];
    if (!secret || !sig || !ts || !nonce) return false;
    if (secret !== this.secret) return false;
    const url = new URL(req.url, "http://localhost");
    const canonical = [req.method, url.pathname + url.search, ts, nonce, sha256Hex(bodyText)].join("\n");
    const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  send(res, status, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }

  handle(req, res) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!this.verify(req, body)) {
        this.signatureFailures++;
        return this.send(res, 401, { error: "unauthorised" });
      }
      const url = new URL(req.url, "http://localhost");
      if (req.method === "POST" && url.pathname === "/internal/submit") {
        // Record every submit attempt (all behaviours), so tests can
        // assert "exactly one submission" even for the error behaviours.
        const payload = JSON.parse(body);
        for (const x of payload.sceneExecutions || []) this.submissions.push(x.executionId);
        if (this.submitBehavior === "timeout") return; // never respond
        if (this.submitBehavior === "unauth") return this.send(res, 401, { error: "unauthorised" });
        if (this.submitBehavior === "no-capacity") return this.send(res, 503, { error: "no-capacity" });
        if (this.submitBehavior === "error500") return this.send(res, 500, { error: "internal" });
        const managerJobIds = [];
        for (const x of payload.sceneExecutions) {
          let mgr = this.managerJobs.get(x.executionId);
          if (!mgr) {
            mgr = "mgr-" + this.nextMgr++;
            this.managerJobs.set(x.executionId, mgr);
          }
          this.journal.set(x.executionId, {
            executionId: x.executionId,
            jobId: payload.jobId,
            sceneIndex: x.sceneIndex,
            attempt: x.attempt,
            state: "dispatched",
            managerJobId: mgr
          });
          managerJobIds.push(mgr);
        }
        return this.send(res, 200, { managerJobIds, status: "dispatched", dispatchState: "slot-claimed" });
      }
      if (req.method === "GET" && url.pathname === "/internal/status") {
        const executionId = url.searchParams.get("executionId");
        if (executionId) {
          if (this.journalOverride) {
            const entry = this.journalOverride(executionId);
            if (entry === null) return this.send(res, 404, { error: "not found" });
            if (entry) return this.send(res, 200, entry);
          }
          const entry = this.journal.get(executionId);
          if (!entry) return this.send(res, 404, { error: "not found" });
          return this.send(res, 200, entry);
        }
        const jobId = url.searchParams.get("jobId");
        const scenes = [...this.journal.values()].filter((j) => j.jobId === jobId);
        return this.send(res, 200, { jobId, aggregateStatus: "queued", scenes });
      }
      if (req.method === "GET" && url.pathname === "/internal/download") {
        if (this.downloadBehavior === "missing") return this.send(res, 404, { error: "not found" });
        if (this.downloadBehavior === "gone") return this.send(res, 410, { error: "expired" });
        const bytes = Buffer.from("FAKE-MP4-BYTES");
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) });
        return res.end(bytes);
      }
      return this.send(res, 404, { error: "unknown" });
    });
  }
}

// ------------------------------------------------------------ miniflare

async function applySchema(db) {
  const schema = readFileSync(path.join(ROOT, "d1/schema.sql"), "utf8");
  const noComments = schema.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of noComments.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

let bootCount = 0;
async function boot({ mode = "controlled-test", apiPort, extraBindings = {} } = {}) {
  bootCount++;
  const mf = new Miniflare({
    root: ROOT,
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: path.join(ROOT, "_worker.js"),
    d1Databases: { NOVA_DB: `nova-phase3-test-${bootCount}` },
    d1Persist: false,
    compatibilityDate: "2025-01-01",
    bindings: {
      NOVA_API_SECRET: TEST_SECRET,
      NOVA_API_MODE: mode,
      NOVA_TEST_KEY: TEST_KEY,
      NOVA_IP_HASH_SALT: TEST_SALT,
      NOVA_API_ORIGIN: `http://localhost:${apiPort}`,
      ...extraBindings
    }
  });
  const db = await mf.getD1Database("NOVA_DB");
  await applySchema(db);
  return { mf, db };
}

async function callWorker(mf, method, path, { body, rawBody, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (rawBody !== undefined) {
    init.body = rawBody;
    init.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await mf.dispatchFetch(SITE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const TEST_HDRS = (token, ip = "203.0.113.7") => ({
  "X-NOVA-JOB-TOKEN": token,
  "X-NOVA-TEST-KEY": TEST_KEY,
  "CF-Connecting-IP": ip
});

// Sign a request AS the API process (for /internal/*).
function signInternal(method, path, bodyText, { timestamp, nonce, secret = TEST_SECRET } = {}) {
  const ts = timestamp !== undefined ? String(timestamp) : String(Math.floor(Date.now() / 1000));
  const nc = nonce !== undefined ? nonce : randomUUID().replace(/-/g, "");
  const canonical = [method, path, ts, nc, sha256Hex(bodyText)].join("\n");
  const sig = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return {
    "X-NOVA-API-SECRET": secret,
    "X-NOVA-SIGNATURE": sig,
    "X-NOVA-TIMESTAMP": ts,
    "X-NOVA-NONCE": nc,
    "Content-Type": "application/json"
  };
}

async function d1Apply(mf, requestId, mutations, signOpts) {
  const bodyText = JSON.stringify({ requestId, mutations });
  return callWorker(mf, "POST", "/internal/d1-apply", {
    rawBody: bodyText,
    headers: signInternal("POST", "/internal/d1-apply", bodyText, signOpts)
  });
}

async function d1Read(mf, query, signOpts) {
  const path = "/internal/d1-read?" + query;
  return callWorker(mf, "GET", path, {
    headers: signInternal("GET", path, "", signOpts)
  });
}

async function jobRow(db, jobId) {
  const row = await db.prepare("SELECT id, data FROM jobs WHERE id = ?").bind(jobId).first();
  return row ? JSON.parse(row.data) : null;
}

async function sceneRows(db, jobId) {
  const r = await db
    .prepare("SELECT job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at FROM scenes WHERE job_id = ? ORDER BY scene_index, attempt")
    .bind(jobId)
    .all();
  return r.results || [];
}

// Seed N jobs rows via one CTE statement (fast, real rows).
async function seedJobs(db, count) {
  await db
    .prepare(
      `WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < ?) INSERT INTO jobs (id, data) SELECT 'seed-job-' || printf('%06d', n), '{}' FROM cnt`
    )
    .bind(count)
    .run();
}

async function retainedTotal(db) {
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS total")
    .first();
  return Number(row.total);
}

// Run the Worker's scheduled() handler directly against a miniflare D1
// binding (this miniflare has no dispatchScheduled/startServer).
// extraEnv passes Worker bindings through (e.g. the retention config —
// scheduled() reads env, and the miniflare boot bindings are NOT visible
// to this direct import, so retention tests must pass them here too).
async function runScheduled(db, extraEnv = {}) {
  const mod = await import("../_worker.js");
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  await mod.default.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, { NOVA_DB: db, ...extraEnv }, ctx);
  await Promise.all(pending);
}

// HTTP shim in front of mf.dispatchFetch so the repair CLI (a plain
// HTTP client) can talk to a miniflare Worker.
function startDispatchProxy(mf) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        const init = { method: req.method, headers: { ...req.headers } };
        delete init.headers.host;
        if (body.length) init.body = body;
        const r = await mf.dispatchFetch(SITE + req.url, init);
        const buf = Buffer.from(await r.arrayBuffer());
        const headers = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(r.status, headers);
        res.end(buf);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(String(e && e.message));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// ------------------------------------------------------------- main

const fake = new FakeApi(TEST_SECRET);
const apiPort = await fake.listen();

try {
  // ------------------------------------------------ capacity + CSP
  {
    console.log("\n-- Capacity + CSP --");
    const { mf, db } = await boot({ apiPort });
    try {
      let r = await callWorker(mf, "GET", "/api/capacity");
      check(
        "CAP.1 controlled-test capacity: available:true WITH mode",
        r.status === 200 && r.json && r.json.available === true &&
          r.json.mode === "controlled-test" && r.json.reason === "controlled-test-only",
        `HTTP ${r.status} ${r.text.slice(0, 160)}`
      );

      // --- CSP: direct module import + stub ASSETS (see the note above) ---
      const workerMod = await import("../_worker.js");
      const worker = workerMod.default;
      const stubAssets = {
        async fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/" || u.pathname === "/index.html") {
            return new Response(readFileSync(path.join(ROOT, "index.html"), "utf8"), {
              headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" }
            });
          }
          if (u.pathname === "/about.html") {
            return new Response(readFileSync(path.join(ROOT, "about.html"), "utf8"), {
              headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" }
            });
          }
          if (u.pathname === "/assets/js/main.js") {
            return new Response(readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8"), {
              headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" }
            });
          }
          return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
        }
      };
      const cspEnv = {
        NOVA_DB: db, ASSETS: stubAssets,
        NOVA_API_SECRET: TEST_SECRET, NOVA_API_MODE: "controlled-test",
        NOVA_TEST_KEY: TEST_KEY, NOVA_IP_HASH_SALT: TEST_SALT,
        NOVA_API_ORIGIN: `http://localhost:${apiPort}`
      };
      async function cspCall(method, p, opts = {}) {
        const init = { method, headers: opts.headers || {} };
        if (opts.body !== undefined) {
          init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
          init.headers["Content-Type"] = "application/json";
        }
        const res = await worker.fetch(new Request(SITE + p, init), cspEnv);
        const text = await res.text();
        return { status: res.status, headers: res.headers, text };
      }

      r = await cspCall("GET", "/");
      const csp = r.headers.get("Content-Security-Policy-Report-Only") || "";
      const nonceMatch = csp.match(/'nonce-([^']+)'/);
      const nonce = nonceMatch ? nonceMatch[1] : null;
      const scriptSrc = (csp.match(/script-src ([^;]+)/) || [])[1] || "";
      const styleSrc = (csp.match(/style-src ([^;]+)/) || [])[1] || "";
      check(
        "CSP.1 index.html: report-only CSP present, nonce in header matches nonce in HTML, no-store, no enforcing header",
        r.status === 200 &&
          nonce !== null &&
          r.text.includes('<script nonce="' + nonce + '" src="assets/js/main.js">') &&
          r.text.includes('<style nonce="' + nonce + '">') &&
          r.headers.get("Cache-Control") === "no-store" &&
          !r.headers.get("Content-Security-Policy") &&
          scriptSrc.includes("'nonce-" + nonce + "'") &&
          scriptSrc.includes("'strict-dynamic'") &&
          !scriptSrc.includes("'self'") /* script-src has no 'self': nonce chosen */ &&
          styleSrc.includes("'nonce-" + nonce + "'"),
        `status=${r.status} csp=${csp.slice(0, 120)} cc=${r.headers.get("Cache-Control")}`
      );
      // A second response must carry a DIFFERENT nonce (fresh per response).
      const r2 = await cspCall("GET", "/");
      const nonce2 = (r2.headers.get("Content-Security-Policy-Report-Only") || "").match(/'nonce-([^']+)'/);
      check(
        "CSP.2 nonce is fresh per response",
        nonce2 && nonce2[1] !== nonce,
        `nonce1=${nonce} nonce2=${nonce2 && nonce2[1]}`
      );

      r = await cspCall("GET", "/about.html");
      const cspA = r.headers.get("Content-Security-Policy-Report-Only") || "";
      const nonceA = (cspA.match(/'nonce-([^']+)'/) || [])[1];
      check(
        "CSP.3 about.html: <style> nonced, no-store",
        r.status === 200 && nonceA && r.text.includes('<style nonce="' + nonceA + '">') &&
          r.headers.get("Cache-Control") === "no-store" &&
          !r.text.includes("<script"),
        `status=${r.status} ${r.text.slice(0, 120)}`
      );

      r = await cspCall("GET", "/assets/js/main.js");
      check(
        "CSP.4 non-HTML asset passes through: no CSP header, no no-store",
        r.status === 200 && !r.headers.get("Content-Security-Policy-Report-Only") &&
          r.headers.get("Cache-Control") !== "no-store",
        `status=${r.status} csp=${r.headers.get("Content-Security-Policy-Report-Only")}`
      );

      r = await cspCall("POST", "/api/csp-report", {
        body: { "csp-report": { "violated-directive": "script-src", "document-uri": "http://test.invalid/" } }
      });
      check("CSP.5 csp-report accepts a violation -> 204", r.status === 204, `HTTP ${r.status}`);
      r = await cspCall("POST", "/api/csp-report", { body: "not json{{{" });
      check("CSP.6 malformed csp-report still -> 204", r.status === 204, `HTTP ${r.status}`);
    } finally {
      await mf.dispose();
    }

    const prod = await boot({ mode: "production", apiPort });
    try {
      const r = await callWorker(prod.mf, "GET", "/api/capacity");
      check(
        "CAP.2 production capacity: available:false, no-production-capacity",
        r.status === 200 && r.json && r.json.available === false &&
          r.json.reason === "no-production-capacity" && !("mode" in r.json),
        `HTTP ${r.status} ${r.text.slice(0, 160)}`
      );
      const g = await callWorker(prod.mf, "POST", "/api/generate", {
        body: { jobId: newJobId(), mode: "single", prompt: "A dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: { "X-NOVA-JOB-TOKEN": newToken(), "CF-Connecting-IP": "203.0.113.8" }
      });
      check(
        "CAP.3 production generate -> 503 capacity_unavailable, no job created",
        g.status === 503 && g.json && g.json.error === "capacity_unavailable",
        `HTTP ${g.status} ${g.text.slice(0, 120)}`
      );
      const g2 = await callWorker(prod.mf, "POST", "/api/generate", {
        body: { jobId: newJobId(), mode: "single", prompt: "A dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: { "X-NOVA-JOB-TOKEN": newToken(), "X-NOVA-TEST-KEY": TEST_KEY, "CF-Connecting-IP": "203.0.113.8" }
      });
      check(
        "CAP.4 production + test key -> 401",
        g2.status === 401,
        `HTTP ${g2.status}`
      );
    } finally {
      await prod.mf.dispose();
    }
  }

  // ------------------------------------------------ canonical + creation
  {
    console.log("\n-- Canonical identity + creation --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const token = newToken();
      const body = { jobId, mode: "single", prompt: "A dragon over a golden kingdom", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 };
      let r = await callWorker(mf, "POST", "/api/generate", { body, headers: TEST_HDRS(token) });
      check(
        "GEN.1 creation happy path -> 202 slot-claimed, dispatchState present",
        r.status === 202 && r.json && r.json.jobId === jobId &&
          r.json.status === "queued" && r.json.dispatchState === "slot-claimed" &&
          r.json.expiresAt === null,
        `HTTP ${r.status} ${r.text.slice(0, 200)}`
      );
      const stored = await jobRow(db, jobId);
      const expectedHash = sha256Hex(canonicalFor(body));
      check(
        "GEN.2 stored requestIdentityHash matches canonical-request-v1 digest; creationToken stored, never returned",
        stored && stored.requestIdentityHash === expectedHash &&
          stored.requestIdentityVersion === "canonical-request-v1" &&
          typeof stored.creationToken === "string" && stored.creationToken.length === 36 &&
          stored.dispatchState === "submitted" &&
          !r.text.includes(stored.creationToken),
        `hash=${stored && stored.requestIdentityHash} expected=${expectedHash}`
      );
      const scenes = await sceneRows(db, jobId);
      check(
        "GEN.3 exactly one scene row, attempt 1, deterministic execution ID, provider_job_id set",
        scenes.length === 1 && scenes[0].attempt === 1 &&
          scenes[0].execution_id === jobId + ":scene-0:attempt-1" &&
          scenes[0].status === "queued" && typeof scenes[0].provider_job_id === "string",
        JSON.stringify(scenes)
      );

      // Duplicate paths.
      r = await callWorker(mf, "POST", "/api/generate", { body, headers: TEST_HDRS(token) });
      check(
        "GEN.4 duplicate same token+content -> 200 existing job, no second manager job",
        r.status === 200 && r.json && r.json.jobId === jobId,
        `HTTP ${r.status} ${r.text.slice(0, 160)}`
      );
      check(
        "GEN.5 fake API created exactly one manager job for the execution",
        fake.managerJobs.size === 1,
        `managerJobs=${fake.managerJobs.size}`
      );
      r = await callWorker(mf, "POST", "/api/generate", { body, headers: TEST_HDRS(newToken()) });
      check("GEN.6 duplicate different token -> 401", r.status === 401, `HTTP ${r.status}`);
      r = await callWorker(mf, "POST", "/api/generate", {
        body: { ...body, prompt: "A different dragon" },
        headers: TEST_HDRS(token)
      });
      check(
        "GEN.7 duplicate different content -> 409 conflict, original unchanged",
        r.status === 409 && r.json && r.json.error === "conflict",
        `HTTP ${r.status} ${r.text.slice(0, 160)}`
      );
      const storedAfter = await jobRow(db, jobId);
      check(
        "GEN.8 original job unchanged after 409",
        storedAfter && storedAfter.requestIdentityHash === expectedHash,
        ""
      );
      // Whitespace-only difference is a different request (409).
      r = await callWorker(mf, "POST", "/api/generate", {
        body: { ...body, prompt: "A dragon over a golden kingdom " },
        headers: TEST_HDRS(token)
      });
      check("GEN.9 trailing-whitespace prompt -> 409 (whitespace is significant)", r.status === 409, `HTTP ${r.status}`);

      // Validation battery.
      const badBodies = [
        ["unexpected field", { ...body, jobId: newJobId(), imageDataUrl: "data:image/png;base64,xx" }, 400],
        ["extra unknown field", { ...body, jobId: newJobId(), surprise: 1 }, 400],
        ["null prompt", { ...body, jobId: newJobId(), prompt: null }, 400],
        ["missing model", { jobId: newJobId(), mode: "single", prompt: "x", frames: 121, resolution: "1024x576", fps: 24 }, 400],
        ["wrong model", { ...body, jobId: newJobId(), model: "wan-2.2" }, 400],
        ["frames 24.0", null, 400], // raw body below
        ["prompt over 2000 chars (never truncated)", { ...body, jobId: newJobId(), prompt: "x".repeat(2001) }, 400],
        ["blank prompt", { ...body, jobId: newJobId(), prompt: "   " }, 400],
        ["both prompt and scenes", { ...body, jobId: newJobId(), scenes: [{ index: 0, prompt: "x" }] }, 400]
      ];
      for (const [name, b, want] of badBodies) {
        if (b === null) continue;
        const rr = await callWorker(mf, "POST", "/api/generate", { body: b, headers: TEST_HDRS(newToken()) });
        check(`VAL ${name} -> ${want}`, rr.status === want, `HTTP ${rr.status} ${rr.text.slice(0, 100)}`);
      }
      // Raw-lexeme cases (must be sent as raw text, not JSON.stringify).
      const rawCases = [
        ["frames 24.0", `{"jobId":"${newJobId()}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":24.0,"resolution":"1024x576","fps":24}`],
        ["frames 2.4e1", `{"jobId":"${newJobId()}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":2.4e1,"resolution":"1024x576","fps":24}`],
        ["frames true", `{"jobId":"${newJobId()}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":true,"resolution":"1024x576","fps":24}`],
        ["fps 24.00", `{"jobId":"${newJobId()}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24.00}`],
        ["duplicate top-level key", `{"jobId":"${newJobId()}","jobId":"${newJobId()}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`],
        ["duplicate key in scene", `{"jobId":"${newJobId()}","mode":"plan","scenes":[{"index":0,"index":0,"prompt":"x"}],"model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`],
        ["lone surrogate in prompt", `{"jobId":"${newJobId()}","mode":"single","prompt":"\\ud800","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`]
      ];
      for (const [name, rawText] of rawCases) {
        const rr = await callWorker(mf, "POST", "/api/generate", { rawBody: rawText, headers: TEST_HDRS(newToken()) });
        check(`VAL ${name} -> 400`, rr.status === 400, `HTTP ${rr.status} ${rr.text.slice(0, 100)}`);
      }
      // Unicode canonical: raw UTF-8, never \uXXXX-escaped.
      const uniJob = newJobId();
      const uniToken = newToken();
      const uniBody = { jobId: uniJob, mode: "single", prompt: "Un dragón — 火龙", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 };
      r = await callWorker(mf, "POST", "/api/generate", { body: uniBody, headers: TEST_HDRS(uniToken) });
      const uniStored = await jobRow(db, uniJob);
      const uniCanon = canonicalFor(uniBody);
      check(
        "VAL unicode prompt: raw UTF-8 canonical (no \\\\u escapes), hash matches",
        r.status === 202 && uniCanon.includes("火龙") && !uniCanon.includes("\\u") &&
          uniStored && uniStored.requestIdentityHash === sha256Hex(uniCanon),
        `status=${r.status} canon=${uniCanon}`
      );
      // No test key in controlled-test mode -> 503, no job.
      const noKeyJob = newJobId();
      r = await callWorker(mf, "POST", "/api/generate", {
        body: { ...uniBody, jobId: noKeyJob },
        headers: { "X-NOVA-JOB-TOKEN": newToken(), "CF-Connecting-IP": "203.0.113.9" }
      });
      check(
        "GEN.10 controlled-test without test key -> 503, no job created",
        r.status === 503 && (await jobRow(db, noKeyJob)) === null,
        `HTTP ${r.status}`
      );
      // Wrong test key -> 401.
      r = await callWorker(mf, "POST", "/api/generate", {
        body: { ...uniBody, jobId: newJobId() },
        headers: { "X-NOVA-JOB-TOKEN": newToken(), "X-NOVA-TEST-KEY": "wrong-key", "CF-Connecting-IP": "203.0.113.9" }
      });
      check("GEN.11 controlled-test wrong test key -> 401", r.status === 401, `HTTP ${r.status}`);

      // Status endpoint.
      r = await callWorker(mf, "GET", `/api/status?jobId=${jobId}`, { headers: TEST_HDRS(token) });
      check(
        "ST.1 status 200, queued, scenes listed, dispatchState present",
        r.status === 200 && r.json && r.json.status === "queued" &&
          Array.isArray(r.json.scenes) && r.json.scenes.length === 1 &&
          r.json.dispatchState === "submitted",
        `HTTP ${r.status} ${r.text.slice(0, 200)}`
      );
      const etag = r.headers.get("ETag");
      r = await callWorker(mf, "GET", `/api/status?jobId=${jobId}`, {
        headers: { ...TEST_HDRS(token), "If-None-Match": etag }
      });
      check("ST.2 If-None-Match -> 304", r.status === 304, `HTTP ${r.status}`);
      r = await callWorker(mf, "GET", `/api/status?jobId=${jobId}`, { headers: TEST_HDRS(newToken()) });
      check("ST.3 status wrong token -> 401", r.status === 401, `HTTP ${r.status}`);
      r = await callWorker(mf, "GET", `/api/status?jobId=${newJobId()}`, { headers: TEST_HDRS(token) });
      check("ST.4 status unknown job -> 404", r.status === 404, `HTTP ${r.status}`);
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ concurrent duplicate (T31-01)
  {
    console.log("\n-- T31-01 concurrent duplicate creation --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const token = newToken();
      const body = { jobId, mode: "single", prompt: "Race dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 };
      const before = fake.managerJobs.size;
      const subsBefore = fake.submissions.length;
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          callWorker(mf, "POST", "/api/generate", { body, headers: TEST_HDRS(token, `203.0.113.${20 + i}`) }))
      );
      const created = results.filter((x) => x.status === 202).length;
      const dups = results.filter((x) => x.status === 200).length;
      const rows = await db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE id = ?").bind(jobId).first();
      const subsForJob = fake.submissions.filter((s) => s === jobId + ":scene-0:attempt-1").length;
      check(
        "T31-01 exactly one 202, rest 200, exactly one job row, exactly one manager job, exactly one journal submission",
        created === 1 && dups === 4 && Number(rows.c) === 1 &&
          fake.managerJobs.size - before === 1 && subsForJob === 1,
        `statuses=${results.map((x) => x.status).join(",")} rows=${rows.c} newMgr=${fake.managerJobs.size - before} submits=${subsForJob}`
      );
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ rate limits (Rev 3 §C-1.6)
  {
    console.log("\n-- Atomic rate limits --");
    const { mf, db } = await boot({ apiPort });
    try {
      const ip = "203.0.113.100";
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          callWorker(mf, "POST", "/api/generate", {
            body: { jobId: newJobId(), mode: "single", prompt: "Rate dragon " + i, model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
            headers: TEST_HDRS(newToken(), ip)
          }))
      );
      const ok = results.filter((x) => x.status === 202).length;
      const limited = results.filter((x) => x.status === 429).length;
      const rlRow = await db.prepare("SELECT count FROM rate_limits WHERE key LIKE 'ip-gen:%'").all();
      const total = (rlRow.results || []).reduce((a, r) => a + Number(r.count), 0);
      check(
        "RL.1 20 simultaneous from one IP: exactly 10 accepted, 10 get 429 with Retry-After, final count 10",
        ok === 10 && limited === 10 && total === 10 &&
          results.filter((x) => x.status === 429).every((x) => x.headers.get("Retry-After")),
        `ok=${ok} limited=${limited} count=${total}`
      );
      // Expired-window race: seed an expired window at the limit, fire 5.
      const ip2 = "203.0.113.101";
      const key2 = "ip-gen:" + createHmac("sha256", TEST_SALT).update(ip2, "utf8").digest("hex");
      const nowMs = Date.now();
      await db
        .prepare("INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(key2, nowMs - 7200000, nowMs - 3600000, 10, nowMs - 3600000)
        .run();
      const r2 = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          callWorker(mf, "POST", "/api/generate", {
            body: { jobId: newJobId(), mode: "single", prompt: "Window dragon " + i, model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
            headers: TEST_HDRS(newToken(), ip2)
          }))
      );
      const row2 = await db.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key2).first();
      check(
        "RL.2 expired window rolls over: all 5 accepted, final count 5",
        r2.every((x) => x.status === 202) && Number(row2.count) === 5,
        `statuses=${r2.map((x) => x.status).join(",")} count=${row2 && row2.count}`
      );
      // Privacy: no raw IP in D1.
      const keys = await db.prepare("SELECT key FROM rate_limits").all();
      check(
        "RL.3 no raw IP stored in rate_limits keys",
        (keys.results || []).every((r) => !r.key.includes("203.0.113")),
        JSON.stringify((keys.results || []).map((r) => r.key))
      );
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ retry (Rev 3 §C-1.5)
  {
    console.log("\n-- Retry --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const token = newToken();
      const body = { jobId, mode: "single", prompt: "Retry dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 };
      let r = await callWorker(mf, "POST", "/api/generate", { body, headers: TEST_HDRS(token) });
      check("RT.0 setup create -> 202", r.status === 202, `HTTP ${r.status}`);
      // Fail the scene via signed d1-apply (as the API process would).
      const failRes = await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "failed", error: "executor blew up" }
      ]);
      check("RT.1 scene-update via d1-apply -> 200", failRes.status === 200, `HTTP ${failRes.status} ${failRes.text.slice(0, 120)}`);
      r = await callWorker(mf, "GET", `/api/status?jobId=${jobId}`, { headers: TEST_HDRS(token) });
      check(
        "RT.2 parent aggregate is failed after the only scene failed",
        r.status === 200 && r.json && r.json.status === "failed",
        `HTTP ${r.status} ${r.text.slice(0, 160)}`
      );
      r = await callWorker(mf, "POST", "/api/retry", {
        body: { jobId, sceneIndex: 0 },
        headers: TEST_HDRS(token)
      });
      check(
        "RT.3 retry -> 202, attempt 2, new execution ID",
        r.status === 202 && r.json && r.json.attempt === 2 &&
          r.json.executionId === jobId + ":scene-0:attempt-2" &&
          r.json.dispatchState === "slot-claimed",
        `HTTP ${r.status} ${r.text.slice(0, 200)}`
      );
      const rows = await sceneRows(db, jobId);
      check(
        "RT.4 old attempt untouched (failed), new attempt queued with provider_job_id",
        rows.length === 2 && rows[0].attempt === 1 && rows[0].status === "failed" &&
          rows[1].attempt === 2 && rows[1].status === "queued" &&
          typeof rows[1].provider_job_id === "string",
        JSON.stringify(rows)
      );
      r = await callWorker(mf, "GET", `/api/status?jobId=${jobId}`, { headers: TEST_HDRS(token) });
      check(
        "RT.5 status during single-scene retry: parent queued (SQL aggregate, Rev 3 §C-1.3), scene retrying:false (no earlier failure recorded on the new attempt row)",
        r.status === 200 && r.json && r.json.status === "queued",
        `HTTP ${r.status} ${r.text.slice(0, 200)}`
      );
      // Two simultaneous retries for the same scene: exactly one 202.
      // (First fail attempt 2 as well so a retry is possible again.)
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId, sceneIndex: 0, attempt: 2, status: "failed", error: "failed again" }
      ]);
      const pair = await Promise.all([
        callWorker(mf, "POST", "/api/retry", { body: { jobId, sceneIndex: 0 }, headers: TEST_HDRS(token, "203.0.113.30") }),
        callWorker(mf, "POST", "/api/retry", { body: { jobId, sceneIndex: 0 }, headers: TEST_HDRS(token, "203.0.113.31") })
      ]);
      const okCount = pair.filter((x) => x.status === 202).length;
      const conflict = pair.filter((x) => x.status === 409).length;
      check(
        "RT.6 simultaneous retries: exactly one 202, other 409",
        okCount === 1 && conflict === 1,
        `statuses=${pair.map((x) => x.status).join(",")}`
      );
      // Retry a non-failed scene -> 400. Retry unknown job -> 404. Wrong token -> 401.
      const jobId2 = newJobId();
      const token2 = newToken();
      await callWorker(mf, "POST", "/api/generate", {
        body: { jobId: jobId2, mode: "single", prompt: "Healthy dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: TEST_HDRS(token2)
      });
      r = await callWorker(mf, "POST", "/api/retry", { body: { jobId: jobId2, sceneIndex: 0 }, headers: TEST_HDRS(token2) });
      check("RT.7 retry a queued scene -> 400 not retryable", r.status === 400, `HTTP ${r.status}`);
      r = await callWorker(mf, "POST", "/api/retry", { body: { jobId: newJobId(), sceneIndex: 0 }, headers: TEST_HDRS(token2) });
      check("RT.8 retry unknown job -> 404", r.status === 404, `HTTP ${r.status}`);
      r = await callWorker(mf, "POST", "/api/retry", { body: { jobId, sceneIndex: 0 }, headers: TEST_HDRS(newToken()) });
      check("RT.9 retry wrong token -> 401", r.status === 401, `HTTP ${r.status}`);
      // Retry on an expired parent -> 410 (seeded directly).
      const expJob = newJobId();
      const expToken = newToken();
      const expHash = sha256Hex(expToken);
      await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(
        expJob,
        JSON.stringify({
          id: expJob, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          createdAtMs: Date.now(), status: "expired", mode: "single", engine: "ltx-video-2b",
          prompt: "Old dragon", accessTokenHash: expHash,
          requestIdentityHash: "x", requestIdentityVersion: "canonical-request-v1",
          dispatchState: "submitted", creationToken: randomUUID(), deploymentMode: "controlled-test"
        })
      ).run();
      await db.prepare(
        "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, 0, 1, ?, NULL, 'failed', 'x', NULL, NULL, ?)"
      ).bind(expJob, expJob + ":scene-0:attempt-1", Date.now()).run();
      r = await callWorker(mf, "POST", "/api/retry", { body: { jobId: expJob, sceneIndex: 0 }, headers: TEST_HDRS(expToken) });
      check("RT.10 retry expired parent -> 410, no new attempt", r.status === 410, `HTTP ${r.status}`);
      const expRows = await sceneRows(db, expJob);
      check("RT.11 expired parent still has exactly one scene row", expRows.length === 1, `rows=${expRows.length}`);

      // Multi-scene retry transition: partial_failed -> running -> succeeded.
      const planJob = newJobId();
      const planToken = newToken();
      const planBody = {
        jobId: planJob, mode: "plan",
        scenes: [{ index: 0, prompt: "Scene zero" }, { index: 1, prompt: "Scene one" }],
        model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24
      };
      r = await callWorker(mf, "POST", "/api/generate", { body: planBody, headers: TEST_HDRS(planToken) });
      check("RT.12 plan create -> 202", r.status === 202, `HTTP ${r.status}`);
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId: planJob, sceneIndex: 0, attempt: 1, status: "succeeded", outputRef: "ref-0", expiresAt: Date.now() + 86400000 }
      ]);
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId: planJob, sceneIndex: 1, attempt: 1, status: "failed", error: "boom" }
      ]);
      r = await callWorker(mf, "GET", `/api/status?jobId=${planJob}`, { headers: TEST_HDRS(planToken) });
      check(
        "RT.13 one succeeded + one failed -> partial_failed",
        r.status === 200 && r.json && r.json.status === "partial_failed",
        `HTTP ${r.status} ${r.text.slice(0, 200)}`
      );
      r = await callWorker(mf, "POST", "/api/retry", { body: { jobId: planJob, sceneIndex: 1 }, headers: TEST_HDRS(planToken) });
      check("RT.14 retry failed scene in partial_failed -> 202", r.status === 202, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
      r = await callWorker(mf, "GET", `/api/status?jobId=${planJob}`, { headers: TEST_HDRS(planToken) });
      const retried = r.json && r.json.scenes && r.json.scenes.find((s) => s.index === 1);
      check(
        "RT.15 parent running during retry, scene retrying:true",
        r.status === 200 && r.json && r.json.status === "running" &&
          retried && retried.retrying === true && retried.attempt === 2,
        `HTTP ${r.status} ${r.text.slice(0, 300)}`
      );
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId: planJob, sceneIndex: 1, attempt: 2, status: "succeeded", outputRef: "ref-1", expiresAt: Date.now() + 86400000 }
      ]);
      r = await callWorker(mf, "GET", `/api/status?jobId=${planJob}`, { headers: TEST_HDRS(planToken) });
      check(
        "RT.16 retry resolves -> parent succeeded, download URL present",
        r.status === 200 && r.json && r.json.status === "succeeded" &&
          typeof r.json.downloadUrl === "string",
        `HTTP ${r.status} ${r.text.slice(0, 300)}`
      );
      // Download the succeeded scene through the fake API.
      r = await callWorker(mf, "GET", `/api/download?jobId=${planJob}&scene=1`, { headers: TEST_HDRS(planToken) });
      check(
        "DL.1 download streams bytes with attachment disposition",
        r.status === 200 && r.text === "FAKE-MP4-BYTES" &&
          (r.headers.get("Content-Disposition") || "").includes("attachment"),
        `HTTP ${r.status} ${r.text.slice(0, 60)}`
      );
      r = await callWorker(mf, "GET", `/api/download?jobId=${planJob}&scene=0`, { headers: TEST_HDRS(newToken()) });
      check("DL.2 download wrong token -> 401", r.status === 401, `HTTP ${r.status}`);
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ internal endpoints (HMAC)
  {
    console.log("\n-- Internal D1 endpoints + HMAC --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const token = newToken();
      await callWorker(mf, "POST", "/api/generate", {
        body: { jobId, mode: "single", prompt: "Internal dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: TEST_HDRS(token)
      });

      // No signature -> 401, no D1 change.
      const before = await jobRow(db, jobId);
      let r = await callWorker(mf, "POST", "/internal/d1-apply", {
        body: { requestId: randomUUID(), mutations: [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "failed" }] }
      });
      check("IN.1 d1-apply without signature -> 401", r.status === 401 && r.json && r.json.error === "unauthorised", `HTTP ${r.status}`);
      const after = await jobRow(db, jobId);
      check("IN.2 no D1 change after rejected call", JSON.stringify(before) === JSON.stringify(after), "");

      // Tampered body -> 401.
      const goodBody = JSON.stringify({ requestId: randomUUID(), mutations: [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "failed" }] });
      const tampered = goodBody.replace('"failed"', '"running"');
      r = await callWorker(mf, "POST", "/internal/d1-apply", {
        rawBody: tampered,
        headers: signInternal("POST", "/internal/d1-apply", goodBody)
      });
      check("IN.3 tampered body -> 401", r.status === 401, `HTTP ${r.status}`);

      // Expired timestamp -> 401.
      r = await d1Apply(mf, randomUUID(), [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "failed" }], {
        timestamp: Math.floor(Date.now() / 1000) - 300
      });
      check("IN.4 expired timestamp -> 401", r.status === 401, `HTTP ${r.status}`);

      // Replay: identical signed request twice -> second 401.
      const replayBody = JSON.stringify({ requestId: randomUUID(), mutations: [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "running" }] });
      const replayHeaders = signInternal("POST", "/internal/d1-apply", replayBody);
      r = await callWorker(mf, "POST", "/internal/d1-apply", { rawBody: replayBody, headers: replayHeaders });
      check("IN.5 first signed d1-apply -> 200", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
      r = await callWorker(mf, "POST", "/internal/d1-apply", { rawBody: replayBody, headers: replayHeaders });
      check("IN.6 replay of identical timestamp+nonce+signature -> 401", r.status === 401, `HTTP ${r.status}`);

      // Nonce not burned by a failed request (Rev 3 §C-1.10 test).
      const burnNonce = randomUUID().replace(/-/g, "");
      const burnBody = JSON.stringify({ requestId: randomUUID(), mutations: [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "running" }] });
      const badSig = signInternal("POST", "/internal/d1-apply", burnBody, { nonce: burnNonce, secret: "wrong-secret" });
      r = await callWorker(mf, "POST", "/internal/d1-apply", { rawBody: burnBody, headers: badSig });
      check("IN.7 invalid signature -> 401", r.status === 401, `HTTP ${r.status}`);
      const goodSig = signInternal("POST", "/internal/d1-apply", burnBody, { nonce: burnNonce });
      r = await callWorker(mf, "POST", "/internal/d1-apply", { rawBody: burnBody, headers: goodSig });
      check("IN.8 same nonce reused by a VALID request after the failed one -> accepted", r.status === 200, `HTTP ${r.status}`);

      // Duplicate requestId returns the stored outcome without re-applying.
      const dupReq = randomUUID();
      const dupMut = [{ type: "scene-update", jobId, sceneIndex: 0, attempt: 1, status: "dispatched" }];
      const d1 = await d1Apply(mf, dupReq, dupMut);
      const d2 = await d1Apply(mf, dupReq, dupMut);
      check(
        "IN.9 duplicate requestId -> same stored outcome, 200 both times",
        d1.status === 200 && d2.status === 200 && d1.text === d2.text,
        `first=${d1.status} second=${d2.status}`
      );

      // Unknown table delete-rows -> 400, nothing deleted.
      const jobsBefore = await retainedTotal(db);
      r = await d1Apply(mf, randomUUID(), [{ type: "delete-rows", table: "nope", ids: ["x"] }]);
      check("IN.10 delete-rows unknown table -> 400", r.status === 400, `HTTP ${r.status}`);
      check("IN.11 retained total unchanged after rejected delete", (await retainedTotal(db)) === jobsBefore, "");

      // Retention gate: delete-rows on jobs while retention disabled -> 403.
      r = await d1Apply(mf, randomUUID(), [{ type: "delete-rows", table: "jobs", ids: [jobId] }]);
      check(
        "IN.12 delete-rows jobs with retention disabled -> 403 retention-deletion-disabled",
        r.status === 403 && r.json && r.json.error === "retention-deletion-disabled",
        `HTTP ${r.status} ${r.text.slice(0, 120)}`
      );
      check("IN.13 job still present after refused delete", (await jobRow(db, jobId)) !== null, "");

      // d1-read operations.
      r = await d1Read(mf, `op=get-job&jobId=${jobId}`);
      check("IN.14 d1-read get-job -> 200 with the job", r.status === 200 && r.json && r.json.job && r.json.job.id === jobId, `HTTP ${r.status}`);
      r = await d1Read(mf, `op=list-scenes&jobId=${jobId}`);
      check("IN.15 d1-read list-scenes -> 200 with one scene", r.status === 200 && r.json && Array.isArray(r.json.scenes) && r.json.scenes.length === 1, `HTTP ${r.status}`);
      r = await d1Read(mf, "op=list-pending-jobs");
      check("IN.16 d1-read list-pending-jobs -> 200, includes the job", r.status === 200 && r.json && r.json.jobs.some((j) => j.id === jobId), `HTTP ${r.status}`);
      r = await d1Read(mf, "op=bogus");
      check("IN.17 d1-read unknown op -> 400", r.status === 400, `HTTP ${r.status}`);
      const unsigned = await callWorker(mf, "GET", `/internal/d1-read?op=get-job&jobId=${jobId}`);
      check("IN.18 d1-read without signature -> 401", unsigned.status === 401, `HTTP ${unsigned.status}`);

      // mark-expired: only after the scene succeeded; parent expires when all scenes expired.
      const expJob = newJobId();
      const expToken = newToken();
      await callWorker(mf, "POST", "/api/generate", {
        body: { jobId: expJob, mode: "single", prompt: "Expiring dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: TEST_HDRS(expToken)
      });
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId: expJob, sceneIndex: 0, attempt: 1, status: "succeeded", outputRef: "ref-x", expiresAt: Date.now() - 1000 }
      ]);
      r = await d1Apply(mf, randomUUID(), [{ type: "mark-expired", jobId: expJob, sceneIndexes: [0] }]);
      check("IN.19 mark-expired -> 200", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
      const expStored = await jobRow(db, expJob);
      check("IN.20 parent status is expired after mark-expired", expStored && expStored.status === "expired", `status=${expStored && expStored.status}`);
      r = await callWorker(mf, "GET", `/api/download?jobId=${expJob}&scene=0`, { headers: TEST_HDRS(expToken) });
      check("DL.3 download of expired scene -> 410", r.status === 410, `HTTP ${r.status}`);
      r = await callWorker(mf, "GET", `/api/status?jobId=${expJob}`, { headers: TEST_HDRS(expToken) });
      check("ST.5 expired job status reports expired, downloadUrl null", r.status === 200 && r.json && r.json.status === "expired" && r.json.downloadUrl === null, `HTTP ${r.status} ${r.text.slice(0, 200)}`);

      // list-expired-scenes sees succeeded-but-past-expiry scenes (before mark-expired).
      const expJob2 = newJobId();
      await callWorker(mf, "POST", "/api/generate", {
        body: { jobId: expJob2, mode: "single", prompt: "Expiring dragon 2", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: TEST_HDRS(newToken())
      });
      await d1Apply(mf, randomUUID(), [
        { type: "scene-update", jobId: expJob2, sceneIndex: 0, attempt: 1, status: "succeeded", outputRef: "ref-y", expiresAt: Date.now() - 1000 }
      ]);
      r = await d1Read(mf, "op=list-expired-scenes");
      check(
        "IN.21 list-expired-scenes includes the past-expiry scene",
        r.status === 200 && r.json && r.json.scenes.some((s) => s.job_id === expJob2),
        `HTTP ${r.status}`
      );

      // Retention enumeration ops (additions 25 Nov ~18:21+ WAT — design
      // gap, impl notes §10.4): list-terminal-jobs + list-expired-rate-limits.
      const DAY = 86400000;
      const enumNow = Date.now();
      const seedEnumJob = async (jobId, status, sceneStatus, sceneAgeMs, nScenes = 1) => {
        await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(
          jobId,
          JSON.stringify({
            id: jobId, createdAt: new Date(enumNow - sceneAgeMs).toISOString(),
            updatedAt: new Date(enumNow - sceneAgeMs).toISOString(),
            createdAtMs: enumNow - sceneAgeMs, status, mode: "single",
            engine: "ltx-video-2b", prompt: "enum seed", accessTokenHash: "x",
            requestIdentityHash: "x", requestIdentityVersion: "canonical-request-v1",
            dispatchState: "submitted", creationToken: randomUUID(), deploymentMode: "controlled-test"
          })
        ).run();
        for (let i = 0; i < nScenes; i++) {
          await db.prepare(
            "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, 1, ?, NULL, ?, NULL, NULL, NULL, ?)"
          ).bind(jobId, i, `${jobId}:scene-${i}:attempt-1`, sceneStatus, enumNow - sceneAgeMs).run();
        }
      };
      const termOld = newJobId();
      const termYoung = newJobId();
      const termNoScene = newJobId();
      const nonTerm = newJobId();
      await seedEnumJob(termOld, "succeeded", "succeeded", 40 * DAY, 2);
      await seedEnumJob(termYoung, "failed", "failed", 10 * DAY, 1);
      await seedEnumJob(termNoScene, "succeeded", "succeeded", 40 * DAY, 0);
      await seedEnumJob(nonTerm, "running", "running", 40 * DAY, 1);
      await db.prepare("INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind("ip-hour:expired", enumNow - 2 * 3600000, enumNow - 3600000, 7, enumNow - 3600000).run();
      await db.prepare("INSERT INTO rate_limits (key, window_start, window_end, count, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind("ip-hour:active", enumNow - 1800000, enumNow + 1800000, 3, enumNow - 1800000).run();

      r = await d1Read(mf, "op=list-terminal-jobs");
      const listed = (r.json && r.json.jobs) || [];
      const listedIds = listed.map((j) => j.id);
      const oldEntry = listed.find((j) => j.id === termOld);
      const noSceneEntry = listed.find((j) => j.id === termNoScene);
      check(
        "IN.22 list-terminal-jobs lists the seeded terminal jobs (non-terminal excluded), oldest first, null terminalAtMs last",
        r.status === 200 &&
          listedIds.includes(termOld) && listedIds.includes(termYoung) && listedIds.includes(termNoScene) &&
          !listedIds.includes(nonTerm) &&
          listedIds.indexOf(termOld) < listedIds.indexOf(termYoung) &&
          listedIds.indexOf(termYoung) < listedIds.indexOf(termNoScene),
        `HTTP ${r.status} ids=${listedIds.join(",")}`
      );
      check(
        "IN.23 list-terminal-jobs terminalAtMs is MAX(scenes.updated_at); null for a terminal job with no scenes",
        oldEntry && Math.abs(oldEntry.terminalAtMs - (enumNow - 40 * DAY)) < 60000 &&
          noSceneEntry && noSceneEntry.terminalAtMs === null,
        `old=${JSON.stringify(oldEntry)} noscene=${JSON.stringify(noSceneEntry)}`
      );
      check(
        "IN.24 list-terminal-jobs returns id/status/terminalAtMs only (no data blob)",
        listed.every((j) => j.id && j.status && !("data" in j) && Object.keys(j).sort().join(",") === "id,status,terminalAtMs"),
        `keys=${listed.map((j) => Object.keys(j).sort().join(",")).join(" | ")}`
      );
      r = await d1Read(mf, `op=list-terminal-jobs&beforeMs=${enumNow - 30 * DAY}`);
      check(
        "IN.25 list-terminal-jobs&beforeMs=<now-30d> returns only the >30-day terminal job",
        r.status === 200 && r.json && r.json.jobs.length === 1 && r.json.jobs[0].id === termOld,
        `HTTP ${r.status} n=${r.json && r.json.jobs.length}`
      );
      r = await d1Read(mf, "op=list-terminal-jobs&limit=1");
      check(
        "IN.26 list-terminal-jobs&limit=1 returns exactly one (oldest) job",
        r.status === 200 && r.json && r.json.jobs.length === 1,
        `HTTP ${r.status} n=${r.json && r.json.jobs.length}`
      );
      r = await d1Read(mf, "op=list-terminal-jobs&limit=0");
      const rBad = await d1Read(mf, "op=list-terminal-jobs&beforeMs=-1");
      check(
        "IN.27 list-terminal-jobs rejects invalid limit / beforeMs with 400",
        r.status === 400 && rBad.status === 400,
        `limit0=${r.status} beforeMs-1=${rBad.status}`
      );
      const unsignedEnum = await callWorker(mf, "GET", "/internal/d1-read?op=list-terminal-jobs");
      check("IN.28 list-terminal-jobs without signature -> 401", unsignedEnum.status === 401, `HTTP ${unsignedEnum.status}`);

      r = await d1Read(mf, "op=list-expired-rate-limits");
      check(
        "IN.29 list-expired-rate-limits returns only the expired row, oldest expiry first",
        r.status === 200 && r.json && r.json.rateLimits.length === 1 && r.json.rateLimits[0].key === "ip-hour:expired",
        `HTTP ${r.status} n=${r.json && r.json.rateLimits.length}`
      );
      r = await d1Read(mf, "op=list-expired-rate-limits&limit=1");
      const unsignedRl = await callWorker(mf, "GET", "/internal/d1-read?op=list-expired-rate-limits");
      check(
        "IN.30 list-expired-rate-limits honours limit=1 and requires a signature (401 unsigned)",
        r.status === 200 && r.json && r.json.rateLimits.length === 1 && unsignedRl.status === 401,
        `limit1=${r.status} unsigned=${unsignedRl.status}`
      );
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ Kaggle mapping (fail-closed)
  {
    console.log("\n-- Kaggle status vocabulary mapping (fail-closed) --");
    const { mf, db } = await boot({ apiPort });
    try {
      // Each case: submit returns 500 (unknown outcome) -> Worker looks the
      // execution up; the fake journal answers with the raw wire value.
      const cases = [
        ["KernelWorkerStatus.QUEUED", 202, "proceed: accepted -> 202"],
        ["KernelWorkerStatus.RUNNING", 202, "proceed: running -> 202"],
        ["KernelWorkerStatus.CANCEL_REQUESTED", 503, "hold: cancel requested -> 503, no redispatch"],
        ["KernelWorkerStatus.NEW_SCRIPT", 503, "hold: new script -> 503, no redispatch"],
        ["KernelWorkerStatus.COMPLETE", 503, "hold: complete without fileReport -> 503, no fail"],
        ["KernelWorkerStatus.CANCEL_ACKNOWLEDGED", 500, "terminal: cancel acknowledged -> job failed, 500"],
        ["KernelWorkerStatus.ERROR", 500, "terminal: error -> job failed, 500"],
        ["KernelWorkerStatus.BOGUS", 503, "unknown wire value -> 503, no redispatch"]
      ];
      for (const [wire, wantStatus, label] of cases) {
        fake.submitBehavior = "error500";
        const jobId = newJobId();
        const token = newToken();
        const execId = jobId + ":scene-0:attempt-1";
        fake.journalOverride = (id) =>
          id === execId
            ? { executionId: id, jobId, sceneIndex: 0, attempt: 1, state: wire, managerJobId: "mgr-kaggle" }
            : null;
        const subsBefore = fake.submissions.length;
        const r = await callWorker(mf, "POST", "/api/generate", {
          body: { jobId, mode: "single", prompt: "Kaggle dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
          headers: TEST_HDRS(token)
        });
        const subsAfter = fake.submissions.filter((s) => s === execId).length;
        check(
          `KG ${wire} -> ${wantStatus} (${label})`,
          r.status === wantStatus && subsAfter === 1,
          `HTTP ${r.status} submits=${subsAfter} ${r.text.slice(0, 120)}`
        );
        if (wantStatus === 500) {
          const stored = await jobRow(db, jobId);
          check(
            `KG ${wire}: job marked failed in D1`,
            stored && stored.status === "failed",
            `status=${stored && stored.status}`
          );
        }
        fake.journalOverride = null;
      }
      fake.submitBehavior = "ok";
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ T31-14 rollback
  {
    console.log("\n-- T31-14 fresh creation rolls back on scene conflict --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const before = await retainedTotal(db);
      await db
        .prepare(
          "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, 1, 1, ?, NULL, 'queued', NULL, NULL, NULL, ?)"
        )
        .bind(jobId, jobId + ":scene-1:attempt-1", Date.now())
        .run();
      const r = await callWorker(mf, "POST", "/api/generate", {
        body: {
          jobId, mode: "plan",
          scenes: [
            { index: 0, prompt: "s0" }, { index: 1, prompt: "s1" },
            { index: 2, prompt: "s2" }, { index: 3, prompt: "s3" }
          ],
          model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24
        },
        headers: TEST_HDRS(newToken())
      });
      const stored = await jobRow(db, jobId);
      const rows = await sceneRows(db, jobId);
      check(
        "T31-14 batch fails -> 500, no parent row, no NEW scene rows (orphan intact), retained unchanged apart from seed",
        r.status === 500 && stored === null && rows.length === 1 &&
          rows[0].scene_index === 1 && rows[0].attempt === 1 &&
          (await retainedTotal(db)) === before + 1,
        `HTTP ${r.status} stored=${!!stored} rows=${rows.length} total=${await retainedTotal(db)} before=${before}`
      );
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ T31-06 ceiling (A/B/C)
  {
    console.log("\n-- T31-06 retention ceiling --");
    // Sub-case A: 99,995 rows, 4-scene plans (footprint 5): exactly one succeeds.
    {
      const { mf, db } = await boot({ apiPort });
      try {
        await seedJobs(db, 99995);
        const results = await Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            callWorker(mf, "POST", "/api/generate", {
              body: {
                jobId: newJobId(), mode: "plan",
                scenes: [
                  { index: 0, prompt: "a" }, { index: 1, prompt: "b" },
                  { index: 2, prompt: "c" }, { index: 3, prompt: "d" }
                ],
                model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24
              },
              headers: TEST_HDRS(newToken(), `203.0.113.${40 + i}`)
            }))
        );
        const ok = results.filter((x) => x.status === 202);
        const refused = results.filter((x) => x.status === 503 && x.json && x.json.error === "retention-backlog");
        const total = await retainedTotal(db);
        let winnerComplete = false;
        if (ok.length === 1) {
          const winnerRows = await sceneRows(db, ok[0].json.jobId);
          winnerComplete = winnerRows.length === 4;
        }
        check(
          "T31-06A 99,995 + 4-scene plans: exactly one 202 (complete, 4 scene rows), rest 503 retention-backlog, total exactly 100,000",
          ok.length === 1 && refused.length === 2 && total === 100000 && winnerComplete,
          `statuses=${results.map((x) => x.status).join(",")} total=${total} winnerComplete=${winnerComplete}`
        );
      } finally {
        await mf.dispose();
      }
    }
    // Sub-case B: 99,998 rows, single generations (footprint 2): exactly one succeeds.
    {
      const { mf, db } = await boot({ apiPort });
      try {
        await seedJobs(db, 99998);
        const results = await Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            callWorker(mf, "POST", "/api/generate", {
              body: { jobId: newJobId(), mode: "single", prompt: "ceiling single", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
              headers: TEST_HDRS(newToken(), `203.0.113.${50 + i}`)
            }))
        );
        const ok = results.filter((x) => x.status === 202).length;
        const refused = results.filter((x) => x.status === 503 && x.json && x.json.error === "retention-backlog").length;
        check(
          "T31-06B 99,998 + singles: exactly one 202, rest 503, total exactly 100,000",
          ok === 1 && refused === 2 && (await retainedTotal(db)) === 100000,
          `statuses=${results.map((x) => x.status).join(",")} total=${await retainedTotal(db)}`
        );
      } finally {
        await mf.dispose();
      }
    }
    // Sub-case C: 99,996 rows, 4-scene plan (footprint 5): nothing fits.
    {
      const { mf, db } = await boot({ apiPort });
      try {
        await seedJobs(db, 99996);
        const jobId = newJobId();
        const r = await callWorker(mf, "POST", "/api/generate", {
          body: {
            jobId, mode: "plan",
            scenes: [
              { index: 0, prompt: "a" }, { index: 1, prompt: "b" },
              { index: 2, prompt: "c" }, { index: 3, prompt: "d" }
            ],
            model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24
          },
          headers: TEST_HDRS(newToken())
        });
        check(
          "T31-06C 99,996 + 4-scene plan: 503 retention-backlog, no parent or scene row created",
          r.status === 503 && r.json && r.json.error === "retention-backlog" &&
            (await jobRow(db, jobId)) === null &&
            (await sceneRows(db, jobId)).length === 0 &&
            (await retainedTotal(db)) === 99996,
          `HTTP ${r.status} total=${await retainedTotal(db)}`
        );
      } finally {
        await mf.dispose();
      }
    }
  }

  // ------------------------------------------------ T31-07 retention measurement
  {
    console.log("\n-- T31-07 retention byte measurement --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const data = JSON.stringify({ id: jobId, note: "héllo — 火龙", n: 1 });
      await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(jobId, data).run();
      await db
        .prepare(
          "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, 0, 1, ?, NULL, 'queued', NULL, '', NULL, ?)"
        )
        .bind(jobId, jobId + ":scene-0:attempt-1", Date.now())
        .run();
      const expectedBytes =
        Buffer.byteLength(jobId, "utf8") + Buffer.byteLength(data, "utf8") +
        (Buffer.byteLength(jobId, "utf8") +
          Buffer.byteLength(jobId + ":scene-0:attempt-1", "utf8") +
          0 + Buffer.byteLength("queued", "utf8") + 0 + 0 + 32);
      const row = await db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM scenes) AS retained_rows,
            (SELECT COALESCE(SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(data AS BLOB))), 0) FROM jobs)
            + (SELECT COALESCE(SUM(
                  LENGTH(CAST(job_id AS BLOB)) + LENGTH(CAST(execution_id AS BLOB))
                  + LENGTH(CAST(COALESCE(provider_job_id, '') AS BLOB)) + LENGTH(CAST(status AS BLOB))
                  + LENGTH(CAST(COALESCE(error, '') AS BLOB)) + LENGTH(CAST(COALESCE(output_ref, '') AS BLOB)) + 32
                ), 0) FROM scenes) AS retained_bytes`
        )
        .first();
      check(
        "T31-07 retained_bytes equals the hand-computed logical UTF-8 payload (multi-byte chars, NULLs, empty output_ref)",
        Number(row.retained_rows) === 2 && Number(row.retained_bytes) === expectedBytes,
        `rows=${row.retained_rows} bytes=${row.retained_bytes} expected=${expectedBytes}`
      );
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ RET retention at 30 days
  // Owner decision 25 Nov ~18:21 WAT (Q3 APPROVED): retention ENABLED,
  // 30 days. Supersedes the removed RET.1 (retention-disabled survival).
  // Rev 3.1 §A-3.1.3.3: the deletion test runs ONLY with enabled=true +
  // days=N set explicitly — every boot/scheduled() call below sets both.
  // Terminal age is MAX(scenes.updated_at) (see _worker.js step 1b).
  {
    console.log("\n-- RET retention at 30 days (enabled) --");
    const RETENTION_ENV = {
      NOVA_JOB_RECORD_RETENTION_ENABLED: "true",
      NOVA_JOB_RECORD_RETENTION_DAYS: "30"
    };
    const DAY = 86400000;
    const seedJob = async (db, jobId, parentStatus, sceneStatus, sceneAgeMs, nScenes = 1) => {
      const now = Date.now();
      await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(
        jobId,
        JSON.stringify({
          id: jobId, createdAt: new Date(now - sceneAgeMs).toISOString(),
          updatedAt: new Date(now - sceneAgeMs).toISOString(),
          createdAtMs: now - sceneAgeMs, status: parentStatus, mode: "single",
          engine: "ltx-video-2b", prompt: "retention seed", accessTokenHash: "x",
          requestIdentityHash: "x", requestIdentityVersion: "canonical-request-v1",
          dispatchState: "submitted", creationToken: randomUUID(), deploymentMode: "controlled-test"
        })
      ).run();
      for (let i = 0; i < nScenes; i++) {
        await db.prepare(
          "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, 1, ?, NULL, ?, NULL, NULL, NULL, ?)"
        ).bind(jobId, i, `${jobId}:scene-${i}:attempt-1`, sceneStatus, now - sceneAgeMs).run();
      }
    };

    // Sub-case 1: scheduled() deletes >30-day terminal jobs (+ scenes),
    // retains everything else; retained total drops by exactly the
    // deleted rows (ceiling accounting, §B-3.2.5.2).
    {
      const { mf, db } = await boot({ apiPort, extraBindings: RETENTION_ENV });
      try {
        const oldJob = newJobId();
        const youngJob = newJobId();
        const activeJob = newJobId();
        const boundaryYoung = newJobId();
        const boundaryOld = newJobId();
        const noSceneJob = newJobId();
        const resumeJob = newJobId();
        const orphanBadJob = newJobId();
        await seedJob(db, oldJob, "succeeded", "succeeded", 40 * DAY, 2);
        await seedJob(db, youngJob, "succeeded", "succeeded", 10 * DAY, 1);
        await seedJob(db, activeJob, "running", "running", 40 * DAY, 1);
        await seedJob(db, boundaryYoung, "succeeded", "succeeded", 30 * DAY - 3600000, 1);
        await seedJob(db, boundaryOld, "succeeded", "succeeded", 30 * DAY + 3600000, 1);
        await seedJob(db, noSceneJob, "succeeded", "succeeded", 40 * DAY, 0);
        await seedJob(db, resumeJob, "succeeded", "succeeded", 40 * DAY, 1);
        // Terminal job with no scenes and NO usable age (no updatedAt):
        // must be retained (fail closed).
        await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(
          orphanBadJob, JSON.stringify({ id: orphanBadJob, status: "succeeded" })
        ).run();
        // Simulate a crash after step 1 of the two-step deletion (scenes
        // gone, parent still present): the next sweep must resume and
        // delete the parent (index-last ordering, §B-3.2.9 analogue).
        await db.prepare("DELETE FROM scenes WHERE job_id = ?").bind(resumeJob).run();
        const totalBefore = await retainedTotal(db);
        check("RET.1a setup: 14 retained rows seeded", totalBefore === 14, `total=${totalBefore}`);
        await runScheduled(db, RETENTION_ENV);
        check(
          "RET.1b 40-day terminal job deleted with its 2 scene rows",
          (await jobRow(db, oldJob)) === null && (await sceneRows(db, oldJob)).length === 0,
          ""
        );
        check(
          "RET.1c 30-day-plus-1h terminal job deleted (strictly-more-than-30-days rule)",
          (await jobRow(db, boundaryOld)) === null && (await sceneRows(db, boundaryOld)).length === 0,
          ""
        );
        check(
          "RET.1d 10-day terminal job retained with its scene row",
          (await jobRow(db, youngJob)) !== null && (await sceneRows(db, youngJob)).length === 1,
          ""
        );
        check(
          "RET.1e 40-day NON-terminal job retained with its scene row",
          (await jobRow(db, activeJob)) !== null && (await sceneRows(db, activeJob)).length === 1,
          ""
        );
        check(
          "RET.1f 30-day-minus-1h terminal job retained (boundary: exactly 30 days is not yet eligible)",
          (await jobRow(db, boundaryYoung)) !== null && (await sceneRows(db, boundaryYoung)).length === 1,
          ""
        );
        check(
          "RET.1g terminal job with no scene rows and a 40-day updatedAt is deleted (fallback age; only reachable via an interrupted deletion)",
          (await jobRow(db, noSceneJob)) === null,
          ""
        );
        check(
          "RET.1h resumed deletion: parent with already-deleted scenes is deleted by the sweep",
          (await jobRow(db, resumeJob)) === null,
          ""
        );
        check(
          "RET.1i ceiling accounting: retained total drops by exactly the 7 deleted rows (14 -> 7)",
          (await retainedTotal(db)) === 7,
          `total=${await retainedTotal(db)}`
        );
        check(
          "RET.1j terminal job with no scenes and no usable age is retained (fail closed)",
          (await jobRow(db, orphanBadJob)) !== null,
          ""
        );
      } finally {
        await mf.dispose();
      }
    }

    // Sub-case 2: delete-rows gate with retention enabled (30 days).
    {
      const { mf, db } = await boot({ apiPort, extraBindings: RETENTION_ENV });
      try {
        const jobId = newJobId();
        await seedJob(db, jobId, "succeeded", "succeeded", 40 * DAY, 1);
        const r = await d1Apply(mf, randomUUID(), [{ type: "delete-rows", table: "scenes", ids: [jobId + ":scene-0:attempt-1"] }]);
        check(
          "RET.2a delete-rows scenes with retention enabled -> 200",
          r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`
        );
        check("RET.2b scene row gone after enabled delete-rows", (await sceneRows(db, jobId)).length === 0, "");
        const r2 = await d1Apply(mf, randomUUID(), [{ type: "delete-rows", table: "jobs", ids: [jobId] }]);
        check(
          "RET.2c delete-rows jobs with retention enabled -> 200, parent gone",
          r2.status === 200 && (await jobRow(db, jobId)) === null,
          `HTTP ${r2.status}`
        );
      } finally {
        await mf.dispose();
      }
    }

    // Sub-case 3: enabled WITHOUT a period set still refuses (config
    // incomplete — §A-3.1.3.2: both values are set together).
    {
      const { mf, db } = await boot({ apiPort, extraBindings: { NOVA_JOB_RECORD_RETENTION_ENABLED: "true" } });
      try {
        const jobId = newJobId();
        await seedJob(db, jobId, "succeeded", "succeeded", 40 * DAY, 1);
        const r = await d1Apply(mf, randomUUID(), [{ type: "delete-rows", table: "jobs", ids: [jobId] }]);
        check(
          "RET.3a enabled but days unset: delete-rows jobs -> 403 retention-deletion-disabled",
          r.status === 403 && r.json && r.json.error === "retention-deletion-disabled",
          `HTTP ${r.status} ${r.text.slice(0, 120)}`
        );
        check("RET.3b job still present after refused delete", (await jobRow(db, jobId)) !== null, "");
        await runScheduled(db, { NOVA_JOB_RECORD_RETENTION_ENABLED: "true" });
        check("RET.3c enabled but days unset: scheduled() deletes nothing", (await jobRow(db, jobId)) !== null, "");
      } finally {
        await mf.dispose();
      }
    }

    // Sub-case 4: ceiling accounting — retention deletion frees capacity.
    {
      const { mf, db } = await boot({ apiPort, extraBindings: RETENTION_ENV });
      try {
        await seedJobs(db, 99998);
        const oldJob = newJobId();
        await seedJob(db, oldJob, "succeeded", "succeeded", 40 * DAY, 1);
        check("RET.4a retained total is exactly 100,000", (await retainedTotal(db)) === 100000, `total=${await retainedTotal(db)}`);
        const refused = await callWorker(mf, "POST", "/api/generate", {
          body: { jobId: newJobId(), mode: "single", prompt: "ceiling after retention", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
          headers: TEST_HDRS(newToken())
        });
        check(
          "RET.4b at 100,000 rows generation is refused 503 retention-backlog",
          refused.status === 503 && refused.json && refused.json.error === "retention-backlog",
          `HTTP ${refused.status}`
        );
        await runScheduled(db, RETENTION_ENV);
        check("RET.4c scheduled() retention deletion drops the total to 99,998", (await retainedTotal(db)) === 99998, `total=${await retainedTotal(db)}`);
        const ok = await callWorker(mf, "POST", "/api/generate", {
          body: { jobId: newJobId(), mode: "single", prompt: "ceiling after retention", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
          headers: TEST_HDRS(newToken())
        });
        check(
          "RET.4d after deletion frees 2 rows, generation is accepted 202",
          ok.status === 202,
          `HTTP ${ok.status} ${ok.text.slice(0, 120)}`
        );
      } finally {
        await mf.dispose();
      }
    }
  }

  // ------------------------------------------------ T31-17 masking + repair CLI
  {
    console.log("\n-- T31-17 retry row must not mask a missing attempt-1 row --");
    const { mf, db } = await boot({ apiPort });
    try {
      const jobId = newJobId();
      const token = newToken();
      const tokenHash = sha256Hex(token);
      // The duplicate below must carry the real canonical hash of its own
      // body, or the identity check (correctly) returns 409.
      const dupBody = {
        jobId, mode: "plan",
        scenes: [
          { index: 1, prompt: "s1" }, { index: 2, prompt: "s2" },
          { index: 3, prompt: "s3" }, { index: 4, prompt: "s4" }
        ],
        model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24
      };
      await db.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").bind(
        jobId,
        JSON.stringify({
          id: jobId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          createdAtMs: Date.now(), status: "queued", mode: "plan", engine: "ltx-video-2b",
          scenes: [
            { index: 1, prompt: "s1" }, { index: 2, prompt: "s2" },
            { index: 3, prompt: "s3" }, { index: 4, prompt: "s4" }
          ],
          accessTokenHash: tokenHash, requestIdentityHash: sha256Hex(canonicalFor(dupBody)),
          requestIdentityVersion: "canonical-request-v1",
          dispatchState: "intent-recorded", creationToken: randomUUID(),
          deploymentMode: "controlled-test"
        })
      ).run();
      const seed = [
        [1, 2, "failed"], [2, 1, "queued"], [3, 1, "queued"], [4, 1, "queued"]
      ];
      for (const [idx, att, st] of seed) {
        await db.prepare(
          "INSERT INTO scenes (job_id, scene_index, attempt, execution_id, provider_job_id, status, error, output_ref, expires_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)"
        ).bind(jobId, idx, att, `${jobId}:scene-${idx}:attempt-${att}`, st, Date.now()).run();
      }
      // Duplicate generate must return the existing job unchanged, with no
      // dispatch recovery attempted (suspended while incomplete).
      const subsBefore = fake.submissions.length;
      const r = await callWorker(mf, "POST", "/api/generate", { body: dupBody, headers: TEST_HDRS(token) });
      check(
        "T31-17a duplicate returns 200 with the existing job; scene set still 4 rows (2 missing attempt-1 for index 1)",
        r.status === 200 && (await sceneRows(db, jobId)).length === 4,
        `HTTP ${r.status} rows=${(await sceneRows(db, jobId)).length}`
      );
      check(
        "T31-17b no dispatch recovery attempted for the incomplete job",
        fake.submissions.length === subsBefore,
        `submissions delta=${fake.submissions.length - subsBefore}`
      );
      // scheduled(): flag the incomplete set (per-index attempt-1).
      await runScheduled(db);
      const flagged = await jobRow(db, jobId);
      check(
        "T31-17c scheduled() flags incomplete-scene-set with missing index [1]",
        flagged && Array.isArray(flagged.incompleteSceneSet) &&
          flagged.incompleteSceneSet.length === 1 && flagged.incompleteSceneSet[0] === 1,
        `flag=${JSON.stringify(flagged && flagged.incompleteSceneSet)}`
      );
      // Repair via the operator CLI against the miniflare Worker (through
      // the dispatchFetch HTTP shim).
      let cliOk = false;
      let proxy = null;
      try {
        proxy = await startDispatchProxy(mf);
        const cli = await runCli([
          path.join(ROOT, "bin/repair-scene-set.mjs"),
          "--worker-origin", `http://localhost:${proxy.port}`,
          "--job-id", jobId,
          "--api-secret", TEST_SECRET
        ]);
        console.log("  repair CLI stdout: " + (cli.stdout || "").trim().split("\n").join(" | "));
        if (cli.stderr) console.log("  repair CLI stderr: " + cli.stderr.trim().split("\n").join(" | "));
        cliOk = cli.status === 0;
        check("T31-17d repair CLI exits 0", cliOk, `exit=${cli.status}`);
      } catch (e) {
        check("T31-17d repair CLI exits 0", false, String(e && e.message));
      } finally {
        if (proxy) proxy.server.close();
      }
      const after = await sceneRows(db, jobId);
      const has11 = after.some((s) => s.scene_index === 1 && s.attempt === 1);
      check(
        "T31-17e repair inserted exactly one row (job,1,1); set now complete (5 rows)",
        has11 && after.length === 5,
        `rows=${after.length} has(1,1)=${has11}`
      );
      await runScheduled(db);
      const cleared = await jobRow(db, jobId);
      check(
        "T31-17f further scheduled() run clears the flag once the set is complete",
        cleared && cleared.incompleteSceneSet === undefined,
        `flag=${JSON.stringify(cleared && cleared.incompleteSceneSet)}`
      );
      // (RET.1 was here: retention-disabled survival of a 40-day-old job.
      // Removed 25 Nov ~18:21 WAT — Q3 APPROVED retention enabled/30 days;
      // retention behaviour is now asserted in the dedicated RET block
      // below, with the enabled configuration set explicitly.)
    } finally {
      await mf.dispose();
    }
  }

  // ------------------------------------------------ submit failure paths
  {
    console.log("\n-- Submit failure / recovery --");
    const { mf, db } = await boot({ apiPort });
    try {
      // no-capacity -> compensation: job failed, 503, no 202.
      fake.submitBehavior = "no-capacity";
      const jobId = newJobId();
      const token = newToken();
      let r = await callWorker(mf, "POST", "/api/generate", {
        body: { jobId, mode: "single", prompt: "No capacity dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 },
        headers: TEST_HDRS(token)
      });
      check(
        "SUB.1 submit no-capacity -> 503 capacity_unavailable, job marked failed",
        r.status === 503 && r.json && r.json.error === "capacity_unavailable" &&
          (await jobRow(db, jobId)).status === "failed",
        `HTTP ${r.status} status=${(await jobRow(db, jobId))?.status}`
      );
      // error500 + journal absent -> one identical re-submit, then 503 unknown.
      fake.submitBehavior = "error500";
      fake.journalOverride = () => null;
      const jobId2 = newJobId();
      const token2 = newToken();
      const body2 = { jobId: jobId2, mode: "single", prompt: "Lost dragon", model: "ltx-video-2b", frames: 121, resolution: "1024x576", fps: 24 };
      r = await callWorker(mf, "POST", "/api/generate", { body: body2, headers: TEST_HDRS(token2) });
      const subsForJob = fake.submissions.filter((s) => s === jobId2 + ":scene-0:attempt-1").length;
      check(
        "SUB.2 unknown outcome + journal absent -> exactly one identical re-submit, then 503, job stays intent-recorded",
        r.status === 503 && subsForJob === 2 &&
          (await jobRow(db, jobId2)).dispatchState === "intent-recorded",
        `HTTP ${r.status} submits=${subsForJob} dispatchState=${(await jobRow(db, jobId2))?.dispatchState}`
      );
      // Duplicate of the same job while journal now shows dispatched.
      // Recovery path 1 re-submits with the identical idempotency keys
      // (Rev 3.2 §B-3.2.2.2: "the re-submit returns the existing manager
      // jobs") — so one further submit CALL is expected; what must not
      // happen is a second manager job. The re-submit fails (error500),
      // the journal lookup confirms dispatched, and the job proceeds.
      fake.journalOverride = (id) =>
        id === jobId2 + ":scene-0:attempt-1"
          ? { executionId: id, jobId: jobId2, sceneIndex: 0, attempt: 1, state: "dispatched", managerJobId: "mgr-lost" }
          : null;
      const mgrBefore = fake.managerJobs.size;
      r = await callWorker(mf, "POST", "/api/generate", { body: body2, headers: TEST_HDRS(token2) });
      const rows2 = await sceneRows(db, jobId2);
      check(
        "SUB.3 duplicate while journal shows dispatched -> 202, no second manager job, provider_job_id from journal",
        r.status === 202 && fake.managerJobs.size === mgrBefore &&
          (await jobRow(db, jobId2)).dispatchState === "submitted" &&
          rows2.length === 1 && rows2[0].provider_job_id === "mgr-lost",
        `HTTP ${r.status} mgrDelta=${fake.managerJobs.size - mgrBefore} provider=${rows2[0] && rows2[0].provider_job_id}`
      );
      fake.journalOverride = null;
      fake.submitBehavior = "ok";
    } finally {
      await mf.dispose();
    }
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks: " + failures.join(", "));
    process.exitCode = 1;
  }
} finally {
  fake.close();
}
