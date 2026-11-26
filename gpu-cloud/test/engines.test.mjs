// NOVA Personal GPU Cloud — engine registry tests.
//
// The registry is capability data: LTX is the only production engine;
// the five engines registered 25 Nov 2026 are unproven (Fun-InP is
// mid-proof) and must NOT be dispatchable.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineRegistry,
  ENGINE_DEFINITIONS,
  ENGINE_STATUSES,
  PRODUCTION_ENGINE_ID,
} from '../src/engines.js';

test('registry lists LTX plus the five engines registered 25 Nov 2026', () => {
  const registry = new EngineRegistry();
  assert.equal(registry.list().length, 6);
  for (const id of [
    'ltx-video-2b',
    'wan2.1-fun-inp-1.3b',
    'fastwan-1.3b',
    'sana-video-2b',
    'allegro-ti2v',
    'skyreels-v2-1.3b',
  ]) {
    assert.ok(registry.get(id), `${id} is registered`);
  }
});

test('every definition carries full metadata and a valid status', () => {
  const registry = new EngineRegistry();
  for (const e of registry.list()) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.label, 'string');
    assert.equal(typeof e.repo, 'string');
    assert.equal(typeof e.licence, 'string');
    assert.ok(Number.isFinite(e.paramsB) && e.paramsB > 0, `${e.id}: paramsB`);
    assert.ok(['bf16', 'fp16'].includes(e.precisionNative), `${e.id}: precisionNative`);
    assert.equal(typeof e.i2v.firstFrame, 'boolean', `${e.id}: i2v.firstFrame`);
    assert.equal(typeof e.i2v.lastFrame, 'boolean', `${e.id}: i2v.lastFrame`);
    assert.equal(typeof e.pipeline, 'string');
    assert.ok(ENGINE_STATUSES.includes(e.status), `${e.id}: status ${e.status}`);
    assert.equal(typeof e.connected, 'boolean', `${e.id}: connected`);
    assert.equal(typeof e.proofStatus, 'string');
    assert.equal(typeof e.proofRef, 'string');
    if (e.vramPeakGib !== null) {
      assert.ok(Number.isFinite(e.vramPeakGib), `${e.id}: vramPeakGib`);
    }
  }
});

test('LTX is the production engine and the only connected one', () => {
  const registry = new EngineRegistry();
  assert.equal(PRODUCTION_ENGINE_ID, 'ltx-video-2b');
  const prod = registry.production();
  assert.equal(prod.id, 'ltx-video-2b');
  assert.equal(prod.status, 'production');
  assert.equal(prod.connected, true);
  assert.deepEqual(
    registry.proven().map((e) => e.id),
    ['ltx-video-2b'],
  );
});

test('no unproven engine is dispatchable', () => {
  const registry = new EngineRegistry();
  for (const e of registry.list()) {
    if (e.id === 'ltx-video-2b') {
      assert.equal(registry.dispatchable(e.id), true);
    } else {
      assert.equal(registry.dispatchable(e.id), false, `${e.id} must not dispatch`);
    }
  }
});

test('first+last-frame I2V is declared for Fun-InP, Allegro and SkyReels, not FastWan or SANA', () => {
  const registry = new EngineRegistry();
  assert.equal(registry.supportsFirstLastFrame('wan2.1-fun-inp-1.3b'), true);
  assert.equal(registry.supportsFirstLastFrame('allegro-ti2v'), true);
  assert.equal(registry.supportsFirstLastFrame('skyreels-v2-1.3b'), true);
  assert.equal(registry.supportsFirstLastFrame('fastwan-1.3b'), false);
  assert.equal(registry.supportsFirstLastFrame('sana-video-2b'), false);
  assert.equal(registry.supportsFirstLastFrame('ltx-video-2b'), true);
});

test('Fun-InP is proving, FastWan and SANA are reviewer-deferred', () => {
  const registry = new EngineRegistry();
  assert.equal(registry.get('wan2.1-fun-inp-1.3b').status, 'proving');
  assert.equal(registry.get('fastwan-1.3b').status, 'deferred');
  assert.equal(registry.get('sana-video-2b').status, 'deferred');
});

test('register rejects definitions without an id, licence or proofStatus', () => {
  const registry = new EngineRegistry();
  assert.throws(() => registry.register({}), /id/);
  assert.throws(() => registry.register({ id: 'x' }), /licence/);
  assert.throws(
    () => registry.register({ id: 'x', licence: 'MIT' }),
    /proofStatus/,
  );
});

test('setStatus and setConnected flip only the named engine', () => {
  const registry = new EngineRegistry();
  registry.setStatus('skyreels-v2-1.3b', 'deferred');
  assert.equal(registry.get('skyreels-v2-1.3b').status, 'deferred');
  assert.equal(registry.get('allegro-ti2v').status, 'unproven');
  assert.throws(() => registry.setStatus('no-such-engine', 'deferred'), /unknown engine/);
  assert.throws(() => registry.setStatus('allegro-ti2v', 'bogus'), /must be one of/);
  registry.setConnected('skyreels-v2-1.3b', true);
  assert.equal(registry.get('skyreels-v2-1.3b').connected, true);
  assert.equal(registry.get('allegro-ti2v').connected, false);
});

test('definitions are frozen and registry instances are independent', () => {
  assert.ok(Object.isFrozen(ENGINE_DEFINITIONS));
  const a = new EngineRegistry();
  const b = new EngineRegistry();
  a.setStatus('allegro-ti2v', 'deferred');
  assert.equal(b.get('allegro-ti2v').status, 'unproven');
});
