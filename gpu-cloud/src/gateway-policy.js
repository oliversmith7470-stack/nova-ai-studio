// NOVA FreeLLMAPI — gateway policy: environment classification and the
// production-aware dispatch resolver.
//
// The resolver is the design's A5 `effectivePrompt(job, policy)` verbatim
// (approved v5 design). The environment comes from trusted server
// configuration only — never from the submit request, a client-supplied
// field, or job metadata. Production jobs always use the original prompt;
// sandbox jobs require a valid revocable owner-authorization checked
// server-side.

import { AUTHORIZATION_OPERATION } from './gateway-authorization.js';

export class InvalidJobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidJobError';
  }
}

export const GATEWAY_ENVIRONMENTS = Object.freeze(['production', 'sandbox', 'development', 'test']);

export function effectivePrompt(job, policy) {
  // The environment comes from trusted server configuration,
  // never from the submit request or a client-supplied field.
  if (policy.environment === 'production') {
    if (job.promptSource === 'enhanced') {
      throw new InvalidJobError(
        'Gateway-enhanced prompts are prohibited in production',
      );
    }
    return job.prompt;
  }

  if (
    policy.environment === 'sandbox'
    && !policy.hasValidOwnerAuthorization(job)
  ) {
    throw new InvalidJobError(
      'Sandbox prompt enhancement is not authorized',
    );
  }

  return job.promptSource === 'enhanced'
    && typeof job.enhancedPrompt === 'string'
    && job.enhancedPrompt.length > 0
      ? job.enhancedPrompt
      : job.prompt;
}

// Build the policy object the resolver and the submit/dispatch paths share.
// `authorizationStore` is the AuthorizationStore; `now` is an injectable
// clock (tests use a fixed time). The policy adapts the job shape: a
// D1-derived record carries its trusted id in `job.id`; a manager job
// carries its D1 parent-job id in `job.params.jobId` and its
// server-created authorization reference in `job.sandboxAuthorizationId`.
export function buildGatewayPolicy({
  environment = 'production',
  environmentId = 'nova-api',
  projectId = 'nova-ai-studio',
  ownerId = 'nova-owner',
  authorizationStore = null,
  component = 'api-server',
} = {}) {
  if (!GATEWAY_ENVIRONMENTS.includes(environment)) {
    throw new Error(`unknown gateway environment: ${environment}`);
  }
  const policy = {
    environment,
    environmentId,
    projectId,
    ownerId,
    component,
    hasValidOwnerAuthorization(job) {
      if (!authorizationStore) return false;
      const jobId = job?.params?.jobId ?? job?.id ?? null;
      const sandboxAuthorizationId = job?.sandboxAuthorizationId ?? null;
      // The store owns the clock (its `now`); validation always reads
      // the live records file, so revocation is visible immediately.
      return authorizationStore.validate(
        { jobId, sandboxAuthorizationId },
        { environmentId, projectId, ownerId },
      );
    },
    // Server-side lookup of the authorization record covering a job, used
    // at intake to attach the server-created sandboxAuthorizationId.
    // Returns the record or null. Never reads a caller-supplied value.
    findAuthorizationForJob(jobId) {
      if (!authorizationStore) return null;
      return authorizationStore.findForJob(jobId, { projectId, environmentId });
    },
  };
  // The operation the policy authorizes is fixed by the design.
  policy.operation = AUTHORIZATION_OPERATION;
  return policy;
}
