// The speech twin of `createPresetProvider`: name a preset, hand over a key, get a
// speech provider. The preset row (`ProviderPreset.speech`) picks the wire.
import {
  PROVIDER_PRESETS,
  SPEECH_PRESET_IDS,
  type ProviderPreset,
  type ProviderPresetId,
} from "../presets.ts";
import type { Attribution } from "../attribution.ts";
import type { SpeechFormat, SpeechLimits, SpeechProvider } from "../speech-core.ts";
import { createGeminiSpeechProvider } from "./gemini-speech.ts";
import { createOpenAISpeechProvider } from "./openai-speech.ts";

export interface SpeechProviderConfig extends SpeechLimits, Attribution {
  apiKey: string;
  /** Absent: the preset's `speech.defaultModel`. A preset without one needs this. */
  model?: string;
  /** Used when a call names no voice. Absent: the preset's `speech.defaultVoice`. */
  voice?: string;
  /** Used when a call names no format. Absent: the preset's `speech.defaultFormat`, else "wav". */
  format?: SpeechFormat;
  /**
   * Replaces the preset's host, for a server that copies its route (a local speech
   * server behind the `openai` preset, a proxy). The preset's default model, voice,
   * format and text limit are facts about its own host, so they do not follow you
   * here: pass the `model`, and a `voice` unless every call names one.
   */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** The `google` preset only: caps the audio tokens generated. Refused on a wire that has no such field. */
  maxOutputTokens?: number;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a speech provider for a preset that can speak. A preset without a
 * `speech` row throws, naming the ones that do (`SPEECH_PRESET_IDS`).
 *
 * ```ts
 * const speech = createSpeechProvider("google", { apiKey });
 * const { bytes, mimeType } = await speech.synthesize({ text: "Click Settings." });
 * ```
 */
export function createSpeechProvider(
  id: ProviderPresetId,
  config: SpeechProviderConfig,
): SpeechProvider {
  const preset: ProviderPreset = PROVIDER_PRESETS[id];
  const spec = preset.speech;
  if (!spec) {
    throw new Error(
      `[providerkit] Preset "${id}" has no speech endpoint. Presets that do: ${SPEECH_PRESET_IDS.join(", ")}.`,
    );
  }
  // A default is a fact about the host that documented it.
  const own = config.baseUrl === undefined;
  const model = config.model ?? (own ? spec.defaultModel : undefined);
  if (!model) {
    throw new Error(
      `[providerkit] Speech on "${id}" has no default model${own ? "" : " for another host"}. Pass a model.`,
    );
  }
  const shared = {
    ...config,
    id,
    model,
    baseUrl: config.baseUrl ?? spec.baseUrl ?? preset.baseUrl,
    voice: config.voice ?? (own ? spec.defaultVoice : undefined),
    format: config.format ?? (own ? spec.defaultFormat : undefined),
    maxInputChars: config.maxInputChars ?? (own ? spec.maxInputChars : undefined),
  };
  switch (spec.shape) {
    case "openai": {
      if (config.maxOutputTokens !== undefined) {
        throw new Error(
          `[providerkit] Speech on "${id}" uses the openai shape, which has no maxOutputTokens. Remove it.`,
        );
      }
      return createOpenAISpeechProvider(shared);
    }
    case "gemini":
      return createGeminiSpeechProvider(shared);
  }
}
