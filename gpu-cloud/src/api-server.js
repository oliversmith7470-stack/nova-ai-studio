// NOVA AI Studio — Phase 3 API process (NEW — Rev 2 §2, §23;
// Rev 3 §C-6: `gpu-cloud/src/api-server.js`).
//
// The small Node HTTP server that owns one GpuManager instance. It is
// the ONLY process that touches the manager store, the storage engine,
// and the sweep/reconciliation timers. It exposes exactly the internal
// endpoints in Rev 2 §3.4, all requiring the API secret + HMAC signing
// (§11, Rev 3 §C-1.10). It never serves browsers directly. It holds no
// Cloudflare secret and no job token; it holds a Gemini key ONLY as host
// configuration for the opt-in direct-Gemini enhancement fallback
// (approved v5 design, A4), never in the repo and never logged. It never
// touches D1 directly — every D1 need goes through the Worker's signed
// /internal/d1-apply + /internal/d1-read endpoints (Rev 3 §C-1.1).
//
// Controlled-test mode ONLY in Phase 3. There is no production behaviour
// here: in production mode the process starts with NO controlled-test
// executor registered and every submit is refused with no-capacity
// (Rev 2 §6.4, Rev 3 §C-1.4). No deployment, no systemd installation,
// no live-database writes, no paid GPU dispatch. The draft systemd unit
// (gpu-cloud/systemd/nova-api-server.service) is a FILE ONLY — it is
// not installed or enabled by anything here.
//
// Usage (controlled test):
//   NOVA_API_SECRET=<secret> NOVA_WORKER_ORIGIN=http://127.0.0.1:<port>
//   NOVA_API_MODE=controlled-test node gpu-cloud/src/api-server.js
//
// Configuration is env-only for the CLI entry; createApiServer(config)
// takes the same values programmatically (tests inject a fake D1 client,
// a fake executor, and a stub usage source).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { GpuManager } from './gpu-manager.js';
import { PROVIDER_DEFINITIONS } from './providers.js';
import { KaggleExecutor, KAGGLE_PROVIDER_ID } from './kaggle-executor.js';
// The real personal executor (Rev 4.8 §7, reviewer correction): the LTX
// executor that builds the Run 10 notebook, replacing the Wan default
// notebook builder the generic KaggleExecutor ships with.
import { LtxKaggleExecutor } from './engines/ltx-executor.js';
import { createStorage } from './storage/index.js';
import { ApiStateStore } from './api-server/state-store.js';
import { verifyWorkerAuth } from './api-server/auth.js';
import { createAttestationVerifier } from './api-server/attestation.js';
import { SqliteNonceStore } from './api-server/nonce-store.js';
import { HttpD1Client } from './api-server/d1-client.js';
import { DispatchManager } from './api-server/dispatch.js';
import { SweepRunner } from './api-server/sweep.js';
import { ReconciliationRunner } from './api-server/reconcile.js';
import { validateMp4 } from './api-server/validation.js';
import { revokeSecret as doRevokeSecret } from './api-server/revocation.js';
import { AuthorizationStore } from './gateway-authorization.js';
import { buildGatewayPolicy } from './gateway-policy.js';
import { createGatewayClient } from './gateway-client.js';
import { createDirectGeminiAdapter } from './direct-gemini.js';
import {
  ACTIVATION_CONFIG_PATH,
  ACTIVATION_AUDIT_LOG_PATH,
  readActivationConfig,
  parseKaggleFloorHours,
  appendActivationAuditLog,
  computeAuthorisation,
  signCapacityResponse,
  storageHealth,
} from './api-server/activation.js';
import { HoursTracker, weekStartMs } from './hours.js';
import { isEngaged } from './kill-switch.js';
import { checkRunnerHeartbeat } from './api-server/runner-heartbeat.js';
import { queueDepth } from './queue.js';
import {
  API_SERVER_VERSION,
  ACK_WINDOW_MS,
  SWEEP_INTERVAL_MS,
  RECONCILE_INTERVAL_MS,
  RETENTION_ENABLED,
  RETENTION_DAYS,
} from './api-server/constants.js';

import {
  STARTUP_STATE_DIR,
  verifyStartupReadiness,
  decideStartupFailureExit,
  resetAttemptCounter,
  logStartupEvent,
  normaliseError,
  attachStartupIdentity,
  formatRejectionValue,
} from './api-server/startup-attempts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_DATA_DIR = path.join(__dirname, '..', 'data', 'api');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MAX_BODY_BYTES = 256 * 1024;

export function routeInventory() {
  // Rev 3.2 §B-3.2.11: four attributes per entry, generated from the
  // shipped code (this table is built from the route table below).
  return [
    { method: 'GET', pattern: '/internal/health', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 5 s Worker timeout applies client-side' },
    { method: 'POST', pattern: '/internal/submit', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 256 KB body limit, 10 s Worker timeout applies client-side' },
    { method: 'GET', pattern: '/internal/status', auth: 'API-secret + HMAC', middleware: 'HMAC verify (empty body), 5 s Worker timeout applies client-side' },
    { method: 'GET', pattern: '/internal/download', auth: 'API-secret + HMAC', middleware: 'HMAC verify (empty body), 30 s idle timeout applies client-side' },
    { method: 'POST', pattern: '/internal/cancel', auth: 'API-secret + HMAC', middleware: 'HMAC verify, 256 KB body limit, 5 s Worker timeout applies client-side' },
    { method: 'GET', pattern: '/internal/capacity', auth: 'API-secret + HMAC', middleware: 'HMAC verify (empty body), audience + requestNonce query params, signed response, 5 s Worker timeout applies client-side' },
  ];
}

// =============================================================================
// Production executor registration factory (Rev 4.9 §4, Rev 4.8 §6)
// =============================================================================

// The code-owned production executor allowlist: provider id -> { create }.
// An entry is added ONLY after the seven §6 registration-gate items have
// been independently evidenced and accepted. The allowlist is EMPTY: no
// provider has passed the gate. `kaggle-t4` is not a permitted public
// executor (personal/experimental only); paid `runpod-4090` is not eligible
// without the owner's separate cost approval and all required gate
// evidence. The factory never treats a provider definition or a
// credential's presence as proof of public authorisation.
export const PRODUCTION_EXECUTOR_FACTORIES = new Map();

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]*$/;

// Parse NOVA_PRODUCTION_EXECUTORS: a comma-separated list of trimmed,
// non-empty, unique provider ids. An empty value is valid (no public
// production executor registered; the API still starts, in the
// no-capacity state). A malformed list (an id with an illegal shape) or a
// duplicate id is a startup failure — the factory never silently skips an
// invalid configured id.
export function parseExecutorList(value) {
  if (value === undefined || value === null) return [];
  const raw = String(value);
  if (raw.trim() === '') return [];
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const seen = new Set();
  for (const id of ids) {
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error(`malformed production executor list: invalid provider id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`malformed production executor list: duplicate provider id ${JSON.stringify(id)}`);
    }
    seen.add(id);
  }
  return ids;
}

// Parse a boolean env flag for the FreeLLMAPI gateway options (approved
// v5 design, §5): "true"/"1" is on, anything else (including unset) is
// off. Flags default OFF — the design authorizes no activation.
function parseEnvFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1';
}

// Controlled-test mode requires an explicitly supplied controlled-test
// executor and registers only that executor. Production mode never creates
// or defaults to FakeControlledExecutor; the two modes are mutually
// exclusive.
export function assertControlledTestExecutor(executor) {
  if (!executor || executor.id !== 'controlled-test-ltx') {
    throw new Error('refusing to start: controlled-test mode requires the controlled-test executor only (Rev 3 §C-1.4)');
  }
}

export function registerControlledTestProvider(manager) {
  return manager.registerProvider({
    id: 'controlled-test-ltx',
    kind: 'kaggle',
    label: 'Controlled-test LTX executor (fake, Phase 3 only)',
    gpuType: 'NVIDIA T4 (simulated)',
    vramGb: 16,
    models: ['ltx-video-2b'],
    costModel: { type: 'free', perSecondUsd: 0 },
    availabilityWindow: { type: 'always', description: 'Controlled test only — not public capacity.' },
    maxConcurrentJobs: 1,
    connected: true,
    status: 'available',
  });
}

// Executor identity: the BaseExecutor family (Kaggle/Colab) carries
// `providerId`; the controlled-test fake carries `id`. Both spellings are
// accepted; a missing identity is a mismatch.
export function executorProviderId(executor) {
  if (!executor || typeof executor !== 'object') return null;
  return executor.providerId ?? executor.id ?? null;
}

// The executor bound to a provider id must be that provider's executor
// and must implement the runtime contract dispatch uses: start(job) and
// fileReport(report). getExecutionState is OPTIONAL at registration — the
// real Kaggle executor has no programmatic status query yet (manual
// channel; the query is unverified, §B-3.2.18), and DispatchManager
// treats a missing query as unknown state (reconciliation path), never as
// a failure. reportFailure and requestCancel are likewise optional —
// dispatch checks for them before calling. A future production executor
// proves the full contract through gate item 7 (controlled dispatch
// end-to-end) before it is ever added to the allowlist.
export function assertExecutorMatchesProvider(executor, providerId) {
  if (!executor || executorProviderId(executor) !== providerId) {
    throw new Error(`production executor id mismatch: expected executor for provider ${providerId}`);
  }
  for (const method of ['start', 'fileReport']) {
    if (typeof executor[method] !== 'function') {
      throw new Error(`production executor for provider ${providerId} is missing ${method}()`);
    }
  }
}

// Kaggle credential presence on the API host (Rev 4.9 §4, personal path):
// the Kaggle CLI reads KAGGLE_USERNAME/KAGGLE_KEY from the environment or
// ~/.kaggle/kaggle.json. Presence is checked, never the values — no
// credential value is read, logged, or compared here. `overrides` exists
// for tests (config.kaggleCredentialPresent); production always probes the
// host. The home directory defaults to the process user's home.
export function isKaggleCredentialPresent({ env = process.env, home = os.homedir() } = {}) {
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

// Personal executor registration (owner-only, Rev 4.9 §4): the only
// recognised personal id is `kaggle-t4`; it must resolve to an implemented
// Kaggle executor and the required Kaggle credential must be present on the
// API host. An unknown or unimplemented id, or a missing credential,
// disables the personal executor but does NOT prevent the API from
// starting (the personal path is opt-in, unlike a production id, which is
// a startup failure). The personal executor is never added to the public
// allowlist and never satisfies public capacity.
//
// The owner-token check remains authoritative at the Worker boundary, where
// the Pages secret NOVA_OWNER_TOKEN actually resides. The API host must not
// receive a duplicate copy of the owner bearer token, and this factory must
// not claim it has verified the Pages secret: the signed
// personal-audience request and activation state are verified before
// personal dispatch by the Worker, not here.
//
// Rev 4.8 §6 (M2-P): registration additionally requires the owner-token
// IDENTIFIER to be configured on this host (ownerTokenConfigured —
// identifier only, the token value never touches the API host). Without
// it the personal executor is unavailable: the capacity response would
// otherwise claim a personal path that no submit can authenticate.
// The executor is wired to the HoursTracker and the registry when
// supplied so personal usage is recorded and budgeted.
//
// Returns { providerId, providerDef, executor } or null (personal path
// unavailable). The provider def is registered with connected/available
// set from credential presence — the registry's dispatchable() gate needs
// those flags, and credential presence is the only authenticated signal
// available at this layer; the five §6 status concepts (S1) remain a
// separate design change and are NOT claimed here.
export function createPersonalExecutor({ personalExecutorId = '', kaggleCredentialPresent = null, ownerTokenConfigured = null, hoursTracker = null, registry = null, packageDir = null, attestationVerifier = null } = {}) {
  const id = typeof personalExecutorId === 'string' ? personalExecutorId.trim() : '';
  if (id === '') return null;
  if (id !== KAGGLE_PROVIDER_ID) {
    console.error(`[api-server] personal executor unavailable: unknown personal executor id ${JSON.stringify(id)} (only kaggle-t4 is recognised)`);
    return null;
  }
  const credentialPresent = kaggleCredentialPresent ?? isKaggleCredentialPresent();
  if (!credentialPresent) {
    console.error('[api-server] personal executor unavailable: kaggle-t4 requested but the Kaggle credential is not present on this host');
    return null;
  }
  if (ownerTokenConfigured !== true) {
    console.error('[api-server] personal executor unavailable: kaggle-t4 requested but NOVA_OWNER_TOKEN_ID is not configured on this host');
    return null;
  }
  const def = PROVIDER_DEFINITIONS.find((d) => d.id === KAGGLE_PROVIDER_ID);
  if (!def) {
    console.error('[api-server] personal executor unavailable: kaggle-t4 has no provider definition');
    return null;
  }
  if (typeof packageDir !== 'string' || packageDir.length === 0) {
    console.error('[api-server] personal executor unavailable: no packageDir for the Kaggle executor');
    return null;
  }
  const executor = new LtxKaggleExecutor({ packageDir, hoursTracker, registry, attestationVerifier });
  // The personal executor is the REAL LTX executor (engines/ltx-executor.js):
  // it builds the Run 10 notebook (121f, 1024x576, 24 fps, 8 steps) with
  // the Kaggle Model mounts, NOT the generic KaggleExecutor's Wan default.
  // The attestation verifier (bound to the API host's signing secrets) is
  // carried so the executor's VDP-06 boundary can verify the
  // server-generated personal attestation; without it no personal job
  // verifies (fail closed).
  // The transport stays null (human channel) until the owner supplies a
  // Kaggle credential AND the proof run is separately authorised — the
  // executor never dispatches without it, and submit() without a
  // transport returns a pending promise (no fake completion).
  assertExecutorMatchesProvider(executor, KAGGLE_PROVIDER_ID);
  return {
    providerId: KAGGLE_PROVIDER_ID,
    providerDef: { ...def, connected: true, status: 'available' },
    executor,
  };
}

// systemd readiness notification (Rev 4.9 §5, Type=notify). Sends READY=1
// via /usr/bin/systemd-notify --ready, with a bounded timeout and both the
// spawn error and the exit status checked. Returns true on success (or
// when there is no notification socket to answer — a plain/manual run),
// false on any failure. Never throws. NotifyAccess=all is required on the
// unit because the notification is sent by this short-lived helper process,
// not directly by the Node main PID. install.sh verifies
// /usr/bin/systemd-notify exists on the target host.
export function notifySystemdReady() {
  if (!process.env.NOTIFY_SOCKET) return true;
  try {
    const result = spawnSync('/usr/bin/systemd-notify', ['--ready'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.error) return false;
    if (result.status !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

export function createApiServer(config = {}) {
  const mode = config.mode === 'controlled-test' ? 'controlled-test' : 'production';
  const secret = config.secret ?? process.env.NOVA_API_SECRET ?? '';
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('NOVA_API_SECRET is required');
  }
  const secretPrevious = config.secretPrevious ?? process.env.NOVA_API_SECRET_PREVIOUS ?? '';
  const dataDir = config.dataDir ?? process.env.NOVA_API_DATA_DIR ?? DEFAULT_API_DATA_DIR;
  const now = config.now ?? (() => Date.now());

  // -- Rev 4.8 §4/§6/§11: M2-P activation machinery -------------------------
  // The activation flags are read ONCE at process start from
  // /etc/nova-api/activation.conf (or config.activationConfigPath in
  // tests) and live in a SEPARATE structure from the API config object
  // — the gateway non-interference test asserts they are NOT in
  // api.config, so they are never merged into it. A missing file means
  // both flags false; a malformed file or unknown key is a startup
  // failure (readActivationConfig throws). There is no HTTP endpoint,
  // no Worker env var, and no request parameter that can read or change
  // these flags; a flag changes only by the §4.1 operator procedure.
  const activationConfigPath = config.activationConfigPath ?? ACTIVATION_CONFIG_PATH;
  const activationFlags = readActivationConfig(activationConfigPath);
  // Response signing secret (key separation, §8): distinct from the
  // transport secret NOVA_API_SECRET. A production-mode process without
  // it cannot serve a signed capacity response and fails at startup;
  // a controlled-test process may run without it, but its capacity
  // route then refuses to serve (503) rather than serving unsigned.
  const signingSecret = config.signingSecret ?? process.env.NOVA_SIGNING_SECRET ?? '';
  if (mode === 'production' && signingSecret.length === 0) {
    throw new Error('NOVA_SIGNING_SECRET is required in production mode (Rev 4.8 §8 key separation)');
  }
  // Previous signing secret (1-hour rotation overlap, same rule as the
  // transport secret): the HMAC may verify against either during the
  // overlap; revocation overrides the overlap for both secrets.
  const signingSecretPrevious = config.signingSecretPrevious ?? process.env.NOVA_SIGNING_SECRET_PREVIOUS ?? '';
  // Owner-token identifier (the token VALUE never touches this host):
  // personal executor registration additionally requires it configured.
  const ownerTokenId = config.ownerTokenId ?? process.env.NOVA_OWNER_TOKEN_ID ?? '';
  const ownerTokenConfigured = ownerTokenId.length > 0;
  // Kaggle experimental floor (hours/week, default 5, §11/§12): a
  // non-numeric or negative value is a startup failure.
  const kaggleFloorHours = parseKaggleFloorHours(
    config.kaggleExperimentFloorHours ?? process.env.NOVA_KAGGLE_EXPERIMENT_FLOOR_HOURS,
  );
  // Rev 4.8 §5.3: the personal provider ids, shared by reference with
  // the manager so the dispatcher routes personal jobs only to them
  // and public jobs never to them. Filled when the personal executor
  // registers below; empty while no personal executor is registered.
  const personalProviderIds = new Set();

  // FreeLLMAPI gateway prompt enhancement (approved v5 design, A4/A5/§5).
  // Host config only, never in the repo; both flags default OFF. The
  // environment defaults to production (fail closed). Production startup
  // rejects NOVA_GATEWAY_ENHANCEMENT=true — enhancement is never a
  // production capability in this revision. The gateway client is created
  // only when the flag is on (no key → client disabled, chain shortens
  // to the raw prompt); the direct-Gemini fallback adapter exists only
  // when a Gemini key is present in host config (verified absent — the
  // fallback stays dormant until the owner supplies one).
  const gatewayEnvironment = config.environment ?? process.env.NOVA_ENVIRONMENT ?? 'production';
  const gatewayEnvironmentId = config.environmentId ?? process.env.NOVA_ENVIRONMENT_ID ?? 'nova-api';
  const gatewayProjectId = config.projectId ?? process.env.NOVA_PROJECT_ID ?? 'nova-ai-studio';
  const gatewayOwnerId = config.ownerId ?? process.env.NOVA_OWNER_ID ?? 'nova-owner';
  const gatewayEnhancement = config.gatewayEnhancement ?? parseEnvFlag(process.env.NOVA_GATEWAY_ENHANCEMENT, false);
  if ((gatewayEnvironment === 'production' || mode === 'production') && gatewayEnhancement) {
    throw new Error('gateway enhancement cannot be enabled in production');
  }
  const authorizationStore = new AuthorizationStore({
    filePath: path.join(dataDir, 'gateway-authorizations.json'),
    auditPath: path.join(dataDir, 'gateway-authorization-audit.log'),
  });
  const gatewayPolicy = buildGatewayPolicy({
    environment: gatewayEnvironment,
    environmentId: gatewayEnvironmentId,
    projectId: gatewayProjectId,
    ownerId: gatewayOwnerId,
    authorizationStore,
    component: 'api-server',
  });
  const gatewayClient = gatewayEnhancement
    ? createGatewayClient({
        baseUrl: config.gatewayBaseUrl ?? process.env.NOVA_GATEWAY_BASE_URL ?? 'http://127.0.0.1:3001',
        apiKey: config.gatewayApiKey ?? process.env.NOVA_GATEWAY_API_KEY ?? '',
        model: config.gatewayTextModel ?? process.env.NOVA_GATEWAY_TEXT_MODEL ?? 'google:gemini-3.5-flash-lite',
      })
    : null;
  const directGemini = gatewayEnhancement
    ? createDirectGeminiAdapter({ apiKey: config.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '' })
    : null;

  const apiState = new ApiStateStore(path.join(dataDir, 'api-state.json'));

  // Rev 4.8 §8 nonce store (reviewer correction): the API process's own
  // local SQLite nonce store at <dataDir>/nonces.db — /var/lib/nova-api/
  // nonces.db in production. Consumption is one atomic INSERT OR IGNORE,
  // so two concurrent consumers of the same nonce admit exactly one.
  // ApiStateStore is NOT a nonce store and is never used as one.
  const nonceStore = config.nonceStore ?? new SqliteNonceStore(path.join(dataDir, 'nonces.db'));

  // D1 client: the Worker origin is required — the API process cannot
  // function without its D1 callbacks (it never touches D1 directly).
  const d1Client = config.d1Client ?? new HttpD1Client({
    workerOrigin: config.workerOrigin ?? process.env.NOVA_WORKER_ORIGIN ?? '',
    secret,
    signingSecret,
    timeoutMs: config.d1TimeoutMs ?? 5000,
  });

  // Manager + storage (local store behind the API process, Rev 2 §2).
  const manager = new GpuManager({
    storePath: config.storePath ?? path.join(dataDir, 'gpu-manager.json'),
    now,
    config: { maxQueueDepth: 100 },
    personalProviderIds,
    enhancement: {
      enabled: gatewayEnhancement,
      client: gatewayClient,
      directGemini,
      policy: gatewayPolicy,
      authorizationStore,
    },
  });
  const storage = config.storage ?? createStorage({
    rootDir: config.storageRootDir ?? path.join(dataDir, 'store'),
    clock: now,
  });
  manager.attachStorage(storage);

  // Rev 4.8 §7: weekly budget tracking per provider (Kaggle 30 h/week
  // by the provider definition, week starting Saturday 00:00 UTC). The
  // tracker shares the manager's store; its keys are namespaced
  // (`hours:usage:<providerId>`) and do not collide with job state.
  const hoursBudgets = {};
  for (const def of PROVIDER_DEFINITIONS) {
    if (typeof def.availabilityWindow?.hoursPerWeek === 'number') {
      hoursBudgets[def.id] = def.availabilityWindow.hoursPerWeek;
    }
  }
  const hoursTracker = new HoursTracker({ store: manager.store, budgets: hoursBudgets });

  // Executor registration factory (Rev 4.9 §4, Rev 4.8 §6): production
  // executor registration is explicit startup configuration, separate from
  // controlled-test mode. Production mode never creates or defaults to
  // FakeControlledExecutor; controlled-test mode requires an explicitly
  // supplied controlled-test executor and registers only that executor.
  const productionExecutorIds = parseExecutorList(
    config.productionExecutors ?? process.env.NOVA_PRODUCTION_EXECUTORS ?? '',
  );
  const productionExecutors = new Map();
  const personalExecutors = new Map();
  let legacyExecutor = null;
  if (mode === 'controlled-test') {
    const testExecutor = config.executor;
    assertControlledTestExecutor(testExecutor);
    registerControlledTestProvider(manager);
    manager.registerExecutor('controlled-test-ltx', testExecutor);
    // The controlled-test executor is NOT a production executor: it is
    // passed through the legacy single-executor option only, and the
    // production registry stays empty.
    legacyExecutor = testExecutor;
  } else {
    if (config.executor) {
      throw new Error('production mode does not accept a single injected test executor');
    }
    for (const providerId of productionExecutorIds) {
      // The allowlist is the gate: an unknown, ungated, or unimplemented
      // id is a STARTUP FAILURE — never a silent skip. Listing kaggle-t4
      // (or any other non-permitted provider) here is a startup failure.
      const registration = PRODUCTION_EXECUTOR_FACTORIES.get(providerId);
      if (!registration) {
        throw new Error(`production executor is not permitted or implemented: ${providerId}`);
      }
      const provider = manager.registry.get(providerId);
      if (!provider) {
        throw new Error(`unknown production provider: ${providerId}`);
      }
      const executor = registration.create(config);
      assertExecutorMatchesProvider(executor, providerId);
      manager.registerExecutor(providerId, executor);
      productionExecutors.set(providerId, executor);
    }
    // Personal executor (owner-only, opt-in): registered separately from
    // NOVA_PERSONAL_EXECUTOR, never added to the public allowlist, never
    // satisfies public capacity. Unavailable personal path does not stop
    // startup; the owner-token check stays at the Worker boundary.
    // Rev 4.8 §6: registration additionally requires the configured
    // owner-token identifier (the token VALUE never touches this host);
    // the executor is wired to the HoursTracker and the registry so
    // personal usage is recorded and budgeted.
    const personal = createPersonalExecutor({
      personalExecutorId: config.personalExecutor ?? process.env.NOVA_PERSONAL_EXECUTOR ?? '',
      kaggleCredentialPresent: config.kaggleCredentialPresent ?? null,
      ownerTokenConfigured,
      hoursTracker,
      registry: manager.registry,
      packageDir: config.packageDir ?? path.join(dataDir, 'packages'),
      // M2-P round 2: the executor's VDP-06 boundary verifies the
      // server-generated personal attestation against the API host's
      // signing secrets (current + previous during rotation) with the
      // revocation record — the same key separation as request auth.
      attestationVerifier: createAttestationVerifier({
        signingSecrets: [signingSecret, signingSecretPrevious],
        apiState,
      }),
    });
    if (personal) {
      manager.registerProvider(personal.providerDef);
      manager.registerExecutor(personal.providerId, personal.executor);
      personalExecutors.set(personal.providerId, personal.executor);
      personalProviderIds.add(personal.providerId);
    }
  }

  const dispatch = new DispatchManager({
    manager,
    executor: legacyExecutor,
    productionExecutors,
    personalExecutors,
    runnerHealthPath: config.runnerHealthPath ?? path.join(dataDir, 'runner-health.json'),
    d1Client,
    apiState,
    gatewayPolicy,
    mode,
    ownerTokenId: ownerTokenConfigured ? ownerTokenId : null,
    // M2-P round 2: the dispatcher generates the personal attestation
    // server-side with the API host's signing secret (current only —
    // rotation's previous secret verifies, never signs).
    attestationSigningSecret: signingSecret,
    ackWindowMs: config.ackWindowMs ?? ACK_WINDOW_MS,
    ackPollMs: config.ackPollMs ?? 1000,
    validateOutput: config.validateOutput ?? validateMp4,
    now,
  });

  // -- Rev 4.8 §4.2/§4.3: signed capacity ------------------------------------
  // computeCapacity(audience, requestNonce) -> the capacity response
  // body (the §4.2 authorisation calculation over live state). The
  // route handler signs it with NOVA_SIGNING_SECRET; the dispatcher
  // reuses it through setAuthorisationCheck at submit time (§6).
  // A failing capacity read never throws to the route: it surfaces as
  // an internal-error 500 (the Worker treats it as api-unreachable).
  const runnerHealthPath = config.runnerHealthPath ?? path.join(dataDir, 'runner-health.json');
  async function computeCapacity({ audience, requestNonce }) {
    const capacity = await manager.storageCapacity();
    const reserved = dispatch._reservedHeadroomBytes();
    // Storage health (§9 F): the writability check targets the actual
    // store root (manager.storage.rootDir), not an assumed path — the
    // root is created by install.sh on the host; if it is missing here
    // (a fresh data dir), create it, because the store cannot function
    // without it. A root that cannot be created or written is
    // unhealthy (fail closed).
    const storeRoot = manager.storage?.rootDir ?? path.join(dataDir, 'store');
    let storeWritable = false;
    try {
      fs.accessSync(storeRoot, fs.constants.W_OK);
      storeWritable = true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        try {
          fs.mkdirSync(storeRoot, { recursive: true });
          fs.accessSync(storeRoot, fs.constants.W_OK);
          storeWritable = true;
        } catch {
          storeWritable = false;
        }
      } else {
        storeWritable = false;
      }
    }
    const heartbeat = checkRunnerHeartbeat(runnerHealthPath, Date.now());
    const storage = storageHealth({
      headroomBytes: Math.max(0, (capacity?.freeBytes ?? 0) - reserved),
      writable: storeWritable,
      sweepHealthy: heartbeat.healthy === true,
    });
    storage.reservedBytes = Math.max(0, reserved);
    storage.totalBytes = capacity?.totalBytes ?? 0;
    storage.freeBytes = capacity?.freeBytes ?? 0;

    const kaggleQuota = hoursTracker.usage('kaggle-t4');
    const providerQuotas = new Map();
    for (const id of productionExecutors.keys()) {
      const u = hoursTracker.usage(id);
      providerQuotas.set(id, u.tracked ? { remaining: u.hoursRemaining, total: u.hoursBudget, floor: 0 } : null);
    }
    const productionDispatchableIds = [...productionExecutors.keys()].filter(
      (id) => manager.registry.dispatchable(id) && manager.executors.has(id),
    );
    const personalDispatchable = personalExecutors.size > 0
      && [...personalExecutors.keys()].every(
        (id) => manager.registry.dispatchable(id) && manager.executors.has(id),
      );

    const providerDetails = [];
    for (const def of manager.registry.list()) {
      const id = def.id;
      const quota = id === 'kaggle-t4' ? kaggleQuota : hoursTracker.usage(id);
      providerDetails.push({
        id,
        kind: def.kind,
        configured: productionExecutors.has(id) || personalExecutors.has(id),
        // §6 S1: `authenticated` requires a credential check passed
        // within the last hour; no such check exists yet, so this is
        // honestly false even when the credential is present. Presence
        // alone proves nothing.
        authenticated: false,
        executorRegistered: manager.executors.has(id),
        // §6 S1: `executionVerified` requires a proof run through the
        // registered executor; Run 10 was manual, so this is false.
        executionVerified: false,
        currentlyDispatchable: manager.registry.dispatchable(id) && manager.executors.has(id),
        models: def.models ?? [],
        maxConcurrentJobs: def.maxConcurrentJobs ?? 0,
        jobsActive: manager._activeJobsOn(id),
        jobsQueued: 0, // jobs are not assigned to a provider before dispatch
        quotaRemaining: quota?.tracked ? quota.hoursRemaining : null,
        quotaUnit: quota?.tracked ? 'hours' : null,
        quotaResetAt: quota?.tracked
          ? new Date(weekStartMs(Date.now()) + 7 * 24 * 3600 * 1000).toISOString()
          : null,
        quotaFloor: id === 'kaggle-t4' ? kaggleFloorHours : null,
      });
    }

    return computeAuthorisation({
      mode,
      flags: activationFlags,
      killSwitchEngaged: isEngaged(manager.store.state),
      storage,
      productionExecutorIds: [...productionExecutors.keys()],
      personalExecutorRegistered: personalExecutors.size > 0,
      kaggleCredentialPresent: config.kaggleCredentialPresent ?? isKaggleCredentialPresent(),
      ownerTokenConfigured,
      kaggleQuota: kaggleQuota.tracked
        ? { remaining: kaggleQuota.hoursRemaining, total: kaggleQuota.hoursBudget, floor: kaggleFloorHours }
        : null,
      providerQuotas,
      providerDetails,
      personalTokenId: ownerTokenConfigured ? ownerTokenId : null,
      queueDepth: queueDepth(manager.store.state),
      requestedAudience: audience,
      requestNonce,
      productionDispatchableIds,
      personalDispatchable,
      ceilingUsd: 0,
      committedUsd: 0,
      paidProductionExecutorIds: [],
    });
  }
  // Submit-time authorisation revalidation (§6): the dispatcher asks
  // the live calculation for the submitted audience and refuses the
  // submit when it is not authorised. A failing check fails closed.
  dispatch.setAuthorisationCheck(async (audience) => {
    const body = await computeCapacity({ audience, requestNonce: '00000000000000000000000000000000' });
    if (audience === 'personal') {
      return { authorised: body.personalProductionAuthorised, reason: body.personalReason ?? null };
    }
    return { authorised: body.publicProductionAuthorised, reason: body.reason ?? null };
  });

  const sweep = new SweepRunner({
    manager,
    d1Client,
    apiState,
    dispatch,
    usageSource: config.usageSource ?? null,
    // Q3 APPROVED 25 Nov 2026 ~18:21 WAT: retention ENABLED, 30 days.
    // Rev 2 §16.1. Config overrides exist only for tests (disabled-path
    // verification); production always uses the approved constants.
    retentionEnabled: config.retentionEnabled ?? RETENTION_ENABLED,
    retentionDays: config.retentionDays ?? RETENTION_DAYS,
    now,
    onBeforeComponent: config.onBeforeComponent ?? null,
    onBeforeDeleteRows: config.onBeforeDeleteRows ?? null,
  });

  const reconcile = new ReconciliationRunner({
    manager,
    d1Client,
    apiState,
    dispatch,
    now,
  });

  const startedAt = Date.now();
  const host = config.host ?? process.env.NOVA_API_HOST ?? '127.0.0.1';
  const port = config.port ?? Number(process.env.NOVA_API_PORT ?? 8788);
  let server = null;
  let sweepTimer = null;
  let reconcileTimer = null;

  async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function send(res, status, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  async function handle(req, res) {
    const requestId = randomUUID();
    const url = new URL(req.url, 'http://localhost');
    const pathWithQuery = url.pathname + url.search;
    try {
      // No unauthenticated route exists on this process — every route,
      // including health-check, requires the secret + HMAC (Rev 2 §3.4).
      const isGet = req.method === 'GET';
      const bodyText = isGet ? '' : await readBody(req);
      const auth = verifyWorkerAuth(req, req.method, pathWithQuery, bodyText, {
        transportSecrets: [secret, secretPrevious],
        signingSecrets: [signingSecret, signingSecretPrevious],
        apiState,
        nonceStore,
      });
      if (!auth.ok) {
        console.error(`[api-server] auth rejected step ${auth.step} requestId=${requestId} ${req.method} ${url.pathname}`);
        return send(res, 401, { error: 'unauthorised' });
      }
      let body = null;
      if (!isGet && bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          return send(res, 400, { error: 'invalid-json' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/internal/health') {
        return send(res, 200, {
          status: 'ok',
          version: API_SERVER_VERSION,
          uptimeMs: Date.now() - startedAt,
          manager: 'ready',
          mode,
        });
      }

      // Rev 4.8 §4.3: signed capacity. The caller is the Worker (request
      // auth is two-secret verifyWorkerAuth, Rev 4.8 §8: transport secret
      // presented, signing secret keys the HMAC, nonce consumed in the
      // local SQLite store). The response is signed with
      // NOVA_SIGNING_SECRET and carries the request nonce back; the
      // Worker verifies the signature, the ±5 s freshness, the nonce
      // echo, and the audience binding before routing on it. A request
      // without a valid audience or nonce is 400; a capacity read
      // failure is 500 (the Worker treats it as api-unreachable); a
      // process without a signing secret serves nothing (503) rather
      // than an unsigned response. (The route-level 503 is defence in
      // depth: request auth already fails closed with 401 before the
      // route is reached, so it is unreachable while the signing secret
      // is required — kept so the route never serves unsigned.)
      // The body is the §4.2 authorisation calculation over live state.
      if (req.method === 'GET' && url.pathname === '/internal/capacity') {
        const audience = url.searchParams.get('audience');
        const requestNonce = url.searchParams.get('requestNonce');
        if (audience !== 'public' && audience !== 'personal') {
          return send(res, 400, { error: 'invalid-audience' });
        }
        if (!/^[0-9a-f]{32}$/i.test(requestNonce ?? '')) {
          return send(res, 400, { error: 'invalid-request-nonce' });
        }
        if (signingSecret.length === 0) {
          return send(res, 503, { error: 'capacity-unavailable' });
        }
        let body;
        try {
          body = await computeCapacity({ audience, requestNonce });
        } catch (err) {
          console.error(`[api-server] capacity failed requestId=${requestId}:`, err && err.message);
          return send(res, 500, { error: 'internal-error' });
        }
        const bodyText = JSON.stringify(body);
        const { timestamp, signature } = signCapacityResponse({ signingSecret, requestNonce, bodyText });
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
          'X-NOVA-Capacity-Timestamp': timestamp,
          'X-NOVA-Capacity-Signature': signature,
        });
        return res.end(bodyText);
      }

      if (req.method === 'POST' && url.pathname === '/internal/submit') {
        const out = await dispatch.submitExecutions(body ?? {});
        return send(res, out.status, out.body);
      }

      if (req.method === 'GET' && url.pathname === '/internal/status') {
        const executionId = url.searchParams.get('executionId');
        const jobId = url.searchParams.get('jobId');
        if (executionId) {
          const entry = dispatch.executionStatus(executionId);
          if (!entry) return send(res, 404, { error: 'not-found' });
          return send(res, 200, entry);
        }
        if (jobId) {
          try {
            const parent = await dispatch.parentStatus(jobId);
            return send(res, 200, parent);
          } catch (err) {
            return send(res, 502, { error: 'd1-unavailable' });
          }
        }
        return send(res, 400, { error: 'executionId or jobId is required' });
      }

      if (req.method === 'GET' && url.pathname === '/internal/download') {
        return streamDownload(req, res, url);
      }

      if (req.method === 'POST' && url.pathname === '/internal/cancel') {
        if (!body || typeof body.jobId !== 'string' || typeof body.executionId !== 'string') {
          return send(res, 400, { error: 'jobId and executionId are required' });
        }
        const out = await dispatch.cancelExecution(body.jobId, body.executionId);
        return send(res, out.status, out.body);
      }

      return send(res, 404, { error: 'unknown-route' });
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        return send(res, 413, { error: 'body-too-large' });
      }
      console.error(`[api-server] ${req.method} ${url.pathname} failed requestId=${requestId}:`, err && err.message);
      if (!res.headersSent) return send(res, 500, { error: 'internal-error' });
      try { res.end(); } catch { /* ignore */ }
    }
  }

  async function streamDownload(req, res, url) {
    const jobId = url.searchParams.get('jobId');
    const executionId = url.searchParams.get('executionId');
    if (!jobId || !executionId) {
      return send(res, 400, { error: 'jobId and executionId are required' });
    }
    const entry = dispatch.journalEntry(executionId);
    if (!entry || entry.jobId !== jobId || !entry.managerJobId) {
      return send(res, 404, { error: 'not-found' });
    }
    const job = manager.getJob(entry.managerJobId);
    if (!job || !job.outputRef) return send(res, 404, { error: 'not-found' });
    // Access expiry (§9.1): never served after expiry, even if the
    // object still physically exists.
    if (job.outputRef.expiresAt !== null && job.outputRef.expiresAt !== undefined
      && job.outputRef.expiresAt <= now()) {
      return send(res, 410, { error: 'expired' });
    }
    let head;
    try {
      head = manager.headJobOutput(entry.managerJobId);
    } catch {
      return send(res, 404, { error: 'not-found' });
    }
    if (!head) return send(res, 404, { error: 'not-found' });
    let stream;
    try {
      stream = manager.getJobOutput(entry.managerJobId);
    } catch {
      return send(res, 404, { error: 'not-found' });
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'video/mp4',
      'Content-Length': head.sizeBytes,
      'Content-Disposition': `attachment; filename="nova-${jobId}-scene-${entry.sceneIndex}.mp4"`,
      'X-NOVA-Expires-At': String(head.expiresAt ?? ''),
    });
    stream.on('error', () => {
      try { res.end(); } catch { /* ignore */ }
    });
    stream.pipe(res);
  }

  async function start() {
    // Startup sequence (Rev 2 §9.2, §10.4): readiness verification FIRST,
    // then catch-up sweep, pending-mutation replay, startup reconciliation —
    // all BEFORE accepting any new job (before listen). Every pre-listen
    // failure logs its canonical event and throws; the CLI entry decides the
    // exit code (decideStartupFailureExit). Phase 5 protocol active only when
    // NOVA_STARTUP_STATE_DIR is set; unset = Phase 3 behaviour, PROVIDED the
    // new modules are present and load successfully (Rev 4.7, F5-26) — the
    // startup dependency chain is not unchanged (static imports: api-server.js
    // -> startup-attempts.js -> startup-counter.mjs), so a missing/broken new
    // module fails the process at import time (correction (l)).
    let startupRequestId = null;
    let startupWindowStart = null;
    let startupAttempts = null;
    let startupGeneration = null;
    if (STARTUP_STATE_DIR) {
      ({ requestId: startupRequestId, windowStart: startupWindowStart, attempts: startupAttempts, generation: startupGeneration } = verifyStartupReadiness());
      // failStep normalises non-Error rejections via normaliseError (correction
      // (e), Rev 4.7 F5-25): a promise may reject with null, a string, a BigInt,
      // a circular object, or any value — assigning properties to it would throw
      // and replace the original failure. A non-Error rejection is wrapped in an
      // Error carrying the original value as `cause`, so the event, the exit
      // decision, and the diagnostic chain all see the real failure. An Error
      // input passes through unchanged (no cause added). The formatter never
      // throws (formatRejectionValue). The identity is attached via
      // attachStartupIdentity (Rev 4.8, F5-42): a frozen or non-extensible Error
      // makes a direct property assignment throw, so the attachment falls back
      // to a wrapper Error with the original as `cause` — the original failure
      // is never replaced. The event detail is formatted with formatRejectionValue, not read as error.message (Rev 4.8, chunk-17 review): attachStartupIdentity may return the original Error unchanged, so a throwing message getter would throw while building the detail — before the throw into the CLI entry.
      const failStep = (event, err) => {
        const error = attachStartupIdentity(normaliseError(err), startupRequestId, startupWindowStart);
        logStartupEvent(event, { requestId: startupRequestId, windowStart: startupWindowStart, detail: formatRejectionValue(error) });
        throw error;
      };
      try { await sweep.runSweep({ reason: 'startup' }); } catch (err) { failStep('startup-sweep-failed', err); }
      try { await dispatch.replayPendingMutations(); } catch (err) { failStep('startup-replay-failed', err); }
      try { await reconcile.runReconciliation({ source: 'startup' }); } catch (err) { failStep('startup-reconcile-failed', err); }
    } else {
      await sweep.runSweep({ reason: 'startup' });
      await dispatch.replayPendingMutations();
      await reconcile.runReconciliation({ source: 'startup' });
    }
    server = http.createServer((req, res) => { void handle(req, res); });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    } catch (err) {
      // Dispose of the created server object after a failed listen (correction
      // (f)): the process exits via the CLI entry, but a failed listen must not
      // leave a half-bound socket behind for the brief exit path, and a start()
      // caller in tests must be able to re-bind the port. close() on a
      // never-listened server invokes the callback with ERR_SERVER_NOT_RUNNING
      // (verified on node 24, 26 Nov 2026) — ignored here. The 'error' event
      // delivers an Error object, but an Error object is not guaranteed
      // extensible — a frozen/non-extensible Error would make a direct property
      // assignment throw and replace the listen failure (Rev 4.8, F5-42), so
      // the identity is attached via attachStartupIdentity, which falls back
      // to a wrapper Error with the original as `cause`. The event detail is formatted with formatRejectionValue, not read as identified.message (Rev 4.8, chunk-17 review): the identified error may be the original Error with a throwing message getter.
      // Server ownership (Rev 4.8, chunk-15 review — chunk-14 §3): `server` is
      // assigned exactly once, above (`server = http.createServer(...)`), and
      // start() is invoked exactly once per process by the CLI entry (chunk 16)
      // — there is no second start() call site anywhere in the design, and a
      // new chain attempt (supervisor or operator) can only start when the unit
      // is inactive, so no concurrent startup attempt can reuse or overwrite
      // `server` before this catch executes. The only other path touching the
      // server is stop(), reached only from the SIGTERM/SIGINT shutdown
      // handler (chunk 16), which is not a startup path.
      try { server.close(() => {}); } catch { /* already closed */ }
      if (STARTUP_STATE_DIR) {
        const identified = attachStartupIdentity(err, startupRequestId, startupWindowStart);
        logStartupEvent('startup-listen-failed', { requestId: startupRequestId, windowStart: startupWindowStart, detail: formatRejectionValue(identified) });
        throw identified;
      }
      throw err;
    }
    // Rev 4.9 §5 (Type=notify): send READY=1 only after the startup
    // readiness check, startup sweep/replay/reconciliation, and successful
    // server.listen() have completed — and BEFORE the counter reset and
    // the startup-recovery-succeeded log, so a notification failure is
    // never mislabelled as a successful recovery. On failure the listener
    // is closed and startup fails (the CLI entry decides the exit code);
    // the counter is NOT reset, so the attempt stays counted and the
    // supervisor can re-arm. The notification is attempted only when
    // running under systemd (NOTIFY_SOCKET set); a plain/manual run has
    // no notification socket and skips silently.
    if (!notifySystemdReady()) {
      try { server.close(() => {}); } catch { /* already closed */ }
      if (STARTUP_STATE_DIR) {
        logStartupEvent('startup-service-ready-notify-failed', { requestId: startupRequestId, windowStart: startupWindowStart, detail: 'systemd-notify-ready-failed' });
      } else {
        console.error('[api-server] systemd READY notification failed');
      }
      throw new Error('systemd READY notification failed');
    }
    if (STARTUP_STATE_DIR) {
      // Reset ONLY after a successful listen() — never after validation alone.
      // Identity-checked (Blocker 1 + Rev 4.7 F5-20): the counter is deleted ONLY
      // when the stored state still belongs to THIS startup (same windowStart,
      // same attempts, same generation, no reservation held). A preserved reset
      // is NOT a failure — it means a newer attempt's state survived, which is
      // the correct outcome — and is logged as startup-recovery-reset-preserved
      // (info). startup-recovery-succeeded means the API IS LISTENING, not that
      // the counter was reset: the two outcomes stay distinguishable in the
      // journal (correction (g)).
      const reset = resetAttemptCounter({ requestId: startupRequestId, windowStart: startupWindowStart, attempts: startupAttempts, generation: startupGeneration });
      if (!reset.ok && reset.preserved) logStartupEvent('startup-recovery-reset-preserved', { requestId: startupRequestId, windowStart: startupWindowStart, detail: 'newer-attempt-state-survived', level: 'info' });
      else if (!reset.ok) logStartupEvent('startup-recovery-counter-unwritable', { requestId: startupRequestId, windowStart: startupWindowStart, detail: reset.reason });
      logStartupEvent('startup-recovery-succeeded', { requestId: startupRequestId, windowStart: startupWindowStart, level: 'info' });
    }
    // Independent timers (Rev 3.2 §B-3.2.7.2): a sweep failure does not
    // stop reconciliation, and vice versa. Unref'd: timers never hold
    // the process open on their own.
    // Timer diagnostics (Rev 4.8, chunk-16 review — chunk-15 §2; wording
    // narrowed Rev 4.8, chunk-17 review): rejection-value formatting cannot
    // throw — the only operation that could throw while reading or formatting
    // the rejection value goes through formatRejectionValue, which never throws
    // (Rev 4.7, F5-25). A promise may reject with a non-Error value, or an
    // Error-like object with a throwing message getter; either way the handler
    // cannot fail while reading or formatting the rejection value. The guarantee
    // covers the formatting step only — it does not extend to the diagnostic sink.
    const sweepIntervalMs = config.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    const reconcileIntervalMs = config.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    sweepTimer = setInterval(() => {
      sweep.runSweep({ reason: 'interval' }).catch((err) => {
        console.error('[api-server] sweep failed:', formatRejectionValue(err));
      });
    }, sweepIntervalMs);
    reconcileTimer = setInterval(() => {
      reconcile.runReconciliation({ source: 'timer' }).catch((err) => {
        console.error('[api-server] reconciliation failed:', formatRejectionValue(err));
      });
    }, reconcileIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
    return { host, port: server.address().port, mode };
  }

  async function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    dispatch.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    // Close the SQLite nonce store (only if this server owns it — a
    // test-injected store is the caller's to close).
    if (!config.nonceStore) {
      try { nonceStore.close(); } catch { /* ignore */ }
    }
  }

  return {
    config: { mode, host, port, dataDir, gatewayEnvironment, gatewayEnhancement },
    // Rev 4.8 §4.1: the activation state lives in a SEPARATE structure
    // from `config` — the gateway non-interference test asserts the
    // flags are NOT in api.config. Nothing here merges them into it.
    activation: {
      flags: { ...activationFlags },
      configPath: activationConfigPath,
      personalTokenId: ownerTokenConfigured ? ownerTokenId : null,
      ownerTokenConfigured,
      kaggleFloorHours,
      signingSecretPresent: signingSecret.length > 0,
      computeCapacity,
      appendAuditLog: (entry) => appendActivationAuditLog({
        logPath: config.activationAuditLogPath ?? ACTIVATION_AUDIT_LOG_PATH,
        ...entry,
      }),
    },
    manager,
    executor: legacyExecutor,
    storage,
    dispatch,
    sweep,
    reconcile,
    apiState,
    nonceStore,
    d1Client,
    gatewayPolicy,
    authorizationStore,
    gatewayClient,
    routeInventory,
    start,
    stop,
    get address() {
      return server ? server.address() : null;
    },
    // Operator surface (CLI-only, never HTTP — Rev 2 §11.6).
    fileReport: (executionId, report) => dispatch.fileReportForExecution(executionId, report),
    revokeSecret: ({ secret: s, revokedBy, reason }) => doRevokeSecret({
      apiState, managerStore: manager.store, secret: s, revokedBy, reason,
    }),
    manualResolve: (args) => reconcile.manualResolve(args),
    repairSceneSet: (jobId, args) => reconcile.repairSceneSet(jobId, args),
    runSweep: (args) => sweep.runSweep(args),
    runReconciliation: (args) => reconcile.runReconciliation(args),
  };
}

// CLI entry: `node gpu-cloud/src/api-server.js`. Env config only; no
// secrets are ever logged.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Common failure boundary (Rev 4.8, F5-43): createApiServer() AND start()
  // go through the SAME failure handler. A synchronous factory throw used to
  // escape via the uncaught-exception path without decideStartupFailureExit;
  // now it is caught, logged as startup-factory-failed, and given the same
  // exit decision as any other startup failure. A factory failure CAN and
  // always does occur after the preparation counter was incremented
  // (preparation runs before the API process starts, in every chain path), so
  // it consumes exactly one counted attempt and the next restart counts the
  // next one; at the limit the process exits 42 and does not restart. start() is declared async (chunk 14), so a throw from its body is already a rejected promise caught by .catch; the invocation is additionally wrapped in Promise.resolve().then(() => api.start()) (Rev 4.8, chunk-17 review — belt-and-braces: a synchronous throw from invoking start() itself becomes a rejection instead of escaping, if the declaration ever changes; the one-microtask deferral is harmless — the shutdown handlers are registered synchronously in the same tick, before the deferred invocation runs).
  // Log delivery before exit (Rev 4.5 finding): a bare process.exit() here
  // can truncate the pending asynchronous console output — the failure event
  // line may never reach journald. The exit is therefore taken via
  // process.exitCode (the process holds no timers or handles on this path — the
  // only listeners are the SIGTERM/SIGINT shutdown handlers, plain process
  // listeners that do not hold the loop open — so Node drains pending output
  // and exits with the code), with an unref'd 100 ms failsafe. The exit code is identical either way.
  const handleStartupFailure = (err) => {
    console.error('[api-server] failed to start:', formatRejectionValue(err));
    // Phase 5: the exit code is decided by the shared counter when the startup
    // protocol is active; otherwise the shipped exit 1. decideStartupFailureExit
    // cannot throw on the counter read or the decision (read failure -> 42, fail-closed). Exit-path resources (Rev 4.8, chunk-17 review): on every pre-listen failure path no server socket is open and no timer has started — readiness and internal-step failures happen before the server object is created (start() creates it only after the internal steps), a listen failure closes the server in its catch, a factory failure creates no server at all, and the sweep/reconcile timers start only after a successful listen(); the only registered listeners are the SIGTERM/SIGINT shutdown handlers (registered only on the start() path, inside if (api)), plain process listeners that do not hold the loop open — so the exitCode drain cannot be blocked by a leftover resource. §15 test (aa) gains the no-open-handle case.
    const code = STARTUP_STATE_DIR ? decideStartupFailureExit(err) : 1;
    process.exitCode = code;
    setTimeout(() => process.exit(code), 100).unref();
  };
  let api;
  try {
    api = createApiServer();
  } catch (err) {
    // Factory failure: the server object was never created, so there is no
    // start() to fail — but the attempt was already counted by preparation,
    // so the exit decision and the canonical event still apply. The identity
    // is unknown here (readiness runs inside start(), which never ran), so the
    // event carries requestId=none / windowStart=none; the counter state
    // decides the exit code. The error is normalised + identity-attached the
    // same way as every other startup failure (F5-42). The event detail is formatted with formatRejectionValue, not read as error.message (Rev 4.8, chunk-17 review — the required correction): normaliseError preserves an Error input unchanged and attachStartupIdentity may return that same object, so a throwing message getter would throw while building the detail, before handleStartupFailure is called — bypassing the common boundary.
    const error = attachStartupIdentity(normaliseError(err), null, null);
    if (STARTUP_STATE_DIR) logStartupEvent('startup-factory-failed', { requestId: null, windowStart: null, detail: formatRejectionValue(error) });
    handleStartupFailure(error);
  }
  if (api) {
    Promise.resolve().then(() => api.start()).then(({ host, port, mode }) => {
      console.log(`[api-server] listening on ${host}:${port} mode=${mode} version=${API_SERVER_VERSION}`);
    }).catch(handleStartupFailure);
    const shutdown = () => {
      api.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}
