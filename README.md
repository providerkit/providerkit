# <img src="https://raw.githubusercontent.com/providerkit/providerkit/main/brand/providerkit-mark-128.png" alt="" width="36" height="36" align="absmiddle"> providerkit

Switch between OpenAI, Anthropic and Gemini without rewriting the TypeScript that streams replies
or handles errors.

## Quick start

Try Core's error handling with Node.js 22 or newer. No API key needed:

```sh
npm install @providerkit/core
node --input-type=module -e 'import { classify } from "@providerkit/core";
  console.log(classify("Your credit balance is too low"))' # quota
```

`quota` means retrying won't help here: the account needs credit. To call a model with your own
key, [stream a reply](#stream-a-reply).

## What Core handles

- Tell a temporary rate limit from an empty balance, even when both return HTTP 429.
- Retry a failed stream or switch to a backup model without repeating text you've already shown.
- Stop a stalled stream even if the provider keeps the connection open.
- Check the arguments a model sends before your tool runs.
- Count input and output tokens the same way across providers, including when a prompt is cached.

Core has no runtime dependencies. The same build runs in Node.js 22+, Bun, Deno, Cloudflare
Workers and Chrome extension service workers.

## Stream a reply

Set `ANTHROPIC_API_KEY` in your shell. Save this as `chat.mjs` and run `node chat.mjs` to see
the reply as it arrives. Anthropic may charge for this call.

```js
import { createPresetProvider } from "@providerkit/core";

const provider = createPresetProvider("anthropic", { apiKey: process.env.ANTHROPIC_API_KEY });
const stream = provider.createStream([{ role: "user", content: "Say hello in Welsh." }], []);

for await (const chunk of stream) {
  if (chunk.content) process.stdout.write(chunk.content);
}
```

[Switch providers](https://providerkit.dev/guides/getting-started/#swapping-the-vendor) and keep
the same loop. If a call fails, the provider's error message can quote your prompt. Set
[`redactErrors: true`](https://providerkit.dev/guides/errors/#keep-the-providers-words-out) to
omit that text but keep the error kind and retry hints.

Core handles the provider call. Keep your own agent loop, or use
[`@providerkit/agents`](https://github.com/providerkit/providerkit/tree/main/agents) to run tools
and workflows. For a chat screen, the experimental
[`@providerkit/react`](https://github.com/providerkit/providerkit/tree/main/react) package has
hooks and optional components. Your app still owns permissions and storage.

## More examples

### Prompt caching on the Anthropic shape

Anthropic caches only the parts of a request that carry a cache marker, and the adapter places
them. A system prompt gets one. A request that declares tools or already holds an assistant turn
gets one on its newest message. Once the conversation has an assistant turn, a request also gets
one on the message the last request ended on. Each turn then reads the earlier turns from cache,
instead of paying the full input rate for the whole conversation again. A one-shot call marks no
message, because nothing would read what it paid to write. Each system message goes out as its
own block, in order. The
[providers guide](https://providerkit.dev/guides/providers/#prompt-caching-on-the-anthropic-shape)
has the rules and the costs.

### Z.ai Coding Plan

`createZaiCodingProvider` uses the Coding Plan endpoint with Bearer authentication.
Pass your plan's key and a model it supports:

```ts
import { createZaiCodingProvider } from "@providerkit/core";

const provider = createZaiCodingProvider({ apiKey, model: "glm-5.2" });
```

It returns the same provider interface as the adapters above. The API root is
`https://api.z.ai/api/anthropic`; the adapter adds `/v1/messages`.
Usage reports tokens consumed, not the price of your subscription.

If you ask for a model your plan does not include, Z.ai answers with code 1311. That is an
`entitlement` error, not `auth`. Your key works: pick a model your plan has, or move to a plan
that has this one.

### OpenCode Go

One key, several models, and each model has its own monthly limit. The preset
switches to the next model when one runs out:

```ts
import { createPresetProvider } from "@providerkit/core";

const provider = createPresetProvider("opencode-go", { apiKey });
```

By default it tries `mimo-v2.6-flash`, then `glm-5.3-flash`, `qwen3.8-flash` and
`longcat-2.0`. Pass `models: [...]` to set your own order, and `fallbacks` to add another
provider after the last model. A model Go has retired answers 410, and the chain moves on to
the next one.

For structured output, pick your own `models`. On 2026-11-11 `mimo-v2.6-flash` ignored a strict
JSON Schema and answered with the schema itself; `glm-5.3-flash`, `qwen3.8-flash` and
`longcat-2.0` filled it in.

Go serves three wires, and the preset picks one from the model id: `minimax-` and `qwen`
models on Anthropic Messages, `gpt-`, `grok-` and `muse-spark-` models on Responses, and
everything else on chat completions. A chain can mix them:

```ts
const provider = createPresetProvider("opencode-go", {
  apiKey,
  models: ["muse-spark-1.3-contributor", "mimo-v2.6-flash"],
});
```

A per-call `model` on a different wire than the provider's own is refused with an
`invalid` error, before any request. Muse Contributor supports text, images, strict JSON
Schema and parallel tools, but only automatic tool choice. `toolChoice: "none"` is sent as no
tools, and a named tool as that tool alone, so it is the only call the model can make. It can
still answer in text instead. `"required"` is still sent, and so is a named tool when it is the
only tool you pass. Muse refuses both. For a structured answer, ask for it with `json`.
Contributor requests may be used to improve Meta products and require the workspace to allow
those endpoints.

Pass `watchdog: { idleMs: 60_000 }` to time each model separately, so a model that opens a
connection and then goes silent rotates too. Do not wrap the returned pool with
`withWatchdog`: that timeout cancels the whole chain. Go refuses a call without a session
id, so pass `sessionId` with each call (the conversation or job id). A call without one
uses a random id the provider keeps for its whole life. If you build a new provider per call
(`withKeyPool` and `withToken` do), pass `instanceSessionId` so each one sends the same id.
Keep one provider alive across calls, so it remembers which models are spent.

Go also asks each client to send its own user agent, not the runtime's default. Pass
`headers: { "user-agent": "my-app" }`, and add it to each Go entry in `fallbacks` too.

### OpenCode Zen and Google Antigravity

`opencode-zen` serves OpenCode Zen's free and paid models on `https://opencode.ai/zen/v1`.
By default it rotates through the free models first (`minimax-m3.1-flash-free`,
`mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free`, `big-pickle`, `glm-5.3-flash-free`),
and routes `claude-`, `gpt-`, `grok-`, `muse-`, `gemini-` and `qwen` models to the endpoint
each family uses. You can also sign in with `createAuthFlow("opencode-zen", host)` from
`@providerkit/core/auth`.

`antigravity` serves Google Cloud Code Assist over OAuth (`gemini-4-argon`,
`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-pro`, `claude-opus-5-5`,
`claude-sonnet-5-5`). Sign in with `createAuthFlow("antigravity", host)` to discover the
Cloud Code Assist project and hand the token source to `withToken` or `createRegistry`.

### Tools

```ts
import { zodTool } from "@providerkit/core/zod";
import { z } from "zod";

const lookup = zodTool({
  name: "lookup",
  description: "Look up an order.",
  input: z.object({ id: z.string() }),
  async run({ id }) {
    return await orders.get(id);
  },
});

const outcome = await lookup.invoke(argsFromModel);
```

`invoke` never throws. A bad argument, a timeout or a failing tool comes back as an outcome the
model reads, so it can fix its call. When a model sends an array as a JSON string, or a string as
`{ text }`, the tool repairs it and checks again. Pass `output` to check results too.
The model reads zod's message for each problem, which can list every value a field accepts. If you
save those replies or show them to people, pass `describeIssues` to write the problems yourself.
`lookup.accepts(args)` runs the same check without running the tool, so nobody is asked to approve
a call that can't run. The [tools guide](https://providerkit.dev/guides/tools/) covers the rest.

### Hosted tools

Let the vendor search the web, fetch a page or run code inside its own turn.
Import the provider from `/hosted`, so plain chat apps load none of its encoders or parsers:

```ts
import { collectTurn } from "@providerkit/core";
import { createPresetProvider } from "@providerkit/core/hosted";

const provider = createPresetProvider("google", { apiKey });
const turn = await collectTurn(
  provider.createStream(history, [], { hostedTools: [{ type: "web_search" }] }),
);
```

`turn.message.citations` holds the pages the answer cites and where each one sits in the text,
and `turn.message.hostedCalls` holds what the vendor ran. None of it is a tool call your loop
has to run. Constructors from the base import refuse `hostedTools` with an `invalid` error
before sending a request. With `/hosted`, an adapter that can't run a tool or apply one of its
settings, such as a domain filter, refuses unless you mark that tool `optional`.
The [tools guide](https://providerkit.dev/guides/tools/#hosted-tools) says which adapter runs
what, and how each call is billed.

### Tool calls written as text

Some models write a tool call into their answer instead of calling the tool. DeepSeek does it
with its own tokens (`<｜tool▁calls▁begin｜>`), and any model can make up a tag
(`<save_note title="x" />`). Wrap the stream to remove that markup before it reaches the reader
or the history:

```ts
import { stripLeakedToolMarkup } from "@providerkit/core";

for await (const chunk of stripLeakedToolMarkup(provider.createStream(messages, tools))) {
  if (chunk.content) write(chunk.content);
}
```

A tag split across chunks is caught too: text that could still become one waits for the next
chunk. Ordinary angle brackets stay, like `a < b` or `Promise<user_row | null>`. A call written
as plain tags with no attributes, the way GLM writes one, is not caught and stays whole. Pass
`onStrip` to log what it removes. The
[tools guide](https://providerkit.dev/guides/tools/#tool-calls-written-as-text) lists what it
catches and what gets through.

### Chat tracing

```ts
import { withProviderTracing } from "@providerkit/core/otel";

const traced = withProviderTracing(provider);
```

Use `traced.createStream` just like `provider.createStream`. Install the optional
`@opentelemetry/api` peer (`^1.10.0`) to use this entry. Normal imports load no tracing code and
need no telemetry dependency. Your app supplies the tracing setup; with only the API installed,
calls still work but no spans are exported. Core installs no exporter or context manager.

Wrap the **final provider**, after the registry, fallback, key/token recovery, gate and watchdog
layers. One CLIENT span named `chat {model}` covers one consumed stream, not each hidden attempt.
It starts on the first read and ends when the iterator ends, fails or the caller's signal aborts.
A finish chunk does not end it because usage can follow. Duration includes queueing, authentication,
recovery and pauses between reads. Tracing adds no pulls, retries, timeout or abort controller.

Options are `tracer` (default: `trace.getTracer("@providerkit/core")`), `parentContext` and
`providerName` (a label, not a routing change). Without `parentContext`, the active context is
saved separately for each `createStream` call. Set it explicitly to attach a call to a saved
parent without a context manager. HTTP child spans still need your app's context manager.
Re-wrapping a wrapper made by this adapter replaces its tracing options rather than adding a
second provider span. It cannot find a traced provider hidden inside an unrelated decorator;
do not trace both individual candidates and their completed chain.

Recorded fields follow the OpenTelemetry GenAI **Development** conventions at
[revision e6658f1](https://github.com/open-telemetry/semantic-conventions-genai/tree/e6658f14c9d9ea0760825f029cb82e7673f48fab):

| Observation                                         | Span attribute                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Chat operation, requested provider/model, streaming | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.stream` |
| Input and output tokens                             | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`                                        |
| Cache reads and writes, already included in input   | `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`                  |
| Reasoning tokens, already included in output        | `gen_ai.usage.reasoning.output_tokens`                                                           |
| Reported cost, including zero                       | `providerkit.usage.reported_cost_usd`                                                            |
| Finish reason                                       | `gen_ai.response.finish_reasons`                                                                 |
| Selected source from `chunk.source`                 | `providerkit.response.provider`, `providerkit.response.model`                                    |
| Time until this wrapper sees a chunk or activity    | `providerkit.stream.first_chunk_seconds`, `providerkit.stream.first_activity_seconds`            |
| Iterator outcome                                    | `providerkit.stream.outcome`: `completed`, `closed`, `cancelled` or `error`                      |

The last normalized usage record wins; cumulative records are not added. No record means unknown,
not zero. Only finite, nonnegative counts are kept. These are observations, not audited bills:
some adapters fill missing vendor counts with zero, and errors, early closure or cancellation can
leave partial usage. Hidden failed attempts are not included. Selected model IDs can be configured
aliases, so they are not labelled `gen_ai.response.model`. Direct Gemini is labelled `gcp.gemini`;
gateways keep their own identity. The timing fields measure this wrapper, not standard TTFT or
server inference time.

Failures record core's low-cardinality `error.type` and an ERROR status, never the error's message,
body, stack, cause or vendor code. Successful and cancelled calls leave status UNSET. Selected
numeric hints use `http.response.status_code` and `providerkit.rate_limit.utilization`,
`reset_at_ms` and `retry_after_ms`; `providerkit.rate_limit.window` accepts only `5h`, `weekly`
or `monthly`. Existing activity and rate-limit callbacks still run. Broken instrumentation does
not replace provider results or errors and cannot replay a call.

No prompts, replies, reasoning, tool arguments/results, hosted payloads, credentials, session IDs,
headers, URLs or app context are captured. Provider and model labels are recorded, so keep private
data out of those labels. Aborting closes observation, not proof that the vendor stopped billing.
A stream abandoned without `return` or abort has no observable end. An inner watchdog timeout
may stay invisible until the next read; tracing does not read ahead to discover it.

This covers **chat only**, including hosted tools as part of the provider call. It does not create
agent tool spans or instrument speech, transcription, decisions, standalone auth, transport or
other helpers. Agent run parenting and dispatch binding are not included; combining this with
agent lifecycle tracing does not automatically attach provider spans to agent runs.

### Speech

Text to one audio file, from its own entry point, so a chat-only app loads none of the speech code:

```ts
import { createSpeechProvider } from "@providerkit/core/speech";

const speech = createSpeechProvider("google", { apiKey });
const { bytes, mimeType } = await speech.synthesize({ text: "Click Settings." });
```

`google`, `openai` and `openrouter` can speak, and `openai` reaches any server that copies
its route through `baseUrl`. A paid call is sent once and never replayed by the package.

### Transcription

One recording to its text, the other direction, from its own entry point too:

```ts
import { createDeepgramTranscriptionProvider } from "@providerkit/core/transcription";

const listen = createDeepgramTranscriptionProvider({ apiKey });
const { text, segments } = await listen.transcribe({ audio: file, language: "pt-BR" });
```

Deepgram and OpenAI transcribe, and the `openai` preset reaches any server that copies its
route through `baseUrl`. Pass `diarize: true` to label who speaks each segment. A paid call is
sent once and never replayed by the package.

### Images

Generate an image without starting a chat:

```ts
import { createOpenAIImageProvider } from "@providerkit/core/images";

const painter = createOpenAIImageProvider({ apiKey, model: "gpt-image-2" });
const { images } = await painter.generate({ prompt: "A blue circle", aspectRatio: "1:1" });
```

Pass `referenceImages` to edit or use existing images as a guide. Gemini and OpenRouter offer
size classes such as `1K` and `2K`; OpenAI picks its nearest pixel size. Results contain bytes,
not download URLs. OpenRouter also returns the charge when it reports one. Pass `retry: "never"`
for a paid operation that must not be sent again after an uncertain result.

### Video

Read one video with Gemini:

```ts
import { createGeminiVideoProvider } from "@providerkit/core/video";

const video = createGeminiVideoProvider({ apiKey, model: "gemini-3.8-flash" });
const { text } = await video.read({ bytes, mimeType: "video/mp4", prompt: "What happens?" });
```

Core uploads the video in chunks, waits for it to be ready and reads it once. It attempts to
remove the file after the read, even on cancellation. Pass `onCleanupError` when you create the
provider to record a failed deletion. The result also reports token usage, even if the text is empty.

### Embeddings

Turn text into a vector, a list of numbers you can store and compare in a search index.

```ts
import { createGeminiEmbeddingProvider } from "@providerkit/core/embeddings";

const embeddings = createGeminiEmbeddingProvider({ apiKey, model: "gemini-embedding-2" });
const { vectors } = await embeddings.embed("Printer paper");
```

Pass up to 100 texts to get one vector per text, in order. Set `dimensions` to match your index
and keep the same model you used to build it. The Gemini adapter makes one request, never trims
text or changes a vector, and does not start a Google Batch job. Key rotation, retries and storage
stay with your app. `usage` is absent if Gemini did not report a complete token count.

### Set up providers once

```ts
import { createRegistry } from "@providerkit/core";

const providers = createRegistry({
  connections: { go: { preset: "opencode-go", apiKey } },
});

const provider = providers.get("go");
```

Name each connection once, with its preset and one credential: an API key, several keys to
rotate, or a signed-in user's token. `get` hands back a provider that already has the watchdog,
a fallback chain when the ref names more than one model, and a limit on calls at once when you
set `maxConcurrent`. Ask for one model with `get("go/glm-5.3-flash")`, or name your own chains
across connections.

**Full documentation lives at [providerkit.dev](https://providerkit.dev)**. It is the single
source of truth for usage, and this README deliberately stays a front door so the two cannot
drift.

| Guide                                                                   | What it covers                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| [Getting started](https://providerkit.dev/guides/getting-started/)      | Install, first stream, swapping vendors          |
| [The provider seam](https://providerkit.dev/guides/providers/)          | Message, chunk and tool shapes                   |
| [Set up providers once](https://providerkit.dev/guides/registry/)       | Name each provider once, then ask by name        |
| [Errors](https://providerkit.dev/guides/errors/)                        | The thirteen kinds, and why status is not enough |
| [Retries and fallback](https://providerkit.dev/guides/retries/)         | Backoff, the commitment rule, backup models      |
| [Streaming and the watchdog](https://providerkit.dev/guides/streaming/) | The stream that stops sending; TTFT              |
| [Tools](https://providerkit.dev/guides/tools/)                          | Tool kernel, argument salvage, zod, hosted tools |
| [Context and compaction](https://providerkit.dev/guides/context/)       | When to compact, and where to cut                |
| [Resume after a crash](https://providerkit.dev/guides/resume/)          | Pick a conversation up after the process stops   |
| [Usage and cost](https://providerkit.dev/guides/usage/)                 | Reconciling cache tokens, cost, savings          |
| [Sign in to a subscription](https://providerkit.dev/guides/auth/)       | Device code and PKCE sign-in, token refresh      |
| [Decision models](https://providerkit.dev/guides/decisions/)            | Typed choices, scores and yes/no probabilities   |
| [Speech](https://providerkit.dev/guides/speech/)                        | Text to one audio clip, one paid request a call  |
| [Transcription](https://providerkit.dev/guides/transcription/)          | A recording to its text, with who spoke when     |

The [API reference](https://providerkit.dev/reference/) is generated from the source, so it
cannot drift either.

## Origin

This was extracted from five production codebases that had each independently grown the same
layer: about 9,100 lines solving one ~2,000-line problem. They had three separate
60-second idle watchdogs, identical down to the constant. On one day in September 2026, two
of them shipped the same five fixes independently.

They had also each learned a _different_ part of the problem. One walked the `cause` chain
for dead sockets; one parsed Gemini's `RetryInfo`; one read the body before the status and
knew the quota wordings in five languages; one knew Anthropic's `529` and when a failure is
worth a different model; one could rescue an answer from a tool call the model truncated.

The classifier here is the union of all five, and the suite is every failure any of them
ever saw. That is the part worth having.

## In production

This is not a plan, it already happened. Four of the five codebases serve production traffic
through this package today, and the migrations that put it there were net-negative every time:
**−452, −1,621 and −197 lines** in the first three. The last one, `@falai/agent` v3, trades three
vendor SDKs for this package (−5,033 more) and ships with the release that carries this section.

## Repo

```
core/     the npm package `@providerkit/core`
agents/   the separate `@providerkit/agents` SDK
react/    `@providerkit/react`, experimental chat hooks and components
site/     providerkit.dev (Astro + Starlight), also open source
brand/    the mark, the OG card, and the generator for both
```

Run `bun install`, then `bun run build`. See [AGENTS.md](./AGENTS.md) for the layout and package
checks. Run only the test file relevant to your change; the full suite is a separate manual check.

## Status

Working and tested (1,077 tests): the seam, the error classifier, retry and backup-model
fallback, the watchdog and its wrapper, structured output on all four shapes, cost math, the
fetch/SSE transport, tool-argument salvage, the Anthropic, OpenAI-shape, Responses and Gemini
adapters, the multi-key rotation pool, rate-limit reset windows, the tool kernel, schema
clamping, the compaction decisions, history repair, `collectTurn`, the gate on calls at once,
the registry, and subscription sign-in (`@providerkit/core/auth`).

That is the whole extraction, and the claim it rests on is that an adopting codebase gets
**smaller**. Four migrations in, it has held every time. If a repo grows on adopting this, the
boundary was drawn in the wrong place.

## License

MIT
