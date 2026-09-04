---
title: Getting started
description: Install providerkit, stream your first completion, and understand where the package stops and your loop begins.
---

```bash
bun add @providerkit/core   # npm / pnpm / yarn all fine
```

Zero runtime dependencies. `fetch` only — no vendor SDKs, no Node built-ins — so the same build
runs in Node 22+, Bun, Deno, Cloudflare Workers and a Chrome MV3 service worker.

## A first stream

```ts
import { createAnthropicProvider, drainStream } from "@providerkit/core";

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-5",
});

const stream = provider.createStream([{ role: "user", content: "Say hi." }], []);

for await (const chunk of stream) {
  if (chunk.content) process.stdout.write(chunk.content);
  if (chunk.usage) console.log("\n", chunk.usage);
}
```

`createStream(messages, tools, opts?)` is the whole provider surface. Every adapter returns the
same [`ProviderChunk`](/guides/providers/) sequence, so nothing downstream of it knows which
vendor answered.

If you only want the finished text, `drainStream` collects one:

```ts
const { text, usage, finishReason } = await drainStream(stream, "claude-sonnet-5");
```

Before this shape of code ships, wrap the provider once:

```ts
import { withWatchdog } from "@providerkit/core";

const guarded = withWatchdog(provider); // same Provider, both silent failures handled
```

A stream that stops sending now fails as a retryable `timeout` instead of hanging forever, and a
turn that completes having said nothing fails instead of showing an empty answer.
[Streaming](/guides/streaming/) has the details.

## Swapping the vendor

An OpenAI-shaped provider is the same call with a different factory. `baseUrl` points it at any
OpenAI-compatible endpoint — OpenRouter, DeepSeek, Groq, Together, LM Studio, Ollama:

```ts
import { createOpenAIProvider } from "@providerkit/core";

const provider = createOpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-5",
  baseUrl: "https://openrouter.ai/api",
  id: "openrouter", // names the provider in errors and logs
});
```

Everything downstream is unchanged. That is the point of the seam.

## What this package is not

It is **not** an agent framework. There is no loop, no prompt templates, no graph, no memory
abstraction, no chain. Your loop is where your product actually lives — the approval gates, the
sub-agents, the terminal-submit rules — and every one of those differs per app.

What is here is everything _underneath_ that loop: the provider seam, the error taxonomy, retry
and fallback, the idle watchdog, the tool kernel, compaction decisions, and cost maths.

## Where to go next

- [The provider seam](/guides/providers/) — the shapes every adapter speaks.
- [Errors](/guides/errors/) — the thirteen kinds, and why status codes are not enough.
- [Retries and fallback](/guides/retries/) — including the one rule that matters for streams.
