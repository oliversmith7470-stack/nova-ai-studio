// NOVA Personal GPU Cloud — Stage 2: the Colab T4 executor.
//
// MECHANISM (researched from Google's Colab FAQ + official docs, via two
// independent 2026 sources, 24 Nov 2026):
//
//   THERE IS NO OFFICIAL COLAB API. Google's own FAQ: it is "not
//   possible to run Colab notebooks programmatically... unless you leave
//   your browser running." No official way exists to start a runtime, run
//   code headlessly, or fetch outputs. The paid ToS bans access "other
//   than by means authorized by Google" — paying does not legitimize
//   headless brokering. The only "automation" is headless-Selenium
//   UI-driving (e.g. colabctl), which breaks on UI changes and faces
//   idle-disconnect + non-guaranteed GPU. It is NOT used here.
//
// So the Colab executor is HONESTLY MANUAL: it prepares the job package
// (notebook + staging manifest + human instructions) and the human runs
// it in their browser. The executor does NOT pretend to dispatch to a
// live Colab runtime. There is no transport seam — nothing to inject —
// because there is no API to call.
//
// WHAT IS AUTOMATED vs WHAT NEEDS A HUMAN (evidence in
// docs/connection-layer.md §3):
//   Automated: the job package, the VDP-06 guard, the hours-budget
//   check, the staging prep test, the notebook (with an in-session
//   download cell — Colab sessions HAVE internet, so the weights
//   download in-session; no dataset upload is needed).
//   Human (every run): open the notebook in Colab, select the T4 GPU
//   runtime, run all cells, keep the browser open (no background
//   execution — execution STOPS when the browser closes), download the
//   report + MP4, file the report with the manager.
//
// FREE-TIER FACTS: 12h max session; NO background execution; T4 subject
// to quota + availability (NOT guaranteed); idle timeouts and usage caps
// UNPUBLISHED ("Colab does not publish these limits"). The 12-15h/week
// figure is a third-party estimate, used as a planning figure only.
// A Colab run can therefore fail at the "get a GPU" step for reasons
// outside the manager's control — the human reports that as a failed
// report (error: colab-gpu-unavailable) so the job is retried elsewhere.
//
// NO CANCEL: there is no API, so requestCancel() returns false. The
// human stops the runtime in the browser (Runtime > Disconnect and
// delete runtime).

import { BaseExecutor } from './executor-base.js';
import { buildNotebook } from './staging.js';

export const COLAB_PROVIDER_ID = 'colab-t4';

export class ColabExecutor extends BaseExecutor {
  constructor({ ...rest } = {}) {
    super({ providerId: COLAB_PROVIDER_ID, ...rest });
  }

  async submit(job, manifest) {
    const dir = this._packageDirFor(job.id);
    // Colab sessions have internet: the notebook downloads the weights
    // in-session (offline: false adds the download cell).
    const notebook = buildNotebook({
      job,
      manifest,
      provider: COLAB_PROVIDER_ID,
      offline: false,
    });
    this._writeFile(dir, 'notebook.ipynb', JSON.stringify(notebook, null, 2));
    this._writeFile(dir, 'staging-manifest.json', JSON.stringify(manifest, null, 2));
    this._writeFile(dir, 'INSTRUCTIONS.md', this._instructions(job, manifest));

    return {
      channel: 'human-manual',
      packageDir: dir,
      kernelId: null,
    };
  }

  // No API exists, so there is nothing to cancel through. The human stops
  // the runtime in the browser.
  async requestCancel(_jobId) {
    return false;
  }

  _instructions(job, manifest) {
    return [
      `# NOVA GPU Cloud — Colab job package: ${job.id}`,
      ``,
      `Model: ${job.modelId} (${manifest.route} route) | Provider: colab-t4`,
      ``,
      `> Colab has NO official API — this run is manual by design. The manager prepared the`,
      `> notebook; a human runs it in the browser. Do not attempt to automate the Colab UI`,
      `> (headless-Selenium driving breaks on UI changes and is not an authorized access method).`,
      ``,
      `## Files`,
      ``,
      `- \`notebook.ipynb\` — the self-contained notebook (includes an in-session weights download cell; Colab sessions have internet)`,
      `- \`staging-manifest.json\` — the VDP-04 staging manifest`,
      ``,
      `## Run it (human, every run)`,
      ``,
      `1. Open https://colab.new and upload \`notebook.ipynb\` (File > Upload notebook).`,
      `2. Runtime > Change runtime type > Hardware accelerator: **T4 GPU**. (A T4 is NOT guaranteed — if Colab offers no GPU, stop and file a failed report: error \`colab-gpu-unavailable\`.)`,
      `3. Runtime > Run all.`,
      `4. KEEP THE BROWSER OPEN — Colab has no background execution; closing the browser stops the run.`,
      `5. When the notebook finishes, download the report JSON (\`${job.id}.report.json\`) and the MP4 from the output folder.`,
      `6. File the report JSON with the manager (see docs/connection-layer.md §6). The MP4 is downloaded separately — no media passes through the manager (O-27).`,
      ``,
      `## Cancel`,
      ``,
      `Runtime > Disconnect and delete runtime. Then file a failed report (error \`cancelled-by-human\`) so the manager records the outcome.`,
      ``,
      `## If the GPU is unavailable`,
      ``,
      `File a failed report with error \`colab-gpu-unavailable\` and the job can be retried on Kaggle. Do not keep retrying Colab in a loop — the quota is unpublished and retries burn it.`,
      ``,
    ].join('\n');
  }
}
