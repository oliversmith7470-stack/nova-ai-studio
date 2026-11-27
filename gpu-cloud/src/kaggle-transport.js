// NOVA Personal GPU Cloud — the real Kaggle CLI transport (Rev 4.8 §7).
//
// Executes `kaggle kernels push/status/output` with the owner's
// credentials, for the KaggleExecutor's transport interface
// ({ push, status, output }). This is the transport the personal LTX
// executor uses when one is wired; by default the executor has NO
// transport (human channel) and this module is not constructed at all.
//
// Credential-gated (fail closed): construction throws unless the Kaggle
// credential is present — KAGGLE_USERNAME + KAGGLE_KEY in the
// environment, or ~/.kaggle/kaggle.json (the same rule as
// isKaggleCredentialPresent). The transport never runs without a
// credential and never embeds one: credentials pass through the child
// process environment only, are never logged, never written to a file,
// and never returned in an error. This module itself makes no network
// calls beyond the CLI's own.
//
// The CLI's text output is parsed best-effort (the CLI prints no JSON
// for these commands): push looks for a kernel slug in stdout, status
// looks for the KernelWorkerStatus enum word, output downloads into a
// scratch dir and reads the <jobId>.report.json the notebook writes.
// An unparseable result is an error, never a success — and the
// executor's poll timeout bounds a transport that never reports.
// `kaggle kernels output` has no completion guarantee in one call; the
// executor polls status until complete before calling output.
//
// No live Kaggle execution happens from this module alone: constructing
// it only proves the CLI + credential are present. A push is a real
// Kaggle API call and therefore needs the separately authorised proof
// run — tests use a stub `kaggle` binary on PATH, never the real CLI.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The Kaggle CLI writes the kernel slug to stdout on a successful push
// (e.g. "Kernel successfully pushed to: <owner>/nova-gpu-cloud-<jobId>").
// The slug is the authority for every later call.
const KERNEL_SLUG_RE = /([A-Za-z0-9_][A-Za-z0-9_.-]*\/nova-gpu-cloud-[A-Za-z0-9_.-]+)/;

// `kaggle kernels status <slug>` prints the KernelWorkerStatus enum.
// Priority order: an ERROR line beats a RUNNING line if both appear
// (a failed kernel can still carry a queued line in the output).
const STATUS_WORDS = ['ERROR', 'COMPLETE', 'RUNNING', 'QUEUED', 'CANCELLED'];
const STATUS_MAP = {
  ERROR: 'error',
  COMPLETE: 'complete',
  RUNNING: 'running',
  QUEUED: 'running',
  CANCELLED: 'error',
};

export function kaggleCredentialPresent({ env = process.env, home = os.homedir() } = {}) {
  const username = env.KAGGLE_USERNAME;
  const key = env.KAGGLE_KEY;
  if (typeof username === 'string' && username.length > 0
    && typeof key === 'string' && key.length > 0) {
    return true;
  }
  try {
    const raw = fs.readFileSync(path.join(home, '.kaggle', 'kaggle.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.username === 'string' && parsed.username.length > 0
      && typeof parsed?.key === 'string' && parsed.key.length > 0;
  } catch {
    return false;
  }
}

export class KaggleCliTransport {
  constructor({
    execImpl = null,
    env = process.env,
    home = os.homedir(),
    kaggleBin = 'kaggle',
    outputRoot = path.join(os.tmpdir(), 'nova-kaggle-output'),
    kernelTimeoutSeconds = 43200,
    commandTimeoutMs = 120_000,
  } = {}) {
    if (!kaggleCredentialPresent({ env, home })) {
      throw new Error(
        'KaggleCliTransport requires the Kaggle credential (KAGGLE_USERNAME + KAGGLE_KEY, or ~/.kaggle/kaggle.json) — refusing to construct without one',
      );
    }
    this.execImpl = execImpl ?? execFileAsync;
    this.env = env;
    this.kaggleBin = kaggleBin;
    this.outputRoot = outputRoot;
    this.kernelTimeoutSeconds = kernelTimeoutSeconds;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  async _run(args) {
    let out;
    try {
      out = await this.execImpl(this.kaggleBin, args, {
        env: this.env,
        timeout: this.commandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      // A missing binary surfaces as ENOENT — a configuration error,
      // never a success. A timeout surfaces as ETIMEDOUT. Neither is
      // retried here; the executor's poll timeout bounds the job.
      const code = err && err.code ? String(err.code) : 'unknown';
      throw new Error(`kaggle CLI failed (${args[0]} ${args[1] ?? ''}): ${code}`);
    }
    return String(out.stdout ?? '') + String(out.stderr ?? '');
  }

  // Push a job package dir as a GPU kernel. Returns { ok: true, kernelId }
  // or throws. The kernel id is parsed from the CLI's stdout.
  async push(packageDir) {
    if (typeof packageDir !== 'string' || packageDir.length === 0) {
      throw new Error('KaggleCliTransport.push requires a package directory');
    }
    const output = await this._run([
      'kernels', 'push',
      '-p', packageDir,
      '--accelerator', 'NvidiaTeslaT4',
      '-t', String(this.kernelTimeoutSeconds),
    ]);
    const match = output.match(KERNEL_SLUG_RE);
    if (!match) {
      throw new Error('kaggle kernels push succeeded but no kernel slug was found in its output');
    }
    return { ok: true, kernelId: match[1] };
  }

  // Poll a kernel's status. Returns { state: 'running'|'complete'|'error',
  // error? }. An unparseable status is an error, never a success.
  async status(kernelId) {
    if (typeof kernelId !== 'string' || kernelId.length === 0) {
      throw new Error('KaggleCliTransport.status requires a kernel id');
    }
    const output = await this._run(['kernels', 'status', kernelId]);
    // Preferred parse: the CLI prints the enum as
    // "KernelWorkerStatus.RUNNING" (or COMPLETE/ERROR/QUEUED/CANCELLED).
    const enumMatch = output.match(/KernelWorkerStatus\.([A-Z_]+)/);
    if (enumMatch) {
      const state = STATUS_MAP[enumMatch[1]];
      if (state) {
        return state === 'error'
          ? { state, error: `kernel ${enumMatch[1].toLowerCase()}` }
          : { state };
      }
      throw new Error(`kaggle kernels status returned an unknown status for ${kernelId}: ${enumMatch[1]}`);
    }
    // Fallback: a bare enum word anywhere in the output.
    for (const word of STATUS_WORDS) {
      if (output.includes(word)) {
        const state = STATUS_MAP[word];
        return state === 'error'
          ? { state, error: `kernel ${word.toLowerCase()}` }
          : { state };
      }
    }
    throw new Error(`kaggle kernels status returned an unparseable status for ${kernelId}`);
  }

  // Download a completed kernel's output and return the provider report
  // (the <jobId>.report.json the notebook writes). Returns the parsed
  // report object. Throws when the report is missing or unparseable —
  // the executor records the poll error and retries next interval.
  async output(kernelId) {
    if (typeof kernelId !== 'string' || kernelId.length === 0) {
      throw new Error('KaggleCliTransport.output requires a kernel id');
    }
    const dir = path.join(this.outputRoot, kernelId.replace(/[^A-Za-z0-9_.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    await this._run(['kernels', 'output', '-p', dir, kernelId]);
    const reportFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.report.json'));
    if (reportFiles.length === 0) {
      throw new Error(`kaggle kernels output for ${kernelId} contains no .report.json`);
    }
    // The notebook writes exactly one report file; if several are
    // present, the newest wins (a re-run overwrites, never appends).
    const reportPath = reportFiles
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, reportPath), 'utf8'));
    } catch {
      throw new Error(`kaggle kernels output for ${kernelId} has an unparseable report (${reportPath})`);
    }
    return parsed;
  }
}
