// NOVA AI Studio — per-origin hours ledger (Kaggle design v13, §6.2,
// §6.5; P-14).
//
// The NOVA ledger is the SOLE authority for NEXORA acceptance; the
// NEXORA local counter is advisory only (T-V24). State is persisted in
// the manager store under the namespaced key `nexoraLedger` — it
// survives a restart with the manager state.
//
// Buckets (§6.5 — ordinary / reserved / protected / commissioning):
//   ordinary     — consumed hours this week, per origin (C_N, C_X);
//   reserved     — in-flight reserved hours, per origin (R_N, R_X);
//   protected    — the 5 h floor (F): not a counter but the threshold
//                  admission must preserve;
//   commissioning— its own accounting label (C_C, R_C): a permit draws
//                  from the ORDINARY bucket only (v13 A-3 — the v4
//                  "draws from the floor" comment was wrong); C_C
//                  counts in Q but NOT against the NEXORA cap.
//
// Where C_N comes from: NOVA-origin personal jobs run through the
// Worker path, which does not write hour reservations into this ledger
// (its floor check is the HoursTracker's per-provider budget). The
// ledger therefore reads C_N live from the HoursTracker
// (kaggle-t4 weekly usage — the tracker's provider total IS the
// NOVA-origin consumed hours, since every NOVA-origin personal job
// runs on kaggle-t4 and the tracker records actual seconds). R_N is
// structurally 0 in v13: the Worker path creates no hour reservations,
// so no NOVA-origin hours are ever "reserved" here — the floor check's
// R_N term is implemented and tested (T-V33 seeds it directly), but
// stays 0 in production until the Worker path writes reservations
// (a follow-up, noted in the implementation report).
//
// Admission for a NEXORA job (§6.2 v13 — the reconciliation term is
// new):
//   Q = min(Q_total − C_N − C_X − C_C, Q_kaggle − D)
//     where Q_total = 30, Q_kaggle = the Kaggle-side remaining hours
//     at the last reconciliation, D = ledger consumption since
//     reconciled_at (D = (C_N + C_X + C_C) − snapshot sums);
//   reconciliation valid iff
//     reconciled_at ≥ max(now_api − 24 h, last_UTC_reset)
//     (last_UTC_reset = the tracker's week start, Saturday 00:00 UTC);
//     invalid or never-reconciled → refused 'quota-unreconciled';
//   floor: Q − R_N − R_X − J ≥ F (F = 5), checked BEFORE the cap —
//     when both fail the reported reason is 'floor-reached';
//   cap:   C_X + R_X + J ≤ K_X (NEXORA weekly cap, default 5 h — the
//     API's value is authoritative).
// Reservations are released ONLY on a confirmed terminal state
// (settle) or operator confirmation (resolveOrphan / halt-cancel) —
// v4 C-1: 24 h is an operator-escalation threshold, NOT an expiry; at
// 24 h the job moves to `orphan-check` AND the operator is escalated;
// the reservation is HELD.
//
// Week: the tracker's UTC week (Saturday 00:00 UTC, hours.js
// weekStartMs). Rollover is lazy, like HoursTracker.usage: a stale
// stored week reads as zeroed; the next mutation writes the fresh
// week. A reservation from a previous week is dropped on rollover (its
// job, if still running, settles its consumed hours into the new week
// — the GPU time falls there). A week rollover also invalidates the
// reconciliation (reconciled_at < the new week start).

import { weekStartMs } from '../hours.js';

export const WEEKLY_BUDGET_HOURS = 30; // Kaggle 30 h/week
export const FLOOR_HOURS = 5; // F, §6.2
export const DEFAULT_NEXORA_CAP_HOURS = 5; // K_X, §6.2
export const DEFAULT_JOB_BUDGET_HOURS = 0.5; // J, §6.2 (proposed)
export const ORPHAN_AFTER_MS = 24 * 3600 * 1000; // C-1 escalation threshold

// Pure admission arithmetic (no store): the exact §6.2 v13 rule,
// testable without a ledger instance. Returns { ok: true } or
// { ok: false, reason: 'quota-unreconciled' | 'floor-reached' |
// 'nexora-cap-reached', detail }. The reconciliation check runs FIRST
// (an unreconciled ledger refuses before any arithmetic), then the
// floor, then the cap — when floor and cap both fail the reported
// reason is 'floor-reached'.
export function computeAdmission({
  consumedN = 0,
  reservedN = 0,
  consumedX = 0,
  reservedX = 0,
  consumedC = 0,
  reservedC = 0,
  jobHours = DEFAULT_JOB_BUDGET_HOURS,
  capHours = DEFAULT_NEXORA_CAP_HOURS,
  floorHours = FLOOR_HOURS,
  budgetHours = WEEKLY_BUDGET_HOURS,
  // Q_kaggle − D: the Kaggle-side remaining hours at the last
  // reconciliation, minus ledger consumption since then. Null when no
  // reconciliation exists (never reconciled) — refused.
  kaggleHeadroomHours = null,
  reconciliationValid = false,
} = {}) {
  const q = kaggleHeadroomHours === null
    ? budgetHours - consumedN - consumedX - consumedC
    : Math.min(budgetHours - consumedN - consumedX - consumedC, kaggleHeadroomHours);
  const detail = {
    q, consumedN, reservedN, consumedX, reservedX, consumedC, reservedC,
    jobHours, capHours, floorHours, kaggleHeadroomHours, reconciliationValid,
    floorHeadroom: q - reservedN - reservedX - jobHours,
    capHeadroom: capHours - (consumedX + reservedX + jobHours),
  };
  if (!reconciliationValid) {
    return { ok: false, reason: 'quota-unreconciled', detail };
  }
  if (q - reservedN - reservedX - jobHours < floorHours) {
    return { ok: false, reason: 'floor-reached', detail };
  }
  if (consumedX + reservedX + jobHours > capHours) {
    return { ok: false, reason: 'nexora-cap-reached', detail };
  }
  return { ok: true, reason: null, detail };
}

function freshLedgerState(weekStart) {
  return {
    version: 1,
    weekStart,
    consumedX: 0,
    reservedX: 0,
    commissioning: { consumed: 0, reserved: 0 },
    reservations: {},
    // §6.2 v13 reconciliation: the last operator reconciliation
    // (null until one happens) — { reconciledAtMs, kaggleRemainingHours,
    // consumedN0, consumedX0, consumedC0 } where the consumed*0 values
    // snapshot the ledger at reconcile time, so D (consumption since)
    // is computable. A week rollover zeroes the counters AND the
    // snapshot (reconciled_at < the new week start invalidates it).
    reconciliation: null,
  };
}

export class PerOriginLedger {
  // store: the manager's JsonStore (nexoraLedger lives there).
  // novaConsumedHours: () => number — the live NOVA-origin consumed
  //   hours this week (the HoursTracker kaggle-t4 usage). When absent,
  //   C_N reads as 0.
  // now: () => ms epoch (injectable for tests).
  constructor({
    store,
    novaConsumedHours = null,
    capHours = DEFAULT_NEXORA_CAP_HOURS,
    floorHours = FLOOR_HOURS,
    jobBudgetHours = DEFAULT_JOB_BUDGET_HOURS,
    now = () => Date.now(),
  } = {}) {
    if (!store) throw new Error('PerOriginLedger requires a store');
    this.store = store;
    this.novaConsumedHours = typeof novaConsumedHours === 'function' ? novaConsumedHours : null;
    this.capHours = capHours;
    this.floorHours = floorHours;
    this.jobBudgetHours = jobBudgetHours;
    this.now = now;
  }

  // The effective ledger state (rollover applied on read — a stale week
  // reads as zeroed). Does not write.
  readState(nowMs = this.now()) {
    const weekStart = weekStartMs(nowMs);
    const stored = this.store.state.nexoraLedger;
    if (!stored || stored.weekStart !== weekStart) return freshLedgerState(weekStart);
    return stored;
  }

  _mutate(fn, nowMs = this.now()) {
    const weekStart = weekStartMs(nowMs);
    let result;
    this.store.mutate((s) => {
      if (!s.nexoraLedger || s.nexoraLedger.weekStart !== weekStart) {
        s.nexoraLedger = freshLedgerState(weekStart);
      }
      result = fn(s.nexoraLedger);
    });
    return result;
  }

  consumedN() {
    if (!this.novaConsumedHours) return 0;
    const v = this.novaConsumedHours();
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  }

  // Operator view (T-V18): all four buckets, plus the raw counters
  // and the reconciliation status. The public capacity surface
  // reports none of these (§6.4).
  snapshot(nowMs = this.now()) {
    const state = this.readState(nowMs);
    const consumedN = this.consumedN();
    return {
      weekStart: state.weekStart,
      consumedN,
      reservedN: 0,
      consumedX: state.consumedX,
      reservedX: state.reservedX,
      commissioning: { ...state.commissioning },
      reconciliation: state.reconciliation ? { ...state.reconciliation } : null,
      reconciliationValid: this.reconciliationValid(nowMs, state),
      kaggleHeadroomHours: this.kaggleHeadroomHours(nowMs, state),
      buckets: {
        // Ordinary: consumed hours (both origins).
        ordinary: consumedN + state.consumedX,
        // Reserved: in-flight reserved hours (both origins + commissioning).
        reserved: state.reservedX + state.commissioning.reserved,
        // Protected: the floor threshold itself (hours that must remain).
        protected: this.floorHours,
        // Commissioning: its own bucket.
        commissioning: state.commissioning.consumed + state.commissioning.reserved,
      },
      reservations: Object.values(state.reservations).map((r) => ({ ...r })),
    };
  }

  // Operator reconciliation (§6.2 v13): the operator reads `kaggle
  // quota` and records the Kaggle-side remaining hours for the week,
  // snapshotting the ledger's consumed counters at the same instant
  // so D (consumption since) is computable. Returns the record.
  reconcile({ kaggleRemainingHours, nowMs = this.now() } = {}) {
    if (typeof kaggleRemainingHours !== 'number' || !Number.isFinite(kaggleRemainingHours) || kaggleRemainingHours < 0) {
      throw new Error('PerOriginLedger.reconcile requires kaggleRemainingHours >= 0');
    }
    return this._mutate((state) => {
      const record = {
        reconciledAtMs: nowMs,
        kaggleRemainingHours,
        consumedN0: this.consumedN(),
        consumedX0: state.consumedX,
        consumedC0: state.commissioning.consumed,
      };
      state.reconciliation = record;
      return { ...record };
    }, nowMs);
  }

  // Reconciliation validity (§6.2 v13): reconciled_at ≥ max(now − 24 h,
  // last_UTC_reset). `state` may be passed to avoid a second read.
  reconciliationValid(nowMs = this.now(), state = null) {
    const s = state ?? this.readState(nowMs);
    const r = s.reconciliation;
    if (!r || typeof r.reconciledAtMs !== 'number') return false;
    return r.reconciledAtMs >= Math.max(nowMs - 24 * 3600 * 1000, weekStartMs(nowMs));
  }

  // Ledger consumption since reconciled_at (D): (C_N + C_X + C_C) now
  // minus the snapshot sums. Null when never reconciled.
  consumedSinceReconcile(nowMs = this.now(), state = null) {
    const s = state ?? this.readState(nowMs);
    const r = s.reconciliation;
    if (!r) return null;
    const now = this.consumedN() + s.consumedX + s.commissioning.consumed;
    const then = r.consumedN0 + r.consumedX0 + r.consumedC0;
    return Math.max(0, now - then);
  }

  // Q_kaggle − D, the Kaggle-side headroom at this instant. Null when
  // never reconciled.
  kaggleHeadroomHours(nowMs = this.now(), state = null) {
    const s = state ?? this.readState(nowMs);
    const r = s.reconciliation;
    if (!r) return null;
    const d = this.consumedSinceReconcile(nowMs, s);
    return r.kaggleRemainingHours - d;
  }

  // Admission for one NEXORA job (read-only — holds nothing).
  admitNexora({ jobHours = this.jobBudgetHours } = {}, nowMs = this.now()) {
    const state = this.readState(nowMs);
    return computeAdmission({
      consumedN: this.consumedN(),
      reservedN: 0,
      consumedX: state.consumedX,
      reservedX: state.reservedX,
      consumedC: state.commissioning.consumed,
      reservedC: state.commissioning.reserved,
      jobHours,
      capHours: this.capHours,
      floorHours: this.floorHours,
      kaggleHeadroomHours: this.kaggleHeadroomHours(nowMs, state),
      reconciliationValid: this.reconciliationValid(nowMs, state),
    });
  }

  // Push-step check (§6.2 v13): before a queued job is pushed to the
  // executor, the dispatcher re-reads `kaggle quota` and refuses to
  // push when Q_kaggle_now − R_N − R_X < F — with R including the job
  // being pushed (its reservation is already held, so the live
  // reservedX includes it). Returns { ok: true } or { ok: false,
  // reason: 'quota-unreconciled' | 'floor-reached' }.
  checkPush({ kaggleRemainingHours, nowMs = this.now() } = {}) {
    if (!this.reconciliationValid(nowMs)) {
      return { ok: false, reason: 'quota-unreconciled' };
    }
    if (typeof kaggleRemainingHours !== 'number' || !Number.isFinite(kaggleRemainingHours)) {
      return { ok: false, reason: 'quota-unreconciled' };
    }
    const state = this.readState(nowMs);
    if (kaggleRemainingHours - 0 - state.reservedX < this.floorHours) {
      return { ok: false, reason: 'floor-reached' };
    }
    return { ok: true, reason: null };
  }

  // Reserve the job's budgeted hours. origin is 'nexora' or
  // 'commissioning' (the commissioning bucket). Returns the reservation.
  reserve({ jobId, origin = 'nexora', hours = this.jobBudgetHours, nowMs = this.now() }) {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new Error('PerOriginLedger.reserve requires a jobId');
    }
    if (origin !== 'nexora' && origin !== 'commissioning') {
      throw new Error(`PerOriginLedger.reserve: unknown origin ${JSON.stringify(origin)}`);
    }
    return this._mutate((state) => {
      const existing = state.reservations[jobId];
      if (existing && existing.status === 'held') return { ...existing };
      const reservation = {
        jobId,
        origin,
        hours,
        createdAtMs: nowMs,
        status: 'held',
        escalatedAtMs: null,
      };
      state.reservations[jobId] = reservation;
      if (origin === 'commissioning') {
        state.commissioning.reserved += hours;
      } else {
        state.reservedX += hours;
      }
      return { ...reservation };
    }, nowMs);
  }

  // Settle a held reservation on a confirmed terminal state: the
  // reserved hours leave the reserved bucket; the ACTUAL GPU hours
  // (provider-reported seconds when available, else the budgeted hours)
  // enter the consumed bucket. Idempotent: a second settle is a no-op.
  // A reservation dropped by a week rollover still records its consumed
  // hours (the GPU time was used) but decrements no reservation.
  settle({ jobId, secondsUsed = null, nowMs = this.now() }) {
    const actual = (typeof secondsUsed === 'number' && Number.isFinite(secondsUsed) && secondsUsed >= 0)
      ? secondsUsed / 3600
      : null;
    return this._mutate((state) => {
      const r = state.reservations[jobId];
      const hours = r ? r.hours : this.jobBudgetHours;
      const consumedHours = actual ?? hours;
      if (r && r.status === 'held') {
        if (r.origin === 'commissioning') {
          state.commissioning.reserved = Math.max(0, state.commissioning.reserved - r.hours);
          state.commissioning.consumed += consumedHours;
        } else {
          state.reservedX = Math.max(0, state.reservedX - r.hours);
          state.consumedX += consumedHours;
        }
        r.status = 'settled';
        r.settledAtMs = nowMs;
        r.consumedHours = consumedHours;
        return { ...r };
      }
      if (!r) {
        // No reservation (week rollover dropped it): record the consumed
        // hours against the NEXORA bucket without touching reserved.
        state.consumedX += consumedHours;
        return { jobId, origin: 'nexora', hours, status: 'settled-no-reservation', consumedHours };
      }
      return { ...r };
    }, nowMs);
  }

  // Release a held reservation WITHOUT consuming it (operator
  // confirmation that the kernel cannot execute, or a halt-cancel of a
  // queued job that never dispatched). Idempotent.
  release({ jobId, nowMs = this.now() }) {
    return this._mutate((state) => {
      const r = state.reservations[jobId];
      if (!r) return null;
      if (r.status !== 'held') return { ...r };
      if (r.origin === 'commissioning') {
        state.commissioning.reserved = Math.max(0, state.commissioning.reserved - r.hours);
      } else {
        state.reservedX = Math.max(0, state.reservedX - r.hours);
      }
      r.status = 'released';
      r.releasedAtMs = nowMs;
      return { ...r };
    }, nowMs);
  }

  // Held reservations older than 24 h with no terminal state (C-1).
  // The reservation is HELD — this only reports them.
  findOrphans(nowMs = this.now()) {
    const state = this.readState(nowMs);
    return Object.values(state.reservations)
      .filter((r) => r.status === 'held' && (nowMs - r.createdAtMs) > ORPHAN_AFTER_MS)
      .map((r) => ({ ...r }));
  }

  // Mark one orphan escalated (operator alert; logged by the caller).
  // A second escalation call is a no-op (the operator is escalated
  // once per reservation).
  escalateOrphan(jobId, nowMs = this.now()) {
    return this._mutate((state) => {
      const r = state.reservations[jobId];
      if (!r || r.status !== 'held' || r.escalatedAtMs !== null) {
        return r ? { ...r } : null;
      }
      r.escalatedAtMs = nowMs;
      return { ...r };
    }, nowMs);
  }

  // Operator confirmation that an orphaned kernel cannot execute:
  // release its reservation. Returns the released reservation, or null
  // when there is nothing held for the job.
  resolveOrphan(jobId, nowMs = this.now()) {
    return this.release({ jobId, nowMs });
  }

  // Non-terminal personal jobs (Rev 4.8 §14 bound: 2 TOTAL across both
  // personal origins; v13 §6.2 per-origin cap: 1 per origin). With no
  // origin argument, counts all personal jobs in flight; with
  // origin 'nexora', only NEXORA-origin jobs (params.origin ===
  // 'nexora'); with origin 'worker', personal jobs from the Worker
  // path (any origin other than 'nexora' — the Worker path carries no
  // origin field of its own). A NEXORA submit is refused while its
  // origin already holds its slot.
  personalQueueDepth(origin = null) {
    return Object.values(this.store.state.jobs || {}).filter((j) => {
      if (j?.params?.audience !== 'personal') return false;
      if (!(j.status === 'queued' || j.status === 'dispatched' || j.status === 'running')) return false;
      if (origin === 'nexora') return j.params?.origin === 'nexora';
      if (origin === 'worker') return j.params?.origin !== 'nexora';
      return true;
    }).length;
  }
}
