// NOVA AI Studio — commissioning mode (Kaggle design v13, §3.5).
//
// The MODE in code only — restricted one-job, NOVA-origin only,
// auto-expiry; its authorisation is a separate owner act.
//
// v13 storage: the permit lives in ONE FILE,
// /etc/nova-api/commissioning-permit.json (path injectable for
// tests). The file holds EXACTLY:
//   { permit_id, authorisation_ref, job_canonical_hash, max_hours,
//     issued_at, expires_at, licence_determination_ref }
// It is written by the operator tool (CLI-only, never an HTTP
// endpoint) running as root via writeStrictFile (write-temp + chown
// root:nova-api + chmod 0440 before rename — §3.3). Exactly ONE
// permit is active at a time (a second issue while one lives is
// refused `permit-exists`).
//
// The CONSUMED marker lives in api-state.json
// (`commissioningPermitMarkers`: permit_id -> { consumed_at, job_id }),
// written in the same serialised section as manager-job creation —
// the two JSON stores make the design's "same BEGIN IMMEDIATE"
// effectively serialised via the dispatcher's _submitQueue. A permit
// authorises exactly one job; a second use is `permit-consumed`. A
// refusal at acceptance (`origin-paused` / `queue-full`) writes NO
// marker, so the permit stays usable until `expires_at`.
//
// Acceptance predicate `commissioningAuthorised`: NOVA-origin only
// (the NEXORA key id is refused — NEXORA submits never consult this
// predicate), binds ONE canonical request hash (any other payload
// refused), `max_hours` is a ceiling on the job's budgeted hours J
// (admission refuses J > max_hours — `max-hours-exceeded`), the
// permit's licence determination must satisfy the job's checkpoint
// (P-9, T-V31), `activation.conf` must be VALID (its value may be
// false — the permit authorises IN PLACE OF the flag; the flag being
// already true is not a refusal — the caller only invokes this
// predicate when the flag is off). It never flips
// `personalProductionActivated` or `personalProductionAuthorised`.
// At DISPATCH only the marker, the licence, the activation validity
// and the §4.2-minus-flag conditions are re-checked — the time
// conditions are NOT re-evaluated, and the permit file may be absent
// at dispatch (a permit that expires between acceptance and push does
// not stop the push — T-V35).

import { randomUUID } from 'node:crypto';

import { licenceSatisfiedFor } from './licence.js';
import { verifyStrictFile, writeStrictFile, defaultStrictFileExpected } from './strict-file.js';

export const COMMISSIONING_MAX_DURATION_MS = 24 * 3600 * 1000; // ≤ 24 h after grant
export const DEFAULT_PERMIT_PATH = '/etc/nova-api/commissioning-permit.json';

const SHA256_RE = /^[0-9a-f]{64}$/;
const PERMIT_KEYS = [
  'permit_id', 'authorisation_ref', 'job_canonical_hash', 'max_hours',
  'issued_at', 'expires_at', 'licence_determination_ref',
].sort();

function permitPathOf(apiState) {
  return apiState?.commissioningPermitPath ?? DEFAULT_PERMIT_PATH;
}

function fileAccessOf(apiState) {
  const fa = apiState?.fileAccess;
  if (fa && typeof fa === 'object') return fa;
  return defaultStrictFileExpected();
}

function markersState(apiState) {
  apiState.reloadIfChanged();
  if (!apiState.state.commissioningPermitMarkers || typeof apiState.state.commissioningPermitMarkers !== 'object') {
    return {};
  }
  return apiState.state.commissioningPermitMarkers;
}

// Read + validate the permit file. Returns { ok: true, permit } or
// { ok: false, reason } where reason is a strict-reader reason
// ('missing', 'symlink', 'wrong-mode', ...) or 'invalid-permit'
// (JSON parse failure or a shape outside the §3.5 exact set). Never
// throws for file problems.
export function readPermitFile(apiState) {
  const fa = fileAccessOf(apiState);
  const read = verifyStrictFile(permitPathOf(apiState), {
    expectedOwnerUid: fa.ownerUid,
    expectedGroupGid: fa.groupGid,
    expectedMode: fa.mode,
    expectedParentUid: fa.parentUid,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  let permit;
  try {
    permit = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (JSON.stringify(Object.keys(permit).sort()) !== JSON.stringify(PERMIT_KEYS)) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.permit_id !== 'string' || permit.permit_id.length === 0) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.authorisation_ref !== 'string' || permit.authorisation_ref.length === 0) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.job_canonical_hash !== 'string' || !SHA256_RE.test(permit.job_canonical_hash)) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.max_hours !== 'number' || !Number.isFinite(permit.max_hours) || permit.max_hours <= 0) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.issued_at !== 'string' || Number.isNaN(Date.parse(permit.issued_at))
    || typeof permit.expires_at !== 'string' || Number.isNaN(Date.parse(permit.expires_at))) {
    return { ok: false, reason: 'invalid-permit' };
  }
  if (typeof permit.licence_determination_ref !== 'string' || permit.licence_determination_ref.length === 0) {
    return { ok: false, reason: 'invalid-permit' };
  }
  return { ok: true, permit };
}

function permitTimeValid(permit, nowMs) {
  const issuedMs = Date.parse(permit.issued_at);
  const expiresMs = Date.parse(permit.expires_at);
  if (issuedMs > nowMs) return false; // issued in the future
  if (expiresMs <= nowMs) return false; // expired
  if (expiresMs - issuedMs > COMMISSIONING_MAX_DURATION_MS) return false; // longer than 24 h
  return true;
}

export function hasConsumedMarker(apiState, permitId) {
  const markers = markersState(apiState);
  return markers[permitId]?.consumed_at != null;
}

// The single live permit, if any: the file reads clean, the time
// conditions hold, and no consumed marker exists. A missing/invalid/
// expired/consumed file means no live permit (null).
export function livePermit(apiState, nowMs = Date.now()) {
  const read = readPermitFile(apiState);
  if (!read.ok) return null;
  if (!permitTimeValid(read.permit, nowMs)) return null;
  if (hasConsumedMarker(apiState, read.permit.permit_id)) return null;
  return read.permit;
}

export function hasLiveCommissioningPermit(apiState, nowMs = Date.now()) {
  return livePermit(apiState, nowMs) !== null;
}

// Create a permit (OPERATOR ONLY — the CLI tool runs as root and
// writes the file via writeStrictFile). Returns { ok: true, permit }
// or { ok: false, reason } where reason is one of 'permit-exists' |
// 'invalid-max-hours' | 'expiry-too-long' | 'invalid-hash' |
// 'invalid-authorisation-ref' | 'licence-missing'. `expiresAtMs`
// defaults to 24 h after grant and may never exceed it.
// `authorisationRef` is REQUIRED — it names the owner authorisation
// the permit rests on. The P-15 refusal (a NOVA-origin job in
// orphan-check or held at dispatch) is enforced by the api-server
// operator wrapper, which owns the ledger + dispatcher — not here.
export function createCommissioningPermit(apiState, {
  jobCanonicalHash,
  maxHours,
  licenceDeterminationRef,
  authorisedBy,
  authorisationRef,
  expiresAtMs = null,
  nowMs = Date.now(),
  fileAccess = null,
} = {}) {
  if (typeof jobCanonicalHash !== 'string' || !SHA256_RE.test(jobCanonicalHash)) {
    return { ok: false, reason: 'invalid-hash' };
  }
  if (typeof maxHours !== 'number' || !Number.isFinite(maxHours) || maxHours <= 0) {
    return { ok: false, reason: 'invalid-max-hours' };
  }
  if (typeof authorisationRef !== 'string' || authorisationRef.length === 0) {
    return { ok: false, reason: 'invalid-authorisation-ref' };
  }
  const expiresMs = expiresAtMs ?? (nowMs + COMMISSIONING_MAX_DURATION_MS);
  if (expiresMs <= nowMs || expiresMs > nowMs + COMMISSIONING_MAX_DURATION_MS) {
    return { ok: false, reason: 'expiry-too-long' };
  }
  if (typeof licenceDeterminationRef !== 'string' || licenceDeterminationRef.length === 0) {
    return { ok: false, reason: 'licence-missing' };
  }
  if (!licenceSatisfiedFor(apiState, null, licenceDeterminationRef)) {
    return { ok: false, reason: 'licence-missing' };
  }
  if (livePermit(apiState, nowMs) !== null) {
    return { ok: false, reason: 'permit-exists' };
  }
  const permit = {
    permit_id: `permit-${randomUUID()}`,
    authorisation_ref: authorisationRef,
    job_canonical_hash: jobCanonicalHash,
    max_hours: maxHours,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    licence_determination_ref: licenceDeterminationRef,
  };
  const fa = fileAccess ?? fileAccessOf(apiState);
  writeStrictFile(permitPathOf(apiState), JSON.stringify(permit, null, 2) + '\n', {
    ownerUid: fa.ownerUid,
    groupGid: fa.groupGid,
    mode: fa.mode,
  });
  apiState.logOperator('commissioning-permit-issued', {
    permit_id: permit.permit_id,
    job_canonical_hash: jobCanonicalHash,
    max_hours: maxHours,
    authorisation_ref: authorisationRef,
    authorised_by: authorisedBy ?? 'operator',
    reason: 'm2p-commissioning',
  });
  return { ok: true, permit };
}

// The acceptance predicate. Returns { ok: true, permit } or
// { ok: false, reason } where reason is one of 'no-permit' |
// 'permit-invalid' | 'permit-consumed' | 'permit-expired' |
// 'hash-mismatch' | 'max-hours-exceeded' | 'wrong-origin' |
// 'activation-invalid' | 'licence-undetermined'.
// `checkpointSha256` is the LTX checkpoint the job would render with;
// the permit's licence determination must satisfy it (P-9, T-V31).
// `jobHours` is the job's budgeted hours J — admission refuses
// J > max_hours (T-V38). `keyId` is the signing key that presented
// the request — 'nexora-v1' is refused (wrong-origin).
export function commissioningAuthorised(apiState, {
  jobCanonicalHash,
  origin = 'nova',
  keyId = null,
  personalActivated = false,
  activationValid = true,
  checkpointSha256 = null,
  jobHours = null,
  nowMs = Date.now(),
} = {}) {
  void personalActivated; // v13 §3.5: the permit authorises IN PLACE OF
  // the flag — the flag's value is not a refusal ground here. (The
  // caller only invokes this predicate when the flag is off; a flag
  // already on authorises through the ordinary path instead.)
  if (origin !== 'nova') return { ok: false, reason: 'wrong-origin' };
  if (keyId === 'nexora-v1') return { ok: false, reason: 'wrong-origin' };
  if (activationValid !== true) return { ok: false, reason: 'activation-invalid' };
  const read = readPermitFile(apiState);
  if (!read.ok) {
    if (read.reason === 'missing') return { ok: false, reason: 'no-permit' };
    return { ok: false, reason: 'permit-invalid' };
  }
  const permit = read.permit;
  const timeValid = permitTimeValid(permit, nowMs);
  const consumed = hasConsumedMarker(apiState, permit.permit_id);
  // A permit that binds a DIFFERENT job: a live one reports
  // hash-mismatch; a consumed/expired one binds nothing anymore, so
  // the request sees no permit at all (v4 semantics, T-V17).
  if (permit.job_canonical_hash !== jobCanonicalHash) {
    if (timeValid && !consumed) return { ok: false, reason: 'hash-mismatch' };
    return { ok: false, reason: 'no-permit' };
  }
  if (consumed) {
    return { ok: false, reason: 'permit-consumed' };
  }
  if (!timeValid) {
    return { ok: false, reason: 'permit-expired' };
  }
  if (jobHours !== null && jobHours > permit.max_hours) {
    return { ok: false, reason: 'max-hours-exceeded' };
  }
  if (checkpointSha256 !== null
    && !licenceSatisfiedFor(apiState, checkpointSha256, permit.licence_determination_ref)) {
    return { ok: false, reason: 'licence-undetermined' };
  }
  return { ok: true, permit };
}

// Mark a permit consumed (called when its job's manager job is created
// — the point of no return for the job's existence — in the same
// serialised section as manager-job creation, so a permit authorises
// exactly one job). Idempotent. `jobId` is recorded in the marker as
// the evidence of which job consumed it.
export function consumeCommissioningPermit(apiState, permitId, { jobId = null, nowMs = Date.now() } = {}) {
  const read = readPermitFile(apiState);
  if (!read.ok || read.permit.permit_id !== permitId) {
    return { ok: false, reason: 'unknown-permit' };
  }
  if (hasConsumedMarker(apiState, permitId)) {
    return { ok: true, marker: { ...markersState(apiState)[permitId] } };
  }
  const marker = { consumed_at: new Date(nowMs).toISOString(), job_id: jobId };
  apiState.mutate((s) => {
    if (!s.commissioningPermitMarkers || typeof s.commissioningPermitMarkers !== 'object') {
      s.commissioningPermitMarkers = {};
    }
    s.commissioningPermitMarkers[permitId] = marker;
  });
  apiState.logOperator('commissioning-permit-consumed', {
    permit_id: permitId,
    job_id: jobId,
    reason: 'm2p-commissioning',
  });
  return { ok: true, marker: { ...marker } };
}

// Auto-expiry on terminal state (called by the commissioning job's
// finaliser): records the expiry in the marker map. The consumed
// marker already blocks any reuse; this is bookkeeping for the
// operator view. Idempotent.
export function expireCommissioningPermit(apiState, permitId, nowMs = Date.now()) {
  const read = readPermitFile(apiState);
  if (!read.ok || read.permit.permit_id !== permitId) {
    return { ok: false, reason: 'unknown-permit' };
  }
  apiState.mutate((s) => {
    if (!s.commissioningPermitMarkers || typeof s.commissioningPermitMarkers !== 'object') {
      s.commissioningPermitMarkers = {};
    }
    const marker = s.commissioningPermitMarkers[permitId] ?? {};
    marker.expired_at = new Date(nowMs).toISOString();
    s.commissioningPermitMarkers[permitId] = marker;
  });
  return { ok: true, permit: { ...read.permit } };
}
