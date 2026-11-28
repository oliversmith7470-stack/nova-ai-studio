// NOVA AI Studio — Kaggle GPU connection design v4: NEXORA acceptance
// tests T-V1–T-V33 (design §8.2) + the identical canonical-request-v1
// vectors (nexora/gpu_jobs/signing.py TEST_VECTORS).
//
// Shape of the coverage:
//   - Real HTTP over loopback (api.start() + fetch) for the auth branch,
//     the new routes (attest / revoke / jobs), the NEXORA-form capacity
//     response, and the submit branch — signed exactly like the real
//     NEXORA client (canonical-request-v1 headers). The vector test
//     below proves the signing functions match Python's literals, so
//     using them to sign test requests is equivalent to using the real
//     client; the circularity is broken by the vectors, not by trust.
//   - In-process dispatch.submitNexora for the acceptance arithmetic
//     (ledger, staging, idempotency, halt, licence) — same code path
//     the route calls, without the HTTP round-trip.
//   - Pure-function checks (computeAdmission, requiredVramGb/admitJob,
//     verifyActivationConfigFile) where the design's arithmetic is the
//     thing under test.
//
// JS canonicalisation note (Python-float trap): the test helper's
// canonicaliseJson renders guidance 1.0 as `1` (JSON.stringify has no
// float/int distinction). The server hashes the RAW request body, so a
// test-internal hash is self-consistent either way — and the wire body
// the real Python client sends carries `1.0`. Cross-language agreement
// is proven ONLY by the literal-vector test below (the canonical_body
// string is copied verbatim from signing.py, `1.0` included), never by
// re-canonicalising a JS object and comparing it with Python's.
//
// No live Kaggle, no real secrets (every secret here is a clearly-fake
// test vector), no network beyond loopback. The personal executor's
// transport is a stub (support.mjs stubKaggleTransport) whose status
// stays 'running', so an accepted job's start promise stays pending —
// a test job never completes, which is also why T-V19's orphan is
// observable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import http from 'node:http';

import { createApiServer } from '../src/api-server.js';
import {
  makeApi,
  submitBody,
  seedJobForSubmit,
  MemoryD1Client,
} from '../src/api-server/test/support.mjs';
import { createStorage } from '../src/storage/index.js';
import {
  canonicaliseJson,
  canonicalRequestHash,
  sha256HexBytes,
  nexoraSigningHeaders,
  signNexoraRequest,
  buildCanonicalRequest,
  signNexoraResponse,
  verifyNexoraResponseSignature,
  freshNexoraNonce,
  nowIso,
} from '../src/api-server/nexora-auth.js';
import {
  issueAttestation,
  revokeAttestation,
  validateAttestation,
  createNexoraAttestationVerifier,
} from '../src/api-server/nexora-attestation.js';
import { verifyNexoraAuth } from '../src/api-server/nexora-auth.js';
import { SqliteNonceStore } from '../src/api-server/nonce-store.js';
import {
  computeAdmission,
} from '../src/api-server/per-origin-ledger.js';
import {
  commissioningAuthorised,
} from '../src/api-server/commissioning.js';
import { licenceSatisfiedFor } from '../src/api-server/licence.js';
import {
  readActivationConfigWithHash,
  verifyActivationConfigFile,
} from '../src/api-server/activation.js';
import { signApiCall, processStartMs } from '../src/api-server/auth.js';
import { checkStage2Safe } from '../src/data-guard.js';
import { weekStartMs } from '../src/hours.js';
import { getStagingManifest } from '../src/staging.js';
import {
  buildLtxNotebook,
  LtxKaggleExecutor,
  LTX_KEYFRAMES_DATASET,
} from '../src/engines/ltx-executor.js';
import { CHECKPOINT_SHA256 } from '../src/phase6/config.js';
import {
  requiredVramGb,
  admitJob,
} from '../src/phase6/resource-profiles.js';
import { KaggleExecutor } from '../src/kaggle-executor.js';

// Clearly-fake test secrets only — never real ones.
const TEST_SIGNING_SECRET = 'test-signing-secret';
const TEST_OWNER_TOKEN_ID = 'owner-token-v1';
const NEXORA_API_SECRET = 'test-nexora-api-secret';
const NEXORA_SIGNING_SECRET = 'test-nexora-signing-secret';

const NEXORA_SESSION = 'test-session-0001';

// -- canonical-request-v1 test vectors (verbatim from
// nexora/gpu_jobs/signing.py TEST_VECTORS — both repos verify the same
// values; TEST_VECTORS_SHA256 = 70e917c6…c50e) --------------------------
const VECTOR_METHOD = 'POST';
const VECTOR_PATH = '/internal/submit';
const VECTOR_TIMESTAMP = '2026-11-27T16:00:00+00:00';
const VECTOR_NONCE = 'test-nonce-0001';
const VECTOR_SIGNING_SECRET = 'test-signing-secret-nexora-v1-FAKE';
const VECTOR_CANONICAL_BODY =
  '{"attestation_id":"att-test-0001","audience":"personal",'
  + '"jobId":"nexora:test-job-0001","keyframe_hashes":'
  + '{"first":"' + 'a'.repeat(64)
  + '","last":"' + 'b'.repeat(64)
  + '"},"ltx_parameters":{"engine":"ltx-video-2b",'
  + '"frames":121,"guidance":1.0,"height":576,"seed":42,'
  + '"steps":8,"width":1024},"origin":"nexora","prompt":'
  + '"Test prompt for canonical vectors.",'
  + '"purpose":"owner_personal_work",'
  + '"requester":"authenticated_owner",'
  + '"target_channel_id":"test-channel",'
  + '"target_channel_status":"non_monetised",'
  + '"third_party_work":false}';
const VECTOR_BODY_SHA256 = '78ea14fc0dd1f80f84cbc9b9bb663219de4558f5f6a5b0b66a62d446f92bc788';
const VECTOR_CANONICAL_REQUEST =
  'POST\n/internal/submit\n'
  + '78ea14fc0dd1f80f84cbc9b9bb663219de4558f5f6a5b0b66a62d446f92bc788\n'
  + '2026-11-27T16:00:00+00:00\ntest-nonce-0001';
const VECTOR_SIGNATURE = '9e7ba62c7a4fae3ccdc96e05e88f60c07dac8c1f60db0c58cc36ce5ca0221961';
const VECTOR_SHA256 = '70e917c6b34a9ae9da0a58933a21cd66f5bd06f5f210831186d27478fe60c50e';

// -- helpers ---------------------------------------------------------------

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-nexora-accept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeActivationConf(dir, text) {
  const p = path.join(dir, 'activation.conf');
  fs.writeFileSync(p, text, 'utf8');
  // v13 §3.3: the strict re-verification requires mode 0440 and the
  // expected owner/group — a temp conf left at the 0644 default would
  // latch activation invalid on the first capacity read. The helper
  // passes the test process's uid/gid as the expected values (see
  // nexoraApi's fileAccess below).
  fs.chmodSync(p, 0o440);
  return p;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// -- minimal PNG builder (v13 §5.7: staged keyframes must be real,
// decodable images — the old fake text bytes are refused
// 'invalid-image'). Builds a 1×1 RGB PNG with the given pixel, with
// correct chunk CRCs. -----------------------------------------------
const _CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = deflateSync(Buffer.from([0x00, r, g, b])); // filter 0 + one RGB pixel
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Boot a production API with the personal executor, the NEXORA wiring,
// ample storage, and (unless licence === false) a licence determination
// for the LTX checkpoint. Mirrors activation-capacity.test.mjs's
// personalApi, plus the NEXORA config. Returns the makeApi context
// ({ api, d1, cleanup }) plus the fake keyframes + their hashes and the
// licence record.
async function nexoraApi(t, {
  personalFlag = true,
  licence = true,
  capHours,
  jobBudgetHours,
  seedHeartbeat = true,
  now,
  // v13 §6.2: reconcile by default (Q_kaggle = 30, D = 0 at boot).
  // Pass reconciled: false for the quota-unreconciled cases.
  reconciled = true,
} = {}) {
  const dir = tempDir(t);
  const confPath = writeActivationConf(dir,
    `NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=${personalFlag}\n`);
  const storeRoot = path.join(dir, 'store');
  fs.mkdirSync(storeRoot, { recursive: true });
  const storage = createStorage({
    rootDir: storeRoot,
    capacityProbe: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
  });
  // v13 §5.7: REAL 1×1 PNG keyframes — the staging store verifies
  // image validity, so the old fake text bytes are refused.
  const keyframes = {
    first: makePng(0x11, 0x22, 0x33),
    last: makePng(0x44, 0x55, 0x66),
  };
  const keyframeHashes = {
    first: sha256HexBytes(keyframes.first),
    last: sha256HexBytes(keyframes.last),
  };
  const ctx = await makeApi({
    mode: 'production',
    executor: false,
    activationConfigPath: confPath,
    // v13 §3.3: the temp conf is 0440, owned by the test process —
    // the expected values match what the helper wrote, so the strict
    // reader verifies clean (the 0440 rule itself is covered at the
    // unit level in T-V13/T-V27 with explicit expectations).
    fileAccess: {
      ownerUid: process.getuid(),
      groupGid: process.getgid(),
      mode: 0o440,
      parentUid: process.getuid(),
    },
    signingSecret: TEST_SIGNING_SECRET,
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    kaggleCredentialPresent: true,
    personalExecutor: 'kaggle-t4',
    seedHeartbeat,
    storage,
    // v13 §5.5: the API event log goes to a temp file in tests, never
    // the production /var/lib/nova-api/api-events.log.
    apiEventLogPath: path.join(dir, 'api-events.log'),
    novaApiSecretNexora: NEXORA_API_SECRET,
    novaSigningSecretNexora: NEXORA_SIGNING_SECRET,
    // v13 §5.7: the staging store (push model) lives in the temp dir.
    stagingDir: path.join(dir, 'staging'),
    nexoraWeeklyCapHours: capHours,
    nexoraJobBudgetHours: jobBudgetHours,
    now,
    // v13 §3.5/§3.4: the file-based permit + licence record live in
    // the temp dir in tests.
    commissioningPermitPath: path.join(dir, 'commissioning-permit.json'),
    licenceDeterminationPath: path.join(dir, 'licence-determination.json'),
  });
  // v13 §6.2: a ledger with no valid reconciliation refuses every
  // NEXORA submit ('quota-unreconciled'), so the helper reconciles by
  // default (Q_kaggle = 30, D = 0 at boot — the same arithmetic as
  // v4). Tests for the unreconciled cases pass { reconciled: false }.
  if (reconciled !== false) {
    ctx.api.reconcileQuota({ kaggleRemainingHours: 30 });
  }
  if (licence) {
    ctx.licence = ctx.api.setLicenceDetermination({
      kind: 'owner-determination',
      licenceTextSha256: 'a'.repeat(64),
      checkpointSha256: CHECKPOINT_SHA256,
      evidenceRef: 'test-evidence',
      determinedBy: 'test-operator',
    });
  }
  ctx.keyframes = keyframes;
  ctx.keyframeHashes = keyframeHashes;
  ctx.confPath = confPath;
  ctx.permitPath = path.join(dir, 'commissioning-permit.json');
  ctx.licencePath = path.join(dir, 'licence-determination.json');
  return ctx;
}

// A NEXORA submit body for one jobId + attestation, with the fake
// keyframe hashes. Overrides replace whole fields (ltx_parameters
// included — a tampered LTX set is one object, not a merge).
function nexoraSubmitBody(jobId, attestationId, keyframeHashes, overrides = {}) {
  return {
    jobId,
    audience: 'personal',
    origin: 'nexora',
    purpose: 'owner_personal_work',
    requester: 'authenticated_owner',
    third_party_work: false,
    target_channel_id: 'test-channel',
    target_channel_status: 'non_monetised',
    ltx_parameters: { engine: 'ltx-video-2b', frames: 121, width: 1024, height: 576, steps: 8, guidance: 1.0, seed: 42 },
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    keyframe_hashes: { ...keyframeHashes },
    attestation_id: attestationId,
    ...overrides,
  };
}

function submitBodyText(body) {
  return canonicaliseJson(body);
}

// Issue an attestation in-process (the registry, not the route — the
// route is covered by the HTTP tests). Returns the attestation record.
function attestInProcess(api, sessionId = NEXORA_SESSION, nowMs = Date.now()) {
  const issued = issueAttestation(api.apiState, {
    clientId: 'nexora-service',
    sessionId,
    restrictionTextVersion: 'v1',
    nowMs,
  });
  assert.equal(issued.ok, true, `attest failed: ${issued.reason}`);
  return issued.attestation;
}

// Sign a request exactly like the real NEXORA client
// (canonical-request-v1 headers). Fresh timestamp + nonce per call.
function nexoraHeaders(method, path, bodyText, {
  apiSecret = NEXORA_API_SECRET,
  signingSecret = NEXORA_SIGNING_SECRET,
  nonce = freshNexoraNonce(),
  timestamp = nowIso(),
} = {}) {
  return {
    headers: nexoraSigningHeaders({ signingSecret, apiSecret, method, path, body: bodyText, timestamp, nonce }),
    nonce,
    timestamp,
  };
}

async function httpJson(port, method, path, { bodyText = '', headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : bodyText,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// Stage one keyframe via the push route (v13 §5.7), exactly like the
// real NEXORA client: signed POST /internal/stage?jobId=<url-encoded>,
// body = file bytes, X-Sha256 + X-Size headers,
// application/octet-stream. The signed path is the full request-target
// including the query string.
async function stageKeyframe(port, jobId, bytes, { sha256, size } = {}) {
  const path = `/internal/stage?jobId=${encodeURIComponent(jobId)}`;
  const { headers } = nexoraHeaders('POST', path, bytes);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Sha256': sha256 ?? sha256HexBytes(bytes),
      'X-Size': String(size ?? bytes.length),
      ...headers,
    },
    body: bytes,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// Stage both keyframes for a submit IN-PROCESS (through the staging
// store directly — the dispatch-level tests never listen, so they
// cannot use the HTTP route; the HTTP route itself is covered by
// T-V26). The test keyframes are fixed (makePng 0x11/0x22/0x33 +
// 0x44/0x55/0x66 — the same bytes nexoraApi puts in ctx.keyframes),
// so only the api object + body are needed; the claimed hashes come
// from the body, exactly as the real client sends them.
function stageForSubmit(api, body) {
  const store = api.dispatch.stagingStore;
  const bytes = { first: makePng(0x11, 0x22, 0x33), last: makePng(0x44, 0x55, 0x66) };
  for (const slot of ['first', 'last']) {
    const staged = store.stage({
      jobId: body.jobId,
      keyId: 'nexora-v1',
      bytes: bytes[slot],
      sha256: body.keyframe_hashes[slot],
      size: bytes[slot].length,
    });
    assert.equal(staged.ok, true, `stage ${slot} failed: ${staged.reason}`);
  }
}

// A raw POST with an explicit (possibly lying) Content-Length, for
// the 10 MB pre-check / abort paths fetch cannot express (fetch sets
// Content-Length from the body and forbids overriding it). Writes
// respect backpressure (await drain): blasting all chunks at once
// overruns the server's abort — the server answers 413 mid-upload
// while the client is still pushing, and the socket errors instead
// of delivering the 413.
function rawStagePost(port, path, headers, chunks) {
  return new Promise((resolve) => {
    let settled = false;
    let responded = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      // agent: false — no keep-alive reuse: a half-sent oversized
      // body (case (i)) leaves its socket unusable, and the next raw
      // request on the same socket would be parsed as a continuation
      // of that body (400) instead of a fresh request.
      agent: false,
      host: '127.0.0.1', port, path, method: 'POST', headers,
    }, (res) => {
      // The server answered (e.g. the 413 abort) — stop uploading:
      // further chunked data on this socket is parsed as a garbage
      // next request and the server answers 400 for it.
      responded = true;
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    // A write error after the server has already answered (e.g. the
    // 10 MB abort closing the socket mid-upload) resolves as a failed
    // request — the assertions on status catch it loudly.
    req.on('error', () => done({ status: 0, text: '' }));
    (async () => {
      for (const c of chunks) {
        if (settled || responded) break;
        if (!req.write(c)) {
          await new Promise((r) => {
            const onDone = () => {
              req.removeListener('drain', onDone);
              req.removeListener('error', onDone);
              req.removeListener('response', onDone);
              r();
            };
            req.once('drain', onDone);
            req.once('error', onDone);
            req.once('response', onDone);
          });
        }
      }
      try { req.end(); } catch { /* socket already gone */ }
    })();
  });
}

// The success-path NEXORA submit: stage both keyframes first, then
// submit in-process. Tests that expect a refusal BEFORE the staging
// step (auth / licence / activation / halt / quota / queue-full) may
// use it too — the in-process stage has no such checks, so the submit
// still refuses at the right step. Only the T-V26 staging tests
// submit WITHOUT staging (that is the point of the test).
function submitNexora(api, body) {
  stageForSubmit(api, body);
  return api.dispatch.submitNexora(body, submitBodyText(body));
}

// A Worker-path personal body (commissioning / NOVA-admission tests).
function workerPersonalBody(label, overrides = {}) {
  const body = submitBody(label);
  return {
    ...body,
    deploymentMode: 'production',
    audience: 'personal',
    nonCommercialPurpose: 'proof',
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    ...overrides,
  };
}

// Seed the HoursTracker (C_N) and the ledger (C_X) directly, for the
// arithmetic tests. Both use the Saturday-week start.
function seedConsumedN(api, hours, nowMs = Date.now()) {
  api.manager.store.mutate((s) => {
    s.providerState['kaggle-t4'] = {
      weekStart: weekStartMs(nowMs),
      hoursUsedThisWeek: hours,
    };
  });
}

function seedConsumedX(api, hours, nowMs = Date.now()) {
  api.manager.store.mutate((s) => {
    const weekStart = weekStartMs(nowMs);
    if (!s.nexoraLedger || s.nexoraLedger.weekStart !== weekStart) {
      s.nexoraLedger = {
        version: 1,
        weekStart,
        consumedX: 0,
        reservedX: 0,
        commissioning: { consumed: 0, reserved: 0 },
        reservations: {},
        reconciliation: null,
      };
    }
    s.nexoraLedger.consumedX = hours;
  });
}

function managerJobFor(api, jobId) {
  const jobs = api.manager.store.state.jobs ?? {};
  return Object.values(jobs).find((j) => j.params?.jobId === jobId) ?? null;
}

// -- canonical-request-v1 vectors (identical on both sides) ---------------

test('canonical vectors: body hash, canonical request, signature, and vectors SHA-256 match signing.py exactly', () => {
  // The canonical_body string is copied VERBATIM from signing.py
  // (guidance written 1.0) — never re-canonicalised from a JS object,
  // which would render 1.0 as 1.
  assert.equal(canonicalRequestHash(VECTOR_CANONICAL_BODY), VECTOR_BODY_SHA256);
  assert.equal(
    buildCanonicalRequest({
      method: VECTOR_METHOD,
      path: VECTOR_PATH,
      body: VECTOR_CANONICAL_BODY,
      timestamp: VECTOR_TIMESTAMP,
      nonce: VECTOR_NONCE,
    }),
    VECTOR_CANONICAL_REQUEST,
  );
  assert.equal(
    signNexoraRequest({
      signingSecret: VECTOR_SIGNING_SECRET,
      method: VECTOR_METHOD,
      path: VECTOR_PATH,
      body: VECTOR_CANONICAL_BODY,
      timestamp: VECTOR_TIMESTAMP,
      nonce: VECTOR_NONCE,
    }),
    VECTOR_SIGNATURE,
  );
  // The §5.8 hash INCLUDES attestation_id (v4 rule — the v5 narrowing
  // is NOT applied here): the vector payload carries att-test-0001
  // and its hash is the recorded one.
  assert.equal(
    canonicalRequestHash(canonicaliseJson({
      body_sha256: VECTOR_BODY_SHA256,
      canonical_request: VECTOR_CANONICAL_REQUEST,
      canonical_request_hash: VECTOR_BODY_SHA256,
      signature: VECTOR_SIGNATURE,
    })),
    VECTOR_SHA256,
  );
});

// -- T-V1: accepted NEXORA-origin personal submit --------------------------

test('T-V1: NEXORA-origin personal submit with valid secrets + fresh attestation is accepted; manager job created, reservation held, dispatched to kaggle-t4', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(out.body.jobId, jobId);
    assert.equal(out.body.dispatchState, 'slot-claimed');
    assert.match(out.body.canonical_request_hash, /^[0-9a-f]{64}$/);
    // The manager job exists, is personal + NEXORA-origin, and was
    // dispatched to kaggle-t4 (providerId is set by dispatchNext).
    const job = managerJobFor(api, jobId);
    assert.ok(job, 'manager job exists');
    assert.equal(job.params.audience, 'personal');
    assert.equal(job.params.origin, 'nexora');
    assert.equal(job.providerId, 'kaggle-t4');
    assert.equal(job.params.nexoraAttestationId, att.attestation_id);
    assert.equal(job.params.nexoraSessionId, NEXORA_SESSION);
    // The two attestation systems stay separate: no round-2
    // personalAttestation, no ownerTokenId, no nonCommercialPurpose.
    assert.equal(job.params.personalAttestation, undefined);
    assert.equal(job.params.ownerTokenId, undefined);
    assert.equal(job.params.nonCommercialPurpose, undefined);
    // The ledger reservation is held (0.5 h) and the queue bound
    // counts the in-flight job.
    const snap = api.nexoraLedger.snapshot();
    assert.equal(snap.reservedX, 0.5);
    assert.equal(snap.consumedX, 0);
    assert.equal(api.nexoraLedger.personalQueueDepth(), 1);
    // The journal records the acceptance WITHOUT the prompt text.
    const entry = api.dispatch.journalEntry(jobId);
    assert.ok(entry, 'journal entry exists');
    assert.equal(entry.audience, 'personal');
    assert.equal(entry.origin, 'nexora');
    assert.equal(entry.attestation_id, att.attestation_id);
    assert.equal(entry.canonical_request_hash, out.body.canonical_request_hash);
    assert.deepEqual(entry.keyframe_hashes, keyframeHashes);
    assert.equal(entry.reservation.hours, 0.5);
    assert.equal(entry.reservation.storageBytes, 200 * 1024 * 1024);
    assert.equal(JSON.stringify(entry).includes('A dragon rests'), false, 'prompt text is never recorded');
  } finally {
    await cleanup();
  }
});

// -- T-V2 / T-V3: attestation gates ----------------------------------------

test('T-V2: missing attestation is refused before any manager job, reservation, or dispatch', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, 'att-never-issued', keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 403);
    assert.equal(out.body.error, 'attestation-refused');
    assert.equal(out.body.reason, 'attestation-unknown');
    assert.equal(managerJobFor(api, jobId), null);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    assert.equal(api.dispatch.journalEntry(jobId), null);
  } finally {
    await cleanup();
  }
});

test('T-V3: stale and revoked attestations are refused, as T-V2', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    // Stale: expire the record in the registry, then submit.
    const stale = attestInProcess(api, 'session-stale');
    api.apiState.mutate((s) => {
      s.nexoraAttestations[stale.attestation_id].expires_at_api = new Date(Date.now() - 1000).toISOString();
    });
    const staleJob = `nexora:${randomUUID()}`;
    const staleBody = nexoraSubmitBody(staleJob, stale.attestation_id, keyframeHashes);
    const staleOut = await submitNexora(api, staleBody);
    assert.equal(staleOut.status, 403);
    assert.equal(staleOut.body.reason, 'attestation-expired');
    assert.equal(managerJobFor(api, staleJob), null);
    // Revoked: revoke, then submit.
    const revoked = attestInProcess(api, 'session-revoked');
    assert.equal(revokeAttestation(api.apiState, revoked.attestation_id).ok, true);
    const revokedJob = `nexora:${randomUUID()}`;
    const revokedBody = nexoraSubmitBody(revokedJob, revoked.attestation_id, keyframeHashes);
    const revokedOut = await submitNexora(api, revokedBody);
    assert.equal(revokedOut.status, 403);
    assert.equal(revokedOut.body.reason, 'attestation-invalid');
    assert.equal(managerJobFor(api, revokedJob), null);
  } finally {
    await cleanup();
  }
});

// -- T-V4: audience ---------------------------------------------------------

test('T-V4: audience "public" is refused — no public executor exists, so the fail-closed reading is 400 audience-must-be-personal (design "routed public" cannot apply)', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes, { audience: 'public' });
    const out = await submitNexora(api, body);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'invalid-submit');
    assert.match(out.body.message, /audience must be personal/);
    assert.equal(managerJobFor(api, jobId), null);
  } finally {
    await cleanup();
  }
});

// -- T-V5: Worker-origin personal submit without a token -------------------
// Round-2 covers the Worker path (worker-owner-gate.test.mjs:
// unauthenticated / wrong-token personal submits are 401/403 with no
// journal entry and no manager job). The NEXORA-side case here: an
// unauthenticated NEXORA submit over HTTP is 401 and holds nothing.

test('T-V5: unauthenticated NEXORA submit over HTTP is 401 and holds nothing (Worker-path coverage is round-2)', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const r = await httpJson(port, 'POST', '/internal/submit', { bodyText: submitBodyText(body) });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'unauthorised');
    assert.equal(managerJobFor(api, jobId), null);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    // A NEXORA-signed request with the WRONG transport secret is 401 too.
    const wrong = nexoraHeaders('POST', '/internal/submit', submitBodyText(body), { apiSecret: 'wrong-secret' });
    const r2 = await httpJson(port, 'POST', '/internal/submit', { bodyText: submitBodyText(body), headers: wrong.headers });
    assert.equal(r2.status, 401);
    assert.equal(managerJobFor(api, jobId), null);
  } finally {
    await cleanup();
  }
});

// -- T-V6: audience mismatch at each layer ---------------------------------

test('T-V6: audience mismatch at the dispatcher / executor / transport layers — the NEXORA-origin third marker refuses at the executor boundary', async (t) => {
  const { api, cleanup } = await nexoraApi(t);
  try {
    const verifier = createNexoraAttestationVerifier(api.apiState);
    const att = attestInProcess(api);
    const base = {
      id: 'job-nexora-1',
      params: {
        audience: 'personal',
        origin: 'nexora',
        jobId: `nexora:${randomUUID()}`,
        nexoraAttestationId: att.attestation_id,
        nexoraSessionId: NEXORA_SESSION,
      },
    };
    // Valid registry attestation: the third marker verifies.
    assert.deepEqual(checkStage2Safe(base, { nexoraAttestationVerifier: verifier }), { ok: true });
    // Unknown attestation id: refused.
    assert.equal(
      checkStage2Safe({ ...base, params: { ...base.params, nexoraAttestationId: 'att-unknown' } }, { nexoraAttestationVerifier: verifier }).ok,
      false,
    );
    // Wrong session binding: refused (the session is recorded from the
    // registry at submit, never from the request).
    assert.equal(
      checkStage2Safe({ ...base, params: { ...base.params, nexoraSessionId: 'another-session' } }, { nexoraAttestationVerifier: verifier }).ok,
      false,
    );
    // Revoked attestation: refused.
    revokeAttestation(api.apiState, att.attestation_id);
    assert.equal(checkStage2Safe(base, { nexoraAttestationVerifier: verifier }).ok, false);
    // Audience public with a (fresh) valid attestation: refused — the
    // marker requires audience personal.
    const att2 = attestInProcess(api, 'session-public-audience');
    assert.equal(
      checkStage2Safe({ ...base, params: { ...base.params, audience: 'public', nexoraAttestationId: att2.attestation_id, nexoraSessionId: 'session-public-audience' } }, { nexoraAttestationVerifier: verifier }).ok,
      false,
    );
    // No verifier wired: fail closed.
    assert.equal(checkStage2Safe(base, {}).ok, false);
    // Dispatcher routing (round-2, executors.test.mjs): a personal job
    // routes ONLY to personal providers and a public job NEVER to
    // them — the T-V1 end-to-end above proves the NEXORA job reaches
    // kaggle-t4 through that routing.
  } finally {
    await cleanup();
  }
});

// -- T-V7: kaggle-t4 as a public production executor ------------------------

test('T-V7: kaggle-t4 in NOVA_PRODUCTION_EXECUTORS is a startup failure', async (t) => {
  const dir = tempDir(t);
  // v13 §3.3: the conf read precedes the executor check, so the test
  // supplies a valid temp conf (both flags false) — without one the
  // missing production conf fails closed first.
  const confPath = writeActivationConf(dir, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n');
  assert.throws(
    () => createApiServer({
      mode: 'production',
      secret: 'test-secret',
      signingSecret: TEST_SIGNING_SECRET,
      dataDir: dir,
      activationConfigPath: confPath,
      fileAccess: {
        ownerUid: process.getuid(),
        groupGid: process.getgid(),
        mode: 0o440,
        parentUid: process.getuid(),
      },
      d1Client: new MemoryD1Client(),
      productionExecutors: 'kaggle-t4',
    }),
    /production executor is not permitted or implemented: kaggle-t4/,
  );
});

// -- T-V8: flag off ----------------------------------------------------------

test('T-V8: personal flag false refuses the NEXORA submit and capacity reports the personal reason', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    // v13 F-6: the activation step refuses with 'activation-false'
    // (the flag is the refusal, not capacity).
    assert.equal(out.body.error, 'activation-false');
    assert.equal(managerJobFor(api, jobId), null);
    // Capacity (NEXORA form): personal is not authorised / activated.
    const { port } = await api.start();
    const path = '/internal/capacity?audience=personal';
    const { headers, nonce } = nexoraHeaders('GET', path, '');
    const r = await httpJson(port, 'GET', path, { headers });
    assert.equal(r.status, 200);
    assert.equal(r.json.personalProductionAuthorised, false);
    assert.equal(r.json.personalProductionActivated, false);
    assert.ok(typeof r.json.personalReason === 'string' && r.json.personalReason.length > 0);
    assert.equal(r.json.commissioning_active, false);
    assert.equal(r.headers.get('x-nova-nonce'), nonce);
  } finally {
    await cleanup();
  }
});

// -- T-V9: quota at/below floor stops both clients --------------------------
// C_N = 25.5 h consumed: remaining 4.5 h <= floor 5 h. The NEXORA path
// refuses at the ledger admission step with quota-refused /
// floor-reached (v13 §4 step 6: the NEXORA path no longer consults
// the §4.2 authorisationCheck — the ledger admission runs instead).
// The Worker personal path still goes through authorisationCheck and
// refuses with no-capacity / quota-exhausted. The ledger's own
// floor-reached reason in the 24.5 < C_N < 25 window is T-V33 case 2.

test('T-V9: quota at/below floor stops personal dispatch for both clients', async (t) => {
  const { api, d1, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    seedConsumedN(api, 25.5);
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'quota-refused');
    assert.equal(out.body.reason, 'floor-reached');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0, 'the ledger is never reached');
    // The Worker personal path refuses too (quota-exhausted).
    const wbody = workerPersonalBody('t-v9-nova');
    seedJobForSubmit(d1, wbody);
    const wout = await api.dispatch.submitExecutions(wbody);
    assert.equal(wout.status, 503);
    assert.equal(wout.body.error, 'no-capacity');
    const cap = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(cap.personalProductionAuthorised, false);
    assert.equal(cap.personalReason, 'quota-exhausted');
  } finally {
    await cleanup();
  }
});

// -- T-V10: public capacity invariance --------------------------------------
// CONFLICT (recorded): the design table's literal clause — "the public
// capacity response never reflects personal availability ... no
// provider ids, GPU/VRAM, quota, reset times, job counts, queue depth,
// or disk figures" — cannot be applied: the internal signed capacity
// body carries providers[]/queueDepth/storage for both audiences by
// round-2 design, and the (u6) test verifies the public-audience
// response with the full verifyCapacityResponse. The actually-public
// surface is the Worker's GET /api/capacity (no figures, verified in
// _worker.js). What IS tested here is the NOVA-side invariance the
// clause is really about: the public authorisation fields are
// identical whether the personal path exists or not, and personal
// never satisfies public.

test('T-V10: public capacity authorisation is identical with/without the personal executor; personal never satisfies public', async (t) => {
  const withPersonal = await nexoraApi(t);
  const withoutPersonal = await (async () => {
    const dir = tempDir(t);
    const confPath = writeActivationConf(dir,
      'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=true\n');
    const storeRoot = path.join(dir, 'store');
    fs.mkdirSync(storeRoot, { recursive: true });
    const storage = createStorage({
      rootDir: storeRoot,
      capacityProbe: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
    });
    return makeApi({
      mode: 'production',
      executor: false,
      activationConfigPath: confPath,
      fileAccess: {
        ownerUid: process.getuid(),
        groupGid: process.getgid(),
        mode: 0o440,
        parentUid: process.getuid(),
      },
      signingSecret: TEST_SIGNING_SECRET,
      ownerTokenId: TEST_OWNER_TOKEN_ID,
      kaggleCredentialPresent: true,
      seedHeartbeat: true,
      storage,
    });
  })();
  try {
    const nonce = '0'.repeat(32);
    const a = await withPersonal.api.activation.computeCapacity({ audience: 'public', requestNonce: nonce });
    const b = await withoutPersonal.api.activation.computeCapacity({ audience: 'public', requestNonce: nonce });
    assert.equal(a.publicProductionAuthorised, false);
    assert.equal(b.publicProductionAuthorised, false);
    assert.equal(a.publicProductionAuthorised, b.publicProductionAuthorised);
    assert.equal(a.reason, b.reason);
    assert.equal(a.publicProductionActivated, b.publicProductionActivated);
    // Personal never satisfies public: the public reason is the same
    // no-executor reason in both boots, not a personal reason.
    assert.notEqual(a.reason, null);
  } finally {
    await withPersonal.cleanup();
    await withoutPersonal.cleanup();
  }
});

// -- T-V11: LTX builder ------------------------------------------------------

test('T-V11: LTX builder builds from the read-only Run 10 transcription; prompt + keyframes substituted; output matches Run 10 parameters', (t) => {
  // The LTX manifest entry exists (the brief's "no LTX entry" claim
  // was stale — it is at staging.js).
  const manifest = getStagingManifest('ltx-video-2b');
  assert.ok(manifest, 'STAGING_MANIFESTS has the ltx-video-2b entry');
  assert.equal(manifest.modelId, 'ltx-video-2b');
  // The checkpoint file in the manifest carries the Run 10 checkpoint
  // SHA-256 (phase6/config.js CHECKPOINT_SHA256, the single source of
  // truth).
  const checkpointFile = manifest.files.find((f) => f.path === 'ltxv-2b-0.9.8-distilled.safetensors');
  assert.ok(checkpointFile, 'manifest carries the checkpoint file');
  assert.equal(checkpointFile.sha256, CHECKPOINT_SHA256);
  const jobA = { id: `nexora:${randomUUID()}`, prompt: 'First dragon prompt' };
  const jobB = { id: jobA.id, prompt: 'A completely different dragon prompt' };
  const nbA = buildLtxNotebook({ job: jobA, manifest, provider: 'kaggle-t4' });
  const nbB = buildLtxNotebook({ job: jobB, manifest, provider: 'kaggle-t4' });
  const textA = nbA.cells.map((c) => c.source.join('')).join('\n');
  const textB = nbB.cells.map((c) => c.source.join('')).join('\n');
  // Run 10 parameters, frozen.
  for (const text of [textA, textB]) {
    assert.ok(text.includes('num_frames=121'));
    assert.ok(text.includes('height=576, width=1024'));
    assert.ok(text.includes('num_inference_steps=8'));
    assert.ok(text.includes('guidance_scale=1.0'));
    assert.ok(text.includes('manual_seed(42)'));
    // The checkpoint SHA assert is embedded in the generated notebook.
    assert.ok(text.includes(CHECKPOINT_SHA256));
    assert.ok(text.includes('LTX SHA256 MISMATCH'));
  }
  // The keyframes ride the owner's dataset mount — that binding lives
  // in the kernel metadata, not the notebook cells (the notebook
  // references per-job FIRST/LAST files generically).
  const metaDir = tempDir(t);
  const metaExecutor = new LtxKaggleExecutor({ packageDir: path.join(metaDir, 'packages') });
  const meta = metaExecutor._kernelMetadata(jobA, manifest);
  assert.ok(meta.dataset_sources.includes(LTX_KEYFRAMES_DATASET));
  assert.equal(meta.is_private, true);
  assert.equal(meta.machine_shape, 'NvidiaTeslaT4');
  // The prompt is substituted per job; the job id is substituted.
  assert.ok(textA.includes('First dragon prompt'));
  assert.ok(!textA.includes('A completely different dragon prompt'));
  assert.ok(textB.includes('A completely different dragon prompt'));
  assert.ok(textA.includes(jobA.id));
  // The builder is a pure transcription (no template file is read or
  // written): the same inputs build byte-identical notebooks, and only
  // the prompt cell differs between the two jobs.
  assert.equal(JSON.stringify(nbA), JSON.stringify(buildLtxNotebook({ job: jobA, manifest, provider: 'kaggle-t4' })));
  assert.notEqual(textA, textB);
});

// -- T-V12: commissioning proof run ------------------------------------------

test('T-V12: proof run through the real path in commissioning mode under a one-job permit — NOT under full activation', async (t) => {
  const { api, d1, licence, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    // No live permit yet: the Worker personal submit refuses.
    const body = workerPersonalBody('t-v12-proof');
    seedJobForSubmit(d1, body);
    const refused = await api.dispatch.submitExecutions(body);
    assert.equal(refused.status, 503);
    // Capacity reports commissioning inactive.
    const capBefore = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capBefore.commissioning_active, false);
    // The operator creates the one-job permit for this EXACT body.
    const hash = canonicalRequestHash(canonicaliseJson(body));
    const permit = api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true, JSON.stringify(permit));
    const capDuring = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capDuring.commissioning_active, true);
    // The same body now submits (202) while the personal flag is off.
    const out = await api.dispatch.submitExecutions(body);
    assert.equal(out.status, 202, JSON.stringify(out.body));
    // The journal carries the permit id + the commissioning reason.
    const entry = api.dispatch.journalEntry(`${body.jobId}:scene-0:attempt-1`);
    assert.ok(entry, 'journal entry exists');
    assert.equal(entry.commissioningPermitId, permit.permit.permit_id);
    assert.equal(entry.commissioningReason, 'm2p-commissioning');
    // The permit is consumed (single-use) and the commissioning bucket
    // holds the 0.5 h reservation — drawn from the floor, not the
    // NEXORA cap, not in Q.
    assert.equal(commissioningAuthorised(api.apiState, {
      jobCanonicalHash: hash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).ok, false);
    const snap = api.nexoraLedger.snapshot();
    assert.equal(snap.commissioning.reserved, 0.5);
    assert.equal(snap.reservedX, 0);
    const capAfter = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capAfter.commissioning_active, false);
  } finally {
    await cleanup();
  }
});

// -- T-V13: activation config strict parsing (integration) ------------------
// T-V27 below covers the same cases at the verifyActivationConfigFile
// unit level; this test covers the observable behaviour — a violation
// latches activation false until a controlled restart, and a submit
// after the latch refuses.

test('T-V13: activation config violations latch activation false until restart; submit after the latch refuses', async (t) => {
  const { api, keyframeHashes, confPath, cleanup } = await nexoraApi(t);
  try {
    // Baseline: flags true, capacity reports activated.
    const capBefore = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capBefore.personalProductionActivated, true);
    assert.equal(api.activation.isInvalid(), false);
    // Violate the mode (0644) after start.
    fs.chmodSync(confPath, 0o644);
    const capAfter = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capAfter.personalProductionActivated, false);
    assert.equal(capAfter.personalProductionAuthorised, false);
    assert.equal(api.activation.isInvalid(), true);
    // Restoring the mode does NOT clear the latch — activation stays
    // false until a controlled restart.
    fs.chmodSync(confPath, 0o440);
    const capLatched = await api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) });
    assert.equal(capLatched.personalProductionActivated, false);
    assert.equal(api.activation.isInvalid(), true);
    // A NEXORA submit after the latch refuses with
    // activation-config-invalid (v13 §3.3: a mode violation latches
    // the config-invalid reason, not activation-false).
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'activation-config-invalid');
    assert.equal(managerJobFor(api, jobId), null);
  } finally {
    await cleanup();
  }
});

// -- T-V14: admission arithmetic --------------------------------------------

test('T-V14: admission arithmetic — required 14.14 GiB (15.19 GB at the design margin); 14.56 GiB device admits, 12 GiB / 8 GiB refuse', () => {
  const key = {
    model: 'ltx-video-2b',
    resolution: '1024x576',
    frames: 121,
    steps: 8,
    decoderMode: 'single-pass',
    attentionBackend: 'default',
  };
  // The design's owner-confirmed 1.50 GiB margin (NOT the repo default
  // 1.92 GiB, which gives 15.64 GB): 12.64 + 1.50 = 14.14 GiB.
  const requiredGb = requiredVramGb(key, { safetyMarginGib: 1.5 });
  assert.equal(requiredGb, 15.19);
  const admitted = admitJob(key, 15.64, { safetyMarginGib: 1.5 });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.requiredGib, 14.14);
  assert.equal(admitted.requiredGb, 15.19);
  // 14.56 GiB = 15.64 GB is the design's device figure (GiB→GB at
  // 1.073741824); a 12 GB or 8 GB device refuses.
  assert.equal(admitJob(key, 12, { safetyMarginGib: 1.5 }).admitted, false);
  assert.equal(admitJob(key, 12, { safetyMarginGib: 1.5 }).reason, 'insufficient-vram');
  assert.equal(admitJob(key, 8, { safetyMarginGib: 1.5 }).admitted, false);
  // OPEN: admitJob takes no device-model parameter — the design §4
  // step 8 device-model keying (e.g. P100 vs T4) is unresolved; the
  // profile is keyed by model/resolution/frames/steps only.
});

// -- T-V15: per-client credentials -------------------------------------------

test('T-V15: a NEXORA-signed request claiming origin=worker is refused; a Worker-signed request never reaches the NEXORA path', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const att = attestInProcess(api);
    // NEXORA auth, origin=worker in the body.
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes, { origin: 'worker' });
    const bodyText = submitBodyText(body);
    const { headers } = nexoraHeaders('POST', '/internal/submit', bodyText);
    const r = await httpJson(port, 'POST', '/internal/submit', { bodyText, headers });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid-submit');
    assert.match(r.json.message, /origin must be nexora/);
    assert.equal(managerJobFor(api, jobId), null);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    // Worker auth, NEXORA-origin body: the Worker path checks the jobId
    // FORM before any D1 read — `nexora:<uuid>` is outside the Worker's
    // namespace, so it is 400 invalid-job-id (v13 §3 D-2.3), never a
    // 404 and never a D1 read for an id that cannot have a record. The
    // request never reaches submitNexora. The millisecond process-start
    // rule rejects a timestamp from the process-start second itself,
    // so sign in the next second.
    const waitMs = (Math.floor(processStartMs() / 1000) + 1) * 1000 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs + 5));
    const jobId2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(jobId2, att.attestation_id, keyframeHashes);
    const bodyText2 = submitBodyText(body2);
    const wheaders = signApiCall('test-secret', TEST_SIGNING_SECRET, 'POST', '/internal/submit', bodyText2);
    const r2 = await httpJson(port, 'POST', '/internal/submit', { bodyText: bodyText2, headers: wheaders });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error, 'invalid-job-id');
    assert.equal(managerJobFor(api, jobId2), null);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
  } finally {
    await cleanup();
  }
});

// -- T-V16: is_private --------------------------------------------------------

test('T-V16: the builder refuses is_private:false — a public kernel is never built', async (t) => {
  const dir = tempDir(t);
  const manifest = getStagingManifest('ltx-video-2b');
  const job = { id: `nexora:${randomUUID()}`, prompt: 'A dragon rests on a ridge at dawn' };
  // Default (null) is private: metadata builds.
  const executor = new LtxKaggleExecutor({ packageDir: path.join(dir, 'packages') });
  const meta = executor._kernelMetadata(job, manifest);
  assert.equal(meta.is_private, true);
  // Explicit is_private:false is refused at the metadata boundary.
  const pub = new LtxKaggleExecutor({ packageDir: path.join(dir, 'packages'), isPrivate: false });
  assert.throws(() => pub._kernelMetadata(job, manifest), /kaggle kernel must be private: is_private:false is refused/);
  // The base executor enforces the same point.
  const base = new KaggleExecutor({ packageDir: path.join(dir, 'packages'), isPrivate: false });
  assert.throws(() => base._kernelMetadata(job, manifest), /is_private:false is refused/);
});

// -- T-V17: commissioning-mode limits ----------------------------------------

test('T-V17: commissioning limits — one job per permit, NOVA-origin only, stated expiry, no authorisation means no mode', async (t) => {
  // No permit: the mode does not exist.
  const bootA = await nexoraApi(t, { personalFlag: false });
  try {
    const body = workerPersonalBody('t-v17-first');
    seedJobForSubmit(bootA.d1, body);
    assert.equal((await bootA.api.dispatch.submitExecutions(body)).status, 503);
    assert.equal((await bootA.api.activation.computeCapacity({ audience: 'personal', requestNonce: '0'.repeat(32) })).commissioning_active, false);
    // A permit for the first body: it submits (202) while the flag is off.
    const hash = canonicalRequestHash(canonicaliseJson(body));
    const permit = bootA.api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: bootA.licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true);
    assert.equal((await bootA.api.dispatch.submitExecutions(body)).status, 202);
    // The permit is single-use: authorising the FIRST hash again
    // reports permit-consumed, and a different hash with no live
    // permit reports no-permit. Either way the second submit refuses.
    assert.equal(commissioningAuthorised(bootA.api.apiState, {
      jobCanonicalHash: hash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).reason, 'permit-consumed');
    const body2 = workerPersonalBody('t-v17-second');
    seedJobForSubmit(bootA.d1, body2);
    const hash2 = canonicalRequestHash(canonicaliseJson(body2));
    assert.equal(commissioningAuthorised(bootA.api.apiState, {
      jobCanonicalHash: hash2, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).reason, 'no-permit');
    assert.equal((await bootA.api.dispatch.submitExecutions(body2)).status, 503);
  } finally {
    await bootA.cleanup();
  }
  // One job PER PERMIT, not one job ever: a fresh boot with a fresh
  // permit for the second body submits fine. (A fresh boot is needed
  // because kaggle-t4's maxConcurrentJobs is 1 and the first job's
  // start promise stays pending on the null transport.)
  const bootB = await nexoraApi(t, { personalFlag: false });
  try {
    const body2 = workerPersonalBody('t-v17-second');
    seedJobForSubmit(bootB.d1, body2);
    const hash2 = canonicalRequestHash(canonicaliseJson(body2));
    const permit2 = bootB.api.createCommissioningPermit({
      jobCanonicalHash: hash2,
      maxHours: 0.5,
      licenceDeterminationRef: bootB.licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit2.ok, true);
    assert.equal((await bootB.api.dispatch.submitExecutions(body2)).status, 202);
  } finally {
    await bootB.cleanup();
  }
  // Stated expiry: a permit with a short life expires on its own.
  const bootC = await nexoraApi(t, { personalFlag: false });
  try {
    const body3 = workerPersonalBody('t-v17-third');
    seedJobForSubmit(bootC.d1, body3);
    const hash3 = canonicalRequestHash(canonicaliseJson(body3));
    const permit3 = bootC.api.createCommissioningPermit({
      jobCanonicalHash: hash3,
      maxHours: 0.5,
      licenceDeterminationRef: bootC.licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
      expiresAtMs: Date.now() + 50,
    });
    assert.equal(permit3.ok, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await bootC.api.dispatch.submitExecutions(body3)).status, 503);
    assert.equal(commissioningAuthorised(bootC.api.apiState, {
      jobCanonicalHash: hash3, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).reason, 'permit-expired');
  } finally {
    await bootC.cleanup();
  }
});

test('T-V17b: NEXORA jobs never run under commissioning — a live permit for the NEXORA body does not authorise a NEXORA submit', async (t) => {
  const { api, keyframeHashes, licence, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    // A live permit bound to this EXACT NEXORA body still does not
    // authorise it: submitNexora refuses when the personal flag is
    // off, with no commissioning fallback.
    const permit = api.createCommissioningPermit({
      jobCanonicalHash: canonicalRequestHash(submitBodyText(body)),
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    // v13 F-6: the flag is off → activation-false; the live permit
    // does not authorise a NEXORA job.
    assert.equal(out.body.error, 'activation-false');
    assert.equal(managerJobFor(api, jobId), null);
  } finally {
    await cleanup();
  }
});

// -- T-V18: floor protection --------------------------------------------------

test('T-V18: floor protection — commissioning consumption lives in its own bucket; ordinary dispatch never touches the floor', async (t) => {
  const { api, d1, licence, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    // Commissioning submit (T-V12 path): the reservation lands in the
    // commissioning bucket only.
    const body = workerPersonalBody('t-v18-comm');
    seedJobForSubmit(d1, body);
    const permit = api.createCommissioningPermit({
      jobCanonicalHash: canonicalRequestHash(canonicaliseJson(body)),
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true);
    assert.equal((await api.dispatch.submitExecutions(body)).status, 202);
    const snap = api.nexoraLedger.snapshot();
    assert.equal(snap.commissioning.reserved, 0.5);
    assert.equal(snap.commissioning.consumed, 0);
    assert.equal(snap.reservedX, 0);
    assert.equal(snap.consumedX, 0);
    assert.equal(snap.buckets.commissioning, 0.5);
    assert.equal(snap.buckets.protected, 5);
    // Ordinary dispatch (a second boot with flags true) reserves the
    // NEXORA bucket, never the commissioning bucket.
    const plain = await nexoraApi(t, { personalFlag: true });
    try {
      const att = attestInProcess(plain.api);
      const jobId = `nexora:${randomUUID()}`;
      const nbody = nexoraSubmitBody(jobId, att.attestation_id, plain.keyframeHashes);
      assert.equal((await submitNexora(plain.api, nbody)).status, 202);
      const snap2 = plain.api.nexoraLedger.snapshot();
      assert.equal(snap2.reservedX, 0.5);
      assert.equal(snap2.commissioning.reserved, 0);
      assert.equal(snap2.buckets.ordinary, 0);
    } finally {
      await plain.cleanup();
    }
  } finally {
    await cleanup();
  }
});

// -- T-V19: orphan reservation retention --------------------------------------
// The fake clock starts on a Tuesday (2026-11-24) so the 25 h advance
// never crosses the Saturday week boundary (a rollover would drop the
// reservation by week change, not by release — a different mechanism).

test('T-V19: orphan reservation is HELD past 24 h without terminal state; released only on confirmed terminal state or operator confirmation; operator escalated once at 24 h', async (t) => {
  const startMs = Date.parse('2026-11-24T12:00:00.000Z');
  let clock = startMs;
  const { api, keyframeHashes, cleanup } = await nexoraApi(t, { now: () => clock });
  try {
    const att = attestInProcess(api, NEXORA_SESSION, clock);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    assert.equal((await submitNexora(api, body)).status, 202);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // 25 h later, no terminal state: the reservation is STILL held
    // (v4 C-1: 24 h is an operator-escalation threshold, NOT an
    // expiry — there is no origin-pause in v4).
    clock = startMs + 25 * 3600 * 1000;
    const orphans = api.checkNexoraOrphans();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].jobId, jobId);
    assert.equal(orphans[0].status, 'held');
    const snap = api.nexoraLedger.snapshot(clock);
    assert.equal(snap.reservedX, 0.5, 'reservation still held past 24 h');
    assert.ok(snap.reservations.find((r) => r.jobId === jobId)?.escalatedAtMs !== null, 'operator escalated');
    // A second check does NOT re-escalate (once per reservation).
    const escalatedAt = snap.reservations.find((r) => r.jobId === jobId).escalatedAtMs;
    api.checkNexoraOrphans();
    const snap2 = api.nexoraLedger.snapshot(clock);
    assert.equal(snap2.reservations.find((r) => r.jobId === jobId).escalatedAtMs, escalatedAt);
    assert.equal(snap2.reservedX, 0.5, 'still held after the second check');
    // Operator confirmation releases it.
    const released = api.resolveNexoraOrphan(jobId);
    assert.equal(released.status, 'released');
    assert.equal(api.nexoraLedger.snapshot(clock).reservedX, 0);
    // The manager job itself is untouched by the orphan machinery
    // (still running — its kernel never reported; no pause exists).
    assert.equal(managerJobFor(api, jobId).status, 'running');
  } finally {
    await cleanup();
  }
});

test('T-V19b: origin-paused — a ledger orphan for the NEXORA origin pauses it until the operator resolves the orphan', async (t) => {
  const startMs = Date.parse('2026-11-24T12:00:00.000Z');
  let clock = startMs;
  const { api, keyframeHashes, cleanup } = await nexoraApi(t, { now: () => clock });
  try {
    const att = attestInProcess(api, NEXORA_SESSION, clock);
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, keyframeHashes);
    assert.equal((await submitNexora(api, body1)).status, 202);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // 25 h later the reservation is an orphan — the origin is paused.
    clock = startMs + 25 * 3600 * 1000;
    assert.equal(api.checkNexoraOrphans().length, 1);
    // A fresh attestation is needed at the new clock (the first one
    // expired with the 4 h TTL); the refusal is the pause, not the
    // attestation — a new session attests cleanly.
    const att2 = attestInProcess(api, 'session-v19b-2', clock);
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att2.attestation_id, keyframeHashes);
    const out2 = await submitNexora(api, body2);
    assert.equal(out2.status, 503);
    assert.equal(out2.body.error, 'origin-paused');
    assert.equal(api.nexoraLedger.snapshot(clock).reservedX, 0.5, 'the orphan reservation is still held');
    // Operator resolution clears the pause — the refusal is no longer
    // origin-paused. The submit now reaches the slot cap instead (job
    // 1 still runs and holds the origin's only slot): queue-full.
    assert.equal(api.resolveNexoraOrphan(job1).status, 'released');
    assert.equal(api.nexoraLedger.snapshot(clock).reservedX, 0);
    const out3 = await submitNexora(api, body2);
    assert.equal(out3.status, 503);
    assert.equal(out3.body.error, 'queue-full');
  } finally {
    await cleanup();
  }
});

test('T-V19c: held at dispatch — a NEXORA job is held when its licence record vanishes after acceptance; re-evaluation clears the hold when the record returns; cancel-held releases the slot', async (t) => {
  const { api, d1, keyframeHashes, licencePath, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    // A Worker personal job occupies the only kaggle-t4 slot, so the
    // NEXORA job queues instead of dispatching.
    const wbody = workerPersonalBody('t-v19c-nova');
    seedJobForSubmit(d1, wbody);
    assert.equal((await api.dispatch.submitExecutions(wbody)).status, 202);
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, keyframeHashes);
    const out1 = await submitNexora(api, body1);
    assert.equal(out1.status, 202);
    assert.equal(out1.body.dispatchState, 'queued');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // The licence record vanishes after acceptance. The next dispatch
    // loop — any submit's loop reaches the queued head job through
    // _dispatchPersonalNext — re-checks and HELDS it: the reservation
    // is retained. (A public submit cannot be the trigger in this
    // harness: public generation has no registered production executor
    // and refuses at acceptance. The wrapper below IS the dispatch
    // loop's core, shared by both submit paths.)
    fs.unlinkSync(licencePath);
    const held = api.dispatch._dispatchPersonalNext();
    assert.equal(held.dispatched, false);
    assert.equal(held.reason, 'held-licence-undetermined');
    assert.equal(api.dispatch.journalEntry(job1).state, 'held-licence-undetermined');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5, 'the held job keeps its reservation');
    // A further NEXORA submit is refused at acceptance (licence).
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att.attestation_id, keyframeHashes);
    const out2 = await submitNexora(api, body2);
    assert.equal(out2.status, 403);
    assert.equal(out2.body.error, 'licence-refused');
    assert.equal(out2.body.reason, 'licence-undetermined');
    // The record returns: re-evaluation clears the hold (the cause is
    // gone). The job stays queued — the executor is still busy — but
    // its journal state is no longer held.
    api.setLicenceDetermination({
      kind: 'owner-determination',
      licenceTextSha256: 'a'.repeat(64),
      checkpointSha256: CHECKPOINT_SHA256,
      evidenceRef: 'test-evidence',
      determinedBy: 'test-operator',
    });
    const re = api.reEvaluateHeldJobs();
    assert.equal(re.find((r) => r.jobId === job1)?.state, 'submitted');
    assert.equal(api.dispatch.journalEntry(job1).state, 'submitted');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // A further submit is refused at the per-origin slot cap — job 1
    // holds the origin's only slot.
    const job3 = `nexora:${randomUUID()}`;
    const body3 = nexoraSubmitBody(job3, att.attestation_id, keyframeHashes);
    const out3 = await submitNexora(api, body3);
    assert.equal(out3.status, 503);
    assert.equal(out3.body.error, 'queue-full');
    // Hold it again, then cancel-held: the manager job is cancelled,
    // the reservation is released, the journal files 'cancelled-held'
    // with the hold reason as evidence — and the slot frees up.
    fs.unlinkSync(licencePath);
    const held2 = api.dispatch._dispatchPersonalNext();
    assert.equal(held2.reason, 'held-licence-undetermined');
    assert.equal(api.dispatch.journalEntry(job1).state, 'held-licence-undetermined');
    const cancelled = api.cancelHeldJob(job1, { reason: 'test-cancel-held' });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.heldReason, 'held-licence-undetermined');
    assert.equal(managerJobFor(api, job1).status, 'cancelled');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    assert.equal(api.dispatch.journalEntry(job1).state, 'cancelled-held');
    // With the record restored and the slot free, a new submit is
    // accepted.
    api.setLicenceDetermination({
      kind: 'owner-determination',
      licenceTextSha256: 'a'.repeat(64),
      checkpointSha256: CHECKPOINT_SHA256,
      evidenceRef: 'test-evidence',
      determinedBy: 'test-operator',
    });
    const job4 = `nexora:${randomUUID()}`;
    const body4 = nexoraSubmitBody(job4, att.attestation_id, keyframeHashes);
    const out4 = await submitNexora(api, body4);
    assert.equal(out4.status, 202);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // cancel-held on a job that is not held refuses.
    assert.equal(api.cancelHeldJob(job4, { reason: 'test' }).ok, false);
  } finally {
    await cleanup();
  }
});

// -- T-V20: API-determined attestation timestamps -----------------------------

test('T-V20: API-determined attestation timestamps — client-supplied confirmed_at/expires_at are ignored', async (t) => {
  const { api, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const bodyText = JSON.stringify({
      client_id: 'nexora-service',
      session_id: 'session-t20',
      restriction_text_version: 'v1',
      confirmed_at: '1999-01-01T00:00:00.000Z',
      expires_at: '1999-01-02T00:00:00.000Z',
    });
    const { headers } = nexoraHeaders('POST', '/internal/attest', bodyText);
    const before = Date.now();
    const r = await httpJson(port, 'POST', '/internal/attest', { bodyText, headers });
    const after = Date.now();
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.attestation_id, /^att-/);
    assert.equal(r.json.client_id, 'nexora-service');
    assert.equal(r.json.session_id, 'session-t20');
    assert.equal(r.json.restriction_text_version, 'v1');
    const confirmed = Date.parse(r.json.confirmed_at_api);
    const expires = Date.parse(r.json.expires_at_api);
    assert.ok(confirmed >= before - 1000 && confirmed <= after + 1000, 'confirmed_at_api is the API clock');
    assert.equal(expires - confirmed, 4 * 3600 * 1000, 'expires_at_api is confirmed + 4 h');
    assert.equal(r.text.includes('1999'), false, 'client-supplied timestamps appear nowhere');
  } finally {
    await cleanup();
  }
});

// -- T-V21: wrong client / session --------------------------------------------

test('T-V21: wrong client / session rejection — attest and validate paths', async (t) => {
  const { api, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    // Wrong client id.
    const wrongClient = JSON.stringify({ client_id: 'worker', session_id: 's1', restriction_text_version: 'v1' });
    const h1 = nexoraHeaders('POST', '/internal/attest', wrongClient);
    const r1 = await httpJson(port, 'POST', '/internal/attest', { bodyText: wrongClient, headers: h1.headers });
    assert.equal(r1.status, 400);
    assert.equal(r1.json.reason, 'invalid-client');
    // Obsolete restriction version.
    const obsolete = JSON.stringify({ client_id: 'nexora-service', session_id: 's1', restriction_text_version: 'v0' });
    const h2 = nexoraHeaders('POST', '/internal/attest', obsolete);
    const r2 = await httpJson(port, 'POST', '/internal/attest', { bodyText: obsolete, headers: h2.headers });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.reason, 'obsolete-version');
    // Duplicate session attestation (design §5.3 v13): the same session
    // already holds one — the route returns the EXISTING record
    // unchanged: 200, same attestation_id, same expires_at_api, no new
    // id, no later expiry, not counted toward the daily limit.
    const att = attestInProcess(api, 'session-dup');
    const dup = JSON.stringify({ client_id: 'nexora-service', session_id: 'session-dup', restriction_text_version: 'v1' });
    const h3 = nexoraHeaders('POST', '/internal/attest', dup);
    const r3 = await httpJson(port, 'POST', '/internal/attest', { bodyText: dup, headers: h3.headers });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.attestation_id, att.attestation_id);
    assert.equal(r3.json.expires_at_api, att.expires_at_api);
    assert.equal(r3.json.confirmed_at_api, att.confirmed_at_api);
    // Wrong session at validation: the record binds its own session.
    assert.equal(validateAttestation(api.apiState, {
      attestationId: att.attestation_id, clientId: 'nexora-service', expectedSessionId: 'another-session',
    }).reason, 'attestation-invalid');
    assert.equal(validateAttestation(api.apiState, {
      attestationId: att.attestation_id, clientId: 'nexora-service', expectedSessionId: 'session-dup',
    }).ok, true);
  } finally {
    await cleanup();
  }
});

// -- T-V22: unauthenticated dashboard ------------------------------------------

test('T-V22: attestation outside the NEXORA auth is refused — unauthenticated and Worker-authenticated alike', async (t) => {
  const { api, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const bodyText = JSON.stringify({ client_id: 'nexora-service', session_id: 's1', restriction_text_version: 'v1' });
    // No auth at all.
    const r0 = await httpJson(port, 'POST', '/internal/attest', { bodyText });
    assert.equal(r0.status, 401);
    // Worker auth (valid Worker signature, wrong credential type).
    const wheaders = signApiCall('test-secret', TEST_SIGNING_SECRET, 'POST', '/internal/attest', bodyText);
    const r1 = await httpJson(port, 'POST', '/internal/attest', { bodyText, headers: wheaders });
    assert.equal(r1.status, 401);
    // NEXORA auth works (the positive control).
    const { headers } = nexoraHeaders('POST', '/internal/attest', bodyText);
    const r2 = await httpJson(port, 'POST', '/internal/attest', { bodyText, headers });
    assert.equal(r2.status, 200);
  } finally {
    await cleanup();
  }
});

// -- T-V23: monetisation halt -------------------------------------------------

test('T-V23: halt set cancels queued NEXORA jobs, releases reservations, and refuses new submits — independently of NEXORA local flag', async (t) => {
  const { api, d1, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    // A Worker personal job occupies the only kaggle-t4 slot first
    // (maxConcurrentJobs is 1), so the NEXORA job below cannot
    // dispatch and stays QUEUED with its reservation held (v13 §6.2:
    // a busy executor yields 202 queued, never a 503, and the
    // reservation is released only on a confirmed terminal state or
    // operator resolve-orphan — the v4 dispatch-failure compensation
    // that released it is gone).
    const wbody = workerPersonalBody('t-v23-nova');
    seedJobForSubmit(d1, wbody);
    const wout = await api.dispatch.submitExecutions(wbody);
    assert.equal(wout.status, 202);
    assert.equal(wout.body.dispatchState, 'slot-claimed');
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, keyframeHashes);
    const out1 = await submitNexora(api, body1);
    assert.equal(out1.status, 202);
    assert.equal(out1.body.dispatchState, 'queued');
    assert.equal(managerJobFor(api, job1).status, 'queued');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5, 'the queued job holds its reservation');
    // A second NEXORA submit is refused at the per-origin slot cap —
    // the origin's only slot is held by the queued job (§4 step 6
    // order: the slot cap is checked before quota).
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att.attestation_id, keyframeHashes);
    const out2 = await submitNexora(api, body2);
    assert.equal(out2.status, 503);
    assert.equal(out2.body.error, 'queue-full');
    assert.equal(managerJobFor(api, job2), null);
    // The operator sets the mirrored halt: the queued job is cancelled
    // (journal files 'cancelled-by-halt', §6.3 v13), the running
    // Worker job is untouched (running kernels complete).
    api.setNexoraHalt({ halted: true, reason: 'monetisation concern' });
    assert.equal(managerJobFor(api, job1).status, 'cancelled');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    // New submits refuse while halted — the API's own record, not a
    // NEXORA local flag (no local flag is ever sent or consulted).
    const job3 = `nexora:${randomUUID()}`;
    const body3 = nexoraSubmitBody(job3, att.attestation_id, keyframeHashes);
    const out3 = await submitNexora(api, body3);
    assert.equal(out3.status, 503);
    assert.equal(out3.body.error, 'client-halted');
    assert.equal(out3.body.reason, 'nexora-halted');
    // Clearing the halt unblocks acceptance — but only after the
    // operator records a revisit decision (design §5.4 v13, T-V36):
    // the clear is refused without one. The next submit now reaches
    // admission/dispatch — and stays queued, because the Worker job
    // still occupies the executor (202 queued, not a 503).
    api.recordRevisitDecision({ kind: 'kaggle-confirmation', detail: 't-v23: kaggle use confirmed non-commercial' });
    api.setNexoraHalt({ halted: false });
    const out4 = await submitNexora(api, body3);
    assert.equal(out4.status, 202);
    assert.equal(out4.body.dispatchState, 'queued');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
  } finally {
    await cleanup();
  }
});

// -- T-V24: counter reconciliation ---------------------------------------------

test('T-V24: the NOVA ledger governs acceptance; a NEXORA local counter never authorises', async (t) => {
  // Pure arithmetic: with the cap at 1.0 h, a second 0.5 h job fits
  // (0 + 0.5 + 0.5 = 1.0) but a third does not (0.5 + 0.5 + 0.5).
  // v13 §6.2: the pure function needs a valid reconciliation (the
  // Kaggle headroom is wide here, so the min() does not bind).
  assert.equal(computeAdmission({
    consumedN: 0, reservedN: 0, consumedX: 0, reservedX: 0.5, jobHours: 0.5, capHours: 1.0,
    kaggleHeadroomHours: 30, reconciliationValid: true,
  }).ok, true);
  assert.equal(computeAdmission({
    consumedN: 0, reservedN: 0, consumedX: 0.5, reservedX: 0.5, jobHours: 0.5, capHours: 1.0,
    kaggleHeadroomHours: 30, reconciliationValid: true,
  }).reason, 'nexora-cap-reached');
  // Integration: cap 0.5 h — the first job takes the whole cap. The
  // second submit is refused at the PER-ORIGIN SLOT CAP (the origin's
  // only slot is held by job 1) — the §4 step 6 order checks the slot
  // cap before quota, so 'queue-full' is the correct v13 answer here.
  const { api, keyframeHashes, cleanup } = await nexoraApi(t, { capHours: 0.5 });
  try {
    const att = attestInProcess(api);
    const job1 = `nexora:${randomUUID()}`;
    // A bogus local counter field is ignored outright — the ledger,
    // never a client counter, authorises.
    const body1 = nexoraSubmitBody(job1, att.attestation_id, keyframeHashes, { local_counter: 999 });
    assert.equal((await submitNexora(api, body1)).status, 202);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att.attestation_id, keyframeHashes);
    const out2 = await submitNexora(api, body2);
    assert.equal(out2.status, 503);
    assert.equal(out2.body.error, 'queue-full');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
  } finally {
    await cleanup();
  }
  // The LEDGER cap refusal itself: a fresh API whose cap is already
  // consumed (no job in flight, slot free) refuses the submit with
  // quota-refused / nexora-cap-reached.
  const capped = await nexoraApi(t, { capHours: 0.5 });
  try {
    seedConsumedX(capped.api, 0.5);
    const att = attestInProcess(capped.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, capped.keyframeHashes);
    const out = await submitNexora(capped.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'quota-refused');
    assert.equal(out.body.reason, 'nexora-cap-reached');
    assert.equal(capped.api.nexoraLedger.snapshot().reservedX, 0);
  } finally {
    await capped.cleanup();
  }
});

// -- T-V25: idempotency ---------------------------------------------------------

test('T-V25: same jobId + same hash returns the existing state (200); same jobId + different hash is 409 idempotency-conflict', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const bodyText = submitBodyText(body);
    const first = await submitNexora(api, body);
    assert.equal(first.status, 202);
    // Same payload again: 200 existing state, no second job, no second
    // reservation. (The duplicate-jobId lookup runs BEFORE attestation
    // and staging per the v13 §4 step 6 order, so an identical
    // re-submit returns the existing state even with an expired
    // attestation.)
    const again = await submitNexora(api, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.jobId, jobId);
    assert.equal(again.body.managerJobId, first.body.managerJobId);
    assert.equal(again.body.canonical_request_hash, first.body.canonical_request_hash);
    assert.equal(Object.values(api.manager.store.state.jobs ?? {}).filter((j) => j.params?.jobId === jobId).length, 1);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // Same jobId, different payload (different prompt → different
    // hash): 409. The hash INCLUDES attestation_id (v4), so a
    // re-submit under a fresh attestation also 409s — the design text
    // saying it "returns the existing job state" contradicts the v4
    // hash; the NEXORA client's reconcile-first flow (job_state before
    // any re-submit) avoids the conflict in practice.
    const changed = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes, { prompt: 'A different dragon prompt' });
    const conflict = await submitNexora(api, changed);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'idempotency-conflict');
    assert.equal(Object.values(api.manager.store.state.jobs ?? {}).filter((j) => j.params?.jobId === jobId).length, 1);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
  } finally {
    await cleanup();
  }
});

// -- T-V26: staging push model (§5.7) -----------------------------------------
// The client PUSHES each keyframe to POST /internal/stage BEFORE
// submitting; the submit re-verifies the staged hashes. The v4
// loopback-fetch model is gone.

test('T-V26: staging push model — stage refuses bad bytes/bounds/halt/pause/activation; submit re-verifies staged hashes', async (t) => {
  const { api, keyframes, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    // (a) A clean stage succeeds and returns the hash + size.
    const r1 = await stageKeyframe(port, jobId, keyframes.first);
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.jobId, jobId);
    assert.equal(r1.json.sha256, keyframeHashes.first);
    assert.equal(r1.json.size, keyframes.first.length);
    assert.equal(r1.json.staged, true);
    assert.equal(r1.json.alreadyStaged, false);
    // Re-stage the same file: no-op success.
    const r1b = await stageKeyframe(port, jobId, keyframes.first);
    assert.equal(r1b.status, 200);
    assert.equal(r1b.json.alreadyStaged, true);
    // (b) A mismatched X-Sha256 is refused at stage (never stored).
    const badSha = await stageKeyframe(port, jobId, keyframes.last, { sha256: '0'.repeat(64) });
    assert.equal(badSha.status, 400);
    assert.equal(badSha.json.error, 'staging-failed');
    assert.equal(badSha.json.reason, 'staging-hash-mismatch');
    // (c) A wrong X-Size is refused.
    const badSize = await stageKeyframe(port, jobId, keyframes.last, { size: keyframes.last.length + 1 });
    assert.equal(badSize.status, 400);
    assert.equal(badSize.json.reason, 'size-mismatch');
    // (d) Non-image bytes are refused (magic bytes + decode).
    const notImage = await stageKeyframe(port, jobId, Buffer.from('not an image at all, just text'));
    assert.equal(notImage.status, 400);
    assert.equal(notImage.json.reason, 'invalid-image');
    // (e) A truncated PNG (valid magic, broken structure) is refused.
    const truncated = await stageKeyframe(port, jobId, keyframes.last.subarray(0, 20));
    assert.equal(truncated.status, 400);
    assert.equal(truncated.json.reason, 'invalid-image');
    // (f) The signed path is the full request-target INCLUDING the
    // query string: signing '/internal/stage' without it is 401.
    const unsignedPath = nexoraHeaders('POST', '/internal/stage', keyframes.last);
    const rUnsigned = await fetch(`http://127.0.0.1:${port}/internal/stage?jobId=${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sha256': keyframeHashes.last,
        'X-Size': String(keyframes.last.length),
        ...unsignedPath.headers,
      },
      body: keyframes.last,
    });
    assert.equal(rUnsigned.status, 401);
    // (g) A second file for the same job stages fine (2-file bound);
    // a THIRD distinct file for the same job is refused
    // storage-unavailable.
    const r2 = await stageKeyframe(port, jobId, keyframes.last);
    assert.equal(r2.status, 200);
    const third = makePng(0x77, 0x88, 0x99);
    const r3 = await stageKeyframe(port, jobId, third);
    assert.equal(r3.status, 503);
    assert.equal(r3.json.error, 'storage-unavailable');
    // (h) An unauthenticated stage is 401.
    const rNoAuth = await fetch(`http://127.0.0.1:${port}/internal/stage?jobId=${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sha256': keyframeHashes.first,
        'X-Size': String(keyframes.first.length),
      },
      body: keyframes.first,
    });
    assert.equal(rNoAuth.status, 401);
    // (i) A declared Content-Length > 10 MB is refused 413 WITHOUT
    // reading the body (the pre-check fires on the declared length).
    const rBig = await rawStagePost(port, `/internal/stage?jobId=${encodeURIComponent(`nexora:${randomUUID()}`)}`, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(11 * 1024 * 1024),
      'X-Sha256': keyframeHashes.first,
      'X-Size': String(11 * 1024 * 1024),
    }, [Buffer.from('x'.repeat(100))]);
    assert.equal(rBig.status, 413);
    assert.equal(JSON.parse(rBig.text).reason, 'file-too-large');
    // (j) A chunked body (no Content-Length) that streams past 10 MB
    // is aborted at 10 MB with the same 413.
    const bigChunks = Array.from({ length: 11 }, () => Buffer.alloc(1024 * 1024, 0x89));
    const rLiar = await rawStagePost(port, `/internal/stage?jobId=${encodeURIComponent(`nexora:${randomUUID()}`)}`, {
      'Content-Type': 'application/octet-stream',
      'X-Sha256': keyframeHashes.first,
      'X-Size': String(11 * 1024 * 1024),
    }, bigChunks);
    assert.equal(rLiar.status, 413);
    assert.equal(JSON.parse(rLiar.text).reason, 'file-too-large');
    // (k) Submit WITHOUT staging: 400 staging-failed /
    // keyframe-hash-mismatch, no manager job, no reservation.
    const jobId2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(jobId2, att.attestation_id, keyframeHashes);
    const out2 = await api.dispatch.submitNexora(body2, submitBodyText(body2));
    assert.equal(out2.status, 400);
    assert.equal(out2.body.error, 'staging-failed');
    assert.equal(out2.body.reason, 'keyframe-hash-mismatch');
    assert.equal(managerJobFor(api, jobId2), null);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0);
    // (l) Submit with only ONE keyframe staged: same refusal.
    const jobId3 = `nexora:${randomUUID()}`;
    const rOnly = await stageKeyframe(port, jobId3, keyframes.first);
    assert.equal(rOnly.status, 200);
    const body3 = nexoraSubmitBody(jobId3, att.attestation_id, keyframeHashes);
    const out3 = await api.dispatch.submitNexora(body3, submitBodyText(body3));
    assert.equal(out3.status, 400);
    assert.equal(out3.body.reason, 'keyframe-hash-mismatch');
    // (m) Submit with keyframes staged for a DIFFERENT job: same.
    const body4 = nexoraSubmitBody(`nexora:${randomUUID()}`, att.attestation_id, keyframeHashes);
    const out4 = await api.dispatch.submitNexora(body4, submitBodyText(body4));
    assert.equal(out4.status, 400);
    assert.equal(out4.body.reason, 'keyframe-hash-mismatch');
    // (n) A fully-staged submit is accepted — and the staged files
    // leave the quarantine on acceptance (referenced by the job).
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await api.dispatch.submitNexora(body, submitBodyText(body));
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(api.dispatch.stagingStore.referencedHashes(jobId).length, 2);
    // (o) The sweep deletes stale UNREFERENCED files but never a
    // referenced one: an orphan staged for a job that never submits
    // is swept after 1 h; the accepted job's files survive.
    const jobId4 = `nexora:${randomUUID()}`;
    const orphanBytes = makePng(0xaa, 0xbb, 0xcc);
    const rOrphan = await stageKeyframe(port, jobId4, orphanBytes);
    assert.equal(rOrphan.status, 200);
    const swept = api.dispatch.stagingStore.sweepUnreferenced(Date.now() + 3600_001);
    assert.equal(swept.deleted, 1);
    assert.equal(api.dispatch.stagingStore.pathFor(sha256HexBytes(orphanBytes)), null);
    assert.ok(api.dispatch.stagingStore.pathFor(keyframeHashes.first));
    assert.ok(api.dispatch.stagingStore.pathFor(keyframeHashes.last));
  } finally {
    await cleanup();
  }
  // (p) A halted client's stage is refused 503 client-halted — and
  // nothing is staged (the refusal happens before any store write).
  const halted = await nexoraApi(t);
  try {
    const { port: hport } = await halted.api.start();
    halted.api.setNexoraHalt({ halted: true, reason: 'test-halt' });
    const jobIdH = `nexora:${randomUUID()}`;
    const rH = await stageKeyframe(hport, jobIdH, halted.keyframes.first);
    assert.equal(rH.status, 503);
    assert.equal(rH.json.error, 'client-halted');
    assert.equal(halted.api.dispatch.stagingStore.pathFor(halted.keyframeHashes.first), null);
  } finally {
    await halted.cleanup();
  }
  // (q) Activation false: the nexora-v1 stage is refused 503
  // activation-false.
  const off = await nexoraApi(t, { personalFlag: false });
  try {
    const { port: oport } = await off.api.start();
    const rO = await stageKeyframe(oport, `nexora:${randomUUID()}`, off.keyframes.first);
    assert.equal(rO.status, 503);
    assert.equal(rO.json.error, 'activation-false');
  } finally {
    await off.cleanup();
  }
  // (r) Origin-paused: a NEXORA origin with a ledger orphan refuses
  // the stage 503 origin-paused.
  const paused = await nexoraApi(t);
  try {
    const { port: pport } = await paused.api.start();
    paused.api.nexoraLedger.reserve({
      jobId: `nexora:${randomUUID()}`,
      origin: 'nexora',
      hours: 0.5,
      nowMs: Date.now() - 25 * 3600_000,
    });
    const rP = await stageKeyframe(pport, `nexora:${randomUUID()}`, paused.keyframes.first);
    assert.equal(rP.status, 503);
    assert.equal(rP.json.error, 'origin-paused');
  } finally {
    await paused.cleanup();
  }
  // (s) The worker key stages ONLY under a live permit: without one
  // 503 activation-false; with one 200. The worker jobId namespace
  // is `worker:<uuid>`.
  const workerNoPermit = await nexoraApi(t);
  try {
    const { port: wport } = await workerNoPermit.api.start();
    const wjob = `worker:${randomUUID()}`;
    const wpath = `/internal/stage?jobId=${encodeURIComponent(wjob)}`;
    // The millisecond process-start rule rejects a worker-signed
    // timestamp from the process-start second — sign in the next.
    const waitMs = (Math.floor(processStartMs() / 1000) + 1) * 1000 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs + 5));
    const wheaders = signApiCall('test-secret', TEST_SIGNING_SECRET, 'POST', wpath, workerNoPermit.keyframes.first);
    const rW = await fetch(`http://127.0.0.1:${wport}${wpath}`, {
      method: 'POST',
      headers: {
        ...wheaders,
        'Content-Type': 'application/octet-stream',
        'X-Sha256': workerNoPermit.keyframeHashes.first,
        'X-Size': String(workerNoPermit.keyframes.first.length),
      },
      body: workerNoPermit.keyframes.first,
    });
    assert.equal(rW.status, 503);
    assert.equal((await rW.json()).error, 'activation-false');
  } finally {
    await workerNoPermit.cleanup();
  }
  const workerPermit = await nexoraApi(t);
  try {
    const { port: wpport } = await workerPermit.api.start();
    const permit = workerPermit.api.createCommissioningPermit({
      jobCanonicalHash: 'c'.repeat(64),
      maxHours: 1,
      licenceDeterminationRef: workerPermit.licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true, JSON.stringify(permit));
    const wjob2 = `worker:${randomUUID()}`;
    const wpath2 = `/internal/stage?jobId=${encodeURIComponent(wjob2)}`;
    const waitMs2 = (Math.floor(processStartMs() / 1000) + 1) * 1000 - Date.now();
    if (waitMs2 > 0) await new Promise((r) => setTimeout(r, waitMs2 + 5));
    const wheaders2 = signApiCall('test-secret', TEST_SIGNING_SECRET, 'POST', wpath2, workerPermit.keyframes.first);
    const rW2 = await fetch(`http://127.0.0.1:${wpport}${wpath2}`, {
      method: 'POST',
      headers: {
        ...wheaders2,
        'Content-Type': 'application/octet-stream',
        'X-Sha256': workerPermit.keyframeHashes.first,
        'X-Size': String(workerPermit.keyframes.first.length),
      },
      body: workerPermit.keyframes.first,
    });
    const rW2Text = await rW2.text();
    assert.equal(rW2.status, 200, rW2Text);
    assert.equal(JSON.parse(rW2Text).staged, true);
  } finally {
    await workerPermit.cleanup();
  }
});

// -- T-V27: activation.conf cases (unit level) -----------------------------------
// T-V13 covers the same cases as observable behaviour (latch + submit
// refusal); these are the distinct verifyActivationConfigFile outcomes
// the design lists separately.

test('T-V27: activation.conf missing / malformed / symlink / owner / group / mode / parent / changed cases (v13 §3.3: 0440, root:nova-api, value comparison, no SHA comparison)', async (t) => {
  const dir = tempDir(t);
  const goodText = 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=true\n';
  const expectedFlags = { publicProductionActivated: false, personalProductionActivated: true };
  // The v13 expected values for a test-owned file: 0440, the test
  // process's uid/gid, parent owned by the test process.
  const expected = {
    expectedFlags,
    expectedOwnerUid: process.getuid(),
    expectedGroupGid: process.getgid(),
    expectedMode: 0o440,
    expectedParentUid: process.getuid(),
  };
  const good = path.join(dir, 'good.conf');
  fs.writeFileSync(good, goodText, 'utf8');
  fs.chmodSync(good, 0o440);
  const { flags, sha256 } = readActivationConfigWithHash(good, {
    ownerUid: process.getuid(),
    groupGid: process.getgid(),
    mode: 0o440,
    parentUid: process.getuid(),
  });
  assert.equal(flags.personalProductionActivated, true);
  assert.equal(sha256, sha256Hex(goodText));
  const ok = verifyActivationConfigFile(good, expected);
  assert.equal(ok.ok, true);
  assert.equal(ok.flags.personalProductionActivated, true);
  assert.equal(ok.sha256, sha256);
  // Missing, no startup baseline: ok, flags false.
  const missing = verifyActivationConfigFile(path.join(dir, 'absent.conf'), { ...expected, expectedFlags: null });
  assert.equal(missing.ok, true);
  assert.equal(missing.flags.personalProductionActivated, false);
  // Deleted after start: missing with a startup baseline.
  const deleted = verifyActivationConfigFile(path.join(dir, 'absent.conf'), expected);
  assert.deepEqual(deleted, { ok: false, reason: 'missing' });
  // Appeared after start: a file where the baseline was missing.
  const appeared = verifyActivationConfigFile(good, { ...expected, expectedFlags: null });
  assert.deepEqual(appeared, { ok: false, reason: 'appeared-after-start' });
  // Symlink: refused outright, never followed.
  const link = path.join(dir, 'link.conf');
  fs.symlinkSync(good, link);
  assert.deepEqual(
    verifyActivationConfigFile(link, expected),
    { ok: false, reason: 'symlink' },
  );
  // Wrong mode (0644, and the old 0600 rule — v13 requires 0440).
  for (const mode of [0o644, 0o600]) {
    const modeBad = path.join(dir, `mode-${mode.toString(8)}.conf`);
    fs.writeFileSync(modeBad, goodText, 'utf8');
    fs.chmodSync(modeBad, mode);
    assert.deepEqual(
      verifyActivationConfigFile(modeBad, expected),
      { ok: false, reason: 'wrong-mode' },
      `mode ${mode.toString(8)} must be wrong-mode`,
    );
  }
  // Wrong owner (chown to the nova-api uid 999; the test expects its own uid).
  const ownerBad = path.join(dir, 'owner.conf');
  fs.writeFileSync(ownerBad, goodText, 'utf8');
  fs.chmodSync(ownerBad, 0o440);
  fs.chownSync(ownerBad, 999, 999);
  assert.deepEqual(
    verifyActivationConfigFile(ownerBad, expected),
    { ok: false, reason: 'wrong-owner' },
  );
  // Wrong group (owner right, group nova-api 993 instead of the test gid).
  const groupBad = path.join(dir, 'group.conf');
  fs.writeFileSync(groupBad, goodText, 'utf8');
  fs.chmodSync(groupBad, 0o440);
  fs.chownSync(groupBad, process.getuid(), 993);
  assert.deepEqual(
    verifyActivationConfigFile(groupBad, expected),
    { ok: false, reason: 'wrong-group' },
  );
  // Hardlink (nlink 2).
  const hard = path.join(dir, 'hard.conf');
  fs.linkSync(good, hard);
  assert.deepEqual(
    verifyActivationConfigFile(hard, expected),
    { ok: false, reason: 'hardlink' },
  );
  // Changed VALUE (personal flag flipped vs the startup-loaded value)
  // → activation-config-changed. The SHA-256 is NOT compared: the same
  // file with only the public flag flipped (personal unchanged) verifies
  // clean — the design compares personalProductionActivated only.
  const changed = path.join(dir, 'changed.conf');
  fs.writeFileSync(changed, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=false\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n', 'utf8');
  fs.chmodSync(changed, 0o440);
  assert.deepEqual(
    verifyActivationConfigFile(changed, expected),
    { ok: false, reason: 'activation-config-changed' },
  );
  const publicOnly = path.join(dir, 'public-only.conf');
  fs.writeFileSync(publicOnly, 'NOVA_PUBLIC_PRODUCTION_ACTIVATED=true\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=true\n', 'utf8');
  fs.chmodSync(publicOnly, 0o440);
  assert.equal(verifyActivationConfigFile(publicOnly, expected).ok, true);
  // Parent directory: a symlinked parent, a group/other-writable
  // parent, and a parent owned by someone else are all refused.
  const realSub = path.join(dir, 'real-sub');
  fs.mkdirSync(realSub);
  const parentFile = path.join(realSub, 'parent.conf');
  fs.writeFileSync(parentFile, goodText, 'utf8');
  fs.chmodSync(parentFile, 0o440);
  const linkDir = path.join(dir, 'link-sub');
  fs.symlinkSync(realSub, linkDir);
  assert.deepEqual(
    verifyActivationConfigFile(path.join(linkDir, 'parent.conf'), expected),
    { ok: false, reason: 'parent-symlink' },
  );
  const writableSub = path.join(dir, 'writable-sub');
  fs.mkdirSync(writableSub);
  fs.chmodSync(writableSub, 0o777);
  const writableFile = path.join(writableSub, 'w.conf');
  fs.writeFileSync(writableFile, goodText, 'utf8');
  fs.chmodSync(writableFile, 0o440);
  assert.deepEqual(
    verifyActivationConfigFile(writableFile, expected),
    { ok: false, reason: 'parent-writable' },
  );
  assert.deepEqual(
    verifyActivationConfigFile(parentFile, { ...expected, expectedParentUid: 999 }),
    { ok: false, reason: 'parent-not-root' },
  );
  // Malformed, duplicate key, unknown value, True, 1.
  const badCases = [
    'not key value at all\n',
    'NOVA_PERSONAL_PRODUCTION_ACTIVATED=true\nNOVA_PERSONAL_PRODUCTION_ACTIVATED=false\n',
    'NOVA_PERSONAL_PRODUCTION_ACTIVATED=True\n',
    'NOVA_PERSONAL_PRODUCTION_ACTIVATED=1\n',
    'NOVA_PERSONAL_PRODUCTION_ACTIVATED=yes\n',
    'NOVA_UNKNOWN_KEY=true\n',
  ];
  for (const [i, text] of badCases.entries()) {
    const p = path.join(dir, `bad-${i}.conf`);
    fs.writeFileSync(p, text, 'utf8');
    fs.chmodSync(p, 0o440);
    assert.deepEqual(
      verifyActivationConfigFile(p, expected),
      { ok: false, reason: 'malformed' },
      `bad case ${i} must be malformed`,
    );
  }
});

// -- T-V28: never-submitted job ---------------------------------------------------

test('T-V28: GET /internal/job?jobId=<never-submitted> is 404 { found: false } (query form, v13 §5.8; the path form still works)', async (t) => {
  const { api, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const jobId = `nexora:${randomUUID()}`;
    // Query form: the NEXORA client's reconcile endpoint.
    const query = `/internal/job?jobId=${encodeURIComponent(jobId)}&hash=${'a'.repeat(64)}`;
    const { headers } = nexoraHeaders('GET', query, '');
    const r = await httpJson(port, 'GET', query, { headers });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { found: false });
    // A jobId outside the caller's namespace is also not found (the
    // caller learns nothing about the other namespace's jobs).
    const cross = `/internal/job?jobId=${encodeURIComponent(`worker:${randomUUID()}`)}`;
    const { headers: ch } = nexoraHeaders('GET', cross, '');
    const rc = await httpJson(port, 'GET', cross, { headers: ch });
    assert.equal(rc.status, 404);
    assert.deepEqual(rc.json, { found: false });
    // Path form: still working (backwards-compatible).
    const path = `/internal/jobs/${encodeURIComponent(jobId)}`;
    const { headers: ph } = nexoraHeaders('GET', path, '');
    const rp = await httpJson(port, 'GET', path, { headers: ph });
    assert.equal(rp.status, 404);
    assert.deepEqual(rp.json, { found: false });
  } finally {
    await cleanup();
  }
});

// -- T-V29: termination-reconciliation ----------------------------------------------

test('T-V29: a lost submit response reconciles from the NOVA journal by jobId + hash — no second execution', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const bodyText = submitBodyText(body);
    const { headers } = nexoraHeaders('POST', '/internal/submit', bodyText);
    // The submit succeeds — but the client "loses" the response.
    // (v13 §5.7: the keyframes are staged before the submit.)
    stageForSubmit(api, body);
    const submitted = await httpJson(port, 'POST', '/internal/submit', { bodyText, headers });
    assert.equal(submitted.status, 202);
    // Reconcile via job_state instead of re-submitting blindly —
    // the query form (v13 §5.8), with the stored hash for hash_match.
    const jobQuery = `/internal/job?jobId=${encodeURIComponent(jobId)}&hash=${submitted.json.canonical_request_hash}`;
    const { headers: jheaders } = nexoraHeaders('GET', jobQuery, '');
    const state = await httpJson(port, 'GET', jobQuery, { headers: jheaders });
    assert.equal(state.status, 200);
    assert.equal(state.json.found, true);
    assert.equal(state.json.jobId, jobId);
    assert.equal(state.json.managerJobId, submitted.json.managerJobId);
    assert.equal(state.json.canonical_request_hash, submitted.json.canonical_request_hash);
    assert.equal(state.json.hash_match, true);
    // A wrong hash still finds the job but reports no match.
    const wrongQuery = `/internal/job?jobId=${encodeURIComponent(jobId)}&hash=${'0'.repeat(64)}`;
    const { headers: wheaders } = nexoraHeaders('GET', wrongQuery, '');
    const wrongState = await httpJson(port, 'GET', wrongQuery, { headers: wheaders });
    assert.equal(wrongState.status, 200);
    assert.equal(wrongState.json.found, true);
    assert.equal(wrongState.json.hash_match, false);
    // The path form still works (backwards-compatible).
    const jobPath = `/internal/jobs/${encodeURIComponent(jobId)}`;
    const { headers: pheaders } = nexoraHeaders('GET', jobPath, '');
    const pathState = await httpJson(port, 'GET', jobPath, { headers: pheaders });
    assert.equal(pathState.status, 200);
    assert.equal(pathState.json.found, true);
    assert.equal(pathState.json.managerJobId, submitted.json.managerJobId);
    // A re-submit of the same payload returns the existing state (200),
    // not a second execution.
    const { headers: h2 } = nexoraHeaders('POST', '/internal/submit', bodyText);
    const again = await httpJson(port, 'POST', '/internal/submit', { bodyText, headers: h2 });
    assert.equal(again.status, 200);
    assert.equal(again.json.managerJobId, submitted.json.managerJobId);
    assert.equal(Object.values(api.manager.store.state.jobs ?? {}).filter((j) => j.params?.jobId === jobId).length, 1);
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
  } finally {
    await cleanup();
  }
});

// -- T-V30: third-party-purpose rejection ----------------------------------------------

test('T-V30: third-party purpose, third_party_work=true, and missing channel fields are refused and recorded in the audit', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    const variants = [
      ['purpose', { purpose: 'monetised-film' }],
      ['third_party_work', { third_party_work: true }],
      ['target_channel_id', { target_channel_id: '' }],
      ['target_channel_status', { target_channel_status: 'monetised' }],
      ['requester', { requester: 'third-party' }],
    ];
    for (const [label, override] of variants) {
      const jobId = `nexora:${randomUUID()}`;
      const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes, override);
      const out = await submitNexora(api, body);
      assert.equal(out.status, 400, label);
      assert.equal(out.body.error, 'invalid-submit', label);
      assert.equal(managerJobFor(api, jobId), null, label);
    }
    // Every refusal is recorded in the NOVA audit (the operator log).
    const refusals = (api.apiState.state.operatorLog ?? []).filter((e) => e.event === 'nexora-submit-refused');
    assert.equal(refusals.length, variants.length);
    for (const r of refusals) assert.match(r.jobId, /^nexora:/);
  } finally {
    await cleanup();
  }
});

// -- T-V31: licence blocking the first proof ------------------------------------------

test('T-V31: P-9 outstanding refuses the commissioning proof and any NEXORA rendering; a determination for another checkpoint does not satisfy it', async (t) => {
  // No licence record at all.
  const unlicensed = await nexoraApi(t, { licence: false });
  try {
    assert.equal(licenceSatisfiedFor(unlicensed.api.apiState, CHECKPOINT_SHA256), false);
    // The commissioning permit cannot even be created.
    const permit = unlicensed.api.createCommissioningPermit({
      jobCanonicalHash: 'a'.repeat(64),
      maxHours: 0.5,
      licenceDeterminationRef: 'lic-nonexistent',
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, false);
    assert.equal(permit.reason, 'licence-missing');
    // And a NEXORA submit refuses before any rendering.
    const att = attestInProcess(unlicensed.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, unlicensed.keyframeHashes);
    const out = await submitNexora(unlicensed.api, body);
    assert.equal(out.status, 403);
    assert.equal(out.body.error, 'licence-refused');
    assert.equal(out.body.reason, 'licence-undetermined');
    assert.equal(managerJobFor(unlicensed.api, jobId), null);
  } finally {
    await unlicensed.cleanup();
  }
  // A determination for a DIFFERENT checkpoint does not satisfy this one.
  const wrongCheckpoint = await nexoraApi(t, { licence: false });
  try {
    wrongCheckpoint.api.setLicenceDetermination({
      kind: 'owner-determination',
      licenceTextSha256: 'b'.repeat(64),
      checkpointSha256: 'b'.repeat(64),
      evidenceRef: 'test-evidence',
      determinedBy: 'test-operator',
    });
    assert.equal(licenceSatisfiedFor(wrongCheckpoint.api.apiState, CHECKPOINT_SHA256), false);
    const att = attestInProcess(wrongCheckpoint.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, wrongCheckpoint.keyframeHashes);
    const out = await submitNexora(wrongCheckpoint.api, body);
    assert.equal(out.status, 403);
    assert.equal(out.body.reason, 'licence-undetermined');
  } finally {
    await wrongCheckpoint.cleanup();
  }
});

test('T-V31b: the payload checkpoint value is ignored (the manifest value governs); a licence record removed after acceptance holds the push, reservation retained', async (t) => {
  const { api, d1, keyframeHashes, licencePath, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    // A Worker personal job occupies the only kaggle-t4 slot, so the
    // NEXORA job queues instead of dispatching.
    const wbody = workerPersonalBody('t-v31b-nova');
    seedJobForSubmit(d1, wbody);
    assert.equal((await api.dispatch.submitExecutions(wbody)).status, 202);
    // A payload checkpoint hash that matches NOTHING is ignored: the
    // server reads the SHA-256 pinned in the run-10 template manifest,
    // never a payload value.
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, keyframeHashes, { checkpoint_sha256: 'f'.repeat(64) });
    const out1 = await submitNexora(api, body1);
    assert.equal(out1.status, 202);
    assert.equal(out1.body.dispatchState, 'queued');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
    // The licence record vanishes after acceptance: the push is
    // refused at the pre-handoff re-check and the job is held — the
    // reservation is RETAINED (released only on a confirmed terminal
    // state or operator resolve-orphan / cancel-held).
    fs.unlinkSync(licencePath);
    const held = api.dispatch._dispatchPersonalNext();
    assert.equal(held.dispatched, false);
    assert.equal(held.reason, 'held-licence-undetermined');
    assert.equal(api.dispatch.journalEntry(job1).state, 'held-licence-undetermined');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5, 'the held job keeps its reservation');
    // The record returns: re-evaluation clears the hold.
    api.setLicenceDetermination({
      kind: 'owner-determination',
      licenceTextSha256: 'a'.repeat(64),
      checkpointSha256: CHECKPOINT_SHA256,
      evidenceRef: 'test-evidence',
      determinedBy: 'test-operator',
    });
    const re = api.reEvaluateHeldJobs();
    assert.equal(re.find((r) => r.jobId === job1)?.state, 'submitted');
    assert.equal(api.nexoraLedger.snapshot().reservedX, 0.5);
  } finally {
    await cleanup();
  }
});

// -- T-V32: capacity preflight vs acceptance ------------------------------------------

test('T-V32: preflight passes, state changes before submit, acceptance refuses; the preflight response is fresh (<= 5 s)', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    // Preflight (NEXORA form): 200, signature verifies, nonce echoes,
    // timestamp is fresh, personal is authorised + activated, no
    // commissioning active.
    const path = '/internal/capacity?audience=personal';
    const { headers, nonce } = nexoraHeaders('GET', path, '');
    const r = await httpJson(port, 'GET', path, { headers });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.personalProductionAuthorised, true);
    assert.equal(r.json.personalProductionActivated, true);
    assert.equal(r.json.commissioning_active, false);
    const signature = r.headers.get('x-nova-signature');
    const timestamp = r.headers.get('x-nova-timestamp');
    assert.equal(r.headers.get('x-nova-nonce'), nonce);
    assert.equal(verifyNexoraResponseSignature({
      signingSecret: NEXORA_SIGNING_SECRET,
      bodyText: r.text,
      timestamp,
      nonce,
      signature,
    }), true);
    const ageMs = Date.now() - Date.parse(timestamp);
    assert.ok(ageMs >= 0 && ageMs < 5000, `capacity response must be fresh, age was ${ageMs} ms`);
    // State changes before the submit: the operator sets the halt.
    api.setNexoraHalt({ halted: true, reason: 'test state change' });
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'client-halted');
    // A preflight older than 5 s is stale and must be re-fetched: that
    // freshness check is the CLIENT's (_verify_capacity_response,
    // PREFLIGHT_MAX_AGE_S = 5) — the NOVA side guarantees the response
    // it issues is fresh (asserted above) and never serves a stale one.
    const ts2 = r.headers.get('x-nova-timestamp');
    assert.ok(Date.now() - Date.parse(ts2) < 5000);
  } finally {
    await cleanup();
  }
});

// -- T-V33: per-origin ledger arithmetic ----------------------------------------------
// Design v13 §6.2: Q = min(Q_total − C_N − C_X − C_C, Q_kaggle − D);
// reconciliation valid iff reconciled_at ≥ max(now − 24 h, last UTC
// reset); floor checked before cap (both failing → 'floor-reached').

test('T-V33: per-origin ledger arithmetic — v13 §6.2 (Q = min(30 - C_N - C_X - C_C, Q_kaggle - D); reconciliation; floor before cap)', async (t) => {
  // Pure arithmetic first (J = 0.5, F = 5, K_X = 5, reconciliation
  // valid, Kaggle headroom wide so the min() does not bind).
  const valid = { kaggleHeadroomHours: 30, reconciliationValid: true };
  assert.equal(computeAdmission({ consumedN: 23, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, ...valid }).ok, true);
  // Boundary: C_N = 24.5 admitted (Q = 5.5, Q − J = 5.0 >= 5).
  assert.equal(computeAdmission({ consumedN: 24.5, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, ...valid }).ok, true);
  assert.equal(computeAdmission({ consumedN: 24.6, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, ...valid }).reason, 'floor-reached');
  // C_N = 20 / C_X = 5: BOTH floor and cap fail — the reported reason
  // is floor-reached (floor is checked first).
  assert.equal(computeAdmission({ consumedN: 20, reservedN: 0, consumedX: 5, reservedX: 0, jobHours: 0.5, ...valid }).reason, 'floor-reached');
  assert.equal(computeAdmission({ consumedN: 10, reservedN: 0, consumedX: 4.6, reservedX: 0, jobHours: 0.5, ...valid }).reason, 'nexora-cap-reached');
  // C_C counts in Q but not against the cap: C_N = 20 / C_C = 5 →
  // Q = 5, Q − J = 4.5 < 5 → floor-reached (cap untouched, C_X = 0).
  assert.equal(computeAdmission({ consumedN: 20, consumedC: 5, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, ...valid }).reason, 'floor-reached');
  // The Kaggle term binds: ledger Q = 10 but Q_kaggle − D = 5.2 →
  // Q = 5.2, Q − J = 4.7 < 5 → floor-reached.
  assert.equal(computeAdmission({ consumedN: 20, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, kaggleHeadroomHours: 5.2, reconciliationValid: true }).reason, 'floor-reached');
  // No reconciliation → quota-unreconciled, before any arithmetic
  // (even a case that would otherwise admit).
  assert.equal(computeAdmission({ consumedN: 0, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5 }).reason, 'quota-unreconciled');
  assert.equal(computeAdmission({ consumedN: 0, reservedN: 0, consumedX: 0, reservedX: 0, jobHours: 0.5, kaggleHeadroomHours: 30, reconciliationValid: false }).reason, 'quota-unreconciled');
  // 1. C_N = 23 admitted (Q - J = 6.5 >= 5).
  const c1 = await nexoraApi(t);
  try {
    seedConsumedN(c1.api, 23);
    const att = attestInProcess(c1.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c1.keyframeHashes);
    assert.equal((await submitNexora(c1.api, body)).status, 202);
  } finally {
    await c1.cleanup();
  }
  // 2. C_N = 24.6 refused floor-reached (Q - J = 4.9 < 5). NOTE: the
  // Worker path would still ADMIT here (remaining 5.4 > 5) — the
  // ledger check reserves the job's hours and the Worker check does
  // not. That asymmetry is the design's: the ledger is the NEXORA
  // gate, the tracker remaining is the Worker gate.
  const c2 = await nexoraApi(t);
  try {
    seedConsumedN(c2.api, 24.6);
    const att = attestInProcess(c2.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c2.keyframeHashes);
    const out = await submitNexora(c2.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.reason, 'floor-reached');
  } finally {
    await c2.cleanup();
  }
  // 3. C_N = 20 / C_X = 5 refused floor-reached (Q = 5, Q - J = 4.5).
  const c3 = await nexoraApi(t);
  try {
    seedConsumedN(c3.api, 20);
    seedConsumedX(c3.api, 5);
    const att = attestInProcess(c3.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c3.keyframeHashes);
    const out = await submitNexora(c3.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.reason, 'floor-reached');
  } finally {
    await c3.cleanup();
  }
  // 4. C_N = 10 / C_X = 4.6: NEXORA refused nexora-cap-reached
  // (4.6 + 0.5 = 5.1 > 5), NOVA admitted (remaining 20 > 5).
  const c4 = await nexoraApi(t);
  try {
    seedConsumedN(c4.api, 10);
    seedConsumedX(c4.api, 4.6);
    const att = attestInProcess(c4.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c4.keyframeHashes);
    const out = await submitNexora(c4.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.reason, 'nexora-cap-reached');
    const wbody = workerPersonalBody('t-v33-nova');
    seedJobForSubmit(c4.d1, wbody);
    const wout = await c4.api.dispatch.submitExecutions(wbody);
    assert.equal(wout.status, 202, JSON.stringify(wout.body));
  } finally {
    await c4.cleanup();
  }
  // 5. Never reconciled → every NEXORA submit is refused
  // 'quota-unreconciled' (the ledger gate runs before the floor/cap
  // arithmetic).
  const c5 = await nexoraApi(t, { reconciled: false });
  try {
    const att = attestInProcess(c5.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c5.keyframeHashes);
    const out = await submitNexora(c5.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'quota-refused');
    assert.equal(out.body.reason, 'quota-unreconciled');
    assert.equal(managerJobFor(c5.api, jobId), null);
  } finally {
    await c5.cleanup();
  }
  // 6. Reconciled Fri 27 Nov 23:00 UTC, submitted Sat 28 Nov 00:30
  // UTC — the week reset (Saturday 00:00 UTC) invalidates the
  // reconciliation even though it is only 1.5 h old → refused
  // 'quota-unreconciled'.
  let clock = Date.parse('2026-11-27T23:00:00.000Z');
  const c6 = await nexoraApi(t, { now: () => clock });
  try {
    clock = Date.parse('2026-11-28T00:30:00.000Z');
    const att = attestInProcess(c6.api, NEXORA_SESSION, clock);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, c6.keyframeHashes);
    const out = await submitNexora(c6.api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.reason, 'quota-unreconciled');
    // And a fresh reconciliation at the new time re-admits.
    c6.api.reconcileQuota({ kaggleRemainingHours: 30 });
    assert.equal((await submitNexora(c6.api, body)).status, 202);
  } finally {
    await c6.cleanup();
  }
  // 7. Push-step check: a held 0.5 h reservation + a fresh Kaggle
  // reading of 5.0 h → 5.0 − 0.5 = 4.5 < 5 → refuse the push; 5.5 h
  // → 5.5 − 0.5 = 5.0 ≥ 5 → push allowed.
  const c7 = await nexoraApi(t);
  try {
    c7.api.nexoraLedger.reserve({ jobId: 'push-test-job', origin: 'nexora', hours: 0.5 });
    assert.equal(c7.api.checkPush({ kaggleRemainingHours: 5.0 }).reason, 'floor-reached');
    assert.equal(c7.api.checkPush({ kaggleRemainingHours: 5.5 }).ok, true);
  } finally {
    await c7.cleanup();
  }
});

// -- T-V34: attestation expiry between submit and reconcile ------------
// As actually attainable (see the hash deviation in the T-V25
// comment): the design's literal second clause — "re-submit under a
// NEW attestation returns the existing job state" — does NOT hold,
// because the canonical request hash INCLUDES attestation_id (the
// landed NEXORA client hashes the full payload). What DOES hold, via
// the v13 acceptance order (duplicate-jobId lookup BEFORE
// attestation), is that an IDENTICAL re-submit returns the existing
// state even with an EXPIRED attestation — and reconcile via
// GET /internal/job needs no attestation at all.

test('T-V34: an attestation that expires between submit and reconcile does not block reconcile or an identical re-submit', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const { port } = await api.start();
    // Issue an attestation, submit, then let it expire. Revocation is
    // the observable equivalent of expiry here — the registry's 4 h
    // TTL is not fakeable in-process without a fake clock, and a
    // revoked attestation fails validation the same way an expired
    // one does.
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 202);
    const revoked = revokeAttestation(api.apiState, att.attestation_id);
    assert.equal(revoked.ok, true);
    // Reconcile needs no attestation: the query form answers 200
    // with the existing state + hash_match true.
    const query = `/internal/job?jobId=${encodeURIComponent(jobId)}&hash=${out.body.canonical_request_hash}`;
    const { headers } = nexoraHeaders('GET', query, '');
    const state = await httpJson(port, 'GET', query, { headers });
    assert.equal(state.status, 200);
    assert.equal(state.json.found, true);
    assert.equal(state.json.hash_match, true);
    assert.equal(state.json.managerJobId, out.body.managerJobId);
    // An IDENTICAL re-submit returns the existing state (200) even
    // though the attestation is now revoked — the duplicate-jobId
    // lookup runs before attestation (v13 §4 step 6).
    const again = await submitNexora(api, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.managerJobId, out.body.managerJobId);
  } finally {
    await cleanup();
  }
});

// -- T-V35: permit refusal cases --------------------------------------------------
// The v13 file-based permit (§3.5): every refusal case at the predicate
// level. The dispatch-level cases (permit expires between acceptance
// and push → still dispatches; queue-full refusal writes no marker)
// live in T-V35b after the Phase 6 dispatch rework.

test('T-V35: permit refusal cases — tampered / symlinked / wrong-mode / expired / replayed / different-hash / NEXORA key / missing issued_at / >24 h / future issued_at / invalid activation.conf', async (t) => {
  const { api, d1, licence, permitPath, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    const body = workerPersonalBody('t-v35-first');
    seedJobForSubmit(d1, body);
    const hash = canonicalRequestHash(canonicaliseJson(body));
    const base = {
      jobCanonicalHash: hash,
      origin: 'nova',
      personalActivated: false,
      activationValid: true,
      checkpointSha256: CHECKPOINT_SHA256,
      jobHours: 0.5,
    };
    // The predicate takes the caller's clock — a frozen nowMs goes
    // stale the moment a permit is re-issued (issued_at lands after
    // it), so every call stamps a fresh one.
    const auth = (extra = {}) => commissioningAuthorised(api.apiState, {
      ...base, nowMs: Date.now(), ...extra,
    });
    const create = () => api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    const writePermit = (obj) => {
      fs.writeFileSync(permitPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      fs.chmodSync(permitPath, 0o440);
    };
    const readPermit = () => JSON.parse(fs.readFileSync(permitPath, 'utf8'));
    const ok = create();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    // Live permit: authorises, and a different hash is hash-mismatch.
    assert.equal(auth().ok, true);
    assert.equal(auth({ jobCanonicalHash: 'b'.repeat(64) }).reason, 'hash-mismatch');
    // The NEXORA key never authorises a commissioning permit.
    assert.equal(auth({ keyId: 'nexora-v1' }).reason, 'wrong-origin');
    // An invalid activation.conf refuses commissioning too.
    assert.equal(auth({ activationValid: false }).reason, 'activation-invalid');
    // Tampered file (invalid JSON) → permit-invalid.
    fs.writeFileSync(permitPath, '{not json', 'utf8');
    fs.chmodSync(permitPath, 0o440);
    assert.equal(auth().reason, 'permit-invalid');
    assert.equal(create().ok, true, 'a tampered permit can be re-issued');
    // Symlinked file → permit-invalid (the strict reader never follows).
    const target = path.join(path.dirname(permitPath), 'permit-target.json');
    fs.writeFileSync(target, JSON.stringify(readPermit()), 'utf8');
    fs.unlinkSync(permitPath);
    fs.symlinkSync(target, permitPath);
    assert.equal(auth().reason, 'permit-invalid');
    fs.unlinkSync(permitPath);
    assert.equal(create().ok, true, 'a symlinked permit can be re-issued');
    // Wrong mode (0644) → permit-invalid; restoring 0440 restores it.
    fs.chmodSync(permitPath, 0o644);
    assert.equal(auth().reason, 'permit-invalid');
    fs.chmodSync(permitPath, 0o440);
    assert.equal(auth().ok, true);
    // Missing issued_at → invalid-permit.
    const noIssued = readPermit();
    delete noIssued.issued_at;
    writePermit(noIssued);
    assert.equal(auth().reason, 'permit-invalid');
    // expires_at − issued_at > 24 h → permit-expired (the creation
    // path refuses to write one, so this is hand-crafted).
    const tooLong = readPermit();
    writePermit({ ...tooLong, issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 25 * 3600 * 1000).toISOString() });
    assert.equal(auth().reason, 'permit-expired');
    // issued_at in the future → permit-expired.
    writePermit({ ...tooLong, issued_at: new Date(Date.now() + 3600 * 1000).toISOString(), expires_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString() });
    assert.equal(auth().reason, 'permit-expired');
    // Expired (expires_at in the past) → permit-expired.
    writePermit({ ...tooLong, issued_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(auth().reason, 'permit-expired');
    assert.equal(create().ok, true, 'an expired permit can be re-issued');
    // A real submit consumes the permit; a second authorisation for
    // the same hash is permit-consumed.
    assert.equal((await api.dispatch.submitExecutions(body)).status, 202);
    assert.equal(auth().reason, 'permit-consumed');
  } finally {
    await cleanup();
  }
});

// -- T-V37: jobId + nonce enforcement (v13 §3 D-2.3) --------------------------
// (a) The jobId form is a UUIDv4 in the caller's namespace, matched
// against the WHOLE string (fullmatch — a trailing newline does not
// slip past the `$`). (b) Cross-namespace submits and reconciles are
// refused / not found. (c) A timestamp 61 s off is stale; 59 s off is
// accepted. (d) A replay whose timestamp is still valid is refused
// by the NONCE store — and the same nonce under a different key id is
// a different record.

test('T-V37: jobId form, cross-namespace, stale timestamp, and nonce replay (v13 §3 D-2.3)', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    // (a) Malformed jobIds are 400 invalid-job-id — the form check
    // runs before attestation, so a fake attestation id suffices.
    const malformed = [
      // Uppercase hex (the pattern is lowercase-only).
      `nexora:${'AAAAAAAA-1111-4111-8111-111111111111'}`,
      // Version digit 5, not 4.
      `nexora:${'aaaaaaaa-1111-5111-8111-111111111111'}`,
      // Variant digit c — outside [89ab].
      `nexora:${'aaaaaaaa-1111-4111-c111-111111111111'}`,
      // Trailing newline: `$` would match before it, so the length
      // check (43 chars) is what refuses it.
      `nexora:${'aaaaaaaa-1111-4111-8111-111111111111'}\n`,
    ];
    for (const badId of malformed) {
      const body = nexoraSubmitBody(badId, 'att-never-issued', keyframeHashes);
      const out = await api.dispatch.submitNexora(body, submitBodyText(body));
      assert.equal(out.status, 400, badId);
      assert.equal(out.body.error, 'invalid-job-id', badId);
      assert.equal(managerJobFor(api, badId), null);
    }
    // Control: the same UUID in valid form passes the form check (it
    // fails later, at attestation — never as invalid-job-id).
    const goodId = `nexora:${'aaaaaaaa-1111-4111-8111-111111111111'}`;
    const goodBody = nexoraSubmitBody(goodId, 'att-never-issued', keyframeHashes);
    const goodOut = await api.dispatch.submitNexora(goodBody, submitBodyText(goodBody));
    assert.notEqual(goodOut.body.error, 'invalid-job-id');

    // (b) Cross-namespace: a NEXORA-signed submit carrying a worker:
    // jobId is 400 invalid-job-id (the NEXORA path validates the
    // NEXORA form before anything else).
    const crossBody = nexoraSubmitBody(`worker:${randomUUID()}`, 'att-never-issued', keyframeHashes);
    const crossOut = await api.dispatch.submitNexora(crossBody, submitBodyText(crossBody));
    assert.equal(crossOut.status, 400);
    assert.equal(crossOut.body.error, 'invalid-job-id');

    // (c) Stale timestamps over HTTP (the reconcile endpoint needs no
    // attestation, so auth is the only gate).
    const { port } = await api.start();
    const query = `/internal/job?jobId=${encodeURIComponent(`nexora:${randomUUID()}`)}&hash=${'a'.repeat(64)}`;
    const future61 = nexoraHeaders('GET', query, '', { timestamp: new Date(Date.now() + 61000).toISOString() });
    const r61 = await httpJson(port, 'GET', query, { headers: future61.headers });
    assert.equal(r61.status, 401);
    assert.equal(r61.json.error, 'stale-timestamp');
    const past61 = nexoraHeaders('GET', query, '', { timestamp: new Date(Date.now() - 61000).toISOString() });
    const rPast = await httpJson(port, 'GET', query, { headers: past61.headers });
    assert.equal(rPast.status, 401);
    assert.equal(rPast.json.error, 'stale-timestamp');
    // 59 s off is accepted past auth (404 — the job was never
    // submitted — proves auth passed; a stale timestamp would be 401).
    const future59 = nexoraHeaders('GET', query, '', { timestamp: new Date(Date.now() + 59000).toISOString() });
    const r59 = await httpJson(port, 'GET', query, { headers: future59.headers });
    assert.equal(r59.status, 404);
    assert.deepEqual(r59.json, { found: false });

    // (b, continued) The WORKER branch asking for a nexora: jobId
    // finds nothing (namespace enforcement on the query form).
    const waitMs = (Math.floor(processStartMs() / 1000) + 1) * 1000 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs + 5));
    const wquery = `/internal/job?jobId=${encodeURIComponent(`nexora:${randomUUID()}`)}`;
    const wheaders = signApiCall('test-secret', TEST_SIGNING_SECRET, 'GET', wquery, '');
    const rw = await httpJson(port, 'GET', wquery, { headers: wheaders });
    assert.equal(rw.status, 404);
    assert.deepEqual(rw.json, { found: false });
  } finally {
    await cleanup();
  }

  // (d) Replay, at unit level with a faked clock (the exact design
  // numbers — a 119 s wall-clock wait would stall the suite): a
  // request timestamped +60 s, replayed 119 s later. The timestamp is
  // then 59 s old — still inside the ±60 s window — so the TIMESTAMP
  // check passes and the NONCE store refuses it (step 5).
  const dir = tempDir(t);
  const store = new SqliteNonceStore(path.join(dir, 'nonces.db'));
  const replayApi = await nexoraApi(t);
  try {
    const auth = {
      apiSecrets: [NEXORA_API_SECRET],
      signingSecrets: [NEXORA_SIGNING_SECRET],
      apiState: replayApi.api.apiState,
      nonceStore: store,
    };
    const t0 = Date.now();
    const query = `/internal/job?jobId=${encodeURIComponent(`nexora:${randomUUID()}`)}`;
    const { headers, nonce } = nexoraHeaders('GET', query, '', {
      timestamp: new Date(t0 + 60000).toISOString(),
    });
    // Node lowercases real incoming headers; the fake req must too.
    const lc = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { headers: lc };
    const first = verifyNexoraAuth(req, 'GET', query, '', auth, { nowMs: t0 });
    assert.equal(first.ok, true, JSON.stringify(first));
    const replay = verifyNexoraAuth(req, 'GET', query, '', auth, { nowMs: t0 + 119000 });
    assert.equal(replay.ok, false);
    assert.equal(replay.step, 5);
    // The same nonce under a different key id is a different record:
    // the Worker key consumes it fine (the composite (key_id, nonce)
    // key — the Step 2 nonce-store tests cover the store itself; this
    // is the same nonce the NEXORA branch just consumed).
    assert.equal(store.consume('worker', nonce, t0 + 119000 + 3600000), true);
  } finally {
    await replayApi.cleanup();
  }
});

// -- T-V38: max_hours ceiling -----------------------------------------------------

test('T-V38: max_hours is a ceiling on the job budget J — admission refuses J > max_hours, and the refusal consumes nothing', async (t) => {
  const { api, d1, licence, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    const body = workerPersonalBody('t-v38-first');
    seedJobForSubmit(d1, body);
    const hash = canonicalRequestHash(canonicaliseJson(body));
    const permit = api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true);
    const base = {
      jobCanonicalHash: hash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    };
    // Predicate level: J = 1.0 > max_hours 0.5 refuses; J = 0.5 passes.
    assert.equal(commissioningAuthorised(api.apiState, { ...base, jobHours: 1.0 }).reason, 'max-hours-exceeded');
    assert.equal(commissioningAuthorised(api.apiState, { ...base, jobHours: 0.5 }).ok, true);
    assert.equal(commissioningAuthorised(api.apiState, { ...base, jobHours: 0.25 }).ok, true);
  } finally {
    await cleanup();
  }
  // Integration: an API whose job budget is 1.0 h refuses the submit
  // under a 0.5 h permit — and the refusal writes NO consumed marker,
  // so the permit still authorises a 0.5 h job afterwards.
  const big = await nexoraApi(t, { personalFlag: false, jobBudgetHours: 1.0 });
  try {
    const body = workerPersonalBody('t-v38-big');
    seedJobForSubmit(big.d1, body);
    const hash = canonicalRequestHash(canonicaliseJson(body));
    const permit = big.api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: big.licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true);
    const out = await big.api.dispatch.submitExecutions(body);
    assert.equal(out.status, 503);
    assert.equal(out.body.reason, 'max-hours-exceeded');
    assert.equal(managerJobFor(big.api, body.jobId), null);
    // The permit is NOT consumed by the refusal.
    assert.equal(commissioningAuthorised(big.api.apiState, {
      jobCanonicalHash: hash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256,
      jobHours: 0.5, nowMs: Date.now(),
    }).ok, true);
  } finally {
    await big.cleanup();
  }
});

// -- T-V36: halt clear requires a revisit decision ---------------------------

test('T-V36: clearing the mirrored halt without a recorded revisit decision is refused; with one it clears', async (t) => {
  const { api, keyframeHashes, cleanup } = await nexoraApi(t);
  try {
    const att = attestInProcess(api);
    api.setNexoraHalt({ halted: true, reason: 'monetisation concern' });
    // No revisit decision recorded: the clear is refused and the halt
    // stands — a submit still refuses client-halted.
    assert.throws(
      () => api.setNexoraHalt({ halted: false }),
      /no revisit decision/,
    );
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const out = await submitNexora(api, body);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'client-halted');
    // A decision recorded BEFORE the halt does not count (it must be
    // at/after the halt's changed_at) — record one now, then clear.
    api.recordRevisitDecision({ kind: 'kaggle-confirmation', detail: 't-v36: kaggle use confirmed non-commercial' });
    const cleared = api.setNexoraHalt({ halted: false });
    assert.equal(cleared.halted, false);
    const out2 = await submitNexora(api, body);
    assert.equal(out2.status, 202);
  } finally {
    await cleanup();
  }
});

// -- T-V39: halt cancellation release, before vs after push -------------------

test('T-V39: halt cancels a queued job and releases its reservation (cancelled-by-halt); a pushed job runs to terminal and releases only then', async (t) => {
  // Before push: the job queues (executor busy) and the halt cancels it.
  const queued = await nexoraApi(t);
  try {
    const att = attestInProcess(queued.api);
    const wbody = workerPersonalBody('t-v39-nova');
    seedJobForSubmit(queued.d1, wbody);
    assert.equal((await queued.api.dispatch.submitExecutions(wbody)).status, 202);
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, queued.keyframeHashes);
    const out1 = await submitNexora(queued.api, body1);
    assert.equal(out1.status, 202);
    assert.equal(out1.body.dispatchState, 'queued');
    assert.equal(queued.api.nexoraLedger.snapshot().reservedX, 0.5);
    queued.api.setNexoraHalt({ halted: true, reason: 'monetisation concern' });
    assert.equal(managerJobFor(queued.api, job1).status, 'cancelled');
    assert.equal(queued.api.nexoraLedger.snapshot().reservedX, 0, 'reservation released on cancel');
    assert.equal(queued.api.dispatch.journalEntry(job1).state, 'cancelled-by-halt');
  } finally {
    await queued.cleanup();
  }
  // After push: the job runs; the halt leaves it alone and the
  // reservation stays held until a confirmed terminal state.
  const pushed = await nexoraApi(t);
  try {
    const att = attestInProcess(pushed.api);
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att.attestation_id, pushed.keyframeHashes);
    const out2 = await submitNexora(pushed.api, body2);
    assert.equal(out2.status, 202);
    assert.equal(out2.body.dispatchState, 'slot-claimed');
    assert.equal(managerJobFor(pushed.api, job2).status, 'running');
    assert.equal(pushed.api.nexoraLedger.snapshot().reservedX, 0.5);
    pushed.api.setNexoraHalt({ halted: true, reason: 'monetisation concern' });
    assert.equal(managerJobFor(pushed.api, job2).status, 'running', 'a pushed job is not cancelled by the halt');
    assert.equal(pushed.api.nexoraLedger.snapshot().reservedX, 0.5, 'no release until terminal');
    assert.notEqual(pushed.api.dispatch.journalEntry(job2).state, 'cancelled-by-halt');
    // A terminal report settles the ledger: reserved 0, consumed 0.5
    // (the report carries secondsUsed 1800 = 0.5 h; a report with no
    // seconds would settle at 0 — the provider-reported figure
    // governs, with the J=0.5 fallback only when none is reported).
    const filed = await pushed.api.dispatch.fileReportForExecution(job2, { status: 'complete', output: Buffer.from('fake-video'), secondsUsed: 1800 });
    assert.equal(filed.filed, true, JSON.stringify(filed));
    for (let i = 0; i < 20 && pushed.api.nexoraLedger.snapshot().reservedX !== 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(pushed.api.nexoraLedger.snapshot().reservedX, 0);
    assert.equal(pushed.api.nexoraLedger.snapshot().consumedX, 0.5);
  } finally {
    await pushed.cleanup();
  }
});

// -- F-3: terminal-state recording (v12 item 14) --------------------------------
// A terminal executor report files the journal state for the two
// operator-filed terminal errors: a human-stopped kernel
// ('cancelled-by-human') and a kernel that exited on an nvidia-smi
// device mismatch ('device-mismatch'). Neither is auto-retried; a
// deliberate retry uses a new jobId. The reservation is released on
// the filed report, with the reported hours consumed.

test('F-3: a filed terminal report maps error cancelled-by-human / device-mismatch to the journal state (v12 item 14)', async (t) => {
  // cancelled-by-human: the human stops the run and files a failed
  // report via fileReport().
  const human = await nexoraApi(t);
  try {
    const att = attestInProcess(human.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, human.keyframeHashes);
    const out = await submitNexora(human.api, body);
    assert.equal(out.status, 202);
    assert.equal(out.body.dispatchState, 'slot-claimed');
    const filed = await human.api.dispatch.fileReportForExecution(jobId, {
      status: 'failed',
      error: 'cancelled-by-human',
      output: Buffer.from('fake-video'),
      secondsUsed: 600,
    });
    assert.equal(filed.filed, true, JSON.stringify(filed));
    for (let i = 0; i < 20 && human.api.dispatch.journalEntry(jobId).state !== 'cancelled-by-human'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(human.api.dispatch.journalEntry(jobId).state, 'cancelled-by-human');
    assert.equal(human.api.nexoraLedger.snapshot().reservedX, 0, 'reservation released on the filed report');
    assert.equal(human.api.nexoraLedger.snapshot().consumedX, 600 / 3600);
  } finally {
    await human.cleanup();
  }
  // device-mismatch: the kernel exits on an nvidia-smi mismatch; the
  // operator files it via fileReport(). Never auto-retried.
  const mismatch = await nexoraApi(t);
  try {
    const att = attestInProcess(mismatch.api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, mismatch.keyframeHashes);
    const out = await submitNexora(mismatch.api, body);
    assert.equal(out.status, 202);
    const filed = await mismatch.api.dispatch.fileReportForExecution(jobId, {
      status: 'failed',
      error: 'device-mismatch',
      output: Buffer.from('fake-video'),
      secondsUsed: 60,
    });
    assert.equal(filed.filed, true, JSON.stringify(filed));
    for (let i = 0; i < 20 && mismatch.api.dispatch.journalEntry(jobId).state !== 'device-mismatch'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(mismatch.api.dispatch.journalEntry(jobId).state, 'device-mismatch');
    assert.equal(mismatch.api.nexoraLedger.snapshot().reservedX, 0);
  } finally {
    await mismatch.cleanup();
  }
});

// -- T-V40: activation step under a permit ------------------------------------
test('T-V40: activation step under a permit — commissioning job accepted with a valid permit; ordinary Worker job and NEXORA job refused activation-false', async (t) => {
  const { api, d1, licence, keyframeHashes, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    // No permit yet: an ordinary Worker personal submit refuses with
    // activation-false (F-6 — the flag is off and no permit
    // authorises it), not no-capacity.
    const plain = workerPersonalBody('t-v40-plain');
    seedJobForSubmit(d1, plain);
    const refused = await api.dispatch.submitExecutions(plain);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, 'activation-false');
    // A commissioning job under a live permit for its exact body is
    // accepted while the flag is off.
    const comm = workerPersonalBody('t-v40-commissioning');
    seedJobForSubmit(d1, comm);
    const hash = canonicalRequestHash(canonicaliseJson(comm));
    const permit = api.createCommissioningPermit({
      jobCanonicalHash: hash,
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true, JSON.stringify(permit));
    const out = await api.dispatch.submitExecutions(comm);
    assert.equal(out.status, 202, JSON.stringify(out.body));
    // An ordinary Worker job (different body, no permit) still
    // refuses activation-false.
    const plain2 = workerPersonalBody('t-v40-plain-2');
    seedJobForSubmit(d1, plain2);
    const refused2 = await api.dispatch.submitExecutions(plain2);
    assert.equal(refused2.status, 503);
    assert.equal(refused2.body.error, 'activation-false');
    // A NEXORA job refuses activation-false EVEN with a live permit
    // bound to its exact body — a permit never authorises NEXORA.
    const att = attestInProcess(api);
    const jobId = `nexora:${randomUUID()}`;
    const body = nexoraSubmitBody(jobId, att.attestation_id, keyframeHashes);
    const permit2 = api.createCommissioningPermit({
      jobCanonicalHash: canonicalRequestHash(submitBodyText(body)),
      maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation',
      authorisedBy: 'test-operator',
    });
    assert.equal(permit2.ok, true, JSON.stringify(permit2));
    const nout = await submitNexora(api, body);
    assert.equal(nout.status, 503);
    assert.equal(nout.body.error, 'activation-false');
    assert.equal(managerJobFor(api, jobId), null);
  } finally {
    await cleanup();
  }
});

// -- T-V35b: permit at dispatch time --------------------------------------------

test('T-V35b: a permit that expires between acceptance and push still dispatches (time is not re-evaluated); a queue-full refusal writes no consumed marker', async (t) => {
  // Case 1: expiry between acceptance and push.
  const { api, d1, licence, permitPath, cleanup } = await nexoraApi(t, { personalFlag: false });
  try {
    // A first commissioning job occupies the only kaggle-t4 slot.
    const first = workerPersonalBody('t-v35b-first');
    seedJobForSubmit(d1, first);
    const firstHash = canonicalRequestHash(canonicaliseJson(first));
    assert.equal(api.createCommissioningPermit({
      jobCanonicalHash: firstHash, maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation', authorisedBy: 'test-operator',
    }).ok, true);
    const firstOut = await api.dispatch.submitExecutions(first);
    assert.equal(firstOut.status, 202, JSON.stringify(firstOut.body));
    // A second commissioning job under its own short-lived permit is
    // accepted and queues (executor busy) — the permit is consumed at
    // acceptance.
    const second = workerPersonalBody('t-v35b-second');
    seedJobForSubmit(d1, second);
    const secondHash = canonicalRequestHash(canonicaliseJson(second));
    const permit2 = api.createCommissioningPermit({
      jobCanonicalHash: secondHash, maxHours: 0.5,
      licenceDeterminationRef: licence.determination_id,
      authorisationRef: 'test-authorisation', authorisedBy: 'test-operator',
      expiresAtMs: Date.now() + 60 * 1000,
    });
    assert.equal(permit2.ok, true, JSON.stringify(permit2));
    const secondOut = await api.dispatch.submitExecutions(second);
    // The executor is busy, so the Worker path refuses the submit at
    // dispatch (503, Rev 2 §10.3 compensation) — but the manager job
    // EXISTS and stays queued, the permit is consumed at acceptance,
    // and the commissioning reservation is held (§6.2: released only
    // on a confirmed terminal state or operator resolve-orphan).
    assert.equal(secondOut.status, 503);
    assert.equal(secondOut.body.error, 'no-capacity');
    const secondJob = Object.values(api.manager.store.state.jobs ?? {})
      .find((j) => j.params?.jobId === second.jobId);
    assert.equal(secondJob?.status, 'queued');
    assert.equal(commissioningAuthorised(api.apiState, {
      jobCanonicalHash: secondHash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).reason, 'permit-consumed');
    assert.equal(api.nexoraLedger.snapshot().commissioning.reserved, 1.0);
    // The permit now expires (hand-rewritten past expires_at) BEFORE
    // the push. The pre-handoff re-check does NOT re-evaluate the time
    // conditions — the consumed marker is the authorisation — so the
    // job still dispatches once the executor frees.
    const record = JSON.parse(fs.readFileSync(permitPath, 'utf8'));
    assert.equal(record.permit_id, permit2.permit.permit_id);
    fs.writeFileSync(permitPath, JSON.stringify({
      ...record,
      issued_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }, null, 2) + '\n', 'utf8');
    fs.chmodSync(permitPath, 0o440);
    assert.equal(commissioningAuthorised(api.apiState, {
      jobCanonicalHash: secondHash, origin: 'nova', personalActivated: false,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).reason, 'permit-consumed', 'the consumed marker governs — the predicate checks consumed before expiry');
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(permitPath, 'utf8')).expires_at) < Date.now(), 'the file itself is expired now');
    // Free the executor: a running Kaggle kernel cannot be cancelled
    // programmatically (cancelJob only requests it), so the first job
    // is completed with a terminal report — the human channel — and
    // the manager marks it terminal. Then run the dispatch loop: the
    // second job dispatches despite the expiry.
    const firstExecId = `${first.jobId}:scene-0:attempt-1`;
    const filedFirst = await api.dispatch.fileReportForExecution(firstExecId, { status: 'complete', output: Buffer.from('fake-video'), secondsUsed: 1800 });
    assert.equal(filedFirst.filed, true, JSON.stringify(filedFirst));
    for (let i = 0; i < 20; i++) {
      const j = api.manager.store.state.jobs[firstOut.body.managerJobIds[0]];
      if (j && (j.status === 'succeeded' || j.status === 'failed' || j.status === 'complete')) break;
      await new Promise((r) => setImmediate(r));
    }
    const r = api.dispatch._dispatchPersonalNext();
    assert.equal(r.dispatched, true, JSON.stringify(r));
    const secondJobAfter = Object.values(api.manager.store.state.jobs ?? {})
      .find((j) => j.params?.jobId === second.jobId);
    assert.equal(secondJobAfter?.status, 'running');
  } finally {
    await cleanup();
  }
  // Case 2: a queue-full refusal writes no consumed marker.
  const queued = await nexoraApi(t);
  try {
    const workerBody = workerPersonalBody('t-v35b-worker');
    const workerHash = canonicalRequestHash(canonicaliseJson(workerBody));
    const permit = queued.api.createCommissioningPermit({
      jobCanonicalHash: workerHash, maxHours: 0.5,
      licenceDeterminationRef: queued.licence.determination_id,
      authorisationRef: 'test-authorisation', authorisedBy: 'test-operator',
    });
    assert.equal(permit.ok, true, JSON.stringify(permit));
    const att = attestInProcess(queued.api);
    const job1 = `nexora:${randomUUID()}`;
    const body1 = nexoraSubmitBody(job1, att.attestation_id, queued.keyframeHashes);
    assert.equal((await submitNexora(queued.api, body1)).status, 202);
    const job2 = `nexora:${randomUUID()}`;
    const body2 = nexoraSubmitBody(job2, att.attestation_id, queued.keyframeHashes);
    const out2 = await submitNexora(queued.api, body2);
    assert.equal(out2.status, 503);
    assert.equal(out2.body.error, 'queue-full');
    // The refusal wrote no marker: the permit still authorises.
    assert.equal(commissioningAuthorised(queued.api.apiState, {
      jobCanonicalHash: workerHash, origin: 'nova', personalActivated: true,
      activationValid: true, checkpointSha256: CHECKPOINT_SHA256, nowMs: Date.now(),
    }).ok, true);
    assert.deepEqual(queued.api.apiState.state.commissioningPermitMarkers, {});
  } finally {
    await queued.cleanup();
  }
});
