// NOVA Personal GPU Cloud — public exports (Stage 1 + Stage 2).

export {
  EngineRegistry,
  ENGINE_DEFINITIONS,
  ENGINE_STATUSES,
  PRODUCTION_ENGINE_ID,
} from './engines.js';
export {
  FUN_INP_ENGINE_ID,
  FUN_INP_REPOS,
  FUN_INP_PROOF,
  FUN_INP_INTERFACE,
  buildJobSpec,
  buildConditioning,
  validateSpec,
} from './engines/fun-inp.js';
export { GpuManager, QueueFullError } from './gpu-manager.js';
export {
  createJob,
  transition,
  isTerminal,
  startedClockAt,
  JOB_TYPES,
  JOB_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  DEFAULT_TIMEOUTS_MS,
  DEFAULT_MIN_VRAM_GB,
  DEFAULT_ESTIMATED_SECONDS,
  JobValidationError,
  JobTransitionError,
} from './job.js';
export { JsonStore, defaultState } from './store.js';
export {
  ProviderRegistry,
  PROVIDER_DEFINITIONS,
  PROVIDER_KINDS,
  providerSupports,
  estimateCostUsd,
} from './providers.js';
export { MockProvider } from './mock-provider.js';
export { queuedJobs, queueDepth, nextJob } from './queue.js';
export {
  createReservation,
  releaseReservation,
  activeReservationForJob,
  committedUsd,
} from './reservations.js';
export {
  engageKillSwitch,
  disengageKillSwitch,
  isEngaged,
} from './kill-switch.js';
export { reconcileReports, findUnreportedJobs } from './reconcile.js';
export { createGpuCloud, fileReport, DEFAULT_STORAGE_ROOT_DIR } from './setup.js';
export {
  NovaStorage,
  createStorage,
  LocalBackend,
  MetadataIndex,
  NAMESPACES,
  listNamespaces,
  isNamespace,
  assertNamespace,
  GENERATED_CONTENT_TTL_MS,
  RETENTION_POLICIES,
  resolveRetention,
  isExpired,
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_DELIVERY_REF_TTL_MS,
  DELIVERY_REF_PREFIX,
  StorageError,
  StorageValidationError,
  NamespaceError,
  ObjectNotFoundError,
  IntegrityError,
  CapacityError,
  DeliveryRefError,
  ChunkNotFoundError,
} from './storage/index.js';
export {
  checkStage2Safe,
  assertStage2Safe,
  DataBoundaryError,
  FORBIDDEN_PARAM_KEYS,
  CREDENTIAL_PATTERNS,
  SYNTHETIC_IMAGE,
} from './data-guard.js';
export {
  HoursTracker,
  weekStartMs,
  syncBudgetStatus,
  MS_PER_HOUR,
  MS_PER_WEEK,
  DEFAULT_WEEK_START_DAY,
} from './hours.js';
export {
  STAGING_MANIFESTS,
  PROOF_MODEL_ID,
  getStagingManifest,
  manifestTotalBytes,
  runPreparationTest,
  buildNotebook,
  CHECK_ENV_PY,
} from './staging.js';
export { BaseExecutor } from './executor-base.js';
export {
  KaggleExecutor,
  KAGGLE_PROVIDER_ID,
  KAGGLE_WEIGHTS_DATASET_SLUG,
} from './kaggle-executor.js';
export { ColabExecutor, COLAB_PROVIDER_ID } from './colab-executor.js';
