---
title: Transcription
description: Turn one recording into its text with Deepgram, OpenAI or any server that copies OpenAI's transcription route. One request per call, timed segments, and speakers when you ask for them.
---

Transcription turns one recording into its text. It is the other direction of
[speech](/guides/speech/), and like speech it is a separate client in its own entry point, so
an app that only chats loads none of the transcription code. That app still carries the
`openai` transcription row of the presets table and the upload path in the shared transport:
416 bytes more, 129 gzipped (measured with `bun build --minify`).

## Transcribe a recording

```ts
import { createDeepgramTranscriptionProvider } from "@providerkit/core/transcription";

const listen = createDeepgramTranscriptionProvider({ apiKey });
const { text } = await listen.transcribe({ audio: file });

text; // "Bom dia. Tudo bem?"
```

`audio` is a `Blob`, and a `File` from `<input type="file">` is one. It needs a media type,
because that is how each vendor learns the format. Bytes you already hold become one with
`new Blob([bytes], { type: "audio/wav" })`.

## What goes in

| Field      | What it does                                                                  |
| ---------- | ----------------------------------------------------------------------------- |
| `audio`    | The recording, as a `Blob` with a media type                                  |
| `language` | A BCP-47 tag such as `pt-BR`. Leave it out and the provider detects it        |
| `diarize`  | `true` labels who speaks each segment                                         |
| `model`    | This call's model, instead of the one the provider was built with             |
| `signal`   | Your Stop. It leaves exactly as it arrived and is never turned into a timeout |

## What comes back

| Field             | What it holds                                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| `text`            | The whole transcript. `""` when nobody spoke                                     |
| `segments`        | Timed pieces: `start` and `end` in seconds, `text`, and `speaker` when you asked |
| `durationSeconds` | The recording's length, when the provider states it                              |
| `usage`           | What the provider says it billed, only when it says so                           |
| `model`           | The model that was asked for                                                     |

Nothing is estimated. If the provider did not state a duration or a usage, the field is
missing. Missing means unknown, not zero. `segments` is empty when the model gives no timing.

`usage` comes in the provider's own unit: `{ type: "tokens", inputTokens, outputTokens,
totalTokens }` (with `audioTokens` and `textTokens` when stated), or `{ type: "duration",
seconds }`. Counts that do not add up are dropped whole.

## Who is speaking

Pass `diarize: true`:

```ts
const { segments } = await listen.transcribe({ audio: file, language: "pt-BR", diarize: true });

segments[0]; // { start: 0.08, end: 1.2, text: "Bom dia.", speaker: 0 }
```

`speaker` is the provider's own label. Deepgram counts from 0. OpenAI sends a string. Turn it
into a name in your app; the package does not make one up.

Without `diarize`, no segment has a `speaker`, even when the reply carries one. Deepgram puts
speaker 0 on every utterance when diarization is off, and a monologue labelled as one speaker
is a claim nobody made.

## Deepgram

Deepgram is not a chat preset, so it has its own constructor instead of a preset row, the way
ElevenLabs does for speech.

It sends `POST https://api.deepgram.com/v1/listen` with the recording as the body, its media
type as `Content-Type`, and the key as `Authorization: Token`. The model is `nova-3` unless you
pass another. Every call asks for `punctuate`, `smart_format` and `utterances`, so the text is
punctuated and `segments` is filled whether or not you asked for speakers. `diarize: true` adds
`diarize_model=latest`. Deepgram's reference says naming a diarization model turns it on, and
the older `diarize` flag is deprecated.

Given no language, Deepgram assumes English. The package sends `detect_language=true` instead,
so leaving `language` out means the same thing on both wires: find out.

Deepgram reports no usage. It bills by the length of the recording, so `durationSeconds` is the
number to bill by. It takes uploads up to 2 GB, which is this wire's `maxAudioBytes` default,
and stops working on one after 10 minutes, which is the package's deadline.

## OpenAI

```ts
import { createTranscriptionProvider } from "@providerkit/core/transcription";

const listen = createTranscriptionProvider("openai", { apiKey });
const { text } = await listen.transcribe({ audio: file });
```

A preset transcribes when it has a `transcription` row. `TRANSCRIPTION_PRESET_IDS` lists them,
for a screen that offers exactly those. Today that is `openai`.

It sends `POST /v1/audio/transcriptions` as a multipart form. The model decides what goes in
the form and what comes back (OpenAI's guide and reference, read 2026-11-11):

| Model                                         | Language field | What comes back                                 |
| --------------------------------------------- | -------------- | ----------------------------------------------- |
| `gpt-transcribe` (the default, recommended)   | `languages[]`  | The text                                        |
| `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | `language`     | The text and token usage                        |
| `gpt-4o-transcribe-diarize`                   | `language`     | Segments with speakers, when `diarize: true`    |
| `whisper-1`                                   | `language`     | Timed segments, the duration and billed seconds |

OpenAI takes two-letter codes, so `pt-BR` goes as `pt`. The region is dropped, including for
Chinese (`zh-TW` goes as `zh`).

The file part is named for its type (`audio.wav`, `audio.mp3`), because OpenAI reads the format
from the name. A type the package does not know keeps the `File`'s own name.

`diarize: true` asks for `diarized_json`, with `chunking_strategy: "auto"`, which OpenAI
requires for anything over 30 seconds. Only `gpt-4o-transcribe-diarize` can answer it. Any other
model answers with a 400, and you get that error rather than a transcript with no speakers that
reads as one voice.

### OpenAI's older models end on 2027-02-26

OpenAI says `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and
`gpt-4o-transcribe-diarize` shut down on 2027-02-26. The diarize model is the only OpenAI model
that labels speakers, so after that date use Deepgram for speakers.

## A server that copies OpenAI's route

Point the `openai` preset at another host with `baseUrl`. Groq serves Whisper on the same route:

```ts
const listen = createTranscriptionProvider("openai", {
  apiKey: groqKey,
  baseUrl: "https://api.groq.com/openai/v1",
  model: "whisper-large-v3",
});
```

A model whose name holds `whisper` is asked for `verbose_json`, so it returns timed segments.
The preset's default model belongs to OpenAI's host and does not follow you to another one, so
name the model. An empty `apiKey` sends no `Authorization` header, for a local server that
wants none. A `baseUrl` that already ends in a version (`/v1`) is not given a second one.

## One request per call

`transcribe()` sends exactly one HTTP request. No retry, no second model, no second key.

A recording is billed by its length once the vendor starts on it. A call that times out or
loses its socket after the upload may already have cost money. So a timeout, a dropped
connection and a 5xx come back with `shouldRetry: false`, even when the vendor sends
`x-should-retry: true`. A 429 stays retryable, because the vendor refused before it did any
work. This is the rule [speech](/guides/speech/#one-request-per-call) follows, and the same
code applies it.

Your own retry then does the safe thing without extra rules:

```ts
import { withRetry } from "@providerkit/core";

const result = await withRetry(() => listen.transcribe({ audio: file }));
```

That sends a throttled call again after the wait the vendor asked for, and nothing else.

## Limits

| Option          | Default                 | What happens past it                                           |
| --------------- | ----------------------- | -------------------------------------------------------------- |
| `maxAudioBytes` | 25 MiB (Deepgram: 2 GB) | Refused before any request, code `audio_too_large`. Never cut  |
| `timeoutMs`     | 600,000                 | `timeout`, one deadline for the upload, the work and the reply |

25 MiB is OpenAI's documented upload limit, and Groq's free tier says the same. Raise it for a
host that takes more. Each limit must be a positive integer, or the provider is not built. The
reply is read up to 64 MiB, and a redirect fails the call instead of following it, because the
key travels in a header.

## Errors

Failures use the same kinds as chat (`auth`, `rate`, `quota`, `model`, and the rest), so the
classifier you already have reads them.

Unlike speech, a transcription error keeps the provider's words in `message` and `body`. A
speech error drops them because they can repeat the text you sent. Here you sent audio, and the
words are often the fix: "Invalid file format. Supported formats: ...". A key that cannot go in
a header is refused before any request, so no runtime error ever quotes it.

| Situation                                                  | Kind                             | `code`                         |
| ---------------------------------------------------------- | -------------------------------- | ------------------------------ |
| A key with a line break or a non-ASCII character           | `auth`                           | `key_invalid`                  |
| No key on Deepgram, which has no keyless mode              | `auth`                           | `key_invalid`                  |
| An empty recording                                         | `invalid`                        | `audio_empty`                  |
| A `Blob` with no media type                                | `invalid`                        | `audio_type_missing`           |
| A recording over `maxAudioBytes`                           | `invalid`                        | `audio_too_large`              |
| A blank `model`                                            | `invalid`                        | `model_required`               |
| A wrong key (401)                                          | `auth`                           | none                           |
| No credits (Deepgram 402, OpenAI 429 `insufficient_quota`) | `quota`                          | none                           |
| A project without access to the model (Deepgram 403)       | `model`                          | none                           |
| Too many calls (429)                                       | `rate`                           | none                           |
| The vendor could not read the audio (400)                  | `invalid`                        | `audio_invalid`                |
| The vendor says the file is too big (413)                  | `invalid`                        | `audio_too_large`              |
| A 5xx, a lost socket, our deadline                         | `overload`, `network`, `timeout` | none, and `shouldRetry: false` |
| A failure the provider reports inside a 200                | by its wording                   | the vendor's                   |
| A 200 that holds no transcript                             | `unknown`                        | `bad_reply`                    |
| A reply over 64 MiB                                        | `invalid`                        | `response_too_large`           |

The first six are thrown before any request, so they cost nothing. A failure inside a 200 and
`bad_reply` come after one, so the provider may have billed for it. Those are
`TranscriptionError`s, and they keep the `usage` the provider stated. A caller that drops one
loses the only record of the charge.

## Not in this release

- No `Registry.transcription`. A registry connection does not serve transcription yet.
- No live audio stream, no URL input (Deepgram can fetch one; the package sends the bytes), no
  `prompt` or keywords, no word timings, no detected language in the result, and no translation.
- No Groq, Mistral or AssemblyAI rows, and no ElevenLabs speech to text. Groq works today
  through `baseUrl`, as above.
- No live call has been made with a real key. Both wires are built from the vendors'
  documentation and the replies it shows, read on 2026-11-11.
