// NOVA Personal GPU Cloud — Phase 6 Workstream B: VAE chunked decode.
//
// A faithful JavaScript port of the ASSEMBLY rules of diffusers 0.40.0
// `AutoencoderKLLTXVideo._temporal_tiled_decode` (see /tmp/ltx_vae.py,
// verified against the pinned source), operating on decoded frame arrays.
// Frames here are plain numeric values (in tests: integer frame identities
// equal to the global sample-frame index). The blend step is real numeric
// arithmetic, so frames in a blend region must be finite numbers.
//
// HOW THE NATIVE MODE WORKS (diffusers 0.40.0, LTX VAE)
// -------------------------------------------------------
// * `use_framewise_decoding` defaults to False and has NO public enable
//   method in 0.40.0 — it is set by direct attribute assignment:
//   `pipe.vae.use_framewise_decoding = True`. (`enable_tiling()` only sets
//   spatial `use_tiling`.)
// * `_decode` routes to `_temporal_tiled_decode` only when
//   `use_framewise_decoding` is set AND latent frames > 2
//   (`tile_sample_min_num_frames // temporal_compression_ratio`).
// * Latent stride = 8 // 8 = 1 latent frame; each tile spans 3 latent
//   frames (`tile_sample_min_num_frames // 8 + 1`); each tile decodes to
//   (latentCount - 1) * 8 + 1 sample frames.
// * Every tile after the first drops its LAST decoded frame.
// * The overlap is blended with `blend_t`: the new tile's first 8 frames
//   are a linear cross-fade against the previous (post-drop) tile's last
//   8 frames:  blended[x] = prev[x] * (1 - x/8) + cur[x] * (x/8).
// * First tile keeps [:9] sample frames, later tiles keep [:8]; the
//   concatenated result is truncated to num_sample_frames.
// * `use_slicing` (batch slicing) only applies when batch > 1, so it is
//   useless for batch=1 jobs. Spatial tiling is NOT enabled by the
//   framewise config (see FRAMEWISE_DECODE_CONFIG).
//
// DEVIATION FROM THE HANDOVER BRIEF — READ THIS
// ----------------------------------------------
// The brief asserted the 121-frame / 16-latent case assembles
// "9 + 8*15 = 129 sample frames, truncated to 121". That is the NAIVE
// count, assuming every tile decodes to 17 frames. The pinned source
// contradicts it: a tile is `z[:, :, i : i + 3]`, so the LAST tiles are
// cut short by the end of the latent array — tile 14 spans latents
// [14, 15] (2 latents -> 9 sample frames) and tile 15 spans latent [15]
// alone (1 latent -> 1 sample frame, confirmed by the decoder's temporal
// upsampler: L latent frames -> 8L - 7 sample frames). After the
// drop-last rule tile 15 contributes ZERO frames, and the assembled total
// is exactly 9 + 8*13 + 8 + 0 = 121 — the source's final truncation is a
// no-op for this case, and the last real sample frame (120) is supplied
// by tile 14, not tile 15. This module implements the SOURCE behaviour:
// planTiles() reports the true per-tile latent counts and decoded
// lengths, and assembleTiles() validates the exact final count.
//
// A second consequence: the assembled last frame is a BLENDED value (the
// final contributing tile's kept frames all lie inside its blend region),
// so it cannot in general be checked for strict equality against a raw
// input frame. assembleTiles() therefore validates the first frame
// strictly, and checks the last frame only against an explicit
// `expectedLastFrame` when the caller supplies one.
//
// GPU VERIFICATION STATUS: no GPU is available in this environment, so
// the actual VRAM saving of framewise decode is EXPLICITLY UNPROVEN.
// Nothing here claims a measured memory reduction.
//
// Pure functions only: no I/O, no GPU, no network, no mutation of inputs.

export const TEMPORAL_COMPRESSION_RATIO = 8;
export const TILE_SAMPLE_MIN_NUM_FRAMES = 16;
export const TILE_SAMPLE_STRIDE_NUM_FRAMES = 8;
export const BLEND_NUM_FRAMES = 8;

// Latent-frame view of the same constants (each is the sample-frame
// value divided by the temporal compression ratio of 8).
export const TILE_LATENT_MIN_NUM_FRAMES = 2;
export const TILE_LATENT_STRIDE_NUM_FRAMES = 1;
// A tile spans tile_latent_min_num_frames + 1 latent frames.
export const TILE_LATENT_COUNT = 3;

// Framewise decode engages in the native `_decode` only when the latent
// frame count exceeds tile_latent_min_num_frames (2).
export const FRAMEWISE_MIN_LATENT_FRAMES = TILE_LATENT_MIN_NUM_FRAMES;

// The native framewise configuration, recorded exactly as pinned.
export const FRAMEWISE_DECODE_CONFIG = Object.freeze({
  method: 'native-framewise',
  vaeClass: 'AutoencoderKLLTXVideo',
  diffusers: '0.40.0',
  enablement:
    'direct attribute assignment pipe.vae.use_framewise_decoding = true ' +
    '(no public enable method in 0.40.0)',
  tileSampleMinNumFrames: TILE_SAMPLE_MIN_NUM_FRAMES,
  tileSampleStrideNumFrames: TILE_SAMPLE_STRIDE_NUM_FRAMES,
  blendNumFrames: BLEND_NUM_FRAMES,
  temporalCompressionRatio: TEMPORAL_COMPRESSION_RATIO,
  spatialTilingEnabled: false,
  // Latent-frame view, derived from the sample-frame values above.
  tileLatentMinNumFrames: TILE_LATENT_MIN_NUM_FRAMES,
  tileLatentStrideNumFrames: TILE_LATENT_STRIDE_NUM_FRAMES,
  tileLatentCount: TILE_LATENT_COUNT,
  // How the chunked path is reached in the pipeline (ltx_pipeline.py):
  // `pipe(..., output_type="latent")` returns latents instead of decoding
  // (line 814); otherwise `self.vae.decode(latents, timestep)` decodes
  // everything at once (line 848).
  pipelinePath: 'output_type="latent" + vae.decode with use_framewise_decoding set',
  // GPU verification of the actual VRAM saving is NOT possible here.
  vramSavingVerified: false,
  vramSavingNote:
    'No GPU available in this environment; the VRAM saving of framewise ' +
    'decode is unproven until an authorised GPU comparison measures it.',
});

// The baseline as Run 10 actually ran: one vae.decode of all latents.
export const SINGLE_PASS_DECODE_CONFIG = Object.freeze({
  method: 'single-pass',
  vaeClass: 'AutoencoderKLLTXVideo',
  diffusers: '0.40.0',
  enablement: 'default pipeline path (no framewise flag set)',
  decode: 'one vae.decode call over all latents at once',
  note: 'Run 10 as run: 121 frames decoded in a single pass; peak VRAM 12.64 GiB.',
});

// Number of latent frames for a sample-frame count, per the native rule
// num_sample_frames = (num_latent_frames - 1) * 8 + 1, inverted.
// Only frame counts with (n - 1) % 8 === 0 are representable.
export function latentFramesFor(numFrames) {
  if (!Number.isInteger(numFrames) || numFrames < 1) {
    throw new Error(`numFrames must be a positive integer, got ${numFrames}`);
  }
  if ((numFrames - 1) % TEMPORAL_COMPRESSION_RATIO !== 0) {
    throw new Error(
      `numFrames ${numFrames} is not representable: (numFrames - 1) must be ` +
        `a multiple of ${TEMPORAL_COMPRESSION_RATIO}`,
    );
  }
  return (numFrames - 1) / TEMPORAL_COMPRESSION_RATIO + 1;
}

// Sample frames for a latent-frame count (the native forward rule).
export function sampleFramesFor(numLatentFrames) {
  if (!Number.isInteger(numLatentFrames) || numLatentFrames < 1) {
    throw new Error(`numLatentFrames must be a positive integer, got ${numLatentFrames}`);
  }
  return (numLatentFrames - 1) * TEMPORAL_COMPRESSION_RATIO + 1;
}

// Whether the native `_decode` would route to `_temporal_tiled_decode`
// for this latent count (flag assumed set): num_frames > 2.
export function framewiseDecodeEngages(numLatentFrames) {
  if (!Number.isInteger(numLatentFrames) || numLatentFrames < 1) {
    throw new Error(`numLatentFrames must be a positive integer, got ${numLatentFrames}`);
  }
  return numLatentFrames > FRAMEWISE_MIN_LATENT_FRAMES;
}

// The tile windows of the native loop
// `for i in range(0, num_frames, tile_latent_stride_num_frames)` with
// `tile = z[:, :, i : i + tile_latent_min_num_frames + 1]`, i.e. each tile
// starts 1 latent frame after the previous and spans up to 3 latent
// frames; the final tiles are cut short by the end of the latent array.
// decodedSampleFrames is what the decoder yields for that latent count:
// (latentCount - 1) * 8 + 1.
export function planTiles(numLatentFrames) {
  if (!Number.isInteger(numLatentFrames) || numLatentFrames < 1) {
    throw new Error(`numLatentFrames must be a positive integer, got ${numLatentFrames}`);
  }
  const tiles = [];
  for (let i = 0; i < numLatentFrames; i += TILE_LATENT_STRIDE_NUM_FRAMES) {
    const latentCount = Math.min(TILE_LATENT_COUNT, numLatentFrames - i);
    tiles.push({
      latentStart: i,
      latentCount,
      decodedSampleFrames: (latentCount - 1) * TEMPORAL_COMPRESSION_RATIO + 1,
    });
  }
  return tiles;
}

// Select the decode mode from the feature flags object. The flag name
// matches the Phase 6 flags in ./config.js (framewiseDecode, default
// false). Accepts either `{ framewiseDecode }` or `{ flags: { framewiseDecode } }`.
export function decodeModeFor(config = {}) {
  const flags = config ?? {};
  const value = flags.framewiseDecode ?? flags.flags?.framewiseDecode ?? false;
  if (typeof value !== 'boolean') {
    throw new Error(`framewiseDecode flag must be a boolean, got ${typeof value}`);
  }
  return value ? 'framewise' : 'single-pass';
}

// Linear cross-fade of `cur`'s first `blend` frames against `prev`'s last
// `blend` frames, exactly as `blend_t` in the pinned source:
//   blended[x] = prevTail[x] * (1 - x/blend) + cur[x] * (x/blend)
// for x in 0..blend-1. Returns a NEW array; neither input is mutated.
// Frames in the blend region must be finite numbers (blend is arithmetic).
function blendOverlap(prevTile, curTile, blend) {
  const extent = Math.min(prevTile.length, curTile.length, blend);
  const out = curTile.slice();
  for (let x = 0; x < extent; x += 1) {
    const a = prevTile[prevTile.length - extent + x];
    const b = curTile[x];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error(
        `blend region frames must be finite numbers, got ${a} and ${b} at offset ${x}`,
      );
    }
    out[x] = a * (1 - x / extent) + b * (x / extent);
  }
  return out;
}

// Assemble decoded per-tile frame arrays into the full video, applying
// the native `_temporal_tiled_decode` rules exactly:
//   1. Every tile after the first drops its last decoded frame.
//   2. Each later tile's head is blended against the previous
//      (post-drop) tile's tail over blendNumFrames.
//   3. The first tile keeps [:stride+1] sample frames; later tiles keep
//      [:stride].
//   4. The concatenation is truncated to numSampleFrames (the source's
//      own final slice; a no-op when the tiles are faithful — see the
//      header note — and never used to hide a short assembly).
// Validation is fail-closed: any violation throws, never silently pads
// or invents frames.
//   - tiles must be a non-empty array of non-empty arrays.
//   - when `expectedTileLengths` is supplied, each tile's length must
//     match exactly (pass planTiles().map(t => t.decodedSampleFrames)).
//   - the assembled length before truncation must be >= numSampleFrames;
//     a short assembly throws (missing frames).
//   - after truncation the length must equal numSampleFrames exactly.
//   - the first assembled frame must strictly equal tiles[0][0].
//   - when `expectedLastFrame` is supplied, the last assembled frame must
//     strictly equal it. (No unconditional last-frame check is possible:
//     the final contributing tile's kept frames are all blended values,
//     and the final tile may contribute nothing at all — see header.)
export function assembleTiles(tiles, options = {}) {
  const { numSampleFrames, expectedTileLengths, expectedLastFrame } = options;
  if (!Array.isArray(tiles) || tiles.length === 0) {
    throw new Error('tiles must be a non-empty array of decoded frame arrays');
  }
  if (!Number.isInteger(numSampleFrames) || numSampleFrames < 1) {
    throw new Error(`numSampleFrames must be a positive integer, got ${numSampleFrames}`);
  }
  if (expectedTileLengths !== undefined) {
    if (!Array.isArray(expectedTileLengths) || expectedTileLengths.length !== tiles.length) {
      throw new Error(
        `expectedTileLengths must have one entry per tile (${tiles.length}), ` +
          `got ${expectedTileLengths?.length}`,
      );
    }
    for (let i = 0; i < tiles.length; i += 1) {
      if (!Array.isArray(tiles[i])) {
        throw new Error(`tile ${i} must be an array of decoded frames`);
      }
      if (tiles[i].length !== expectedTileLengths[i]) {
        throw new Error(
          `tile ${i} has ${tiles[i].length} decoded frames, expected ` +
            `${expectedTileLengths[i]} for its latent window`,
        );
      }
    }
  }
  for (let i = 0; i < tiles.length; i += 1) {
    if (!Array.isArray(tiles[i]) || tiles[i].length === 0) {
      throw new Error(`tile ${i} must be a non-empty array of decoded frames`);
    }
  }

  const stride = TILE_SAMPLE_STRIDE_NUM_FRAMES;
  const blend = BLEND_NUM_FRAMES;

  // Step 1: drop the last decoded frame of every tile after the first.
  const postDrop = tiles.map((tile, i) => (i > 0 ? tile.slice(0, -1) : tile.slice()));

  // Steps 2-3: blend each later tile against the previous post-drop tile,
  // then keep [:stride+1] for the first tile, [:stride] for later tiles.
  const kept = [];
  for (let i = 0; i < postDrop.length; i += 1) {
    if (i === 0) {
      kept.push(postDrop[0].slice(0, stride + 1));
    } else {
      const blended = blendOverlap(postDrop[i - 1], postDrop[i], blend);
      kept.push(blended.slice(0, stride));
    }
  }

  // Step 4: concatenate, then the source's final truncation.
  const assembled = kept.flat();
  if (assembled.length < numSampleFrames) {
    throw new Error(
      `assembled ${assembled.length} frames, fewer than the expected ` +
        `${numSampleFrames}: refusing to pad a short decode`,
    );
  }
  const result = assembled.slice(0, numSampleFrames);

  if (result.length !== numSampleFrames) {
    throw new Error(
      `assembled ${result.length} frames, expected exactly ${numSampleFrames}`,
    );
  }
  if (result[0] !== tiles[0][0]) {
    throw new Error(
      `first assembled frame ${result[0]} does not match the first input frame ${tiles[0][0]}`,
    );
  }
  if (expectedLastFrame !== undefined && result[result.length - 1] !== expectedLastFrame) {
    throw new Error(
      `last assembled frame ${result[result.length - 1]} does not match ` +
        `the expected last frame ${expectedLastFrame}`,
    );
  }
  return result;
}
