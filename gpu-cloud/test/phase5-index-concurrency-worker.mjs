// phase5-index-concurrency-worker.mjs — child-process worker for the
// Finding 10C cross-process index test (phase5-storage-runner.test.mjs).
//
// Puts N persistent objects (namespace 'models') into a shared store,
// issues one delivery ref per object, redeems each ref once, and writes
// the accepted ids + refs to a result file. The parent runs runner
// sweeps against the same store while this worker writes: every object
// the worker accepted must stay readable afterwards.
//
// Usage:
//   node phase5-index-concurrency-worker.mjs --data-dir <dir> --count <n> --out <file>

import fs from 'node:fs';
import path from 'node:path';

import { createStorage } from '../src/storage/index.js';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const dataDir = get('--data-dir');
const count = Number(get('--count') ?? '20');
const outPath = get('--out');
if (!dataDir || !outPath || !Number.isInteger(count) || count <= 0) {
  console.error('usage: phase5-index-concurrency-worker.mjs --data-dir <dir> --count <n> --out <file>');
  process.exit(2);
}

const storage = createStorage({ rootDir: path.join(dataDir, 'store') });
const accepted = [];
for (let i = 0; i < count; i++) {
  const src = path.join(dataDir, `worker-src-${i}.bin`);
  fs.writeFileSync(src, Buffer.alloc(64, (i * 7 + 1) % 251));
  const record = await storage.put({ namespace: 'models', source: src, contentType: 'application/octet-stream' });
  const ref = await storage.issueDeliveryRef({ namespace: 'models', objectId: record.objectId });
  const redeemed = await storage.redeemDeliveryRef(ref.ref);
  accepted.push({
    namespace: 'models',
    objectId: record.objectId,
    sizeBytes: record.sizeBytes,
    ref: ref.ref,
    redemptions: redeemed.redemptions,
  });
  // Yield between puts so the parent's sweeps interleave with the writes.
  await new Promise((r) => setTimeout(r, 25));
}
fs.writeFileSync(outPath, JSON.stringify({ accepted }, null, 2) + '\n');
