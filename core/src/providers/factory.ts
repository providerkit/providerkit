// The one-line switch: resolve a preset id into a wired provider.
//
// Consumers used to write their own switch over providers — the same
// dispatch, re-derived per codebase, each quietly accumulating dialect
// knowledge (which gateway takes Bearer, which needs the thinking marker).
// The presets table + this factory is that dispatch, said once: a caller
// names an id and hands over a credential, and the header style, endpoint
// and adapter come from the table.
//
// `effort` passes through to the adapter unchanged — the per-endpoint
// thinking dialects (Z.ai's explicit disabled marker, OpenRouter's floors)
// are the adapters' knowledge, and this factory must not re-derive them.
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createResponsesProvider } from "./responses.ts";
import { PRESET_IDS, PROVIDER_PRESETS, type ProviderPreset, type ProviderPresetId } from "../presets.ts";
import type { Effort, Provider } from "../types.ts";

export interface PresetProviderConfig {
  /** The credential: an API key for `key`/`bearer` presets, an ACCESS TOKEN
   *  for `oauth` ones. Acquiring the token is the caller's job. */
  apiKey: string;
  /** Which model to run. Absent = the preset's `defaultModel`; a preset
   *  without either throws rather than sending a request nobody chose. */
  model?: string;
  effort?: Effort;
  /** Output ceiling. The Anthropic shape requires one; adapters default it. */
  maxTokens?: number;
  /** Per-request headers (request ids, `ChatGPT-Account-Id`) on top of the
   *  preset's static protocol headers. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function createPresetProvider(id: ProviderPresetId, config: PresetProviderConfig): Provider {
  // The table is closed (`satisfies`), but a caller may hold an id as a plain
  // string — validate rather than index into undefined.
  if (!(id in PROVIDER_PRESETS)) {
    throw new Error(
      `[providerkit] Unknown provider preset "${id}". Valid ids: ${PRESET_IDS.join(", ")}`,
    );
  }
  const preset: ProviderPreset = PROVIDER_PRESETS[id];
  const model = config.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(`[providerkit] Preset "${id}" has no defaultModel — pass a model.`);
  }
  const headers = { ...preset.headers, ...config.headers };

  switch (preset.shape) {
    case "anthropic":
      // `key` rides Anthropic's native x-api-key; coding plans and OAuth
      // tokens read Bearer (measured across the family's coding endpoints).
      return createAnthropicProvider({
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        baseUrl: preset.baseUrl,
        id,
        headers,
        bearer: preset.auth !== "key",
        // The endpoint's thinking dialect rides the table (zai: silence means
        // the model default, which is ON — "none" must be said out loud).
        ...(preset.explicitNone ? { explicitNone: true } : {}),
        fetchImpl: config.fetchImpl,
      });
    case "openai":
      return createOpenAIProvider({
        id,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        baseUrl: preset.baseUrl,
        headers,
        fetchImpl: config.fetchImpl,
      });
    case "responses":
      return createResponsesProvider({
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        baseUrl: preset.baseUrl,
        id,
        headers,
        fetchImpl: config.fetchImpl,
      });
    case "gemini":
      return createGeminiProvider({
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        baseUrl: preset.baseUrl,
        id,
        headers,
        fetchImpl: config.fetchImpl,
      });
  }
}
