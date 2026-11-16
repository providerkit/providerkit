// Explicit opt-in: plain chat imports no hosted encoder or parser.
import { anthropicHosted } from "./hosted/anthropic.ts";
import { geminiHosted } from "./hosted/gemini.ts";
import { openaiHosted } from "./hosted/openai.ts";
import { responsesHosted } from "./hosted/responses.ts";
import {
  anthropicMessages,
  anthropicProvider,
  type AnthropicConfig,
} from "./providers/anthropic.ts";
import { geminiContents, geminiProvider, type GeminiConfig } from "./providers/gemini.ts";
import { openaiProvider, type OpenAIConfig } from "./providers/openai.ts";
import { responsesProvider, type ResponsesConfig } from "./providers/responses.ts";
import {
  presetProvider,
  buildPresetAdapter,
  type PresetProviderConfig,
  type PresetAdapterConfig,
} from "./providers/factory.ts";
import { configuredFallbacks, type ProviderFallbackConfig } from "./fallback.ts";
import type { HostedCodecs } from "./providers/hosted-codecs.ts";
import type { ProviderPresetId } from "./presets.ts";
import type { ChatMessage, Provider } from "./types.ts";
import { providerRegistry, type Registry, type RegistryOptions } from "./registry.ts";

export * from "./hosted/types.ts";
export { hostedRefused, planHostedTools } from "./hosted/shared.ts";
export type {
  AnthropicConfig,
  GeminiConfig,
  OpenAIConfig,
  ResponsesConfig,
  PresetProviderConfig,
  PresetAdapterConfig,
};

const codecs: HostedCodecs = {
  anthropic: anthropicHosted,
  gemini: geminiHosted,
  openai: openaiHosted,
  responses: responsesHosted,
};

/** An Anthropic provider with hosted tools and paused-turn continuation. */
export function createAnthropicProvider(config: AnthropicConfig): Provider {
  return anthropicProvider(config, codecs);
}

/** A Gemini provider with built-in tools, grounding and replay. */
export function createGeminiProvider(config: GeminiConfig): Provider {
  return geminiProvider(config, codecs);
}

/** A Chat Completions provider with hosted search and citations. */
export function createOpenAIProvider(config: OpenAIConfig): Provider {
  return openaiProvider(config, codecs);
}

/** A Responses provider with hosted tools and generated images. */
export function createResponsesProvider(config: ResponsesConfig): Provider {
  return responsesProvider(config, codecs);
}

/** A preset provider whose model chain and preset fallbacks also opt in. */
export function createPresetProvider(id: ProviderPresetId, config: PresetProviderConfig): Provider {
  return presetProvider(id, config, codecs);
}

/** One bare preset adapter with hosted tools, without a pool or watchdog. */
export function presetAdapter(id: ProviderPresetId, config: PresetAdapterConfig): Provider {
  return buildPresetAdapter(id, config, codecs);
}

/** Opt preset fallback specs in. Hand-built providers keep their own setup. */
export function withConfiguredFallbacks(
  primary: Provider,
  config?: ProviderFallbackConfig,
): Provider {
  return configuredFallbacks(primary, config, codecs);
}

/** A registry whose connections, key rotation and token refresh keep the opt-in. */
export function createRegistry(options: RegistryOptions): Registry {
  return providerRegistry(options, codecs);
}

/** Convert history with Anthropic's hosted replay records. */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  provider = "anthropic",
): ReturnType<typeof anthropicMessages> {
  return anthropicMessages(messages, provider, codecs.anthropic.replay);
}

/** Convert history with Gemini's hosted replay records. */
export function toGeminiContents(
  messages: readonly ChatMessage[],
  provider?: string,
): ReturnType<typeof geminiContents> {
  return geminiContents(messages, provider, codecs.gemini.replay);
}
