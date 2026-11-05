---
title: Speech
description: Turn text into one audio clip with Google Gemini, OpenAI, OpenRouter or any server that copies OpenAI's speech route. One request per call, and the audio is named by its own bytes.
---

Speech turns a short text into one audio file. It is a separate client from the chat
`Provider`, in its own entry point, so an app that only chats loads none of the speech code.
That app still carries the three speech rows of the presets table and a 64 KiB cap on an
error body: about 1.5 KB more, 0.6 KB gzipped (measured with `bun build --minify`).

## Say something

```ts
import { createSpeechProvider } from "@providerkit/core/speech";

const speech = createSpeechProvider("google", { apiKey });
const { bytes, mimeType } = await speech.synthesize({ text: "Click Settings." });

mimeType; // "audio/wav"
```

`bytes` is the whole file. Save it, play it or hand it to a decoder.

## What comes back

| Field                         | What it holds                                                                |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `bytes`, `format`, `mimeType` | The audio, and what the bytes really are                                     |
| `sampleRate`, `channels`      | Only when the file or the request states them                                |
| `durationMs`                  | Exact, from a WAV header that checks out. Absent for mp3, Opus, AAC and FLAC |
| `characters`                  | The length of the text you sent after trimming                               |
| `usage`                       | Token counts, only when the provider reported them                           |
| `model`, `voice`              | What you asked for                                                           |

Nothing is estimated. If the provider did not state a duration, a rate or a count, the
field is missing. Missing means unknown, not zero.

## Which presets can speak

A preset speaks when it has a `speech` row. `SPEECH_PRESET_IDS` lists them, for a screen
that offers exactly those. Read on 2026-11-02.

| Preset       | Wire     | Default model          | Default voice       | Text limit                                          | Formats the vendor documents         |
| ------------ | -------- | ---------------------- | ------------------- | --------------------------------------------------- | ------------------------------------ |
| `google`     | `gemini` | `gemini-3.8-flash-tts` | `Kore` (30 voices)  | 4,096 (the package default; the vendor states none) | wav, pcm                             |
| `openai`     | `openai` | `gpt-4o-mini-tts`      | `alloy` (13 voices) | 4,096                                               | wav, mp3, opus, aac, flac, pcm       |
| `openrouter` | `openai` | none: name a model     | none: name a voice  | 4,096 (the package default; the vendor states none) | mp3 or pcm, and some models only one |

Only the `gemini` wire checks the format before the request (wav and pcm). The `openai` wire
sends the `format` you ask for and lets the vendor answer, so a format a model does not make
comes back as a 400 from the vendor.

The plan sign-ins (`chatgpt`, `claude`, `antigravity` and the rest) have no speech row.
No speech endpoint is known to accept a plan token.

Google's guide lists `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`,
`gemini-3.1-flash-tts-preview` and `gemini-2.5-pro-preview-tts`. Only the first has run
against the live API, and the preset lists the first two. The guide says the older
`gemini-3.1-flash-tts-preview` answers raw PCM by default. A wav request refuses that as
`bad_audio` after Google has billed it, so if you name that model or
`gemini-2.5-pro-preview-tts`, pass `format: "pcm"`. Neither has run here.

OpenRouter takes `mp3` or `pcm`, and some models take only one of them (Gemini TTS and HeyGen
answer 400 to mp3, MiniMax to pcm). The row asks for `mp3`, so for a Gemini TTS model behind
OpenRouter pass `format: "pcm"`. OpenRouter states no sample rate for most pcm replies, so
the result then has no `sampleRate` or `durationMs`. List its speech models with
`GET /api/v1/models?output_modalities=speech`.

### OpenAI's models end on 2027-01-06

OpenAI says `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down on 2027-01-06
([deprecations](https://developers.openai.com/api/docs/deprecations)). The model it names
as the replacement is not served by `/audio/speech`. After that date the `openai` row is
useful for servers that copy the route, which is the next section.

## A server that copies OpenAI's route

Point the `openai` preset at another host with `baseUrl`. A local Kokoro server needs no key:

```ts
const speech = createSpeechProvider("openai", {
  apiKey: "",
  baseUrl: "http://localhost:8880/v1",
  model: "kokoro",
  voice: "af_bella",
});
```

An empty `apiKey` sends no `Authorization` header. A preset's default model, voice, format
and text limit are facts about its own host, so none of them follow you to another one:
name the model, and a voice unless every call does. A `baseUrl` that already ends in a
version (`/v1`) is not given a second one.

## One request per call

`synthesize()` sends exactly one HTTP request. No retry, no second model, no second key.

A speech reply arrives whole. A chat stream that fails before its first token has cost
nothing, but a speech call that times out or loses its socket may have been billed already.
So a timeout, a dropped connection and a 5xx come back with `shouldRetry: false`, even when
the vendor sends `x-should-retry: true`: that header says a resend is fine for the vendor, not
that the first call went unbilled. A 429 stays retryable, because the vendor refused before it
did any work, and there the header is believed.

Your own retry then does the safe thing without extra rules:

```ts
import { withRetry } from "@providerkit/core";

const clip = await withRetry(() => speech.synthesize({ text }));
```

That sends a throttled call again after the wait the vendor asked for, and nothing else.
Pass a `signal` to `synthesize` and a Stop leaves exactly as it arrived. It is never
turned into a timeout.

## The audio is named by its bytes

Many servers ignore the format they were asked for. So `format` is read from the file:
WAV, FLAC, Ogg Opus, mp3 or ADTS AAC. Ask for WAV and receive mp3, and you get
`format: "mp3"`.

- An empty body, a JSON body or bytes nobody recognises is an error, never audio.
- Raw PCM has no header to read. It is accepted only when you asked for `pcm`.
- A WAV with a header that does not check out is still labelled `wav`, with no rate or
  duration. Decode it before you trust it.
- `readWav(bytes)` reads a WAV strictly (PCM, exact sizes, whole frames) and returns its
  rate, channels, sample width, frames and duration, or `undefined`.

## Limits

| Option          | Default | What happens past it                                     |
| --------------- | ------- | -------------------------------------------------------- |
| `maxInputChars` | 4,096   | Refused before any request. Never cut                    |
| `maxAudioBytes` | 32 MiB  | `invalid`, code `response_too_large`. Never read past it |
| `timeoutMs`     | 120,000 | `timeout`, one deadline for the headers and the body     |

Each must be a positive integer, or the provider is not built. The reply is read with a
cap, a redirect fails the call instead of following (the key travels in a header), and an
error body is read up to 64 KiB.

## Errors

Failures use the same kinds as chat (`auth`, `rate`, `quota`, `model`, and the rest), so the
classifier you already have reads them. They are read from the status and the body, then the
provider's words are dropped. An error carries its `kind`, `status`, `code` and retry hints,
and never the vendor's text or your key: a vendor error can echo the text you sent. A send
that fails keeps no `cause` either, because a runtime that refuses a header quotes its value,
and a base URL can carry a password. The message names the host and nothing after it.

| Situation                                        | Kind           | `code`               |
| ------------------------------------------------ | -------------- | -------------------- |
| A key with a line break or a non-ASCII character | `auth`         | `key_invalid`        |
| Empty or blank text                              | `invalid`      | `text_empty`         |
| Text over `maxInputChars`                        | `invalid`      | `text_too_long`      |
| No voice, and the preset names none              | `invalid`      | `voice_required`     |
| A format the wire cannot make                    | `invalid`      | `format_unsupported` |
| A failure the provider reports inside a 200      | by its wording | none                 |
| An empty reply, or no audio block                | `overload`     | `empty_audio`        |
| A reply that is not audio                        | `unknown`      | `bad_audio`          |
| A reply over `maxAudioBytes`                     | `invalid`      | `response_too_large` |
| A Gemini clip cut short                          | `invalid`      | `incomplete`         |

The first five are thrown before any request. An empty reply, `bad_audio`, `incomplete` and
a failure reported inside a 200 come after one, so the provider has billed for it. Those are
`SpeechError`s, and they keep the `usage` the provider stated. A caller that drops one loses
the only record of the charge. On the OpenAI route a reply cut off for being too large is a plain
error, because its usage was never read. On Gemini, audio over `maxAudioBytes` inside a reply
that arrived whole is a `SpeechError` that keeps the usage; only a reply the transport cap
cut off carries none.

## Gemini

Gemini speech runs on the Interactions API (`POST /v1beta/interactions`). The request is
the one an adopter has already run against the live API. `store` is `false`, so the
interaction is not kept. The reply must say `completed`, the last audio block wins, a block
that holds a link instead of data is refused and never fetched, and the base64 must be
strict.

`maxOutputTokens` caps the audio tokens generated. It is not sent unless you set it. A live
call on 2026-11-03 showed Google enforces it: the clip stopped early, the reply said
`incomplete` and carried the usage billed, and the package reports that as the `incomplete`
error with that usage. The text limit is still the bound on cost you can rely on.

Google's speech guide spells the voice field `speech_config` and its API reference spells it
`structured_speech_config`. The package sends `speech_config`: a live call on 2026-11-03 showed it changes the voice. The other spelling was accepted too, but a voice sent that way was not tested. The interface is `v1beta`
and can move. On a key without billing, Google's terms let it use what you send to improve
its products, outside the EEA, Switzerland and the UK (read 2026-11-02). Read the terms that
apply to your key.

## ElevenLabs

ElevenLabs is not a chat preset, so it has its own constructor instead of a preset row:

```ts
import { createElevenLabsSpeechProvider, listElevenLabsVoices } from "@providerkit/core/speech";

const voices = await listElevenLabsVoices({ apiKey });
const speech = createElevenLabsSpeechProvider({ apiKey, voice: voices[0].id });
const { bytes } = await speech.synthesize({ text: "Click Settings." });
```

It sends `POST /v1/text-to-speech/{voice_id}` with the key in `xi-api-key`, the text and the
model (`eleven_multilingual_v2` unless you pass another, such as `eleven_flash_v2_5`). The voice is
a voice id, not a name: `listElevenLabsVoices` reads the ones the key can use from `GET /v2/voices`,
with the languages ElevenLabs verified for each. It makes WAV and raw PCM at 24 kHz, MP3 at
128 kbps and Opus. Those work on every plan; 44.1 kHz PCM and WAV need a Pro plan, so the
package does not ask for them. ElevenLabs bills per character and states no usage, so
`characters` is the number to bill by and `usage` stays empty.

A missing or malformed voice id comes back as `invalid` with the code `voice_not_found`, not as
an unknown model: the fix is another voice. A wrong key is `auth`, no credits is `quota`, a
throttle or too many calls at once is `rate`. Like the other wires, the error never carries the
vendor's words, the URL's path or the request. Read from the documentation on 2026-11-05; no
live call has been made with a real key.

## Check the wire with a real key

`core/scripts/probe-speech.ts` sends a few short, paid requests and prints what came back,
so you can settle what documentation cannot. Run it yourself, in a checkout:

```sh
cd core
GEMINI_API_KEY=... bun run probe:speech google          # lists the steps, sends nothing
GEMINI_API_KEY=... bun run probe:speech google --yes    # sends them
```

The dry run lists the steps and how many paid requests they make. The script reads the key
from the environment, never from an argument, and never prints it. With `--base-url` it reads
only `PROBE_SPEECH_API_KEY`, so a vendor key is never sent to a host you typed.

## Not in this release

- No `Registry.speech`. A registry connection does not serve speech yet.
- No `language`, `instructions`, `speed`, streaming or `check()`. Both wires detect the
  language from the text, and a field that is accepted and ignored is worse than a missing one.
- No xAI, Mistral, Azure or Groq rows. Each needs its own wire, or a direct
  read of its documentation first.
