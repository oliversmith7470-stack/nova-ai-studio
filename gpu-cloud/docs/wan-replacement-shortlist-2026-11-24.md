# Wan Replacement Shortlist — NOVA AI Studio Video Engine

**Date:** 24 November 2026
**Status:** Research only. No commits, no pushes, no Kaggle runs, no weight downloads.
**Decision context:** Shina has decided to replace Wan 2.2 TI2V-5B after repeated failures —
v3 failed with a real CUDA OOM on a single T4 at step 0 (1.88 GB short, 13.27 GB already in
use of 14.56 GB); v4 was killed by the host-RAM OOM killer under torchrun (peak VRAM only
363 MB). v5 (single-process pipeline-parallel) is building, but the model itself is to be
replaced.

## Hard requirements (from the brief)

1. Image-to-video capable (the pipeline animates keyframe stills into clips).
2. Runs on Kaggle's free allocation: 2x Tesla T4 16 GB each (ideally fits a SINGLE 16 GB T4).
3. Free / open licence permitting commercial use in our own product.
4. Weights downloadable from Hugging Face.
5. Proven to run on Kaggle or a comparable free GPU (not just claimed to fit).

## Kaggle T4 facts that decide this (measured, not assumed)

- Each T4 has **15,360 MiB** VRAM, no NVLink; host RAM **~31 GiB**; 4 vCPU; CUDA 13,
  PyTorch 2.11. (blog.sdad.pro, "Two T4s and the Host RAM Wall", Nov 2026 — four benchmark
  campaigns run on the same Kaggle machine.)
- **Turing (compute capability 7.5): FP16 and INT8 work; BF16 and FP8 do not.**
  (Same source.) Any model whose recommended dtype is BF16, or whose fit depends on FP8
  tensor cores, is a problem on this hardware.
- **Host RAM, not VRAM, is the usual wall** on Kaggle: two LTX processes were OOM-killed
  because each needed ~20 GB of host RAM. One process at a time only. (Same source.)
- `/kaggle/working` is **20 GB**. A first-run download over 20 GB does not fit without a
  dataset mount (the same trick used for the Wan weights).

## Ranked shortlist

| Rank | Model | Params | VRAM on one T4 | I2V | Licence | Kaggle/T4 proof |
|------|-------|--------|----------------|-----|---------|-----------------|
| **1** | **LTX-Video 2B distilled (0.9.8)** | ~2B | **~9–11 GB measured** | Yes, native + first/last frame | LTXV Open Weights 0.X — free below $10M revenue (see caveat) | **Yes — measured on Kaggle T4 twice** |
| 2 | FramePack (HunyuanVideo 13B) | 13B | 6 GB minimum (official) | Yes, I2V-only | Code Apache 2.0; weights inherit Tencent Hunyuan terms | No direct Kaggle run found; runs on 6 GB laptop GPUs |
| 3 | HunyuanVideo 1.5 FP8 | 8.3B | 14 GB floor with offload (official) | Yes | Tencent Hunyuan Community — excludes EU/UK/KR | No Kaggle run found |
| 4 | SkyReels V2 1.3B (DF) | 1.3B | ~14.7 GB peak with offload (official) | Yes | Ambiguous — HF tag "skywork-license", some sources claim Apache 2.0 | None found |
| 5 | Wan 2.1 1.3B | 1.3B | 8.19 GB (official, 480p) | **No official I2V** (community Fun InP only) | Apache 2.0 | Widely run on consumer GPUs |
| — | CogVideoX-2B / 5B-I2V | 2B / 5B | ~19 GB (2B, official) | 2B has NO I2V; 5B-I2V is BF16 | Apache 2.0 | Ran on Kaggle T4 but **1,053 s per 49 frames** |
| — | Self-Forcing | 13B backbone | 45–60 GB (inherits HunyuanVideo 13B) | Via HunyuanVideo-I2V | Inherits HunyuanVideo terms | None — not a standalone small model |

---

## #1 — LTX-Video 2B distilled (0.9.8) — RECOMMENDED

**Checkpoint:** `Lightricks/LTX-Video`, file `ltxv-2b-0.9.8-distilled.safetensors`,
6,340,744,492 bytes (~6.3 GB). Ungated repo.
(Source: synapspaces TRACK-C doc, verified against the Hub 2026-10-12/13.)

**Why it wins — measured evidence on the exact hardware:**

- **VRAM:** peak **9.1 GB (cuda:0) / 9.8 GB (cuda:1)**, 10.5 GB for a 145-frame
  two-condition shot, at 768p-class on Kaggle T4 — "with room to spare on a 16 GB T4".
  (synapspaces TRACK-C.) Independently, T4-Bench measured **~11 GiB** on a Kaggle T4.
  (blog.sdad.pro.)
- **Speed:** **27.4 seconds per warm 49-frame clip at 4 steps** on a Kaggle T4 —
  the fastest video model in the T4-Bench atlas, ~38x faster than CogVideoX-2B on the
  same machine. (blog.sdad.pro.) TRACK-C reports **~10 s per second of video** on one T4.
- **I2V:** native image-to-video with first+last-frame conditioning
  (`LTXConditionPipeline`); 8 fixed timesteps, no CFG. (synapspaces TRACK-C.)
  A ComfyUI I2V notebook runs on a free T4. (huggingface.co/vidfom/LTX-itv-Repository.)
- **Weights size:** 6.3 GB — fits `/kaggle/working` (20 GB) with no dataset mount needed,
  unlike Wan (34 GB) and FramePack (30 GB+).
- **Precision:** runs FP16, which Turing supports. No BF16/FP8 dependency.

**Licence — the one caveat, and it is real:**

- LTX-Video 2B is under the **LTXV Open Weights License 0.X** (15 Apr 2025, applies to all
  LTXV versions since v0.9.6). Entities with annual revenue **under $10,000,000** may use
  it "for any purpose" without a paid licence, including hosting for third parties
  (SaaS). Above $10M, a paid Commercial Use Agreement is required, with liquidated
  damages of double the fees for unauthorised use.
  (Source: huggingface.co/Lightricks/LTX-Video — LTX-Video-Open-Weights-License-0.X.txt.)
- **Non-compete flag:** the newer LTX-2.x Community License explicitly bars use "in any
  product, service, or application that directly competes with Lightricks' products or
  services or is designed to replace or substitute them, without a separate commercial
  license from Lightricks" — regardless of revenue. (ltx.io licensing page.) The 0.X
  licence has its own use-based restrictions in Attachment A, which must be read before
  shipping. NOVA AI Studio is a video-generation product; whether it "directly competes"
  with Lightricks' products is a question for the pending Lightricks reply to Shina's
  licensing letter (sent 22 Nov 2026). **Do not treat the licence as cleared until that
  reply lands or Attachment A is read.**
- The code (Lightricks/LTX-Video repo) is Apache 2.0; the weights are under the
  community licence. Running the model with the Apache code does not change the
  weights' licence.

**Quality notes:** below Wan 14B, better than AnimateDiff; "Fast generation (2-5 min per
clip)" at 480p in one guide, but the Kaggle measurements above are much faster with the
distilled checkpoint. 768p-class tested on T4; 1280x720 is the obvious next experiment
per TRACK-C. Distilled model = 8 fixed steps, no CFG — less control than a full model.

**Host-RAM note:** one LTX process needs ~20 GB of host RAM on Kaggle; two parallel
processes exceed the 31 GiB and get OOM-killed (T4-Bench). Run one clip at a time per
session; the second T4 does not double video throughput for this model.

**Throughput estimate (from measured numbers):** ~27 s per 49-frame (~2 s) clip means
roughly a 5-second clip in ~60–70 s. At 30 GPU-h/week, that is on the order of
**1,500+ five-second clips per Kaggle week** — an order of magnitude more than Wan's
~120–230. (Estimate from the measured 27.4 s/49-frame figure; verify in the proof run.)

---

## #2 — FramePack (HunyuanVideo 13B)

- **Params:** 13B (HunyuanVideo-based transformer, checkpoint `lllyasviel/FramePackI2V_HY`).
- **VRAM:** **6 GB minimum**, official README: "the minimal required GPU memory is 6GB.
  (Yes 6 GB, not a typo. Laptop GPUs are okay.)" Memory cost is O(1) — frame 1,800 costs
  the same as frame 30 — because past context is compressed into a fixed-size window.
  (lllyasviel/FramePack README, via localaimaster.com and chatforest.com.)
- **I2V:** yes — image-to-video only. Generates up to **60 seconds at 30 fps**
  (1,800 frames) from one still. First+last-frame variant (FLF2V) runs inside 12 GB.
  (studio.aifilms.ai.)
- **Speed — the problem:** **2.5 s/frame on an RTX 4090, 1.5 s/frame with TeaCache**;
  laptop GPUs run **4–8x slower**. A 5-second clip (150 frames) is ~4 min on a 4090 and
  **~25–50 min on laptop-3060-class hardware**. A T4 is closer to the laptop end, so a
  5-second clip on Kaggle would likely take **~30–60 minutes**. (Official README figures
  via localaimaster.com; techiehub.blog.)
- **Download:** **30 GB+ on first run** — exceeds Kaggle's 20 GB `/kaggle/working`;
  needs a dataset mount like the Wan weights. (localaimaster.com.)
- **Licence:** code is Apache 2.0, but the weights are derived from HunyuanVideo, so they
  carry the **Tencent Hunyuan Community License** (EU/UK/South Korea exclusion, 100M MAU
  threshold) — not Apache 2.0. "The repository README does not spell this out... verify
  the specific checkpoint you download." (shotcraft.video.)
- **Quality:** HunyuanVideo 13B quality; modest resolution rather than HD; human motion
  and fine detail will not match paid services. (dev.to.)
- **Kaggle evidence:** none found directly. Runs on 6 GB laptop GPUs, so it will fit a
  T4 — the question is speed, not fit.
- **Verdict:** the long-form champion (60 s from one image is unique), but far too slow
  for NOVA's clip pipeline on a T4, and the weights licence is murky. Best as a
  **second-phase option for long scenes**, not the core engine.

## #3 — HunyuanVideo 1.5 (FP8)

- **Params:** 8.3B (down from 13B in v1.0). T2V + I2V, 480p and 720p, 121 frames default.
  (Tencent-Hunyuan/HunyuanVideo-1.5.)
- **VRAM:** official README minimum **14 GB with model offloading enabled**.
  FP8 transformer: ~14–16 GB (text encoder on GPU), ~10–12 GB with text-encoder CPU
  offload. (willitrunai.com, from the model card + community benchmarks.)
  Measured: **14.3 GB peak** at 480p FP8 on an RTX 5060 Ti 16 GB, 11 min/clip.
  (vramready.com.)
- **T4 problem — FP8 does not run natively on Turing.** The T4 has no FP8 tensor cores
  (blog.sdad.pro). FP8 weights would need dequantisation or a fallback path, erasing
  most of the benefit. The FP16 path needs ~24–28 GB without offload.
  (willitrunai.com.) With offload it fits, but slowly.
- **Speed:** step-distilled 480p I2V generates **within 75 seconds on a single RTX 4090**
  (official README). On a T4, expect an order of magnitude slower — the 5060 Ti
  measurement was 11 min/clip at 480p.
- **Licence:** **Tencent Hunyuan Community License.** Commercial use is allowed where
  the licence applies; services above 100M monthly users need a licence from Tencent.
  **The licence does not apply at all in the EU, the UK, and South Korea.**
  (nodegrove.io; soundverse.ai.) For a product with users anywhere, that exclusion is a
  real restriction. One source describes it as "non-commercial research"
  (willitrunai.com) — the licence text itself must be read before relying on it.
- **Download:** the full repo is **372 GB** on Hugging Face across all variants
  (nexgpu.net); the single FP16 checkpoint is ~16.7 GB, FP8 ~8.3 GB. Needs care to
  download only the needed checkpoint.
- **Kaggle evidence:** none found.
- **Verdict:** strong quality and a real 14 GB floor, but FP8 is the wrong precision
  for Turing, the licence excludes three major markets, and no Kaggle run exists.

## #4 — SkyReels V2 1.3B (Diffusion Forcing)

- **Params:** 1.3B. 540p (544x960), 97 frames base, extendable to 737+ frames.
  (Skywork/SkyReels-V2-I2V-1.3B-540P-Diffusers.)
- **VRAM:** **~14.7 GB peak** for a 540p video on the 1.3B model, with `--offload` and
  TeaCache (official model card). Fits a 16 GB card, but with only ~1.4 GB of headroom
  on a Kaggle T4 (15,360 MiB) — tight, and any longer clip or higher frame count eats
  the margin.
- **I2V:** yes — dedicated I2V checkpoint, plus start/end-frame and shot-extension modes.
- **Licence — ambiguous:** the HF model card is tagged **"skywork-license"**
  (nodevalid.com, read from the vendor's own model card 2026-09-22), while some
  secondary sources claim Apache 2.0 (studio.aifilms.ai). One catalogue lists
  "Commercial use: With conditions" (outmake.app). **Unverified — read the licence
  before any use.**
- **Speed:** no published per-clip time found.
- **Kaggle evidence:** none found.
- **Verdict:** small and I2V-native, but the VRAM margin is thin, the licence is
  unclear, and nothing proves it on a T4. A backup candidate only.

## #5 — Wan 2.1 1.3B (flagged: same family)

- **Params:** 1.3B. 480p, 81 frames at 16 fps (~5 s).
- **VRAM:** **8.19 GB** (official Wan2.1 README: "The T2V-1.3B model requires only
  8.19 GB VRAM, making it compatible with almost all consumer-grade GPUs.").
  At 720p, community figures put it at 16–20 GB. (spheron.network.)
- **I2V — no official checkpoint.** Wan 2.1's official I2V model is the 14B only
  (I2V-14B-480P/720P). The 1.3B is T2V-only officially; image-to-video on 1.3B exists
  only via community methods (Fun InP, VACE). (Wan2GP skill docs; Wan2.1 repo model list.)
- **Speed:** 5-second 480p clip in **about 4 minutes on an RTX 4090** (official figure).
  (localairigs.com.)
- **Licence:** Apache 2.0 — clean.
- **Family risk (the reason it ranks last among the viable):** same Wan family, same
  codebase patterns, same team. Shina's decision was to replace Wan after repeated
  failures; dropping to the smaller sibling keeps the family risk and gives up I2V
  (officially) and 720p. Only worth it as a fallback if every other candidate fails.
- **Kaggle evidence:** widely run on consumer GPUs; no specific Kaggle proof found.

## Ruled out

### CogVideoX-2B / CogVideoX-5B-I2V — fails I2V + T4 requirements

- **CogVideoX-2B has no official image-to-video checkpoint.** The diffusers docs list
  only two official I2V checkpoints: `THUDM/CogVideoX-5b-I2V` and
  `THUDM/CogVideoX-1.5-5b-I2V`, both **BF16** — and the T4 has no BF16 hardware support.
  (huggingface.co/docs/diffusers — CogVideoX pipeline docs.)
- **VRAM:** the diffusers docs state CogVideoX-2b "requires about 19 GB of GPU memory
  to decode 49 frames (6 seconds of video at 8 FPS) with output resolution 720x480,
  which makes it not possible to run on consumer GPUs or free-tier T4 Colab."
  The model card's "from 4 GB" figure requires all diffusers optimisations enabled and
  was tested only on A100/H100. (THUDM/CogVideoX-2b model card.)
- **Speed on Kaggle T4, measured:** **1,053 seconds for 49 frames** — ~38x slower than
  LTX-Video 2B on the same machine. Highest prompt alignment in the T4-Bench video
  campaign (CLIP 0.2645), but unusable as a production engine at that speed.
  (blog.sdad.pro.)
- Licence is Apache 2.0 (clean), but the model fails the I2V and T4 requirements.

### Self-Forcing — not a standalone candidate

- Self-Forcing is a **distillation method applied to HunyuanVideo 13B**, not a small
  model of its own. It inherits the 13B backbone: **60 GB at 720x1280x129f, 45 GB at
  544x960x129f**, 80 GB recommended (official HunyuanVideo README). No small-model
  checkpoint exists. It is a technique, not a replacement.

### Also noted, not ranked

- **LTX-2.3 / LTX-2.5 (22B):** Lightricks' newest models; one guide claims LTX-2.3
  runs on a 16 GB GPU (techiehub.blog), but the repos are **gated**, the 22B weights are
  46 GB in bf16, and the 13B 0.9.8 distilled fp8 (15.7 GB) leaves no room for 768p
  activations on one T4 (synapspaces TRACK-C). Not viable on Kaggle T4 without heavy
  quantisation work. Watch item only.
- **Mochi 1 (Genmo, 10B, Apache 2.0):** needs ~24 GB+; not T4-viable.

## Recommendation

**Replace Wan 2.2 TI2V-5B with LTX-Video 2B distilled (0.9.8) as the core video model.**

The evidence is the strongest of any candidate on the exact hardware NOVA uses:

1. **Measured on Kaggle T4, twice, by independent sources** — 9.1–11 GB peak VRAM,
   27.4 s per 49-frame clip. No other candidate has any Kaggle measurement at all.
2. **Fits one T4 with ~5 GB of headroom** — the Wan failure mode (VRAM wall) does not
   apply.
3. **Native image-to-video with first+last-frame conditioning** — matches the keyframe
   pipeline exactly.
4. **6.3 GB weights** — fits `/kaggle/working` without a dataset mount.
5. **FP16** — runs on Turing; no BF16/FP8 dependency.
6. **Throughput:** roughly 1,500+ five-second clips per 30-GPU-hour Kaggle week
   (estimate from the measured 27.4 s/49-frame figure).

**Before the proof run, two things must be settled:**

1. **Licence:** read Attachment A of the LTXV Open Weights License 0.X, and wait for
   (or chase) the Lightricks reply to Shina's 22 Nov licensing letter — the
   non-compete question (does NOVA "directly compete" with Lightricks' products?)
   is the one real blocker. Below $10M revenue the licence is otherwise free for
   commercial use including SaaS.
2. **Proof run (same discipline as Wan):** one short clip on Kaggle first, Shina's
   verdict, then continue. The measured numbers say it will fit and run fast; the
   proof run confirms it in our own pipeline and checks output quality against the
   Alignment Standard.

**Fallback order if LTX is blocked on licence:** FramePack (slow but fits anything)
for long scenes, HunyuanVideo 1.5 (licence exclusions) for 720p quality, SkyReels V2
1.3B (licence unverified) as a last resort. Wan 2.1 1.3B only if Shina revisits the
family decision.

## Sources

- T4-Bench / "Two T4s and the Host RAM Wall" — https://blog.sdad.pro/blog/t4-bench-two-t4s-host-ram-wall
  (Kaggle 2x T4 measurements: LTX 2B distilled 27.4 s/49 frames, ~11 GiB; CogVideoX-2b
  1,053 s/49 frames; Turing has no BF16/FP8; host RAM is the wall.)
- Synaps Optic TRACK-C (LTX on Kaggle) — https://optic.synapspaces.com/m/knowledge/items/f0d4a5ea-819d-4507-aaf2-2934f6bd815d
  (LTX 2B distilled on Kaggle T4: VRAM peak 9.1/9.8 GB, ~10 s per second of video,
  6,340,744,492-byte checkpoint, LTXV licence note.)
- LTXV Open Weights License 0.X — https://huggingface.co/Lightricks/LTX-Video/raw/main/LTX-Video-Open-Weights-License-0.X.txt
  ($10M revenue threshold; SaaS hosting permitted below it.)
- LTX licensing page — https://ltx.io/lp/ltx-ai-video-licensing
  (Non-compete clause in the LTX-2.x Community License.)
- LTX-Video I2V notebook (free T4) — https://huggingface.co/vidfom/LTX-itv-Repository/raw/main/LTX-Video/LTX_Video_Img_to_Vid.ipynb
- FramePack README figures — https://localaimaster.com/blog/framepack-setup-guide
  (6 GB minimum, 2.5 s/frame on RTX 4090, 1.5 s/frame with TeaCache, 30 GB+ download.)
- FramePack licence caveat — https://shotcraft.video/models/framepack/
  (Code Apache 2.0; weights inherit Tencent Hunyuan terms.)
- HunyuanVideo 1.5 VRAM — https://willitrunai.com/blog/hunyuanvideo-1-5-vram-requirements
  (8.3B, FP8 14–16 GB, offloaded 8–12 GB; Tencent Hunyuan Community License.)
- HunyuanVideo 1.5 licence + files — https://nodegrove.io/create/hunyuanvideo-1.5
  (Licence excludes EU/UK/South Korea; 100M MAU threshold; 14 GB minimum with offload.)
- HunyuanVideo 1.5 measured — https://vramready.com/models/hunyuanvideo-1-5/
  (14.3 GB peak, 11 min/clip at 480p FP8 on RTX 5060 Ti 16 GB.)
- HunyuanVideo 1.5 overview — https://nexgpu.net/en/models/hunyuanvideo/
  (14 GB floor with offload; step-distilled 480p I2V ~75 s on RTX 4090; 372 GB repo total.)
- SkyReels V2 1.3B — https://huggingface.co/Skywork/SkyReels-V2-I2V-1.3B-540P-Diffusers
  (~14.7 GB peak VRAM at 540p with offload; I2V checkpoint.)
- SkyReels V2 licence tag — https://nodevalid.com/models/skyreels-v2/
  (Licence tagged "skywork-license" on the vendor's model card.)
- CogVideoX diffusers docs — https://huggingface.co/docs/diffusers/v0.32.2/api/pipelines/cogvideox
  (Only 5B-I2V checkpoints for I2V, both BF16; 2B needs ~19 GB for 49 frames, "not
  possible to run on... free-tier T4 Colab".)
- CogVideoX-2B model card — https://huggingface.co/GrigoriyLojkin/CogVideoX-2b
  (diffusers FP16 from 4 GB with all optimisations, tested only on A100/H100; Apache 2.0.)
- Wan 2.1 1.3B VRAM — https://localairigs.com/guides/best-gpu-for-local-video-generation
  (8.19 GB official, 5 s 480p clip ~4 min on RTX 4090.)
- Wan 1.3B VRAM table — https://www.spheron.network/blog/deploy-wan-2-1-ai-video-generation-gpu-setup/
  (1.3B: 8–12 GB at 480p, 16–20 GB at 720p.)
- LTX-Video VRAM table — https://runllmlocal.com/ai-video-vram/
  (LTX-Video 2B: 5 GB at 480p/720p FP8.)
