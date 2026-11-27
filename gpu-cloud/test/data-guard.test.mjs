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

// -- Personal production marker (Rev 4.8 §12, M2-P) -------------------------
// A personal-audience job carrying the full non-commercial attestation
// is the second lawful marker: it passes the boundary, while the
// credential scan still applies. The attestation facts are verified
// upstream (Worker binds the ownerTokenId from its environment; the API
// submit path re-checks purpose + token id), so the guard checks their
// presence and shape only.

function personalJob(overrides = {}) {
  const { params = {}, ...rest } = overrides;
  return {
    id: 'job-personal-1',
    modelId: 'ltx-video-2b',
    prompt: 'A dragon rests on a misty mountain ridge at dawn',
    params: {
      audience: 'personal',
      nonCommercialAttested: true,
      nonCommercialPurpose: 'proof',
      ownerTokenId: 'owner-token-v1',
      ...params,
    },
    ...rest,
  };
}

test('a personal job with the full non-commercial attestation passes', () => {
  assert.deepEqual(checkStage2Safe(personalJob()), { ok: true });
  for (const purpose of ['test', 'proof', 'benchmark', 'experiment', 'own-non-monetised-film']) {
    assert.deepEqual(
      checkStage2Safe(personalJob({ params: { nonCommercialPurpose: purpose } })),
      { ok: true },
      `purpose ${purpose} should pass`,
    );
  }
});

test('a personal job missing any attestation fact is refused', () => {
  const missing = [
    { audience: 'public' },
    { audience: undefined },
    { nonCommercialAttested: false },
    { nonCommercialAttested: undefined },
    { nonCommercialPurpose: 'monetised-film' },
    { nonCommercialPurpose: 'learning' },
    { nonCommercialPurpose: undefined },
    { ownerTokenId: '' },
    { ownerTokenId: undefined },
  ];
  for (const params of missing) {
    const j = personalJob({ params });
    if (params.audience === undefined) delete j.params.audience;
    if (params.nonCommercialAttested === undefined) delete j.params.nonCommercialAttested;
    if (params.nonCommercialPurpose === undefined) delete j.params.nonCommercialPurpose;
    if (params.ownerTokenId === undefined) delete j.params.ownerTokenId;
    const r = checkStage2Safe(j);
    assert.equal(r.ok, false, `${JSON.stringify(params)} should be refused`);
    assert.match(r.reason, /not marked as a Stage 2 synthetic test job/);
  }
});

test('the credential scan still applies to a personal job', () => {
  const r = checkStage2Safe(personalJob({ prompt: 'api_key: hunter2' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential-like pattern/);
  const r2 = checkStage2Safe(personalJob({ params: { userImage: 'photo.png' } }));
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /forbidden key "userImage"/);
});
