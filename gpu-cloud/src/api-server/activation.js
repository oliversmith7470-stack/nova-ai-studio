// NOVA AI Studio — Phase 5 M2-P activation machinery (Rev 4.8 §4, §9, §11).
//
// This module owns the activation flags, the authorisation calculation,
// and the signed capacity contract. It is the single source of the §11
// naming mapping: the configuration keys NOVA_PUBLIC_PRODUCTION_ACTIVATED
// / NOVA_PERSONAL_PRODUCTION_ACTIVATED (activation.conf) map to the
// application properties publicProductionActivated / personalProductionActivated
// (internal capacity response, authorisation calculation). No other
// spelling of either flag may appear in code, config, logs, or
// documentation — no `publicProductionActive`, no
// `PUBLIC_PRODUCTION_ACTIVATED`, no bare `activated`.
//
// The flags live in a SEPARATE structure from the API config object:
// the gateway non-interference test asserts they are NOT in api.config,
// so nothing in this module ever merges them into it. The flags are read
// at API process start only; there is no HTTP endpoint, no Worker env
// var, and no request parameter that can read or change them. A flag
// changes only by the §4.1 operator procedure (edit activation.conf,
// restart the API process, append the audit-log entry, verify with a
// signed GET /internal/capacity).
//
// The response signature uses NOVA_SIGNING_SECRET, which is distinct from
// the transport secret NOVA_API_SECRET (key separation, §8). The signing
// secret lives in the host env file (and the Worker's copy as a Pages
// secret); it is never logged, never committed, never printed.

import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ACTIVATION_CONFIG_PATH = '/etc/nova-api/activation.conf';
export const ACTIVATION_AUDIT_LOG_PATH = '/var/lib/nova-api/activation-audit.log';

// §9 reason vocabulary, in precedence order (first match wins). Exactly
// these seven words; `api-unreachable` is NOT one of them — it means the
// capacity call itself failed (transport failure) and the Worker reports
// it separately.
export const CAPACITY_REASONS = [
  'kill-switch-engaged',
  'not-activated',
  'no-production-executor',
  'ceiling',
  'quota-exhausted',
  'storage-full',
  'no-worker',
];

export const STORAGE_SAFETY_MARGIN_BYTES = 500 * 1024 * 1024; // 500 MB (§9/§14)
export const CAPACITY_FRESHNESS_SECONDS = 5; // §4.3: |now - timestamp| <= 5 s

// The five non-commercial purposes live in the single shared module
// ./non-commercial-purposes.js (re-exported here so existing importers
// are unchanged). Round 3 (reviewer re-review verdict, 27 Nov 2026
// §2): the Cloudflare Worker previously held its own Set literal of
// the same five strings; two identical copies can drift. There is now
// one literal in the repo.
export { NON_COMMERCIAL_PURPOSES } from './non-commercial-purposes.js';

const TRUE_VALUES = new Set(['true']);
const FALSE_VALUES = new Set(['false']);

// -- Activation config ------------------------------------------------------

// Parse activation.conf text. Strict boolean parsing: anything other than
// exactly `true` / `false` is a startup failure (fail closed). Unknown
// keys are a startup failure too — a misspelled flag must never silently
// mean "off". Missing keys default false (§4.1: each flag defaults false).
// Returns { publicProductionActivated, personalProductionActivated }.
export function parseActivationConfigText(text, source = 'activation.conf') {
  const flags = { publicProductionActivated: false, personalProductionActivated: false };
  const seen = new Set();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(`activation config ${source}: malformed line ${JSON.stringify(rawLine)} (expected KEY=value)`);
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== 'NOVA_PUBLIC_PRODUCTION_ACTIVATED' && key !== 'NOVA_PERSONAL_PRODUCTION_ACTIVATED') {
      throw new Error(`activation config ${source}: unknown key ${JSON.stringify(key)}`);
    }
    if (seen.has(key)) {
      throw new Error(`activation config ${source}: duplicate key ${JSON.stringify(key)}`);
    }
    seen.add(key);
    if (TRUE_VALUES.has(value)) {
      flags[key === 'NOVA_PUBLIC_PRODUCTION_ACTIVATED' ? 'publicProductionActivated' : 'personalProductionActivated'] = true;
    } else if (FALSE_VALUES.has(value)) {
      flags[key === 'NOVA_PUBLIC_PRODUCTION_ACTIVATED' ? 'publicProductionActivated' : 'personalProductionActivated'] = false;
    } else {
      throw new Error(`activation config ${source}: ${key} must be exactly "true" or "false", got ${JSON.stringify(value)}`);
    }
  }
  return flags;
}

// Read the activation config file at API process start. A missing file
// means both flags false (§4.1 default) — the operator creates the file
// explicitly when a flag is ever set true, so absence can never open a
// path. Any other read failure, or a malformed file, is a startup failure.
export function readActivationConfig(filePath = ACTIVATION_CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(`[activation] ${filePath} not found — both activation flags default false`);
      return { publicProductionActivated: false, personalProductionActivated: false };
    }
    throw new Error(`activation config ${filePath} unreadable: ${err?.message ?? err}`);
  }
  return parseActivationConfigText(text, filePath);
}

// Parse the Kaggle experimental floor (hours/week). Default 5 (§11/§12).
// Unset/empty means the default; a non-numeric, non-finite, or negative
// value is a startup failure — a bad floor must never silently gate (or
// un-gate) personal dispatch.
export function parseKaggleFloorHours(value, defaultHours = 5) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultHours;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`NOVA_KAGGLE_EXPERIMENT_FLOOR_HOURS must be a finite number >= 0, got ${JSON.stringify(value)}`);
  }
  return n;
}

// -- Audit log ---------------------------------------------------------------

// Append one activation audit-log entry (§4.1: timestamp, operator, flag,
// old value -> new value, authorisation reference). One JSON object per
// line; deactivation entries also carry a reason. Never throws on a
// missing parent directory — the caller creates it; a write failure is
// surfaced so the operator procedure cannot claim an unrecorded change.
export function appendActivationAuditLog({
  logPath = ACTIVATION_AUDIT_LOG_PATH,
  operator,
  flag,
  oldValue,
  newValue,
  authorisationRef,
  reason = null,
  at = new Date().toISOString(),
} = {}) {
  if (flag !== 'publicProductionActivated' && flag !== 'personalProductionActivated') {
    throw new Error(`activation audit log: unknown flag ${JSON.stringify(flag)}`);
  }
  if (typeof oldValue !== 'boolean' || typeof newValue !== 'boolean') {
    throw new Error('activation audit log: oldValue and newValue must be booleans');
  }
  if (typeof authorisationRef !== 'string' || authorisationRef.length === 0) {
    throw new Error('activation audit log: authorisationRef is required');
  }
  const entry = {
    timestamp: at,
    operator: operator ?? 'operator',
    flag,
    oldValue,
    newValue,
    authorisationRef,
    ...(reason ? { reason } : {}),
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// -- Response signing (§4.3) -------------------------------------------------

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacSha256Hex(keyText, message) {
  return createHmac('sha256', keyText).update(message, 'utf8').digest('hex');
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let ba;
  let bb;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Sign a capacity response body (§4.3): HMAC-SHA-256 over
// `timestamp + "\n" + requestNonce + "\n" + sha256Hex(body)`, key
// NOVA_SIGNING_SECRET. Returns { timestamp, signature }.
export function signCapacityResponse({ signingSecret, requestNonce, bodyText, timestamp = null } = {}) {
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    throw new Error('capacity response signing requires NOVA_SIGNING_SECRET');
  }
  if (!/^[0-9a-f]{32}$/i.test(requestNonce ?? '')) {
    throw new Error('capacity response signing requires a 32-hex requestNonce');
  }
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  if (!/^[0-9]+$/.test(String(ts))) {
    throw new Error('capacity response signing requires a numeric Unix-seconds timestamp');
  }
  const canonical = `${ts}\n${requestNonce}\n${sha256Hex(bodyText)}`;
  return { timestamp: String(ts), signature: hmacSha256Hex(signingSecret, canonical) };
}

// Verify a capacity response (§4.3 — the Worker-side contract, also used
// by the live-verification script). Checks, in order: signature present
// and well-formed; timestamp fresh (|now - ts| <= 5 s); HMAC verifies
// (constant-time); body parses as JSON with every required field and the
// correct types; requestedAudience equals the audience asked for;
// requestNonce echoes the nonce sent; internal consistency (authorised
// requires activated, production mode, and a disengaged kill-switch; a
// reason is present exactly when its mode is unauthorised, and is one of
// the seven vocabulary words). Any failure returns { ok: false, reason }
// — a rejected response is treated exactly like a transport failure
// (`api-unreachable`): no dispatch. Never throws.
export function verifyCapacityResponse({
  signingSecret,
  timestamp,
  signature,
  requestNonce,
  expectedAudience,
  bodyText,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const reject = (reason) => ({ ok: false, reason });
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    return reject('no-signing-secret');
  }
  if (!/^[0-9a-f]{64}$/i.test(signature ?? '')) return reject('bad-signature');
  if (!/^[0-9]+$/.test(String(timestamp ?? ''))) return reject('bad-timestamp');
  const ts = Number(timestamp);
  if (Math.abs(nowSec - ts) > CAPACITY_FRESHNESS_SECONDS) return reject('stale-timestamp');
  if (!/^[0-9a-f]{32}$/i.test(requestNonce ?? '')) return reject('bad-nonce');
  const expected = hmacSha256Hex(signingSecret, `${ts}\n${requestNonce}\n${sha256Hex(bodyText ?? '')}`);
  if (!constantTimeHexEqual(expected, signature)) return reject('signature-mismatch');
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return reject('malformed-body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reject('malformed-body');
  const boolField = (name) => typeof body[name] === 'boolean';
  if (typeof body.mode !== 'string') return reject('malformed-body');
  if (!boolField('publicProductionAuthorised')) return reject('malformed-body');
  if (!boolField('publicProductionActivated')) return reject('malformed-body');
  if (!boolField('personalProductionAuthorised')) return reject('malformed-body');
  if (!boolField('personalProductionActivated')) return reject('malformed-body');
  if (!boolField('killSwitchEngaged')) return reject('malformed-body');
  if (body.requestedAudience !== expectedAudience) return reject('audience-mismatch');
  if (body.requestNonce !== requestNonce) return reject('nonce-mismatch');
  if (body.publicProductionAuthorised && !body.publicProductionActivated) {
    return reject('inconsistent-authorised-without-activated');
  }
  if (body.personalProductionAuthorised && !body.personalProductionActivated) {
    return reject('inconsistent-authorised-without-activated');
  }
  if (body.publicProductionAuthorised && body.mode !== 'production') {
    return reject('inconsistent-authorised-without-production-mode');
  }
  if (body.personalProductionAuthorised && body.mode !== 'production') {
    return reject('inconsistent-authorised-without-production-mode');
  }
  if (body.publicProductionAuthorised && body.killSwitchEngaged) {
    return reject('inconsistent-authorised-with-kill-switch');
  }
  if (body.personalProductionAuthorised && body.killSwitchEngaged) {
    return reject('inconsistent-authorised-with-kill-switch');
  }
  const reasonOk = (present, value) => {
    if (present) return CAPACITY_REASONS.includes(value);
    return value === undefined;
  };
  if (!reasonOk(!body.publicProductionAuthorised, body.reason)) {
    return reject('inconsistent-reason');
  }
  if (!reasonOk(!body.personalProductionAuthorised, body.personalReason)) {
    return reject('inconsistent-reason');
  }
  return { ok: true, body };
}

// -- Authorisation calculation (§4.2, §9) ------------------------------------

// Compute both authorisation states from live inputs. Pure function —
// the route handler supplies the live reads, tests supply fixtures.
// Precedence (§9, first match wins): kill-switch-engaged, not-activated,
// no-production-executor, ceiling, quota-exhausted, storage-full,
// no-worker. `reason` / `personalReason` are present exactly when the
// corresponding mode is unauthorised. Kaggle never appears in the public
// providers list; the personal providers entry is the personal executor
// only (reported in the providers array with its own id — it is not a
// public provider and never satisfies public capacity).
//
// inputs:
//   mode: 'production' | 'controlled-test'
//   flags: { publicProductionActivated, personalProductionActivated }
//   killSwitchEngaged: boolean
//   storage: { headroomBytes, reservedBytes, ok }
//   productionExecutorIds: string[] (registered permitted providers)
//   personalExecutorRegistered: boolean
//   kaggleCredentialPresent: boolean
//   ownerTokenConfigured: boolean
//   kaggleQuota: { remaining, total, floor } | null (null = untracked)
//   providerQuotas: Map id -> { remaining, total, floor } | null
//   providerDetails: [{ id, kind, configured, authenticated,
//     executorRegistered, executionVerified, currentlyDispatchable,
//     models, maxConcurrentJobs, jobsActive, jobsQueued,
//     quotaRemaining, quotaUnit, quotaResetAt, quotaFloor }] (optional;
//     when omitted, providers defaults to [])
//   personalTokenId: string | null
//   queueDepth: number
//   requestedAudience, requestNonce: echoed in the body
export function computeAuthorisation(inputs = {}) {
  const mode = inputs.mode ?? 'production';
  const flags = inputs.flags ?? { publicProductionActivated: false, personalProductionActivated: false };
  const killSwitchEngaged = inputs.killSwitchEngaged === true;
  const storage = inputs.storage ?? { headroomBytes: 0, reservedBytes: 0, ok: false };
  const productionExecutorIds = inputs.productionExecutorIds ?? [];
  const personalExecutorRegistered = inputs.personalExecutorRegistered === true;
  const kaggleCredentialPresent = inputs.kaggleCredentialPresent === true;
  const ownerTokenConfigured = inputs.ownerTokenConfigured === true;
  const kaggleQuota = inputs.kaggleQuota ?? null;
  const providerQuotas = inputs.providerQuotas ?? new Map();
  const queueDepth = typeof inputs.queueDepth === 'number' ? inputs.queueDepth : 0;

  const storageOk = storage.ok === true;

  // --- public ---
  let publicAuthorised = false;
  let publicReason = null;
  if (mode !== 'production') {
    // A non-production process never authorises production. The reason
    // vocabulary has no word for "wrong mode"; not-activated is the
    // closest honest word (the mode's activation flag cannot open a
    // non-production process), and the mode field itself reports the
    // truth. The Worker also enforces authorised => mode production.
    publicReason = 'not-activated';
  } else if (killSwitchEngaged) {
    publicReason = 'kill-switch-engaged';
  } else if (!flags.publicProductionActivated) {
    publicReason = 'not-activated';
  } else if (productionExecutorIds.length === 0) {
    publicReason = 'no-production-executor';
  } else {
    // Ceiling: a registered permitted PAID provider can never dispatch
    // while the store ceiling is 0 (the default) — no paid estimate can
    // fit under it. With no paid provider registered the ceiling cannot
    // block; with only free providers there is no ceiling to hit.
    const paidRegistered = (inputs.paidProductionExecutorIds ?? []).length > 0;
    const ceilingUsd = inputs.ceilingUsd ?? 0;
    const committedUsd = inputs.committedUsd ?? 0;
    if (paidRegistered && ceilingUsd - committedUsd <= 0) {
      publicReason = 'ceiling';
    } else {
      // Quota: at least one registered permitted provider must be above
      // its floor. A provider with an invalid quota model is excluded
      // (§13 quota-invalid) and cannot satisfy this condition.
      const anyAboveFloor = productionExecutorIds.some((id) => {
        const q = providerQuotas.get(id) ?? null;
        if (!q) return false;
        if (!Number.isFinite(q.remaining) || !Number.isFinite(q.total) || !Number.isFinite(q.floor)) return false;
        if (q.total <= q.floor) return false;
        return q.remaining > q.floor;
      });
      if (!anyAboveFloor) {
        publicReason = 'quota-exhausted';
      } else if (!storageOk) {
        publicReason = 'storage-full';
      } else {
        const anyDispatchable = (inputs.productionDispatchableIds ?? productionExecutorIds).length > 0;
        if (!anyDispatchable) {
          publicReason = 'no-worker';
        } else {
          publicAuthorised = true;
        }
      }
    }
  }

  // --- personal ---
  let personalAuthorised = false;
  let personalReason = null;
  if (mode !== 'production') {
    personalReason = 'not-activated';
  } else if (killSwitchEngaged) {
    personalReason = 'kill-switch-engaged';
  } else if (!flags.personalProductionActivated) {
    personalReason = 'not-activated';
  } else if (!personalExecutorRegistered || !kaggleCredentialPresent || !ownerTokenConfigured) {
    // The §9 "no executor" case: no personal executor registered for
    // this mode (registration also requires the Kaggle credential and
    // the configured owner token, §6).
    personalReason = 'no-production-executor';
  } else if (kaggleQuota !== null) {
    // Quota floor (§12): personal dispatch stops at or below the
    // experimental floor. An invalid quota model cannot satisfy the
    // condition (fail closed).
    const q = kaggleQuota;
    if (!Number.isFinite(q.remaining) || !Number.isFinite(q.total) || !Number.isFinite(q.floor)
      || q.total <= q.floor) {
      personalReason = 'quota-exhausted';
    } else if (q.remaining <= q.floor) {
      personalReason = 'quota-exhausted';
    } else if (!storageOk) {
      personalReason = 'storage-full';
    } else if (!inputs.personalDispatchable) {
      personalReason = 'no-worker';
    } else {
      personalAuthorised = true;
    }
  } else if (!storageOk) {
    personalReason = 'storage-full';
  } else if (!inputs.personalDispatchable) {
    personalReason = 'no-worker';
  } else {
    personalAuthorised = true;
  }

  const body = {
    engine: 'ltx-video-2b',
    mode,
    requestedAudience: inputs.requestedAudience ?? 'public',
    requestNonce: inputs.requestNonce ?? '',
    publicProductionAuthorised: publicAuthorised,
    ...(publicAuthorised ? {} : { reason: publicReason }),
    publicProductionActivated: flags.publicProductionActivated === true,
    personalProductionAuthorised: personalAuthorised,
    ...(personalAuthorised ? {} : { personalReason }),
    personalProductionActivated: flags.personalProductionActivated === true,
    personalTokenId: inputs.personalTokenId ?? null,
    killSwitchEngaged,
    queueDepth,
    providers: inputs.providerDetails ?? [],
    storage: {
      totalBytes: Math.max(0, storage.totalBytes ?? 0),
      freeBytes: Math.max(0, storage.freeBytes ?? 0),
      headroomBytes: Math.max(0, storage.headroomBytes ?? 0),
      reservedBytes: Math.max(0, storage.reservedBytes ?? 0),
      ok: storageOk,
    },
  };
  return body;
}

// Storage health (§9 F): ok iff headroom after reservations >= 500 MB
// AND the store directory is writable AND the sweep last ran successfully
// within 2 hours (heartbeat verdict supplied by the caller).
export function storageHealth({ headroomBytes, writable, sweepHealthy }) {
  const ok = (headroomBytes ?? 0) >= STORAGE_SAFETY_MARGIN_BYTES
    && writable === true
    && sweepHealthy === true;
  return { headroomBytes: Math.max(0, headroomBytes ?? 0), ok };
}
