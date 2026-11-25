// T31-03 — Crash after manager dispatch does not cause duplicate execution.
// Rev 3.2 §B-3.2.2.2: the manager job is created; the dispatch-journal
// update is dropped (simulated crash between manager creation and the
// journal write). The Worker re-submits with the same idempotency key:
// exactly one manager job exists, the journal is repaired with
// journal-repaired: true, and no second execution occurs.
//
// The dispatch journal itself is a design component with NO runnable
// implementation in this repo (grep: zero occurrences of "journal" in
// gpu-cloud/src, zero in _worker.js). The journal-repair assertions
// therefore cannot run and are BLOCKED with that evidence. What CAN run
// is the manager half: the in-process GpuManager's idempotency on the
// execution ID (the same key the design uses), which is the mechanism
// the re-submit relies on.
import { makeManager, submitVideo } from '../gpu-cloud/test/support.mjs';
import { seamPresent, Recorder, runMain } from './harness.mjs';

const TITLE = 'Crash after manager dispatch does not cause duplicate execution';

export async function run(rec) {
  // ---- Evidence: the journal seam does not exist.
  const journalSeam = seamPresent(/journal-repaired|dispatch journal|dispatchJournal/);
  rec.blocked('J1', 'journal is repaired with journal-repaired: true on re-submit', journalSeam ? `found in ${journalSeam} (unexpected)` : 'no dispatch-journal implementation exists in this repo: "journal" occurs nowhere in gpu-cloud/src/*.js or _worker.js; the API process that owns the journal has no runnable entry point');
  rec.blocked('J2', 're-submit after a dropped journal write returns the existing manager job (journal path)', 'same missing seam as J1 — the Worker has no /internal/submit route and no journal to consult');

  // ---- Manager half (runnable in-process): idempotency on the key.
  const fakeT = { after() {} };
  let m;
  try {
    m = makeManager(fakeT);
  } catch (e) {
    rec.blocked('M1', 'manager boots in-process for the idempotency check', `makeManager threw: ${String(e?.message ?? e)}`);
    return;
  }
  const key = 'nova-job-00000000-0000-4000-8000-000000000001:scene-0:attempt-1';
  const first = submitVideo(m, key);
  rec.check('M1', 'manager: first submit with the execution ID creates one manager job', first.created === true, true, first.created);
  const d = m.dispatchNext();
  rec.check('M2', 'manager: the job dispatches (provider start happens once)', d.dispatched === true, true, d);
  // Simulated crash point: journal write dropped — the manager job and
  // its provider start already exist; only the journal is missing.
  const again = submitVideo(m, key);
  rec.check('M3', 'manager: re-submit with the same idempotency key returns the existing job, creates nothing', again.created === false && again.job.id === first.job.id, 'same job, created false', { created: again.created, sameId: again.job.id === first.job.id });
  rec.check('M4', 'manager: exactly one manager job exists and exactly one provider start happened (no second execution)', m.listJobs().length === 1 && m.mock.startedJobs.length === 1, '1 job, 1 start', { jobs: m.listJobs().length, starts: m.mock.startedJobs.length });
  await m.waitFor(first.job.id);
  rec.check('M5', 'manager: the single job completes; still exactly one job', m.getJob(first.job.id).status === 'succeeded' && m.listJobs().length === 1, 'succeeded, 1 job', { status: m.getJob(first.job.id).status, jobs: m.listJobs().length });
  rec.note('M1–M5 prove the manager half (idempotency on the execution ID). They do NOT prove the journal repair — that needs the API-process dispatch journal, which is unimplemented. T31-03 as defined stays BLOCKED until that seam exists.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-03', TITLE, run);
}
