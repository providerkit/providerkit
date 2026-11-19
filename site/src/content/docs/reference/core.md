---
title: Core API
description: Import paths and generated signatures for @providerkit/core 0.35.0.
---

These signatures describe **@providerkit/core 0.35.0**. Start with the
[quickstart](/guides/getting-started/) for a working provider call.

| Import path                       | Exports                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@providerkit/core`               | [Providers, messages, tools, errors and stream helpers](/reference/core/readme/)                             |
| `@providerkit/core/hosted`        | [Providers and registries with hosted tools enabled](/reference/core/hosted/functions/createpresetprovider/) |
| `@providerkit/core/otel`          | [withProviderTracing](/reference/core/otel/functions/withprovidertracing/)                                   |
| `@providerkit/core/zod`           | [Zod tool helpers](/reference/core/zod/functions/zodtool/)                                                   |
| `@providerkit/core/decisions`     | [Decision models](/guides/decisions/)                                                                        |
| `@providerkit/core/speech`        | [Speech synthesis](/guides/speech/)                                                                          |
| `@providerkit/core/transcription` | [Audio transcription](/guides/transcription/)                                                                |
| `@providerkit/core/auth`          | [Sign-in and token refresh](/guides/auth/)                                                                   |

The Core API sidebar lists the generated symbols under each entry. Optional entries may need a
peer package; the main entry does not load them.

## Hosted tools

`/hosted` supplies provider and registry factories that opt into vendor-run work, such as web
search or image generation. The plain chat factories do not load its encoders or parsers. Use the
[hosted-tools guide](/guides/tools/#hosted-tools) to configure a provider call. These results do
not become local tool calls for your app to execute.

## OpenTelemetry tracing

`/otel` exports `withProviderTracing`. Wrap a provider with an OpenTelemetry tracer to record chat
spans. It requires the optional `@opentelemetry/api` peer. It does not install an exporter or send
traces by itself.

Prompts, output, reasoning and tool arguments are excluded. See
[ProviderTracingOptions](/reference/core/otel/interfaces/providertracingoptions/) for the fields
and content policy. Your app owns the tracer, exporter and retention.

## Tool result metadata

`Tool.outputSchema` is optional JSON Schema metadata for a tool's result. Core keeps it on the
tool instance, not in the provider's tool definition. It does not validate results with it.
Validate your runtime output where your app needs that guarantee.
