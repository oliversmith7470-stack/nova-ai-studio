// runner-heartbeat.js — the storage-runner heartbeat contract (Rev 4.8 §14
// Stage 2, Rev 4.9 §6/F-6a), shared by its two readers: the standing
// health-check probe (health-check.js) and the API's submit-time gate
// (dispatch.js). The writer is the storage runner (storage-runner.js).
//
// The heartbeat file is /var/lib/nova-api/runner-health.json, written
// atomically (temp file + rename) by the runner after EVERY sweep pass —
// including the recovery unit's catch-up pass at startup, so the signal is
// fresh from the moment the API listens. Fields:
//   lastSuccessfulSweepAt — wall-clock ISO time the last sweep completed
//     successfully (never advanced by a failed pass)
//   lastAttemptAt         — wall-clock ISO time of the last pass attempt
//   status                — 'ok' | 'failed'
//   objectsDeleted        — objects deleted in the last pass
//   error                 — non-empty on failure
//
// The runner is HEALTHY iff status is 'ok' AND lastSuccessfulSweepAt is
// within the last 2 hours — the same 2-hour threshold §10 already uses for
// "no deletion pass has completed successfully within 2 hours", reused here
// so the two sections cannot drift. A missing, unreadable, unparseable,
// failed, or older-than-two-hours heartbeat is UNHEALTHY (fail closed):
// the probe alerts (storage-runner-heartbeat-outage) and the API refuses
// new submits with 503 capacity_unavailable / storage-full until a sweep
// succeeds. In-flight work is never cancelled by this gate. A FUTURE-dated
// lastSuccessfulSweepAt is also UNHEALTHY (reason 'stale'): a clock that
// has jumped forward must not make an old heartbeat look fresh (ChatGPT
// Rev 4.9 review, Finding 8A) — the age check is two-sided, [0, 2h].
//
// This module never throws on a bad heartbeat file: every failure mode is
// reported as a structured { healthy: false, reason } result. It contains
// no event names (the probe owns the alert event; the API owns the 503).
import fs from 'node:fs';

export const RUNNER_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours (§14 Stage 2)
export const DEFAULT_RUNNER_HEALTH_PATH = '/var/lib/nova-api/runner-health.json';

// Read + parse the heartbeat file. Never throws: a missing file, a read
// error, or unparseable JSON is reported in the result.
export function readRunnerHeartbeat(healthPath) {
  let raw;
  try {
    raw = fs.readFileSync(healthPath, 'utf8');
  } catch (err) {
    return { present: false, parseable: false, reason: err?.code === 'ENOENT' ? 'missing' : 'unreadable', error: err };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { present: true, parseable: false, reason: 'unparseable' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, parseable: false, reason: 'unparseable' };
  }
  return {
    present: true,
    parseable: true,
    status: value.status ?? null,
    lastSuccessfulSweepAt: value.lastSuccessfulSweepAt ?? null,
    lastAttemptAt: value.lastAttemptAt ?? null,
    objectsDeleted: value.objectsDeleted ?? null,
    error: value.error ?? null,
    raw: value,
  };
}

// Health verdict for a parsed heartbeat (see the module header for the
// rule). Returns { healthy, reason } where reason is one of:
// 'ok' | 'missing' | 'unreadable' | 'unparseable' | 'failed' | 'stale'.
export function isRunnerHeartbeatHealthy(heartbeat, nowMs = Date.now()) {
  if (!heartbeat || !heartbeat.present) return { healthy: false, reason: 'missing' };
  if (!heartbeat.parseable) return { healthy: false, reason: heartbeat.reason ?? 'unparseable' };
  if (heartbeat.status !== 'ok') return { healthy: false, reason: 'failed' };
  const lastOk = Date.parse(heartbeat.lastSuccessfulSweepAt);
  if (!Number.isFinite(lastOk)) return { healthy: false, reason: 'stale' };
  const ageMs = nowMs - lastOk;
  // Two-sided age check (Finding 8A): a future-dated heartbeat (negative
  // age — a clock jump, a hand-edited file, a writer bug) must not pass.
  if (ageMs < 0) return { healthy: false, reason: 'stale' };
  if (ageMs > RUNNER_HEARTBEAT_MAX_AGE_MS) return { healthy: false, reason: 'stale' };
  return { healthy: true, reason: 'ok' };
}

// One-call form: read the file and judge it. Never throws.
export function checkRunnerHeartbeat(healthPath, nowMs = Date.now()) {
  const heartbeat = readRunnerHeartbeat(healthPath);
  const verdict = isRunnerHeartbeatHealthy(heartbeat, nowMs);
  return { ...heartbeat, ...verdict };
}
