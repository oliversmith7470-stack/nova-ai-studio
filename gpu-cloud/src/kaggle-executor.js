// NOVA Personal GPU Cloud — Stage 2: the Kaggle T4 executor.
//
// MECHANISM (researched from Kaggle's official docs, 24 Nov 2026):
// Kaggle DOES have an official remote-execution API — the Kaggle CLI
// (kaggle-api). `kaggle kernels push -p <folder> [--accelerator
// NvidiaTeslaT4] [-t timeout]` uploads the notebook AND runs it;
// `kaggle kernels status` polls; `kaggle kernels output` downloads
// artifacts; `kaggle kernels logs` / `files` / `pull` / `delete` also
// exist. Accelerators include NvidiaTeslaT4 (GPU T4 x2, the default GPU),
// A100, L4, L4X1, TPU v5e/v6e, H100, RtxPro6000.
//
// WHAT IS AUTOMATED vs WHAT NEEDS A HUMAN (evidence in
// docs/connection-layer.md §2):
//   Automated by this executor: the job package (notebook + kernel
//   metadata + staging manifest + instructions), the VDP-06 guard, the
//   hours-budget check, the staging prep test.
//   Human (Part B): the Kaggle account + phone verification, the dataset
//   upload for the 34 GB official weights, and — until a credentialed
//   transport exists — running `kaggle kernels push` + polling +
//   downloading the report and filing it via executor.fileReport(). The
//   CLI needs credentials (kaggle.json / API token), which are a Part B
//   item, so the DEFAULT transport is null: the executor prepares the
//   package and the human runs the CLI.
//   A `transport` may be injected (Part B, or tests): an object with
//     push(packageDir) -> Promise<{ ok, kernelId?, error? }>
//     status(kernelId) -> Promise<{ state: 'running'|'complete'|'error', error? }>
//     output(kernelId) -> Promise<provider report>
//   A real transport execs `kaggle kernels push` / `status` / `output`
//   with the owner's credentials — it is never built with credentials in
//   Stage 2. With a transport, start() pushes and polls in the
//   background; the start() promise resolves when the run ends.
//
// NO CANCEL: the CLI has no cancel command (verified against the
// kaggle-api reference — the kernels subcommands are list/init/push/pull/
// output/status/files/logs/delete). A runaway run is stopped in the web
// UI. requestCancel() therefore returns false honestly.
//
// ONLY THE CODE_FILE IS SENT: `kaggle kernels push` sends only the
// notebook text; sibling files are NOT uploaded. The notebook is
// self-contained (see staging.js buildNotebook) and the dataset is
// attached via kernel-metadata dataset_sources, not by file upload.
//
// SESSION FACTS (kaggle.com/docs/notebooks): 12h execution for CPU and
// GPU sessions; 20 GB auto-saved disk in /kaggle/working; T4 x2 = 2x T4,
// 4 vCPU, 29 GB RAM; 20 minutes idle time on interactive sessions.
// "Save & Run All" runs top-to-bottom in a fresh session (up to 12h) —
// the same commit/batch path as `kaggle kernels push`.
// Internet is a session setting, ON by default for new notebooks
// (Kaggle's own docs) — the plan's "no internet during GPU sessions" is
// NOT confirmed by the first-party docs. The offline-staging procedure
// stands regardless (reviewer-mandated, conservative); whether a GPU
// session can download weights in-session is a Part B verification item.

import { BaseExecutor } from './executor-base.js';
import { buildNotebook } from './staging.js';

export const KAGGLE_PROVIDER_ID = 'kaggle-t4';

// The dataset slug the official weights are staged under. The owner
// uploads the weights to this dataset in Part B; the kernel metadata
// references it via dataset_sources.
export const KAGGLE_WEIGHTS_DATASET_SLUG = 'wan22-ti2v-5b';

export class KaggleExecutor extends BaseExecutor {
  // transport: null (default — human runs the CLI) or an injected object
  //   { push, status, output } (see the module header).
  // kaggleUsername: the owner's Kaggle username, filled in at Part B.
  //   Until then the kernel metadata carries a placeholder.
  // pollIntervalMs: how often to poll `kaggle kernels status` with a
  //   transport (default 60 s — the CLI is rate-limited; do not poll fast).
  // pollTimeoutMs: backstop for a transport that never reports terminal
  //   (default 12 h — Kaggle's GPU session limit). The job's own
  //   timeoutMs (params.timeoutMs) is the primary bound.
  // notebookBuilder: injectable so Part B can build the trivial GPU
  // smoke kernel (staging.js buildSmokeNotebook) through the same
  // packaging path. Default is the Wan proof notebook (buildNotebook).
  // enableInternet: the smoke kernel (Part B B-K8) sets this true to
  // test in-session downloads empirically. Default false (offline run).
  constructor({
    transport = null,
    kaggleUsername = null,
    notebookBuilder = null,
    enableInternet = null,
    pollIntervalMs = 60_000,
    pollTimeoutMs = 12 * 3600 * 1000,
    // Kaggle design v4 §5.5 / T-V16: kernel privacy. The default (null)
    // is private; an explicit `isPrivate: false` is refused at the
    // metadata boundary — a public kernel is never built, so prompts and
    // keyframes can never be pushed public by a caller option.
    isPrivate = null,
    ...rest
  } = {}) {
    super({ providerId: KAGGLE_PROVIDER_ID, ...rest });
    // Rev 4.8 §5.3/§7: the Kaggle executor serves the personal
    // (owner-only) audience exclusively. _start() refuses a missing,
    // unknown, or mismatched job audience; submit() accepts only an
    // explicitly personal audience at the transport boundary too, so no
    // single layer's failure can route a public prompt to Kaggle.
    this.audience = 'personal';
    this.transport = transport;
    this.kaggleUsername = kaggleUsername;
    this.notebookBuilder = notebookBuilder;
    this.enableInternet = enableInternet;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.isPrivate = isPrivate;
  }

  async submit(job, manifest) {
    // Rev 4.8 §5.3/§7, layer 3 — transport (M2-P round 2,
    // reviewer-prescribed strict check): the Kaggle transport accepts
    // ONLY an explicitly personal audience. A missing, unknown, or
    // public audience throws audience-mismatch — no package is built,
    // no push is attempted. _start() already refuses a non-matching
    // audience, so this fires for a direct submit() call — defense in
    // depth, not the primary gate. A throw here becomes a failed report
    // via start()'s catch.
    if (job?.params?.audience !== 'personal') {
      throw new Error(
        'audience-mismatch: Kaggle transport requires personal audience',
      );
    }
    const dir = this._packageDirFor(job.id);
    // The notebook builder is injectable (see the constructor): the
    // default builds the Wan proof notebook; Part B injects
    // buildSmokeNotebook for the trivial GPU smoke kernel.
    const build = this.notebookBuilder ?? buildNotebook;
    const notebook = build({
      job,
      manifest,
      provider: KAGGLE_PROVIDER_ID,
      offline: true,
    });
    this._writeFile(dir, 'notebook.ipynb', JSON.stringify(notebook, null, 2));
    this._writeFile(dir, 'staging-manifest.json', JSON.stringify(manifest, null, 2));
    this._writeFile(dir, 'kernel-metadata.json', JSON.stringify(
      this._kernelMetadata(job, manifest),
      null, 2,
    ));
    this._writeFile(dir, 'README.md', this._readme(job, manifest));

    // With an injected transport, push now; without one, the human runs
    // the CLI (Part B). A failed push is a failed submission — the base
    // class turns the throw into a failed report.
    let kernelId = null;
    if (this.transport) {
      const pushed = await this.transport.push(dir);
      if (!pushed || !pushed.ok) {
        throw new Error(
          `kaggle kernels push failed: ${pushed?.error ?? 'unknown error'}`,
        );
      }
      kernelId = pushed.kernelId ?? null;
    }

    return {
      channel: this.transport ? 'kaggle-cli' : 'kaggle-cli-human',
      packageDir: dir,
      kernelId,
      kernelMetadata: this._kernelMetadata(job, manifest),
    };
  }

  // With a transport, poll `kaggle kernels status` until the run ends;
  // without one, the manual channel waits for fileReport.
  afterSubmit(job, _manifest, submission) {
    if (!this.transport || !submission.kernelId) return;
    this._startPolling(job.id, submission.kernelId, submission.startedAt);
  }

  _startPolling(jobId, kernelId, startedAt) {
    const poll = async () => {
      // Resolved by another path (fileReport, or the job finalized) —
      // stop polling.
      if (!this.pending.has(jobId)) return;
      if (Date.now() - startedAt > this.pollTimeoutMs) {
        this._resolve(jobId, {
          jobId,
          providerId: KAGGLE_PROVIDER_ID,
          status: 'failed',
          secondsUsed: 0,
          costUsd: 0,
          completedAt: Date.now(),
          resultRef: null,
          error: `poll-timeout: no terminal status after ${this.pollTimeoutMs}ms`,
        });
        return;
      }
      try {
        const st = await this.transport.status(kernelId);
        if (st.state === 'complete') {
          const raw = await this.transport.output(kernelId);
          this._resolve(jobId, this._normalizeReport({ ...raw, jobId }));
          return;
        }
        if (st.state === 'error') {
          this._resolve(jobId, {
            jobId,
            providerId: KAGGLE_PROVIDER_ID,
            status: 'failed',
            secondsUsed: 0,
            costUsd: 0,
            completedAt: Date.now(),
            resultRef: null,
            error: `kaggle-kernel-error: ${st.error ?? 'kernel failed'}`,
          });
          return;
        }
        // Still running — poll again. unref: polling must never hold the
        // process open (same rule as the mock's timers).
        const t = setTimeout(poll, this.pollIntervalMs);
        t.unref?.();
      } catch (err) {
        // A transient poll failure must not kill the job — record it and
        // retry next interval. The poll timeout bounds a dead transport.
        const record = this.submissions.get(jobId);
        if (record) record.lastPollError = String(err?.message ?? err);
        const t = setTimeout(poll, this.pollIntervalMs);
        t.unref?.();
      }
    };
    const t0 = setTimeout(poll, this.pollIntervalMs);
    t0.unref?.();
  }

  _kernelMetadata(job, manifest) {
    // T-V16: a public kernel is refused outright — the metadata is the
    // enforcement point, so no push path can ever carry is_private:false.
    if (this.isPrivate === false) {
      throw new Error(
        'kaggle kernel must be private: is_private:false is refused (prompts and keyframes must not be public)',
      );
    }
    const owner = this.kaggleUsername ?? '<kaggle-username>';
    const meta = {
      id: `${owner}/nova-gpu-cloud-${job.id}`,
      title: `NOVA GPU Cloud — ${job.id}`,
      code_file: 'notebook.ipynb',
      language: 'python',
      kernel_type: 'notebook',
      is_private: true,
      enable_gpu: true,
      // Internet stays OFF for the proof run (offline staging). The
      // smoke kernel (Part B B-K8) sets enableInternet: true to test
      // in-session downloads empirically.
      enable_internet: this.enableInternet ?? false,
      dataset_sources: [],
      competition_sources: [],
      kernel_sources: [],
    };
    if (manifest.route === 'official') {
      // The 34 GB official weights ride on a dataset mount, NOT working
      // storage (20 GB limit). The dataset must exist before the push.
      meta.dataset_sources = [`${owner}/${KAGGLE_WEIGHTS_DATASET_SLUG}`];
    }
    return meta;
  }

  _readme(job, manifest) {
    // The smoke kernel is trivial (minutes); the proof run gets the 12h cap.
    const timeoutS = manifest.route === 'smoke' ? 600 : 43200;
    const lines = [
      `# NOVA GPU Cloud — Kaggle job package: ${job.id}`,
      ``,
      `Model: ${job.modelId} (${manifest.route} route) | Provider: kaggle-t4`,
      ``,
      `## Files`,
      ``,
      `- \`notebook.ipynb\` — the self-contained notebook (only this file is sent on push)`,
      `- \`kernel-metadata.json\` — kernel metadata (GPU on, internet off${manifest.route === 'official' ? ', weights dataset attached' : ''})`,
      `- \`staging-manifest.json\` — the VDP-04 staging manifest (weights, config, VAE, text encoder, packages)`,
      ``,
      `## Before the first push (Part B, human)`,
      ``,
      `1. Sign in to Kaggle as the owner's account and complete phone verification (gates the GPU accelerator and the Internet toggle).`,
      `2. Fill in the Kaggle username in \`kernel-metadata.json\` (currently \`<kaggle-username>\`).`,
    ];
    if (manifest.route === 'official') {
      lines.push(
        `3. Upload the 34 GB official weights as a private Kaggle Dataset named \`${KAGGLE_WEIGHTS_DATASET_SLUG}\` (the dataset_sources entry in kernel-metadata.json). The weights do NOT fit /kaggle/working (20 GB).`,
      );
    }
    lines.push(
      ``,
      `## Run it`,
      ``,
      `    cd ${job.id}`,
      `    kaggle kernels push -p . --accelerator NvidiaTeslaT4 -t ${timeoutS}`,
      ``,
      manifest.route === 'smoke'
        ? `(-t 600 = 10 min timeout. The smoke kernel is trivial — minutes, not hours.)`
        : `(-t 43200 = 12h timeout, Kaggle's GPU session limit. The proof run is expected to take far less.)`,
      ``,
      `## Poll + download the report`,
      ``,
      `    kaggle kernels status <kaggle-username>/nova-gpu-cloud-${job.id}`,
      `    kaggle kernels output -p . <kaggle-username>/nova-gpu-cloud-${job.id}`,
      ``,
      `Then file the report JSON (${job.id}.report.json) with the manager (see docs/connection-layer.md §6) and download the MP4 separately — no media passes through the manager (O-27).`,
      ``,
      `## Cancel`,
      ``,
      `The Kaggle CLI has NO cancel command. To stop a runaway run, open the kernel in the Kaggle web UI and delete/stop it there.`,
      ``,
      `## Papermill`,
      ``,
      `Kaggle runs committed notebooks via papermill, which kills a kernel that produces no output for ~4 s. The notebook prints progress with flush=True throughout — do not remove the prints.`,
      ``,
    );
    return lines.join('\n');
  }
}
