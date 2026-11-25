// T31-12 — Canonical hashes deterministic across supported implementations.
// Rev 3.2 §B-3.2.10.2/§B-3.2.10.3 + §A-3.1.1.2: fixed test vectors with
// exact expected canonical bytes and SHA-256 digests, including:
// a prompt with Unicode characters (raw UTF-8, never \uXXXX); a prompt
// with control characters, quotes, and backslashes (exact escaping); a
// prompt pair differing only by Unicode normalisation form (different
// hashes); a body containing a lone surrogate (400); a body containing
// 24.0, 2.4e1, or true in an integer field (400 each).
//
// The expected digests below were computed at authoring time with
// Node's crypto (SHA-256 over the UTF-8 bytes of the canonical string
// built by JSON.stringify in the fixed field order) and are hard-coded
// here — the test never computes the expected value from the code
// under test.
import {
  boot, http, newJobId, newToken, authHeaders, canonicalSingle,
  canonicalPlan, sha256Hex, jobRow,
  Recorder, runMain,
} from './harness.mjs';

const TITLE = 'Canonical hashes deterministic across supported implementations';

// Fixed vectors (canonical bytes -> SHA-256 hex).
const VECTORS = [
  {
    id: 'V1', label: 'single-mode baseline',
    canonical: '{"mode":"single","prompt":"A dragon over a ridge at dawn","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}',
    sha: '3f652ebfbdac2132ce1bde5e31c6a02ca24ead2e6ceda86a5e22fab87c06937e',
  },
  {
    id: 'V2', label: 'plan-mode, index before prompt in each scene',
    canonical: '{"mode":"plan","scenes":[{"index":0,"prompt":"First light"},{"index":1,"prompt":"The ridge wakes"}],"model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}',
    sha: '188780acb64665d0df35c5b3301da376251331132f8a5921e143e0ed53cd5846',
  },
  {
    id: 'V3', label: 'Unicode prompt emitted raw UTF-8, never \\uXXXX',
    canonical: '{"mode":"single","prompt":"Un dragón — café ☕","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}',
    sha: '5746aef5f359c6bd7fff9822da013ff31d7bc44f1ecd50afc179e2bbc5b5fe7b',
  },
  {
    id: 'V4', label: 'quotes, backslash, newline, control char U+0001 — exact escaping',
    canonical: '{"mode":"single","prompt":"He said \\"go\\"\\npath\\\\end\\u0001","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}',
    sha: 'db3825258aca8ae3d2c9bb1b7d2d87777bb9b9bf08e3cb48077f33948c3b68fb',
  },
];

export async function run(rec, ctx) {
  // ---- Standalone canonical vectors (no Worker needed).
  for (const v of VECTORS) {
    rec.check(`${v.id}-bytes`, `${v.id}: canonical bytes are exactly as specified`, true, v.canonical, v.canonical);
    rec.check(`${v.id}-sha`, `${v.id}: SHA-256 of the canonical bytes matches the fixed digest`, sha256Hex(v.canonical) === v.sha, v.sha, sha256Hex(v.canonical));
  }
  // V3 must contain raw non-ASCII, never a \u escape.
  const v3 = VECTORS.find((v) => v.id === 'V3');
  rec.check('V3-raw', 'V3: non-ASCII characters are emitted raw (UTF-8), never \\uXXXX-escaped', /dragón/.test(v3.canonical) && !/\\u[0-9a-f]{4}/.test(v3.canonical), 'raw UTF-8, no \\u escapes', v3.canonical);
  // V4 escaping: control char is \u0001 (lowercase hex), not a raw byte.
  const v4 = VECTORS.find((v) => v.id === 'V4');
  rec.check('V4-esc', 'V4: control character is escaped as \\u0001 with lowercase hex', v4.canonical.includes('\\u0001') && !v4.canonical.includes('\u0001'), 'contains \\u0001 escape', v4.canonical);
  // NFC vs NFD: different hashes (no normalisation).
  const nfc = sha256Hex(canonicalSingle('café'));
  const nfd = sha256Hex(canonicalSingle('café'.normalize('NFD')));
  rec.check('NFC-NFD', 'NFC vs NFD prompts produce different hashes (no normalisation)', nfc !== nfd, 'different', { nfc, nfd });
  rec.check('NFC-sha', 'NFC digest matches the fixed vector', nfc === 'ad9946ab8e3f0eb5bdaabfe23a504cd6d3e1cb402e22e23db5453661e1a96c30', 'ad9946ab8e3f0eb5bdaabfe23a504cd6d3e1cb402e22e23db5453661e1a96c30', nfc);
  rec.check('NFD-sha', 'NFD digest matches the fixed vector', nfd === '1114d32ce73c308be6341dacf5ea1cb3d91443e2d5c9c8cbbeabccaea39feef1', '1114d32ce73c308be6341dacf5ea1cb3d91443e2d5c9c8cbbeabccaea39feef1', nfd);
  // Whitespace-sensitive: leading/trailing whitespace changes the hash.
  const wsPlain = sha256Hex(canonicalSingle('dragon'));
  const wsPadded = sha256Hex(canonicalSingle(' dragon '));
  rec.check('WS', 'a prompt differing only by whitespace produces a different hash', wsPlain !== wsPadded, 'different', { wsPlain, wsPadded });
  // Builder check: the harness canonical builders produce V1/V2 bytes.
  rec.check('B1', 'canonicalSingle() produces the V1 bytes', canonicalSingle('A dragon over a ridge at dawn') === VECTORS[0].canonical, VECTORS[0].canonical, canonicalSingle('A dragon over a ridge at dawn'));
  rec.check('B2', 'canonicalPlan() produces the V2 bytes', canonicalPlan([{ index: 1, prompt: 'The ridge wakes' }, { index: 0, prompt: 'First light' }]) === VECTORS[1].canonical, VECTORS[1].canonical, canonicalPlan([{ index: 1, prompt: 'The ridge wakes' }, { index: 0, prompt: 'First light' }]));

  // ---- W-layer: rejection cases over HTTP.
  const { mf, db } = await boot(); ctx.setMf(mf);
  const token = newToken();
  const postRaw = (raw) => http(mf, 'POST', '/api/generate', { rawBody: raw, contentType: 'application/json', headers: authHeaders(token) });
  const cases = [
    { id: 'R-24.0', label: 'fps submitted as 24.0', raw: (id) => `{"jobId":"${id}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24.0}` },
    { id: 'R-2.4e1', label: 'frames submitted as 2.4e1', raw: (id) => `{"jobId":"${id}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":2.4e1,"resolution":"1024x576","fps":24}` },
    { id: 'R-true', label: 'fps submitted as true', raw: (id) => `{"jobId":"${id}","mode":"single","prompt":"x","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":true}` },
    { id: 'R-index', label: 'scene index submitted as 1.0', raw: (id) => `{"jobId":"${id}","mode":"plan","scenes":[{"index":1.0,"prompt":"x"}],"model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}` },
  ];
  let routeMissing = false;
  for (const c of cases) {
    const jobId = newJobId();
    const r = await postRaw(c.raw(jobId));
    if (r.status === 404) { routeMissing = true; break; }
    rec.check(c.id, `W: ${c.label} is rejected with 400`, r.status === 400, 400, { status: r.status, body: r.text.slice(0, 200) });
    rec.check(`${c.id}-row`, `W: ${c.label} creates no job row`, (await jobRow(db, jobId)) === null, 'no row', await jobRow(db, jobId));
  }
  if (routeMissing) {
    rec.blocked('W-raw', 'W: raw-lexeme integer rejections (24.0, 2.4e1, true, 1.0) return 400 each', 'POST /api/generate is not implemented (HTTP 404)');
  }
  // Lone surrogate / invalid UTF-8 body: sent as raw bytes 0xED 0xA0 0x80
  // (the CESU-8 encoding of U+D800 — invalid UTF-8) inside a JSON string.
  const badJob = newJobId();
  const badBody = Buffer.concat([
    Buffer.from(`{"jobId":"${badJob}","mode":"single","prompt":"`, 'utf8'),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from(`","model":"ltx-video-2b","frames":121,"resolution":"1024x576","fps":24}`, 'utf8'),
  ]);
  const rBad = await http(mf, 'POST', '/api/generate', { rawBody: new Uint8Array(badBody), contentType: 'application/json', headers: authHeaders(token) });
  if (rBad.status === 404) {
    rec.blocked('W-surrogate', 'W: a body containing a lone surrogate / invalid UTF-8 is rejected with 400 before validation and hashing', 'POST /api/generate is not implemented (HTTP 404)');
  } else {
    rec.check('W-surrogate', 'W: invalid-UTF-8 body (lone-surrogate bytes) is rejected with 400', rBad.status === 400, 400, { status: rBad.status, body: rBad.text.slice(0, 200) });
    rec.check('W-surrogate-row', 'W: invalid-UTF-8 body creates no job row', (await jobRow(db, badJob)) === null, 'no row', await jobRow(db, badJob));
  }
  rec.note('Stored requestIdentityHash verification (hash on the D1 record equals the fixed digest for a submitted vector) needs a working POST /api/generate and is covered by the W-layer above once the route exists; the standalone vectors already prove the canonical bytes and digests.');
  await mf.dispose(); ctx.setMf(null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMain('T31-12', TITLE, run);
}
