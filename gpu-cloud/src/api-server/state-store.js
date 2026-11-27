// NOVA AI Studio — Phase 3 API process: persistent API-process state.
//
// The API process owns state the manager store does not model: the
// dispatch journal, the revocation record cache, the HMAC replay store,
// deletion-intent journal, O-23 daily counters, headroom reservations,
// pending D1 mutations, reconciliation state, sweep reports, temp-file
// registry, and the operator log.
//
// Persistence: one JSON document, written atomically (temp file in the
// same directory + fsync + rename), exactly like JsonStore. A crash
// leaves either the old file or the new file, never a partial one.
// Readers that share the file across processes (the T31-08 two-process
// revocation test) re-read when the file's mtime changes, so a revocation
// written by one process is visible to the other without a restart.
// Revocation is ALSO mirrored into the manager store (see revocation.js):
// the manager store is the design's authoritative revocation home
// (Rev 3.2 §B-3.2.4.2); this file is the process-local working copy.

import fs from 'node:fs';
import path from 'node:path';

export function defaultApiState() {
  return {
    version: 1,
    // executionId -> dispatch journal entry (Rev 2 §10.2, Rev 3.1 §A-3.1.2.2)
    dispatchJournal: {},
    // HMAC replay store: nonce -> expiresAtMs. A nonce is recorded ONLY
    // after the signature verifies (Rev 3 §C-1.10).
    nonces: {},
    // Revocation records (Rev 3.2 §B-3.2.4.2). Authoritative copy lives
    // in the manager store; this is the working copy.
    revocations: [],
    // objectId -> deletion-intent record (Rev 3.2 §B-3.2.9.2)
    deletionIntents: {},
    // 'cleanup-ops-YYYY-MM-DD' -> count (Rev 2 §15.1)
    cleanupCounters: {},
    // executionId -> { bytes, reservedAt } (Rev 2 §6.3, 50 MB each)
    headroomReservations: {},
    // Pending D1 mutations (Rev 3 §C-1.1): { requestId, mutations, tries, lastError, createdAt }
    pendingMutations: [],
    // Reconciliation state: executionId -> { attempts, lastAt, escalated }
    reconciliation: {},
    // Incomplete scene sets flagged by reconciliation (Rev 3.4/3.5):
    // jobId -> { missingIndexes, flaggedAt }
    incompleteSceneSets: {},
    // Retention candidates (Rev 2 §16.1, Q3 approved 25 Nov 2026):
    // jobId -> { terminalAt, firstSeenAt }. The API process records a
    // job here when it OBSERVES the parent aggregate reach a terminal
    // state; the sweep deletes its rows 30 days after terminalAt. The
    // Worker d1-read surface cannot list terminal jobs, so jobs that
    // terminalise outside the API process's view are not enumerated
    // here (see the impl-notes doc §6).
    retentionCandidates: {},
    // Retention-deletion intents: jobId -> { state, scenesDeleted,
    // jobDeleted, startedAt, completedAt }. Written before any row is
    // deleted; a crash mid-deletion resumes from the intent.
    retentionIntents: {},
    sweepReports: [],
    operatorLog: [],
    // NEXORA Kaggle connection (design v4): the NEXORA-facing
    // attestation registry (§5.3), the mirrored client halt (§5.4),
    // commissioning permits (§3.5), and licence determinations
    // (§3.5 P-9). The per-origin hours ledger lives in the manager
    // store (per-origin-ledger.js), not here.
    nexoraAttestations: {},
    nexoraClientHalts: {},
    commissioningPermits: {},
    licenceDeterminations: {},
    // Revisit decisions (Kaggle design v13 §5.4): the operator's
    // recorded decisions that a halt may be cleared — kinds
    // 'initial-declaration' | 'kaggle-confirmation' |
    // 'channels-kept-off-kaggle'. A halt clears only when a decision
    // was recorded at/after the halt's changed_at. Array of
    // { kind, detail, recorded_at, recorded_by }.
    revisitDecisions: [],
    // Commissioning permit consumed markers (design v13 §3.5): the
    // file holds the permit; this map holds permit_id ->
    // { consumed_at, job_id } written in the same serialised section
    // as manager-job creation, so a permit authorises exactly one job.
    commissioningPermitMarkers: {},
    // temp file registry (Rev 2 §16.3): path -> { jobId, createdAt }
    tempFiles: {},
  };
}

export const DEFAULT_API_EVENT_LOG_PATH = '/var/lib/nova-api/api-events.log';

export class ApiStateStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    // Kaggle design v13 §5.5: the API's own events go to a separate
    // append-only log (owned by nova-api, chattr +a in production) —
    // never into the operator log alone. Best-effort: a failed append
    // never throws (logEvent swallows).
    this.eventLogPath = options.eventLogPath ?? DEFAULT_API_EVENT_LOG_PATH;
    this.state = defaultApiState();
    this._mtimeMs = 0;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      const st = fs.statSync(this.filePath);
      this._mtimeMs = st.mtimeMs;
      this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!this.state || typeof this.state !== 'object') this.state = defaultApiState();
      for (const [k, v] of Object.entries(defaultApiState())) {
        if (!(k in this.state)) this.state[k] = v;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      // No file yet: start empty; the first save creates it.
    }
  }

  // Re-read if another process changed the file (mtime moved). Returns
  // true when a reload happened. Callers that need cross-process
  // visibility (revocation, nonces) call this before deciding.
  reloadIfChanged() {
    try {
      const st = fs.statSync(this.filePath);
      if (st.mtimeMs !== this._mtimeMs) {
        this._loadFromDisk();
        return true;
      }
    } catch {
      // File vanished: keep in-memory state.
    }
    return false;
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
    try {
      this._mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // ignore
    }
  }

  mutate(fn) {
    this.reloadIfChanged();
    fn(this.state);
    this.save();
    return this.state;
  }

  logOperator(event, fields = {}) {
    const entry = { at: Date.now(), event, ...fields };
    this.mutate((s) => {
      s.operatorLog.push(entry);
      if (s.operatorLog.length > 500) s.operatorLog.splice(0, s.operatorLog.length - 500);
    });
    return entry;
  }

  // Kaggle design v13 §5.5: the API's own event log — one JSON line
  // per event, appended to api-events.log (owned by nova-api,
  // append-only `chattr +a` in production; the root-owned activation
  // log is written only by the root restart procedure and is NOT this
  // file). Best-effort by design: a failed append (missing directory,
  // read-only filesystem) is swallowed — event logging must never fail
  // a request. Returns true when the line was appended.
  logEvent(event, fields = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n';
    try {
      fs.mkdirSync(path.dirname(this.eventLogPath), { recursive: true });
      fs.appendFileSync(this.eventLogPath, line, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}
