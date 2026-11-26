// NOVA Personal GPU Cloud — Fun-InP adapter contract tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUN_INP_ENGINE_ID,
  FUN_INP_PROOF,
  FUN_INP_INTERFACE,
  buildJobSpec,
  buildConditioning,
  validateSpec,
} from '../src/engines/fun-inp.js';

const KEY_A = 'e'.repeat(64);
const KEY_B = 'c'.repeat(64);

function validInput(overrides = {}) {
  return {
    prompt: 'a dragon on a ridge at dawn',
    firstKeyframeHash: KEY_A,
    lastKeyframeHash: KEY_B,
    ...overrides,
  };
}

test('buildJobSpec fills the proof defaults (LTX run-4 comparability)', () => {
  const spec = buildJobSpec({
    firstKeyframeHash: KEY_A,
    lastKeyframeHash: KEY_B,
  });
  assert.equal(spec.engineId, FUN_INP_ENGINE_ID);
  assert.equal(spec.prompt, FUN_INP_PROOF.prompt);
  assert.equal(spec.frames, 17);
  assert.equal(spec.height, 576);
  assert.equal(spec.width, 1024);
  assert.equal(spec.steps, 50);
  assert.equal(spec.guidanceScale, 6.0);
  assert.equal(spec.seed, 42);
  assert.equal(spec.weightDtype, 'float16');
  assert.equal(spec.scheduler, 'FlowMatchEulerDiscreteScheduler');
  assert.equal(spec.pipeline, FUN_INP_PROOF.pipeline);
  assert.ok(Object.isFrozen(spec));
});

test('validateSpec rejects a frame count Wan cannot encode', () => {
  // Wan requires (frames - 1) divisible by 4.
  const bad = { ...validInput(), frames: 16, firstKeyframeHash: KEY_A, lastKeyframeHash: KEY_B };
  assert.equal(validateSpec({ ...buildJobSpec(validInput()), frames: 16 }).ok, false);
  assert.match(
    validateSpec({ ...buildJobSpec(validInput()), frames: 16 }).errors.join(' '),
    /divisible by 4/,
  );
  assert.throws(() => buildJobSpec(bad), /frames/);
});

test('validateSpec enforces FP16 as the only weight dtype', () => {
  const spec = buildJobSpec(validInput());
  assert.equal(validateSpec({ ...spec, weightDtype: 'bfloat16' }).ok, false);
  assert.match(
    validateSpec({ ...spec, weightDtype: 'bfloat16' }).errors.join(' '),
    /float16/,
  );
  assert.throws(() => buildJobSpec(validInput({ weightDtype: 'float32' })), /float16/);
});

test('validateSpec rejects bad hashes, empty prompts and out-of-range steps', () => {
  const base = buildJobSpec(validInput());
  assert.equal(validateSpec({ ...base, firstKeyframeHash: 'not-a-hash' }).ok, false);
  assert.equal(validateSpec({ ...base, prompt: '   ' }).ok, false);
  assert.equal(validateSpec({ ...base, steps: 0 }).ok, false);
  assert.equal(validateSpec({ ...base, steps: 101 }).ok, false);
  assert.equal(validateSpec({ ...base, guidanceScale: 0.5 }).ok, false);
  assert.equal(validateSpec({ ...base, height: 575 }).ok, false);
  assert.equal(validateSpec({ ...base, scheduler: 'UniPCMultistepScheduler' }).ok, false);
});

test('buildConditioning describes the first+last-frame layout', () => {
  const spec = buildJobSpec(validInput());
  const cond = buildConditioning(spec);
  assert.deepEqual(cond.videoTensor.shape, [1, 3, 17, 576, 1024]);
  assert.deepEqual(cond.maskVideo.shape, [1, 1, 17, 576, 1024]);
  assert.match(cond.videoTensor.layout, /frame 0 = first keyframe/);
  assert.match(cond.videoTensor.layout, /middle frames zero/);
  assert.match(cond.maskVideo.layout, /0 at frame 0 and frame frames-1/);
  assert.match(cond.maskVideo.layout, /255 at all middle frames/);
  assert.equal(cond.clipImage, null);
  assert.match(cond.channelOrder, /in_channels 36/);
  assert.match(cond.channelOrder, /16 noise \+ 4 mask \+ 16 masked-video/);
  assert.throws(() => buildConditioning({ frames: 16 }), /invalid/);
});

test('the interface contract names load / generate / unload', () => {
  assert.equal(typeof FUN_INP_INTERFACE.load.description, 'string');
  assert.ok(FUN_INP_INTERFACE.load.steps.length >= 4);
  assert.deepEqual(
    FUN_INP_INTERFACE.generate.parameters,
    ['prompt', 'firstKeyframe', 'lastKeyframe', 'frames', 'steps', 'guidanceScale', 'seed', 'height', 'width'],
  );
  assert.equal(typeof FUN_INP_INTERFACE.unload.description, 'string');
});
