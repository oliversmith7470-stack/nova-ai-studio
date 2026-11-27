// NOVA AI Studio — licence determinations (Kaggle design v13, §3.4,
// §7 F-15, §10 P-9).
//
// P-9 (Lightricks LTX licence reply) blocks the proof ITSELF: no
// rendering of any kind — including the M2-P commissioning proof —
// before the licence reply permits the intended use. A licence
// determination is an OPERATOR-set record (CLI-only, like fileReport /
// revokeSecret — never an HTTP endpoint) stating that the licence
// reply for one checkpoint permits the intended use, with the evidence
// reference the operator relied on.
//
// v13 storage: the record lives in ONE FILE,
// /etc/nova-api/licence-determination.json (path injectable for
// tests), written by the operator tool as root via writeStrictFile
// (write-temp + chown root:nova-api + chmod 0440 before rename —
// §3.3). The record is exactly:
//   { determination_id, kind: "lightricks-reply" | "owner-determination",
//     licence_text_sha256, checkpoint_sha256, determined_at, evidence_ref }
// The gate is the EXISTENCE of a determination for the checkpoint
// SHA-256 the job would render with:
//   licenceSatisfiedFor(checkpointSha256) — enforced at the
//   commissioning predicate (T-V31) and at submitNexora (F-15), and
//   (v13) at EVERY personal job — the gate is extended to the ordinary
//   Worker path's personal jobs too (the v4 "deliberately NOT
//   enforced" note is superseded by v13 §3.4: "every personal job
//   refused licence-undetermined unless valid + checkpoint matches").
// A missing, unreadable, or malformed record file fails closed
// (licence NOT satisfied). The checkpoint the job renders with is the
// SHA-256 pinned in the run-10 template manifest, read server-side —
// a payload checkpoint value is ignored (T-V31).

import { randomUUID } from 'node:crypto';

import { verifyStrictFile, writeStrictFile, defaultStrictFileExpected } from './strict-file.js';

export const DEFAULT_LICENCE_PATH = '/etc/nova-api/licence-determination.json';
export const LICENCE_KINDS = ['lightricks-reply', 'owner-determination'];

const SHA256_RE = /^[0-9a-f]{64}$/;

function licencePathOf(apiState) {
  return apiState?.licenceDeterminationPath ?? DEFAULT_LICENCE_PATH;
}

function fileAccessOf(apiState) {
  const fa = apiState?.fileAccess;
  if (fa && typeof fa === 'object') return fa;
  return defaultStrictFileExpected();
}

// Read + validate the licence record file. Returns
// { ok: true, record } or { ok: false, reason } where reason is a
// strict-reader reason ('missing', 'symlink', 'wrong-mode', ...) or
// 'invalid-record' (JSON parse failure or a field outside the §3.4
// shape). Never throws for file problems.
export function readLicenceRecord(apiState) {
  const fa = fileAccessOf(apiState);
  const read = verifyStrictFile(licencePathOf(apiState), {
    expectedOwnerUid: fa.ownerUid,
    expectedGroupGid: fa.groupGid,
    expectedMode: fa.mode,
    expectedParentUid: fa.parentUid,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  let record;
  try {
    record = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: 'invalid-record' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (typeof record.determination_id !== 'string' || record.determination_id.length === 0) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (!LICENCE_KINDS.includes(record.kind)) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (record.licence_text_sha256 !== null
    && (typeof record.licence_text_sha256 !== 'string' || !SHA256_RE.test(record.licence_text_sha256))) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (typeof record.checkpoint_sha256 !== 'string' || !SHA256_RE.test(record.checkpoint_sha256)) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (typeof record.determined_at !== 'string' || Number.isNaN(Date.parse(record.determined_at))) {
    return { ok: false, reason: 'invalid-record' };
  }
  if (record.evidence_ref !== null && typeof record.evidence_ref !== 'string') {
    return { ok: false, reason: 'invalid-record' };
  }
  return { ok: true, record };
}

// Record a licence determination (OPERATOR ONLY — the CLI tool runs
// as root and writes the file via writeStrictFile). Returns the
// record. `kind` must be 'lightricks-reply' | 'owner-determination';
// `checkpointSha256` must be a 64-hex SHA-256. Throws on a bad kind /
// checkpoint or on a failed write (the operator sees the failure —
// a determination that was not written must never look written).
export function setLicenceDetermination(apiState, {
  kind,
  licenceTextSha256,
  checkpointSha256,
  evidenceRef,
  determinedBy,
  nowMs = Date.now(),
  fileAccess = null,
} = {}) {
  if (!LICENCE_KINDS.includes(kind)) {
    throw new Error(`setLicenceDetermination requires kind in ${LICENCE_KINDS.join(', ')}`);
  }
  if (typeof checkpointSha256 !== 'string' || !SHA256_RE.test(checkpointSha256)) {
    throw new Error('setLicenceDetermination requires a 64-hex checkpointSha256');
  }
  if (licenceTextSha256 !== null && licenceTextSha256 !== undefined
    && (typeof licenceTextSha256 !== 'string' || !SHA256_RE.test(licenceTextSha256))) {
    throw new Error('setLicenceDetermination requires a 64-hex licenceTextSha256 or null');
  }
  const record = {
    determination_id: `lic-${randomUUID()}`,
    kind,
    licence_text_sha256: licenceTextSha256 ?? null,
    checkpoint_sha256: checkpointSha256,
    determined_at: new Date(nowMs).toISOString(),
    evidence_ref: evidenceRef ?? null,
  };
  const fa = fileAccess ?? fileAccessOf(apiState);
  writeStrictFile(licencePathOf(apiState), JSON.stringify(record, null, 2) + '\n', {
    ownerUid: fa.ownerUid,
    groupGid: fa.groupGid,
    mode: fa.mode,
  });
  apiState.logOperator('licence-determination-recorded', {
    determination_id: record.determination_id,
    kind,
    checkpoint_sha256: checkpointSha256,
    determined_by: determinedBy ?? 'operator',
  });
  return record;
}

export function getLicenceDetermination(apiState, determinationId) {
  const read = readLicenceRecord(apiState);
  if (!read.ok) return null;
  return read.record.determination_id === determinationId ? { ...read.record } : null;
}

// True when a determination exists for this checkpoint SHA-256. When
// `determinationId` is given, that specific determination must exist
// AND cover the checkpoint (or any checkpoint when checkpointSha256 is
// null — the commissioning-permit creation check). A missing or
// invalid record file is NOT satisfied (fail closed).
export function licenceSatisfiedFor(apiState, checkpointSha256 = null, determinationId = null) {
  const read = readLicenceRecord(apiState);
  if (!read.ok) return false;
  const record = read.record;
  if (determinationId !== null) {
    if (record.determination_id !== determinationId) return false;
    if (checkpointSha256 === null) return true;
    return record.checkpoint_sha256 === checkpointSha256;
  }
  if (checkpointSha256 === null) return false;
  return record.checkpoint_sha256 === checkpointSha256;
}
