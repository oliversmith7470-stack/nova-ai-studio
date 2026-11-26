# Twenty Free Video-Generation Engines — NOVA AI Studio Deep Research

**Date:** 25 November 2026 (overnight research)
**Authorised by:** Shina, 25 Nov ~00:37 WAT ("Search the entire internet. Go deep, deeper this time. … We need 10 and we need 20 and they must be free. And they must be good. Good engines.")
**Scope:** RESEARCH ONLY. No weights downloaded, no generation run, no experiment, nothing committed. This report is for reviewer review in the morning.
**Prior records:** `wan-replacement-shortlist-2026-11-24.md`, `github-engine-alternatives-2026-11-24.md`, `ltx-proof-evidence-2026-11-24.md` (575 lines).

## How to read this report

- **"Free"** means: open weights runnable on free compute with no payment, no API-key purchase, no expiring trial. Free-trial APIs and freemium hosted services do NOT count.
- **"Good"** means: a real image-to-video or text-to-video engine with credible evidence (public demo, benchmark, or community reproduction) — not vaporware, not a paper with no weights.
- **VRAM figures** state whether they are measured, vendor-claimed, or community-measured, and on what GPU. Anything not established is marked **UNVERIFIED** — never presented as a measurement.
- **The T4 bar:** Kaggle Tesla T4, 15,360 MiB VRAM, Turing (cc 7.5). FP16 and INT8 run natively; BF16 and FP8 have no tensor-core support (emulation only). Host RAM ~31 GiB; `/kaggle/working` 20 GB.
- **Licence flags:** any licence excluding the US is DISQUALIFYING (Shina is in the US). Non-commercial terms are disqualifying. EU/UK/South Korea exclusions, revenue thresholds, non-compete clauses, and SaaS/hosting restrictions are flagged. Licence characterisations are a technical reading, not a legal opinion.

## The bar: LTX-Video 2B distilled (0.9.8) — the production engine

Measured on NOVA's own Kaggle T4 (runs 4–6 + repeatability series v7–v9, Nov 2026): 6.92 GiB peak VRAM @ 17 frames, 8.68 GiB @ 49 frames, 1024×576, FP16 proven (0 BF16 parameters before and after sampling), sampling 13.3 s per 49 frames, repeatability PROVEN (three independent runs byte-identical to run 4). Licence: LTXV Open Weights License 0.X — no non-compete; §2 worldwide royalty-free grant subject to Attachment A; $10M revenue threshold; §3 expressly permits SaaS hosting; §5 Lightricks claims no rights in output. Three obligations: machine-generated disclosure, enforceable user restrictions + notice, redistribution conditions if the model is ever distributed.

**Finding from this round — flag for the reviewer:** the LTX-Video repo (v0.9.x) now states "This repository is no longer under active development" and "LTX-2.5 supersedes both LTX-Video (v0.9.x) and LTX-2" (README, crawled ~21 Nov 2026). NOVA's production engine is frozen upstream. That is not a reason to switch — LTX-2.5 is 22B with a 16 GB VRAM floor and does not fit a T4 — but it means no upstream fixes are coming for the 0.9.x line.

## Ranked table — 25 real engines found

The target was 20. **25 genuinely qualify** as real, free, open-weights video engines with evidence. Nothing here is padding: every entry has downloadable weights and a documented generation capability. Ranking is by NOVA suitability (T4 fit + I2V capability + licence + speed + quality), not by raw quality alone.

| Rank | Engine | Params | Licence | I2V | VRAM (T4-relevant) | Precision | T4 fit | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **LTX-Video 2B distilled 0.9.8** | 2B | LTXV 0.X ($10M cap) | First+last frame | **6.92–8.68 GiB measured** | FP16 native | ✅ Proven | **Production engine — the bar** |
| 2 | Wan2.1-Fun-1.3B-InP | 1.3B | Apache 2.0 | **First+last frame** | ~8–12 GB inferred, UNVERIFIED | BF16 | Likely, unproven | Strongest new candidate |
| 3 | FastWan (FastVideo) | 1.3B | Apache 2.0 | No (T2V); 5B TI2V | ~8 GB (teacher figure) | BF16 | Plausible, FP16 unverified | Fastest clean distill (3 steps) |
| 4 | SANA-Video 2B (v1) | 2B | Apache 2.0 | First frame | **7.2 GB measured** (paper) | BF16-only | VRAM ✅, precision ⚠️ | Best VRAM; needs FP16 proof |
| 5 | Allegro-TI2V | 2.8B | Apache 2.0 | First+last frame | 9.3 GB w/ offload (vendor) | BF16/FP32 | Fits w/ offload | Named backup; very slow |
| 6 | SkyReels V2 1.3B DF | 1.3B | **CONFLICT: Apache vs Community** | First frame + start/end | 14.7 GB w/ offload (vendor) | FP16 native | Knife-edge | Candidate if licence = Apache |
| 7 | FramePack F1 | 13B | Code Apache; weights Tencent terms | I2V-only | 6 GB min (vendor) | BF16 | Fits, very slow | Long-form specialist (60 s) |
| 8 | LingBot-Video Dense 1.3B | 1.3B | Apache 2.0 | First frame | 8 GB card proven (community) | BF16-only | VRAM ✅, slow | Backup; robotics bias, JSON workflow |
| 9 | Wan2.1-VACE-1.3B | 1.3B | Apache 2.0 | Reference-guided, not true I2V | ~12 GB community-measured | BF16 | Fits w/ offload | Editing/extension tool |
| 10 | Phantom-Wan-1.3B | 1.3B | Apache 2.0 (HF metadata) | Subject-to-video, not I2V | ~8–16 GB claimed | **FP16-native** | Likely fits | Character-consistency feature |
| 11 | Bernini-R-1.3B | 1.3B | Apache 2.0 | Reference-to-video | UNVERIFIED (~8.19 GB Wan proxy) | BF16 | Plausible, unproven | Editing-first; needs VRAM probe |
| 12 | HunyuanVideo 1.5 | 8.3B | Tencent Community (excl. EU/UK/KR) | First frame | 14 GB min w/ offload (vendor) | FP8/FP16 | Marginal, FP8-dependent | Quality pick; licence + precision problems |
| 13 | Open-Sora 1.2/1.3 | 1.1B + T5-XXL | Apache 2.0 | First frame | ~18 GB @720p (third-party) | BF16-only | Marginal, proof needed | Best of the older DiTs |
| 14 | Pyramid-Flow | ~2B | MIT | First frame only | <8 GB w/ sequential offload (vendor) | BF16-only | Fits w/ offload | Stale (Nov 2024), slow, no last frame |
| 15 | SANA-Video 2.0 5B | 4.47B | Apache 2.0 + LTX-2 VAE ($10M cap) + Gemma gated | First frame | UNVERIFIED | BF16 | Unknown | Don't select until VRAM measured |
| 16 | Kandinsky 6.0 Lite | 3B | MIT | First+last frame (since Oct 2026) | 7.9 GiB @ 16 GB preset (offload) | BF16 | Host-RAM-bound | Joint audio+video; too slow, 5 s fixed |
| 17 | Self-Forcing | 1.3B | Code Apache; **weights licence unstated** | No (T2V stream) | UNVERIFIED | BF16 | UNVERIFIED | Real-time streaming; licence must clear |
| 18 | Wan 2.1 1.3B (T2V) | 1.3B | Apache 2.0 | No official I2V | 8.19 GB (vendor) | BF16 | Fits | T2V-only; family cancelled |
| 19 | Latte-1 | UNVERIFIED | Apache 2.0 | No (T2V+T2I) | 17 GB / 9 GB quant (vendor) | FP16 | Quant only | 2024-era, T2V-only |
| 20 | AnimateDiff | 0.4B module | Apache 2.0 code | Via adapters only | 5.6 GB measured (512²/16f) | FP16 | Fits easily | 2023 motion module, not an engine |
| 21 | AnimateLCM | 454M adapter | MIT code; **weights unstated** | First frame | ~6 GB proxy (UNVERIFIED) | FP16 | Fits | 4-step; needs licence clarity |
| 22 | SEINE | UNVERIFIED | Apache code; **weights conditional** | First+last transition | UNVERIFIED | UNVERIFIED | Probably fits | Unique transition mode; licence unclear |
| 23 | ConsistI2V | ~2B | MIT | First frame | UNVERIFIED | UNVERIFIED | Likely fits | 256×256, dormant since 2024 |
| 24 | Open-Sora-Plan v1.3 | ~2B DiT | MIT | First+last (v1.2) | 24 GB official | BF16 | ❌ No | Ascend-only future |
| 25 | EasyAnimate V5.1 | 7B / 12B | Apache 2.0 | First frame (InP) | 16 GB path needs FP8 | BF16/FP8 | ❌ No | Too big; weights exceed disk |

**Honest count note:** 25 engines qualify as real and free. Of those, only **~8 are credible production or backup candidates for NOVA on a T4** (ranks 1–8, with caveats). Ranks 9–17 are feature/specialist candidates or need a proof run to resolve a specific open question. Ranks 18–25 are weak, dated, T2V-only, licence-unclear, or T4-infeasible — included because they are real free engines with evidence, not because NOVA should use them.

---

## Per-engine evidence

### #1 — LTX-Video 2B distilled (0.9.8) — Lightricks — PRODUCTION ENGINE

- **Params:** ~2B (transformer 1.92B + VAE 1.25B measured in-session). Checkpoint 6.34 GB.
- **Licence:** LTXV Open Weights License 0.X — no non-compete; $10M revenue threshold; SaaS hosting expressly permitted; three obligations (disclosure, user restrictions + notice, redistribution conditions). Lightricks letter sent 22 Nov 2026, reply still outstanding.
- **T2V / I2V:** Both; native first+last-frame conditioning (`LTXConditionPipeline`).
- **Resolution / frames:** Proven 1024×576, 17 and 49 frames; 768p-class tested externally.
- **Precision:** FP16 native in the diffusers adaptation (0 BF16 params measured before and after sampling). The native repo config is BF16 two-pass — not used on T4.
- **VRAM / speed (measured on NOVA's Kaggle T4):** 6.92 GiB peak @ 17f, 8.68 GiB @ 49f; sampling 7.2 s @ 17f, 13.3 s @ 49f; total notebook ~180–220 s including load.
- **Pipeline:** diffusers 0.40.0 `LTXConditionPipeline.from_single_file`, FP16.
- **Community:** Lightricks/LTX-Video repo; 0.9.x line now frozen upstream (see flag above).
- **Sources:** `ltx-proof-evidence-2026-11-24.md` (NOVA's own runs 1–9); huggingface.co/Lightricks/LTX-Video; LTXV Open Weights License 0.X text.
- **Verdict:** The production engine. Every other candidate is judged against it.

### #2 — Wan2.1-Fun-1.3B-InP (Fun-InP) — Alibaba PAI — STRONGEST NEW CANDIDATE

- **Params:** 1.3B (Wan2.1-T2V-1.3B fine-tune with inpainting conditioning). 14B sibling exists.
- **Licence:** Apache 2.0 (HF repo metadata). No territorial/revenue restriction found.
- **T2V / I2V:** T2V + I2V with **first-frame AND optional last-frame conditioning** — the only true first+last-frame model in the new batch. Model zoo: "supporting start and end frame prediction." V1.1 refresh exists (`Wan2.1-Fun-V1.1-1.3B-InP`, collection updated 9 Oct 2025; repos updated 11 Dec 2025).
- **Resolution / frames:** Multi-resolution training (512/768/1024); 81 frames @ 16 fps (~5 s).
- **Precision:** BF16 (ComfyUI file `wan2.1_fun_inp_1.3B_bf16.safetensors`). FP16 cast needed for T4 — UNVERIFIED as published.
- **VRAM:** UNVERIFIED as a vendor figure. Third-party: Pineido says fits 6 GB; runcomfy recommends `model_cpu_offload` for 1.3B. By analogy to the 1.3B base (8.19 GB vendor), expect ~8–12 GB — inference, not measurement. Diffusion model alone ~7 GB; full HF repo storage 19.0 GB (includes VAE + text encoder + full-precision files).
- **Speed:** UNVERIFIED for InP specifically. Base 1.3B vendor claim (~4 min/5 s 480p on RTX 4090) is the only anchor.
- **T4 fit:** Likely fits (1.3B class), but exact peak VRAM is UNVERIFIED — needs a proof run. BF16→FP16 conversion likely needed for speed.
- **Pipeline:** Native via `aigc-apps/VideoX-Fun` (predict_i2v.py / predict_t2v.py); native ComfyUI support (`WanFunInpaintToVideo` node); community diffusers conversion exists (`weizhou03/Wan2.1-Fun-1.3B-InP-Diffusers`, unofficial). NOT in official diffusers.
- **Community:** HF collection `alibaba-pai/wan21-fun-v11` — 2.95k downloads, 9 likes (crawled ~Apr 2026). ComfyUI docs updated 13 Nov 2026. GitHub stars UNVERIFIED.
- **Sources:** huggingface.co/collections/alibaba-pai/wan21-fun-v11; github.com/aigc-apps/VideoX-Fun; docs.comfy.org/tutorials/video/wan/fun-inp. V1.0 ~Apr–Jun 2025; V1.1 Oct 2025. No paper found (UNVERIFIED).
- **Verdict:** Strongest new candidate — the only true first+last-frame I2V at 1.3B with a clean Apache 2.0 licence. VRAM/speed need a proof run.

### #3 — FastWan (FastVideo) — Hao AI Lab, UC San Diego

- **Params:** 1.3B (T2V); FastWan2.2-TI2V-5B also exists (text+image-to-video, 5B). DMD2 + Video Sparse Attention distillation of Wan2.1-T2V-1.3B from 50 → **3 denoising steps**; full checkpoints, not LoRA.
- **Licence:** Apache 2.0 — weights + training recipe + 600K-sample synthetic dataset, all Apache-2.0. No territory/revenue/SaaS restriction.
- **T2V / I2V:** T2V (1.3B); TI2V-5B does text+image-to-video (first-frame). No last-frame.
- **Resolution / frames:** 5 s, 832×480, 81 frames @ 16 fps (1.3B). TI2V-5B: 720p.
- **Precision:** Wan2.1 is BF16-native — T4 has no BF16 tensor cores. FP16 fallback UNVERIFIED. FastWan-QAD is FP8 — does NOT run natively on T4; exclude the QAD variant.
- **VRAM:** FastWan-specific VRAM UNVERIFIED. Teacher Wan2.1-1.3B needs 8.19 GB (vendor figure) — fits a T4 in principle.
- **Speed (measured, author-reported):** 5-s 480p clip in **5 s end-to-end on one H200** (1 s denoising) and **21 s on one RTX 4090** (2.8 s denoising). QAD: ~3.4 s on RTX 4090 (FP8, T4-inapplicable).
- **T4 fit:** Plausible but unproven — 1.3B/8 GB class fits; the open question is purely BF16→FP16 behaviour on Turing.
- **Pipeline:** Diffusers (`WanDMDPipeline`, `FastVideo/FastWan2.1-T2V-1.3B-Diffusers`) + native FastVideo repo.
- **Community:** `hao-ai-lab/FastVideo`, org huggingface.co/FastVideo. Active 2025–2026. Star counts UNVERIFIED.
- **Sources:** huggingface.co/FastVideo; github.com/hao-ai-lab/FastVideo; haoailab.com/blogs/fastmetal/.
- **Verdict:** The best commercial-clean few-step candidate — Apache-2.0, 3 steps, 480p/5s, diffusers-native. Needs one T4 FP16 validation run before any commitment.

### #4 — SANA-Video 2B (v1) — NVIDIA / MIT HAN Lab — VERIFIED THIS ROUND

- **Naming correction:** SANA-Video **v1** is the 2B model; SANA-Video **2.0** is a separate 5B/14B family. Prior records conflated them.
- **Params:** 2B DiT; full 480p checkpoint ≈14 GB on disk incl. Gemma text encoder (third-party DeepJ docs).
- **Licence:** Apache 2.0 (repo LICENSE + model card). No geographic exclusions, no revenue threshold, no non-compete. Model card says "intended for research purposes only" as a use description, but the licence itself is Apache 2.0 — no commercial restriction in the licence text. No US exclusion.
- **T2V / I2V:** Both. `SanaVideoPipeline` (T2V) and native `SanaImageToVideoPipeline` (first-frame I2V) in diffusers; vLLM-Omni docs confirm end-to-end I2V serving validation at 480p and 720p. `LongSanaVideoPipeline` (LongLive variant) for 81–961 frames (5–60 s).
- **Resolution / frames:** 480p: 480×832, 81 frames (5 s @ 16 fps). 720p: 704×1280, 81 frames, uses LTX-2 Video VAE (480p uses Wan VAE). LongLive variant: up to 60 s.
- **Precision:** **BF16-native.** Diffusers docs: transformer BF16 recommended; text encoder and VAE "must stay in torch.bfloat16 or torch.float32 for the model to work correctly." **No official FP16 path documented for SANA-Video.** FP16 load via diffusers `torch_dtype` is mechanically possible but UNVERIFIED for correctness/quality. Caution: SANA issue #297 (image model) recorded float16 producing a uniform gray image on MPS — different branch, but shows FP16 is not a tested path in this codebase.
- **VRAM — MEASURED:** ICLR 2026 paper, Fig. 1(c): **7.2 GB flat vs. video length** (constant-memory KV cache) — measured, but the GPU is not stated in the extracted paper text. Secondary: selfhost.directory lists ≈5.0 GB for the 720p checkpoint (their estimate, methodology unknown — treat as unconfirmed). No community T4 measurement found.
- **Speed — MEASURED (authors):** 36 s latency for 720p/81f/50 steps (paper Fig. 1(b); GPU unstated in extract, presumably H100-class); 71 s → 29 s for 5 s 720p with NVFP4 on RTX 5090 (2.4×). 16× faster than Wan 2.1-1.3B in measured latency (authors' claim). VBench 84.05.
- **T4 fit:** VRAM fits easily (7.2 GB measured ≪ 15 GB). The blocker is **precision, not memory**: BF16 has no native tensor-core support on Turing — BF16 would run via FP32 emulation (slow) or need an FP16/INT8 conversion that is UNVERIFIED. INT4 via SVDQuant/Nunchaku exists for SANA *image* models; no verified INT4 path for SANA-Video.
- **Pipeline:** Native NVlabs repo + full diffusers support + ComfyUI, SGLang, vLLM-Omni.
- **Community:** github.com/NVlabs/Sana — 9,885 stars, 815 forks, very active (latest news entry 2026/11 SANA-Robot).
- **Sources:** github.com/NVlabs/Sana; huggingface.co/Efficient-Large-Model/SANA-Video_2B_480p_diffusers; huggingface.co/Efficient-Large-Model/SANA-Video_2B_720p_diffusers; paper arXiv 2509.24695 (Sep 2025); weights released 27 Oct 2025; diffusers merge 6 Nov 2025; ICLR 2026 Oral (accepted 26 Jan 2026). Project: nvlabs.github.io/Sana/Video/.
- **Verdict:** Best VRAM profile of any candidate and the only one with a measured sub-8 GB footprint — but BF16-native with no verified FP16 path, so T4 viability hinges on an unproven precision conversion. Worth a precision-conversion experiment, not a drop-in.

### #5 — Allegro-TI2V — Rhymes AI — NAMED BACKUP (reviewer, 24 Nov)

- **Params:** DiT 2.8B + VideoVAE 175M (vendor publishes them separately).
- **Licence:** Apache 2.0. Cleanest licence in the field — no revenue threshold, no geographic exclusion, no non-compete, no output-ownership claim.
- **T2V / I2V:** Text+image-to-video: **required first frame, optional last frame**. Training jointly covers first-frame-to-video, first&last-frames-to-video, and video-continuation.
- **Resolution / frames:** Fixed 720×1280, 88 frames, 6 s @ **15 fps** (below NOVA's 24 fps delivery — needs frame-rate conversion; 30 fps only via EMA-VFI interpolation, an extra step).
- **Precision:** VAE FP32/TF32/BF16/FP16; DiT/T5 BF16/FP32/TF32 — **no FP16 for the DiT**. BF16 on Turing is emulation.
- **VRAM:** 9.3 GB BF16 with CPU offload; 27.5 GB without (vendor model-card figures). Fits a T4 only with offload. Download 24.3 GB strains /kaggle/working (20 GB) unless scoped.
- **Speed:** ~20 min per 6 s clip on a single H100; ~3 min on 8×H100 (vendor). Community reports ~1 hour on an RTX 3090, ~30 min on a 4090, with the TI2V pre-inference phase spiking >30 GB VRAM. On a T4 this would be far slower — likely 1–2+ hours per clip (estimate, UNVERIFIED).
- **T4 fit:** Fits with offload, but speed is disqualifying for production throughput.
- **Pipeline:** Native + diffusers integration (merged in diffusers 0.32.0-dev). Python ≥ 3.10, PyTorch ≥ 2.4, CUDA ≥ 12.4.
- **Community:** github.com/rhymes-ai/Allegro — 1,137 stars, 84 commits, created 2024-10-16. Last news 2025-02-07 (Presto release); no 2026 activity found. Pinned-reproducible by commit.
- **Sources:** github.com/rhymes-ai/Allegro; huggingface.co/rhymes-ai/Allegro-TI2V. Open-sourced 25 Nov 2024.
- **Verdict:** The strongest backup on licence cleanliness and true first+last-frame I2V. Test only if LTX is blocked on licence or quality. It cannot be the core engine at this speed.

### #6 — SkyReels V2 1.3B DF (Diffusion Forcing) — Skywork AI

- **Params:** 1.3B (DF variant). 14B and (unreleased) 5B siblings; 5B still "Coming Soon" as of Aug 2026.
- **Licence:** **CONFLICT — UNVERIFIED which governs.** Some sources say Apache 2.0; ComfyUI Wiki lists "SkyReels-V2 Community License"; the sota-reference table says "custom (verify)". The HF model card is tagged "skywork-license". **Do not adopt until the licence file in `SkyworkAI/SkyReels-V2` is read directly.** Commercial use is explicitly permitted per some readings, but it is a custom non-OSI licence either way.
- **T2V / I2V:** Both, plus start/end-frame and shot extension; Diffusion Forcing enables **infinite-length autoregressive generation** (repo documents 60 s / 1,457 frames in one session). Built on Wan2.1.
- **Resolution / frames:** 960×544 @ 24 fps; 97 base frames, extendable to 257–737+ (async mode; block-boundary artefacts reported in GitHub issue #90).
- **Precision:** **FP16, fp8_e4m3fn, fp8_e5m2** — FP16-native, T4-friendly.
- **VRAM:** ~14.7 GB peak for 540p on the 1.3B — vendor README figure (with offload/TeaCache). Leaves ~0.7 GB headroom on a 15.36 GB T4. Lowering `--base_num_frames` (77/57) reduces peak per README.
- **Speed:** UNVERIFIED — no generation-time figure found.
- **T4 fit:** Tight — feasible but fragile; needs a proof run.
- **Pipeline:** Native repo; diffusers docs cover it; ComfyUI via custom nodes (UNVERIFIED which).
- **Community:** github.com/SkyworkAI/SkyReels-V2 — 7,806 stars. Paper arXiv:2504.13074 (17 Apr 2025). Released 21–24 Apr 2025. Note: SkyReels V4 exists but has no open weights as of Aug 2026 (API/preview only).
- **Sources:** huggingface.co/Skywork/SkyReels-V2-DF-1.3B-540P; github.com/SkyworkAI/SkyReels-V2; arXiv:2504.13074.
- **Verdict:** Candidate IF the licence resolves to Apache 2.0 — the only FP16-native infinite-length 1.3B in the field; VRAM is knife-edge on a T4.

### #7 — FramePack F1 — lllyasviel

- **Params:** 13B HunyuanVideo backbone; checkpoint `lllyasviel/FramePackI2V_HY`; 30 GB+ download.
- **Licence:** Code Apache 2.0, but the weights are derived from HunyuanVideo, so they carry the **Tencent Hunyuan Community License** (EU/UK/South Korea exclusion, 100M MAU threshold) — not Apache 2.0. The README does not spell this out; verify the specific checkpoint.
- **T2V / I2V:** I2V-only design. First+last frame via community PR #167 / diffusers. **Long-form: up to 60 s at 30 fps (1,800 frames)** from one still — unique in this list.
- **Resolution / frames:** Modest resolution rather than HD; up to 1,800 frames.
- **Precision:** BF16 (HunyuanVideo lineage).
- **VRAM:** 6 GB minimum with offload (official README: "the minimal required GPU memory is 6GB"). Memory cost is O(1) — frame 1,800 costs the same as frame 30.
- **Speed:** 2.5 s/frame on an RTX 4090, 1.5 s/frame with TeaCache; laptop GPUs 4–8× slower. A 5-second clip (150 frames) is ~4 min on a 4090 and ~25–50 min on laptop-3060-class hardware. On a T4, expect ~30–60 min per 5 s clip.
- **T4 fit:** Fits (6 GB min) but far too slow for NOVA's clip pipeline. README requires RTX 30XX/40XX/50XX — T4 not listed; no T4 proof. 30 GB+ download exceeds /kaggle/working (20 GB); needs a dataset mount.
- **Pipeline:** Native repo + diffusers (`HunyuanVideoFramepackPipeline`). F1 variant (May 2025, simpler/faster).
- **Community:** github.com/lllyasviel/FramePack — 17,356 stars (Nov 2026).
- **Sources:** github.com/lllyasviel/FramePack; shotcraft.video/models/framepack/ (licence caveat).
- **Verdict:** The long-form champion (60 s from one image is unique), but far too slow for NOVA's clip pipeline on a T4, and the weights licence is murky. Best as a second-phase option for long scenes, not the core engine.

### #8 — LingBot-Video Dense 1.3B — Robbyant (Ant Group)

- **Params:** Dense 1.3B (and MoE 30B-A3B, ~3B active/token — far out of T4 range). Rewriter is Qwen3.6-27B (base + LoRA adapter).
- **Licence:** Apache 2.0. No geographic exclusions, no revenue/non-compete terms.
- **T2V / I2V:** T2I, T2V, TI2V (text+image-to-video, first-frame). **Quirk: the DiT consumes structured JSON captions, not natural-language prompts** — the intended workflow is prompt → Qwen3.6-27B rewriter → JSON → DiT (+ auto-negative step). Plain prompts without rewriting are off-recipe.
- **Resolution / frames:** 832×480, 81 frames (trained window; longer "collapses to noise" per community testing), 24 fps. DMD examples: 121 frames @ 832×480.
- **Precision:** BF16 DiT/text encoder, FP32 VAE (official flags). FP8 workflows documented for MoE via SGLang. **FP16 path: UNVERIFIED.**
- **VRAM — MEASURED (community + official):** Dense 1.3B DiT is 2.79 GB in BF16; the Qwen3-VL text encoder is ~8 GB (community ComfyUI pack loads it on CPU, encodes, frees it, then runs the DiT). **Community-verified: Dense 1.3B runs on an RTX 3070 8 GB / 16 GB RAM** (RealRebelAI ComfyUI nodes); DiffSynth-Studio claims a 6 GB VRAM minimum with VRAM management. MoE: official DMD 5 s example measured ~82 GiB peak allocated — far out of range.
- **Speed — MEASURED (community):** Dense 1.3B, 832×480×81f, 40 steps: ~14 s/iteration on RTX 3070, ≈10 min per 81-frame clip (sequential CFG). No official Dense speed table found.
- **T4 fit:** Dense 1.3B fits VRAM comfortably (8 GB card proven), but BF16-on-Turing speed is the open question, and the JSON-caption + 27B-rewriter workflow adds heavy pipeline complexity. Robotics/embodied training bias (70,000+ h embodied data) — quality on NOVA's fantasy/drama content is UNVERIFIED. Pinned stack is bleeding-edge (torch 2.12.0.dev+cu130, transformers 5.8.1, diffusers 0.39.0) — T4 compatibility UNVERIFIED.
- **Pipeline:** Native repo + diffusers (`LingBotVideoPipeline`) + SGLang Diffusion backend; ComfyUI community nodes exist.
- **Community:** github.com/Robbyant/lingbot-video — 988 stars, 46 forks, 10 commits, created 2026-07-08.
- **Sources:** github.com/Robbyant/lingbot-video; huggingface.co/robbyant/lingbot-video-dense-1.3b; paper arXiv 2607.07675 (submitted 8 Jul 2026). Project: technology.robbyant.com/lingbot-video.
- **Verdict:** The dense 1.3B is a genuine small-GPU candidate with community proof on 8 GB cards, but BF16-only, slow (~10 min/clip on a 3070), and built around a JSON-caption + 27B rewriter workflow for robotics content. Backup candidate only; LTX remains better aligned.

### #9 — Wan2.1-VACE-1.3B — Alibaba Tongyi Lab (ali-vilab)

- **Params:** 1.3B DiT (Wan2.1-T2V-1.3B backbone + VACE Context Adapter).
- **Licence:** Apache 2.0 — confirmed in the VACE repo model table and on the HF model card. No territorial/revenue restriction found.
- **T2V / I2V:** T2V + all-in-one creation/editing (reference-guided generation R2V, video-to-video restyling, masked inpainting, outpainting, first+last-frame extension via "Expand-Anything"). **Important: VACE takes a reference image only as a loose guide — it does NOT animate a first frame the way a true I2V model does.** It can extend a static first+last frame into a continuous shot, which is adjacent to but not the same as NOVA's keyframe-animation need.
- **Resolution / frames:** 832×480, 81 frames (~5 s @ 16 fps). 14B sibling does 720p.
- **Precision:** BF16 in diffusers (`Wan2.1-VACE-1.3B-diffusers`, dtype bf16); native repo also BF16-oriented. FP16 cast needed for T4 — UNVERIFIED whether anyone has published an FP16 VACE-1.3B.
- **VRAM:** 8–12 GB claimed (aifilms, with `--offload_model`). Community-measured: ~12 GB at 832×480×81 with no offloading after Kijai's Apr 2025 memory optimisations (banodoco-kb, fp32+VACE); ~7.7 GB at 512×512×57. Base T2V-1.3B vendor figure is 8.19 GB. No vendor-published VACE-specific peak found.
- **Speed:** UNVERIFIED on any GPU. Expect Wan-1.3B-class ~4 min/5 s on a 4090 as a floor; T4 slower.
- **T4 fit:** Fits 15 GB at 480p/81f with offload; tight without. Needs FP16 conversion work for speed.
- **Pipeline:** Native (`ali-vilab/VACE`, needs SAM2/Depth-Anything-V2/DWpose annotators for full editing modes) and diffusers (`WanVACEPipeline`, diffusers ≥ 0.34.0). Also native ComfyUI support.
- **Community:** github.com/ali-vilab/VACE — 4,066 stars, 300 forks, 19 commits (crawled ~18 Nov 2026). Repo news ends 14 May 2025 (1.3B/14B release). Wan2.1 base repo: 17,487 stars, last code change 2026-03-05.
- **Sources:** github.com/ali-vilab/VACE; huggingface.co/Wan-AI/Wan2.1-VACE-1.3B; paper arXiv:2503.07598 ("VACE: All-in-One Video Creation and Editing", ICCV 2025). Released 14 May 2025 (preview 31 Mar 2025).
- **Verdict:** Candidate as an editing/extension tool, not as NOVA's core keyframe animator — VACE doesn't do true first-frame I2V.

### #10 — Phantom-Wan-1.3B — ByteDance Intelligent Creation

- **Params:** 1.3B (fine-tuned Wan2.1-T2V-1.3B; replaces the base checkpoint entirely). 14B and 14B-Pro siblings exist. 1.3B released 21 Apr 2025.
- **Licence:** Apache 2.0 per HF repo frontmatter and multiple secondary sources. Caveat: the repo's own LICENSE file was not directly read and the Apache-2.0 attribution is partly inherited from Wan — read the LICENSE file before production use. No territorial/revenue restriction found.
- **T2V / I2V:** **Subject-to-video (S2V), NOT first-frame I2V.** Takes 1–4 reference images (character/wardrobe/prop) + text and generates a video preserving subject identity. It does not animate a given first frame into a clip. Complementary to NOVA's keyframe animation, not a replacement.
- **Resolution / frames:** 832×480 (and 720p supported per README); 81 frames standard.
- **Precision:** FP16 and FP32 listed for 1.3B (ComfyUI wiki); FP8 variants exist for 14B via community GGUF. **FP16-native — T4-friendly.**
- **VRAM:** ~8 GB claimed (third-party) to 10–16 GB (aifilms). No vendor-published peak found — claimed, not measured. Requires the base Wan2.1-T2V-1.3B download too (VAE + text encoder).
- **Speed:** UNVERIFIED. One community datapoint: VACE+Phantom merge, 832×480×81, ~15 min on an RTX 3060 — not a clean 1.3B measurement.
- **T4 fit:** Likely fits at 480p (1.3B + FP16). Needs proof run.
- **Pipeline:** Native (`generate.py --task s2v-1.3B`); ComfyUI via Kijai's WanVideoWrapper (since 23 Apr 2025); GGUF quantised checkpoints via QuantStack. NOT in official diffusers (UNVERIFIED — no diffusers pipeline found).
- **Community:** github.com/Phantom-video/Phantom — ~1,536 stars, last push 11 Sep 2025 (flagged "inactive"). ICCV 2025 acceptance (26 Jun 2025). Repo looks unmaintained since mid-2025.
- **Sources:** github.com/Phantom-video/Phantom; huggingface.co/bytedance-research/Phantom; paper arXiv:2502.11079 (16 Feb 2025; full version 10 Apr 2025). Project: phantom-video.github.io/Phantom/.
- **Verdict:** Candidate for a character-consistency feature, not for core keyframe animation; repo is quiet since Sep 2025.

### #11 — Bernini-R-1.3B — ByteDance

- **Params:** Bernini-R-1.3B (fine-tuned from Wan2.1-1.3B, released 9 Jun 2026). Full Bernini is Qwen2.5-VL-7B planner + 14B Wan2.2 renderer ("7+14B") — out of T4 range.
- **Licence:** Apache 2.0. No geographic exclusions, no revenue/non-compete terms.
- **T2V / I2V:** Unified task interface: t2i, i2i, t2v, v2v, rv2v, r2v (reference-to-video from one or more reference images). Editing is its strength (first-tier vs closed models on video editing per authors); raw T2V quality trails the strongest closed systems (authors' own note).
- **Resolution / frames:** Defaults 480p / 16 fps; examples up to 720p/24fps, 121 frames.
- **Precision:** BF16 (Wan2.1/2.2 base). FP16 path: UNVERIFIED.
- **VRAM:** No Bernini-specific VRAM figure published. Nearest proxy: base Wan2.1-1.3B officially needs 8.19 GB VRAM. Bernini-R-1.3B additionally loads the UMT5 text encoder + VAE, so expect more than 8.19 GB — UNVERIFIED, do not assume it fits. The 14B variants need H100-class multi-GPU.
- **Speed:** UNVERIFIED — no published seconds-per-clip for any Bernini variant.
- **T4 fit:** 1.3B renderer plausibly fits 15 GB by the Wan proxy, but unproven; the full 7+14B pipeline does not. Prompt enhancer needs an OpenAI-compatible endpoint (external dependency, "highly recommended"). Hopper recommended (FlashAttention-3), falls back to FA2/SDPA on other CUDA GPUs. Pinned torch 2.5.1+cu124 (Bernini-R) / 2.7.1+cu126 (full Bernini).
- **Pipeline:** Native repo (diffusers-format checkpoints, `infer_single_gpu.py` / `infer_multi_gpu.py`); requires Open-VeOmni for multi-GPU.
- **Community:** github.com/bytedance/Bernini — 1,373 stars, 107 forks, 22 commits, created 2026-05-29.
- **Sources:** github.com/bytedance/Bernini; huggingface.co/ByteDance/Bernini-R-1.3B-Diffusers; paper arXiv 2605.22344 (22 May 2026; revised 2 Sep 2026). Project: bernini-ai.github.io.
- **Verdict:** Real open model, clean licence, but an editing-first framework with no published VRAM or speed numbers — the 1.3B renderer is a maybe, the full system is out of reach. Low priority; needs a VRAM probe before any commitment.

### #12 — HunyuanVideo 1.5 — Tencent

- **Params:** 8.3B DiT + Qwen2.5-VL 7B text encoder (+ small glyph encoder). Down from 13B in v1.0.
- **Licence:** **Tencent Hunyuan Community License — EXCLUDES the EU, UK, and South Korea.** The US is NOT excluded, so Shina (US-based) is covered — but flag the exclusion for any EU/UK user or deployment. Also carries "use, distribution and commercial-scale conditions" (exact thresholds UNVERIFIED — read the licence before commercial use). Not Apache/MIT. GitHub licence field shows NOASSERTION.
- **T2V / I2V:** Both, built-in (I2V was a separate model in v1). First-frame I2V. 480p/720p native, 121 frames (~10 s @ 24 fps); separate super-res model to 1080p.
- **Precision:** FP16 and FP8 builds exist (ComfyUI template: FP16 diffusion 16.65 GB + FP8-scaled text encoder 9.38 GB; FP8-scaled distilled I2V diffusion 8.33 GB).
- **VRAM:** Tencent's own figure: **14 GB minimum with offloading**. FP16 diffusion stage alone is 19.2 GB in ComfyUI's template (computed 3 Nov 2026 from exact file sizes); FP8-scaled route: 10.9 GB largest stage. Measured: 14.3 GB peak at 480p FP8 on an RTX 5060 Ti 16 GB, 11 min/clip (vramready.com). Community integrations (LightX2V, Wan2GP) claim as little as 6 GB (UNVERIFIED).
- **Speed:** Step-distilled I2V (Dec 2025, 8–12 steps): ~75 s for a 480p I2V clip on a single RTX 4090 (vendor README claim). On a T4, expect an order of magnitude slower.
- **T4 fit:** Marginal. The 14 GB minimum assumes offloading; FP16 weights alone (16.65 GB diffusion) exceed one T4, so it needs offload + the FP8 path — and **FP8 is not native on T4**, so the FP8 build's speed on T4 is UNVERIFIED and likely poor. Host RAM ~31 GB is also a constraint for offloading a 29 GB template download. Full repo is 372 GB on HF across all variants; the single FP16 checkpoint is ~16.7 GB, FP8 ~8.3 GB.
- **Pipeline:** Native repo + diffusers + ComfyUI + LightX2V support; training code published.
- **Community:** github.com/Tencent-Hunyuan/HunyuanVideo-1.5 — 4,616 stars, 120 commits, created 2025-11-20. Actively maintained (FP8 GEMM support Dec 23, 2025; step-distilled I2V Dec 5, 2025; training code + LoRA Dec 5, 2025). HunyuanVideo repo ~12,000 stars.
- **Sources:** github.com/Tencent-Hunyuan/HunyuanVideo-1.5; huggingface.co/Tencent-Hunyuan/HunyuanVideo-1.5; willitrunai.com (VRAM); vramready.com (measured 14.3 GB). Released 20 Nov 2025.
- **Verdict:** Strong quality and a real 14 GB floor, but FP8 is the wrong precision for Turing, the licence excludes three major markets, and no Kaggle run exists. Revisit only if NOVA moves to Ampere-or-newer hardware.

### #13 — Open-Sora 1.2 / 1.3 — HPC-AI Tech

- **Params:** 1.1B diffusion (STDiT3-XL/2) + 384M VAE (1.2; 1.3 also 1.1B per its report). Text encoder is **T5-XXL (DeepFloyd/t5-v1_1-xxl, ~11B)** — a heavy encoder that dominates load/offload planning.
- **Licence:** Apache 2.0 (repo + weights). No US exclusion, no revenue threshold, no non-compete found.
- **T2V / I2V:** Both in one model, plus V2V and video extension. I2V is first-frame conditioned. No first+last-frame mode in 1.x.
- **Resolution / frames:** 1.3: 0–113 frames, 360p & 720p, any aspect ratio, 24fps (demos 5s 720×1280). 1.2: 0–16s, 144p–720p; 720p at 8s/16s marked "inference-only, needs >1× 80GB GPU + sequence parallelism" in its own report.
- **Precision:** **BF16** — the official v1.2 inference config sets `dtype = "bf16"` (verified in the config file). Flash attention enabled by default; SDPA backend added in 1.3. **No documented FP16 inference path found** — FP16 viability on T4 is UNVERIFIED.
- **VRAM:** No official 1.2/1.3 VRAM figure published. Third-party: aifetchly benchmark table lists 18.2GB peak @720p on A100 for 1.2 (third-party claim, not an official measurement); roundup guides list 16–24GB minimum. 1.3 VRAM UNVERIFIED.
- **Speed:** 1.2: ~120s per 720p clip on A100 (aifetchly, third-party). 1.3 speed UNVERIFIED.
- **T4 fit:** Marginal, proof-run required. 1.1B DiT is small, but T5-XXL + BF16-only + ~18GB (third-party) @720p means 720p likely needs offload; 360p is the realistic T4 target. BF16 on T4 runs without tensor-core acceleration. No quantisation path documented.
- **Pipeline:** No official diffusers pipeline. Only an unmerged 2024 test PR (#7561, "[don't merge]", stale). Native `opensora` package + ColossalAI; ComfyUI via third-party nodes.
- **Community:** github.com/hpcaitech/Open-Sora/ — 29,949 stars, 3,101 forks, 1,333 commits — by far the largest community in the older batch. Repo is active but main is now 2.0 (11B, ruled out); 1.2/1.3 live on frozen branches. 1.3 released 20 Feb 2025; 1.2 on 17 Jun 2024.
- **Sources:** github.com/hpcaitech/Open-Sora/; 1.3 report docs/report_04.md; 1.2 tech report arXiv:2412.20404; HF weights `hpcai-tech/OpenSora-STDiT-v3`, `hpcai-tech/OpenSora-VAE-v1.2`.
- **Quality age:** Mid-2024 to early-2025 DiT. Better than the UNet-era models (rectified flow, 3D VAE) but visibly behind 2025–26 models; 1.2 demos carry watermarks on some samples.
- **Verdict:** The only licence-clean, small-enough older engine worth a T4 proof run — test 360p FP16 feasibility and measure real VRAM/speed before any commitment. 720p on T4 is unlikely without offload.

### #14 — Pyramid-Flow — jy0205

- **Params:** ~2B (miniFLUX variant). 10 s @ 768p / 24 fps (5 s @ 384p).
- **Licence:** MIT (per repo licence field; Shotcraft also lists MIT for weights). Clean.
- **T2V / I2V:** Yes — `generate_i2v` with a first-frame image. **First frame only; no last-frame support** in the official code.
- **Resolution / frames:** 5 s @ 384p; 10 s @ 768p / 24 fps.
- **Precision:** **BF16-only** — README code states `model_dtype, torch_dtype = 'bf16', torch.bfloat16  # Use bf16 (not support fp16 yet)`. BF16 on Turing is emulation.
- **VRAM:** <12 GB with `cpu_offloading=True`; <8 GB with `model.enable_sequential_cpu_offload()` (README). Fits a T4 with offload.
- **Speed:** 5.5 min on a single A100 for 5 s @ 768p — far slower than LTX.
- **T4 fit:** Fits with offload, but BF16-only + stale stack + slow + no last frame.
- **Pipeline:** Native repo. Stale stack: Python 3.8.10, PyTorch 2.1.2 (Oct 2024) — two years behind Kaggle's environment; dependency risk.
- **Community:** github.com/jy0205/Pyramid-Flow — 3,215 stars, 130 commits, created 2024-10-06. Last news 2024-11-13 (768p miniFLUX checkpoint). ICLR 2025 paper. No activity since Nov 2024.
- **Sources:** github.com/jy0205/Pyramid-Flow.
- **Verdict:** Weak backup. Fits and is MIT-licensed, but BF16-only + stale stack + slow + no last frame.

### #15 — SANA-Video 2.0 5B — NVIDIA / MIT HAN Lab

- **Params:** 5B (4.47B actual). 14B (14.25B actual) weights NOT released — architecture/config public only, checkpoint "coming soon."
- **Licence:** Apache 2.0 for the model — BUT it requires Google's **Gemma-2-2b-it text encoder (Gemma Terms of Use, gated)** and the 2.0 5B decodes with the **LTX-2.3 VAE under the LTX-2 Community Licence — free for commercial use only below US$10M annual revenue** (flagged threshold). The 720p checkpoint uses the LTX-2 Video VAE.
- **T2V / I2V:** T2V + TI2V (first frame), 720p 193f @ 24 fps ≈ 8 s. 4-step DMD preview also released (T2V-only).
- **Resolution / frames:** 720p, 81/193 frames.
- **Precision:** BF16 (recommended dtype). T4 caveat again.
- **VRAM:** UNVERIFIED — no published VRAM figure found for the 5B model. (Weights alone ≈9 GB BF16 by arithmetic — estimate, not a measurement.)
- **Speed (authors):** 13.2 s @ 480p, 13.06 s @ 720p/5 s on one H100 (with Sol-Engine); VBench 84.30. 5-s 720p takes 71 s → 29 s (NVFP4) on an RTX 5090.
- **T4 fit:** Unknown — 4.47B BF16 with no VRAM data and no FP16 path. Doubtful.
- **Pipeline:** Native repo + diffusers. 5B 720p checkpoint released Aug 2026.
- **Community:** github.com/NVlabs/Sana — 9,885 stars, very active.
- **Sources:** huggingface.co/Efficient-Large-Model/SANA-Video_2.0_5B_720p; huggingface.co/Efficient-Large-Model/SANA-Video_2.0_5B_720p_4step; github.com/NVlabs/Sana; paper arXiv:2509.24695.
- **Verdict:** Faster and higher-quality than v1, but 5B BF16 with no VRAM data, no FP16 path, and a revenue-threshold VAE dependency. Do not select until a VRAM measurement exists.

### #16 — Kandinsky 6.0 Lite — Sber / Kandinsky Lab

- **Params:** Lite 3B (2B video + 0.6B audio + 0.4B cross-attention). Pro 29B (19B video + 5B audio + 5B cross-attention) — out of range. Each ships in regular (50-step), distilled (10-step PiFlow), and pretrain flavors, plus a separate VSR super-resolution model.
- **Licence:** MIT for code, weights, and diffusers integration — no geographic exclusions, no revenue threshold, no non-compete. Note: Russian origin — Sber is a sanctioned entity in some jurisdictions; the MIT licence itself imposes no restriction, but Shina should be aware of the provenance. This is a flag, not a licence disqualifier.
- **T2V / I2V:** Text-to-audio-video (T2AV) and image-to-audio-video (I2AV, first frame). Since 25 Oct 2026 the native pipeline also supports **first+last frame**, audio-driven video, and video-driven audio. Joint 44 kHz audio + lip-sync in a single pass (its headline feature). Video-only mode available.
- **Resolution / frames:** Fixed 5 s, 121 frames @ 24 fps, base 864×480 (SD); HD uses 768×432 base; Full HD 1920×1080 via the separate SR model. No longer clips, no shot/cut concept.
- **Precision:** BF16 (training and inference; diffusers examples use `torch.bfloat16`). Text encoder Qwen2.5-VL-7B in BF16 (NF4 at the 16 GB preset). Community INT8 ConvRot weights exist (ComfyUI). FP16 path: UNVERIFIED.
- **VRAM — MEASURED (authors' report + repo):** Peak allocated, Pro SD resident weights: 72.8 GiB (H100). Lite resident: 43.5 GiB (SD). With block offload (2 blocks resident): 21.7 GiB peak at the 32/24 GB preset; **16 GB preset: 7.9 GiB (SD) / 13.7 (HD) / 12.3 (Full HD)**. BUT the 16 GB preset needs ~58 GiB host RAM for Pro (Lite's host-RAM need at 16 GB preset is UNVERIFIED) — Kaggle's ~31 GiB host RAM is likely insufficient for Pro at that preset. Lite weights alone ≈8 GB BF16.
- **Speed — MEASURED (repo table, median of 3, non-distilled, excl. load/encode):** Lite SD 5 s clip: 239 s H100, 309 s RTX 5090, 437 s RTX 4090, 1,310 s RTX 5060 Ti 16 GB. Lite Distill SD: 31.2 s H100, 44.2 s RTX 5090, 68 s RTX 4090, 173.7 s RTX 5060 Ti. Pro Distill SD: 87.8 s H100. Note: two sources' tables differ slightly (miraflow vs repo README — e.g. Lite SD H100 239 s vs 143.2 s); the repo README table is the newer/authoritative one — treat the non-distilled H100 numbers as having two published values (discrepancy UNRESOLVED, likely different MagCache/compile settings).
- **T4 fit:** Marginal-to-poor. The 16 GB preset's 7.9 GiB peak would fit VRAM, but (a) host-RAM demand is likely above Kaggle's ~31 GiB for Pro and unverified for Lite, (b) BF16 on Turing without tensor cores, (c) SageAttention compile needs Ampere/Ada/Blackwell — **Turing (T4) support for its attention kernels is UNVERIFIED**, (d) speed is poor — even the distilled Lite takes ~174 s on a 16 GB RTX 5060 Ti, and a T4 would be far slower. The 5 s fixed clip length also mismatches NOVA's longer-clip production.
- **Pipeline:** Native repo (uv + just, Python 3.13/3.14, PyTorch 2.13 required for block offload) + diffusers (`Kandinsky6TI2VAPipeline`, `Kandinsky6SRPipeline`) + ComfyUI, vLLM-Omni, SGLang, FastVideo.
- **Community:** github.com/kandinskylab/kandinsky-6 — 331 stars, 38 forks, 44 commits, created 2026-10-05; latest update 8 Nov 2026.
- **Sources:** github.com/kandinskylab/kandinsky-6; huggingface.co/kandinskylab/Kandinsky-6.0-Lite-5s-Diffusers; technical report arXiv 2610.05608 (submitted 4 Oct 2026); weights + code released 6 Oct 2026. Deep-dive: miraflow.ai/blog/kandinsky-6-0-video-explained-open-source-audio-video-model-2026.
- **Verdict:** Genuinely open (MIT), unique joint audio+lip-sync, but too slow, too heavy, and too short (5 s fixed) for NOVA on T4; the audio stream is also wasted under NOVA's narration-and-dialogue-only rule. Not a production candidate; note only for its lip-sync architecture.

### #17 — Self-Forcing — Adobe Research + UT Austin (NeurIPS 2025 Spotlight)

- **Params:** 1.3B (same weights as teacher Wan2.1-T2V-1.3B under a causal mask; 4 denoising steps per chunk, 5 latent frames per chunk).
- **Licence:** Code Apache-2.0; **WEIGHTS LICENCE UNSPECIFIED** (per a 2026 audit of the release). Teacher Wan2.1 is Apache-2.0, but the released student weights carry no stated licence — verify before commercial use.
- **What it is:** Autoregressive few-step distillation of Wan2.1-T2V-1.3B (DMD-family distribution matching over self-rollouts + rolling KV cache). Fixes CausVid's train-test mismatch; data-free.
- **T2V / I2V:** T2V only (1.3B base). Streams indefinitely via rolling KV cache.
- **Resolution / frames:** 832×480, 81 frames (5 s) @ 16 fps per chunk; unbounded length by autoregression.
- **Precision:** BF16 (Wan lineage) — same T4 caveat as FastWan; FP16 UNVERIFIED.
- **VRAM:** UNVERIFIED.
- **Speed (measured, paper):** 17.0 FPS streaming, 0.69 s first-frame latency on one H100 (chunk-wise); ~16 FPS H100 / ~10 FPS RTX 4090 (project page). VBench total 84.31 — matches/beats the 103 s/clip bidirectional teacher. Training cost: <16 h on 8×H100 (~$300–500 at 2026 spot).
- **T4 fit:** UNVERIFIED — H100/4090 numbers only; BF16 + KV-cache memory unknown on Turing.
- **Pipeline:** Native repo (github.com/self-forcing org), not diffusers.
- **Community:** Paper 9 Jun 2025 (v2 10 Nov 2025). Star count UNVERIFIED.
- **Sources:** Paper arXiv:2506.08009; project self-forcing.github.io.
- **Verdict:** Best speed/quality numbers in the few-step batch (real-time streaming, VBench 84.31), but weights licence unspecified + BF16/T4 unproven. Second-priority validation target after FastWan.

### #18 — Wan 2.1 1.3B (T2V) — Alibaba

- **Params:** 1.3B. 480p, 81 frames at 16 fps (~5 s).
- **Licence:** Apache 2.0 — clean.
- **T2V / I2V:** **No official I2V.** Wan 2.1's official I2V model is the 14B only (I2V-14B-480P/720P). The 1.3B is T2V-only officially; image-to-video on 1.3B exists only via community methods (Fun InP — see #2 — and VACE — see #9). There is **no official Wan2.1-I2V-1.3B**; the diffusers Wan page lists I2V only at 14B.
- **Resolution / frames:** 480p, 81 frames. At 720p, community figures put it at 16–20 GB.
- **Precision:** BF16 (diffusers checkpoints are bf16). FP16 cast needed for T4.
- **VRAM:** 8.19 GB (official Wan2.1 README: "The T2V-1.3B model requires only 8.19 GB VRAM, making it compatible with almost all consumer-grade GPUs.").
- **Speed:** 5-second 480p clip in about 4 minutes on an RTX 4090 (official figure).
- **T4 fit:** Fits at 480p, but T2V-only and the Wan family was cancelled by Shina after repeated proof failures (Wan 2.2 TI2V-5B, five failed attempts, 3.75 GPU-h). Dropping to the smaller sibling keeps the family risk and gives up I2V (officially) and 720p.
- **Pipeline:** Native repo + diffusers. Widely run on consumer GPUs; no specific Kaggle proof found.
- **Community:** Wan2.1 base repo 17,487 stars, last code change 2026-03-05.
- **Sources:** Wan2.1 repo; huggingface.co/docs/diffusers (Wan pipeline).
- **Verdict:** Only worth it as a fallback if every other candidate fails — and the Fun-InP and VACE derivatives (#2, #9) are better uses of the same 1.3B backbone.

### #19 — Latte-1 — Vchitect (Monash / Shanghai AI Lab / NJU / NTU)

- **Params:** UNVERIFIED — no parameter count found in the paper excerpts, README, or diffusers docs. The pipeline carries a **T5-XXL (t5-v1_1-xxl) text encoder**, which dominates memory; do not quote a transformer size without a source.
- **Licence:** Apache 2.0 (code + `maxin-cn/Latte-1` Hub repo). No territory, revenue, or SaaS restriction found. T5 weights are Apache-2.0 (Google). Clean.
- **What it is:** A standalone Latent Diffusion Transformer (DiT) for video — the first DiT video backbone of note. T2V checkpoint Latte-1 initialised from PixArt-α.
- **T2V / I2V:** T2V and T2I only (`video_length=16` or 1). No I2V.
- **Resolution / frames:** 16 frames @ 512×512, 50 inference steps default, guidance 7.5. Academic benchmarks (FaceForensics, SkyTimelapse, UCF101, Taichi-HD) at 256×256.
- **Precision:** FP16 (diffusers example uses fp16).
- **VRAM:** 17 GB full precision → 9 GB with 4/8-bit quantisation (Latte README, author-stated, Jul 2024). That 17 GB figure is the pipeline total incl. T5-XXL.
- **Speed:** 16.2 s avg without torch.compile, 14.6 s with compile, on an 80 GB A100 (diffusers official benchmark, 16f/512²; step count for the benchmark UNVERIFIED, presumably 50).
- **T4 fit:** DOES NOT FIT NATIVELY (17 GB > 15 GB) — needs the 8-bit quant path (9 GB, INT8 runs natively on T4) or CPU offload. Feasible but unproven on T4.
- **Pipeline:** Diffusers `LattePipeline` (integrated 11 Jul 2024) + native PyTorch repo.
- **Community:** github.com/Vchitect/Latte — 1,949 stars, 190 forks, created 28 Oct 2023, last push 10 Aug 2026 (still lightly touched). TMLR 2025. Latte-1 released 23 May 2024.
- **Quality:** SOTA on its four 2023 academic benchmarks and "comparable to recent T2V models" in early 2024 — but that is a 2024 bar; 512²/16f/50-step with no I2V is a generation behind LTX/Wan-class output.
- **Sources:** github.com/Vchitect/Latte; huggingface.co/maxin-cn/Latte-1; paper arXiv:2401.03048 (5 Jan 2024); diffusers docs (Latte pipeline).
- **Verdict:** Licence-clean and DiT-modern for its era, but 17 GB native VRAM, 50 steps, and 2024-era 512² quality make it a weak LTX alternative; keep as a research reference only.

### #20 — AnimateDiff — guoyww / Shanghai AI Lab et al.

- **Params:** Motion module v2 453M, v3 ~0.4B (1.56–1.82 GB ckpt); SDXL-beta module 950 MB. Full pipeline adds the SD1.5 base (~0.86B UNet + VAE + CLIP).
- **Licence:** Code Apache 2.0 (GitHub-detected). Motion-module weights are distributed under the same repo terms (commonly treated as Apache-2.0; a separate weights-licence statement was UNVERIFIED). Base SD1.5 is CreativeML Open RAIL-M (commercial use allowed, use-based restrictions). No territory/revenue/SaaS restriction found.
- **What it is:** NOT a standalone video model — a **plug-in motion module** inserted into a frozen SD1.5/SDXL text-to-image model. The base model supplies all appearance; the module supplies motion priors learned from WebVid-10M. ICLR 2024 Spotlight.
- **T2V / I2V:** T2V native. **No native I2V** — image animation comes via adapters: IP-Adapter, SparseCtrl, ControlNet, AnimateLCM-I2V, or video-to-video pipelines. Not first/last-frame.
- **Resolution / frames:** 16-frame window (sliding-window/FreeNoise extends indefinitely in principle); 512×512 SD1.5, 1024×1024 SDXL-beta. ~20–25 steps DDIM typical. Motion LoRAs (8 camera moves) are v2-only.
- **Precision:** FP16.
- **VRAM (measured, sd-webui-animatediff docs, 512²/16f, Torch 2.0, RTX 4090):** 12.13 GB no optimisation; 5.6 GB xformers/SDP; 4.21 GB xformers/SDP without batched cond/uncond; 10.39 GB sub-quadratic. SDXL 1024×768/16f: 13.87 GB. Community consensus: ~6–8 GB peak typical SD1.5.
- **Speed:** ~30–60 s per 16f clip on an 8 GB GPU (community guide); ~30 s on RTX 4090 for 16f/512² (Synpix) — community figures, not author benchmarks.
- **T4 fit:** FITS COMFORTABLY at SD1.5/512² (4–6 GB class with SDP attention).
- **Pipeline:** Diffusers (`AnimateDiffPipeline`, `MotionAdapter`) + native repo + ComfyUI (ComfyUI-AnimateDiff-Evolved, actively maintained) + sd-webui-animatediff.
- **Community / maintenance — be honest:** github.com/guoyww/AnimateDiff — 12,302 stars, 1,109 forks, but the **feature line stopped at v3 (Dec 2023)**; last code update 31 Jul 2024; maintenance health 30/100 (Ross index). Upstream is effectively frozen; all life is in community forks. Quality is 2023-era: flicker, weak motion, WebVid look (v1 bleeds Shutterstock watermarks; v3 needs the domain adapter at ~0.5 strength).
- **Sources:** github.com/guoyww/AnimateDiff; huggingface.co/guoyww/animatediff; paper arXiv:2307.04725 (Jul 2023); animatediff.github.io.
- **Verdict:** Licence-clean and T4-trivial, but a 2023 motion adapter, not a video engine — short, flickery, SD1.5-quality clips. Viable only as a cheap stylised-animation fallback, never as an LTX replacement.

### #21 — AnimateLCM — CUHK MMLab

- **Params:** 454M adapter (HF lists 453.8M); needs an SD1.5 base (~0.86B UNet) underneath. Download 4.7 GB total across 4 weight files.
- **Licence:** MIXED — one variant disqualified, others unclear. Code is MIT (GitHub-detected). Weights: HF repo licence is "Not stated" (checked Nov 2026) — UNVERIFIED as a commercial grant. The **SVD variant is DISQUALIFIED**: it is tuned from SVD-xt / SVD-xt-1.1 weights, inheriting SVD's non-commercial terms. The SD1.5-based T2V/I2V variants sit on SD1.5 (CreativeML Open RAIL-M, commercial use permitted with use restrictions) + an AnimateDiff-style motion module — plausibly usable, but the unstated weights licence means **treat as not-clean until the authors state terms**.
- **What it is:** A motion-module + LoRA adapter in the AnimateDiff lineage, distilled with decoupled consistency learning (image prior first, then motion prior). Three releases: AnimateLCM-T2V (SD1.5), AnimateLCM-I2V, AnimateLCM-SVD.
- **T2V / I2V:** T2V, I2V, control-to-video, video-to-video stylisation, longer video (sliding window). I2V is first-frame image animation.
- **Resolution / frames:** 16 frames @ 512×512 typical (SD1.5 line); SVD variant 25 frames high-res. **4 steps** (1–8 for SVD), guidance ~1.5.
- **Precision:** FP16 (diffusers usage: `diffusion_pytorch_model.fp16.safetensors` ships in the repo).
- **VRAM:** No AnimateLCM-specific measurement found (UNVERIFIED); AnimateDiff-class SD1.5 16f/512² is ~5.6 GB measured with xformers/SDP — a reasonable proxy, not a measurement.
- **Speed:** ~50 s for 16f×512² at 4 steps vs ~4 min for AnimateDiff-V3 DDIM 20-step (plakat docs) — GPU UNVERIFIED, treat as indicative only.
- **T4 fit:** FITS (SD1.5-class, fp16, 4 steps). The blocker is licence clarity, not hardware.
- **Pipeline:** Diffusers-supported (`MotionAdapter` + `LCMScheduler`, `AnimateDiffPipeline`) + native repo + ComfyUI.
- **Community:** github.com/G-U-N/AnimateLCM — ~658–660 stars, 47 forks, inactive, last push 22 Oct 2024. Paper Feb 2024, SIGGRAPH Asia 2024.
- **Sources:** github.com/G-U-N/AnimateLCM; huggingface.co/wangfuyun/AnimateLCM; paper arXiv:2402.00769 (Feb 2024); animatelcm.github.io.
- **Verdict:** T2V/I2V variants are the most T4-friendly few-step option in the older batch, but weights licence unstated — needs author clarification before any commercial use; SVD variant excluded outright.

### #22 — SEINE — Vchitect / Shanghai AI Lab

- **Params:** UNVERIFIED — no parameter count published in sources found (LaVie-base size not stated; SD1.4 UNet is 860M before temporal layers — do not infer a total).
- **Licence:** CONDITIONAL — needs author contact. Code Apache-2.0. Weights: README states they are "fully open for academic research and also allow **free commercial usage**. To apply for a commercial license, please contact vchitect@pjlab.org.cn." That is self-contradictory: free commercial use is claimed, yet a commercial licence must be applied for. **Do not treat as clean Apache until the lab confirms in writing.** No US exclusion stated. Weights descend from SD1.4 (CreativeML Open RAIL-M).
- **What it is:** A short-to-long video diffusion model for **generative transition and prediction** — it bridges and extends clips rather than generating from scratch. Initialised from LaVie-base, built on Stable Diffusion v1.4. ICLR 2024.
- **T2V / I2V:** **I2V + transition + prediction.** I2V from a first frame; **transition mode takes TWO images (first + last) and generates the frames between them** — the only engine in the older batch with native first+last-frame interpolation; prediction mode extends a clip forward. Also text-conditioned. Not a pure T2V engine.
- **Resolution / frames:** Trained at 320×512, 16 frames; transition/prediction chains extend to longer "story-level" videos by stitching.
- **Precision / VRAM / Speed:** ALL UNVERIFIED — no figures found anywhere. SD1.4+temporal class suggests ~8–12 GB, but that is an estimate, not a measurement. LaVie base defaults to 50 steps; SEINE's step count UNVERIFIED.
- **T4 fit:** PROBABLY FITS (SD1.4-class, 320×512, 16f) but unproven; the blocker is the licence ambiguity.
- **Pipeline:** Native PyTorch (built on LaVie + diffusers + SD), custom sample scripts. Not a diffusers pipeline.
- **Community:** github.com/Vchitect/SEINE — 967 stars, last commit 13 Nov 2024 — inactive. Paper 31 Oct 2023 (arXiv:2310.20700).
- **Sources:** github.com/Vchitect/SEINE; arXiv:2310.20700; vchitect.github.io/SEINE-project/.
- **Verdict:** Unique first+last-frame transition capability is genuinely interesting for NOVA (clip stitching), but licence needs written confirmation and VRAM/speed are unverified — a follow-up candidate, not a production pick.

### #23 — ConsistI2V — TIGER-AI-Lab (University of Waterloo)

- **Params:** ~2B (ICLR 2026 URSA paper comparison table). Built on Stable Diffusion 2.1-base + spatiotemporal attention over the first frame + FrameInit noise initialisation. Trained on WebVid-10M.
- **Licence:** MIT (GitHub LICENSE file). No US exclusion, no revenue threshold. Note: base weights derive from SD 2.1-base, which carries CreativeML Open RAIL-M upstream — commercial-permissive with use restrictions; flag for legal review but not disqualifying on its face.
- **T2V / I2V:** I2V only, first-frame conditioned (+ text prompt). No T2V, no first+last-frame.
- **Resolution / frames:** Trained on 16 frames at 256×256 (frame interval 1–5 for FPS control); inference at higher resolutions is possible via config but no official supported-resolution statement found. ~1–2s clips.
- **Precision / VRAM / Speed:** ALL UNVERIFIED — no dtype statement, no published VRAM figure, no published speed figure. Small SD2.1-based model at 256×256, so it very likely fits a T4 comfortably, but that is an inference, not a measurement. 50 DDIM steps, guidance 7.5.
- **T4 fit:** Likely fits easily (small model, tiny frames) — but UNVERIFIED, and the 256×256 native resolution makes it a poor production fit regardless.
- **Pipeline:** No diffusers pipeline class. Native codebase built on AnimateDiff + diffusers components; Gradio demo + Replicate demo exist.
- **Community:** github.com/TIGER-AI-Lab/ConsistI2V — 261 stars, 14 forks, 15 commits. Created 6 Feb 2024; code+model released 26 Feb 2024; last news 26 Mar 2024. Dormant since spring 2024. Paper published in TMLR Jul 2024.
- **Sources:** github.com/TIGER-AI-Lab/ConsistI2V; huggingface.co/TIGER-Lab/ConsistI2V; paper arXiv:2402.04324 (Feb 2024).
- **Quality age:** Early-2024 academic I2V. Its own contribution is consistency, not quality — 256×256 base resolution is far below NOVA's 1024×576 production target.
- **Verdict:** Licence-clean and probably T4-fitting, but a dormant 256×256 academic model. Only conceivable as a last-resort cheap I2V fallback; not a production engine.

### #24 — Open-Sora-Plan v1.3 — PKU-YuanGroup (Peking University)

- **Params:** DiT ~2B per the arXiv paper summary ("the current 2B model in version 1.3.0"). Huawei MindSpeed-MM docs list "OpenSoraPlan 1.3-T2V 8.6B" — that figure is a training-configuration total whose composition is UNVERIFIED; do not quote 8.6B as the DiT size. WF-VAE-S is 146M (8-channel); WF-VAE-L 316M (16-channel).
- **Licence:** MIT (GitHub-detected, LICENSE file). No US exclusion, no revenue threshold found. (One secondary source says Apache-2.0; the repo badge and GitHub detection both say MIT — MIT governs.)
- **T2V / I2V:** Both. v1.3.0 ships T2V and I2V checkpoints (93×640×640 and `_i2v`). v1.2.0 I2V supports **transition generation (first + last frame)** — the only engine in the older batch with documented first+last-frame conditioning.
- **Resolution / frames:** Arbitrary sizes on stride 32; frames must be 4n+1 (e.g. 93, 77, 61, 45, 29); v1.3 demoed at 93×480p and 93×640×640. ~4s at 24fps typical.
- **Precision:** BF16 in MindSpeed-MM training docs; GPU inference precision UNVERIFIED.
- **VRAM:** Official: **93×480p within 24GB VRAM** (README, repeated in the v1.3.0 release notes). No 16GB path published.
- **Speed:** UNVERIFIED — no published seconds-per-clip figure found.
- **T4 fit:** Not viable as published — official requirement is 24GB; no offload/quantisation path documented for v1.3. The project has since moved to Huawei Ascend: **v1.5.0 (5 Jun 2025, 8B, "comparable to HunyuanVideo") is Ascend-910-only, NPU + MindSpeed-MM framework, and the README's GPU section still reads "coming soon..." as of Nov 2026.** The GPU code path is the frozen v1.3-era branch.
- **Pipeline:** Native `opensora` (PKU fork) pipeline only. No diffusers pipeline found.
- **Community:** github.com/PKU-YuanGroup/Open-Sora-Plan — 12,198 stars, 1,073 forks, 595 commits. Repo is active in 2026 — but on new sibling projects: Helios (8 Mar 2026, minute-scale video, 19.5 FPS on H100) and MovieRoll (18 Nov 2026, minute-long rolling video). v1.3 itself is frozen since Oct 2024 (paper Dec 2024).
- **Sources:** github.com/PKU-YuanGroup/Open-Sora-Plan; huggingface.co/LanguageBind/Open-Sora-Plan-v1.3.0; paper arXiv:2412.00131 (3 Dec 2024); WF-VAE paper arXiv:2411.17459.
- **Quality age:** Late-2024 DiT; paper claims VBench aesthetic quality above CogVideoX-2B and Mochi-1, but authors admit the 2B model saturates and struggles with physics. Some v1.2 weights may produce watermarks (Panda70M training).
- **Verdict:** Clean MIT licence, but 24GB VRAM and an Ascend-only future rule it out for Kaggle T4s. Watch Helios/MovieRoll only if a future GPU port appears.

### #25 — EasyAnimate V5.1 — Alibaba PAI

- **Params:** 7B and 12B DiT variants (MMDiT structure, Qwen2-VL text encoder, flow sampling). V5.1-12b weights 34GB; V5.1-7b weights 22GB; **~60GB disk needed for all weights — each single variant alone exceeds Kaggle's 20GB /kaggle/working.**
- **Licence:** Apache-2.0 (repo + HF). No US exclusion, no revenue threshold, no non-compete found.
- **T2V / I2V:** Both, plus V2V and control (Canny/Pose/trajectory/camera). I2V via `-InP` checkpoints (first-frame conditioned). No first+last-frame mode documented.
- **Resolution / frames:** 1–49 frames at 8fps (~6s max); resolutions 256–1024 per side, up to 1024×1024. V4 (older) did 144 frames at 24fps.
- **Precision:** BF16 default; README explicitly says GPUs without BF16 support (2080 Ti, V100 — and by the same logic T4) must switch `weight_dtype` to FP16 in app.py/predict files. Also offers `qfloat8` (FP8) quantisation mode — FP8 is emulation-only on T4.
- **VRAM (official README tables):** 12B at 16GB: only 384×672×25 via `model_cpu_offload_and_qfloat8` (FP8!); 384×672×49 needs sequential CPU offload. 7B at 16GB: 384×672 via qfloat8, 576×1008 via sequential offload. 24GB opens 576×1008 for both. 40GB needed for 768×1344.
- **Speed (official, 25 steps, 12B):** A10 24GB: ~120s (384×672×25), ~240s (×49), ~750s (576×1008×49). A100 80GB: ~45s / ~90s / ~300s respectively. 7B speed UNVERIFIED.
- **T4 fit:** Not viable. The only 16GB paths are FP8 quantisation (T4 emulates FP8 — slow, quality hit) or sequential CPU offload (very slow). Weights alone (22GB for 7B) exceed the 20GB working dir. BF16→FP16 fallback exists but does not fix size/speed.
- **Pipeline:** V5.1 supported in diffusers (`EasyAnimatePipeline`, FP16 recommended dtype; 8-bit bitsandbytes quantisation documented).
- **Community:** github.com/aigc-apps/EasyAnimate — 2,264 stars, 187 forks, 89 commits. Latest README news Mar 2025. Exact last-commit date UNVERIFIED. ComfyUI integration exists. No v6 found as of Nov 2026. A V5.1-7b variant appeared on Modelers.cn (Huawei Ascend hub) in Apr 2026 per a third-party auto-generated article — treat as UNVERIFIED for the NVIDIA path.
- **Sources:** github.com/aigc-apps/EasyAnimate; huggingface.co/alibaba-pai/EasyAnimateV5.1-12b-zh; diffusers docs (EasyAnimate pipeline). V5.1 released 21 Jan 2025; diffusers support 6 Mar 2025.
- **Quality age:** Early-2025 MMDiT, respectable but a generation behind Wan 2.x / LTX 2B class; 8fps native output is a visible motion-quality handicap.
- **Verdict:** Clean licence, wrong hardware class — a 7–12B BF16/FP8 model that cannot run properly on a 15GB T4 or fit in 20GB of disk.

---

## Ruled out in this round (with reasons)

| Candidate | Size / VRAM | Why ruled out |
|---|---|---|
| **HappyHorse-1.0** (Alibaba) | UNVERIFIED params | **Closed source, API-only.** fal.ai (official API partner): "we can confirm that HappyHorse-1.0 will be closed source. It will not be licensable or open source." No repo, no HF weights, no paper. #1 on Artificial Analysis arena (T2V Elo 1333, I2V Elo 1392, Apr 2026) — and entirely inaccessible for self-hosting. HappyHorse 1.1 (23 Jun 2026) same status. |
| **LongLive 2.0** (NVIDIA) | 5B, 19.4 GB NVFP4 / 35.4 GB BF16 | **Hardware requirements disqualify it for T4.** Official stack requires compute capability 8.9 or newer (T4 is 7.5); NVFP4 needs Blackwell; FP8 needs Ada+ tensor cores. Even the NVFP4 figure (19.4 GB) exceeds a 15 GB T4. An infrastructure (NVFP4 + sequence-parallel AR long-video), not just a model; reference model built on Wan2.2-TI2V-5B. Apache 2.0. |
| **Wan 2.5 / 2.6 / 2.7 / 3.0** (Alibaba) | N/A | **Closed, API-only — no weights exist.** Multiple independent checks (Oct–Nov 2026) confirm: no Wan 2.5 weights on HF, ModelScope, or GitHub. Wan 2.5 previewed 24 Sep 2025, commercial launch 11 Nov 2025; 2.6 (16 Dec 2025), 2.7 (Apr 2026), 3.0 (public beta 6 Aug 2026) all API-only. **Any "Wan 2.5 download / Apache 2.0" claim is false** — several SEO pages make it; the careful sources explicitly debunk it. |
| **Mochi 2** (Genmo) | N/A | **Does not exist as a confirmed release.** AgentMarketCap (Nov 2026): "no Mochi 2 announced as of October 2026." Genmo's own site still presents Mochi 1. Third-party listicles mention it with vague claims but cite no announcement, repo, or weights — treat as hallucinated/SEO content. Warning: "Mochi 535B-A23B" (Marin project, Nov 2026) is a **text LLM**, unrelated. |
| **Step-Video-T2V / TI2V** (StepFun) | 30B, ~73–79 GB | MIT licence is ideal, but 30B / ~75 GB peak VRAM (vendor figures) is five T4s' worth; even 4-way sharding needs 64 GB/card. No quantisation path closes a 5× gap. |
| **T2V-Turbo v1/v2** (UC Santa Barbara) | ~1.8B (teacher) | **Non-commercial.** Repo has NO licence file; HF card says "meant for research purposes"; GenAI-Arena lists cc-by-nc-4.0; decisively, **both teachers are non-commercial** (VideoCrafter2 non-commercial disclaimer; ModelScopeT2V CC-BY-NC-ND). A distill cannot out-license its teacher. Also T2V-only, 320×512/16f, FP32. |
| **VideoLCM** (HUST + Alibaba) | 1.7B | **Non-commercial.** VGen repo has no licence file; README disclaimer: "intended for RESEARCH/NON-COMMERCIAL USE ONLY"; teacher ModelScopeT2V is CC-BY-NC-ND. T2V-only, 448×256/16f. Repo inactive since Jan 2025. |
| **ModelScopeT2V** (Alibaba DAMO) | 1.7B | **CC-BY-NC-ND** (official HF model card) — non-commercial + no-derivatives. Secondary sources claiming Apache-2.0 are wrong. T2V-only, 256²/16f, 2023 quality, diffusers pipeline deprecated. |
| **VideoCrafter2** (AILab-CVC) | ~1.8B | **Non-commercial disclaimer in its own README** ("can only be used for personal/research/non-commercial purposes"), despite Apache-2.0 claims on the project page and HF tags. The authors' own restrictive text governs. Also 2 s clips at 320×512, FP32, dormant since 2024. |
| **I2VGen-XL** (Alibaba DAMO) | ~3.7B (2-stage) | **Non-commercial disclaimer** on the official HF model card and VGen repo ("intended for RESEARCH/NON-COMMERCIAL USE ONLY"), despite MIT claims in secondary sources. No LICENSE file in repo. Also 1-second clips, Nov 2023, dormant. |
| **MuseV** (Tencent Music) | UNVERIFIED | **Split licence — model weights non-commercial.** README: "code: MIT License … model: The trained model are available for non-commercial research purposes only." Also virtual-human specialised (small motions only), dormant, no paper ever published. |
| **Motion-I2V** (CUHK + NVIDIA) | UNVERIFIED | **No licence at all** — repo root contains no LICENSE file; HF weights licence UNVERIFIED. No terms = no grant. Also unmeasured (no VRAM/speed figures anywhere), 192 stars, 12 commits, inactive since Sep 2024. |
| **Text2Video-Zero** (Picsart AI) | SD base (~1B) | A training-free **wrapper, not an engine** — zero video weights of its own; motion is essentially camera-pan / latent-shift. Repo dead since May 2023, HF Space broken, 2023 motion quality. |
| **SANA-Sprint** (NVIDIA) | 0.6B/1.6B | **Image-only** (T2I, one-step). The MLX conversion card states explicitly: "Not supported… Video generation." Do not count it. |
| **CausVid** | Wan 2.1 1.3B base | CC BY-NC-SA 4.0 — non-commercial. Already ruled out 24 Nov; not re-presented. |
| **Cosmos Predict2/2.5-2B** | 2B, 32.54 GB | Ampere/Hopper/Blackwell only; gated weights; revocable licence. Already ruled out 24 Nov. |
| **MiniMax H3** | 33B, ~45 GB | Licence **EXCLUDES the US** — Shina is in the US. Already ruled out 24 Nov; re-confirmed this round (MiniMax H3 Community License, "Applicable Territory" excludes US/EU/UK/SK; $20M/year revenue ceiling). |
| **MAGI-1 / MAGI-2** | 4.5B / 114B MoE | MAGI-1: 24 GB FP path; 12 GB path needs FP8 (not native on T4). MAGI-2: 8 Hopper GPUs. Already ruled out 24 Nov. |
| **Ovi 1.1** | 11B, 32 GB min | Wan 2.2 video branch + 5B audio branch. Already ruled out 24 Nov. |
| **SkyReels V3** | 14B+14B+19B | 24 GB floor; Skywork Community License "security review expectation" for internet-service deployment. Already ruled out 24 Nov. |
| **SVD / SVD-XT** | 14–25 frames max | Stability AI Community License — non-commercial by default; commercial use requires a paid licence. Already ruled out 24 Nov. |
| **Vchitect-2.0** | 2B, Apache 2.0 | T2V only in the official code — no image input. Already ruled out 24 Nov. |
| **DynamiCrafter** | 16-frame hard cap | Apache 2.0 and I2V, but 16 frames = 0.7 s at 24 fps; 2023-era quality. Already ruled out 24 Nov. |
| **CogVideoX** | 2B no I2V, ~19 GB | 2B has no I2V; 5B-I2V is BF16; 1,053 s/49f measured on Kaggle T4. Already ruled out 24 Nov. |
| **Mochi 1** | 10B, ~24 GB+ | Already ruled out 24 Nov. |
| **Open-Sora 2.0** | 11B | Already ruled out 24 Nov (size). |
| **LTX-2 / LTX-2.5** | 22B, gated | LTX-2.x Community License carries a non-compete (2.x) / $10M revenue threshold (2.5); 16 GB VRAM floor exceeds a T4; 66 GB download exceeds /kaggle/working. Already ruled out 24 Nov; re-confirmed this round. |
| **Wan-Dancer-14B / Wan2.2-Animate-2-14B** | 14B | Open (Apache 2.0, Jul–Aug 2026) but 14B, datacentre-class reference rigs (Animate-2 default 8× A800). Out for T4. |
| **SkyReels V4** | N/A | No open weights as of Aug 2026 (preview/API only). |
| **SANA-WM** | 2.6B + 17B refiner | 49–51 GB; camera-trajectory world model, not a general I2V engine. Already ruled out 24 Nov. |

---

## Corrections to prior records (from this round)

1. **SANA-Video naming:** there is no "SANA-Video 2.0 2B". The 2B model is SANA-Video **v1**; SANA-Video **2.0** is the 5B/14B family. The 24 Nov GitHub report conflated them. This report separates them (#4 and #15).
2. **SANA-Video 2B VRAM — now VERIFIED:** 7.2 GB measured (ICLR 2026 paper Fig. 1(c), flat vs. video length). This closes the top open item from 24 Nov. The remaining open question is FP16 correctness, not VRAM.
3. **ModelScopeT2V licence:** the 24 Nov shortlist's parenthetical suggesting Apache 2.0 was wrong — the official HF model card states **CC-BY-NC-ND**. It is disqualified.
4. **VideoCrafter2 licence:** secondary sources claiming Apache 2.0 are contradicted by the repo README's own non-commercial disclaimer. Treated as disqualified; the authors' own restrictive text governs.
5. **T2V-Turbo affiliation:** UC Santa Barbara (Jiachen Li et al.), not CMU.
6. **LTX-Video 0.9.x is frozen upstream** (see the flag at the top of this report).
7. **Wan 2.5+ misinformation is widespread:** multiple SEO pages claim open weights/Apache 2.0 for Wan 2.5/2.7/3.0. Every careful check (Oct–Nov 2026) finds no weights. Trust only the `Wan-AI` HF org / `Wan-Video` GitHub org.
8. **Mochi 2 does not exist** as a confirmed Genmo release; third-party mentions are unsubstantiated.
9. **SkyReels V2 licence is genuinely in conflict** (Apache 2.0 vs Skywork Community License across sources) — the 24 Nov report's "custom licence" characterisation was one side of the conflict; the licence file must be read directly.
10. **SANA-Video 2.0 5B carries two licence dependencies** the 24 Nov report did not note: the Gemma-2-2b-it text encoder (Gemma Terms of Use, gated) and the LTX-2.3 VAE (LTX-2 Community Licence, $10M revenue threshold).

## Cross-cutting findings

1. **BF16 is the hidden T4 tax.** Almost every 2025–2026 engine is BF16-native (Wan family, SANA, HunyuanVideo, Open-Sora, LingBot, Bernini, Kandinsky, FastWan, Self-Forcing). On Turing, BF16 has no tensor-core support — it runs emulated/slow. FP16 conversion behaviour is the single highest-value validation question across the whole field, and it is UNVERIFIED for every BF16-native candidate except LTX (proven FP16 in the diffusers adaptation).
2. **The 2026 field moved away from the T4.** New releases are bigger (14B–114B), assume Ampere-or-newer hardware (LongLive 2.0 requires cc ≥ 8.9; Kandinsky's SageAttention needs Ampere+), and increasingly carry custom licences with geographic carve-outs. LTX 2B distilled remains the outlier that fits.
3. **Licence conflicts are the story of the older batch.** VideoCrafter2 and I2VGen-XL both have Apache-2.0/MIT claims *somewhere* but non-commercial disclaimers in their own official README/model card. The authors' own restrictive text governs; a licence-file check, not a secondary-source claim, is what settles it.
4. **Speed reality check.** Even the best-fitting Wan-1.3B engines are ~4 min/5 s on a 4090 (vendor claim) — an order of magnitude slower than LTX's 13.3 s/49f sampling. The distilled variants (FastWan 21 s/5 s on a 4090; Self-Forcing real-time streaming on H100) close the gap, but only if their FP16/T4 questions resolve favourably. Wan-family engines buy consistency/control, not throughput.
5. **One FP16 conversion pattern likely serves the whole Wan family.** Fun-InP, VACE, Phantom-Wan, FastWan, and Self-Forcing are all Wan-2.1-1.3B derivatives — one validated FP16 conversion + harness pattern would unlock several candidates at once.
6. **Kaggle disk is a second trap.** EasyAnimate weights (22–34 GB per variant), FramePack (30 GB+), HunyuanVideo 1.5 (29 GB template), LTX-2.5 (66 GB), and Allegro (24.3 GB) all exceed or strain the 20 GB `/kaggle/working` limit. Dataset mounts or scoped downloads are needed for any of them.

## Top 5 worth any future proof run

Ranked by expected value of a single controlled proof (one short clip, Shina's verdict, then continue — the established proof discipline). **No proof run is authorised by this report.** The reviewer's ruling stands: no further engine experiment unless LTX hits a material quality/licensing/repeatability/hardware blocker. These five are the order in which to spend proof effort *if* that gate ever opens.

1. **Wan2.1-Fun-1.3B-InP** — the only true first+last-frame I2V at 1.3B with a clean Apache 2.0 licence. Proof question: real T4 VRAM + speed + FP16 behaviour. If it fits and moves, it is the strongest LTX alternative on licence + capability.
2. **FastWan (1.3B)** — Apache 2.0, 3 steps, diffusers-native, 21 s/5 s clip on a 4090. Proof question: FP16-on-T4 behaviour. If FP16 works, it is the fastest clean engine after LTX.
3. **SANA-Video 2B (v1)** — measured 7.2 GB VRAM, Apache 2.0, native I2V + 60 s LongLive variant. Proof question: FP16 correctness (the one open item; VRAM is already proven). If FP16 works, it has the best VRAM headroom of any candidate.
4. **Allegro-TI2V** — already the named backup (reviewer, 24 Nov). Apache 2.0, true first+last-frame I2V, 9.3 GB with offload. Proof question: real T4 speed (expected very slow — the proof would confirm whether it is usable at all, not whether it is fast).
5. **SkyReels V2 1.3B DF** — FP16-native (no precision conversion needed), infinite-length generation, I2V + start/end frame. Two gates before any proof: (a) read the repo LICENSE file to resolve the Apache-vs-Community conflict; (b) the 14.7 GB VRAM figure leaves almost no headroom — the proof would be a fit test first, quality second.

Honourable mention: **LingBot-Video Dense 1.3B** (community-proven on 8 GB cards, Apache 2.0) — worth a look only if the top five all fail, given its slow speed and JSON-caption workflow.

## The reviewer's ruling vs Shina's research order

- **Reviewer's ruling (24 Nov ~23:55, verbatim `architecture/github-engine-review-reply-verbatim-2026-11-24.md`):** "No further engine search or backup experiment unless LTX hits a material quality/licensing/repeatability/hardware blocker." Engine selection does NOT grant production approval; gates remain (repeatability — now PROVEN 25 Nov ~00:19; longer-clip validation; website integration E2E; licence obligations before commercial release).
- **Shina's overnight order (25 Nov ~00:37):** deep internet research for twenty free, good video-generation engines — research only, reviewer review in the morning.
- **How the two sit together:** this report is research, not experiment. No weights were downloaded, no generation was run, no engine was tested. Nothing in it spends GPU time, touches the LTX production track, or pre-empts the reviewer's gates. The top-5 list above is a *contingency ordering* for proof effort, not a request to run proofs. The decision the reviewer faces in the morning is whether the research changes anything about the standing ruling — in particular whether the Fun-InP / FastWan / SANA-Video FP16 questions are worth one controlled validation each, or whether the ruling holds and LTX remains the sole engine until a blocker appears.

## Recommendation (unchanged)

**STICK WITH LTX.** Nothing in this deeper search beats LTX-Video 2B distilled on NOVA's hardware. The reasons are the same as on 24 Nov, now with 25 engines of evidence behind them:

1. LTX is still the only candidate with measured T4 proof — now including byte-identical repeatability across three independent runs.
2. LTX is still the only candidate with native FP16 proven on Turing. Every 2025–2026 alternative is BF16-native (except SkyReels V2 and Phantom-Wan, which have their own problems).
3. LTX is still fastest by orders of magnitude at the production operating point, except for the distilled Wan variants whose FP16 behaviour is unproven.
4. LTX's licence is workable; the alternatives with cleaner licences lose on speed and precision, and the alternatives with comparable quality carry custom licences with geographic exclusions.

What this round adds: **Fun-InP, FastWan, and SANA-Video 2B are now named, evidenced, and ordered** as the three candidates most worth a single validation each if the reviewer ever opens that gate — and the FP16-conversion question is identified as the one validation that would unlock several candidates at once.

---

## Reviewer-submission summary (for the NOVA reviewer thread, morning)

*This section is a self-contained summary suitable for sending to the NOVA reviewer. It was NOT sent by Muse — Shina sends reviewer-thread material himself.*

**Subject: NOVA — twenty free video-generation engines: deep research report (25 Nov 2026)**

Shina ordered an overnight deep search for twenty free, good video-generation engine alternatives to LTX. Research only — no downloads, no runs, no experiments. Full report: `gpu-cloud/docs/twenty-free-engines-2026-11-25.md` (25 engines ranked, per-engine evidence, ruled-out table).

**Headline results:**
- **25 real engines qualify** as free, open-weights, and evidenced (target was 20). Of those, ~8 are credible production/backup candidates on a T4; the rest are specialist, dated, T2V-only, licence-unclear, or T4-infeasible.
- **Top new finding — SANA-Video 2B VRAM VERIFIED:** 7.2 GB measured (ICLR 2026 paper Fig. 1(c)). This closes the top open item from 24 Nov. Remaining question is FP16 correctness, not VRAM.
- **Strongest new candidate — Wan2.1-Fun-1.3B-InP:** true first+last-frame I2V at 1.3B, Apache 2.0. VRAM/speed unverified — needs a proof run.
- **Fastest clean distill — FastWan:** Apache 2.0, 3 steps, 5 s clip in 21 s on a 4090. FP16-on-T4 unverified.
- **Five 2026 names resolved:** HappyHorse-1.0 (closed, API-only — out), Bernini-R-1.3B (real, Apache 2.0, editing-first, VRAM unverified), LingBot-Video Dense 1.3B (real, Apache 2.0, community-proven on 8 GB cards, slow), LongLive 2.0 (requires cc ≥ 8.9 — out for T4), Kandinsky 6.0 Lite (real, MIT, joint audio+video, too slow and host-RAM heavy).
- **Wan 2.5/2.6/2.7/3.0 are all closed, API-only** — no weights exist; SEO claims of open weights are false. Mochi 2 does not exist as a confirmed release. Step-Video is 30B / ~75 GB — datacentre-class.
- **Licence corrections:** ModelScopeT2V is CC-BY-NC-ND (not Apache 2.0); VideoCrafter2 and I2VGen-XL carry non-commercial disclaimers in their own official text despite Apache/MIT claims elsewhere. SkyReels V2's licence is genuinely in conflict (Apache 2.0 vs Skywork Community License) — the repo LICENSE file must be read directly.
- **Flag:** the LTX-Video 0.9.x repo now states it is "no longer under active development" (LTX-2.5 supersedes it). NOVA's production engine is frozen upstream. LTX-2.5 itself does not fit a T4 (22B, 16 GB floor).

**Top 5 worth any future proof run (contingency ordering only — no proof authorised):** 1) Fun-InP, 2) FastWan, 3) SANA-Video 2B, 4) Allegro-TI2V (already the named backup), 5) SkyReels V2 1.3B (after the licence file is read).

**Recommendation unchanged: stick with LTX.** Nothing beats it on measured T4 fit, native FP16, or speed. The cross-cutting finding is that BF16 is the hidden T4 tax across the whole 2025–2026 field — FP16-conversion validation is the one test that would unlock several candidates at once.

**Question for the reviewer:** does this research change the standing ruling (no further engine experiment unless LTX hits a material blocker)? In particular, are the Fun-InP / FastWan / SANA-Video FP16 questions worth one controlled validation each, or does the ruling hold?

**STAGE: RESEARCH COMPLETE — AWAITING REVIEWER REVIEW AND OWNER DECISION.**
