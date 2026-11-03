/**
 * Probe a speech preset against the live API, before code relies on a field.
 *
 * THIS SENDS REAL, PAID REQUESTS. Nothing here runs unless you start it, and without
 * `--yes` it only prints the requests it would send. Each request is a few words of
 * synthetic text: well under one cent on Gemini by Google's list price, and possibly
 * nothing on its free tier. Prices change; check yours.
 *
 * Usage:
 *   bun run scripts/probe-speech.ts <preset> [model] [--yes] [--voice=NAME]
 *     [--other-voice=NAME] [--format=wav|mp3|opus|aac|flac|pcm] [--base-url=URL]
 *     [--only=STEP,STEP] [--save=DIR]
 *
 * The key is read from the environment inside this process and never printed, never
 * written to a file and never taken from an argument (an argument shows in `ps` and in
 * shell history). google reads GEMINI_API_KEY, openai OPENAI_API_KEY, openrouter
 * OPENROUTER_API_KEY. PROBE_SPEECH_API_KEY overrides all three. A server you reach with
 * --base-url may need no key. Bun reads `.env` from the working directory; for a file
 * elsewhere, add --env-file=<path> after `bun`.
 *
 * What it settles on `google` (one step each, so a failed variant shows its own reply):
 *   baseline         the request the package sends. The audio block's field names, the
 *                    reply's `status`, and `usage`.
 *   structured       `speech_config` renamed `structured_speech_config`, as the API
 *                    reference spells it. Does Google take either?
 *   mime-wav         `mime_type: "audio/wav"` added to `response_format`. Accepted?
 *   voice-honoured   the same words in --voice (default Kore) and --other-voice (default
 *                    Charon). Identical bytes mean the voice was accepted and ignored.
 *   max-tokens       a longer sentence with `max_output_tokens` at 12. Google lists 25
 *                    audio tokens a second, so a cap that holds gives about half a second.
 *                    What `status` does a cut clip carry?
 * On any other preset it runs `baseline`, then `voice-honoured` when --other-voice is set.
 *
 * --save=DIR writes each reply as a redacted `<step>.json` (every field exactly as
 * received, long strings replaced by their length) and the audio beside it, so a real
 * reply can replace the invented one in the tests. Listen to the two voice files once.
 *
 * Examples:
 *   bun run scripts/probe-speech.ts google
 *   bun run scripts/probe-speech.ts google --yes --save=./probe-out
 *   bun run scripts/probe-speech.ts openai kokoro --base-url=http://localhost:8880/v1 \
 *     --voice=af_bella --other-voice=am_adam --format=mp3 --yes
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../src/errors.ts";
import { PROVIDER_PRESETS, SPEECH_PRESET_IDS, type ProviderPreset } from "../src/presets.ts";
import {
  asRecord,
  createSpeechProvider,
  SPEECH_FORMATS,
  SpeechError,
  type SpeechFormat,
  type SpeechProviderConfig,
} from "../src/speech.ts";

const USAGE =
  "Usage: bun run scripts/probe-speech.ts <preset> [model] [--yes] [--voice=NAME] [--other-voice=NAME] [--format=FORMAT] [--base-url=URL] [--only=STEP,STEP] [--save=DIR]";

const KEY_VARIABLE: Record<string, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const WORDS = "Hello there.";
const LONG_SENTENCE =
  "Click Settings, then choose Voice, and press Try voice to hear a short sample.";
const CAP = 12;

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith("--"));
// Split on the first "=" only: a URL can hold one.
const flags = Object.fromEntries(
  argv
    .filter((arg) => arg.startsWith("--"))
    .map((arg): [string, string] => {
      const eq = arg.indexOf("=");
      return eq === -1 ? [arg.slice(2), "true"] : [arg.slice(2, eq), arg.slice(eq + 1)];
    }),
);

function fail(message: string): never {
  console.error(`Error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const [presetId, modelArg] = positional;
if (!presetId) {
  console.error(USAGE);
  console.error(`Presets that can speak: ${SPEECH_PRESET_IDS.join(", ")}.`);
  console.error("Nothing was sent.");
  process.exit(0);
}
const found = SPEECH_PRESET_IDS.find((id) => id === presetId);
if (!found) fail(`"${presetId}" has no speech row. Use one of: ${SPEECH_PRESET_IDS.join(", ")}.`);
// A new name: TypeScript keeps the narrowing on a const, not inside the functions below.
const known = found;
const preset: ProviderPreset = PROVIDER_PRESETS[known];

const formatFlag = flags.format;
const format = SPEECH_FORMATS.find((value) => value === formatFlag);
if (formatFlag !== undefined && !format) {
  fail(`--format=${formatFlag} is not a format. Use one of: ${SPEECH_FORMATS.join(", ")}.`);
}
const baseUrl = flags["base-url"];
if (baseUrl && !modelArg) fail("--base-url needs a model. Pass it after the preset.");
const keyVariable = KEY_VARIABLE[known] ?? `${known.toUpperCase().replaceAll("-", "_")}_API_KEY`;
const apiKey = process.env.PROBE_SPEECH_API_KEY ?? process.env[keyVariable] ?? "";
const voice = flags.voice ?? (baseUrl ? undefined : preset.speech?.defaultVoice);
const otherVoice = flags["other-voice"] ?? (known === "google" ? "Charon" : undefined);
const send = flags.yes === "true";
const save = flags.save;

const steps =
  known === "google"
    ? ["baseline", "structured", "mime-wav", "voice-honoured", "max-tokens"]
    : ["baseline", ...(otherVoice ? ["voice-honoured"] : [])];
const only = flags.only?.split(",").map((name) => name.trim());
const chosen = only ? steps.filter((name) => only.includes(name)) : steps;
if (only && chosen.length !== only.length) {
  fail(`--only names a step this preset does not have. Its steps: ${steps.join(", ")}.`);
}

// One request per step, except voice-honoured, which is two (the baseline's voice is re-asked).
const requestCount = chosen.reduce((sum, name) => sum + (name === "voice-honoured" ? 2 : 1), 0);
console.log(
  `Probing [${known}] model ${modelArg ?? preset.speech?.defaultModel ?? "(none: pass one)"}` +
    `${baseUrl ? ` at ${baseUrl}` : ""}.`,
);
console.log(`Steps: ${chosen.join(", ")}. That is ${requestCount} paid request(s).`);
// Whether a key is set, never what it is.
console.log(`Key: ${apiKey ? "set" : "not set"} (${keyVariable}).`);
if (!send) {
  console.log("Dry run: nothing was sent. Add --yes to send them.");
  process.exit(0);
}
if (!apiKey && !baseUrl) {
  fail(`Missing API key. Set ${keyVariable} (or PROBE_SPEECH_API_KEY) in the environment.`);
}

/** The reply as received, with anything long or secret replaced, for printing and fixtures. */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    const hidden = apiKey ? value.replaceAll(apiKey, "[key]") : value;
    return hidden.length > 200 ? `<${hidden.length} characters>` : hidden;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

interface Tap {
  fetchImpl: typeof fetch;
  /** What came back over the wire, whatever the package then made of it. */
  seen: { status?: number; contentType?: string; bytes?: number; envelope?: unknown };
}

/**
 * A fetch that changes the request body when a variant asks (to try a field the package
 * does not send) and keeps a redacted copy of the reply. The request headers, and so the
 * key, are never recorded.
 */
function tap(variant?: (body: Record<string, unknown>) => Record<string, unknown>): Tap {
  const seen: Tap["seen"] = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    const body =
      variant && typeof init?.body === "string"
        ? JSON.stringify(variant(JSON.parse(init.body)))
        : init?.body;
    const res = await fetch(url, { ...init, body });
    const copy = res.clone();
    seen.status = res.status;
    seen.contentType = res.headers.get("content-type") ?? undefined;
    const raw = new Uint8Array(await copy.arrayBuffer());
    seen.bytes = raw.byteLength;
    if (/json|text/.test(seen.contentType ?? "")) {
      const text = new TextDecoder().decode(raw);
      try {
        seen.envelope = redact(JSON.parse(text));
      } catch {
        seen.envelope = redact(text.slice(0, 600));
      }
    }
    return res;
  };
  return { fetchImpl, seen };
}

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

interface Attempt {
  variant?: (body: Record<string, unknown>) => Record<string, unknown>;
  text?: string;
  voice?: string;
  config?: Partial<SpeechProviderConfig>;
}

/** Runs one request, prints what happened, and returns the audio hash for comparing. */
async function attempt(step: string, options: Attempt = {}): Promise<string | undefined> {
  const wire = tap(options.variant);
  const speech = createSpeechProvider(known, {
    apiKey,
    ...(modelArg ? { model: modelArg } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(format ? { format } : {}),
    ...options.config,
    fetchImpl: wire.fetchImpl,
  });
  const started = Date.now();
  const report: Record<string, unknown> = { step, model: speech.model };
  let digest: string | undefined;
  let audio: { bytes: Uint8Array; format: SpeechFormat } | undefined;
  try {
    const result = await speech.synthesize({
      text: options.text ?? WORDS,
      voice: options.voice ?? voice,
    });
    digest = await sha256(result.bytes);
    audio = { bytes: result.bytes, format: result.format };
    Object.assign(report, {
      ok: true,
      voice: result.voice,
      format: result.format,
      mimeType: result.mimeType,
      bytes: result.bytes.byteLength,
      sampleRate: result.sampleRate,
      channels: result.channels,
      durationMs: result.durationMs,
      usage: result.usage,
      sha256: digest,
    });
  } catch (error) {
    const failed = error instanceof ProviderError ? error : undefined;
    Object.assign(report, {
      ok: false,
      kind: failed?.kind ?? "not a ProviderError",
      status: failed?.status,
      code: failed?.code,
      retryable: failed?.shouldRetry,
      // The package keeps the provider's words out of its errors. The reply is above
      // under `http`, redacted, because the reason is what a probe is for.
      usage: error instanceof SpeechError ? error.usage : undefined,
      message: error instanceof Error ? redact(error.message) : "thrown value",
    });
  }
  report.ms = Date.now() - started;
  report.http = wire.seen;
  console.log(JSON.stringify(report, null, 2));
  if (save) {
    await mkdir(save, { recursive: true });
    await writeFile(
      join(save, `${step}.json`),
      `${JSON.stringify(wire.seen.envelope ?? report, null, 2)}\n`,
    );
    if (audio) await writeFile(join(save, `${step}.${audio.format}`), audio.bytes);
  }
  return digest;
}

const renameSpeechConfig = (body: Record<string, unknown>): Record<string, unknown> => {
  const { speech_config, ...rest } = asRecord(body.generation_config) ?? {};
  return { ...body, generation_config: { ...rest, structured_speech_config: speech_config } };
};
const addWavMime = (body: Record<string, unknown>): Record<string, unknown> => ({
  ...body,
  response_format: { ...asRecord(body.response_format), mime_type: "audio/wav" },
});

for (const step of chosen) {
  console.log(`\n--- ${step} ---`);
  if (step === "baseline") await attempt(step);
  else if (step === "structured") await attempt(step, { variant: renameSpeechConfig });
  else if (step === "mime-wav") await attempt(step, { variant: addWavMime });
  else if (step === "max-tokens") {
    await attempt(step, { text: LONG_SENTENCE, config: { maxOutputTokens: CAP } });
  } else if (step === "voice-honoured") {
    const first = await attempt(`${step}-a`);
    const second = await attempt(`${step}-b`, { voice: otherVoice });
    console.log(
      first && second
        ? first === second
          ? "Same bytes for two voices: the voice was accepted and ignored."
          : "Different bytes for two voices. Listen to both files once to confirm they sound different."
        : "One of the two requests failed, so the voices were not compared.",
    );
  }
}
