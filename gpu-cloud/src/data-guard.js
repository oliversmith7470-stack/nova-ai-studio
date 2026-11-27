// NOVA Personal GPU Cloud — Stage 2: VDP-06 data-handling boundary.
import { NON_COMMERCIAL_PURPOSES } from './api-server/activation.js';
//
// Kaggle and Colab are both Google-owned infrastructure. Stage 2 runs use
// a SYNTHETIC prompt and a NON-SENSITIVE test image only. No private user
// media, confidential project material, credentials, or real customer
// content may reach either free GPU environment in any Stage 2 test.
//
// Enforcement is two layers, and both REFUSE (the executor resolves a
// failed report — it never merely warns):
//
//   1. THE MARKER (primary, enforceable): a job must carry one of the
//      two lawful markers:
//        (a) Stage 2: params.stage2Test === true — the submitter's
//            explicit assertion that this is a synthetic Stage 2 test
//            job. An unmarked job is refused. The guard cannot tell a
//            synthetic prompt from a real user's prompt by content
//            alone, so the marker is what makes the boundary
//            enforceable rather than aspirational.
//        (b) Personal production (Rev 4.8 §12, M2-P; round 2): a
//            personal-audience job carrying a SERVER-GENERATED, SIGNED
//            attestation (params.personalAttestation) that verifies at
//            this boundary through verifyPersonalAttestation: the
//            signature must authenticate under a server-held signing
//            secret, and the attestation must bind the verified
//            owner-token identifier, an explicitly selected purpose from
//            the five NON_COMMERCIAL_PURPOSES, and this specific job
//            (the Worker job id in params.jobId). One job exists per Worker
//            jobId (server-verified uniqueness, M2-P round 3), so the
//            binding cannot be reused for a different job. An incoming
//            nonCommercialAttested boolean is NEVER a marker — it is
//            ignored outright. A personal job without a valid signed
//            attestation is refused here, exactly like an unmarked
//            Stage 2 job. The verifier is injected by the executor
//            (opts.attestationVerifier); without one, no personal job
//            can verify — fail closed.
//   2. THE SCAN (second line, heuristic): the prompt and params are
//      scanned for credential-like patterns and for keys that carry user
//      or private media. A match is refused. The scan is a heuristic —
//      it catches obvious leaks, not a determined exfiltration — and is
//      documented as such; the marker is the real boundary. The scan
//      applies to BOTH markers: a personal job carrying an API key in
//      its prompt is refused just like a Stage 2 job is.
//
// The image rule: a Stage 2 job may carry NO image, or the single value
// params.testImage === 'synthetic' (a named synthetic fixture — the
// notebook generates or uses a test pattern, it does not receive a file).
// Any other image value — a path, URL, base64 blob, or object — is
// refused, because the executor cannot verify what it contains.

export class DataBoundaryError extends Error {
  constructor(reason) {
    super(`data boundary refusal: ${reason}`);
    this.name = 'DataBoundaryError';
    this.reason = reason;
  }
}

// Param keys that carry user-supplied or private content. Any present
// (non-null/undefined) value under one of these keys is refused.
export const FORBIDDEN_PARAM_KEYS = Object.freeze([
  'userImage',
  'userMedia',
  'userFile',
  'uploadedFile',
  'uploadedMedia',
  'uploadedImage',
  'customerContent',
  'customerMedia',
  'privateMedia',
  'privateFile',
  'confidential',
  'credentials',
  'apiKey',
  'api_key',
  'secret',
  'token',
  'password',
]);

// Credential-like patterns scanned in the prompt (and in string params).
// Heuristic only — see the module header. Each entry names what it looks
// for so a refusal can say why.
export const CREDENTIAL_PATTERNS = Object.freeze([
  { name: 'api-key-like', pattern: /\bsk-[A-Za-z0-9]{8,}/ },
  { name: 'api-key-assignment', pattern: /api[_-]?key\s*[:=]/i },
  { name: 'password-assignment', pattern: /password\s*[:=]/i },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'bearer-token', pattern: /bearer\s+[A-Za-z0-9._~+/-]{20,}/i },
]);

// The only image value a Stage 2 job may carry.
export const SYNTHETIC_IMAGE = 'synthetic';

// Check a job against the Stage 2 data boundary. Returns
// { ok: true } or { ok: false, reason }. Does not throw.
// `opts.attestationVerifier` is the (attestation, expected, opts) =>
// boolean the executor injects, bound to the API host's signing
// secrets; `opts.nowMs` injects the clock for tests. Without a
// verifier, no personal job can verify (fail closed).
export function checkStage2Safe(job, opts = {}) {
  const params = job?.params ?? {};

  // 1. The marker — one of the two lawful markers (see the module
  // header). A job with neither is refused. verifyPersonalAttestation
  // performs actual authenticity and binding checks, not field
  // comparison: the signature must authenticate under a server-held
  // signing secret, and the attestation must bind the verified
  // owner-token identifier, an explicitly selected purpose from the
  // five, and this specific job (the Worker job id, params.jobId — the
  // manager's internal job.id is a different, idempotency-derived
  // value and is NOT what the attestation binds, and is never
  // consulted here: the expected jobId is params.jobId only).
  // Uniqueness of that id is server-verified (M2-P round 3): one job
  // per Worker jobId — D1 PRIMARY KEY + conditional creation + the 409
  // on a different request under the same id at the Worker, and the
  // API's D1-record lookup before signing — so a signed attestation
  // cannot be reused for a different job. The credential scan
  // below still runs for both markers.
  const stage2Marked = params.stage2Test === true;
  const verifyAttestation = typeof opts?.attestationVerifier === 'function'
    ? opts.attestationVerifier
    : null;
  const lawfulMarker = stage2Marked || (
    params.audience === 'personal'
    && verifyAttestation !== null
    && verifyAttestation(params.personalAttestation, {
      audience: 'personal',
      ownerTokenId: params.ownerTokenId,
      purpose: NON_COMMERCIAL_PURPOSES,
      recordedPurpose: params.nonCommercialPurpose,
      jobId: params.jobId,
    }, { nowMs: opts?.nowMs })
  );
  if (!lawfulMarker) {
    return {
      ok: false,
      reason:
        'VDP-06: lawful execution marker missing — the job is not marked ' +
        'as a Stage 2 synthetic test job (params.stage2Test must be ' +
        'true) and carries no valid signed personal attestation ' +
        '(personal audience + a server-generated attestation binding ' +
        'ownerTokenId, one of the five purposes, and this job id)',
    };
  }

  // 2. Forbidden param keys.
  for (const key of FORBIDDEN_PARAM_KEYS) {
    if (params[key] !== undefined && params[key] !== null) {
      return {
        ok: false,
        reason: `params carry forbidden key "${key}" (user/private content)`,
      };
    }
  }

  // 3. The image rule.
  if (params.testImage !== undefined && params.testImage !== null) {
    if (params.testImage !== SYNTHETIC_IMAGE) {
      return {
        ok: false,
        reason:
          'params.testImage must be "synthetic" (a named test fixture) — ' +
          'no image file, path, URL or blob may be sent to a free GPU',
      };
    }
  }
  if (params.startImage !== undefined && params.startImage !== null) {
    return {
      ok: false,
      reason:
        'params.startImage is not allowed in Stage 2 — use ' +
        'params.testImage: "synthetic" for the test image',
    };
  }

  // 4. Credential-like patterns in the prompt and in string params.
  const texts = [job?.prompt ?? ''];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') texts.push(value);
    void key;
  }
  for (const text of texts) {
    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) {
        return {
          ok: false,
          reason: `text matches credential-like pattern "${name}"`,
        };
      }
    }
  }

  return { ok: true };
}

// Check a job against the boundary, throwing DataBoundaryError on refusal.
export function assertStage2Safe(job, opts = {}) {
  const result = checkStage2Safe(job, opts);
  if (!result.ok) throw new DataBoundaryError(result.reason);
  return true;
}

// Credential-pattern scan only (no Stage 2 marker, no param-key or image
// rules). Used by the FreeLLMAPI enhancement validation boundary (A4) and
// the submit-path effective-prompt scan (A5): an enhanced prompt that
// matches a credential-like pattern is rejected, and an effective prompt
// that matches one is refused at submit. Returns the matching pattern
// name, or null. Fixed names only — never the matched text.
export function scanCredentialPatterns(text) {
  if (typeof text !== 'string') return null;
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}
