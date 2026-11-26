// NOVA Personal GPU Cloud — Stage 1: provider registry.
//
// A provider definition is CAPABILITY DATA: what GPU it has, how much VRAM
// per card, which models it can run, what it costs, when it is available.
// Stage 1 ships ONE working provider (the in-process mock) and three
// DEFINITIONS (Kaggle, Colab, RunPod) with connected: false — no live
// connection exists yet. Stage 2 wires the real free-GPU connection; the
// paid RunPod route additionally needs owner approval + a payment route
// (video plan Phase 3) and a raised spending ceiling.
//
// VRAM is PER GPU CARD. Two T4 cards do not give one process 32 GB of
// unified VRAM (reviewer VDP-03) — the dispatcher compares a job's
// minVramGb against a single card.

export const PROVIDER_KINDS = Object.freeze(['mock', 'kaggle', 'colab', 'runpod']);

// Open video/image models that fit a free 16 GB T4, per the Video
// Independence Plan §2 (candidate fits — each needs a real run to prove
// it, VDP-03). The registry records the claim; Stage 2/3 prove it.
const T4_MODELS = Object.freeze([
  // NOTE: wan2.2-ti2v-5b is kept for the record; its proof track was
  // CANCELLED by Shina 24 Nov 2026 (CUDA OOM, v5) and the kernel deleted.
  // Do not dispatch it.
  'wan2.2-ti2v-5b',
  'wan2.1-1.3b',
  'self-forcing',
  'framepack',
  'cogvideox-2b',
  'ltx-video-2b',
  'sdxl-base-1.0',
  'z-image-turbo',
  // Engines registered 25 Nov 2026 from docs/twenty-free-engines-2026-11-25.md
  // (see src/engines.js for full metadata and proof status). Listing here
  // is NOT proof: only engines with connected: true in the engine registry
  // may run jobs; today that is ltx-video-2b only.
  'wan2.1-fun-inp-1.3b',
  'fastwan-1.3b',
  'sana-video-2b',
  'allegro-ti2v',
  'skyreels-v2-1.3b',
]);

export const PROVIDER_DEFINITIONS = Object.freeze([
  {
    id: 'mock-t4',
    kind: 'mock',
    label: 'Mock T4 (Stage 1 simulator)',
    gpuType: 'Mock T4',
    vramGb: 16,
    models: ['mock-image-v1', 'mock-video-v1', 'wan2.2-ti2v-5b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: {
      type: 'always',
      description: 'Always available in-process (simulator).',
    },
    maxConcurrentJobs: 4,
    connected: true,
    status: 'available',
  },
  {
    id: 'kaggle-t4',
    kind: 'kaggle',
    label: 'Kaggle free GPU (2x T4)',
    gpuType: 'NVIDIA T4 x2',
    vramGb: 16, // per card — NOT 32 GB unified (VDP-03)
    models: [...T4_MODELS],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: {
      type: 'weekly-hours',
      hoursPerWeek: 30,
      description:
        '30 GPU-hours/week; 12h sessions; 20 GB working storage; offline ' +
        'staging required (VDP-04). Internet is a session setting, ON by ' +
        'default per Kaggle\'s own docs — the "no internet" claim is NOT ' +
        'confirmed first-party; the offline procedure stands regardless ' +
        '(reviewer-mandated, conservative). Kaggle is Google-owned: Phase 1 ' +
        'buys model independence, not infrastructure independence.',
    },
    maxConcurrentJobs: 1,
    connected: false,
    status: 'not-connected',
  },
  {
    id: 'colab-t4',
    kind: 'colab',
    label: 'Google Colab free GPU (T4)',
    gpuType: 'NVIDIA T4',
    vramGb: 16,
    models: [...T4_MODELS],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: {
      type: 'weekly-hours',
      hoursPerWeek: 12,
      description:
        '~12-15 GPU-hours/week, variable (unpublished); GPU not guaranteed; ' +
        '12h sessions; idle timeouts; NO background execution (browser must ' +
        'stay open). No official API — manual channel only. Unreliable as ' +
        'a sole backend.',
    },
    maxConcurrentJobs: 1,
    connected: false,
    status: 'not-connected',
  },
  {
    id: 'runpod-4090',
    kind: 'runpod',
    label: 'RunPod Serverless (RTX 4090)',
    gpuType: 'NVIDIA RTX 4090',
    vramGb: 24,
    models: [
      ...T4_MODELS,
      'wan2.1-14b',
      'hunyuanvideo-1.5-fp8',
      'skyreels-v2-1.3b',
    ],
    costModel: { type: 'paid', perSecondUsd: 1.34 / 3600 },
    availabilityWindow: {
      type: 'always',
      description:
        'On-demand serverless; scale-to-zero; per-second billing. Requires ' +
        'owner approval + a payment route (video plan Phase 3) and a raised ' +
        'spending ceiling. Rate is a planning figure, not a ceiling (VDP-08).',
    },
    maxConcurrentJobs: 10,
    connected: false,
    status: 'not-connected',
  },
]);

// Can this provider run this job? Checks model support + per-card VRAM.
// (Availability, connection and capacity are the dispatcher's checks.)
export function providerSupports(provider, job) {
  if (!provider.models.includes(job.modelId)) {
    return { ok: false, reason: 'model-unsupported' };
  }
  if (provider.vramGb < job.minVramGb) {
    return { ok: false, reason: 'insufficient-vram' };
  }
  return { ok: true };
}

// Planning estimate for a job on a provider (USD). Free providers cost 0.
// Paid estimate = per-second rate x the job's estimated seconds. This is a
// planning figure, not a guaranteed ceiling (VDP-08).
export function estimateCostUsd(provider, job) {
  if (provider.costModel.type === 'free') return 0;
  return provider.costModel.perSecondUsd * job.estimatedSeconds;
}

export class ProviderRegistry {
  constructor(definitions = PROVIDER_DEFINITIONS) {
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
      throw new Error('provider definition requires a non-empty id');
    }
    if (!PROVIDER_KINDS.includes(def.kind)) {
      throw new Error(`provider kind must be one of: ${PROVIDER_KINDS.join(', ')}`);
    }
    this.definitions.set(def.id, structuredClone(def));
    return this.definitions.get(def.id);
  }

  // A provider is dispatchable only when it is CONNECTED and AVAILABLE.
  // Definitions with connected: false (Kaggle/Colab/RunPod in Stage 1)
  // can never receive a job, however capable they look on paper.
  dispatchable(id) {
    const p = this.definitions.get(id);
    return Boolean(p && p.connected && p.status === 'available');
  }

  setStatus(id, status) {
    const p = this.definitions.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    p.status = status;
    return p;
  }

  setConnected(id, connected) {
    const p = this.definitions.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    p.connected = connected;
    return p;
  }
}
