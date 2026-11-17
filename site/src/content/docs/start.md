---
title: Start here
description: Choose the provider calls, agent loop or chat screen your app needs.
---

## Call models with Core

Use Core when you need streaming answers, tool calls or the same error handling across providers.
You can keep your existing agent loop.

```ts
isTransient("overload"); // true
```

[Import this function](/guides/errors/#try-it-in-your-code), then follow the
[Core quickstart](/guides/getting-started/) to call a model.

## Run tasks with Agents

Use Agents when you want a loop that calls a model, runs its tools and returns a checked result.
Core handles the provider underneath it.

```ts
await assistant.run("List the tasks.");
```

The [offline quickstart](/agents/getting-started/) supplies `assistant` and returns two example
tasks without an API key. Agents 0.1.0 is experimental; check the result status before using its output.

## Follow the React chat package

React is being built for browser state, hooks and optional chat components. It is not published
yet. [Read the development overview](/react/) and follow the public chat example work.

## Choose only what you need

- Already have an agent loop? [Use Core](/core/).
- Need a shared model/tool loop? [Use Agents](/agents/).
- Diagnosing a provider failure? [Try the error classifier](/demos/errors/).
- Connecting a browser to a server? [Read the package boundaries](/concepts/package-boundaries/).
