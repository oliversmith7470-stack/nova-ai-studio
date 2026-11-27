// NOVA AI Studio — the five non-commercial purposes (single source of
// truth).
//
// A personal (owner-only) job must carry an explicitly selected purpose
// from exactly these five (Rev 4.8 §12, item D, option (b) — Kaggle
// commercial-use decision 26 Nov 2026: personal Kaggle = demonstrably
// non-commercial work only). Both sides of the boundary import this
// module — the API-side activation.js and the Cloudflare Worker
// (_worker.js) — so the list can never drift between the two gates: a
// purpose outside the five is refused by one gate or the other, and a
// purpose in the five is accepted by both.
//
// This module has NO dependencies (no node: imports, no fs, no crypto)
// so it is importable from both the Node API process and the Workers
// runtime. Do NOT add a dependency here, and do NOT duplicate this list
// anywhere else: grep for 'own-non-monetised-film' must find this file
// as the only literal source.
//
// Round 3 (reviewer re-review verdict, 27 Nov 2026 §2): the Worker
// previously held its own Set literal of the same five strings; two
// identical copies can drift. The literal was removed; _worker.js
// imports this module instead.

export const NON_COMMERCIAL_PURPOSES = Object.freeze([
  'test',
  'proof',
  'benchmark',
  'experiment',
  'own-non-monetised-film',
]);
