// NOVA Personal GPU Cloud — LIVE storage connection test.
//
// Proves the manager ↔ cloud-store wiring end to end against the REAL
// live store (gpu-cloud/data/store/) with a REAL file: the in-house
// proof clip (our own synthetic output — VDP-06 clean).
//
//   node scripts/storage-live-test.mjs
//
// What it does, in order:
//   1. Copies the proof clip to scratch (the original is never moved,
//      never written to — the copy is deleted at the end).
//   2. Submits a live job and stores the clip under `outputs` via the
//      manager (24h TTL). Verifies the stored hash == the original's
//      SHA-256, size, chunk count and retention.
//   3. Retrieves it through the manager and verifies byte-identical +
//      checksum match.
//   4. Issues a delivery reference through the manager (stored as the
//      job's resultRef), redeems it, verifies it resolves.
//   5. Verifies usage accounting reflects the object.
//   6. Proves expiry on the live store with a short-TTL object: present,
//      then gone after a manager sweep (no 24h wait — per-object TTL
//      override, which the design supports). Its delivery ref fails
//      after deletion.
//   7. Proves the sweep TIMER on the live store: a second short-TTL
//      object disappears with the timer running and no manual sweep.
//
// The clip STAYS in the live store afterwards (it is the store's first
// real object; it expires automatically 24h after creation). The
// short-TTL objects are deleted by the test itself. The scratch copy is
// removed. Nothing is committed, pushed or deployed. Exits non-zero on
// any failed check, printing exactly which one.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGpuCloud } from '../src/setup.js';
import { GENERATED_CONTENT_TTL_MS } from '../src/storage/index.js';

const GPU_CLOUD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOVA_ROOT = path.resolve(GPU_CLOUD_ROOT, '..');
const PROOF_CLIP = path.join(NOVA_ROOT, 'proof-clip-2026-11-24', 'dragon-ridge-proof-8s.mp4');
const SCRATCH_DIR = path.join(GPU_CLOUD_ROOT, 'data', '.live-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`live test failed at: ${name}${detail ? ` (${detail})` : ''}`);
}

async function main() {
  console.log('NOVA GPU Cloud — LIVE storage connection test');
  console.log(`  proof clip: ${PROOF_CLIP}`);

  // --- 1. Copy the clip to scratch (original never moved, never written).
  if (!fs.existsSync(PROOF_CLIP)) throw new Error(`proof clip missing: ${PROOF_CLIP}`);
  const originalSize = fs.statSync(PROOF_CLIP).size;
  const originalHash = sha256File(PROOF_CLIP);
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  const scratchCopy = path.join(SCRATCH_DIR, 'dragon-ridge-proof-8s.mp4');
  fs.copyFileSync(PROOF_CLIP, scratchCopy);
  check('scratch copy matches the original', sha256File(scratchCopy) === originalHash);
  console.log(`  original: ${originalSize} bytes, sha256 ${originalHash}`);

  const cloud = createGpuCloud();
  const { manager } = cloud;
  console.log(`  live store: ${cloud.storageRootDir}`);

  try {
    // --- 2. Store the clip under `outputs` via the manager.
    const { job, created } = manager.submit({
      idempotencyKey: 'live-storage-test-20261124',
      type: 'video',
      modelId: 'wan2.2-ti2v-5b',
      prompt: 'live storage connection test (synthetic)',
      params: { stage2Test: true, testImage: 'synthetic' },
    });
    console.log(`  job ${job.id} (created: ${created})`);
    const record = await manager.storeJobOutput(job.id, {
      source: scratchCopy,
      contentType: 'video/mp4',
    });
    check('stored object id IS the original hash', record.objectId === originalHash, record.objectId.slice(0, 16) + '…');
    check('stored size matches the original', record.sizeBytes === originalSize, `${record.sizeBytes} bytes`);
    check('single chunk (1.8 MB < 4 MiB chunk)', record.chunkCount === 1, `${record.chunkCount} chunk(s)`);
    check('outputs namespace, transient retention', record.namespace === 'outputs' && record.retentionPolicy === 'transient');
    check(
      '24h TTL on the stored clip',
      record.expiresAt === record.createdAt + GENERATED_CONTENT_TTL_MS,
      `expires ${new Date(record.expiresAt).toISOString()}`,
    );
    console.log(`  stored${record.deduplicated ? ' (deduplicated — already present)' : ''}: ${record.namespace}/${record.objectId}`);

    // --- 3. Retrieve through the manager: byte-identical + checksum match.
    const retrieved = await manager.getJobOutputBuffer(job.id);
    check('retrieved bytes identical to the original', Buffer.compare(retrieved, fs.readFileSync(PROOF_CLIP)) === 0);
    check('retrieved checksum matches', sha256Buffer(retrieved) === originalHash);
    const head = manager.headJobOutput(job.id);
    check('head() metadata agrees', head && head.sizeBytes === originalSize && head.objectId === originalHash);

    // --- 4. Delivery reference through the manager.
    const ref = await manager.issueJobDeliveryRef(job.id);
    check('delivery ref issued (opaque nova://)', ref.ref.startsWith('nova://delivery/'));
    check('job resultRef holds the ref, not bytes', manager.getJob(job.id).resultRef === ref.ref);
    const redeemed = await cloud.storage.redeemDeliveryRef(ref.ref);
    check('delivery ref redeems to the stored clip', redeemed.objectId === originalHash);

    // --- 5. Usage accounting.
    const usage = manager.storageUsage();
    check(
      'usage reflects the clip',
      (usage.namespaces.outputs?.bytes ?? 0) >= originalSize &&
        (usage.namespaces.outputs?.objects ?? 0) >= 1,
      `outputs: ${usage.namespaces.outputs?.objects} object(s), ${usage.namespaces.outputs?.bytes} bytes; total ${usage.totalObjects} object(s)`,
    );

    // --- 6. Expiry proof: short-TTL object + manager sweep (no 24h wait).
    const { job: expiryJob } = manager.submit({
      idempotencyKey: 'live-storage-test-20261124-expiry',
      type: 'video',
      modelId: 'wan2.2-ti2v-5b',
      prompt: 'live storage expiry test (synthetic)',
      params: { stage2Test: true, testImage: 'synthetic' },
    });
    const shortBytes = Buffer.from('live-expiry-proof-object');
    await manager.storeJobOutput(expiryJob.id, {
      source: shortBytes,
      contentType: 'text/plain',
      ttlMs: 3000,
    });
    check('short-TTL object present before expiry', manager.headJobOutput(expiryJob.id) !== null);
    const expiryRef = await manager.issueJobDeliveryRef(expiryJob.id);
    check('short-TTL object has a live delivery ref', (await cloud.storage.redeemDeliveryRef(expiryRef.ref)).objectId === sha256Buffer(shortBytes));
    console.log('  waiting 4s for the 3s TTL to pass…');
    await sleep(4000);
    const sweep = await manager.runStorageSweep();
    const expectedId = `outputs/${sha256Buffer(shortBytes)}`;
    check(
      'manager sweep deleted the expired object',
      sweep.deletedIds.includes(expectedId) && sweep.bytesFreed >= shortBytes.length,
      `deleted ${sweep.deleted} (${sweep.deletedIds.join(', ')}), freed ${sweep.bytesFreed} bytes`,
    );
    check('expired object reads as gone', manager.headJobOutput(expiryJob.id) === null);
    check('job outputRef cleared after expiry', manager.getJob(expiryJob.id).outputRef === null);
    let refFailed = false;
    try {
      await cloud.storage.redeemDeliveryRef(expiryRef.ref);
    } catch (err) {
      refFailed = err.name === 'DeliveryRefError';
    }
    check('delivery ref dies with its object', refFailed);

    // --- 7. Timer proof: short-TTL object, timer running, NO manual sweep.
    const { job: timerJob } = manager.submit({
      idempotencyKey: 'live-storage-test-20261124-timer',
      type: 'video',
      modelId: 'wan2.2-ti2v-5b',
      prompt: 'live storage timer test (synthetic)',
      params: { stage2Test: true, testImage: 'synthetic' },
    });
    await manager.storeJobOutput(timerJob.id, {
      source: Buffer.from('live-timer-proof-object'),
      contentType: 'text/plain',
      ttlMs: 2000,
    });
    manager.startStorageSweep(1000);
    console.log('  sweep timer started (1s interval); waiting 4s with no manual sweep…');
    await sleep(4000);
    check('timer swept the expired object on its own', manager.headJobOutput(timerJob.id) === null);
    manager.stopStorageSweep();
    check('sweep timer stopped cleanly', cloud.storage.sweepTimer === null);

    // --- Final state.
    const finalUsage = manager.storageUsage();
    console.log(`\n  final store state: ${finalUsage.totalObjects} object(s), ${finalUsage.totalBytes} bytes`);
    console.log(`  the proof clip stays in the live store until ${new Date(record.expiresAt).toISOString()} (24h TTL)`);
    console.log(`\nLIVE STORAGE TEST: ALL ${checks.length} CHECKS PASSED`);
  } finally {
    // Scratch is scratch: the copy goes, the stored object stays.
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    console.log('  scratch copy removed; original untouched.');
  }
}

main().catch((err) => {
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  console.error(`\nLIVE STORAGE TEST FAILED: ${err?.message ?? err}`);
  if (failed.length > 0) console.error(`failed checks: ${failed.join('; ')}`);
  process.exit(1);
});
