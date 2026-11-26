// NOVA Personal GPU Cloud — live runner.
//
// Boots the GPU Cloud with the LIVE defaults (job records at
// data/gpu-manager.json, object store at data/store/), runs one expiry
// sweep immediately, then starts the sweep timer (default every hour)
// and stays alive until stopped (Ctrl+C / SIGTERM).
//
// This is the live host for the sweep timer until the owner decides the
// production host (Stage 4 API process, cron-triggered sweep, or a
// dedicated daemon — see docs/storage/design.md §12). Launch it from
// the main session, not from a subagent or cron worker: long processes
// launched by workers get reaped.
//
//   node scripts/run-gpu-cloud.mjs [--sweep-interval-ms <ms>]
//
// No GPU work happens here — the runner only tends the store. It never
// dispatches jobs, never touches Kaggle/Colab, never touches NOVA
// production.

import { createGpuCloud } from '../src/setup.js';
import { DEFAULT_SWEEP_INTERVAL_MS } from '../src/storage/index.js';

function parseArgs(argv) {
  const out = { sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sweep-interval-ms') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error('--sweep-interval-ms must be a positive integer (ms)');
      }
      out.sweepIntervalMs = v;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const { sweepIntervalMs } = parseArgs(process.argv.slice(2));
  const cloud = createGpuCloud();
  const { manager } = cloud;

  console.log('NOVA GPU Cloud — live runner');
  console.log(`  store root: ${cloud.storageRootDir}`);
  console.log(`  sweep interval: ${sweepIntervalMs} ms`);

  const initial = await manager.runStorageSweep();
  console.log(
    `  initial sweep: checked ${initial.checked}, deleted ${initial.deleted}, ` +
      `freed ${initial.bytesFreed} bytes, staging cleaned ${initial.stagingCleaned}`,
  );

  const usage = manager.storageUsage();
  console.log(
    `  store now holds ${usage.totalObjects} object(s), ${usage.totalBytes} bytes`,
  );

  manager.startStorageSweep(sweepIntervalMs);
  console.log('  sweep timer running. Press Ctrl+C to stop.');

  // Keep-alive: the sweep timer is unref'd (it never holds a process
  // open on its own) and a pending promise is not an event-loop handle,
  // so without this the process would exit at once. This ref'd interval
  // is the only thing holding the runner open; stop() clears it.
  const keepAlive = setInterval(() => {}, 60_000);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping — sweep timer off.');
    manager.stopStorageSweep();
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`run-gpu-cloud failed: ${err?.message ?? err}`);
  process.exit(1);
});
