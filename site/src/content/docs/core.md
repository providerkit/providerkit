---
title: Core
description: Call models, stream answers and handle provider failures with @providerkit/core.
---

Core calls providers and handles their failures. Use it under your own loop or with
[Agents](/agents/). This site documents **0.35.0**.

```ts
isTransient("overload"); // true
```

[Import and run this function](/guides/errors/#try-it-in-your-code).
It reports whether a kind of failure can pass with time, not whether a particular request is safe to replay.

## Make a provider call

[The quickstart](/guides/getting-started/) installs Core and streams a first answer. The main entry
uses `fetch`, with no runtime dependencies or vendor SDKs. It runs in Node 22+, Bun, Deno,
Cloudflare Workers and Chrome MV3 service workers.

Keep secret keys on a trusted server unless the person supplies their own key in a local app.

## Find the part you need

| Job                                           | Guide                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Switch providers without rewriting your loop  | [Providers](/guides/providers/) and [registry](/guides/registry/)     |
| Diagnose a failure                            | [Errors](/guides/errors/) and the [classifier demo](/demos/errors/)   |
| Retry without repeating a partial answer      | [Retries](/guides/retries/)                                           |
| Stop stalled calls and cap concurrency        | [Streaming](/guides/streaming/) and [limits](/guides/limits/)         |
| Run your tools or provider-hosted tools       | [Tools](/guides/tools/)                                               |
| Fit a long conversation into a model's window | [Context](/guides/context/)                                           |
| Restore messages after an interruption        | [Provider history](/guides/resume/)                                   |
| Measure usage                                 | [Usage and cost](/guides/usage/)                                      |
| Make or transcribe audio                      | [Speech](/guides/speech/) and [transcription](/guides/transcription/) |

## Optional entries

Import only the capability you use. [The Core reference](/reference/core/) lists the import paths,
including `/hosted` for provider-run tools and `/otel` for opt-in OpenTelemetry tracing.
Core does not own your prompts, permissions, agent loop or stored conversations.

Continue with [examples](/examples/) or [package boundaries](/concepts/package-boundaries/).
