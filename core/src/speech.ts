// `@providerkit/core/speech`: text to speech, a second kind of client next to the chat
// `Provider`. It is its own entry point, and `index.ts` does not export it, so an app
// that only chats loads none of it. Same reason `decisions.ts` stands apart.
export * from "./speech-core.ts";
export * from "./providers/openai-speech.ts";
export * from "./providers/gemini-speech.ts";
export * from "./providers/speech-factory.ts";
export { SPEECH_PRESET_IDS, type PresetSpeech } from "./presets.ts";
