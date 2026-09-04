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
verbatim — DeepSeek returns a 400 on a tool-call turn that arrives without its `reasoning_content`
— so the loop has to commit it even though the UI treats reasoning as display-only.

The mirror of that rule: a turn with thinking **disabled** must not carry reasoning. Use
`stripReasoning(messages)` before sending one.

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

Tool calls arrive as `ToolCallDelta` fragments to be assembled by `index`. Providers stream
arguments a few characters at a time, so a call is only complete at the `finish` chunk.

:::caution[Usage chunks are cumulative on some providers and final-only on others]
Take the **last** one, never the sum. `drainStream` already does this.
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
the call it just made — it re-plans, and often re-issues the tool call you already answered.

Nothing else in the seam is opaque, so it is the one field a store must round-trip without
understanding. If your history layer normalises tool calls, keep this field.

`reasoningDetails` is OpenRouter's normalized version of the same idea — its reasoning payload,
arriving on the stream and going back verbatim as `reasoning_details` on the next turn. Same
contract: opaque, provider-owned. `drainStream` keeps it on the `Completion`; `stripReasoning`
drops it along with `reasoning`, because a thinking-off turn must not carry either half of the
record.

## Options

```ts
interface StreamOptions {
  model?: string; // override the bound model for this call
  effort?: Effort; // "none" | "low" | "medium" | "high" | "max"
  maxTokens?: number; // thinking and the answer SHARE this ceiling
  temperature?: number;
  topP?: number; // set this OR temperature, not both
  stopSequences?: string[]; // no equivalent field on the Responses shape
  signal?: AbortSignal;
  toolChoice?: ToolChoice;
  json?: JsonOutput;
}
```

`effort` is mapped, not passed through. On OpenAI-shape it becomes `reasoning_effort`; on
Anthropic-shape it becomes a thinking budget in output tokens, always clamped below `maxTokens`,
because a budget at or above the ceiling leaves no room to answer and the turn ends mid-thought.

## Structured output

`json` asks for a schema-constrained answer. On the OpenAI shapes it rides the native schema mode,
and `isStrictSchema` decides whether OpenAI's strict mode is requested — strict demands every
listed property be required and every object closed with `additionalProperties: false`, all the
way down, so a schema with one optional field would otherwise 400 the request. Pass `json.strict`
to overrule that guess. Anthropic has no schema mode, so the schema rides in the prompt as an
extra system block, placed after the cached one. Gemini takes it via `responseJsonSchema`.

Whatever the shape, the seam never guarantees the JSON — validate the answer regardless. `json`
only decides whether the request is accepted.

## Adapters

| Factory                   | Shape                   | Notes                                                                                  |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `createAnthropicProvider` | Anthropic Messages      | any compatible endpoint via `baseUrl`; `bearer: true` moves the key to `Authorization` |
| `createOpenAIProvider`    | OpenAI Chat Completions | any compatible endpoint via `baseUrl`; `providerOrder` pins OpenRouter upstreams       |
| `createResponsesProvider` | OpenAI Responses        | reasoning items replay across turns; also serves the ChatGPT subscription backend      |
| `createGeminiProvider`    | Gemini REST             | no SDK; thought signatures survive tool turns, and thoughts bill as output             |

On the OpenAI-shape adapter, `effortDialect` names which spelling of _think this hard_ the endpoint
accepts — `openai`, `openrouter`, `deepseek`, or `off` for one that rejects the field outright. It
is inferred from the provider `id` where the name gives it away.

`providerOrder` exists for cache warmth, not preference. OpenRouter's prompt cache lives on the
upstream host's account, and default routing hops between hosts — every hop is a cold cache,
which costs both latency and input tokens. Fallbacks stay enabled; it is a preference, not a lock.

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
  headers: { "http-referer": "https://your.app" },
});
```

Three fields cover the difference between one host and another — `baseUrl`, `headers`, and on the
Anthropic shape `bearer`. There is no base class to extend and no vendor list to be absent from;
a host that ships next month works the day it ships. What the adapters do NOT do is guess: a
dialect's optional corners (`tool_choice` forcing, `count_tokens`, thinking blocks) are uneven
across gateways, so a switch is worth one real tool-calling turn against the new host.

`bearer` is about where the credential rides, not what kind it is. Two unrelated cases want it:
a gateway that reads `Authorization` instead of `x-api-key`, and a **subscription backend** —
Claude or ChatGPT signed in as a person rather than billed per token. Those carry an OAuth
access token that expires and rotates, so the login and the refresh stay in your app; the
package only ever sees the resulting bearer. Give one its own `id`, because a 401 there means
_sign in again_, not _bad API key_, and a ledger that cannot tell them apart will retry the one
that no amount of retrying fixes.

## Bringing your own envelope

The four adapters go through `streamSse`, which is one `fetch`, one classified error and one SSE
reader. Some apps can only take the last of those three. An extension with translated failure
copy, its own log levels, or a token refresh in front of every request has to build the request
and read the failure itself — but it should not be writing a fourth SSE parser to do it.

```ts
import { parseSseStream } from "@providerkit/core";

const res = await myFetchWithAuth(url, init);
if (!res.ok) throw myOwnTranslatedError(res); // your envelope, your wording
for await (const payload of parseSseStream(res.body!)) {
  handle(JSON.parse(payload));
}
```

It yields each frame's `data:` payload: frames split on the blank line the spec requires (so a
payload containing a newline survives), CRLF normalised, continuation lines joined, `[DONE]`
swallowed, and the final frame emitted even when the stream ends without its trailing blank line.

It also yields a bare JSON object appended **outside** the framing, because Gemini reports a
mid-stream failure that way — dropped, a 429 that lands after the headers reads as an empty,
successful turn.
