// NOVA Personal GPU Cloud — NOVA Cloud Storage: retention policies.
//
// Retention is a CONFIGURABLE POLICY, not a baked-in answer. Two policies
// exist; the namespace sets the default and a put can override per object.
//
//   persistent — the object has no expiry (expiresAt null). It stays until
//     the owner deletes it.
//   transient  — the object expires ttlMs after creation. The expiry sweep
//     deletes it for real (chunks + index record + delivery references).
//
// THE 24-HOUR RULE (owner direction, 24 Nov 2026 ~16:46 WAT): every 24
// hours the manager automatically deletes generated content to keep space.
// A user has 24 HOURS from generation to download what was generated;
// after 24 hours it is deleted automatically. GENERATED_CONTENT_TTL_MS is
// that rule in code, and it is the default transient TTL for the
// generated-output namespaces (outputs, media, text).
//
// HISTORY (recorded so the flip is auditable, not silent):
//   - A2 O-27 (owner, 24 Nov ~12:23 WAT): deliver, no server copy kept.
//     That record stands for the A2 scope.
//   - Storage direction (owner, 24 Nov ~16:44 WAT): everything rests on
//     this store, so NOVA content is KEPT on it by default — superseding
//     O-27's no-copy rule for content on this store.
//   - Storage direction refined (owner, 24 Nov ~16:46 WAT): generated
//     outputs get a 24h TTL with automatic deletion; models, system files
//     and small records persist. This file implements the refined rule.

import { StorageValidationError } from './errors.js';

// 24 hours, in milliseconds. The generated-content lifetime.
export const GENERATED_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;

export const RETENTION_POLICIES = Object.freeze(['persistent', 'transient']);

// Resolve the retention for one put: namespace default, overridden by the
// caller's explicit retention/ttlMs. Returns { policy, ttlMs, expiresAt }
// (ttlMs/expiresAt are null for persistent).
export function resolveRetention(namespaceDef, overrides, createdAt) {
  const policy = overrides?.retention ?? namespaceDef.retention;
  if (!RETENTION_POLICIES.includes(policy)) {
    throw new StorageValidationError(
      `retention must be one of: ${RETENTION_POLICIES.join(', ')}`,
    );
  }
  if (policy === 'persistent') {
    return { policy: 'persistent', ttlMs: null, expiresAt: null };
  }
  const ttlMs = overrides?.ttlMs ?? namespaceDef.defaultTtlMs ?? GENERATED_CONTENT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new StorageValidationError('ttlMs must be a positive integer (milliseconds)');
  }
  return { policy: 'transient', ttlMs, expiresAt: createdAt + ttlMs };
}

// An object is expired when it has an expiry time at or before `now`.
// Persistent objects (expiresAt null) never expire.
export function isExpired(record, now) {
  return record.expiresAt !== null && record.expiresAt <= now;
}
