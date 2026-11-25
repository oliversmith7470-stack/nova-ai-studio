// NOVA AI Studio — Phase 3 API process: emergency revocation.
//
// Rev 3.2 §B-3.2.4.2 (amending Rev 3 §C-1.10(b)):
//   - Authoritative source: a revocation record in the manager store
//     (the shared persistent state the API process already owns), keyed
//     by the revoked secret's SHA-256 fingerprint. No API process decides
//     revocation from its own environment or memory alone.
//   - Propagation: asynchronous with a SPECIFIED MAXIMUM of 5 seconds —
//     instantaneous revocation is not required in Phase 3 and is not
//     claimed. Each process re-reads the record when its cached copy is
//     older than 5 s (this implementation re-reads on file-mtime change,
//     which is immediate in practice; the 5-second figure is the
//     specified maximum, not a measured figure).
//   - Procedure order: (1) write the revocation record (this IS the
//     revocation — from this moment the old secret is revoked everywhere,
//     subject only to the 5 s bound) and record ONE logical revocation
//     event in the operator log; (2) set the new secret on the API
//     process(es); (3) update the Worker secret; (4) verify with a signed
//     health-check using the new secret, and verify the old secret is
//     rejected (401) by every active process.
//   - The ordinary 1-hour rotation overlap is VOID for a revoked
//     fingerprint. A planned rotation (no revocation record) still
//     accepts both secrets for one hour.
//   - Scope: the API shared secret (HMAC secret) only. Job tokens are
//     per-job and are not revoked through this mechanism.
//
// The record is written to BOTH the manager store (authoritative, via
// manager.store.mutate — the store already owns the atomic write path)
// and the API state file (working copy, for cross-process visibility in
// tests and for processes that share the data directory).

import { fingerprintOfSecret } from './auth.js';
import { REVOCATION_MAX_PROPAGATION_MS } from './constants.js';

export function revokeSecret({ apiState, managerStore, secret, revokedBy, reason }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('revokeSecret requires the secret value (or its fingerprint)');
  }
  const fingerprint = fingerprintOfSecret(secret);
  const record = {
    type: 'secret-revocation',
    fingerprint,
    revokedAt: Date.now(),
    revokedBy: revokedBy || 'operator',
    reason: reason || 'emergency revocation',
  };
  // Authoritative copy: the manager store.
  if (managerStore) {
    managerStore.mutate((s) => {
      if (!Array.isArray(s.apiRevocations)) s.apiRevocations = [];
      if (!s.apiRevocations.some((r) => r.fingerprint === fingerprint)) {
        s.apiRevocations.push(record);
      }
    });
  }
  // Working copy: the API state file (shared across processes via mtime).
  apiState.mutate((s) => {
    if (!s.revocations.some((r) => r.fingerprint === fingerprint)) {
      s.revocations.push(record);
    }
  });
  // ONE logical revocation event in the operator log — not one per process.
  apiState.logOperator('secret-revoked', {
    fingerprint,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
    reason: record.reason,
    maxPropagationMs: REVOCATION_MAX_PROPAGATION_MS,
  });
  return record;
}

export function isRevoked(apiState, secret) {
  apiState.reloadIfChanged();
  const fingerprint = fingerprintOfSecret(secret);
  return (apiState.state.revocations || []).some((r) => r.fingerprint === fingerprint);
}

export function listRevocations(apiState) {
  apiState.reloadIfChanged();
  return [...(apiState.state.revocations || [])];
}
