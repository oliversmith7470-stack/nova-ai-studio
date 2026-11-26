// NOVA Personal GPU Cloud — Fun-InP engine-interface adapter (JS contract).
//
// Wan2.1-Fun-1.3B-InP (Alibaba PAI, Apache 2.0) — true first+last-frame
// image-to-video at 1.3B. This module is the ENGINE INTERFACE: it
// expresses load / generate(first_keyframe, last_keyframe, prompt,
// frames, steps) / unload, the FP16-required path on a Kaggle T4, and
// the exact conditioning layout the native VideoX-Fun pipeline needs.
// The live execution lives in the Kaggle notebook
// (packages/fun-inp-proof-20261125-01/fun-inp-proof.ipynb), which
// implements this contract cell by cell; this module is the contract
// the notebook is checked against.
//
// VERIFIED LOAD PATH (25 Nov 2026, before the proof):
// - Transformer + VAE + CLIP image encoder + tokenizer: diffusers
//   conversion weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers (safetensors
//   headers read: transformer 3.13 GB / 1,013 tensors ALL BF16, in_channels
//   36; VAE 0.48 GB / 194 tensors ALL F32; image_encoder 1.26 GB / 520
//   tensors ALL BF16). The conversion's text_encoder is 22.5 GB FP32 —
//   too big to download; NOT used.
// - Text encoder: umT5-XXL as transformers UMT5EncoderModel, weights
//   from Kaggle model thiminhnht/umt5-xxl-fp16 (single file
//   umt5_xxl_fp16.safetensors, 11.37 GB, 243 tensors ALL F16, keys in
//   transformers format — verified via the Kaggle API). Mounted read-only,
//   zero disk. DISCLOSED SUBSTITUTION: the native VideoX-Fun pipeline
//   expects its custom WanT5EncoderModel class; the proof loads the SAME
//   umT5-XXL weights into transformers' UMT5EncoderModel instead, because
//   the native class's parameter names differ from the checkpoint's
//   transformers-format keys and a remap could not be verified without
//   the weights in hand. Same weights, same architecture, same FP16
//   arithmetic; the native pipeline only calls
//   text_encoder(input_ids, attention_mask)[0] and reads .dtype, both
//   of which UMT5EncoderModel satisfies. The native class's fp16_clamp
//   safety net is absent in the transformers class — if inf/NaN appears
//   in the embeddings, that is a recorded finding, not a silent failure.
// - Pipeline: VideoX-Fun WanFunInpaintPipeline (native, pinned commit
//   98fffa929bb373edcbfa3620e9aa05cd65a53103, 2026-11-24). Scheduler:
//   FlowMatchEulerDiscreteScheduler (diffusers), as the ComfyUI loader
//   constructs it. weight_dtype = FP16 everywhere (transformer cast from
//   BF16 weights; VAE cast from F32; CLIP cast from BF16).
//
// FP16 is the REQUIRED path: T4 has no BF16 tensor cores, so any BF16
// parameter after load is a FAILED gate (same rule as the LTX proof).
// The proof answers one question: does Fun-InP load AND execute in FP16
// on one T4, or does it fail?

export const FUN_INP_ENGINE_ID = 'wan2.1-fun-inp-1.3b';

export const FUN_INP_REPOS = Object.freeze({
  // Native weights (official, Apache 2.0).
  nativeWeights: 'alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP',
  // Diffusers-layout conversion (transformer / VAE / CLIP / tokenizer).
  diffusersConversion: 'weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers',
  // Native pipeline + loader reference implementation.
  pipelineCode: 'aigc-apps/VideoX-Fun',
  pipelineCommit: '98fffa929bb373edcbfa3620e9aa05cd65a53103',
  pipelineCommitDate: '2026-11-24T03:20:36Z',
  // Text-encoder weights (Kaggle model mount, FP16, transformers keys).
  textEncoderKaggleModel: 'thiminhnht/umt5-xxl-fp16',
  textEncoderFile: 'umt5_xxl_fp16.safetensors',
});

export const FUN_INP_PROOF = Object.freeze({
  kernel: 'oliversmithh/nova-gpu-cloud-fun-inp-proof-20261125-01',
  package: 'packages/fun-inp-proof-20261125-01',
  // LTX run-4 prompt and keyframes, for comparability (exact run-4
  // prompt string from packages/ltx-proof-20261124-01/ltx-proof.ipynb).
  prompt:
    'An ash-grey dragon with ember-cracked wings rests on a misty mountain ridge at dawn, slow cinematic camera push-in, mist drifting across the ridge, embers glowing faintly along the dragon\'s wings, epic fantasy film still, dramatic dawn light',
  firstKeyframeHash: 'e55d8e21',
  lastKeyframeHash: 'c93a1efa',
  firstKeyframeSource: 'kaggle dataset oliversmithh/nova-ltx-proof-keyframes-20261124 (first keyframe, sha256 prefix e55d8e21)',
  lastKeyframeSource: 'kaggle dataset oliversmithh/nova-ltx-proof-keyframes-20261124 (last keyframe, sha256 prefix c93a1efa)',
  frames: 17,
  height: 576,
  width: 1024,
  steps: 50,
  guidanceScale: 6.0,
  seed: 42,
  weightDtype: 'float16',
  scheduler: 'FlowMatchEulerDiscreteScheduler',
  pipeline: 'videox_fun.pipeline.pipeline_wan_fun_inpaint.WanFunInpaintPipeline',
  // Scoped download budget (conversion transformer + VAE + CLIP + tokenizer + configs).
  downloadBudgetBytes: 5 * 1024 ** 3,
  workingDiskBytes: 20 * 1024 ** 3,
});

// The adapter interface. Each step maps to a notebook cell; the notebook
// is the live implementation of this contract.
export const FUN_INP_INTERFACE = Object.freeze({
  load: {
    description:
      'Load WanFunInpaintPipeline on one Kaggle T4 in FP16: transformer + VAE + CLIP + tokenizer from the diffusers conversion, text encoder from the Kaggle FP16 mount.',
    steps: [
      'clone VideoX-Fun at the pinned commit (sparse, videox_fun only)',
      'scoped download of conversion transformer/vae/image_encoder/tokenizer/scheduler/model_index.json (NOT text_encoder)',
      'load transformers UMT5EncoderModel from the conversion text_encoder config + Kaggle FP16 safetensors (strict, dtype audit)',
      'build WanFunInpaintPipeline with transformer/vae/CLIP cast to FP16 and FlowMatchEulerDiscreteScheduler',
      'dtype audit: zero BF16 parameters anywhere; encoder moved to CPU after embedding (LTX pattern)',
    ],
  },
  generate: {
    description:
      'First+last-frame I2V: frame 0 = first keyframe, frame N-1 = last keyframe, middle frames zero; mask_video 0 at the given frames, 255 elsewhere; clip_image None (black image, zeroed CLIP context).',
    parameters: ['prompt', 'firstKeyframe', 'lastKeyframe', 'frames', 'steps', 'guidanceScale', 'seed', 'height', 'width'],
  },
  unload: {
    description: 'Free GPU memory and record peak VRAM / host RAM; export MP4 (yuv420p) + frame strip + report JSON. No further generation in this run.',
  },
});

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec must be an object'] };
  if (typeof spec.prompt !== 'string' || spec.prompt.trim().length === 0) {
    errors.push('prompt must be a non-empty string');
  }
  if (typeof spec.firstKeyframeHash !== 'string' || !SHA256_HEX.test(spec.firstKeyframeHash)) {
    errors.push('firstKeyframeHash must be a sha256 hex string');
  }
  if (typeof spec.lastKeyframeHash !== 'string' || !SHA256_HEX.test(spec.lastKeyframeHash)) {
    errors.push('lastKeyframeHash must be a sha256 hex string');
  }
  if (!Number.isInteger(spec.frames) || spec.frames < 5 || spec.frames > 129 || (spec.frames - 1) % 4 !== 0) {
    errors.push('frames must be an integer 5..129 with (frames-1) divisible by 4 (Wan latent frame rule)');
  }
  if (!Number.isInteger(spec.steps) || spec.steps < 1 || spec.steps > 100) {
    errors.push('steps must be an integer 1..100');
  }
  if (typeof spec.guidanceScale !== 'number' || spec.guidanceScale < 1 || spec.guidanceScale > 20) {
    errors.push('guidanceScale must be a number 1..20');
  }
  if (!Number.isInteger(spec.seed) || spec.seed < 0) {
    errors.push('seed must be a non-negative integer');
  }
  for (const [name, value] of [['height', spec.height], ['width', spec.width]]) {
    if (!Number.isInteger(value) || value % 8 !== 0 || value < 256 || value > 1920) {
      errors.push(`${name} must be a multiple of 8 in 256..1920`);
    }
  }
  if (spec.weightDtype !== 'float16') {
    errors.push('weightDtype must be float16 — FP16 is the required path on T4 (no BF16 tensor cores)');
  }
  if (spec.scheduler !== 'FlowMatchEulerDiscreteScheduler') {
    errors.push('scheduler must be FlowMatchEulerDiscreteScheduler');
  }
  return { ok: errors.length === 0, errors };
}

export function buildJobSpec(input = {}) {
  const spec = {
    engineId: FUN_INP_ENGINE_ID,
    prompt: input.prompt ?? FUN_INP_PROOF.prompt,
    firstKeyframeHash: input.firstKeyframeHash,
    lastKeyframeHash: input.lastKeyframeHash,
    frames: input.frames ?? FUN_INP_PROOF.frames,
    height: input.height ?? FUN_INP_PROOF.height,
    width: input.width ?? FUN_INP_PROOF.width,
    steps: input.steps ?? FUN_INP_PROOF.steps,
    guidanceScale: input.guidanceScale ?? FUN_INP_PROOF.guidanceScale,
    seed: input.seed ?? FUN_INP_PROOF.seed,
    weightDtype: input.weightDtype ?? FUN_INP_PROOF.weightDtype,
    scheduler: input.scheduler ?? FUN_INP_PROOF.scheduler,
    pipeline: FUN_INP_PROOF.pipeline,
  };
  const { ok, errors } = validateSpec(spec);
  if (!ok) {
    throw new Error(`invalid Fun-InP job spec: ${errors.join('; ')}`);
  }
  return Object.freeze(spec);
}

// The conditioning layout the native pipeline consumes. Pure data — the
// notebook builds the actual tensors from this description.
export function buildConditioning(spec) {
  const { ok, errors } = validateSpec(spec);
  if (!ok) throw new Error(`invalid Fun-InP job spec: ${errors.join('; ')}`);
  const { frames, height, width } = spec;
  return Object.freeze({
    videoTensor: Object.freeze({
      shape: [1, 3, frames, height, width],
      layout:
        'frame 0 = first keyframe (RGB, normalised to [-1, 1]); frame frames-1 = last keyframe; middle frames zero',
    }),
    maskVideo: Object.freeze({
      shape: [1, 1, frames, height, width],
      layout: '0 at frame 0 and frame frames-1 (given); 255 at all middle frames (to generate)',
    }),
    clipImage: null,
    clipImageNote:
      'None: the native pipeline runs the CLIP encoder on a black image and zeroes the result, so clip conditioning contributes nothing.',
    channelOrder:
      'transformer in_channels 36 = 16 noise + 4 mask + 16 masked-video latents (native code: x = cat([noise, mask, masked_video]) on the channel axis)',
  });
}
