// Phase 6 Optimisation — public entry point.
//
// Re-exports the Phase 6 modules. Nothing here registers an executor,
// wires a worker into the API server, or changes any Phase 5 behaviour:
// the modules are standalone components, tested with fakes, ready for
// future registration only under a separate owner authorisation.
//
// All feature flags default OFF (see config.js); the FP16 Run 10
// configuration is the only baseline.
export * from './resource-profiles.js';
export * from './config.js';
export * from './persistent-worker.js';
export * from './chunked-decode.js';
export * from './throughput.js';
export * from './benchmark.js';
