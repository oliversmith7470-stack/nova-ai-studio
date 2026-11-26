// NOVA Personal GPU Cloud — NOVA Cloud Storage: error types.
//
// Every failure mode the storage engine can report, as a distinct class so
// callers (and the GPU Manager, and the NOVA API in Stage 4) can tell a
// missing object from a corrupt one from a full disk without parsing
// strings. All carry a stable `code` for the same reason.

export class StorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StorageError';
    this.code = code ?? 'storage_error';
  }
}

// Caller-side mistake: bad namespace, bad retention option, bad TTL, bad
// source type. Nothing was stored.
export class StorageValidationError extends StorageError {
  constructor(message) {
    super(message, 'validation_error');
    this.name = 'StorageValidationError';
  }
}

// The namespace is not one of the six defined in namespaces.js.
export class NamespaceError extends StorageValidationError {
  constructor(namespace) {
    super(`unknown namespace: ${String(namespace)}`);
    this.name = 'NamespaceError';
    this.namespace = namespace;
  }
}

// The object does not exist in the namespace — or it expired. `reason` is
// 'missing' or 'expired'; callers that care (the delivery flow) read it.
export class ObjectNotFoundError extends StorageError {
  constructor(namespace, objectId, reason = 'missing') {
    super(`object not found: ${namespace}/${objectId} (${reason})`, 'object_not_found');
    this.name = 'ObjectNotFoundError';
    this.namespace = namespace;
    this.objectId = objectId;
    this.reason = reason;
  }
}

// A stored chunk's bytes do not match its recorded hash, or a chunk is
// missing from the backend. Corruption is DETECTED and reported — never
// silently served.
export class IntegrityError extends StorageError {
  constructor(namespace, objectId, chunkIndex, detail) {
    super(
      `integrity check failed: ${namespace}/${objectId} chunk ${chunkIndex} (${detail})`,
      'integrity_error',
    );
    this.name = 'IntegrityError';
    this.namespace = namespace;
    this.objectId = objectId;
    this.chunkIndex = chunkIndex;
  }
}

// The backend has no room for the object (disk full / quota exceeded), or
// the capacity probe reports less free space than the object needs. The
// put is refused whole — no partial object is left in the index.
export class CapacityError extends StorageError {
  constructor(message) {
    super(message, 'capacity_exceeded');
    this.name = 'CapacityError';
  }
}

// A delivery reference is unknown, expired, or out of redemptions. `reason`
// is 'unknown' | 'expired' | 'exhausted'.
export class DeliveryRefError extends StorageError {
  constructor(reason) {
    super(`delivery reference ${reason}`, 'delivery_ref_error');
    this.name = 'DeliveryRefError';
    this.reason = reason;
  }
}

// A chunk the backend was asked for is not there. The engine translates
// this into an IntegrityError at the object level (a missing chunk means
// the object cannot be served whole).
export class ChunkNotFoundError extends StorageError {
  constructor(namespace, objectId, chunkIndex) {
    super(
      `chunk not found: ${namespace}/${objectId} chunk ${chunkIndex}`,
      'chunk_not_found',
    );
    this.name = 'ChunkNotFoundError';
    this.namespace = namespace;
    this.objectId = objectId;
    this.chunkIndex = chunkIndex;
  }
}
