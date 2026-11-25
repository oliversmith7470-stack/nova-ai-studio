// T31-08 — Revocation reaches all active processes within the interval.
// Rev 3.2 §B-3.2.4.2: two API processes sharing one manager store;
// revoke the Worker secret during the rotation overlap window; both
// processes reject the old secret within 5 seconds of the revocation
// record's revokedAt, both accept the new secret, and exactly one
// revocation event is recorded in the operator log.
//
// There is NO runnable API process in this repo: no HTTP server entry
// point, no HMAC verification in _worker.js, no revocation record in
// the manager store (gpu-cloud/src/store.js has no revocation concept),
// and no /internal/* Worker routes. The two-process test cannot be
// staged, so every assertion is BLOCKED with that evidence.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, Recorder, runMain, seamPresent } from './harness.mjs';

const TITLE = 'Revocation reaches all active processes within the interval';

export async function run(rec) {
  const hmacSeam = seamPresent(/HMAC|hmac|createHmac|timingSafeEqual/);
  const revocationSeam = seamPresent(/revocation|revokedAt|secret-revocation/);
  const internalSeam = seamPresent(/\/internal\//);
  rec.note(`seam probe: HMAC text in ${hmacSeam ?? 'nothing'}; revocation text in ${revocationSeam ?? 'nothing'}; /internal/ routes in ${internalSeam ?? 'nothing'}`);
  const storeHasRevocation = /revocation/.test(fs.readFileSync(path.join(REPO, 'gpu-cloud', 'src', 'store.js'), 'utf8'));
  rec.note(`manager store (gpu-cloud/src/store.js) contains a revocation concept: ${storeHasRevocation}`);
  rec.blocked('R1', 'both API processes reject the old secret within 5 seconds of revokedAt', 'no API process exists to run twice: there is no HTTP server entry point in gpu-cloud/src, no shared-secret verification in _worker.js, and no revocation record in the manager store');
  rec.blocked('R2', 'both API processes accept the new secret', 'same missing seam as R1');
  rec.blocked('R3', 'exactly one revocation event is recorded in the operator log', 'no operator log and no revocation procedure exist in this repo');
  rec.blocked('R4', 'a process whose cached revocation list is stale re-reads the record before verifying a request (5-second staleness bound)', 'same missing seam as R1');
  rec.note('The 5-second propagation interval is a specified maximum, not a measured figure (§B-3.2.18). T31-08 is its proof — it cannot run until the API process + revocation record exist.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-08', TITLE, run);
}
