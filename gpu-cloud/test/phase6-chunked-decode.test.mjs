// NOVA Personal GPU Cloud — Phase 6 Gate 4: VAE chunked-decode tests.
//
// CPU fixtures only. Frames are integer identities equal to the global
// sample-frame index, so a correct assembly is exactly [0..120] — any
// duplicate, gap, reorder, or off-by-one shows up as a failed deepEqual.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAMEWISE_DECODE_CONFIG,
  SINGLE_PASS_DECODE_CONFIG,
  assembleTiles,
  decodeModeFor,
  framewiseDecodeEngages,
  latentFramesFor,
  planTiles,
  sampleFramesFor,
} from '../src/phase6/chunked-decode.js';

// Faithful decoded tiles for the Run 10 shape (16 latent frames).
// Tile i decodes latents [i, i+1, i+2]; under the assembly's alignment a
// tile's local frame j is global sample 8i+1+j (tile 0: j). The final
// tiles are cut short by the end of the latent array: tile 14 spans
// latents [14, 15] (9 frames, values 113..121), tile 15 spans latent
// [15] alone (1 frame, value 121) and contributes nothing after the
// drop-last rule.
function run10Tiles() {
  const tiles = [[...Array(17).keys()]];
  for (let i = 1; i <= 13; i += 1) {
    tiles.push(Array.from({ length: 17 }, (_, j) => 8 * i + 1 + j));
  }
  tiles.push(Array.from({ length: 9 }, (_, j) => 113 + j));
  tiles.push([121]);
  return tiles;
}

test('latentFramesFor inverts the native frame rule and validates input', () => {
  assert.equal(latentFramesFor(121), 16);
  assert.equal(latentFramesFor(1), 1);
  assert.equal(latentFramesFor(9), 2);
  assert.equal(latentFramesFor(17), 3);
  assert.equal(sampleFramesFor(16), 121);
  assert.equal(sampleFramesFor(1), 1);
  assert.throws(() => latentFramesFor(120), /not representable/);
  assert.throws(() => latentFramesFor(0), /positive integer/);
  assert.throws(() => latentFramesFor(-8), /positive integer/);
  assert.throws(() => latentFramesFor(121.5), /positive integer/);
  assert.throws(() => latentFramesFor('121'), /positive integer/);
  assert.throws(() => sampleFramesFor(0), /positive integer/);
});

test('planTiles(16) gives 16 windows; the last tiles are cut short by the latent end', () => {
  const plan = planTiles(16);
  assert.equal(plan.length, 16);
  assert.deepEqual(plan[0], { latentStart: 0, latentCount: 3, decodedSampleFrames: 17 });
  assert.deepEqual(plan[1], { latentStart: 1, latentCount: 3, decodedSampleFrames: 17 });
  assert.deepEqual(plan[13], { latentStart: 13, latentCount: 3, decodedSampleFrames: 17 });
  // Source truth, not the naive 3-latent count: tile 14 has 2 latents,
  // tile 15 has 1 latent.
  assert.deepEqual(plan[14], { latentStart: 14, latentCount: 2, decodedSampleFrames: 9 });
  assert.deepEqual(plan[15], { latentStart: 15, latentCount: 1, decodedSampleFrames: 1 });
  for (let i = 0; i < 16; i += 1) {
    assert.equal(plan[i].latentStart, i);
  }
  assert.deepEqual(planTiles(1), [{ latentStart: 0, latentCount: 1, decodedSampleFrames: 1 }]);
  assert.deepEqual(planTiles(2), [
    { latentStart: 0, latentCount: 2, decodedSampleFrames: 9 },
    { latentStart: 1, latentCount: 1, decodedSampleFrames: 1 },
  ]);
  assert.throws(() => planTiles(0), /positive integer/);
});

test('framewise decode engages only above 2 latent frames (native _decode gate)', () => {
  assert.equal(framewiseDecodeEngages(2), false);
  assert.equal(framewiseDecodeEngages(3), true);
  assert.equal(framewiseDecodeEngages(16), true);
  assert.throws(() => framewiseDecodeEngages(0), /positive integer/);
});

test('121-frame / 16-latent assembly is exactly [0..120]: no duplicates, no gaps', () => {
  const tiles = run10Tiles();
  const expectedLengths = planTiles(16).map((t) => t.decodedSampleFrames);
  const before = structuredClone(tiles);
  const out = assembleTiles(tiles, {
    numSampleFrames: 121,
    expectedTileLengths: expectedLengths,
    expectedLastFrame: 120,
  });
  assert.equal(out.length, 121);
  assert.deepEqual(out, Array.from({ length: 121 }, (_, i) => i));
  assert.equal(out[0], 0);
  assert.equal(out[120], 120);
  // No boundary duplicates or gaps: the sequence is exactly consecutive.
  for (let i = 1; i < out.length; i += 1) {
    assert.equal(out[i], out[i - 1] + 1, `gap or duplicate at index ${i}`);
  }
  // The last tile contributes nothing (its single frame is dropped), and
  // the final sample frame comes from tile 14.
  assert.deepEqual(tiles, before, 'assembleTiles must not mutate its inputs');
});

test('small case: 2 latent frames assemble to 9 with the last tile dropping to empty', () => {
  const out = assembleTiles([[0, 1, 2, 3, 4, 5, 6, 7, 8], [9]], {
    numSampleFrames: 9,
    expectedTileLengths: [9, 1],
    expectedLastFrame: 8,
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('overlap is trimmed exactly once: boundary frames appear a single time', () => {
  // 3 latent frames, identity tiles: tile 1 covers globals 9..25, tile 2
  // covers 17..33. The overlap region (9..16) must appear once, as the
  // blended values — and with equal decodes the blend is the identity.
  const tiles = [
    Array.from({ length: 17 }, (_, j) => j),
    Array.from({ length: 17 }, (_, j) => 9 + j),
    Array.from({ length: 17 }, (_, j) => 17 + j),
  ];
  const out = assembleTiles(tiles, { numSampleFrames: 17 });
  assert.deepEqual(out, Array.from({ length: 17 }, (_, i) => i));
});

test('blend is a linear cross-fade over 8 frames against the previous tile tail', () => {
  // Distinct values on each side so the blend is observable: tile 0 tail
  // is 9..16, tile 1 head is 100..107.
  const tiles = [
    Array.from({ length: 17 }, (_, j) => j),
    Array.from({ length: 17 }, (_, j) => 100 + j),
    Array.from({ length: 17 }, (_, j) => 200 + j),
  ];
  const out = assembleTiles(tiles, { numSampleFrames: 17 });
  assert.equal(out.length, 17);
  // First tile untouched: keeps [:9].
  assert.deepEqual(out.slice(0, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // Blended head: blended[x] = (9+x)*(1-x/8) + (100+x)*(x/8).
  assert.equal(out[9], 9); // x=0: fully the previous tile's tail
  assert.ok(Math.abs(out[10] - (10 * 0.875 + 101 * 0.125)) < 1e-9);
  assert.ok(Math.abs(out[13] - (13 * 0.5 + 104 * 0.5)) < 1e-9);
  assert.ok(Math.abs(out[16] - (16 * 0.125 + 107 * 0.875)) < 1e-9); // x=7
  // Monotone cross-fade from the previous tile towards the new tile.
  for (let x = 1; x < 8; x += 1) {
    assert.ok(out[9 + x] > out[9 + x - 1], `blend must rise at offset ${x}`);
  }
});

test('malformed tile input throws instead of silently padding or truncating', () => {
  const good = run10Tiles();
  assert.throws(() => assembleTiles([], { numSampleFrames: 121 }), /non-empty array/);
  assert.throws(() => assembleTiles('nope', { numSampleFrames: 121 }), /non-empty array/);
  assert.throws(() => assembleTiles([[]], { numSampleFrames: 1 }), /non-empty array/);
  assert.throws(() => assembleTiles([[0, 1], 'bad'], { numSampleFrames: 3 }), /must be a non-empty array/);
  // Short assembly: 3 frames offered for 9 expected — never pad.
  assert.throws(
    () => assembleTiles([[0, 1, 2]], { numSampleFrames: 9 }),
    /fewer than the expected 9/,
  );
  // Wrong per-tile length against the plan.
  assert.throws(
    () =>
      assembleTiles(good, {
        numSampleFrames: 121,
        expectedTileLengths: planTiles(16).map((t) => t.decodedSampleFrames + 1),
      }),
    /expected 18 for its latent window/,
  );
  assert.throws(
    () => assembleTiles(good, { numSampleFrames: 121, expectedLastFrame: 119 }),
    /does not match the expected last frame/,
  );
  // Non-numeric frames in a blend region cannot be cross-faded.
  assert.throws(
    () =>
      assembleTiles(
        [Array.from({ length: 17 }, (_, j) => j), Array(17).fill('x')],
        { numSampleFrames: 17 },
      ),
    /must be finite numbers/,
  );
  assert.throws(() => assembleTiles([[0]], { numSampleFrames: 0 }), /positive integer/);
});

test('decodeModeFor follows the framewiseDecode flag, defaulting to single-pass', () => {
  assert.equal(decodeModeFor(), 'single-pass');
  assert.equal(decodeModeFor({}), 'single-pass');
  assert.equal(decodeModeFor({ framewiseDecode: false }), 'single-pass');
  assert.equal(decodeModeFor({ framewiseDecode: true }), 'framewise');
  assert.equal(decodeModeFor({ flags: { framewiseDecode: true } }), 'framewise');
  assert.equal(decodeModeFor({ flags: { framewiseDecode: false } }), 'single-pass');
  assert.throws(() => decodeModeFor({ framewiseDecode: 'yes' }), /must be a boolean/);
});

test('decode configs record the native mode exactly and are frozen', () => {
  assert.deepEqual(FRAMEWISE_DECODE_CONFIG, {
    method: 'native-framewise',
    vaeClass: 'AutoencoderKLLTXVideo',
    diffusers: '0.40.0',
    enablement:
      'direct attribute assignment pipe.vae.use_framewise_decoding = true ' +
      '(no public enable method in 0.40.0)',
    tileSampleMinNumFrames: 16,
    tileSampleStrideNumFrames: 8,
    blendNumFrames: 8,
    temporalCompressionRatio: 8,
    spatialTilingEnabled: false,
    tileLatentMinNumFrames: 2,
    tileLatentStrideNumFrames: 1,
    tileLatentCount: 3,
    pipelinePath: 'output_type="latent" + vae.decode with use_framewise_decoding set',
    vramSavingVerified: false,
    vramSavingNote:
      'No GPU available in this environment; the VRAM saving of framewise ' +
      'decode is unproven until an authorised GPU comparison measures it.',
  });
  assert.equal(FRAMEWISE_DECODE_CONFIG.spatialTilingEnabled, false);
  assert.equal(SINGLE_PASS_DECODE_CONFIG.method, 'single-pass');
  assert.equal(SINGLE_PASS_DECODE_CONFIG.vaeClass, 'AutoencoderKLLTXVideo');
  assert.ok(Object.isFrozen(FRAMEWISE_DECODE_CONFIG));
  assert.ok(Object.isFrozen(SINGLE_PASS_DECODE_CONFIG));
});
