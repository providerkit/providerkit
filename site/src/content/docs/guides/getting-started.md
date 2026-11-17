---
title: Core quickstart
description: Install Core, stream a first answer and choose whether to keep your own loop or use Agents.
---

```ts
isTransient("overload"); // true
```

[Import this helper](/guides/errors/#try-it-in-your-code), or continue below to make a provider call.
The helper runs locally. A provider call needs a key and may be billed.

## Install Core

```bash
bun add @providerkit/core
```

Zero runtime dependencies. `fetch` only, with no vendor SDKs and no Node built-ins, so the same build
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

If you only want the finished answer, `drainStream` collects one. Give it a new stream: the one
above was already read, and a stream can be read only once.

```ts
const { text, toolCalls, usage, finishReason } = await drainStream(
  provider.createStream([{ role: "user", content: "Say hi." }], []),
  "claude-sonnet-5",
);
```

`toolCalls` holds the calls the model asked for, put back together and in order, and is empty when
it asked for none. In an agent loop, use `collectTurn` instead. It returns the assistant message
itself, ready to append to your history:

```ts
import { collectTurn } from "@providerkit/core";

const turn = await collectTurn(provider.createStream(history, tools));
history.push(turn.message);
for (const call of turn.message.toolCalls ?? []) history.push(await runTool(call));
```

Before this shape of code ships, wrap the provider once:

```ts
import { withWatchdog } from "@providerkit/core";

const guarded = withWatchdog(provider); // same Provider, both silent failures handled
```

A stream that stalls now fails instead of hanging forever. Whether its timeout can be retried
depends on when the response started and whether anything was emitted. A turn that completes
without an answer also fails. Reasoning alone does not count as an answer.
[Streaming](/guides/streaming/) has the details.

## Swapping the vendor

An OpenAI-shaped provider is the same call with a different factory. `baseUrl` points it at any
OpenAI-compatible endpoint: OpenRouter, DeepSeek, Groq, Together, LM Studio, Ollama.

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

## Choose your loop

Core handles provider calls, errors, retry policy, stream deadlines, tools and usage. It does not
choose your prompts or run an agent loop.

Keep your own loop, or use [Agents](/agents/) for a shared model/tool loop with specialists and
checkpoints. Either way, your app owns permission checks and stored data. See
[package boundaries](/concepts/package-boundaries/).

## Where to go next

- [The provider seam](/guides/providers/): the shapes every adapter speaks.
- [Set up providers once](/guides/registry/): name each provider and its key once, then ask for
  one by name.
- [Errors](/guides/errors/): the thirteen kinds, and why status codes are not enough.
- [Retries and fallback](/guides/retries/): including the one rule that matters for streams.
