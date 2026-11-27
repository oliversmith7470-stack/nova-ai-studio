// NOVA FreeLLMAPI — gateway client (VM-local only).
//
// Approved v5 design §5 (loopback enforcement, credential protections),
// A3 (named proven models only, provider-qualified colon pins),
// A4 (validation boundary, 1 MiB bounded streaming read), §10 (readiness
// check + shared unify-overrides specification).
//
// The client never logs Authorization headers, never exposes the unified
// key, and never includes credentials or prompt contents in exceptions.
// Every failure degrades to the caller (throw a fixed-message
// GatewayEnhancementError); the caller falls through to the direct-Gemini
// fallback or the raw prompt.

export const GATEWAY_DEFAULT_BASE_URL = 'http://127.0.0.1:3001';

// The only approved text models, in provider-qualified colon form (A3).
// Bare ids, slash forms, "auto", and OVH are rejected at construction.
export const APPROVED_TEXT_MODELS = Object.freeze([
  'google:gemini-3.5-flash-lite',
  'groq:qwen/qwen3.8-27b',
]);

// Expected X-Routed-Via value per approved pin (platform/model form).
export const EXPECTED_ROUTED_VIA = Object.freeze({
  'google:gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
  'groq:qwen/qwen3.8-27b': 'groq/qwen/qwen3.8-27b',
});

export const GATEWAY_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB (A4)
export const GATEWAY_DEFAULT_TIMEOUT_MS = 30000; // 30 s (A4)
export const GATEWAY_MAX_TOKENS = 1024; // response budget for an enhancement (<= 4,000 chars)

// Platforms with an operator-held usable key (verified: google + groq
// proven live; huggingface key present). Any other platform prefix is
// treated as keyless for the readiness-override evaluation.
export const KEYED_PLATFORMS = Object.freeze(['google', 'groq', 'huggingface']);

export const ENHANCEMENT_INSTRUCTION =
  'Rewrite the following video generation prompt for the LTX video engine. '
  + 'Keep the same subject, intent, and content; make it concrete and '
  + 'structured for the engine. Return only the rewritten prompt, nothing else.\n\nPrompt: ';

export class GatewayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

export class GatewayEnhancementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayEnhancementError';
  }
}

// Loopback validation (NOVA-14). Scheme must be exactly http; hostname
// (lowercased, brackets stripped, one trailing dot removed) must be a
// literal loopback IP (127.0.0.1 or ::1). `localhost` is rejected in ALL
// configurations in this implementation — a deliberate fail-closed
// tightening vs the design's resolve-and-pin allowance for local
// experiments (see the impl spec §11); local experiments use 127.0.0.1.
// No username/password; port 1-65535 (default 3001); path empty or '/';
// no query or fragment.
export function validateGatewayBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayConfigError('gateway base URL is not a valid URL');
  }
  if (url.protocol !== 'http:') throw new GatewayConfigError('gateway base URL must use http');
  if (url.username !== '' || url.password !== '') throw new GatewayConfigError('gateway base URL must not contain credentials');
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost') throw new GatewayConfigError('gateway base URL must use a literal loopback IP, not localhost');
  if (host !== '127.0.0.1' && host !== '::1') throw new GatewayConfigError('gateway base URL must be a loopback address');
  const port = url.port === '' ? 3001 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GatewayConfigError('gateway base URL port is invalid');
  if (url.pathname !== '' && url.pathname !== '/') throw new GatewayConfigError('gateway base URL path must be empty or /');
  if (url.search !== '' || url.hash !== '') throw new GatewayConfigError('gateway base URL must not contain a query or fragment');
  return { baseUrl: `http://${host === '::1' ? '[::1]' : host}:${port}`, host, port };
}

export function validateGatewayModel(model) {
  if (!APPROVED_TEXT_MODELS.includes(model)) {
    throw new GatewayConfigError('gateway text model must be an approved colon-form pin');
  }
  return model;
}

// Factory. Returns null (disabled client) when no API key is configured —
// a missing key disables the gateway client and the enhancement chain
// falls through (§5). Throws GatewayConfigError on an invalid base URL
// or a non-allowlisted model, before any HTTP attempt.
export function createGatewayClient({
  baseUrl = GATEWAY_DEFAULT_BASE_URL,
  apiKey = '',
  model = APPROVED_TEXT_MODELS[0],
  timeoutMs = GATEWAY_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  const { baseUrl: normalized } = validateGatewayBaseUrl(baseUrl);
  validateGatewayModel(model);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayConfigError('gateway timeout must be a positive integer (ms)');
  }
  const expectedRoutedVia = EXPECTED_ROUTED_VIA[model];
  const client = {
    baseUrl: normalized,
    model,
    timeoutMs,
    // One enhancement attempt. No retries: the gateway already fails over
    // internally within the pinned platform (A4). Returns
    // { content, routedVia, reportedModel } or throws GatewayEnhancementError
    // with a fixed message (never a prompt or credential fragment).
    async enhance(prompt) {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new GatewayEnhancementError('enhancement prompt is empty');
      }
      let res;
      try {
        res = await fetchImpl(`${normalized}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: ENHANCEMENT_INSTRUCTION + prompt }],
            max_tokens: GATEWAY_MAX_TOKENS,
          }),
          redirect: 'manual', // redirects are prohibited; a 3xx is a failure
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new GatewayEnhancementError('gateway enhancement timed out');
        }
        throw new GatewayEnhancementError('gateway enhancement request failed');
      }
      if (res.status >= 300 && res.status < 400) {
        throw new GatewayEnhancementError('gateway enhancement refused (redirect)');
      }
      if (res.status !== 200) {
        throw new GatewayEnhancementError('gateway enhancement failed');
      }
      // Bounded streaming read: reject and close before JSON parsing as
      // soon as the 1 MiB cap is exceeded; never buffer unbounded input.
      const routedVia = res.headers?.get?.('x-routed-via') ?? null;
      let text;
      try {
        text = await readBoundedText(res, GATEWAY_MAX_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof GatewayEnhancementError) throw err;
        throw new GatewayEnhancementError('gateway enhancement response unreadable');
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new GatewayEnhancementError('gateway enhancement response is not JSON');
      }
      // Strict response shape (same strictness as the NEXORA provider).
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new GatewayEnhancementError('gateway enhancement response has no content');
      }
      const reportedModel = typeof json?.model === 'string' && json.model.length > 0 ? json.model : null;
      // Upstream verification (NOVA-03, cross 4.2): the exact verified
      // X-Routed-Via must equal the expected pinned platform AND model.
      // A platform match alone is insufficient; missing/malformed/
      // mismatched upstream identity discards the enhancement.
      if (typeof routedVia !== 'string' || routedVia !== expectedRoutedVia) {
        throw new GatewayEnhancementError('gateway enhancement upstream unverified');
      }
      return { content, routedVia, reportedModel };
    },
  };
  return client;
}

async function readBoundedText(res, maxBytes) {
  // Prefer the Web ReadableStream when present (node fetch); fall back to
  // .text() for stub responses in tests (which are small by construction).
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new GatewayEnhancementError('gateway enhancement response exceeds size limit');
    }
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new GatewayEnhancementError('gateway enhancement response exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// -- readiness check (§10, shared specification) ---------------------------
//
// A REAL call per approved pin (not a dashboard read) plus the unify
// overrides evaluation. `getOverrides` supplies the gateway's
// model_unify_overrides setting value (parsed JSON, or null when unset);
// the operator script reads it from the gateway DB. Returns
// { ok, checks: [{ name, ok, reason? }] }.

const APPROVED_GROUP_TOKENS = Object.freeze(['gemini-3.5-flash-lite', 'qwen3.8-27b', 'qwen/qwen3.8-27b']);

function memberPlatform(member) {
  const idx = member.indexOf(':');
  return idx === -1 ? null : member.slice(0, idx).toLowerCase();
}

function isApprovedKeyedMember(member) {
  return Object.keys(EXPECTED_ROUTED_VIA).some((pin) => {
    const [platform, modelId] = pin.split(':');
    return member === `${platform}:${modelId}` || member === pin;
  });
}

function identifiesApprovedGroup(value) {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return APPROVED_GROUP_TOKENS.some((token) => lower.includes(token));
}

// Evaluate the shared unify-overrides specification. Fails when any
// override merges a keyless row into either approved group, splits an
// approved keyed row out of its expected group, or cannot be established
// as safe (fail closed). An absent/empty overrides value passes.
export function evaluateUnifyOverrides(overrides) {
  if (overrides === null || overrides === undefined) return { ok: true };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, reason: 'override-unrecognized' };
  }
  const { merges, splits } = overrides;
  if (!Array.isArray(merges) || !Array.isArray(splits)) {
    return { ok: false, reason: 'override-unrecognized' };
  }
  for (const merge of merges) {
    if (!merge || typeof merge !== 'object' || typeof merge.into !== 'string'
      || !Array.isArray(merge.keys) || merge.keys.some((k) => typeof k !== 'string')) {
      return { ok: false, reason: 'override-unrecognized' };
    }
    const intoApproved = identifiesApprovedGroup(merge.into);
    for (const key of merge.keys) {
      // An approved keyed row merged away from its own group.
      if (isApprovedKeyedMember(key) && !intoApproved) {
        return { ok: false, reason: 'keyed-row-merged-away' };
      }
      // A keyless row merged into an approved group. A key is provably
      // keyed only when it is an exact platform:model_id member id with
      // a keyed platform; anything else merged into an approved group
      // fails closed (a display-name key may match keyless rows).
      if (intoApproved) {
        const platform = memberPlatform(key);
        if (platform === null || !KEYED_PLATFORMS.includes(platform)) {
          return { ok: false, reason: 'keyless-merge' };
        }
      }
    }
  }
  for (const split of splits) {
    if (!split || typeof split !== 'object' || typeof split.member !== 'string') {
      return { ok: false, reason: 'override-unrecognized' };
    }
    // Splitting an approved keyed row out of its expected group.
    if (isApprovedKeyedMember(split.member)) {
      return { ok: false, reason: 'keyed-split' };
    }
  }
  return { ok: true };
}

export async function checkGatewayReadiness({
  baseUrl = GATEWAY_DEFAULT_BASE_URL,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  getOverrides = async () => null,
  timeoutMs = GATEWAY_DEFAULT_TIMEOUT_MS,
} = {}) {
  const checks = [];
  const fail = (name, reason) => {
    checks.push({ name, ok: false, reason });
    return { ok: false, checks };
  };
  // The readiness check runs against the loopback gateway only.
  try {
    validateGatewayBaseUrl(baseUrl);
  } catch {
    return fail('base-url', 'invalid-base-url');
  }
  // Real calls, one per approved pin.
  for (const model of APPROVED_TEXT_MODELS) {
    const name = `chat:${model}`;
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say the word mango and nothing else.' }],
          max_tokens: 10,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail(name, 'request-failed');
    }
    if (res.status !== 200) return fail(name, `http-${res.status}`);
    const routedVia = res.headers?.get?.('x-routed-via') ?? null;
    if (routedVia !== EXPECTED_ROUTED_VIA[model]) return fail(name, 'upstream-mismatch');
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return fail(name, 'response-not-json');
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) return fail(name, 'empty-content');
    checks.push({ name, ok: true });
  }
  // Unify overrides (shared specification, both conditions).
  let overrides;
  try {
    overrides = await getOverrides();
  } catch {
    return fail('unify-overrides', 'overrides-unreadable');
  }
  const evaluated = evaluateUnifyOverrides(overrides);
  if (!evaluated.ok) return fail('unify-overrides', evaluated.reason);
  checks.push({ name: 'unify-overrides', ok: true });
  return { ok: true, checks };
}
