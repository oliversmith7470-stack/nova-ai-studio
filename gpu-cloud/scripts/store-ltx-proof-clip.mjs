// Store the LTX proof clip in the live GPU Cloud store (outputs, 24h TTL)
// and verify retrieval + delivery ref. Run after the kernel completes:
//
//   node scripts/store-ltx-proof-clip.mjs <mp4-path> [idempotency-key]
//
// The idempotency key defaults to 'ltx-proof-20261124-01' (run 4). Use a
// distinct key per run (e.g. 'ltx-proof-20261124-01-v5') so each run's
// stored clip keeps its own job record.
//
// Same route as the Wan proof clip (storage-live-test.mjs pattern).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createGpuCloud } from '../src/setup.js';
import { GENERATED_CONTENT_TTL_MS } from '../src/storage/index.js';

const MP4 = process.argv[2];
const JOB_KEY = process.argv[3] || 'ltx-proof-20261124-01';
if (!MP4 || !fs.existsSync(MP4)) {
  console.error('usage: node scripts/store-ltx-proof-clip.mjs <mp4-path> [idempotency-key]');
  process.exit(2);
}

const bytes = fs.readFileSync(MP4);
const hash = createHash('sha256').update(bytes).digest('hex');
console.log(`clip: ${MP4}`);
console.log(`size: ${bytes.length} bytes, sha256 ${hash}`);

const cloud = createGpuCloud();
const { manager } = cloud;

const { job } = manager.submit({
  idempotencyKey: JOB_KEY,
  type: 'video',
  modelId: 'ltx-video-2b-distilled-0.9.8',
  prompt: 'An ash-grey dragon with ember-cracked wings rests on a misty mountain ridge at dawn; the dragon slowly raises its wings from folded at its sides to spread high above its back, lifting its head toward the camera, mist drifts across the ridge, embers rise glowing from its wings, epic fantasy film, dramatic dawn light (LTX proof, synthetic)',
  params: { stage2Test: true, testImage: 'synthetic' },
});
console.log(`job ${job.id}`);

const record = await manager.storeJobOutput(job.id, {
  source: MP4,
  contentType: 'video/mp4',
});
console.log(`stored: ${record.namespace}/${record.objectId}`);
console.log(`  size ${record.sizeBytes} bytes, chunks ${record.chunkCount}, retention ${record.retentionPolicy}`);
console.log(`  expires ${new Date(record.expiresAt).toISOString()}`);
if (record.objectId !== hash) throw new Error('stored objectId != file sha256');
if (record.sizeBytes !== bytes.length) throw new Error('stored size != file size');
if (record.expiresAt !== record.createdAt + GENERATED_CONTENT_TTL_MS) throw new Error('TTL is not 24h');

const retrieved = await manager.getJobOutputBuffer(job.id);
if (Buffer.compare(retrieved, bytes) !== 0) throw new Error('retrieved bytes differ');
console.log('retrieved bytes identical to the file');

const ref = manager.issueJobDeliveryRef(job.id);
console.log(`delivery ref: ${ref.ref}`);
const redeemed = cloud.storage.redeemDeliveryRef(ref.ref);
if (redeemed.objectId !== hash) throw new Error('delivery ref redeems to the wrong object');
console.log('delivery ref redeems to the stored clip');
console.log('STORE OK');
