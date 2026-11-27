// NOVA FreeLLMAPI — manual benchmark harness (approved v5 design, §4b/B3).
//
// Runs a small, fixed set of TEXT prompt-enhancement probes against the
// VM-local gateway and records a benchmark.json manifest. It never imports
// the job store or the dispatch manager (B3), never writes outside the
// scratch root, and never promotes a result anywhere.
//
// Image benchmarking is BLOCKED (B1): Cloudflare has no key, Hugging Face
// has zero catalogue rows AND returns HTTP 402 (no free credits), and
// Pollinations needs a separate authorization that has not been granted.
// Audio benchmarking needs its own separate authorization, also not
// granted. Both modes report "unavailable" with the specific reason and
// exit 0 — unavailable is a finding, not a failure.
//
// Usage:
//   NOVA_GATEWAY_BENCHMARK=true NOVA_GATEWAY_API_KEY=<key> \
//     node gpu-cloud/scripts/freellmapi-benchmark.mjs [--mode text|image|audio] [--run-id <id>]
//   --base-url defaults to http://127.0.0.1:3001; --model defaults to
//   google:gemini-3.5-flash-lite. The benchmark flag must be on or the run
//   is reported unavailable (the flag is host config, default OFF).
// Manifest: gpu-cloud/benchmark-scratch/<run-id>-<yyyymmdd-hhmmss>/benchmark.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { createGatewayClient } from '../src/gateway-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRATCH_ROOT = path.join(__dirname, '..', 'benchmark-scratch');

const TEXT_PROBES = [
  'A lone dragon circles a mountain lake at dawn.',
  'A blacksmith forges a sword from fallen star metal.',
  'Rain falls on a quiet village street at night.',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      args[key] = value;
    }
  }
  return args;
}

function timestampSuffix(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? 'text';
  if (!['text', 'image', 'audio'].includes(mode)) {
    console.error(`freellmapi-benchmark: unknown mode ${JSON.stringify(mode)} (text|image|audio)`);
    process.exit(1);
  }
  const runId = args['run-id'] ?? randomBytes(4).toString('hex');
  const runDir = path.join(SCRATCH_ROOT, `${runId}-${timestampSuffix()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, 'benchmark.json');

  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    mode,
    status: 'unavailable',
    reason: null,
    gateway: {
      baseUrl: args['base-url'] ?? process.env.NOVA_GATEWAY_BASE_URL ?? 'http://127.0.0.1:3001',
      model: args.model ?? process.env.NOVA_GATEWAY_TEXT_MODEL ?? 'google:gemini-3.5-flash-lite',
    },
    probes: [],
    notes: [],
  };
  const finish = () => {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`freellmapi-benchmark: ${manifest.status}${manifest.reason ? ` (${manifest.reason})` : ''} — ${manifestPath}`);
    process.exit(0);
  };

  // Prerequisite 1: the benchmark flag. Host config, default OFF.
  if (process.env.NOVA_GATEWAY_BENCHMARK !== 'true' && process.env.NOVA_GATEWAY_BENCHMARK !== '1') {
    manifest.reason = 'benchmark-flag-off';
    manifest.notes.push('NOVA_GATEWAY_BENCHMARK is not true. Benchmarking is host-config-gated and defaults OFF.');
    finish();
  }
  // Prerequisite 2: the mode's own authorization.
  if (mode === 'image') {
    manifest.reason = 'image-benchmark-blocked';
    manifest.notes.push('B1: image benchmarking is blocked — Cloudflare has no key, Hugging Face has zero catalogue rows and returns HTTP 402 (no free credits), Pollinations needs a separate authorization that has not been granted.');
    finish();
  }
  if (mode === 'audio') {
    manifest.reason = 'audio-benchmark-blocked';
    manifest.notes.push('Audio benchmarking needs a separate owner authorization that has not been granted.');
    finish();
  }
  // Prerequisite 3: the gateway API key.
  const apiKey = args['api-key'] ?? process.env.NOVA_GATEWAY_API_KEY ?? '';
  if (!apiKey) {
    manifest.reason = 'gateway-api-key-missing';
    manifest.notes.push('NOVA_GATEWAY_API_KEY is not set in host config.');
    finish();
  }
  // Prerequisite 4: the gateway answers its dashboard (liveness only —
  // dashboard 200 is NOT readiness; the probes below are the check).
  try {
    const res = await fetch(`${manifest.gateway.baseUrl}/`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`dashboard ${res.status}`);
  } catch {
    manifest.reason = 'gateway-unavailable';
    manifest.notes.push(`Gateway dashboard did not answer at ${manifest.gateway.baseUrl}.`);
    finish();
  }

  let client;
  try {
    client = createGatewayClient({
      baseUrl: manifest.gateway.baseUrl,
      apiKey,
      model: manifest.gateway.model,
    });
  } catch (err) {
    manifest.reason = 'gateway-config-invalid';
    manifest.notes.push(err.message);
    finish();
  }
  if (!client) {
    manifest.reason = 'gateway-api-key-missing';
    finish();
  }

  manifest.status = 'complete';
  for (const prompt of TEXT_PROBES) {
    const started = Date.now();
    try {
      const result = await client.enhance(prompt);
      manifest.probes.push({
        prompt,
        ok: true,
        latencyMs: Date.now() - started,
        routedVia: result.routedVia,
        reportedModel: result.reportedModel,
        outputChars: result.content.length,
      });
    } catch (err) {
      manifest.probes.push({ prompt, ok: false, latencyMs: Date.now() - started, reason: err.message });
    }
  }
  if (manifest.probes.some((p) => !p.ok)) manifest.status = 'partial';
  finish();
}

main().catch((err) => {
  console.error(`freellmapi-benchmark: unexpected failure: ${err.message}`);
  process.exit(1);
});
