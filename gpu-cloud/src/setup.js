// NOVA Personal GPU Cloud — Stage 2: setup factory.
//
// createGpuCloud() wires a GpuManager with the Stage 2 executors:
//   - the Stage 1 mock (unchanged),
//   - kaggle-t4 (KaggleExecutor),
//   - colab-t4 (ColabExecutor),
// plus the weekly hours tracker, built from the provider definitions'
// availabilityWindow.hoursPerWeek (Kaggle 30, Colab 12).
//
// STORAGE (24 Nov 2026): createGpuCloud() also wires the NOVA Cloud
// Storage engine (NovaStorage, local filesystem backend) into the
// manager — the live store lives at gpu-cloud/data/store/ by default,
// beside the manager's job records (data/gpu-manager.json). The manager
// exposes store/retrieve operations for job outputs (storeJobOutput /
// getJobOutput / headJobOutput / issueJobDeliveryRef / deleteJobOutput)
// and hosts the expiry sweep timer (startStorageSweep /
// stopStorageSweep). The sweep timer does NOT start by itself:
// createGpuCloud({ startSweepTimer: true }) opts in, or the live runner
// (scripts/run-gpu-cloud.mjs) starts it. The production host for the
// timer is still an open owner decision — see docs/storage/design.md §12.
//
// BOTH REAL PROVIDERS START NOT-CONNECTED. The registry definitions
// carry connected: false / status 'not-connected' and nothing in Stage 2
// flips them — the live connection check (Part B) is what marks a
// provider connected. Until then the dispatcher can never assign a job
// to Kaggle or Colab (dispatchable() requires connected + available),
// however the executors are registered. Tests that need a dispatchable
// real provider flip it explicitly (see test/support.mjs).
//
// Startup reconciliation: the stored weekly budget is checked for each
// tracked provider, so a budget spent last week does not block this
// week, and a budget spent this week blocks immediately after a restart
// (syncBudgetStatus).
//
// fileReport(manager, executor, report) is the operator's single call
// for the manual channel: it files the provider's completion report with
// the executor (resolving the job's pending start() promise, which
// finalizes the job in the manager and records the GPU seconds against
// the weekly budget) and waits for the job to reach a terminal state.
// Returns { filed, job } or { filed: false, reason }.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GpuManager } from './gpu-manager.js';
import { HoursTracker, syncBudgetStatus } from './hours.js';
import { KaggleExecutor } from './kaggle-executor.js';
import { ColabExecutor } from './colab-executor.js';
import { createStorage } from './storage/index.js';

const DEFAULT_PACKAGE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
);

// The live store's durable home: gpu-cloud/data/store/, beside the
// manager's job records (data/gpu-manager.json). Covered by
// gpu-cloud/.gitignore — media bytes are never committed.
export const DEFAULT_STORAGE_ROOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'store',
);

export function createGpuCloud({
  storePath,
  packageDir = DEFAULT_PACKAGE_DIR,
  kaggleUsername = null,
  kaggleTransport = null,
  route = 'official',
  stagingRootDir = null,
  weekStartDay,
  now,
  config,
  mockOptions,
  enhancement,
  storageRootDir = DEFAULT_STORAGE_ROOT_DIR,
  storage = null,
  startSweepTimer = false,
  sweepIntervalMs,
} = {}) {
  const manager = new GpuManager({
    ...(storePath !== undefined ? { storePath } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(mockOptions !== undefined ? { mockOptions } : {}),
    // FreeLLMAPI (A4/A5): enhancement options pass through; absent means
    // disabled (the GpuManager default), so existing callers are
    // unaffected.
    ...(enhancement !== undefined ? { enhancement } : {}),
  });

  // Weekly budgets come from the provider definitions (the single source
  // of truth for the free-tier hours).
  const budgets = {};
  for (const def of manager.registry.list()) {
    if (def.availabilityWindow?.type === 'weekly-hours') {
      budgets[def.id] = def.availabilityWindow.hoursPerWeek;
    }
  }
  const hoursTracker = new HoursTracker({
    store: manager.store,
    budgets,
    ...(weekStartDay !== undefined ? { weekStartDay } : {}),
    // Share the manager's clock (injectable for tests) so week
    // boundaries and job timeouts agree.
    ...(now !== undefined ? { now } : {}),
  });

  const kaggle = new KaggleExecutor({
    hoursTracker,
    registry: manager.registry,
    route,
    stagingRootDir,
    packageDir,
    transport: kaggleTransport,
    kaggleUsername,
  });
  const colab = new ColabExecutor({
    hoursTracker,
    registry: manager.registry,
    route,
    stagingRootDir,
    packageDir,
  });
  manager.registerExecutor('kaggle-t4', kaggle);
  manager.registerExecutor('colab-t4', colab);

  // Reconcile registry status with the stored weekly budgets.
  for (const id of Object.keys(budgets)) {
    syncBudgetStatus(manager.registry, hoursTracker, id);
  }

  // NOVA Cloud Storage: the live store, attached to the manager. A
  // pre-constructed storage instance may be passed in (tests, custom
  // backends); otherwise one is created at storageRootDir, sharing the
  // manager's clock so job timeouts and object expiry agree. The sweep
  // timer starts only on an explicit opt-in (startSweepTimer: true) —
  // tests and one-shot scripts must not start timers by accident.
  const cloudStorage = storage ?? createStorage({
    rootDir: storageRootDir,
    ...(now !== undefined ? { clock: now } : {}),
  });
  manager.attachStorage(cloudStorage);
  if (startSweepTimer) {
    manager.startStorageSweep(sweepIntervalMs);
  }

  return {
    manager,
    store: manager.store,
    registry: manager.registry,
    hoursTracker,
    mock: manager.mock,
    kaggle,
    colab,
    executors: { mock: manager.mock, kaggle, colab },
    storage: cloudStorage,
    storageRootDir: cloudStorage.rootDir,
  };
}

// File a provider completion report (manual channel) and wait for the
// job to finalize. The executor records the GPU seconds against the
// weekly budget as part of resolving the report.
export async function fileReport(manager, executor, report, timeoutMs = 5000) {
  const filed = executor.fileReport(report);
  if (!filed.filed) return { filed: false, reason: filed.reason };
  const job = await manager.waitFor(report.jobId, timeoutMs);
  return { filed: true, job, status: filed.status };
}
