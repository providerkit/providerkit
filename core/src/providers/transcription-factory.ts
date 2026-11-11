// The transcription twin of `createSpeechProvider`: name a preset, hand over a key, get a
// transcription provider. The preset row (`ProviderPreset.transcription`) picks the wire.
import {
  PROVIDER_PRESETS,
  TRANSCRIPTION_PRESET_IDS,
  type ProviderPreset,
  type ProviderPresetId,
} from "../presets.ts";
import type { Attribution } from "../attribution.ts";
import type { TranscriptionLimits, TranscriptionProvider } from "../transcription-core.ts";
import { createOpenAITranscriptionProvider } from "./openai-transcription.ts";
import type { FetchLike } from "../transport.ts";

export interface TranscriptionProviderConfig extends TranscriptionLimits, Attribution {
  apiKey: string;
  /** Absent: the preset's `transcription.defaultModel`. A preset without one needs this. */
  model?: string;
  /**
   * Replaces the preset's host, for a server that copies its route (Groq, a local Whisper
   * server, a proxy). The preset's default model is a fact about its own host, so it does not
   * follow you here: pass the `model`.
   */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Build a transcription provider for a preset that can transcribe. A preset without a
 * `transcription` row throws, naming the ones that do (`TRANSCRIPTION_PRESET_IDS`). Deepgram is
 * not a chat preset: `createDeepgramTranscriptionProvider` builds it.
 *
 * ```ts
 * const listen = createTranscriptionProvider("openai", { apiKey });
 * const { text } = await listen.transcribe({ audio: file });
 * ```
 */
export function createTranscriptionProvider(
  id: ProviderPresetId,
  config: TranscriptionProviderConfig,
): TranscriptionProvider {
  const preset: ProviderPreset = PROVIDER_PRESETS[id];
  const spec = preset.transcription;
  if (!spec) {
    throw new Error(
      `[providerkit] Preset "${id}" has no transcription endpoint. Presets that do: ${TRANSCRIPTION_PRESET_IDS.join(", ")}. Deepgram has its own: createDeepgramTranscriptionProvider.`,
    );
  }
  // A default is a fact about the host that documented it.
  const own = config.baseUrl === undefined;
  const model = config.model ?? (own ? spec.defaultModel : undefined);
  if (!model) {
    throw new Error(
      `[providerkit] Transcription on "${id}" has no default model${own ? "" : " for another host"}. Pass a model.`,
    );
  }
  const shared = {
    ...config,
    id,
    model,
    baseUrl: config.baseUrl ?? spec.baseUrl ?? preset.baseUrl,
  };
  switch (spec.shape) {
    case "openai":
      return createOpenAITranscriptionProvider(shared);
  }
}
