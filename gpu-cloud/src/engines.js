// NOVA Personal GPU Cloud — video-generation engine registry.
//
// An engine definition is CAPABILITY DATA: what model it is, where its
// weights live, what licence governs it, what precision it natively
// runs, whether it does first/last-frame image-to-video, and whether
// NOVA has PROVEN it on a Kaggle T4. Mirrors the provider registry
// pattern (src/providers.js): definitions are data, the registry is a
// thin lookup, and nothing is dispatchable until proven.
//
// Proof discipline (standing): an engine is connected: false until a
// controlled proof run on one T4 establishes it. LTX-Video 2B distilled
// is the production engine — proven 24–25 Nov 2026 (runs 4–9, including
// byte-identical repeatability across three independent runs). The
// five engines registered 25 Nov 2026 come from the overnight deep
// research (docs/twenty-free-engines-2026-11-25.md); only Fun-InP has
// a proof authorised (reviewer, 25 Nov: ONE controlled Kaggle proof,
// strict stop if it fails the T4 memory/FP16 gate). FastWan and
// SANA-Video are DEFERRED by the reviewer; Allegro-TI2V is the named
// backup (reviewer, 24 Nov); SkyReels V2 needs its licence file read
// before any proof.
//
// Licence characterisations are a technical reading, not a legal
// opinion. Any licence excluding the US is disqualifying (Shina is in
// the US); non-commercial terms are disqualifying.

export const ENGINE_STATUSES = Object.freeze([
  'production', // proven on a T4 and selected as the production engine
  'proving', // one controlled proof authorised / running
  'unproven', // registered from research; no proof run yet
  'deferred', // reviewer deferred any proof for now
  'ruled-out', // researched and excluded; kept for the record
]);

export const ENGINE_DEFINITIONS = Object.freeze([
  {
    id: 'ltx-video-2b',
    label: 'LTX-Video 2B distilled (0.9.8)',
    repo: 'Lightricks/LTX-Video',
    checkpoint: 'ltxv-2b-0.9.8-distilled.safetensors',
    licence: 'LTXV Open Weights License 0.X (15 Apr 2025)',
    licenceNotes:
      'No non-compete; $10M revenue threshold; SaaS hosting expressly permitted; ' +
      'obligations: machine-generated disclosure, enforceable user restrictions + notice, ' +
      'redistribution conditions if distributed. Lightricks letter sent 22 Nov 2026, reply outstanding.',
    paramsB: 2,
    precisionNative: 'fp16',
    i2v: { firstFrame: true, lastFrame: true },
    pipeline: 'diffusers 0.40.0 LTXConditionPipeline.from_single_file (FP16 adaptation)',
    vramPeakGib: 8.68,
    vramBasis: 'measured',
    vramNote: '6.92 GiB @ 17 frames, 8.68 GiB @ 49 frames, 1024x576, Kaggle T4 (runs 4-9).',
    proofStatus: 'production',
    connected: true,
    status: 'production',
    proofRef: 'docs/ltx-proof-evidence-2026-11-24.md',
  },
  {
    id: 'wan2.1-fun-inp-1.3b',
    label: 'Wan2.1-Fun-1.3B-InP (V1.1)',
    repo: 'alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP',
    checkpoint: 'diffusion_pytorch_model.safetensors (native) / transformer/diffusion_pytorch_model.safetensors (diffusers conversion weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers)',
    licence: 'Apache 2.0',
    licenceNotes: 'No territorial/revenue restriction found. Cleanest licence of the new batch.',
    paramsB: 1.3,
    precisionNative: 'bf16',
    i2v: { firstFrame: true, lastFrame: true },
    pipeline: 'VideoX-Fun WanFunInpaintPipeline (native, in_channels 36 = 16 noise + 4 mask + 16 masked video)',
    vramPeakGib: null,
    vramBasis: 'unverified',
    vramNote: 'Expect ~8-12 GB by analogy to the 1.3B base (8.19 GB vendor); UNVERIFIED — the proof measures it.',
    proofStatus: 'proving',
    connected: false,
    status: 'proving',
    proofRef: 'docs/fun-inp-connection-2026-11-25.md',
    notes:
      'Strongest new candidate: the only true first+last-frame I2V at 1.3B with a clean licence. ' +
      'KEY OPEN QUESTION: BF16-native; T4 has no BF16 tensor cores — the proof establishes whether it loads AND executes in FP16. ' +
      'Text encoder umT5-XXL via Kaggle model mount thiminhnht/umt5-xxl-fp16 (FP16 safetensors, transformers-format keys, verified).',
  },
  {
    id: 'fastwan-1.3b',
    label: 'FastWan (FastVideo) 1.3B',
    repo: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    checkpoint: 'FastWan2.1-T2V-1.3B-Diffusers',
    licence: 'Apache 2.0',
    licenceNotes: 'Weights + training recipe + dataset, all Apache-2.0. No territory/revenue/SaaS restriction.',
    paramsB: 1.3,
    precisionNative: 'bf16',
    i2v: { firstFrame: false, lastFrame: false },
    pipeline: 'diffusers WanDMDPipeline (3 denoising steps)',
    vramPeakGib: null,
    vramBasis: 'unverified',
    vramNote: 'Teacher Wan2.1-1.3B needs 8.19 GB (vendor); FastWan-specific VRAM UNVERIFIED.',
    proofStatus: 'unproven',
    connected: false,
    status: 'deferred',
    proofRef: 'docs/twenty-free-engines-2026-11-25.md',
    notes:
      'Fastest clean distill (3 steps; 5 s clip in 21 s on a 4090, author-reported). T2V only at 1.3B (TI2V is the 5B). ' +
      'REVIEWER-DEFERRED 25 Nov 2026: no proof authorised for now.',
  },
  {
    id: 'sana-video-2b',
    label: 'SANA-Video 2B (v1)',
    repo: 'Efficient-Large-Model/SANA-Video_2B_480p_diffusers',
    checkpoint: 'SANA-Video_2B_480p_diffusers',
    licence: 'Apache 2.0',
    licenceNotes:
      'No geographic exclusions, no revenue threshold, no non-compete. Model card says "intended for research purposes only" ' +
      'as a use description, but the licence itself is Apache 2.0.',
    paramsB: 2,
    precisionNative: 'bf16',
    i2v: { firstFrame: true, lastFrame: false },
    pipeline: 'diffusers SanaImageToVideoPipeline',
    vramPeakGib: 7.2,
    vramBasis: 'measured',
    vramNote: '7.2 GB flat vs. video length, ICLR 2026 paper Fig. 1(c) (GPU unstated). Best VRAM profile of any candidate.',
    proofStatus: 'unproven',
    connected: false,
    status: 'deferred',
    proofRef: 'docs/twenty-free-engines-2026-11-25.md',
    notes:
      'BF16-native with NO documented FP16 path (diffusers docs: text encoder and VAE "must stay in bfloat16 or float32"). ' +
      'VRAM is proven; the open question is FP16 correctness. REVIEWER-DEFERRED 25 Nov 2026: no proof authorised for now.',
  },
  {
    id: 'allegro-ti2v',
    label: 'Allegro-TI2V',
    repo: 'rhymes-ai/Allegro-TI2V',
    checkpoint: 'Allegro-TI2V',
    licence: 'Apache 2.0',
    licenceNotes: 'Cleanest licence in the field — no revenue threshold, no geographic exclusion, no non-compete, no output-ownership claim.',
    paramsB: 2.8,
    precisionNative: 'bf16',
    i2v: { firstFrame: true, lastFrame: true },
    pipeline: 'native + diffusers integration (merged in diffusers 0.32.0-dev)',
    vramPeakGib: 9.3,
    vramBasis: 'vendor',
    vramNote: '9.3 GB BF16 with CPU offload; 27.5 GB without (vendor model-card figures).',
    proofStatus: 'unproven',
    connected: false,
    status: 'unproven',
    proofRef: 'docs/twenty-free-engines-2026-11-25.md',
    notes:
      'NAMED BACKUP (reviewer, 24 Nov 2026). True first+last-frame I2V, but ~20 min per 6 s clip on an H100 — ' +
      'likely 1-2+ hours per clip on a T4 (estimate, UNVERIFIED). Test only if LTX is blocked on licence or quality.',
  },
  {
    id: 'skyreels-v2-1.3b',
    label: 'SkyReels V2 1.3B DF (Diffusion Forcing)',
    repo: 'Skywork/SkyReels-V2-DF-1.3B-540P',
    checkpoint: 'SkyReels-V2-DF-1.3B-540P',
    licence: 'CONFLICT — Apache 2.0 vs Skywork Community License (UNRESOLVED)',
    licenceNotes:
      'Sources disagree: some say Apache 2.0, ComfyUI Wiki lists "SkyReels-V2 Community License". ' +
      'DO NOT adopt until the licence file in SkyworkAI/SkyReels-V2 is read directly.',
    paramsB: 1.3,
    precisionNative: 'fp16',
    i2v: { firstFrame: true, lastFrame: true },
    pipeline: 'native repo; diffusers docs cover it',
    vramPeakGib: 14.7,
    vramBasis: 'vendor',
    vramNote: '14.7 GB peak for 540p (vendor README, with offload/TeaCache) — ~0.7 GB headroom on a 15.36 GB T4. Knife-edge.',
    proofStatus: 'unproven',
    connected: false,
    status: 'unproven',
    proofRef: 'docs/twenty-free-engines-2026-11-25.md',
    notes:
      'FP16-native (no precision conversion needed) + infinite-length autoregressive generation. ' +
      'Two gates before any proof: (a) read the repo LICENSE file to resolve the licence conflict; (b) VRAM fit test first, quality second.',
  },
]);

export const PRODUCTION_ENGINE_ID = 'ltx-video-2b';

export class EngineRegistry {
  constructor(definitions = ENGINE_DEFINITIONS) {
    this.definitions = new Map(
      definitions.map((d) => [d.id, structuredClone(d)]),
    );
  }

  get(id) {
    return this.definitions.get(id) ?? null;
  }

  list() {
    return [...this.definitions.values()];
  }

  register(def) {
    if (typeof def?.id !== 'string' || def.id.length === 0) {
      throw new Error('engine definition requires a non-empty id');
    }
    if (typeof def?.licence !== 'string' || def.licence.length === 0) {
      throw new Error('engine definition requires a licence string');
    }
    if (typeof def?.proofStatus !== 'string' || def.proofStatus.length === 0) {
      throw new Error('engine definition requires a proofStatus');
    }
    this.definitions.set(def.id, structuredClone(def));
    return this.definitions.get(def.id);
  }

  // The production engine: proven on a T4 and selected. Exactly one.
  production() {
    return this.definitions.get(PRODUCTION_ENGINE_ID) ?? null;
  }

  // Engines NOVA has proven on a T4 (connected). Only these may run jobs.
  proven() {
    return this.list().filter((d) => d.connected === true);
  }

  // An engine may run a job only when it is connected (proven).
  dispatchable(id) {
    const e = this.definitions.get(id);
    return Boolean(e && e.connected && e.status === 'production');
  }

  setStatus(id, status) {
    const e = this.definitions.get(id);
    if (!e) throw new Error(`unknown engine ${id}`);
    if (!ENGINE_STATUSES.includes(status)) {
      throw new Error(`engine status must be one of: ${ENGINE_STATUSES.join(', ')}`);
    }
    e.status = status;
    return e;
  }

  setConnected(id, connected) {
    const e = this.definitions.get(id);
    if (!e) throw new Error(`unknown engine ${id}`);
    e.connected = connected;
    return e;
  }

  // True first+last-frame I2V (NOVA's keyframe-animation need).
  supportsFirstLastFrame(id) {
    const e = this.definitions.get(id);
    return Boolean(e && e.i2v && e.i2v.firstFrame && e.i2v.lastFrame);
  }
}
