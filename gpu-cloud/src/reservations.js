// NOVA Personal GPU Cloud — Stage 1: quota reservation ledger.
//
// QUOTA RESERVATION BEFORE DISPATCH: a reservation record is created
// BEFORE any job is dispatched, and released on every terminal state
// (succeeded / failed / cancelled / timed-out). A reservation is the
// manager's own accounting of committed spend — it is what the global
// spending ceiling is enforced against.
//
// A reservation is NOT a provider-side hold. It cannot stop a provider
// charging for an accepted job (VDP-02); it stops NOVA dispatching work
// it has not budgeted for.

import { randomUUID } from 'node:crypto';

export function createReservation(state, { jobId, providerId, estimatedUsd, now }) {
  const reservation = {
    id: `res_${randomUUID()}`,
    jobId,
    providerId,
    estimatedUsd,
    status: 'active',
    createdAt: now,
    releasedAt: null,
    releaseReason: null,
  };
  state.reservations[reservation.id] = reservation;
  return reservation;
}

// Release is idempotent: releasing an already-released reservation is a
// no-op that returns the existing record.
export function releaseReservation(state, reservationId, reason, now) {
  const r = state.reservations[reservationId];
  if (!r) return null;
  if (r.status === 'released') return r;
  r.status = 'released';
  r.releasedAt = now;
  r.releaseReason = reason;
  return r;
}

export function activeReservationForJob(state, jobId) {
  return (
    Object.values(state.reservations).find(
      (r) => r.jobId === jobId && r.status === 'active',
    ) ?? null
  );
}

// Sum of estimated USD across all active reservations — the committed
// spend the ceiling is enforced against.
export function committedUsd(state) {
  return Object.values(state.reservations)
    .filter((r) => r.status === 'active')
    .reduce((sum, r) => sum + r.estimatedUsd, 0);
}
