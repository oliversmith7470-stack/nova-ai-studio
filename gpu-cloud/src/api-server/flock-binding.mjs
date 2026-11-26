// flock-binding.mjs — loader for the native flock(2) binding.
//
// NOVA Phase 5 Rev 4.8 (design §10): the alert dispatcher imports
// { flockExNb, flockUn } from this module. This file is a thin loader over
// the compiled N-API addon ./flock-binding.node, whose canonical source is
// ./flock-binding.cc (rebuild with ./build-flock-binding.sh).
//
//   flockExNb(fd) — flock(fd, LOCK_EX | LOCK_NB):
//       true on success; false when the lock is held (EWOULDBLOCK);
//       throws on any other failure.
//   flockUn(fd) — flock(fd, LOCK_UN); throws on failure.
//
// If the .node file is absent or fails to load, the import throws here —
// by design: the install check must prove the binding works on the target
// host before the dispatcher is installed, and a dispatcher that cannot
// lock must never run (fail-closed).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('./flock-binding.node');

export const flockExNb = binding.flockExNb;
export const flockUn = binding.flockUn;
