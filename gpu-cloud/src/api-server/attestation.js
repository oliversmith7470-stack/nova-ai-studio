// NOVA Personal GPU Cloud — server-generated personal attestation
// (M2-P round 2, reviewer re-review 27 Nov 2026).
//
// The personal attestation is the ONLY lawful personal marker at the
// VDP-06 boundary besides stage2Test. It is a trusted, server-generated,
// authenticated assertion — NEVER an incoming boolean. The API process
// generates it at submit time, only after the Worker-authenticated
// request passes the purpose and token-identifier checks, and signs it
// with the API host's server-held signing secret (NOVA_SIGNING_SECRET —
// the same key separation as Rev 4.8 §8: the transport secret never
// signs anything). The executor verifies it at the VDP-06 boundary
// through verifyPersonalAttestation, which performs actual authenticity
// and binding checks — not field comparison:
//
//   - authenticity: the HMAC-SHA-256 signature verifies under a
//     configured, non-revoked server-held signing secret (constant-time
//     compare; current, then previous during rotation — revocation
//     overrides the overlap, mirroring verifyWorkerAuth step 4);
//   - binding: owner identity (the verified owner-token identifier),
//     the explicitly selected purpose (one of the five), and the specific
//     job (the Worker job id) must all match the expected values, so the
//     attestation cannot be reused for another job, another owner, or
//     another purpose;
//   - freshness: attestedAt must be a safe integer, not in the future
//     beyond clock skew, and not older than the validity window (24 h —
//     a queued personal job must still verify when the executor picks it
//     up hours later, but a stale attestation never revives).
//
// The jobId binding rests on a server-verified uniqueness chain (M2-P
// round 3, reviewer re-review verdict §1): the client supplies only
// the FORM of the Worker job id (`nova-job-<uuid>`); uniqueness is
// verified server-side — the Worker enforces one job per id through
// the D1 jobs PRIMARY KEY, the conditional creation batch, and the 409
// on a different request under the same id, and the API re-checks the
// id's form and loads its D1 record before signing (a jobId with no D1
// record is refused 404, so an attestation can never bind an id the
// Worker never issued). The manager's internal job.id is a different,
// idempotency-derived value and is NEVER an alternate key in this
// verification path: verifyPersonalAttestation consults only the
// expected jobId (the Worker job id in params.jobId), and no caller
// may substitute job.id for it.
//
// The purpose itself is NOT proof of non-commercial use: the attestation
// is the owner's explicit confirmation, authenticated by the Worker-side
// owner-token verification and bound here by the token identifier. A job
// whose purpose is one of the five but carries no valid signed
// attestation is refused at the boundary — the same as a job with no
// marker at all. The credential scan still runs for BOTH lawful markers
// (stage2Test and attestation) — see data-guard.js.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { NON_COMMERCIAL_PURPOSES } from './activation.js';
import { fingerprintOfSecret } from './auth.js';

export const ATTESTATION_VERSION = 1;

// A queued personal job must still verify when the executor picks it up
// hours later (Kaggle queue waits, operator pickup); 24 h bounds the
// reuse window without expiring a legitimate queued job.
export const ATTESTATION_VALIDITY_MS = 24 * 3600 * 1000;
export const ATTESTATION_CLOCK_SKEW_MS = 60 * 1000;

// Canonical form for signing: fixed field order, one field per line.
// The signature covers every binding field, so none of them can be
// altered after signing.
export function canonicalAttestationString(attestation) {
  return [
    `v${attestation.version}`,
    attestation.audience,
    attestation.ownerTokenId,
    attestation.purpose,
    attestation.jobId,
    String(attestation.attestedAt),
    attestation.nonCommercial === true ? 'non-commercial' : 'commercial',
  ].join('\n');
}

// Generate the server attestation for one personal submit. Called only
// by the API process, only after authentication and the explicit-purpose
// + token-identifier checks. Throws on any invalid input — a malformed
// attestation is never produced. The returned object is the exact shape
// the reviewer prescribed, plus the server-held signature.
export function signPersonalAttestation(fields, signingSecret) {
  const { ownerTokenId, purpose, jobId, attestedAt } = fields ?? {};
  if (typeof ownerTokenId !== 'string' || ownerTokenId.length === 0) {
    throw new Error('signPersonalAttestation requires a non-empty ownerTokenId');
  }
  if (!NON_COMMERCIAL_PURPOSES.includes(purpose)) {
    throw new Error('signPersonalAttestation requires a purpose from the five non-commercial purposes');
  }
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('signPersonalAttestation requires a non-empty jobId');
  }
  if (!Number.isSafeInteger(attestedAt)) {
    throw new Error('signPersonalAttestation requires a safe-integer attestedAt');
  }
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    throw new Error('signPersonalAttestation requires a server-held signing secret');
  }
  const attestation = {
    version: ATTESTATION_VERSION,
    audience: 'personal',
    ownerTokenId,
    purpose,
    jobId,
    attestedAt,
    nonCommercial: true,
  };
  attestation.signature = createHmac('sha256', signingSecret)
    .update(canonicalAttestationString(attestation), 'utf8')
    .digest('hex');
  return attestation;
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Verify a personal attestation against the expected binding.
// `expected` = { ownerTokenId, purpose, jobId [, recordedPurpose] }:
//   - purpose: a single purpose string (must equal the attestation's)
//     or the list of allowed purposes (the attestation's must be in it);
//   - recordedPurpose (optional): the purpose recorded on the job — when
//     supplied as a string the attestation's purpose must equal it, so a
//     signed attestation for one purpose cannot ride on a job recorded
//     under another.
//   - jobId: the Worker job id the attestation is bound to — the job's
//     identity across the Worker, the journal and the manager record
//     (params.jobId). The manager's internal job.id is a different,
//     idempotency-derived value and is NOT what the attestation binds.
// `signingSecrets`: the server-held signing secrets to try (current,
// then previous during rotation). `opts.isRevoked` (fingerprint) =>
// boolean skips revoked secrets. `opts.nowMs` injects the clock for
// tests. Returns false on ANY failure — an unverifiable attestation is
// not a lawful marker.
export function verifyPersonalAttestation(attestation, expected, signingSecrets, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const isRevoked = typeof opts.isRevoked === 'function' ? opts.isRevoked : null;

  // Shape + freshness.
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return false;
  if (attestation.version !== ATTESTATION_VERSION) return false;
  if (attestation.audience !== 'personal') return false;
  if (attestation.nonCommercial !== true) return false;
  if (typeof attestation.ownerTokenId !== 'string' || attestation.ownerTokenId.length === 0) return false;
  if (typeof attestation.jobId !== 'string' || attestation.jobId.length === 0) return false;
  if (!NON_COMMERCIAL_PURPOSES.includes(attestation.purpose)) return false;
  if (!Number.isSafeInteger(attestation.attestedAt)) return false;
  if (attestation.attestedAt > nowMs + ATTESTATION_CLOCK_SKEW_MS) return false;
  if (attestation.attestedAt < nowMs - ATTESTATION_VALIDITY_MS) return false;
  if (typeof attestation.signature !== 'string' || !/^[0-9a-f]{64}$/i.test(attestation.signature)) return false;

  // Binding to the expected job.
  if (!expected || typeof expected !== 'object') return false;
  if (typeof expected.ownerTokenId !== 'string' || attestation.ownerTokenId !== expected.ownerTokenId) return false;
  if (typeof expected.jobId !== 'string' || attestation.jobId !== expected.jobId) return false;
  if (typeof expected.purpose === 'string') {
    if (attestation.purpose !== expected.purpose) return false;
  } else if (Array.isArray(expected.purpose)) {
    if (!expected.purpose.includes(attestation.purpose)) return false;
  } else if (expected.purpose !== undefined) {
    return false;
  }
  if (typeof expected.recordedPurpose === 'string' && attestation.purpose !== expected.recordedPurpose) return false;

  // Authenticity: the signature must verify under a configured,
  // non-revoked server-held signing secret (constant-time compare).
  const secrets = (Array.isArray(signingSecrets) ? signingSecrets : [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return false;
  const canonical = canonicalAttestationString(attestation);
  for (const secret of secrets) {
    if (isRevoked && isRevoked(fingerprintOfSecret(secret))) continue;
    const expectedSignature = createHmac('sha256', secret)
      .update(canonical, 'utf8')
      .digest('hex');
    if (constantTimeHexEqual(expectedSignature, attestation.signature)) return true;
  }
  return false;
}

// Build the verifier closure the personal executor carries: it binds the
// API host's signing secrets (current + previous during rotation) and
// the revocation record (re-read from disk at verify time, so a
// revocation recorded after startup still applies), so the VDP-06
// boundary verifies against live state. The returned function takes
// (attestation, expected, opts) — the same shape data-guard passes.
export function createAttestationVerifier({ signingSecrets = [], apiState = null } = {}) {
  const secrets = (Array.isArray(signingSecrets) ? signingSecrets : [])
    .filter((s) => typeof s === 'string' && s.length > 0);
  return (attestation, expected, opts = {}) => {
    const isRevoked = apiState && typeof apiState.reloadIfChanged === 'function'
      ? (fingerprint) => {
          apiState.reloadIfChanged();
          return (apiState.state.revocations || [])
            .some((r) => r.fingerprint === fingerprint);
        }
      : null;
    return verifyPersonalAttestation(attestation, expected, secrets, { ...opts, isRevoked });
  };
}
