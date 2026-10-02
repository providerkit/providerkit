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
import type { Effort, Provider, ServiceTier } from "../types.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";

export interface PresetProviderConfig extends ProviderFallbackConfig {
  /** The credential: an API key for `key`/`bearer` presets, an ACCESS TOKEN
   *  for `oauth` ones. `@providerkit/core/auth` signs in and renews it. */
  apiKey: string;
  /** Which model to run. Absent = the preset's `defaultModel`; a preset
   *  without either throws rather than sending a request nobody chose. */
  model?: string;
  /** A model chain on this one endpoint and key: the first answers, the rest
   *  take over in order when it fails (quota, rate, outage). Wins over `model`
   *  and the preset's `rotation`; `fallbacks` still run after the chain. */
  models?: readonly string[];
  /** Replaces the preset's API root. For a vendor that gives each account its
   *  own host (Copilot: `credential.baseUrl` from the sign-in). */
  baseUrl?: string;
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
  /** Default `service_tier` for every call on the OpenAI and Responses shapes;
   *  `StreamOptions.serviceTier` wins. Anthropic and Gemini presets refuse it. */
  serviceTier?: ServiceTier;
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
  const chain = config.models?.length ? config.models : config.model ? undefined : preset.rotation;
  if (chain && chain.length > 1) {
    const { models: _models, fallbacks = [], ...single } = config;
    return createPresetProvider(id, {
      ...single,
      model: chain[0],
      fallbacks: [
        ...chain.slice(1).map((model) => ({ ...single, preset: id, model })),
        ...fallbacks,
      ],
    });
  }
  const model = chain?.[0] ?? config.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(`[providerkit] Preset "${id}" has no defaultModel — pass a model.`);
  }
  if (config.serviceTier && (preset.shape === "anthropic" || preset.shape === "gemini")) {
    throw new Error(
      `[providerkit] Preset "${id}" speaks the ${preset.shape} shape, which has no service tier. ` +
        "Remove serviceTier.",
    );
  }
  const headers = { ...preset.headers, ...config.headers };
  const baseUrl = config.baseUrl ?? preset.baseUrl;
  const maxTokens = config.maxTokens ?? preset.maxTokens;

  const {
    fallbacks: _fallbacks,
    fallbackOptions: _fallbackOptions,
    watchdog: _watchdog,
    models: _models,
    ...baseConfig
  } = config;

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
        maxTokens,
        baseUrl,
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
        maxTokens,
        baseUrl,
        ...(preset.path ? { path: preset.path } : {}),
        headers,
        ...(config.providerOrder ? { providerOrder: config.providerOrder } : {}),
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        ...(preset.initiatorHeader ? { initiatorHeader: true } : {}),
        fetchImpl: config.fetchImpl,
      });
      break;
    case "responses":
      provider = createResponsesProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens,
        baseUrl,
        ...(preset.path ? { path: preset.path } : {}),
        id,
        headers,
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        ...(preset.imageLimits ? { imageLimits: preset.imageLimits } : {}),
        ...(preset.replayReasoning ? { replayReasoning: true } : {}),
        fetchImpl: config.fetchImpl,
      });
      break;
    case "gemini":
      provider = createGeminiProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        baseUrl,
        id,
        headers,
        fetchImpl: config.fetchImpl,
      });
      break;
  }

  return withConfiguredFallbacks(provider, config);
}
