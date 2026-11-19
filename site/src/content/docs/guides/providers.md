---
title: The provider seam
description: The provider-neutral message, chunk and tool shapes that every adapter translates to and from.
---

Every adapter translates to and from exactly these shapes, so your loop and your tests never see
a vendor type.

These are deliberately **not** OpenAI's parameter types. Using one vendor's dialect as the lingua
franca means the Anthropic and Gemini adapters round-trip through a shape that is not theirs, and
the mismatches leak out as bugs.

## The interface

```ts
interface Provider {
  readonly id: string;
  readonly model: string;
  createStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: StreamOptions,
  ): AsyncIterable<ProviderChunk>;
}
```

## Messages

```ts
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string;
      reasoning?: string;
      reasoningDetails?: unknown[]; // OpenRouter's opaque reasoning payload
      toolCalls?: ToolCall[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; images?: ImagePart[] };
```

`reasoning` on an assistant turn is not decoration. Thinking-mode providers demand it echoed
verbatim. DeepSeek returns a 400 on a tool-call turn that arrives without its `reasoning_content`,
so the loop has to commit it even though the UI treats reasoning as display-only.

The mirror of that rule: a turn with thinking **disabled** must not carry reasoning. Use
`stripReasoning(messages)` before sending one.

A user turn's parts are text, images and files. A file is a PDF, a recording or a video, sent as
base64 bytes with its media type:

```ts
{ type: "file", mimeType: "application/pdf", data: pdfBase64 }
```

Only the Gemini adapter sends a file. Gemini takes up to 100 MB of inline data per request, and
50 MB for a PDF (documented, Gemini API "File input methods", read 2026-09-27). The base64 text is a
third larger than the file. The other adapters throw an `invalid` `ProviderError` that names the
adapter and the media type, before any request goes out. They never drop the file, because the
model would then answer about a file it never saw. A `FallbackPool` doesn't pass an `invalid` error
on to the next provider, so send a request with a file to a Gemini provider directly.

Some backends fail the whole request over one image they won't take. The `grok` preset knows its
backend's limits: each side at least 8 px, an area of at least 512 px², and at most 5 MB once
decoded. It replaces any other image with a note the model reads, like
`[image omitted: image/webp] (unreadable dimensions for image/webp)`, so the turn still runs. WebP
always gets a note, because its size can't be checked. Only the last 4 images in a request are
sent. To apply the same check in your own adapter, call `gateImages(messages, limits)`.

`gateImages` takes two options. `toolResultsOnly: true` checks and counts only the images in tool
results, and leaves the person's own images as they are, so pruning old screenshots never takes
the attachment the task is about. `reason` puts one reason in every note. For a model that reads
no images, pass `maxImages: 0` and a reason that says so:

```ts
gateImages(
  messages,
  { minSide: 0, minArea: 0, maxDecodedBytes: Infinity, maxImages: 0 },
  { reason: "this model reads text only" },
);
```

Every image then becomes `[image omitted: image/png] (this model reads text only)`, with its own
media type.

## Chunks

```ts
interface ProviderChunk {
  type: "delta" | "usage" | "finish";
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
}
```

Tool calls arrive as `ToolCallDelta` fragments. Providers stream arguments a few characters at a
time, so a call is only complete at the `finish` chunk. You don't have to put them back together:
`collectTurn` reads the turn to the end and returns the assistant message to append, with each
call joined from its fragments and the calls in `index` order.

```ts
import { collectTurn } from "@providerkit/core";

const turn = await collectTurn(provider.createStream(history, tools));
history.push(turn.message); // turn.message.toolCalls holds the calls to run
```

:::caution[Usage chunks are cumulative on some providers and final-only on others]
Take the **last** one, never the sum. `collectTurn` and `drainStream` already do this.
:::

### Reasoning that must ride back

```ts
interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  thoughtSignature?: string; // Gemini's opaque reasoning token
}
```

Gemini returns an opaque signature alongside a tool call, and it must go back **verbatim** on
the next turn. Drop it and the model resumes from a chain of thought that no longer contains
the call it just made. It re-plans, and often re-issues the tool call you already answered.

Nothing else in the seam is opaque, so it is the one field a store must round-trip without
understanding. If your history layer normalises tool calls, keep this field.

`reasoningDetails` is OpenRouter's normalized version of the same idea: its reasoning payload,
arriving on the stream and going back verbatim as `reasoning_details` on the next turn. Same
contract: opaque, provider-owned. `collectTurn` keeps it on the message it returns, and
`drainStream` on the `Completion`; `stripReasoning`
drops it along with `reasoning`, because a thinking-off turn must not carry either half of the
record.

`reasoningItems` is the ChatGPT backend's version: its encrypted reasoning items, sent once at the
end of a turn as `{ provider, items }`. The `chatgpt` preset asks for them
(`include: ["reasoning.encrypted_content"]`) and sends them back on the next turn, newest first, up
to 8 MiB. Only the provider that made them gets them back. After a fallback to another provider they
are dropped, because another vendor would reject them. Keep them on the assistant message, like
`reasoningDetails`. `stripReasoning` drops them too. Go and Grok don't ask for them, because they
may refuse `include`.

## Options

```ts
interface StreamOptions {
  model?: string; // override the bound model for this call
  effort?: Effort; // "none" | "low" | "medium" | "high" | "max"
  maxTokens?: number; // thinking and the answer SHARE this ceiling
  temperature?: number; // not sent to Gemini, which fixes its own sampling
  topP?: number; // set this OR temperature, not both; not sent to Gemini
  stopSequences?: string[]; // no equivalent field on the Responses shape
  signal?: AbortSignal;
  toolChoice?: ToolChoice;
  json?: JsonOutput;
  serviceTier?: "priority" | "flex"; // OpenAI and Responses shapes only
}
```

`serviceTier` is sent as `service_tier`: `priority` is faster and costs more, `flex` is slower and
costs less. You can also set it once on a provider, and a per-call value wins. Anthropic and Gemini
refuse it with an `invalid` error. Anthropic's own `service_tier` means something else, and Gemini
has no such switch.

`effort` is mapped, not passed through. On OpenAI-shape it becomes `reasoning_effort`. On
Anthropic-shape it depends on the model id:

- Current Claude models get adaptive thinking, with the level in `output_config.effort`. Some of
  them can't stop thinking at all (Claude Fable 5.1 and Opus 5.5, for example), so there `"none"`
  sends the lowest level, `low`. Adaptive thinking has no budget of its own and shares `maxTokens`
  with the answer, so give it a large `maxTokens` at `high` and `max`.
- Claude 4.5 and older, and other vendors' Anthropic-compatible endpoints, get a thinking budget
  in output tokens. It always stays below `maxTokens`, because a budget at or above that ceiling
  leaves no room to answer and the turn ends mid-thought.
- On Claude 4.5 and older, only the first request of a tool loop thinks. The requests that send
  tool results back run without thinking, and the next user turn thinks again. These models need
  a thinking request's last assistant turn to start with a thinking block, and the adapter doesn't
  send thinking blocks back (documented, Anthropic Thinking page, read 2026-09-27).
- On Claude 4.5 and older, a request that forces a tool (`toolChoice: "required"` or `{ name }`)
  also runs without thinking. On these models, forcing a tool with thinking on is an error, so the
  tool you asked for wins (documented, same page).

`toolChoice` goes out in each wire's own field, with two exceptions.

Claude Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5, and any Claude model newer than the adapter
knows, answer a forced tool (`"required"` or `{ name }`) with a 400 on every request (documented,
Anthropic Thinking page, read 2026-10-01). So the adapter sends them no `tool_choice`, which means
`auto`, as that page advises. `"required"` goes out with every tool, and `{ name: "save" }` with
the `save` tool alone, so the model can't call a different one. Either way it can still answer in
text, so check for the tool call.

OpenCode Go's Muse Contributor (`muse-spark-1.3-contributor`) accepts only `auto` and answers any
other choice with a 400, which no retry or backup model gets past. So the adapter says what it can
in the tool list:

- `"none"` is sent as no tools.
- `{ name: "save" }` is sent as the `save` tool alone, with no `tool_choice`. It is the only call
  the model can make, but it can still answer in text, so say in the prompt that you need the
  call. If `save` is not in the call's tools, the call fails with an `invalid` error before any
  request.
- `"required"` can't be said that way, because every tool under `auto` is the request you'd get
  by leaving the choice out. It is still sent, and Muse refuses it with an `invalid` error. The
  same goes for `{ name: "save" }` when `save` is the only tool you pass. For a structured answer,
  ask for it with `json` instead.

## Structured output

`json` asks for a schema-constrained answer. On the OpenAI shapes it rides the native schema mode,
and `isStrictSchema` decides whether OpenAI's strict mode is requested. Strict demands every
listed property be required and every object closed with `additionalProperties: false`, all the
way down, so a schema with one optional field would otherwise 400 the request. Pass `json.strict`
to overrule that guess. Anthropic has no schema mode, so the schema rides in the prompt as an
extra system block, placed after the cached one. Gemini takes it via `responseJsonSchema`.

Whatever the shape, the seam never guarantees the JSON, so validate the answer regardless. `json`
only decides whether the request is accepted.

Models also wrap their JSON: a fence, a sentence before it, notes after it. `parseJsonAnswer(text)`
reads it out of all of those:

````ts
parseJsonAnswer('Here you go:\n```json\n{"ok": true}\n```'); // { ok: true }
````

It takes the first fenced block marked `json` or not marked at all. The JSON may start on the fence
line itself, right after the `json`; any other text there, like a title, is skipped. With no fence,
it takes the text from the first `{` or `[` to the bracket that closes it. A fence counts only at
the start of a line, so a JSON value that holds a code sample comes back whole. It returns
`unknown`, because parsed is not validated. When there is no JSON to read, it throws a
`JsonAnswerError`, whose `text` holds the first 2,000 characters of the answer.

### When the same call also carries tools

A model that cannot serve a schema and a tool call at once does not tell you. Its decoder is pinned
to the schema, so the tool call has nowhere to go and the model writes the announcement instead:
_"let me look that up for you"_. Then the turn ends. Nothing is logged, because nothing failed. It
reads as a model with no initiative, and no amount of prompting fixes it.

Measured 2026-09-07, one request, sampled:

| model                    | response format | schema in the prompt |
| ------------------------ | --------------- | -------------------- |
| `z-ai/glm-5.3-flash`     | 0/10            | 8/8                  |
| `z-ai/glm-5.3`           | 0/5             | -                    |
| `deepseek-v4-flash-0731` | 0/5             | -                    |
| `gemini-3.8-flash`       | 3/10            | -                    |
| `gemini-3.5-flash-lite`  | 10/10           | 6/6                  |
| `gpt-5.6-luna`           | 10/10           | 6/6                  |
| `qwen3.8-flash`          | 10/10           | 1/6                  |

`jsonWithTools: "prompt"` drops the response format from the calls that carry tools and sends the
schema as prompt instead. That is what the Anthropic adapter has always done, which is why this cannot
happen there. Calls without tools keep the format, where it is strictly better. It works the same
way on the Gemini adapter, and `StreamOptions.jsonWithTools` overrides it per call.

No default is right for everyone, and the qwen row is the whole argument: it is as broken by the
prompt as GLM is by the format. So don't read it off a model card. Ask the model:

```ts
const probe = await probeJsonWithTools(provider);
// { use: "prompt", calls: { response_format: 0, prompt: 3 }, samples: 3 }
if (!probe.use) throw new Error(`${model} cannot use tools with a schema at all`);
```

Six short calls, once, at whatever moment you choose to ask. Boot is the usual one. Log `calls`
rather than just `use`: `0/3 and 3/3` is what makes the next model swap's regression obvious.

It catches the structural failure: the model that _cannot_ emit the call, on the easiest question
there is. A model that is merely unreliable passes: `gemini-3.8-flash` answers the probe 3/3 and a
real turn 3/10. That is the right line. A harder probe would start failing good models for being
terse, and "sometimes forgets its tools" is a prompt problem, not a wire shape one.

## Adapters

| Factory                   | Shape                   | Notes                                                                                  |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `createAnthropicProvider` | Anthropic Messages      | any compatible endpoint via `baseUrl`; `bearer: true` moves the key to `Authorization` |
| `createOpenAIProvider`    | OpenAI Chat Completions | any compatible endpoint via `baseUrl`; `providerOrder` and `pinHost` route pins        |
| `createResponsesProvider` | OpenAI Responses        | `replayReasoning` sends encrypted reasoning back; also serves the ChatGPT backend      |
| `createGeminiProvider`    | Gemini REST             | no SDK; thought signatures survive tool turns, thoughts bill as output, Gemini 3 dials |

On the OpenAI-shape adapter, `effortDialect` names which spelling of _think this hard_ the endpoint
accepts: `openai`, `openrouter`, `deepseek`, or `off` for one that rejects the field outright. It
is inferred from the provider `id` where the name gives it away.

### Prompt caching on the Anthropic shape

Anthropic caches only the parts of a request that carry a cache marker (`cache_control`), and the
adapter places the markers for you. A request carries up to three:

- On your last system message. Anthropic caches tools first, then the system prompt, so this one
  marker covers both. A request with no system message has nothing to mark here. The schema block
  that `json` adds never gets this marker, so a schema that changes between calls leaves the
  cached prompt as it was.
- On the newest message. Each request writes a cache entry there.
- On the message just before the newest assistant message. That is where the previous request
  ended, so this request reads that entry exactly. The first request of a tool loop has no
  assistant message yet, so it gets the marker on its newest message but not this one.

The message markers go only on a request that another one will follow: one that declares tools,
or one whose messages already hold an assistant turn. A one-shot call, like a title or a summary,
marks no message, because nothing would read the entry it paid to write. If it has no system
message either, it carries no marker at all, and nothing in it is cached.

One marker on the newest message is not enough on its own. A read looks back at most 20 blocks
from a marker for an entry an earlier request wrote. On the Claude API a run of tool calls counts
as one block, and so does a run of tool results, but a turn that adds more than 20 still misses.
The marker where the previous request ended makes that read exact.

A marker goes on the last block that can carry one. Thinking blocks can't, and neither can text
that is empty or only spaces and line breaks, so the marker moves back to an earlier block in the
same message, or that message gets none. Markers sit on blocks only, never on the request's
top-level `cache_control` field, because the legacy Bedrock integration answers that field with a 400.

Anthropic's [prompt caching page](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
(read 2026-11-19) gives the costs. A 5-minute cache write bills 1.25 times the input rate. A read
bills a tenth of it, or less on the newest models. A prefix shorter than the model's minimum (512
tokens on the newest models, up to 4,096 on older ones) is not cached and not billed as a write.
Other Anthropic-shape endpoints, such as Kimi, Z.ai, Qwen and OpenCode's Claude routes, get the
same markers. How each of them caches has not been checked.

Each system message becomes its own system block, in order, with the marker on the last. So a line
you add first stays the first block. A blank system message is left out, because Anthropic refuses
a block of only spaces and line breaks.

### OpenRouter sticky routing

OpenRouter's prompt cache lives on the upstream host's account. Default routing hops between hosts
on every request, which drops the cache and inflates latency and token costs.

By default, the OpenAI adapter automatically pins the model's first-party vendor host (`pinHost: true`,
`allow_fallbacks: true`) via `openRouterHostFor`. If you want to supply your own preference order:

```ts
createOpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "z-ai/glm-5.3-flash",
  baseUrl: "https://openrouter.ai/api",
  providerOrder: ["z-ai", "deepinfra"], // explicit upstream pin
});
```

### OpenRouter data policy

`dataCollection: "deny"` sends OpenRouter's `provider.data_collection`, so the request only goes to
hosts that, by OpenRouter's records, don't train on your prompts. Some of them still keep prompts
for a while: OpenRouter's separate `zdr` setting is what rules that out. It rides with the
route pin or alone, and only to openrouter.ai. If a model has no such host, OpenRouter answers 404
instead of sending the request anywhere else. Leave it unset and your account's setting applies.

```ts
createPresetProvider("openrouter", {
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "z-ai/glm-5.3-flash",
  dataCollection: "deny",
});
```

### OpenRouter output ceiling

When you set no `maxTokens`, the `openrouter` preset sends `max_tokens: 32000`. Without a ceiling,
OpenRouter prices each paid call before it starts as if the answer could run to a cap of its own,
and a low balance answers 402. On 2026-09-10 it priced the model's whole window: a call to
`z-ai/glm-5.3-flash` that needed a few thousand tokens was refused for 131,072.
[OpenRouter's limits page](https://openrouter.ai/docs/api-reference/limits) now says it counts "a
fixed per-request cap" when you send no `max_tokens`, and gives no value, so the ceiling lowers
that estimate only while the cap is above 32,000. It always stops a runaway: one adopter saw a single answer run to 131,072 tokens.
32,000 is about twice that adopter's p99 over 60 days (16,389 tokens on GLM 5.3 Flash). Its
longest real answer was 33,429 tokens, which would stop at the ceiling, so give long work a higher
`maxTokens`.

Set a lower `maxTokens` for a long prompt. The ceiling has to fit in the context window beside the
prompt, so on a model with a 131,072-token window, a prompt over about 99,000 tokens fails as
`context`. A `models` chain or a `fallbacks` list doesn't move on to its next model for that kind.
The preset's own models have windows of 500,000 tokens or more.

Set one too on a model that can't write that much. OpenRouter sends a call only to hosts that can
write a reply that long
([provider routing](https://openrouter.ai/docs/features/provider-routing)), so a model whose
every host stops sooner can't take the call. On 2026-11-19 that was 57 of the 479 models
OpenRouter listed, `openai/gpt-4o-mini` (16,384) among them. Every host of every model the preset
lists writes 65,536 or more.

```ts
createPresetProvider("openrouter", { apiKey, model: "openai/gpt-4o-mini", maxTokens: 16_384 });
```

Thinking shares the ceiling with the answer. With `effort` set, OpenRouter sizes some models'
thinking from it: 80% of it at `high` on Claude
([reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)).
A `createOpenAIProvider` pointed at OpenRouter sends no ceiling unless you set one.

### Curated presets and `createPresetProvider`

Instead of hand-crafting `baseUrl`, header styles, and dialect quirks per vendor, you can instantiate
any of the 48 curated presets directly:

```ts
import { createPresetProvider } from "@providerkit/core";

// One line: wire headers, auth mode and endpoints resolve from the table
const zai = createPresetProvider("zai", { apiKey: process.env.ZAI_API_KEY! });
const qwen = createPresetProvider("qwen", { apiKey: process.env.DASHSCOPE_API_KEY! });
const deepseek = createPresetProvider("deepseek", { apiKey: process.env.DEEPSEEK_API_KEY! });
```

Endpoints supporting both Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`) wires are
explicitly distinguished (e.g. `zai` vs `zai-openai`, `qwen` token plan vs `qwen-token-plan-openai`).

Four preset options cover what a vendor needs beyond a key:

- `baseUrl` replaces the preset's API root, for a vendor that gives each account its own host.
- `replayReasoning` sends the model's encrypted reasoning back on the next turn. Only `chatgpt` turns
  it on. Go and Grok may refuse the `include` field it needs.
- `initiatorHeader` sends `X-Initiator` (`user` or `agent`) on every call. Only `github-copilot`
  uses it, because GitHub bills a premium request per `user` turn.
- `noSampling` drops `temperature` and `top_p` from every call. Only `google-openai` uses it,
  because Gemini fixes its own sampling and its next models answer those fields with an error.

### Subscription presets

Five presets take a short-lived token from a sign-in, not an API key. Pass the token as `apiKey`.
[`@providerkit/core/auth`](/guides/auth/) gets and renews it.

| Preset           | Signs in as         | Sign-in flow     |
| ---------------- | ------------------- | ---------------- |
| `chatgpt`        | ChatGPT             | `chatgpt`        |
| `grok`           | Grok (SuperGrok, X) | `grok`           |
| `kimi-plan`      | Kimi plan           | `kimi-plan`      |
| `github-copilot` | GitHub Copilot      | `github-copilot` |
| `claude`         | Claude plan         | none yet         |

`claude` takes a token you got another way, because `createAuthFlow` has no Claude flow. The `meta`
and `openrouter` flows have no subscription preset of their own. `openrouter` gives you a key for
the keyed `openrouter` preset.

### Declaring cross-provider fallbacks by preset ID

When building resilience pools, fallbacks can be declared by preset ID using `FallbackSpec`:

```ts
createPresetProvider("zai", {
  apiKey: process.env.ZAI_API_KEY!,
  fallbacks: [
    { preset: "openrouter", apiKey: process.env.OPENROUTER_API_KEY!, model: "z-ai/glm-5.3-flash" },
    { preset: "deepseek", apiKey: process.env.DEEPSEEK_API_KEY!, model: "deepseek-flash" },
  ],
});
```

### Four dialects, not four companies

The table names wire shapes. Nothing in it is bound to the company that invented the shape, and
that matters more every year: OpenRouter, DeepSeek, GLM, Kimi and MiniMax now publish an
Anthropic Messages endpoint beside their OpenAI one, so the same model is reachable through
either adapter. **Pick the adapter that matches the endpoint you are pointing at**, then say
where it lives.

```ts
// GLM through OpenRouter's Anthropic-dialect endpoint
createAnthropicProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "z-ai/glm-5",
  baseUrl: "https://openrouter.ai/api", // + /v1/messages
  bearer: true, // these read Authorization, not x-api-key
  siteUrl: "https://your.app", // -> HTTP-Referer, for OpenRouter's rankings
  siteName: "Your App", // -> X-Title
});
```

`siteUrl` / `siteName` work on the OpenAI shape and the Anthropic shape, directly or through
`createPresetProvider`, and ride every request whenever they are set. The Gemini and Responses
shapes ignore them. A raw entry in `headers` always wins over them.

Three fields cover the difference between one host and another: `baseUrl`, `headers`, and on the
Anthropic shape `bearer`. There is no base class to extend and no vendor list to be absent from;
a host that ships next month works the day it ships. What the adapters do NOT do is guess: a
dialect's optional corners (`tool_choice` forcing, `count_tokens`, thinking blocks) are uneven
across gateways, so a switch is worth one real tool-calling turn against the new host.

`bearer` is about where the credential rides, not what kind it is. Two unrelated cases want it:
a gateway that reads `Authorization` instead of `x-api-key`, and a **subscription backend**:
Claude or ChatGPT signed in as a person rather than billed per token. Those carry an OAuth
access token that expires and rotates. [`@providerkit/core/auth`](/guides/auth/) signs in and
renews it for ChatGPT, Kimi, Grok, GitHub Copilot, Meta and OpenRouter. Your app still stores the
token and shows the sign-in screens. Give one its own `id`, because a 401 there means
_sign in again_, not _bad API key_, and a ledger that cannot tell them apart will retry the one
that no amount of retrying fixes.

## Bringing your own envelope

The four adapters go through `streamSse`, which is one `fetch`, one classified error and one SSE
reader. Some apps can only take the last of those three. An extension with translated failure
copy, its own log levels, or a token refresh in front of every request has to build the request
and read the failure itself, but it should not be writing a fourth SSE parser to do it.

```ts
import { parseFrame, parseSseStream } from "@providerkit/core";

const res = await myFetchWithAuth(url, init);
if (!res.ok) throw myOwnTranslatedError(res); // your envelope, your wording
for await (const payload of parseSseStream(res.body!)) {
  handle(parseFrame(payload, "my-gateway"));
}
```

It yields each frame's `data:` payload: frames split on the blank line the spec requires (so a
payload containing a newline survives), CRLF normalised, continuation lines joined, and the final
frame emitted even when the stream ends without its trailing blank line. `[DONE]` is not yielded:
it ends the stream. Comments and empty frames, which is how vendors send keep-alives, are dropped.

So a payload that reaches your loop and isn't JSON is a lost piece of the turn, not a keep-alive.
`parseFrame` throws a `network` error for it, the same as a socket that dies mid-read, so the
turn fails instead of passing with a delta, a tool call or its finish missing.

It also yields a bare JSON object appended **outside** the framing, because Gemini reports a
mid-stream failure that way. Dropped, a 429 that lands after the headers reads as an empty,
successful turn.
