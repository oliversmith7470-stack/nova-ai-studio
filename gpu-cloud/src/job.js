// NOVA Personal GPU Cloud — Stage 1: job model.
//
// A job is a RECORD only. It never holds image or video bytes (O-27: no
// persistent media storage in Development). The `resultRef` field holds an
// opaque delivery reference (e.g. a transient provider URL) — never media.
//
// Status lifecycle:
//   queued -> dispatched -> running -> succeeded | failed | cancelled | timed-out
//   queued -> cancelled (owner cancel / kill-switch)
//   dispatched -> failed | cancelled | timed-out
// Terminal states (succeeded, failed, cancelled, timed-out) have no exit.
//
// Idempotency: a client-supplied idempotency key maps to exactly one job.
// Submitting the same key twice returns the existing job; it never creates
// a second job and never causes a second dispatch.

import { randomUUID } from 'node:crypto';

export const JOB_TYPES = Object.freeze(['image', 'video', 'other']);

export const JOB_STATUSES = Object.freeze([
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
]);

export const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
]);

// Allowed transitions. Anything else is a JobTransitionError.
export const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['dispatched', 'cancelled']),
  dispatched: Object.freeze(['running', 'failed', 'cancelled', 'timed-out']),
  running: Object.freeze(['succeeded', 'failed', 'cancelled', 'timed-out']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  'timed-out': Object.freeze([]),
});

// Default maximum generation time per job type (ms). Overridable per job
// via params.timeoutMs. A job that runs past its timeout is marked
// timed-out by the manager's timeout sweep (see gpu-manager.js).
export const DEFAULT_TIMEOUTS_MS = Object.freeze({
  image: 5 * 60 * 1000, // 5 minutes
  video: 30 * 60 * 1000, // 30 minutes
  other: 10 * 60 * 1000, // 10 minutes
});

// Default minimum GPU memory per job type (GB). Overridable per job via
// params.minVramGb. The dispatcher only assigns a job to a provider whose
// per-GPU VRAM meets this (two cards are NOT one unified pool — VDP-03).
export const DEFAULT_MIN_VRAM_GB = Object.freeze({
  image: 8,
  video: 12,
  other: 8,
});

// Default estimated generation time per job type (seconds), used only to
// estimate cost before dispatch. Overridable per job via
// params.estimatedSeconds. Estimates are planning figures, not ceilings.
export const DEFAULT_ESTIMATED_SECONDS = Object.freeze({
  image: 60,
  video: 300,
  other: 120,
});

export class JobValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobValidationError';
  }
}

export class JobTransitionError extends Error {
  constructor(from, to) {
    super(`invalid job transition: ${from} -> ${to}`);
    this.name = 'JobTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function createJob({
  idempotencyKey,
  type,
  modelId,
  prompt,
  params = {},
  priority = 0,
  seq,
  now,
}) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new JobValidationError('idempotencyKey is required (non-empty string)');
  }
  if (!JOB_TYPES.includes(type)) {
    throw new JobValidationError(`type must be one of: ${JOB_TYPES.join(', ')}`);
  }
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new JobValidationError('modelId is required (non-empty string)');
  }
  if (typeof prompt !== 'string') {
    throw new JobValidationError('prompt must be a string');
  }
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new JobValidationError('priority must be a finite number');
  }
  if (typeof seq !== 'number') {
    throw new JobValidationError('seq is required (monotonic queue sequence)');
  }
  if (typeof now !== 'number') {
    throw new JobValidationError('now is required (ms epoch)');
  }

  return {
    id: `job_${randomUUID()}`,
    idempotencyKey,
    type,
    modelId,
    prompt,
    params: { ...params },
    priority,
    seq,
    status: 'queued',
    providerId: null,
    reservationId: null,
    // Kill-switch / cancel semantics (VDP-02): cancellation is a REQUEST.
    // A remote job may still complete after the request; that outcome is
    // recorded in cancelOutcome and the cost is kept for reconciliation.
    cancellationRequested: false,
    cancellationRequestedAt: null,
    cancelOutcome: null, // 'provider-completed' | 'provider-failed' | null
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUTS_MS[type],
    minVramGb: params.minVramGb ?? DEFAULT_MIN_VRAM_GB[type],
    estimatedSeconds: params.estimatedSeconds ?? DEFAULT_ESTIMATED_SECONDS[type],
    cost: {
      estimatedUsd: null, // set at dispatch, from the provider's cost model
      providerReportedUsd: null, // set at completion, from the provider report
      providerReportedSeconds: null, // set at completion, from the provider report
      novaSeconds: null, // NOVA-measured wall time (completedAt - startedAt)
      currency: 'USD',
    },
    error: null,
    // FreeLLMAPI gateway prompt enhancement (approved v5 design, A5).
    // The original prompt above is immutable; the fields below are
    // nullable and default to current behaviour (no migration, no
    // behaviour change for existing jobs). Metadata fields are DEFERRED
    // (A2) — none exist on the record.
    enhancedPrompt: null, // gateway-produced variant, when accepted
    promptSource: 'user', // 'user' | 'enhanced' — which prompt dispatches
    enhancementSource: null, // 'gateway' | 'direct-gemini' | null
    enhancementModel: null, // exact verified X-Routed-Via (gateway) or google/gemini-3.5-flash (direct)
    enhancementRequestedModel: null, // colon-form gateway identifier requested, null otherwise
    enhancementReportedModel: null, // gateway response model, null otherwise
    // Server-created reference to the sandbox owner-authorization record
    // covering this job (A5 contract). The caller can never supply it.
    sandboxAuthorizationId: null,
    // Opaque delivery reference only — NEVER media bytes (O-27).
    resultRef: null,
    providerCompletedAt: null,
    reconciliationNeeded: false,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
  };
}

// Move a job to a new status. Throws JobTransitionError on an illegal move.
// Sets the matching timestamp (dispatchedAt / startedAt / completedAt).
export function transition(job, to, now) {
  const allowed = TRANSITIONS[job.status] ?? [];
  if (!allowed.includes(to)) {
    throw new JobTransitionError(job.status, to);
  }
  job.status = to;
  job.updatedAt = now;
  if (to === 'dispatched') job.dispatchedAt = now;
  if (to === 'running') job.startedAt = now;
  if (TERMINAL_STATUSES.has(to)) job.completedAt = now;
  return job;
}

export function isTerminal(job) {
  return TERMINAL_STATUSES.has(job.status);
}

// The clock a timeout is measured from: running jobs count from start,
// dispatched-but-not-yet-running jobs count from dispatch.
export function startedClockAt(job) {
  return job.startedAt ?? job.dispatchedAt;
}
