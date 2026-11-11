// `@providerkit/core/transcription`: one recording to its text, the inverse of
// `@providerkit/core/speech`. It is its own entry point, and `index.ts` does not export it, so
// an app that only chats loads none of the transcription code.
//
// Named, not `export *`: transcription-core.ts also holds helpers the two wires share, and a
// helper exported here is one this package can never change without a major version.
export {
  DEFAULT_TRANSCRIPTION_LIMITS,
  TranscriptionError,
  type TranscriptionLimits,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionSegment,
  type TranscriptionShape,
  type TranscriptionUsage,
} from "./transcription-core.ts";
// The `fetchImpl` option's type, so a transcription-only app can type its wrapper without the
// main entry.
export type { FetchLike } from "./transport.ts";
export * from "./providers/openai-transcription.ts";
export * from "./providers/deepgram-transcription.ts";
export * from "./providers/transcription-factory.ts";
export { TRANSCRIPTION_PRESET_IDS, type PresetTranscription } from "./presets.ts";
