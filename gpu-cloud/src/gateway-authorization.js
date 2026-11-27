// NOVA FreeLLMAPI — sandbox owner-authorization records.
//
// Implements the A5 contract of the approved v5 design
// (nova-freellmapi-gateway-use-design-corrected-v5.md) against the
// implementation specification in
// ~/workspace/your_files/nova-freellmapi-authorization-record-impl-spec.md.
//
// A record is a persisted, server-side owner authorization for gateway
// prompt enhancement in one sandbox environment. A boolean supplied by a
// request, job, client, or environment variable is never an authorization
// record. Validation always re-reads the records file from disk (no cache),
// so a revocation by the operator CLI is visible to the next validation
// immediately. Every approval, validation decision, revocation, and
// supersede appends an event to an append-only audit log. No credentials
// or prompt contents are ever written to records or audit events.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AUTHORIZATION_OPERATION = 'gateway_prompt_enhancement';

export const APPROVAL_METHODS = Object.freeze(['host-operator-cli']);

export const AUTHORIZATION_STATUSES = Object.freeze(['active', 'revoked', 'expired']);

// Strict UTC ISO 8601: YYYY-MM-DDTHH:MM:SS[.fff]Z with real calendar dates
// (month 1-12, day valid for the month incl. leap years, hour 0-23,
// minute/second 0-59 — no 24:00, no leap second 60, no year 0000).
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

export function isValidIsoUtc(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_UTC_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return false;
  return Number.isFinite(Date.parse(value));
}

export function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

export class AuthorizationStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthorizationStoreError';
  }
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

export class AuthorizationStore {
  constructor({ filePath, auditPath, component = 'api-server', now = () => Date.now() } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new AuthorizationStoreError('AuthorizationStore requires a filePath');
    }
    if (typeof auditPath !== 'string' || auditPath.length === 0) {
      throw new AuthorizationStoreError('AuthorizationStore requires an auditPath');
    }
    this.filePath = filePath;
    this.auditPath = auditPath;
    this.component = component;
    this.now = now;
  }

  // -- persistence ----------------------------------------------------------

  _load() {
    if (!fs.existsSync(this.filePath)) return { version: 1, records: {} };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.records == null || typeof parsed.records !== 'object') {
      throw new AuthorizationStoreError('authorization records file is corrupt');
    }
    return parsed;
  }

  _save(doc) {
    atomicWriteJson(this.filePath, doc);
  }

  _appendAudit(event) {
    const dir = path.dirname(this.auditPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8');
    try { fs.chmodSync(this.auditPath, 0o600); } catch { /* best effort */ }
  }

  _auditEvent({ authorizationId, decision, projectId, environmentId, operation, jobId, reason }) {
    return {
      authorizationId: authorizationId ?? null,
      decision,
      timestamp: isoNow(this.now()),
      projectId: projectId ?? null,
      environmentId: environmentId ?? null,
      operation: operation ?? AUTHORIZATION_OPERATION,
      jobId: jobId ?? null,
      component: this.component,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  _hasApprovalEvent(authorizationId) {
    if (!fs.existsSync(this.auditPath)) return false;
    const text = fs.readFileSync(this.auditPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.authorizationId === authorizationId && event.decision === 'approved') return true;
    }
    return false;
  }

  // -- creation ---------------------------------------------------------------
  //
  // Operator-only (see the CLI). Validates every input; the operation is
  // fixed to gateway_prompt_enhancement and the approval method to
  // host-operator-cli. Creating a record for a job that an ACTIVE record
  // already covers supersedes the old record.

  create({
    jobIds,
    startsAt,
    expiresAt,
    projectId,
    environmentId,
    ownerId,
    approvalMethod = 'host-operator-cli',
  } = {}) {
    if (!Array.isArray(jobIds) || jobIds.length === 0 || jobIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new AuthorizationStoreError('jobIds must be a non-empty array of job id strings');
    }
    if (!isValidIsoUtc(startsAt)) throw new AuthorizationStoreError('startsAt must be a UTC ISO 8601 timestamp');
    if (!isValidIsoUtc(expiresAt)) throw new AuthorizationStoreError('expiresAt must be a UTC ISO 8601 timestamp');
    if (Date.parse(expiresAt) <= Date.parse(startsAt)) {
      throw new AuthorizationStoreError('expiresAt must be strictly after startsAt');
    }
    if (typeof projectId !== 'string' || projectId.length === 0) throw new AuthorizationStoreError('projectId is required');
    if (typeof environmentId !== 'string' || environmentId.length === 0) throw new AuthorizationStoreError('environmentId is required');
    if (typeof ownerId !== 'string' || ownerId.length === 0) throw new AuthorizationStoreError('ownerId is required');
    if (!APPROVAL_METHODS.includes(approvalMethod)) throw new AuthorizationStoreError('unknown approvalMethod');

    const doc = this._load();
    const authorizationId = `auth-${randomUUID()}`;
    const record = {
      authorizationId,
      approvedByOwnerId: ownerId,
      approvedAt: isoNow(this.now()),
      approvalMethod,
      projectId,
      environmentId,
      operation: AUTHORIZATION_OPERATION,
      jobScope: { jobIds: [...new Set(jobIds)] },
      startsAt,
      expiresAt,
      status: 'active',
      revokedAt: null,
      revokedByOwnerId: null,
      lastValidatedByComponent: null,
      supersededBy: null,
    };
    // Supersede any ACTIVE record covering the same project/environment/
    // operation and any of the same job IDs.
    for (const existing of Object.values(doc.records)) {
      if (existing.status !== 'active' || existing.supersededBy !== null) continue;
      if (existing.projectId !== projectId || existing.environmentId !== environmentId) continue;
      if (existing.operation !== AUTHORIZATION_OPERATION) continue;
      const overlap = (existing.jobScope?.jobIds ?? []).some((id) => record.jobScope.jobIds.includes(id));
      if (!overlap) continue;
      existing.supersededBy = authorizationId;
      this._appendAudit(this._auditEvent({
        authorizationId: existing.authorizationId,
        decision: 'superseded',
        projectId: existing.projectId,
        environmentId: existing.environmentId,
        operation: existing.operation,
        jobId: null,
      }));
    }
    doc.records[authorizationId] = record;
    this._save(doc);
    this._appendAudit(this._auditEvent({
      authorizationId,
      decision: 'approved',
      projectId,
      environmentId,
      operation: AUTHORIZATION_OPERATION,
      jobId: null,
    }));
    return record;
  }

  // -- reads ------------------------------------------------------------------

  get(authorizationId) {
    const doc = this._load();
    return doc.records[authorizationId] ?? null;
  }

  list() {
    const doc = this._load();
    return Object.values(doc.records).sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1));
  }

  // The ACTIVE record covering a job (newest approval wins if several
  // somehow exist — creation supersedes the old ones, so this is a
  // defensive fallback, not the normal path).
  findForJob(jobId, { projectId, environmentId } = {}) {
    const doc = this._load();
    const covering = Object.values(doc.records).filter((r) => (
      r.status === 'active'
      && r.supersededBy === null
      && (projectId === undefined || r.projectId === projectId)
      && (environmentId === undefined || r.environmentId === environmentId)
      && Array.isArray(r.jobScope?.jobIds)
      && r.jobScope.jobIds.includes(jobId)
    ));
    if (covering.length === 0) return null;
    covering.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
    return covering[0];
  }

  // -- revocation ---------------------------------------------------------------
  //
  // Atomic: status + revokedAt + revokedByOwnerId in one file write, plus
  // the audit event. The next validation reads the file and rejects it.

  revoke(authorizationId, { revokedByOwnerId } = {}) {
    if (typeof revokedByOwnerId !== 'string' || revokedByOwnerId.length === 0) {
      throw new AuthorizationStoreError('revokedByOwnerId is required');
    }
    const doc = this._load();
    const record = doc.records[authorizationId] ?? null;
    if (!record) throw new AuthorizationStoreError(`unknown authorization ${authorizationId}`);
    if (record.status === 'revoked') return record; // already revoked: report, do not re-write
    record.status = 'revoked';
    record.revokedAt = isoNow(this.now());
    record.revokedByOwnerId = revokedByOwnerId;
    this._save(doc);
    this._appendAudit(this._auditEvent({
      authorizationId,
      decision: 'revoked',
      projectId: record.projectId,
      environmentId: record.environmentId,
      operation: record.operation,
      jobId: null,
    }));
    return record;
  }

  // -- validation ---------------------------------------------------------------
  //
  // The design's nine checks, verbatim in substance. Always re-reads the
  // file (no cache). Every decision appends an audit event. Any failed
  // check returns false; validation fails closed.

  validate({ jobId, sandboxAuthorizationId } = {}, { environmentId, projectId, ownerId } = {}) {
    const nowMs = this.now();
    const reject = (authorizationId, record, reason) => {
      this._appendAudit(this._auditEvent({
        authorizationId: authorizationId ?? null,
        decision: 'rejected',
        projectId: record?.projectId ?? projectId ?? null,
        environmentId: record?.environmentId ?? environmentId ?? null,
        operation: record?.operation ?? AUTHORIZATION_OPERATION,
        jobId: jobId ?? null,
        reason,
      }));
      return false;
    };
    let doc;
    try {
      doc = this._load();
    } catch {
      // A corrupt/unreadable records file fails closed.
      return reject(null, null, 'records-unloadable');
    }
    let record = null;
    if (typeof sandboxAuthorizationId === 'string' && sandboxAuthorizationId.length > 0) {
      record = doc.records[sandboxAuthorizationId] ?? null;
      if (!record) return reject(sandboxAuthorizationId, null, 'authorization-not-found');
    } else {
      if (typeof jobId !== 'string' || jobId.length === 0) return reject(null, null, 'job-id-missing');
      record = this._findInDoc(doc, jobId, { projectId, environmentId });
      if (!record) return reject(null, null, 'no-covering-authorization');
    }

    // (2) Required fields present and well-typed.
    const fieldsOk = typeof record.authorizationId === 'string' && record.authorizationId.length > 0
      && typeof record.approvedByOwnerId === 'string' && record.approvedByOwnerId.length > 0
      && isValidIsoUtc(record.approvedAt)
      && typeof record.approvalMethod === 'string'
      && typeof record.projectId === 'string' && record.projectId.length > 0
      && typeof record.environmentId === 'string' && record.environmentId.length > 0
      && typeof record.operation === 'string'
      && record.jobScope && Array.isArray(record.jobScope.jobIds) && record.jobScope.jobIds.length > 0
      && record.jobScope.jobIds.every((id) => typeof id === 'string' && id.length > 0)
      && isValidIsoUtc(record.startsAt)
      && isValidIsoUtc(record.expiresAt)
      && (record.status === 'active' || record.status === 'revoked')
      && (record.revokedAt === null || isValidIsoUtc(record.revokedAt))
      && (record.revokedByOwnerId === null || (typeof record.revokedByOwnerId === 'string' && record.revokedByOwnerId.length > 0))
      && (record.lastValidatedByComponent === null || typeof record.lastValidatedByComponent === 'string')
      && (record.supersededBy === null || typeof record.supersededBy === 'string');
    if (!fieldsOk) return reject(record.authorizationId, record, 'record-invalid');
    // A stored 'expired' status is invalid data (expiry is computed, §11 of
    // the impl spec) — it never passes the field check above, which only
    // allows 'active' | 'revoked'.

    // (3) Approving owner resolves to the configured owner.
    if (ownerId !== undefined && record.approvedByOwnerId !== ownerId) {
      return reject(record.authorizationId, record, 'owner-mismatch');
    }
    // (4) Approval method valid, approval timestamp valid and not in the
    // future, approval event recorded.
    if (!APPROVAL_METHODS.includes(record.approvalMethod)) {
      return reject(record.authorizationId, record, 'approval-method-invalid');
    }
    if (Date.parse(record.approvedAt) > nowMs) {
      return reject(record.authorizationId, record, 'approved-in-future');
    }
    if (!this._hasApprovalEvent(record.authorizationId)) {
      return reject(record.authorizationId, record, 'approval-event-missing');
    }
    // (5) Status active; revoked fails immediately; now >= expiresAt is expired.
    if (record.status !== 'active') return reject(record.authorizationId, record, 'not-active');
    if (nowMs >= Date.parse(record.expiresAt)) return reject(record.authorizationId, record, 'expired');
    // (6) startsAt <= now < expiresAt.
    if (nowMs < Date.parse(record.startsAt)) return reject(record.authorizationId, record, 'not-yet-valid');
    // (7) environmentId exactly equals the trusted deployment environment ID.
    if (environmentId !== undefined && record.environmentId !== environmentId) {
      return reject(record.authorizationId, record, 'environment-mismatch');
    }
    // (8) projectId exactly matches the trusted project ID.
    if (projectId !== undefined && record.projectId !== projectId) {
      return reject(record.authorizationId, record, 'project-mismatch');
    }
    // (9) operation exactly gateway_prompt_enhancement.
    if (record.operation !== AUTHORIZATION_OPERATION) {
      return reject(record.authorizationId, record, 'operation-mismatch');
    }
    // (10) The trusted job ID is explicitly included in jobScope.
    if (typeof jobId !== 'string' || !record.jobScope.jobIds.includes(jobId)) {
      return reject(record.authorizationId, record, 'job-not-in-scope');
    }
    // (11) Not superseded.
    if (record.supersededBy !== null) return reject(record.authorizationId, record, 'superseded');

    // Accepted: record the validating component on the record (server-side
    // only) and the decision in the audit log.
    try {
      const fresh = this._load();
      const live = fresh.records[record.authorizationId];
      if (live) {
        live.lastValidatedByComponent = this.component;
        this._save(fresh);
      }
    } catch {
      // A failed component stamp must not turn an accepted validation into
      // a rejection — the audit event below is the authoritative record.
    }
    this._appendAudit(this._auditEvent({
      authorizationId: record.authorizationId,
      decision: 'validated',
      projectId: record.projectId,
      environmentId: record.environmentId,
      operation: record.operation,
      jobId: jobId ?? null,
    }));
    return true;
  }

  _findInDoc(doc, jobId, { projectId, environmentId } = {}) {
    const covering = Object.values(doc.records).filter((r) => (
      r.status === 'active'
      && r.supersededBy === null
      && (projectId === undefined || r.projectId === projectId)
      && (environmentId === undefined || r.environmentId === environmentId)
      && Array.isArray(r.jobScope?.jobIds)
      && r.jobScope.jobIds.includes(jobId)
    ));
    if (covering.length === 0) return null;
    covering.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
    return covering[0];
  }
}
