// NOVA FreeLLMAPI — direct-Gemini fallback adapter (A4).
//
// Separate bounded adapter in the API server. It must NOT reuse or
// refactor netlify/functions/gemini.js or the _worker.js handler (A1).
// It mirrors gemini.js's PROVEN request shape (gemini-3.5-flash,
// maxOutputTokens 1500, thinkingLevel MINIMAL, 28 s timeout) and is used
// only when the gateway enhancement fails AND a Gemini credential exists
// in the API-server environment. With no credential the adapter is not
// created (factory returns null) and the chain shortens to the raw prompt.
// No credential or prompt fragment is ever included in an error.

export const DIRECT_GEMINI_MODEL = 'gemini-3.5-flash';
export const DIRECT_GEMINI_MODEL_IDENTITY = 'google/gemini-3.5-flash';
export const DIRECT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DIRECT_GEMINI_TIMEOUT_MS = 28000;

export class DirectGeminiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirectGeminiError';
  }
}

// Factory. Returns null when no API key is configured (fallback
// unavailable — the chain shortens to the raw prompt, which is correct
// behaviour, not an error).
export function createDirectGeminiAdapter({
  apiKey = '',
  baseUrl = DIRECT_GEMINI_BASE_URL,
  timeoutMs = DIRECT_GEMINI_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  const adapter = {
    model: DIRECT_GEMINI_MODEL,
    modelIdentity: DIRECT_GEMINI_MODEL_IDENTITY,
    async enhance(prompt) {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new DirectGeminiError('enhancement prompt is empty');
      }
      let res;
      let responseText;
      try {
        res = await fetchImpl(
          `${baseUrl}/v1beta/models/${DIRECT_GEMINI_MODEL}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                maxOutputTokens: 1500,
                thinkingConfig: { thinkingLevel: 'MINIMAL' },
              },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        responseText = await res.text();
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new DirectGeminiError('direct Gemini enhancement timed out');
        }
        throw new DirectGeminiError('direct Gemini enhancement request failed');
      }
      if (!res.ok) throw new DirectGeminiError('direct Gemini enhancement failed');
      let json;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new DirectGeminiError('direct Gemini enhancement response is not JSON');
      }
      // gemini.js's extraction shape: candidates[0].content.parts[].text.
      const parts = json?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new DirectGeminiError('direct Gemini enhancement response has no content');
      }
      const content = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
      if (content.length === 0) {
        throw new DirectGeminiError('direct Gemini enhancement response has no content');
      }
      return { content, reportedModel: null };
    },
  };
  return adapter;
}
