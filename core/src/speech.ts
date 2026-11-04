// `@providerkit/core/speech`: text to speech, a second kind of client next to the chat
// `Provider`. It is its own entry point, and `index.ts` does not export it, so an app
// that only chats loads none of the speech code. Same reason `decisions.ts` stands apart.
//
// Named, not `export *`: speech-core.ts also holds helpers the two wires share, and a
// helper exported here is one this package can never change without a major version.
export {
  DEFAULT_SPEECH_LIMITS,
  readWav,
  SPEECH_FORMATS,
  SpeechError,
  type SpeechFormat,
  type SpeechLimits,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
  type SpeechShape,
  type SpeechUsage,
  type WavInfo,
} from "./speech-core.ts";
export * from "./providers/openai-speech.ts";
export * from "./providers/gemini-speech.ts";
export * from "./providers/speech-factory.ts";
export { SPEECH_PRESET_IDS, type PresetSpeech } from "./presets.ts";
