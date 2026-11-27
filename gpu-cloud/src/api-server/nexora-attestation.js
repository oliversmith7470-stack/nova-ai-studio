// NOVA AI Studio — NEXORA-facing attestation registry (Kaggle design
// v4, §5.3).
//
// This is a DIFFERENT thing from the Worker-side VDP-06 attestation
// (api-server/attestation.js, M2-P round 2): that one is server-generated
// after Worker authentication, HMAC-signed, and binds ownerTokenId /
// purpose / Worker jobId. THIS registry is NEXORA-facing and per-session:
// NEXORA calls POST /internal/attest with {client_id, session_id,
// restriction_text_version}; the API assigns attestation_id,
// confirmed_at_api and expires_at_api = confirmed_at_api + 4 h on the
// API clock, and stores the record. The two systems share no code, no
// state, and no field names beyond the word "attestation" — do not
// conflate them.
//
// Registry rules (design §5.3), enforced at submit:
//   unknown, expired, revoked, wrong-client, wrong-session,
//   obsolete-version — all refuse; no job, no reservation.
// Duplicate attest (same live session) is NOT a refusal (design §5.3,
// v13): it returns the existing record unchanged — 200, no new id, no
// later expiry, not counted toward the daily limit.
// The registry is persisted in the API state file (api-state.json,
// `nexoraAttestations`) — it survives a restart; never memory-only.
// A client-supplied timestamp, if any, is ignored: the API clock is
// the only clock (test T-V20).
//
// Residual rule (design §5.3): at most 6 attestations per client per
// day; the 7th is refused.
//
// `restriction_text_version` is a single current version string held
// in this module; a version change invalidates all outstanding
// attestations (obsolete-version). The NEXORA client sends "v1"
// (nexora/gpu_jobs/attestation.py::RESTRICTION_TEXT_VERSION).

import { randomUUID } from 'node:crypto';

import { NEXORA_CLIENT_ID } from './nexora-auth.js';

export const RESTRICTION_TEXT_VERSION = 'v1';
export const ATTESTATION_VALIDITY_MS = 4 * 3600 * 1000; // 4 h, §5.3
export const MAX_ATTESTATIONS_PER_CLIENT_PER_DAY = 6; // §5.3 residual

function attestationsState(apiState) {
  apiState.reloadIfChanged();
  if (!apiState.state.nexoraAttestations || typeof apiState.state.nexoraAttestations !== 'object') {
    return {};
  }
  return apiState.state.nexoraAttestations;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Issue a new attestation for one session. Returns
// { ok: true, attestation } or { ok: false, reason } where reason is one
// of 'invalid-client' | 'obsolete-version' | 'attestation-limit'.
// `nowMs` injects the clock for tests. A duplicate for a live session
// (same client + session, unexpired, unrevoked) returns the EXISTING
// record unchanged ({ ok: true, attestation: existing, duplicate: true })
// — 200, no new id, no later expiry, not counted toward the daily
// limit (design §5.3 v13). The duplicate check runs before the daily
// cap, so a client at its 6/day cap still re-receives its live record.
export function issueAttestation(apiState, { clientId, sessionId, restrictionTextVersion, nowMs = Date.now() }) {
  if (clientId !== NEXORA_CLIENT_ID) {
    return { ok: false, reason: 'invalid-client' };
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'invalid-session' };
  }
  if (restrictionTextVersion !== RESTRICTION_TEXT_VERSION) {
    return { ok: false, reason: 'obsolete-version' };
  }
  const records = attestationsState(apiState);
  // Duplicate: the same session already holds an unexpired, unrevoked
  // attestation — return it unchanged (design §5.3 v13).
  for (const r of Object.values(records)) {
    if (r.client_id === clientId && r.session_id === sessionId
      && r.revoked !== true && Date.parse(r.expires_at_api) > nowMs) {
      return { ok: true, attestation: { ...r }, duplicate: true };
    }
  }
  // Per-client daily cap (residual §5.3 rule): count today's issued
  // attestations for this client; refuse the 7th.
  const today = dayKey(nowMs);
  let issuedToday = 0;
  for (const r of Object.values(records)) {
    if (r.client_id === clientId && r.issued_day === today) issuedToday += 1;
  }
  if (issuedToday >= MAX_ATTESTATIONS_PER_CLIENT_PER_DAY) {
    return { ok: false, reason: 'attestation-limit' };
  }
  const confirmedAt = new Date(nowMs).toISOString();
  const attestation = {
    attestation_id: `att-${randomUUID()}`,
    client_id: clientId,
    session_id: sessionId,
    restriction_text_version: restrictionTextVersion,
    confirmed_at_api: confirmedAt,
    expires_at_api: new Date(nowMs + ATTESTATION_VALIDITY_MS).toISOString(),
    revoked: false,
    issued_day: today,
  };
  apiState.mutate((s) => {
    if (!s.nexoraAttestations || typeof s.nexoraAttestations !== 'object') {
      s.nexoraAttestations = {};
    }
    s.nexoraAttestations[attestation.attestation_id] = attestation;
  });
  apiState.logOperator('nexora-attestation-issued', {
    attestation_id: attestation.attestation_id,
    client_id: clientId,
    session_id: sessionId,
    restriction_text_version: restrictionTextVersion,
  });
  return { ok: true, attestation };
}

// Revoke one attestation (POST /internal/revoke, best-effort from the
// client side). Returns { ok: true, attestation } or
// { ok: false, reason: 'unknown-attestation' }. Revoking an already
// revoked attestation is a no-op success (idempotent).
export function revokeAttestation(apiState, attestationId) {
  const records = attestationsState(apiState);
  const record = records[attestationId];
  if (!record) return { ok: false, reason: 'unknown-attestation' };
  if (record.revoked !== true) {
    apiState.mutate((s) => {
      const r = s.nexoraAttestations[attestationId];
      if (r) r.revoked = true;
    });
    apiState.logOperator('nexora-attestation-revoked', {
      attestation_id: attestationId,
      client_id: record.client_id,
      session_id: record.session_id,
    });
  }
  return { ok: true, attestation: { ...record, revoked: true } };
}

// Validate an attestation for submit (design §5.3). The submit payload
// carries only attestation_id — the session binding is the attestation
// itself (an unpredictable UUID held by the session that obtained it);
// `expectedSessionId`, when supplied, must match the record's session
// (the data-guard verifier supplies it; the submit path does not have
// a session to restate). Returns { ok: true, record } or
// { ok: false, reason } where reason is one of 'attestation-unknown' |
// 'attestation-expired' | 'attestation-invalid' | 'obsolete-version'.
// Expiry is checked here: acceptance is the freshness gate (design §5.8
// — an attestation that expired between the first submit and a duplicate
// refuses the duplicate with attestation-expired).
export function validateAttestation(apiState, { attestationId, clientId, expectedSessionId = null, nowMs = Date.now() }) {
  const records = attestationsState(apiState);
  const record = records[attestationId];
  if (!record) return { ok: false, reason: 'attestation-unknown' };
  if (record.revoked === true) return { ok: false, reason: 'attestation-invalid' };
  if (record.client_id !== clientId) return { ok: false, reason: 'attestation-invalid' };
  if (expectedSessionId !== null && record.session_id !== expectedSessionId) {
    return { ok: false, reason: 'attestation-invalid' };
  }
  if (record.restriction_text_version !== RESTRICTION_TEXT_VERSION) {
    return { ok: false, reason: 'obsolete-version' };
  }
  if (Date.parse(record.expires_at_api) <= nowMs) {
    return { ok: false, reason: 'attestation-expired' };
  }
  return { ok: true, record };
}

// The data-guard third-marker verifier (VDP-06 boundary, executor side):
// (attestationId, expected { jobId, sessionId, clientId }, opts) =>
// boolean. Checks record existence + client/session binding +
// not-revoked + current version. It does NOT check the 4 h expiry at
// the executor boundary — acceptance is the freshness gate; a job
// queued for hours must still verify when the executor picks it up,
// and an expired attestation can never authorise a NEW acceptance.
// A null verifier (no registry wired) verifies nothing — fail closed.
export function createNexoraAttestationVerifier(apiState) {
  return (attestationId, expected = {}, _opts = {}) => {
    if (typeof attestationId !== 'string' || attestationId.length === 0) return false;
    const records = attestationsState(apiState);
    const record = records[attestationId];
    if (!record) return false;
    if (record.revoked === true) return false;
    if (expected.clientId !== undefined && record.client_id !== expected.clientId) return false;
    if (expected.sessionId !== undefined && record.session_id !== expected.sessionId) return false;
    if (record.restriction_text_version !== RESTRICTION_TEXT_VERSION) return false;
    // jobId is not bound by the per-session attestation (the binding is
    // client + session); the journal binds the attestation to the job.
    return true;
  };
}
