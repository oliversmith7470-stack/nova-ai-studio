// NOVA Personal GPU Cloud — Stage 1: file-backed store.
//
// Persistence round-trips (a new manager on the same path sees the same
// state), writes are atomic (no temp files left behind, always valid
// JSON), and the store holds RECORDS ONLY — never media bytes (O-27).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GpuManager } from '../src/gpu-manager.js';
import { makeManager, submitImage, tempStorePath } from './support.mjs';

test('state survives a manager restart on the same path', async (t) => {
  const storePath = tempStorePath(t);
  const m1 = new GpuManager({ storePath });
  m1.setSpendingCeiling(7, { authorizedBy: 'Shina', reason: 'test' });
  const { job } = submitImage(m1, 'store-1');
  m1.dispatchNext();
  await m1.waitFor(job.id);
  m1.engageKillSwitch('test stop');

  const m2 = new GpuManager({ storePath });
  assert.equal(m2.getSpendingCeiling(), 7);
  assert.equal(m2.killSwitchEngaged(), true);
  assert.equal(m2.getJob(job.id).status, 'succeeded');
  assert.equal(m2.getJobByKey('store-1').id, job.id);
  assert.equal(m2.store.state.ceiling.changes.length, 1);
  assert.equal(m2.store.state.killSwitch.log.length, 1);
});

test('writes are atomic: no temp files left, always valid JSON', async (t) => {
  const storePath = tempStorePath(t);
  const m = new GpuManager({ storePath });
  const { job } = submitImage(m, 'store-atomic');
  m.dispatchNext();
  await m.waitFor(job.id);
  m.setSpendingCeiling(3, { authorizedBy: 'Shina', reason: 'test' });

  const dir = path.dirname(storePath);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);

  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(parsed.jobs[job.id].status, 'succeeded');
  assert.equal(parsed.version, 1);
});

test('the store holds records only — no media bytes anywhere', async (t) => {
  const storePath = tempStorePath(t);
  const m = new GpuManager({ storePath });
  const { job } = submitImage(m, 'store-nomedia');
  m.dispatchNext();
  await m.waitFor(job.id);

  const raw = fs.readFileSync(storePath, 'utf8');
  const parsed = JSON.parse(raw);

  // No media-ish fields anywhere in the stored document.
  const keys = [];
  (function walk(v) {
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    }
  })(parsed);
  for (const banned of ['bytes', 'base64', 'data', 'pixels', 'mp4', 'png']) {
    assert.ok(!keys.includes(banned), `store must not contain a '${banned}' field`);
  }

  // resultRef is an opaque reference string, not media.
  const stored = parsed.jobs[job.id];
  assert.equal(typeof stored.resultRef, 'string');
  assert.ok(stored.resultRef.startsWith('mock://transient/'));
  assert.ok(stored.resultRef.length < 100);

  // Every value in the document is a JSON primitive (string/number/
  // boolean/null) or a plain object/array of them — nothing binary.
  (function checkValues(v) {
    if (v === null) return;
    if (Array.isArray(v)) {
      v.forEach(checkValues);
      return;
    }
    if (typeof v === 'object') {
      Object.values(v).forEach(checkValues);
      return;
    }
    assert.ok(
      ['string', 'number', 'boolean'].includes(typeof v),
      `unexpected value type: ${typeof v}`,
    );
  })(parsed);
});

test('a fresh store starts at ceiling 0 with the kill-switch off', (t) => {
  const m = makeManager(t);
  assert.equal(m.getSpendingCeiling(), 0);
  assert.equal(m.killSwitchEngaged(), false);
  assert.deepEqual(m.stats(), {
    jobs: 0,
    byStatus: {},
    queueDepth: 0,
    ceilingUsd: 0,
    committedUsd: 0,
    killSwitchEngaged: false,
    inflight: 0,
  });
});
