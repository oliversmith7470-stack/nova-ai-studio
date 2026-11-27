// NOVA FreeLLMAPI — operator readiness script (approved v5 design, §10).
//
// Verifies the VM-local gateway is ready to serve NOVA prompt enhancement:
// real POST /v1/chat/completions calls against BOTH approved pins
// (google:gemini-3.5-flash-lite, then groq:qwen/qwen3.8-27b — tiny prompt,
// max_tokens 10, expect 200 + non-empty content + matching X-Routed-Via)
// PLUS the model-unify override state read from the gateway database
// (read-only SQLite: settings.model_unify_overrides) and the gateway
// version from its package.json.
//
// A dashboard 200 is NOT readiness — this script makes the real calls.
// It never activates anything: readiness is a report, and a ready gateway
// does not enable enhancement (the NOVA_GATEWAY_ENHANCEMENT flag stays
// OFF until the owner activates it separately).
//
// Usage:
//   NOVA_GATEWAY_API_KEY=<key> node gpu-cloud/scripts/freellmapi-readiness.mjs
//     [--base-url <url>] [--gateway-dir <path>]
//   --gateway-dir defaults to NOVA_GATEWAY_DIR, else ~/workspace/freellmapi.
//   Exit 0 when ready, 1 when not (the JSON report names the failing check).
//   Never prints a key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkGatewayReadiness, evaluateUnifyOverrides } from '../src/gateway-client.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_GATEWAY_DIR = path.join(os.homedir(), 'workspace', 'freellmapi');

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

// Read the gateway version: the root package.json first, then the server
// package.json (the monorepo root carries no version field).
function readGatewayVersion(gatewayDir) {
  for (const candidate of [path.join(gatewayDir, 'package.json'), path.join(gatewayDir, 'server', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return { version: pkg.version, source: candidate };
      }
    } catch {
      // Missing or unparsable — try the next candidate.
    }
  }
  return { version: null, source: null };
}

// Read the model-unify overrides from the gateway SQLite database,
// read-only. Returns { present, overrides, error }.
async function readOverrides(gatewayDir) {
  const dbPath = path.join(gatewayDir, 'server', 'data', 'freeapi.db');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'model_unify_overrides'").get();
      if (!row) return { present: false, overrides: null, error: null };
      let parsed;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        return { present: true, overrides: null, error: 'override-value-not-json' };
      }
      return { present: true, overrides: parsed, error: null };
    } finally {
      db.close();
    }
  } catch (err) {
    return { present: false, overrides: null, error: `gateway-db-unreadable: ${err.message}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] ?? process.env.NOVA_GATEWAY_BASE_URL ?? DEFAULT_BASE_URL;
  const gatewayDir = args['gateway-dir'] ?? process.env.NOVA_GATEWAY_DIR ?? DEFAULT_GATEWAY_DIR;
  const apiKey = args['api-key'] ?? process.env.NOVA_GATEWAY_API_KEY ?? '';

  const report = {
    checkedAt: new Date().toISOString(),
    baseUrl,
    gatewayDir,
    ready: false,
    version: readGatewayVersion(gatewayDir),
    checks: [],
    overrides: null,
  };

  // 1. Real calls against both approved pins.
  const readiness = await checkGatewayReadiness({ baseUrl, apiKey });
  report.checks = readiness.checks;

  // 2. Override state from the gateway database (read-only).
  const overrideRead = await readOverrides(gatewayDir);
  if (overrideRead.error) {
    report.checks.push({ name: 'overrides', ok: false, reason: overrideRead.error });
  } else {
    const evaluation = evaluateUnifyOverrides(overrideRead.overrides);
    report.overrides = {
      present: overrideRead.present,
      value: overrideRead.overrides,
      evaluation,
    };
    report.checks.push({
      name: 'overrides',
      ok: evaluation.ok,
      ...(evaluation.ok ? {} : { reason: evaluation.reason }),
    });
  }

  report.ready = report.checks.every((c) => c.ok);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready ? 0 : 1);
}

main().catch((err) => {
  console.error(`freellmapi-readiness: unexpected failure: ${err.message}`);
  process.exit(1);
});
