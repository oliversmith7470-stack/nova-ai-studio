# GitHub Engine Alternatives to Wan 2.2 — Research Report

**Date:** 24 November 2026
**Authorised by:** Shina, 24 Nov ~23:47 WAT ("You are free to check Github if ww can see engine to replace wan")
**Scope:** Research only. No weights downloaded, no generation run, nothing committed.
**Context:** Wan 2.2 TI2V-5B is CANCELLED (five failed proof attempts on 2× Kaggle Tesla T4, 3.75 GPU-h, never past step 0). LTX-Video 2B distilled (0.9.8) is the current chosen replacement and has already proven itself twice on a single T4. This search is for alternatives that could **beat LTX or serve as a credible backup** — not to re-litigate the Wan decision.

**Prior records:** `wan-proof-evidence-2026-11-24.md`, `wan-replacement-shortlist-2026-11-24.md` (LTX 2B #1, FramePack #2, HunyuanVideo 1.5 FP8 #3, SkyReels V2 1.3B #4, Wan 2.1 1.3B #5; CogVideoX and Self-Forcing ruled out).

## Constraints (all must hold for a candidate to count)

1. Runs on a Kaggle Tesla T4 (15.36 GB VRAM, Turing — FP16 native; FP8/BF16 tensor cores NOT native). Must fit in ~14 GB with headroom, or have a credible low-memory path.
2. Image-to-video (first frame; ideally first+last frame) — NOVA's workflow is I2V.
3. Free and open weights; licence must permit SaaS hosting of generated output. Watch for non-compete clauses, geographic exclusions, revenue thresholds, output-ownership terms.
4. Actively maintained or at least pinned-reproducible (exact commit/checkpoint available).
5. No paid API, no card, no sign-up wall for the weights.

## The bar: LTX-Video 2B distilled (0.9.8) — measured on NOVA's own hardware

| Fact | Value (measured, Kaggle T4) |
|---|---|
| Checkpoint | 6.3 GB |
| Precision | FP16 native (proven 0 BF16 before AND after sampling) |
| I2V | First + last frame (diffusers adaptation) |
| Run 4 | 17 frames, 1024×576, peak VRAM 6.92 GiB, sampling 7.2 s |
| Run 5 | 49 frames, 1024×576, peak VRAM 8.68 GiB (59.6%), sampling 13.3 s, visible motion |
| External benchmark | 27.4 s / 49 frames (same config family) |
| Licence | LTX 2B Community Licence 0.X — no non-compete; §2 worldwide royalty-free grant subject to Attachment A; $10M revenue threshold; §3 expressly permits SaaS hosting; §5 Lightricks claims no rights in output. Three obligations: Attachment A(e) machine-generated disclosure; §3.1/§4 enforceable user restrictions + notice; §3.2 redistribution conditions if the model is ever distributed. |

**This is the bar an alternative must clear.** No candidate in this search clears it on all three axes (fit + speed + licence) at once.

---

## Ranked shortlist (alternatives / backups to LTX)

### #1 — Allegro-TI2V (rhymes-ai/Allegro) — STRONGEST BACKUP

- **Repo:** https://github.com/rhymes-ai/Allegro — **1,137 stars**, 84 commits, current commit `f395a54b015f7e3296c52f59a45b78acf9dd07f6`. Created 2024-10-16. Last news 2025-02-07 (Presto release); repo not archived, pinned-reproducible by commit.
- **Model:** 2.8B DiT + 175M VAE. 720p, 88 frames, 6 s @ 15 fps. Merged into diffusers (0.32.0-dev).
- **I2V:** YES — true TI2V. `--first_frame` required, `--last_frame` optional ("the model will generate intermediate video content based on the specified first and last frame images"). Training jointly covers first-frame-to-video, first&last-frames-to-video, and video-continuation.
- **VRAM:** **9.3 GB BF16 with CPU offload** (27.5 GB without), per the README's own table. Fits a T4 with offload.
- **Licence:** **Apache License 2.0** — cleanest licence in the field. No revenue threshold, no geographic exclusion, no non-compete, no output-ownership claim. Commercial SaaS use permitted outright.
- **Stack:** Python ≥ 3.10, PyTorch ≥ 2.4, CUDA ≥ 12.4 — modern, compatible with Kaggle's environment.
- **Why it does NOT beat LTX:** **Speed.** 100 sampling steps; README states **~20 minutes per clip on a single H100** (3 min on 8× H100). On a T4 with CPU offload it would be far slower still. LTX does 49 frames in 13.3 s of sampling. Allegro is roughly two orders of magnitude slower. **Precision:** DiT/T5 are **BF16/FP32/TF32 only — no FP16 for the DiT** (VAE supports FP16). BF16 on Turing is emulation, which makes the already-slow generation slower. **Frame rate:** 15 fps native (30 fps only via EMA-VFI interpolation, an extra step).
- **Verdict:** The strongest backup on licence cleanliness and true first+last-frame I2V. Test only if LTX is blocked on licence or quality. It cannot be the core engine at this speed.

### #2 — FramePack F1 (lllyasviel/FramePack) — LONG-FORM SPECIALIST

- **Repo:** https://github.com/lllyasviel/FramePack — **17,356 stars** (Nov 2026). Apache 2.0 code. F1 variant (May 2025, simpler/faster). Now in diffusers (`HunyuanVideoFramepackPipeline`).
- **Model:** 13B HunyuanVideo backbone; 30 GB+ download.
- **I2V:** I2V-only design (image is the starting point). First+last frame via community PR #167 / diffusers. **Long-form:** up to 60 s — the only candidate here that does long-form natively.
- **VRAM:** 6 GB minimum with offload (FramePack's whole design is low-VRAM). Fits a T4.
- **Licence:** **Murkier than the code licence suggests.** Code is Apache 2.0, but the weights inherit **Tencent Hunyuan terms** (custom community licence with EU/UK/KR geographic exclusion). Read the full weights licence before any production use.
- **Why it does NOT beat LTX:** **Speed.** ~30–60 min per 5 s clip on T4-class hardware. **Size:** 30 GB+ download (weights stay HF pointers until a bigger backend exists; the store holds ~4.85 GB). **Hardware:** README requires RTX 30XX/40XX/50XX — T4 not listed; no T4 proof. 13B backbone is 6.5× LTX's size for the same job.
- **Verdict:** Keep as the long-form second-phase option (60 s clips LTX cannot do in one pass). Not a core-engine replacement.

### #3 — SkyReels V2 1.3B DF (SkyworkAI/SkyReels-V2) — TIGHT FIT, CUSTOM LICENCE

- **Repo:** https://github.com/SkyworkAI/SkyReels-V2 — **7,806 stars**.
- **Model:** 1.3B (diffusion-forcing variant). 540p.
- **I2V:** Yes — I2V + start/end frame + video extension.
- **VRAM:** **14.7 GB peak with offload at 540p** — a thin margin on a 15.36 GB T4; no T4 proof. One fp32 activation spike away from the same OOM that killed Wan.
- **Licence:** **Skywork Community License — NOT Apache 2.0** (multiple sources agree, incl. a 2026-09-27 correction). Commercial use is explicitly permitted with no separate application needed, but it is a custom non-OSI licence — read the full text before use.
- **Why it does NOT beat LTX:** VRAM margin is ~0.7 GB; resolution is 540p vs LTX's proven 1024×576; custom licence needs a full read; no measured T4 proof.
- **Verdict:** Backup only, behind Allegro (worse licence clarity, worse VRAM margin).

### #4 — Pyramid-Flow (jy0205/Pyramid-Flow) — FITS, BUT BF16-ONLY AND STALE

- **Repo:** https://github.com/jy0205/Pyramid-Flow — **3,215 stars**, 130 commits, current commit `a012faa1dc4d71301a7a153c7f9554c081947ea2`. Created 2024-10-06. Last news 2024-11-13 (768p miniFLUX checkpoint). ICLR 2025 paper.
- **Model:** ~2B (miniFLUX variant). 10 s @ 768p / 24 fps (5 s @ 384p).
- **I2V:** Yes — `generate_i2v` with a first-frame image. **First frame only; no last-frame support** in the official code.
- **VRAM:** **<12 GB with `cpu_offloading=True`; <8 GB with `model.enable_sequential_cpu_offload()`** (README). Fits a T4 with offload.
- **Licence:** **MIT** (per repo licence field; Shotcraft also lists MIT for weights). Clean.
- **Why it does NOT beat LTX:** **BF16-only** — README code states `model_dtype, torch_dtype = 'bf16', torch.bfloat16  # Use bf16 (not support fp16 yet)`. BF16 on Turing is emulation. **Stale stack:** Python 3.8.10, PyTorch 2.1.2 (Oct 2024) — two years behind Kaggle's environment; dependency risk. **Speed:** 5.5 min on a single A100 for 5 s @ 768p — far slower than LTX. **No last-frame conditioning.** No activity since Nov 2024.
- **Verdict:** Weak backup. Fits and is MIT-licensed, but BF16-only + stale stack + slow + no last frame.

### #5 — HunyuanVideo 1.5 (Tencent-Hunyuan/HunyuanVideo-1.5) — 14 GB FLOOR, FP8-DEPENDENT

- **Repo:** https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5 — **4,616 stars**, 120 commits, current commit `60783e704160023913bee78f0b47036d393d4dfa`. Created 2025-11-20. Actively maintained (FP8 GEMM support Dec 23, 2025; step-distilled I2V Dec 5, 2025; training code + LoRA Dec 5, 2025; diffusers + ComfyUI + LightX2V support).
- **Model:** 8.3B DiT + 3D causal VAE (16× spatial, 4× temporal compression). Unified T2V/I2V. 480p/720p, up to 10 s. Step-distilled 480p I2V: 8 or 12 steps.
- **I2V:** Yes — dedicated I2V checkpoints (480P-I2V, 720P-I2V, plus cfg-distill and step-distill variants).
- **VRAM:** **Minimum 14 GB with model offloading enabled** (README §System Requirements). FP16 path is 24–28 GB. The 14 GB floor depends on offload + (for the fast path) FP8 GEMM via sgl-kernel. **FP8 is not native on Turing** — the fit is unproven on a T4 and the FP8 acceleration path likely does not run there. Third-party Wan2GP claims 6 GB, but that is an unverified third-party low-VRAM app, not the official path. Step-distilled 480p I2V: 121 frames in 290 s on an RTX 3090 (24 GB) — and 75 s end-to-end on an RTX 4090.
- **Licence:** GitHub licence field shows **NOASSERTION** — a custom Tencent Hunyuan Community Licence (LICENSE file in repo). Per the November shortlist, it **excludes the EU, UK, and South Korea** from the grant. Shina is in the US (not excluded), but a custom licence with geographic carve-outs needs a full read before production use, and the exclusion signals the licensor's willingness to carve out territories.
- **Why it does NOT beat LTX:** 14 GB floor leaves ~1.4 GB headroom on a T4 (vs LTX's 8.68 GiB peak — 6.7 GB headroom); the fast path is FP8-dependent (not native on Turing); 8.3B is 4× LTX's size; no T4 proof; custom licence with geographic exclusions.
- **Verdict:** The most actively maintained candidate and the strongest on paper for quality, but the T4 fit is marginal and FP8-dependent. Revisit only if NOVA moves to Ampere-or-newer hardware.

---

## Watch item (unresolved — do NOT rank yet)

### SANA-Video 2.0 2B (NVlabs/Sana)

- **Repo:** https://github.com/NVlabs/Sana — SANA-Video 2.0, Apache 2.0.
- **What is known:** A **2B variant exists** (`SANA-Video_2B_480p/720p_diffusers`, native `SanaImageToVideoPipeline`, 81 frames, 50 steps, BF16 DiT). T2V + TI2V (first frame). The 5B sibling (4.47B) is 720p, 81f @ 16 fps / 193f @ 24 fps, 4-step DMD distilled preview is T2V-only, and needs **~16–24 GB BF16** — over the T4. The 2B's VRAM figure was **NOT established** in this search. BF16 inference is a Turing concern either way. Note: SANA-Video uses the **LTX 2.3 VAE** — an LTX-family dependency.
- **Action:** verify the 2B's measured VRAM (and whether any FP16 path exists) before ranking it. If it fits under ~12 GB with an FP16 path, it becomes a real #2/#3 contender. Until then it is a watch item, not a candidate.

---

## Ruled out (with reasons)

| Candidate | Size / VRAM | Why ruled out |
|---|---|---|
| **Cosmos Predict2 / Predict2.5-2B** (nvidia-cosmos) | 2B, **32.54 GB VRAM required** (model card) | Ampere/Hopper/Blackwell only (T4 is Turing); measured 27.7 GB + 32 min/clip on DGX Spark; weights GATED on HF (must agree to share HF info); NVIDIA Open Model License is commercially usable but **revocable**; world-model training (robotics/AV), not cinematic content. Cosmos 3 needs ≥79 GiB. |
| **MiniMax H3** (MiniMax-AI/MiniMax-H3, Aug 2026) | 33B, ~45 GB pruned bundle | Custom MiniMax H3 Community License **excludes use in the US, EU, UK, and South Korea** without separate authorisation — Shina is in the US. Full release ~385 GB; pruned INT8 DiT alone 20.9 GB. (Otherwise attractive: FL2VA first+last frame + native stereo audio, 4–15 s up to 2K.) |
| **MAGI-1** (SandAI-org/MAGI-1) | 4.5B, 24 GB | Distilled FP8 build runs on 12 GB, but FP8 is not native on Turing. Apache 2.0, I2V, autoregressive unlimited length — the hardware fit is the blocker. |
| **MAGI-2 Preview** (Aug 2026) | 114B MoE (6B active), 307 GB checkpoint | Requires 8 Hopper GPUs. Apache 2.0, 10 s 1080p + audio — completely out of reach. |
| **Ovi 1.1** (character-ai/Ovi) | 11B, 32 GB min (~24 GB FP8 + offload) | Wan 2.2 video branch (the cancelled family) + 5B audio branch. Native audio is attractive, but the size and FP8 dependence rule it out. No code updates since Nov 2025. |
| **SkyReels V3** (Jan 29, 2026) | 14B R2V + 14B V2V + 19B A2V | 24 GB floor (FP8 + offload below that, at 540p/480p); 52–69 GB storage per model; built on Wan 2.1 backbone; Skywork Community License carries a "security review expectation" for internet-service deployment. |
| **CausVid** (tianweiy/CausVid) | Wan 2.1 1.3B base | **CC BY-NC-SA 4.0 — non-commercial.** I2V still on the repo TODO list. |
| **SVD** (Stability-AI/generative-models) | 14–25 frames max | Stability AI Community License — **non-commercial by default; commercial use requires a paid licence from Stability AI**. No text conditioning; unmaintained (API deprecated July 2025); gated download. |
| **Vchitect-2.0** (Vchitect/Vchitect-2.0) | 2B, Apache 2.0 | **T2V only in the official code** — no image input in inference.py. 100 default steps; base 720×480 @ 8 fps; last updated Mar 2025; 921 stars. |
| **SANA-Video 2.0 5B** (NVlabs/Sana) | 4.47B, ~16–24 GB BF16 | Over the T4 at the low end; BF16-only inference. (The 2B variant is the watch item above.) |
| **SANA-WM** (NVlabs/Sana) | 2.6B + 17B refiner, 49–51 GB | Camera-trajectory world model, not a general I2V engine; refiner under the LTX-2 Community License. |
| **DynamiCrafter** (Doubiiu/DynamiCrafter) | 16-frame hard cap, ~10 GB pruned bf16 @ 1024×576 | Apache 2.0 and I2V, but 16 frames = 0.7 s at 24 fps (shorter than even the LTX proof clip); 2023-era quality; Python 3.8.5, xformers required for full quality. Weak at best. |
| **CogVideoX** | 2B no I2V, ~19 GB, 1,053 s/49f on T4 | Ruled out in the November shortlist; nothing new found. |
| **Self-Forcing** | 13B backbone, 45–60 GB | Ruled out in the November shortlist; nothing new found. |
| **Mochi 1** | 10B, ~24 GB+ | Ruled out in the November shortlist. |
| **Open-Sora 2.0** | 11B | Ruled out in the November shortlist (size). |
| **Wan 2.1 1.3B** | — | Family cancelled; no official I2V. |
| **LTX-2 / LTX-2.5** | 22B, gated | LTX-2.x Community License carries a non-compete; gated weights; far too large. |

## Names noted but not verified in this search

From 2026 "best open video model" lists (rawspaceleaf, jutsustudio, Nov 2026): **HappyHorse-1.0, Bernini, LingBot-Video, LongLive 2.0, Kandinsky 6**. Not examined — the verified candidates above already decide the recommendation, and none of these five appeared with a T4-class VRAM claim or an I2V-first design in the lists. **AnimateDiff** (2023, SVD-based) is superseded. **Luma Ray2 / Seedance 1.0** are proprietary APIs — excluded by the no-paid-API constraint.

---

## Recommendation: STICK WITH LTX

**Nothing found beats LTX 2B distilled on NOVA's hardware.** The reasons are structural, not a matter of one missing search:

1. **LTX is the only candidate with measured T4 proof.** 6.92 GiB @ 17f and 8.68 GiB @ 49f, FP16, on the actual Kaggle T4, twice. Every alternative's fit is a README claim, an offload figure, or an FP8/BF16 path that has never been run on a T4.
2. **LTX is the only candidate with native FP16.** The 2026 field has moved to BF16/FP8-native design (Ampere+ assumptions). Allegro, Pyramid-Flow, SANA, and HunyuanVideo 1.5's fast path all depend on precisions Turing does not accelerate natively. On a T4, that means emulation slowness on top of already-long generation times.
3. **LTX is fastest by orders of magnitude.** 13.3 s sampling for 49 frames vs ~20 min/H100 (Allegro), 5.5 min/A100 for 5 s (Pyramid-Flow), 30–60 min/5 s (FramePack), 75 s/RTX 4090 (HunyuanVideo 1.5 step-distilled). Speed is what makes a free service usable — a 20-minute queue per clip is not a product.
4. **LTX's licence is workable.** The $10M revenue threshold is far above NOVA's current scale; the three obligations (disclosure, user restrictions + notice, redistribution conditions) are manageable. The alternatives with cleaner licences (Allegro Apache 2.0, Pyramid-Flow MIT) lose on speed and precision; the alternatives with comparable quality (HunyuanVideo 1.5, SkyReels V2, MiniMax H3) carry custom licences with geographic exclusions.
5. **The 2026 trend cuts against the T4.** New releases are bigger (14B–114B), assume Ampere-or-newer hardware, and increasingly carry custom licences with geographic carve-outs. LTX 2B distilled remains the outlier that fits.

### What to do with the alternatives

- **Allegro-TI2V** is the strongest backup: cleanest licence (Apache 2.0), true first+last-frame I2V, fits at 9.3 GB with offload. Test it **only if LTX is blocked on licence or quality** — and expect very slow generation.
- **FramePack F1** stays the long-form specialist (60 s) for a later phase, not a core-engine replacement.
- **SANA-Video 2B** is the one open question: verify its measured VRAM (and any FP16 path) before ranking it.
- **HunyuanVideo 1.5** becomes interesting only if NOVA moves to Ampere-or-newer hardware.

### What would change this recommendation

- A verified SANA-Video 2B VRAM figure under ~12 GB with an FP16 path.
- An Allegro proof run on a T4 at acceptable speed (unlikely given the H100 baseline).
- A licence change for LTX (e.g. a lower revenue threshold or a non-compete added to the 0.X terms).
- NOVA moving off the T4 to Ampere-or-newer hardware (re-opens HunyuanVideo 1.5, MAGI-1 FP8, Cosmos 2B).

## Method note

Searches run 24 Nov 2026 ~23:47–23:55 WAT via web/GitHub search + direct README reads (Allegro, Pyramid-Flow, HunyuanVideo-1.5 read in full; FramePack, SkyReels V2, SANA, Cosmos, MiniMax H3, MAGI-1/2, Ovi, SkyReels V3, CausVid, SVD, Vchitect-2.0, DynamiCrafter verified via search results and secondary sources). Star counts are as of the crawl time (Allegro 1,137; Pyramid-Flow 3,215; HunyuanVideo-1.5 4,616; FramePack 17,356; SkyReels V2 7,806; MAGI-1 3,806; Ovi 1,763; Vchitect-2.0 ~921). Licence characterisations are from the repos' own licence fields and README/model-card text, plus the November shortlist where noted; they are a technical reading, not a legal opinion.
