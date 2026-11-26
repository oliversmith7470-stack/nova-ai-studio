// NOVA Personal GPU Cloud — Stage 1: file-backed JSON store.
//
// Job RECORDS only — never image or video bytes (O-27). The whole state is
// one JSON document, written atomically (write temp file in the same
// directory, fsync, rename over the live file) so a crash can never leave
// a half-written store behind.
//
// Single-process assumption: the manager is the only writer. Stage 4 (the
// NOVA API connection) must decide the multi-process story before this
// store is ever shared.

import fs from 'node:fs';
import path from 'node:path';

export function defaultState() {
  return {
    version: 1,
    seq: 0, // monotonic queue sequence (stable FIFO tiebreak)
    jobs: {}, // jobId -> job record
    idempotency: {}, // idempotencyKey -> jobId (exactly one job per key)
    reservations: {}, // reservationId -> reservation record
    providerState: {}, // providerId -> { status, hoursUsedThisWeek, updatedAt }
    killSwitch: { engaged: false, reason: null, engagedAt: null, log: [] },
    // Global spending ceiling (USD). Default 0 = zero-cost mode: paid
    // providers are NEVER dispatched while the ceiling is 0. Raising it is
    // an owner decision; every change is recorded with who/why/when.
    ceiling: { valueUsd: 0, changes: [] },
    reconciliations: [], // reconciliation run records
    lateReports: [], // provider reports that arrived after the job went terminal
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = defaultState();
    if (fs.existsSync(filePath)) {
      this.state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }

  // Atomic save: temp file + fsync + rename. A crash leaves either the old
  // file or the new file, never a partial one.
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
  }

  // Apply a mutation to the in-memory state and persist it atomically.
  mutate(fn) {
    fn(this.state);
    this.save();
    return this.state;
  }
}
