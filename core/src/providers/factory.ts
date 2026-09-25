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
import {
  PRESET_IDS,
  PROVIDER_PRESETS,
  type ProviderPreset,
  type ProviderPresetId,
} from "../presets.ts";
import type { Effort, Provider } from "../types.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";

export interface PresetProviderConfig extends ProviderFallbackConfig {
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
  /**
   * App attribution for OpenRouter's rankings — the site URL rides as
   * `HTTP-Referer`, the app name as `X-Title`. Public, not secret. Sent on
   * the OpenAI-compatible and Anthropic shapes (OpenRouter reads them for app
   * attribution); the Gemini and Responses shapes ignore them. An explicit
   * entry in `headers` always wins.
   */
  siteUrl?: string;
  /**
   * App name for OpenRouter's rankings, sent as `X-Title`. See `siteUrl`.
   */
  siteName?: string;
  /** OpenRouter-only: preferred upstream hosts, in order. OpenRouter's cache
   *  lives on the upstream host's account and default routing hops hosts
   *  between rounds — pinning keeps a conversation's rounds (and their cache)
   *  on one host. Empty/absent = default routing. */
  providerOrder?: string[];
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

  const { fallbacks: _fallbacks, fallbackOptions: _fallbackOptions, ...baseConfig } = config;

  let provider: Provider;
  switch (preset.shape) {
    case "anthropic":
      // `key` rides Anthropic's native x-api-key; coding plans and OAuth
      // tokens read Bearer (measured across the family's coding endpoints).
      provider = createAnthropicProvider({
        ...baseConfig,
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
      break;
    case "openai":
      provider = createOpenAIProvider({
        ...baseConfig,
        id,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        baseUrl: preset.baseUrl,
        ...(preset.path ? { path: preset.path } : {}),
        headers,
        ...(config.providerOrder ? { providerOrder: config.providerOrder } : {}),
        fetchImpl: config.fetchImpl,
      });
      break;
    case "responses":
      provider = createResponsesProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        baseUrl: preset.baseUrl,
        id,
        headers,
        fetchImpl: config.fetchImpl,
      });
      break;
    case "gemini":
      provider = createGeminiProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        baseUrl: preset.baseUrl,
        id,
        headers,
        fetchImpl: config.fetchImpl,
      });
      break;
  }

  return withConfiguredFallbacks(provider, config);
}
