// NOVA Personal GPU Cloud — server-generated personal attestation tests
// (M2-P round 2).
//
// The attestation is a trusted, server-generated, authenticated
// assertion: signed with a server-held signing key, binding the verified
// owner-token identifier, the explicitly selected purpose, and the
// specific job. verifyPersonalAttestation performs actual authenticity
// and binding checks — not field comparison. No live GPU, no real
// secret: all keys here are test-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ATTESTATION_VERSION,
  ATTESTATION_VALIDITY_MS,
  signPersonalAttestation,
  verifyPersonalAttestation,
  createAttestationVerifier,
} from '../src/api-server/attestation.js';
import { NON_COMMERCIAL_PURPOSES } from '../src/api-server/activation.js';

const SIGNING = 'test-attestation-signing-secret';
const PREVIOUS = 'test-attestation-previous-secret';
const OWNER_TOKEN_ID = 'owner-token-v1';
const JOB_ID = 'nova-job-11111111-2222-3333-4444-555555555555';
const NOW = Date.now();

function fields(overrides = {}) {
  return {
    ownerTokenId: OWNER_TOKEN_ID,
    purpose: 'proof',
    jobId: JOB_ID,
    attestedAt: NOW,
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    ownerTokenId: OWNER_TOKEN_ID,
    purpose: NON_COMMERCIAL_PURPOSES,
    recordedPurpose: 'proof',
    jobId: JOB_ID,
    ...overrides,
  };
}

test('a signed attestation verifies against the expected binding', () => {
  const attestation = signPersonalAttestation(fields(), SIGNING);
  assert.equal(attestation.version, ATTESTATION_VERSION);
  assert.equal(attestation.audience, 'personal');
  assert.equal(attestation.ownerTokenId, OWNER_TOKEN_ID);
  assert.equal(attestation.purpose, 'proof');
  assert.equal(attestation.jobId, JOB_ID);
  assert.equal(attestation.attestedAt, NOW);
  assert.equal(attestation.nonCommercial, true);
  assert.match(attestation.signature, /^[0-9a-f]{64}$/);
  assert.equal(
    verifyPersonalAttestation(attestation, expected(), [SIGNING], { nowMs: NOW }),
    true,
  );
});

test('signing rejects invalid inputs (no malformed attestation is ever produced)', () => {
  assert.throws(() => signPersonalAttestation(fields({ ownerTokenId: '' }), SIGNING), /ownerTokenId/);
  assert.throws(() => signPersonalAttestation(fields({ purpose: 'monetised-film' }), SIGNING), /purpose/);
  assert.throws(() => signPersonalAttestation(fields({ purpose: 'learning' }), SIGNING), /purpose/);
  assert.throws(() => signPersonalAttestation(fields({ jobId: '' }), SIGNING), /jobId/);
  assert.throws(() => signPersonalAttestation(fields({ attestedAt: 1.5 }), SIGNING), /attestedAt/);
  assert.throws(() => signPersonalAttestation(fields(), ''), /signing secret/);
  // All five purposes sign.
  for (const purpose of NON_COMMERCIAL_PURPOSES) {
    const a = signPersonalAttestation(fields({ purpose }), SIGNING);
    assert.equal(
      verifyPersonalAttestation(a, expected({ recordedPurpose: purpose }), [SIGNING], { nowMs: NOW }),
      true,
      `purpose ${purpose} should verify`,
    );
  }
});

test('verification fails when any binding field is wrong', () => {
  const attestation = signPersonalAttestation(fields(), SIGNING);
  const cases = [
    ['wrong owner', expected({ ownerTokenId: 'owner-token-v999' })],
    ['wrong job', expected({ jobId: 'nova-job-99999999-8888-7777-6666-555555555555' })],
    ['wrong purpose', expected({ recordedPurpose: 'test' })],
    ['purpose list without the attestation purpose', expected({ purpose: ['test', 'benchmark'] })],
    ['missing owner', expected({ ownerTokenId: undefined })],
    ['missing job', expected({ jobId: undefined })],
  ];
  for (const [label, exp] of cases) {
    assert.equal(
      verifyPersonalAttestation(attestation, exp, [SIGNING], { nowMs: NOW }),
      false,
      label,
    );
  }
  // An attestation cannot be reused for another job: re-signing is the
  // only way to bind a different job id.
  const other = signPersonalAttestation(fields({ jobId: 'nova-job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), SIGNING);
  assert.equal(
    verifyPersonalAttestation(other, expected(), [SIGNING], { nowMs: NOW }),
    false,
  );
});

test('verification fails on a tampered attestation', () => {
  const attestation = signPersonalAttestation(fields(), SIGNING);
  for (const tampered of [
    { ...attestation, purpose: 'test' },
    { ...attestation, ownerTokenId: 'owner-token-v2' },
    { ...attestation, jobId: 'nova-job-00000000-0000-0000-0000-000000000000' },
    { ...attestation, attestedAt: attestation.attestedAt + 1000 },
    { ...attestation, nonCommercial: false },
    { ...attestation, version: 2 },
    { ...attestation, audience: 'public' },
    { ...attestation, signature: '0'.repeat(64) },
    // Flip the last signature character to a DIFFERENT hex digit —
    // a blind slice+append of '0' is a no-op (and a false pass) when
    // the signature already ends in '0'.
    { ...attestation, signature: attestation.signature.slice(0, 63) + (attestation.signature[63] === '0' ? '1' : '0') },
  ]) {
    assert.equal(
      verifyPersonalAttestation(tampered, expected(), [SIGNING], { nowMs: NOW }),
      false,
      JSON.stringify({ purpose: tampered.purpose, jobId: tampered.jobId }),
    );
  }
});

test('verification fails without a signing secret, or with the wrong secret', () => {
  const attestation = signPersonalAttestation(fields(), SIGNING);
  assert.equal(verifyPersonalAttestation(attestation, expected(), [], { nowMs: NOW }), false);
  assert.equal(verifyPersonalAttestation(attestation, expected(), ['wrong-secret'], { nowMs: NOW }), false);
  assert.equal(verifyPersonalAttestation(attestation, expected(), [''], { nowMs: NOW }), false);
  // The previous secret verifies during rotation overlap.
  const fromPrevious = signPersonalAttestation(fields(), PREVIOUS);
  assert.equal(
    verifyPersonalAttestation(fromPrevious, expected(), [SIGNING, PREVIOUS], { nowMs: NOW }),
    true,
  );
});

test('a revoked signing secret does not verify (revocation overrides rotation)', () => {
  const attestation = signPersonalAttestation(fields(), SIGNING);
  // isRevoked is consulted by fingerprint: revoke the signing secret's
  // fingerprint and the attestation must fail even though the secret is
  // configured.
  const fingerprint = createHash('sha256').update(SIGNING, 'utf8').digest('hex');
  const isRevoked = (fp) => fp === fingerprint;
  assert.equal(
    verifyPersonalAttestation(attestation, expected(), [SIGNING], { nowMs: NOW, isRevoked }),
    false,
  );
  // The same attestation verifies when nothing is revoked.
  assert.equal(
    verifyPersonalAttestation(attestation, expected(), [SIGNING], { nowMs: NOW, isRevoked: () => false }),
    true,
  );
});

test('freshness: a future or stale attestation does not verify', () => {
  const future = signPersonalAttestation(fields({ attestedAt: NOW + 120 * 1000 }), SIGNING);
  assert.equal(verifyPersonalAttestation(future, expected(), [SIGNING], { nowMs: NOW }), false);
  const stale = signPersonalAttestation(fields({ attestedAt: NOW - ATTESTATION_VALIDITY_MS - 1000 }), SIGNING);
  assert.equal(verifyPersonalAttestation(stale, expected(), [SIGNING], { nowMs: NOW }), false);
  // Just inside the window still verifies.
  const old = signPersonalAttestation(fields({ attestedAt: NOW - ATTESTATION_VALIDITY_MS + 60 * 1000 }), SIGNING);
  assert.equal(verifyPersonalAttestation(old, expected(), [SIGNING], { nowMs: NOW }), true);
  // A non-integer attestedAt never verifies.
  const attestation = signPersonalAttestation(fields(), SIGNING);
  assert.equal(
    verifyPersonalAttestation({ ...attestation, attestedAt: 1.5 }, expected(), [SIGNING], { nowMs: NOW }),
    false,
  );
});

test('a bare boolean is not an attestation (the old marker is dead)', () => {
  assert.equal(verifyPersonalAttestation(true, expected(), [SIGNING], { nowMs: NOW }), false);
  assert.equal(verifyPersonalAttestation(null, expected(), [SIGNING], { nowMs: NOW }), false);
  assert.equal(verifyPersonalAttestation(undefined, expected(), [SIGNING], { nowMs: NOW }), false);
  // An unsigned object with the right fields but no signature fails.
  const unsigned = {
    version: 1,
    audience: 'personal',
    ownerTokenId: OWNER_TOKEN_ID,
    purpose: 'proof',
    jobId: JOB_ID,
    attestedAt: NOW,
    nonCommercial: true,
  };
  assert.equal(verifyPersonalAttestation(unsigned, expected(), [SIGNING], { nowMs: NOW }), false);
});

test('createAttestationVerifier binds the secrets and the revocation record', async () => {
  const { ApiStateStore } = await import('../src/api-server/state-store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-attestation-'));
  try {
    const apiState = new ApiStateStore(path.join(dir, 'api-state.json'));
    const verifier = createAttestationVerifier({ signingSecrets: [SIGNING, PREVIOUS], apiState });
    const attestation = signPersonalAttestation(fields(), SIGNING);
    assert.equal(verifier(attestation, expected(), { nowMs: NOW }), true);
    // Revoking the signing secret through the store kills verification.
    const { revokeSecret } = await import('../src/api-server/revocation.js');
    revokeSecret({ apiState, secret: SIGNING, revokedBy: 'test', reason: 'rotation' });
    assert.equal(verifier(attestation, expected(), { nowMs: NOW }), false);
    // An attestation signed with the (unrevoked) previous secret still
    // verifies after the current secret is revoked.
    const fromPrevious = signPersonalAttestation(fields(), PREVIOUS);
    assert.equal(verifier(fromPrevious, expected(), { nowMs: NOW }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
