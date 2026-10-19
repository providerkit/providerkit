---
title: Set up providers once
description: Name each provider and its credential once per app, then ask for one by name. What you get back already has the watchdog, the fallback chain and the limit on calls at once.
---

Most apps build the same block at startup: a provider per vendor from env, a watchdog on each, a
few of them chained into a fallback pool, and the pool kept alive so it remembers which models are
down. `createRegistry` builds all of that from one config.

```ts
import { createRegistry } from "@providerkit/core";

const providers = createRegistry({
  connections: { go: { preset: "opencode-go", apiKey: process.env.OPENCODE_API_KEY! } },
});

const provider = providers.get("go");
```

`provider` is an ordinary `Provider`. Call `createStream` on it like any other, as in
[Getting started](/guides/getting-started/). `go` is a connection: a name you pick for one preset
and one credential.

`get("go")` runs every model the connection has, in order. With no `model` or `models` set,
`opencode-go` uses its own list: `mimo-v2.6-flash`, then `mimo-v2.5`, `glm-5.3-flash`, `qwen3.8-flash` and
`longcat-2.0`. Each model has its own watchdog. The models sit in one fallback pool: when one
fails before it sends anything, the pool benches it for a while and the next one answers.

Calling `get` on every request is fine. Each chain is built once, the first time a call needs it,
and then shared.

## Refs

A ref is the string you pass to `get`. It names what to run.

| Ref                  | Runs                                        |
| -------------------- | ------------------------------------------- |
| `"go/glm-5.3-flash"` | one model on the connection `go`            |
| `"go"`               | every model on `go`, in order               |
| `"default"`          | a chain: a named list of refs, run in order |

A ref splits at the first `/`. Everything after it is the model id, slashes included, so
`"openrouter/xiaomi/mimo-v2.6-flash"` asks the `openrouter` connection for
`xiaomi/mimo-v2.6-flash`.

A bare connection runs the first of these that it has: its `models`, its `model`, the preset's own
list, or the preset's default model.

```ts
const providers = createRegistry({
  connections: {
    go: { preset: "opencode-go", apiKey: goKey, headers: { "user-agent": "my-app" } },
    openrouter: { preset: "openrouter", apiKey: openRouterKey },
  },
  chains: {
    default: ["go/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash"],
  },
});

const provider = providers.get("default", { effort: "high", maxTokens: 8_000 });
```

A model listed twice in a chain runs once, at its first place. A chain can't name another chain:
list its refs instead.

Effort and `maxTokens` go in the second argument of `get`, never in the ref. They apply to every
call on that provider, and a call that sets its own wins.

`get` throws on a name it doesn't know, and the message lists the names it does.
`createRegistry` throws at startup on a bad config, for example an unknown preset, a chain with no
refs, or a connection with no model whose preset has no default either.

### One model gets no pool

`get("go/glm-5.3-flash")` returns that one model with nothing around it but its watchdog (and its
gate, below). A pool of one would bench the only option after one blip, so a 503 that a retry
fixes in a second would turn into 30 seconds of instant failures.

### The model comes from the ref

A provider from `get` refuses a per-call `model` with an `invalid` error, before any request goes
out. Ask the registry for that model instead: `providers.get("go/glm-5.3-flash")`.

## Credentials

Each connection takes exactly one of `apiKey`, `keys` or `token`. With none, or more than one,
`createRegistry` throws.

```ts
const providers = createRegistry({
  connections: {
    go: { preset: "opencode-go", apiKey: goKey },
    gemini: { preset: "google", keys: { keys: [freeA, freeB], paidKey } },
    chatgpt: { preset: "chatgpt", token },
  },
});
```

`apiKey` is one key, sent on every call.

`keys` takes the same options as a `KeyPool`. The free keys take turns, the paid key goes last,
and a key that fails is benched for a time that fits the failure:
[Limits and key pools](/guides/limits/) has the table. One pool serves every model on the
connection, so a benched key is benched for all of them.

`token` is a `TokenSource` from `@providerkit/core/auth`. Each call reads a token that works now,
and a 401 before any output renews it and sends the call once more.
[Sign in to a subscription](/guides/auth/) shows how to make one.

A key pool and a token both build a new adapter for every call. The registry gives each model one
session id that every rebuild keeps, so on `opencode-go` and `chatgpt` a call without its own
`sessionId` stays on one session and keeps its prompt cache.

## Calls at once

```ts
const providers = createRegistry({
  connections: { go: { preset: "opencode-go", apiKey: goKey, maxConcurrent: 2 } },
});
```

`maxConcurrent` caps how many calls run at once on a connection. Flat-rate plans have a cap like
this and only tell you by failing: six calls at once on one Z.ai Coding Plan key got some 429s back
(measured 2026-09-25). In a chain, those failures go to the next model, so the cap shows up as a
quietly different answer, not as an error.

The cap is shared by every chain and every provider from `get` that uses the connection. Calls
past it wait in line, first in first out. A full connection makes callers wait. It does not move
them to the next model.

Time in line doesn't count against the watchdog: its clocks start once the call has a slot. A call
whose signal aborts leaves the line. A slot comes back when its stream ends or throws, when you
`break` out of reading it, or when its signal aborts.

The count covers this process only. Two servers each let `maxConcurrent` calls through.

## The watchdog

Every model gets one by default, with the package's clocks: 60 s with no byte, or 300 s with no
chunk, and the call fails as a `timeout`. It also fails a turn that ends without an answer.
[Streaming and the watchdog](/guides/streaming/) has the details. Each model has its own, so a model
that goes quiet times out and the next one in the chain answers.

`watchdog: false` turns it off, and `watchdog: { idleMs: 120_000 }` changes a clock. Set either on
a connection or on the registry. A connection's own setting replaces the registry's.

Don't wrap a provider from `get` in `withWatchdog`. A clock around the whole chain would cancel the
chain, not just the model that went quiet.

## Changing a connection while running

```ts
providers.update("go", { preset: "opencode-go", apiKey: newKey });
providers.remove("openrouter");
```

`update` adds a connection or replaces one. A provider you got from `get` before the update sends
the new key on its next call, so you don't need to `get` it again. `remove` deletes a connection,
and a chain that names it fails on its next call.

When the new config equals the old one, `update` does nothing, so you can call it every time you
re-read your config. Plain objects and arrays count as equal when their contents are. Functions
and every other object count as equal only when they are the same one. So make `onEvict`,
`fetchImpl` and the `TokenSource` once and keep them in constants:

```ts
import type { KeyPoolOptions } from "@providerkit/core";

// Made once, so every re-read hands over the same function.
const onEvict: KeyPoolOptions["onEvict"] = (info) => log.warn("benched a key", info);

function onConfigReload(config: AppConfig) {
  providers.update("gemini", { preset: "google", keys: { keys: config.geminiKeys, onEvict } });
}
```

A new function counts as a change even when it does the same thing. A change rebuilds the
connection, and the rebuild drops what it learned: each model's cooldown and each key's bench. The
gate stays when `maxConcurrent` didn't change, because calls in flight still hold its slots.

## What the registry knows

```ts
providers.status();
// {
//   go: {
//     gate: { max: 2, held: 1, waiting: 0 },
//     candidates: [
//       { ref: "go/glm-5.3-flash", retryAtMs: 1760900400000, kind: "rate", probing: false },
//     ],
//   },
//   openrouter: {
//     candidates: [{ ref: "openrouter/z-ai/glm-5.3-flash", retryAtMs: 0, probing: false }],
//   },
//   gemini: {
//     keys: [
//       { tier: "free", evictedUntil: 0 },
//       { tier: "free", evictedUntil: 1760900460000 },
//       { tier: "paid", evictedUntil: 0 },
//     ],
//     candidates: [],
//   },
// }
```

`status()` has one entry per connection.

- `gate` is there when the connection sets `maxConcurrent`: `held` calls are running and `waiting`
  calls are in line.
- `keys` is there when it uses `keys`. Each key shows its tier and when it is back, where 0 means
  it is serving now. The key itself is never shown, so you can put this on a status page as is.
- `candidates` has one entry per model built so far. A model is built the first time a ref needs
  it. `retryAtMs` is when its bench ends, or 0 when it has none. A time already past means its
  next call is the test call that lifts the bench, and `probing` is true while that call runs.
  `kind` says why it was benched, and `window` says which subscription window ran out when the
  vendor named one.

To hear about a bench when it happens, pass `fallback.onCooldown`:

```ts
const providers = createRegistry({
  connections,
  fallback: {
    onCooldown: ({ ref, kind, retryAtMs }) =>
      log.warn(`${ref} benched for ${kind} until ${new Date(retryAtMs).toISOString()}`),
  },
});
```

Read `ref`, not the provider's `id`. Two connections on one preset, like two OpenCode Go accounts,
share the `id` `opencode-go`, on the provider and in `chunk.source`. Only the ref
(`"work/glm-5.3-flash"`) tells them apart.

`fallback` also takes the pool options, like `cooldownMs` and `probeStaleMs`. They are set once for
the whole registry, because every chain shares one record of benches: a model benched in one chain
is benched in every chain that lists it.
