// NOVA Personal GPU Cloud — NOVA Cloud Storage: public exports.

export { NovaStorage, createStorage } from './engine.js';
export {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_DELIVERY_REF_TTL_MS,
  STAGING_MAX_AGE_MS,
  DELIVERY_REF_PREFIX,
  MANIFEST_FILE_NAME,
  writeObjectManifest,
  readObjectManifest,
  validateManifestRecord,
} from './engine.js';
export { LocalBackend } from './local-backend.js';
export { MetadataIndex, defaultIndexState, indexKey } from './metadata-index.js';
export { assertBackend, BACKEND_METHODS } from './backend-interface.js';
export { NAMESPACES, listNamespaces, isNamespace, assertNamespace } from './namespaces.js';
export {
  GENERATED_CONTENT_TTL_MS,
  RETENTION_POLICIES,
  resolveRetention,
  isExpired,
} from './retention.js';
export { sha256Hex, createHasher } from './hashing.js';
export {
  StorageError,
  StorageValidationError,
  NamespaceError,
  ObjectNotFoundError,
  IntegrityError,
  CapacityError,
  DeliveryRefError,
  ChunkNotFoundError,
} from './errors.js';
