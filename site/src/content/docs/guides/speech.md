---
title: Speech
description: Turn text into one audio clip with Google Gemini, OpenAI, OpenRouter or any server that copies OpenAI's speech route. One request per call, and the audio is named by its own bytes.
---

Speech turns a short text into one audio file. It is a separate client from the chat
`Provider`, in its own entry point, so an app that only chats never loads it.

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

| Preset       | Wire     | Default model          | Default voice       | Text limit | Formats it makes               |
| ------------ | -------- | ---------------------- | ------------------- | ---------- | ------------------------------ |
| `google`     | `gemini` | `gemini-3.8-flash-tts` | `Kore` (30 voices)  | not stated | wav, pcm                       |
| `openai`     | `openai` | `gpt-4o-mini-tts`      | `alloy` (13 voices) | 4,096      | wav, mp3, opus, aac, flac, pcm |
| `openrouter` | `openai` | none: name a model     | none: name a voice  | not stated | mp3 by default, pcm            |

The plan sign-ins (`chatgpt`, `claude`, `antigravity` and the rest) have no speech row.
No speech endpoint is known to accept a plan token.

Google's guide lists `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`,
`gemini-3.1-flash-tts-preview` and `gemini-2.5-pro-preview-tts`. Only the first has run
against the live API. The OpenRouter row takes `mp3` or `pcm` and answers 400 to anything
else; list its speech models with `GET /api/v1/models?output_modalities=speech`.

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
So a timeout, a dropped connection and a 5xx come back with `shouldRetry: false`. A vendor
that sends `x-should-retry: true` is believed. A 429 stays retryable, because the vendor
refused before it did any work.

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
and never the vendor's text or your key: a vendor error can echo the text you sent.

| Situation                                   | Kind           | `code`               |
| ------------------------------------------- | -------------- | -------------------- |
| Empty or blank text                         | `invalid`      | `text_empty`         |
| Text over `maxInputChars`                   | `invalid`      | `text_too_long`      |
| No voice, and the preset names none         | `invalid`      | `voice_required`     |
| A format the wire cannot make               | `invalid`      | `format_unsupported` |
| A failure the provider reports inside a 200 | by its wording | none                 |
| An empty reply, or no audio block           | `overload`     | `empty_audio`        |
| A reply that is not audio                   | `unknown`      | `bad_audio`          |
| A reply over `maxAudioBytes`                | `invalid`      | `response_too_large` |
| A Gemini clip cut short                     | `invalid`      | `incomplete`         |

The first four are thrown before any request. An empty reply, `bad_audio`, `incomplete` and
a failure reported inside a 200 come after one, so the provider has billed for it. Those are
`SpeechError`s, and they keep the `usage` the provider stated. A caller that drops one loses
the only record of the charge. A reply cut off for being too large is a plain error, because
its usage was never read.

## Gemini

Gemini speech runs on the Interactions API (`POST /v1beta/interactions`). The request is
the one an adopter has already run against the live API. `store` is `false`, so the
interaction is not kept. The reply must say `completed`, the last audio block wins, a block
that holds a link instead of data is refused and never fetched, and the base64 must be
strict.

`maxOutputTokens` caps the audio tokens generated. It is not sent unless you set it, and
nobody has measured whether a speech model honours it. The text limit is the real bound on
cost.

Google's speech guide spells the voice field `speech_config` and its API reference spells it
`structured_speech_config`. The package sends the one that has run. The interface is `v1beta`
and can move. On a key without billing, Google's terms let it use what you send to improve
its products, outside the EEA, Switzerland and the UK (read 2026-11-02). Read the terms that
apply to your key.

## Check the wire with a real key

`core/scripts/probe-speech.ts` sends a few short, paid requests and prints what came back,
so you can settle what documentation cannot. Run it yourself, in a checkout:

```sh
GEMINI_API_KEY=... bun run probe:speech google          # lists the requests, sends nothing
GEMINI_API_KEY=... bun run probe:speech google --yes    # sends them
```

It reads the key from the environment, never from an argument, and never prints it.

## Not in this release

- No `Registry.speech`. A registry connection does not serve speech yet.
- No `language`, `instructions`, `speed`, streaming or `check()`. Both wires detect the
  language from the text, and a field that is accepted and ignored is worse than a missing one.
- No xAI, Mistral, ElevenLabs, Azure or Groq rows. Each needs its own wire, or a direct
  read of its documentation first.
