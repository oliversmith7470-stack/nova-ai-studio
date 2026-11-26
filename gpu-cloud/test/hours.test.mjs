// NOVA Personal GPU Cloud — Stage 2: weekly GPU-hours tracking tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HoursTracker, weekStartMs, syncBudgetStatus, DEFAULT_WEEK_START_DAY } from '../src/hours.js';
import { JsonStore } from '../src/store.js';
import { ProviderRegistry } from '../src/providers.js';
import { tempDir } from './stage2-support.mjs';
import { fakeClock } from './support.mjs';
import path from 'node:path';

// A Saturday, 2026-11-28 00:00 UTC (the default week-start day).
const SAT_2026_11_28 = Date.UTC(2026, 10, 28, 0, 0, 0);

function makeTracker(t, budgets = { 'kaggle-t4': 30, 'colab-t4': 12 }, clock = fakeClock(SAT_2026_11_28)) {
  const dir = tempDir(t);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const tracker = new HoursTracker({ store, budgets, now: clock.now });
  return { tracker, store, clock, dir };
}

test('weekStartMs: a Saturday 00:00 UTC starts its own week', (t) => {
  assert.equal(weekStartMs(SAT_2026_11_28), SAT_2026_11_28);
});

test('weekStartMs: a Friday belongs to the previous Saturday', (t) => {
  const friday = Date.UTC(2026, 11, 4, 12, 0, 0); // Fri 4 Dec 2026
  assert.equal(weekStartMs(friday), SAT_2026_11_28);
});

test('weekStartMs: the default week-start day is Saturday (6)', (t) => {
  assert.equal(DEFAULT_WEEK_START_DAY, 6);
});

test('untracked providers report tracked: false and never spend', (t) => {
  const { tracker } = makeTracker(t);
  const u = tracker.usage('mock-t4');
  assert.equal(u.tracked, false);
  assert.equal(u.spent, false);
  assert.equal(tracker.isSpent('mock-t4'), false);
});

test('usage starts at 0 with the full budget remaining', (t) => {
  const { tracker } = makeTracker(t);
  const u = tracker.usage('kaggle-t4');
  assert.equal(u.tracked, true);
  assert.equal(u.hoursUsed, 0);
  assert.equal(u.hoursBudget, 30);
  assert.equal(u.hoursRemaining, 30);
  assert.equal(u.spent, false);
});

test('recordUsage accumulates seconds into hours', (t) => {
  const { tracker } = makeTracker(t);
  tracker.recordUsage('kaggle-t4', 3600); // 1h
  tracker.recordUsage('kaggle-t4', 1800); // 0.5h
  const u = tracker.usage('kaggle-t4');
  assert.equal(u.hoursUsed, 1.5);
  assert.equal(u.hoursRemaining, 28.5);
  assert.equal(u.spent, false);
});

test('recording the full budget marks the provider spent', (t) => {
  const { tracker } = makeTracker(t);
  const u = tracker.recordUsage('colab-t4', 12 * 3600);
  assert.equal(u.spent, true);
  assert.equal(u.hoursRemaining, 0);
  assert.equal(tracker.isSpent('colab-t4'), true);
});

test('usage persists in the store across tracker instances', (t) => {
  const dir = tempDir(t);
  const storePath = path.join(dir, 'state.json');
  const store1 = new JsonStore(storePath);
  const t1 = new HoursTracker({ store: store1, budgets: { 'kaggle-t4': 30 }, now: () => SAT_2026_11_28 });
  t1.recordUsage('kaggle-t4', 7200);
  const store2 = new JsonStore(storePath);
  const t2 = new HoursTracker({ store: store2, budgets: { 'kaggle-t4': 30 }, now: () => SAT_2026_11_28 });
  assert.equal(t2.usage('kaggle-t4').hoursUsed, 2);
});

test('a new week rolls the usage over to 0', (t) => {
  const { tracker, clock } = makeTracker(t);
  tracker.recordUsage('kaggle-t4', 29 * 3600);
  assert.equal(tracker.usage('kaggle-t4').hoursUsed, 29);
  clock.advance(8 * 24 * 3600 * 1000); // 8 days later — a new week
  const u = tracker.checkWeek('kaggle-t4');
  assert.equal(u.rolledOver, true);
  assert.equal(u.hoursUsed, 0);
  assert.equal(u.spent, false);
});

test('checkWeek does not roll over within the same week', (t) => {
  const { tracker, clock } = makeTracker(t);
  tracker.recordUsage('kaggle-t4', 3600);
  clock.advance(3 * 24 * 3600 * 1000); // 3 days later — same week
  const u = tracker.checkWeek('kaggle-t4');
  assert.equal(u.rolledOver, false);
  assert.equal(u.hoursUsed, 1);
});

test('recordUsage rejects negative or non-finite seconds', (t) => {
  const { tracker } = makeTracker(t);
  assert.throws(() => tracker.recordUsage('kaggle-t4', -1), /finite number/);
  assert.throws(() => tracker.recordUsage('kaggle-t4', Number.NaN), /finite number/);
});

test('syncBudgetStatus flips a spent connected provider to unavailable', (t) => {
  const { tracker, store } = makeTracker(t);
  const registry = new ProviderRegistry();
  registry.setConnected('kaggle-t4', true);
  registry.setStatus('kaggle-t4', 'available');
  tracker.recordUsage('kaggle-t4', 30 * 3600);
  syncBudgetStatus(registry, tracker, 'kaggle-t4');
  assert.equal(registry.get('kaggle-t4').status, 'unavailable');
  assert.equal(registry.dispatchable('kaggle-t4'), false);
  void store;
});

test('syncBudgetStatus restores a spent provider after the week rolls over', (t) => {
  const { tracker, clock } = makeTracker(t);
  const registry = new ProviderRegistry();
  registry.setConnected('kaggle-t4', true);
  registry.setStatus('kaggle-t4', 'available');
  tracker.recordUsage('kaggle-t4', 30 * 3600);
  syncBudgetStatus(registry, tracker, 'kaggle-t4');
  assert.equal(registry.get('kaggle-t4').status, 'unavailable');
  clock.advance(8 * 24 * 3600 * 1000);
  syncBudgetStatus(registry, tracker, 'kaggle-t4');
  assert.equal(registry.get('kaggle-t4').status, 'available');
  assert.equal(registry.dispatchable('kaggle-t4'), true);
});

test('syncBudgetStatus never restores a provider that was never connected', (t) => {
  const { tracker, clock } = makeTracker(t);
  const registry = new ProviderRegistry(); // kaggle-t4: not-connected
  tracker.recordUsage('kaggle-t4', 30 * 3600);
  clock.advance(8 * 24 * 3600 * 1000);
  syncBudgetStatus(registry, tracker, 'kaggle-t4');
  assert.equal(registry.get('kaggle-t4').status, 'not-connected');
  assert.equal(registry.get('kaggle-t4').connected, false);
});
