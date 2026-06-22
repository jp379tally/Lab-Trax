/**
 * Shared OpenAI client factory for the AI assistant surfaces.
 *
 * Centralises how the server constructs an OpenAI client from the
 * `AI_INTEGRATIONS_OPENAI_API_KEY` (and optional `AI_INTEGRATIONS_OPENAI_BASE_URL`)
 * environment so a future change to client construction is made in one place
 * instead of being copied into each route. `getAiClient()` returns a cached
 * singleton for hot paths like the agentic chat loop; `createOpenAIClient()`
 * builds a fresh client for callers that need per-call construction.
 *
 * Both return `null` when no API key is configured so callers can degrade
 * gracefully (e.g. respond 503 or fall back to a template).
 */

import OpenAI from "openai";

/**
 * Build a fresh OpenAI client, or `null` when no API key is configured.
 *
 * Must include `baseURL` when using the Replit AI Integrations proxy — the key
 * is a proxy credential that only works against `AI_INTEGRATIONS_OPENAI_BASE_URL`,
 * not directly against api.openai.com.
 */
export function createOpenAIClient(): OpenAI | null {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

let _cachedOpenAI: OpenAI | null | undefined;

/**
 * Return a cached OpenAI client singleton, or `null` when no API key is
 * configured. The result (including `null`) is memoised for the lifetime of the
 * module, so a key change requires a process/module reset to take effect.
 */
export function getAiClient(): OpenAI | null {
  if (_cachedOpenAI !== undefined) return _cachedOpenAI;
  _cachedOpenAI = createOpenAIClient();
  return _cachedOpenAI;
}
