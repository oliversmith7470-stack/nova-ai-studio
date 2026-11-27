// NOVA AI Studio — mirrored NEXORA halt (Kaggle design v13, §5.4).
//
// API-side halt state for client `nexora-service`, persisted in
// api-state.json: `{ halted, reason, changed_at }`. Operator set/clear
// functions (CLI-only, audit-logged). Enforced at NEXORA submit
// independently of NEXORA's local flag: halt set → queued NEXORA jobs
// cancelled, reservations released, new submits refused (T-V23);
// running kernels complete (no cancel exists).
//
// Clearing a halt requires a recorded revisit decision (design §5.4
// v13, mirroring the NEXORA side): the operator records one of
// 'initial-declaration' | 'kaggle-confirmation' |
// 'channels-kept-off-kaggle' in api-state.json (`revisitDecisions`)
// and the clear is refused until a decision exists at/after the
// halt's changed_at. A halt that was never set clears freely (no-op).

import { NEXORA_CLIENT_ID } from './nexora-auth.js';

export const REVISIT_DECISION_KINDS = [
  'initial-declaration',
  'kaggle-confirmation',
  'channels-kept-off-kaggle',
];

function haltsState(apiState) {
  apiState.reloadIfChanged();
  if (!apiState.state.nexoraClientHalts || typeof apiState.state.nexoraClientHalts !== 'object') {
    return {};
  }
  return apiState.state.nexoraClientHalts;
}

function decisionsState(apiState) {
  apiState.reloadIfChanged();
  if (!Array.isArray(apiState.state.revisitDecisions)) {
    return [];
  }
  return apiState.state.revisitDecisions;
}

// Record a revisit decision (OPERATOR ONLY, audit-logged). Returns the
// decision. `kind` must be one of REVISIT_DECISION_KINDS.
export function recordRevisitDecision(apiState, { kind, detail = null, recordedBy = 'operator', nowMs = Date.now() }) {
  if (!REVISIT_DECISION_KINDS.includes(kind)) {
    throw new Error(`recordRevisitDecision requires kind in ${REVISIT_DECISION_KINDS.join(', ')}`);
  }
  const decision = {
    kind,
    detail,
    recorded_at: new Date(nowMs).toISOString(),
    recorded_by: recordedBy,
  };
  apiState.mutate((s) => {
    if (!Array.isArray(s.revisitDecisions)) s.revisitDecisions = [];
    s.revisitDecisions.push(decision);
  });
  apiState.logOperator('nexora-revisit-decision', {
    kind,
    detail,
  });
  return { ...decision };
}

// True when a revisit decision was recorded at/after `sinceMs`.
export function hasRevisitDecisionSince(apiState, sinceMs) {
  for (const d of decisionsState(apiState)) {
    if (Date.parse(d.recorded_at) >= sinceMs) return true;
  }
  return false;
}

// Set or clear the halt for one client (OPERATOR ONLY). Returns the
// record. `halted` must be a boolean; clearing is `halted: false`.
// Clearing a LIVE halt is refused (throws) unless a revisit decision
// was recorded at/after the halt's changed_at — the operator must
// record the decision first (T-V36).
export function setNexoraHalt(apiState, { clientId = NEXORA_CLIENT_ID, halted, reason = null, changedBy = 'operator', nowMs = Date.now() }) {
  if (typeof halted !== 'boolean') {
    throw new Error('setNexoraHalt requires halted to be a boolean');
  }
  if (halted === false) {
    const current = haltsState(apiState)[clientId];
    if (current && current.halted === true) {
      const haltedAt = Date.parse(current.changed_at);
      if (!hasRevisitDecisionSince(apiState, haltedAt)) {
        throw new Error('halt clear refused: no revisit decision recorded since the halt was set');
      }
    }
  }
  const record = {
    halted,
    reason: halted ? (reason ?? 'operator halt') : null,
    changed_at: new Date(nowMs).toISOString(),
    changed_by: changedBy,
  };
  apiState.mutate((s) => {
    if (!s.nexoraClientHalts || typeof s.nexoraClientHalts !== 'object') {
      s.nexoraClientHalts = {};
    }
    s.nexoraClientHalts[clientId] = record;
  });
  apiState.logOperator(halted ? 'nexora-halt-set' : 'nexora-halt-cleared', {
    client_id: clientId,
    reason: record.reason,
  });
  return { ...record };
}

export function getNexoraHalt(apiState, clientId = NEXORA_CLIENT_ID) {
  const record = haltsState(apiState)[clientId];
  return record ? { ...record } : null;
}

export function isNexoraHalted(apiState, clientId = NEXORA_CLIENT_ID) {
  return getNexoraHalt(apiState, clientId)?.halted === true;
}
