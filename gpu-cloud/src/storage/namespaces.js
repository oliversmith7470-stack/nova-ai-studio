// NOVA Personal GPU Cloud — NOVA Cloud Storage: namespaces.
//
// The store is NOVA AI Studio's storage foundation (owner direction, 24 Nov
// 2026 ~16:44 WAT): everything that works on NOVA rests on it — videos,
// images, text, and all data from everything users do on the platform.
// Namespaces separate those kinds so each gets its own retention default.
// Objects are addressed (namespace, objectId); the same bytes in two
// namespaces are two objects, because their retention differs.
//
// Retention defaults (owner direction, 24 Nov 2026 ~16:46 WAT):
//   - GENERATED OUTPUTS expire 24 hours after creation and are deleted
//     automatically by the manager's sweep. A user has 24 hours from
//     generation to download what was generated.
//   - Models, system files, job records, project metadata, prompts and
//     other small records PERSIST — they are not generated content, and
//     re-fetching 10–28 GB of weights every day is infeasible (Kaggle GPU
//     sessions have no internet).
// Per-object retention overrides are supported at put time (see
// retention.js): a prompt or script stored in `text` passes
// retention: 'persistent'; a throwaway working file in `jobs` passes a
// short transient TTL.

import { NamespaceError } from './errors.js';
import { GENERATED_CONTENT_TTL_MS } from './retention.js';

export const NAMESPACES = Object.freeze({
  // Model weights, configs, tokenizers, VAE + text-encoder files and
  // other system files — the VDP-04 staging set. PERSISTENT.
  models: Object.freeze({
    retention: 'persistent',
    defaultTtlMs: null,
    description: 'Model weights, configs, tokenizers, VAE/text-encoder files, system files.',
  }),
  // Job inputs (prompts, start images), job working files, job records.
  // PERSISTENT by default — prompts and records are small and the manager
  // needs them for reconciliation and audit. Throwaway working files use
  // a per-object transient override. NOTE (open for the owner to correct):
  // uploaded input images currently persist with the job record; the 24h
  // rule covers GENERATED outputs only.
  jobs: Object.freeze({
    retention: 'persistent',
    defaultTtlMs: null,
    description: 'Job inputs (prompts, start images), working files, job records.',
  }),
  // Generated images/videos in transit to delivery — where a GPU worker
  // lands a fresh generation. 24h TTL.
  outputs: Object.freeze({
    retention: 'transient',
    defaultTtlMs: GENERATED_CONTENT_TTL_MS,
    description: 'Generated images/videos in transit to delivery.',
  }),
  // Generated videos + images (the generated-content namespace). 24h TTL.
  // `outputs` is the landing stage, `media` the generated-content home;
  // both expire 24h after creation.
  media: Object.freeze({
    retention: 'transient',
    defaultTtlMs: GENERATED_CONTENT_TTL_MS,
    description: 'Generated videos + images.',
  }),
  // Generated text by default (24h TTL). Prompts and scripts are records,
  // not outputs — store them with retention: 'persistent'.
  text: Object.freeze({
    retention: 'transient',
    defaultTtlMs: GENERATED_CONTENT_TTL_MS,
    description: 'Generated text (default); prompts/scripts via persistent override.',
  }),
  // User project data, project metadata, activity records. PERSISTENT.
  projects: Object.freeze({
    retention: 'persistent',
    defaultTtlMs: null,
    description: 'User project data, project metadata, activity records.',
  }),
});

export function listNamespaces() {
  return Object.keys(NAMESPACES);
}

export function isNamespace(name) {
  return Object.prototype.hasOwnProperty.call(NAMESPACES, name);
}

export function assertNamespace(name) {
  if (!isNamespace(name)) {
    throw new NamespaceError(name);
  }
  return NAMESPACES[name];
}
