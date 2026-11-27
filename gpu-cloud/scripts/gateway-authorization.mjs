// NOVA FreeLLMAPI — sandbox owner-authorization operator CLI.
//
// The ONLY way to create or revoke a sandbox owner-authorization record
// (approved v5 design, §4d + implementation spec
// ~/workspace/your_files/nova-freellmapi-authorization-record-impl-spec.md).
// Approval method: host-operator-cli — the person running this script on
// the API host IS the operator; the record's approvedByOwnerId is the
// single owner id from host config (NOVA_OWNER_ID).
//
// Usage:
//   node gpu-cloud/scripts/gateway-authorization.mjs create \
//     --job-ids <nova-job-uuid,...> --expires-at <ISO-8601-UTC> \
//     [--starts-at <ISO-8601-UTC>] [--environment-id <id>] \
//     [--project-id <id>] [--owner-id <id>] [--reason <text>]
//   node gpu-cloud/scripts/gateway-authorization.mjs revoke --id <id> [--reason <text>]
//   node gpu-cloud/scripts/gateway-authorization.mjs show --id <id>
//   node gpu-cloud/scripts/gateway-authorization.mjs list
//
// Options:
//   --data-dir <dir>   Store location (default: NOVA_API_DATA_DIR, else
//                      /var/lib/nova-api — the host data directory).
//   --config <path>    Host config file (default: NOVA_API_CONFIG, else
//                      /etc/nova-api/api.env). The CLI reads NOVA_OWNER_ID,
//                      NOVA_ENVIRONMENT_ID and NOVA_PROJECT_ID from it
//                      when the matching flag is not given.
//
// Host config: the CLI refuses to run (exit 2) when it needs a host-config
// value and the config file is unreadable — an authorization must never be
// created from guessed identity. Explicit flags satisfy a value without
// the config; the data directory's permissions remain the real gate on
// who can write records.
//
// Never prints a credential. The store files are mode 0600.

import fs from 'node:fs';
import path from 'node:path';

import { AuthorizationStore, isValidIsoUtc } from '../src/gateway-authorization.js';

const JOB_ID_RE = /^nova-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_DATA_DIR = '/var/lib/nova-api';
const DEFAULT_CONFIG_PATH = '/etc/nova-api/api.env';

function usageError(message) {
  console.error(`gateway-authorization: ${message}`);
  console.error('Usage: gateway-authorization.mjs <create|revoke|show|list> [options]');
  console.error('  create --job-ids <id,...> --expires-at <ISO> [--starts-at <ISO>]');
  console.error('         [--environment-id <id>] [--project-id <id>] [--owner-id <id>]');
  console.error('  revoke --id <id>');
  console.error('  show --id <id>');
  console.error('  list');
  console.error('  [--data-dir <dir>] [--config <path>]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) usageError(`missing value for --${key}`);
      args[key] = value;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// Read KEY=value lines from the host config file. Throws when the file
// cannot be read — the caller turns that into the exit-2 refusal.
function readHostConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!['create', 'revoke', 'show', 'list'].includes(command)) {
    usageError(command ? `unknown command ${JSON.stringify(command)}` : 'a command is required');
  }

  const dataDir = args['data-dir'] ?? process.env.NOVA_API_DATA_DIR ?? DEFAULT_DATA_DIR;
  const configPath = args.config ?? process.env.NOVA_API_CONFIG ?? DEFAULT_CONFIG_PATH;

  // Host config is needed whenever an identity value is not supplied
  // explicitly. It is read lazily, once, and only then.
  let hostConfig = null;
  let hostConfigFailed = false;
  const hostValue = (key) => {
    if (hostConfig === null && !hostConfigFailed) {
      try {
        hostConfig = readHostConfig(configPath);
      } catch {
        hostConfigFailed = true;
      }
    }
    if (hostConfigFailed) {
      console.error(`gateway-authorization: host config is unreadable: ${configPath}`);
      console.error('gateway-authorization: refusing to run — pass the identity explicitly (--owner-id, --environment-id, --project-id) or fix the host config.');
      process.exit(2);
    }
    return hostConfig[key];
  };

  const store = new AuthorizationStore({
    filePath: path.join(dataDir, 'gateway-authorizations.json'),
    auditPath: path.join(dataDir, 'gateway-authorization-audit.log'),
    component: 'host-operator-cli',
  });

  if (command === 'create') {
    const jobIds = (args['job-ids'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (jobIds.length === 0) usageError('--job-ids is required (comma-separated nova-job-<uuid> ids)');
    for (const id of jobIds) {
      if (!JOB_ID_RE.test(id)) usageError(`invalid job id ${JSON.stringify(id)}`);
    }
    const expiresAt = args['expires-at'];
    if (!expiresAt || !isValidIsoUtc(expiresAt)) {
      usageError('--expires-at is required and must be a strict UTC ISO 8601 timestamp (e.g. 2026-12-01T00:00:00.000Z)');
    }
    const startsAt = args['starts-at'] ?? new Date().toISOString();
    if (!isValidIsoUtc(startsAt)) {
      usageError('--starts-at must be a strict UTC ISO 8601 timestamp');
    }
    const ownerId = args['owner-id'] ?? hostValue('NOVA_OWNER_ID') ?? 'nova-owner';
    const environmentId = args['environment-id'] ?? hostValue('NOVA_ENVIRONMENT_ID') ?? 'nova-api';
    const projectId = args['project-id'] ?? hostValue('NOVA_PROJECT_ID') ?? 'nova-ai-studio';
    let record;
    try {
      record = store.create({
        jobIds,
        expiresAt,
        startsAt,
        environmentId,
        projectId,
        ownerId,
      });
    } catch (err) {
      console.error(`gateway-authorization: ${err.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === 'revoke') {
    const id = args.id;
    if (!id) usageError('--id is required');
    const ownerId = args['owner-id'] ?? hostValue('NOVA_OWNER_ID') ?? 'nova-owner';
    let revoked;
    try {
      revoked = store.revoke(id, { revokedByOwnerId: ownerId });
    } catch (err) {
      console.error(`gateway-authorization: ${err.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(revoked, null, 2));
    return;
  }

  if (command === 'show') {
    const id = args.id;
    if (!id) usageError('--id is required');
    const record = store.get(id);
    if (!record) {
      console.error(`gateway-authorization: no authorization record ${JSON.stringify(id)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  // list
  console.log(JSON.stringify(store.list(), null, 2));
}

main();
