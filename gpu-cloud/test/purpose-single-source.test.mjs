// NOVA Personal GPU Cloud — single-source-of-truth test for the five
// non-commercial purposes (M2-P round 3, reviewer re-review verdict
// §2).
//
// The five purposes must exist as exactly ONE literal in the repo:
// gpu-cloud/src/api-server/non-commercial-purposes.js. The API-side
// activation.js re-exports it, and the Cloudflare Worker (_worker.js)
// imports it. The Worker's old Set literal of the same five strings was
// removed — two identical copies can drift, and this test fails loudly
// if a second literal ever comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_COMMERCIAL_PURPOSES } from '../src/api-server/non-commercial-purposes.js';
import { NON_COMMERCIAL_PURPOSES as FROM_ACTIVATION } from '../src/api-server/activation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = ['test', 'proof', 'benchmark', 'experiment', 'own-non-monetised-film'];

test('the shared module holds exactly the five purposes, frozen', () => {
  assert.deepEqual([...NON_COMMERCIAL_PURPOSES], EXPECTED);
  assert.ok(Object.isFrozen(NON_COMMERCIAL_PURPOSES));
});

test('activation.js re-exports the same list (no second literal)', () => {
  assert.deepEqual([...FROM_ACTIVATION], EXPECTED);
  assert.equal(FROM_ACTIVATION, NON_COMMERCIAL_PURPOSES);
  const activationText = fs.readFileSync(
    path.join(ROOT, 'gpu-cloud/src/api-server/activation.js'), 'utf8',
  );
  assert.equal(
    activationText.includes('own-non-monetised-film'), false,
    'activation.js must not hold its own literal of the five',
  );
});

test('_worker.js imports the shared module and holds no second literal', () => {
  const workerText = fs.readFileSync(path.join(ROOT, '_worker.js'), 'utf8');
  assert.match(
    workerText,
    /import \{ NON_COMMERCIAL_PURPOSES \} from "\.\/gpu-cloud\/src\/api-server\/non-commercial-purposes\.js";/,
  );
  assert.equal(
    workerText.includes('own-non-monetised-film'), false,
    '_worker.js must not hold its own literal of the five',
  );
});
