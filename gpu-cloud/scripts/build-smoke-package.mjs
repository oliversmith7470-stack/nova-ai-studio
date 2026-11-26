// NOVA GPU Cloud — Part B smoke package builder (B-K6/B-K8).
//
// Writes the trivial GPU smoke kernel package using the Stage 2
// generator: KaggleExecutor.submit() + staging.js buildSmokeNotebook
// (same packaging path as the Wan proof job — notebook + kernel
// metadata + staging manifest + README). It does NOT push anything;
// the operator pushes with the Kaggle CLI afterwards.
//
// Usage: node scripts/build-smoke-package.mjs
// Output: packages/smoke-20261124-01/ (notebook.ipynb, kernel-metadata.json,
//   staging-manifest.json, README.md)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KaggleExecutor } from '../src/kaggle-executor.js';
import { SMOKE_MANIFEST, buildSmokeNotebook } from '../src/staging.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const job = {
  id: 'smoke-20261124-01',
  modelId: 'smoke',
  prompt: 'smoke test — no generation (Part B B-K6/B-K8)',
};

const executor = new KaggleExecutor({
  packageDir: path.join(ROOT, 'packages'),
  // The Kaggle username is 'oliversmithh' (verified via `kaggle kernels
  // list --mine`, author "Oliver Smithh") — NOT 'Oliversmith7470'
  // (the Google account name). The push accepts the metadata id either
  // way, but status/output need the canonical ref.
  kaggleUsername: 'oliversmithh',
  notebookBuilder: buildSmokeNotebook,
  // Internet ON for the smoke kernel: the point is to answer B-K8
  // empirically (can a GPU session download in-session?).
  enableInternet: true,
});

const submission = await executor.submit(job, SMOKE_MANIFEST);
console.log(JSON.stringify(submission, null, 2));
