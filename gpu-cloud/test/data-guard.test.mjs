// NOVA Personal GPU Cloud — Stage 2: VDP-06 data-boundary tests.
//
// The guard refuses (never warns) any job that is not a marked Stage 2
// synthetic test job, any job carrying user/private media or credentials,
// and any image other than the named 'synthetic' fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStage2Safe,
  assertStage2Safe,
  DataBoundaryError,
} from '../src/data-guard.js';
import { signPersonalAttestation, createAttestationVerifier } from '../src/api-server/attestation.js';
import { NON_COMMERCIAL_PURPOSES } from '../src/api-server/activation.js';

function job(overrides = {}) {
  const { params = {}, ...rest } = overrides;
  return {
    id: 'job-test-1',
    modelId: 'wan2.2-ti2v-5b',
    prompt: 'a synthetic test dragon flies over a test valley',
    params: { stage2Test: true, testImage: 'synthetic', ...params },
    ...rest,
  };
}

test('a marked Stage 2 synthetic job passes', () => {
  assert.deepEqual(checkStage2Safe(job()), { ok: true });
  assert.equal(assertStage2Safe(job()), true);
});

test('an unmarked job is refused', () => {
  const j = job({ params: { stage2Test: undefined } });
  delete j.params.stage2Test;
  const r = checkStage2Safe(j);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not marked as a Stage 2 synthetic test job/);
});

test('stage2Test must be exactly true (truthy is not enough)', () => {
  const r = checkStage2Safe(job({ params: { stage2Test: 'yes' } }));
  assert.equal(r.ok, false);
});

test('user media params are refused', () => {
  for (const key of ['userImage', 'userMedia', 'uploadedFile', 'customerContent', 'privateMedia']) {
    const r = checkStage2Safe(job({ params: { [key]: 'some-file-or-blob' } }));
    assert.equal(r.ok, false, `${key} should be refused`);
    assert.match(r.reason, new RegExp(`forbidden key "${key}"`));
  }
});

test('credential params are refused', () => {
  for (const key of ['apiKey', 'secret', 'token', 'password', 'credentials']) {
    const r = checkStage2Safe(job({ params: { [key]: 'x' } }));
    assert.equal(r.ok, false, `${key} should be refused`);
  }
});

test('a real image value is refused (only "synthetic" is allowed)', () => {
  for (const image of ['/home/user/photo.png', 'https://example.com/x.jpg', 'data:image/png;base64,AAAA', { url: 'x' }]) {
    const r = checkStage2Safe(job({ params: { testImage: image } }));
    assert.equal(r.ok, false, `${JSON.stringify(image)} should be refused`);
    assert.match(r.reason, /must be "synthetic"/);
  }
});

test('no image at all is allowed', () => {
  const j = job();
  delete j.params.testImage;
  assert.deepEqual(checkStage2Safe(j), { ok: true });
});

test('startImage is refused (use testImage: synthetic)', () => {
  const r = checkStage2Safe(job({ params: { startImage: 'synthetic' } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /startImage is not allowed/);
});

test('credential-like text in the prompt is refused', () => {
  const cases = [
    'my key is sk-abcdefgh12345678',
    'api_key: hunter2',
    'password=letmein',
    '-----BEGIN RSA PRIVATE KEY-----',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwx',
  ];
  for (const prompt of cases) {
    const r = checkStage2Safe(job({ prompt }));
    assert.equal(r.ok, false, `${prompt} should be refused`);
    assert.match(r.reason, /credential-like pattern/);
  }
});

test('assertStage2Safe throws DataBoundaryError with the reason', () => {
  const j = job({ params: { userImage: 'x' } });
  assert.throws(
    () => assertStage2Safe(j),
    (err) => err instanceof DataBoundaryError && /userImage/.test(err.reason),
  );
});

// -- Personal production marker (Rev 4.8 §12, M2-P round 2) ---------------
// The ONLY personal marker is a server-generated, signed attestation
// (params.personalAttestation), verified at this boundary through an
// injected verifier bound to the API host's signing secrets. An incoming
// nonCommercialAttested boolean is NEVER a marker. The credential scan
// still applies to personal jobs, exactly as to stage2Test jobs.

const TEST_SIGNING_SECRET = 'test-attestation-signing-secret';
const TEST_OWNER_TOKEN_ID = 'owner-token-v1';
const TEST_JOB_ID = 'nova-job-11111111-2222-3333-4444-555555555555';

function attestationVerifier() {
  return createAttestationVerifier({ signingSecrets: [TEST_SIGNING_SECRET], apiState: null });
}

function personalJob(overrides = {}) {
  const { params = {}, ...rest } = overrides;
  const attestation = signPersonalAttestation({
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    purpose: 'proof',
    jobId: TEST_JOB_ID,
    attestedAt: Date.now(),
  }, TEST_SIGNING_SECRET);
  return {
    id: 'job-personal-1',
    modelId: 'ltx-video-2b',
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    params: {
      audience: 'personal',
      personalAttestation: attestation,
      nonCommercialPurpose: 'proof',
      ownerTokenId: TEST_OWNER_TOKEN_ID,
      jobId: TEST_JOB_ID,
      ...params,
    },
    ...rest,
  };
}

function checkPersonal(j, verifier = attestationVerifier()) {
  return checkStage2Safe(j, { attestationVerifier: verifier });
}

test('a personal job with a valid signed attestation passes', () => {
  assert.deepEqual(checkPersonal(personalJob()), { ok: true });
  assert.equal(assertStage2Safe(personalJob(), { attestationVerifier: attestationVerifier() }), true);
  for (const purpose of NON_COMMERCIAL_PURPOSES) {
    const attestation = signPersonalAttestation({
      ownerTokenId: TEST_OWNER_TOKEN_ID,
      purpose,
      jobId: TEST_JOB_ID,
      attestedAt: Date.now(),
    }, TEST_SIGNING_SECRET);
    assert.deepEqual(
      checkPersonal(personalJob({
        params: { personalAttestation: attestation, nonCommercialPurpose: purpose },
      })),
      { ok: true },
      `purpose ${purpose} should pass`,
    );
  }
});

test('a personal job without a verifier is refused (fail closed)', () => {
  const r = checkStage2Safe(personalJob());
  assert.equal(r.ok, false);
  assert.match(r.reason, /VDP-06: lawful execution marker missing/);
});

test('the old boolean marker is dead: nonCommercialAttested alone never passes', () => {
  const j = personalJob({ params: { personalAttestation: undefined } });
  delete j.params.personalAttestation;
  j.params.nonCommercialAttested = true;
  const r = checkPersonal(j);
  assert.equal(r.ok, false);
  assert.match(r.reason, /VDP-06: lawful execution marker missing/);
});

test('a personal job with a tampered or misbound attestation is refused', () => {
  const good = signPersonalAttestation({
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    purpose: 'proof',
    jobId: TEST_JOB_ID,
    attestedAt: Date.now(),
  }, TEST_SIGNING_SECRET);
  const cases = [
    ['wrong job', { ...good, jobId: 'nova-job-99999999-8888-7777-6666-555555555555' }],
    ['wrong purpose', { ...good, purpose: 'test' }],
    ['wrong owner', { ...good, ownerTokenId: 'owner-token-v999' }],
    ['wrong signature', { ...good, signature: '0'.repeat(64) }],
    ['unsigned', (({ signature, ...rest }) => rest)(good)],
    ['wrong audience', { ...good, audience: 'public' }],
  ];
  for (const [label, attestation] of cases) {
    const r = checkPersonal(personalJob({ params: { personalAttestation: attestation } }));
    assert.equal(r.ok, false, label);
    assert.match(r.reason, /VDP-06: lawful execution marker missing/, label);
  }
  // An attestation for another job does not verify even when it is
  // itself correctly signed.
  const otherJob = signPersonalAttestation({
    ownerTokenId: TEST_OWNER_TOKEN_ID,
    purpose: 'proof',
    jobId: 'nova-job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    attestedAt: Date.now(),
  }, TEST_SIGNING_SECRET);
  assert.equal(checkPersonal(personalJob({ params: { personalAttestation: otherJob } })).ok, false);
});

test('a personal job missing any attestation fact is refused', () => {
  const missing = [
    { audience: 'public' },
    { audience: undefined },
    { nonCommercialPurpose: 'monetised-film' },
    { nonCommercialPurpose: 'learning' },
    { nonCommercialPurpose: undefined },
    { ownerTokenId: '' },
    { ownerTokenId: undefined },
    { jobId: undefined },
    { jobId: 'nova-job-00000000-0000-0000-0000-000000000000' },
  ];
  for (const params of missing) {
    const j = personalJob({ params });
    if (params.audience === undefined) delete j.params.audience;
    if (params.nonCommercialPurpose === undefined) delete j.params.nonCommercialPurpose;
    if (params.ownerTokenId === undefined) delete j.params.ownerTokenId;
    if (params.jobId === undefined) delete j.params.jobId;
    const r = checkPersonal(j);
    assert.equal(r.ok, false, `${JSON.stringify(params)} should be refused`);
    assert.match(r.reason, /VDP-06: lawful execution marker missing/);
  }
});

test('the credential scan still applies to a personal job', () => {
  const r = checkPersonal(personalJob({ prompt: 'api_key: hunter2' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential-like pattern/);
  const r2 = checkPersonal(personalJob({ params: { userImage: 'photo.png' } }));
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /forbidden key "userImage"/);
});

test('the credential scan still applies to a stage2Test job (both markers)', () => {
  const r = checkStage2Safe(job({ prompt: 'password=letmein' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential-like pattern/);
});
