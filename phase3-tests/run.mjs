// Phase 3 acceptance-test runner (T31-01–T31-17 + supporting tests).
//
// Usage (from the repo root):
//   node phase3-tests/run.mjs            # every test, summary table
//   node phase3-tests/run.mjs t31-01     # a single test (substring match)
//   node phase3-tests/t31-01.mjs         # a single test file directly
//
// Each test runs as a child process (node <file>) so a boot failure in
// one test cannot poison the others. The runner parses the
// `__PHASE3_RESULT__ <json>` line each file prints and aggregates the
// verdicts. Exit code: 0 all PASS, 1 any FAIL, 2 no FAIL but some
// BLOCKED (nothing failed, but not everything could run).

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(DIR)
  .filter((f) => /^t31-.*\.mjs$/.test(f) && (filter === '' || f.includes(filter)))
  .sort();

if (files.length === 0) {
  console.log(`No test files match "${filter}".`);
  process.exit(2);
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(DIR, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      const m = out.match(/__PHASE3_RESULT__ (\{.*\})/);
      if (m) {
        try {
          resolve({ file, result: JSON.parse(m[1]), code, err: err.trim() });
          return;
        } catch { /* fall through */ }
      }
      resolve({ file, result: null, code, err: (err + '\n' + out).trim().slice(-2000) });
    });
  });
}

const rows = [];
for (const file of files) {
  const { result, code, err } = await runOne(file);
  if (result) {
    rows.push({ test: result.test, title: result.title, verdict: result.verdict, passed: result.passed, failed: result.failed, blocked: result.blocked, ms: result.durationMs });
  } else {
    rows.push({ test: file.replace(/\.mjs$/, ''), title: '(no result — runner error)', verdict: 'ERROR', passed: 0, failed: 1, blocked: 0, ms: 0, err });
  }
  void code;
}

const total = { pass: 0, fail: 0, blocked: 0 };
for (const r of rows) {
  total.pass += r.passed; total.fail += r.failed; total.blocked += r.blocked;
}
console.log('');
console.log('Phase 3 acceptance tests — summary');
console.log('test        verdict   pass  fail  blocked   ms  title');
for (const r of rows) {
  console.log(`${r.test.padEnd(12)} ${r.verdict.padEnd(8)} ${String(r.passed).padStart(4)} ${String(r.failed).padStart(5)} ${String(r.blocked).padStart(7)} ${String(r.ms).padStart(6)}  ${r.title}`);
}
console.log('');
console.log(`TOTAL: ${rows.length} test files, ${total.pass} assertions passed, ${total.fail} failed, ${total.blocked} blocked`);
for (const r of rows.filter((x) => x.verdict === 'ERROR')) {
  console.log(`\nERROR ${r.test}:\n${r.err}`);
}
const anyFail = rows.some((r) => r.failed > 0 || r.verdict === 'ERROR');
const anyBlocked = rows.some((r) => r.blocked > 0);
process.exit(anyFail ? 1 : (anyBlocked ? 2 : 0));
