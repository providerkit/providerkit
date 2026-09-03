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
  | { role: "assistant"; content: string; reasoning?: string; toolCalls?: ToolCall[] }
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

## Options

```ts
interface StreamOptions {
  model?: string; // override the bound model for this call
  effort?: Effort; // "none" | "low" | "medium" | "high" | "max"
  maxTokens?: number; // thinking and the answer SHARE this ceiling
  signal?: AbortSignal;
  toolChoice?: ToolChoice;
  json?: JsonOutput;
}
```

`effort` is mapped, not passed through. On OpenAI-shape it becomes `reasoning_effort`; on
Anthropic-shape it becomes a thinking budget in output tokens, always clamped below `maxTokens`,
because a budget at or above the ceiling leaves no room to answer and the turn ends mid-thought.

## Adapters

| Factory                   | Shape                   | Notes                                                                            |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `createAnthropicProvider` | Anthropic Messages      | `bearer: true` sends a subscription token instead of `x-api-key`                 |
| `createOpenAIProvider`    | OpenAI Chat Completions | any compatible endpoint via `baseUrl`; `providerOrder` pins OpenRouter upstreams |

`providerOrder` exists for cache warmth, not preference. OpenRouter's prompt cache lives on the
upstream host's account, and default routing hops between hosts — every hop is a cold cache,
which costs both latency and input tokens. Fallbacks stay enabled; it is a preference, not a lock.
