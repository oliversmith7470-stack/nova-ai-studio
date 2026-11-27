// NOVA Personal GPU Cloud — Rev 4.8 §8: the API process's own local nonce
// store.
//
// Design requirement (Rev 4.8 §8, Worker→API direction): the component that
// verifies a signature owns the nonce store for that direction. The API
// process consumes Worker→API nonces in its own local SQLite file,
// <dataDir>/nonces.db (/var/lib/nova-api/nonces.db in production), table
// `nonces (key_id TEXT, nonce TEXT, expires_at INTEGER, PRIMARY KEY
// (key_id, nonce))` — Kaggle design v13 §3 D-2.3 requires (key_id,
// nonce) composite uniqueness; consumption is one `INSERT OR IGNORE`
// with `expires_at = timestamp + 360` (seconds, stored as milliseconds
// here, matching the Worker-side D1 store); the call is rejected unless
// exactly one row changed. The API process NEVER writes to D1, NEVER
// reads D1, and NEVER asks the Worker whether a nonce was used.
//
// Guarantees (proven by gpu-cloud/test/nonce-store.test.mjs):
// - atomic consumption: INSERT OR IGNORE is a single SQLite statement, so
//   two concurrent consumers of the same nonce — in-process or in two
//   processes sharing the file — admit exactly one;
// - restart persistence: the file survives process restarts, so a consumed
//   nonce stays consumed (no resurrection after a crash or a VM rebuild);
// - interrupted-write recovery: SQLite's journal makes a torn write atomic
//   — a killed writer leaves either the old or the new state, never a
//   half-written row; a corrupted file is surfaced as an error, never as
//   a silent "nonce unseen";
// - expiry + bounds: expired nonces are pruned best-effort on consume; the
//   live set is bounded by the validity window (360 s + 5 min grace), so
//   the file cannot grow without bound.
// The store holds only random nonces and expiry timestamps — no secrets, no
// job data. The file is created 0600, protected like api.env.
//
// This REPLACES the ApiStateStore JSON nonce store for request
// authentication. ApiStateStore keeps its own roles (kill-switch, activation
// flags, revocation record); it is not a nonce store and must not be used as
// one — its mutate() reload+save is not atomic across processes, so two
// concurrent consumers could both see a nonce absent (the gap the reviewer
// found). verifyWorkerAuth takes the SQLite store as an explicit argument;
// there is no fallback to the JSON store.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const NONCE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce)
)`;

// The design's nonce validity window: timestamp + 360 s (Rev 4.8 §8).
export const NONCE_VALIDITY_SECONDS = 360;

const NONCE_RE = /^[0-9a-f]{32}$/i;

export class SqliteNonceStore {
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new Error('SqliteNonceStore requires a database path');
    }
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // Two processes may share the file (a stale process + its replacement);
    // a 5 s busy timeout lets a contended writer wait instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Kaggle design v13 §3 D-2.3: the nonce store requires (key_id,
    // nonce) composite uniqueness — the same nonce under a different
    // key id is a different nonce. A pre-v13 file holds the old
    // single-column table; nonces live at most 360 s, so dropping and
    // recreating it is safe (no live nonce can be older than the
    // validity window, and a dropped nonce fails closed as unseen —
    // which only ever refuses a replay).
    const cols = this.db.prepare('PRAGMA table_info(nonces)').all();
    if (cols.length > 0 && !cols.some((c) => c.name === 'key_id')) {
      this.db.exec('DROP TABLE nonces');
    }
    this.db.exec(NONCE_TABLE_SQL);
    // Security-boundary file, like api.env: 0600, best-effort on
    // filesystems that ignore modes.
    if (dbPath !== ':memory:') {
      try { fs.chmodSync(dbPath, 0o600); } catch { /* ignore */ }
    }
    this._insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO nonces (key_id, nonce, expires_at) VALUES (?, ?, ?)',
    );
    this._hasStmt = this.db.prepare(
      'SELECT 1 AS present FROM nonces WHERE key_id = ? AND nonce = ?',
    );
    this._pruneStmt = this.db.prepare(
      'DELETE FROM nonces WHERE expires_at < ?',
    );
    this._countStmt = this.db.prepare('SELECT COUNT(*) AS c FROM nonces');
  }

  // Atomically consume a nonce under one key id. Returns true iff THIS
  // call consumed it (exactly one row changed); false when the nonce
  // was already present under that key id. The same nonce under a
  // DIFFERENT key id is a different row and consumes cleanly (§3
  // D-2.3). Expired nonces are pruned first (best-effort; a prune
  // failure never fails consumption — the INSERT OR IGNORE is the
  // authority).
  consume(keyId, nonce, expiresAtMs) {
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw new Error('SqliteNonceStore.consume requires a key id');
    }
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new Error('SqliteNonceStore.consume requires a 32-hex nonce');
    }
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error('SqliteNonceStore.consume requires a finite expiresAtMs');
    }
    try { this._pruneStmt.run(Date.now()); } catch { /* best-effort */ }
    const res = this._insertStmt.run(keyId, nonce, Math.floor(expiresAtMs));
    return res.changes === 1;
  }

  has(keyId, nonce) {
    const row = this._hasStmt.get(keyId, nonce);
    return !!row;
  }

  // Delete expired nonces. Returns the number deleted.
  prune(nowMs = Date.now()) {
    const res = this._pruneStmt.run(nowMs);
    return res.changes;
  }

  count() {
    return this._countStmt.get().c;
  }

  close() {
    this.db.close();
  }
}
