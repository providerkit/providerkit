---
title: Agents API
description: Public entry points in @providerkit/agents 0.2.0, grouped by the work they do.
---

These signatures match the experimental **@providerkit/agents 0.2.0** release. Use Core
`^0.33.1`. [Start with the offline quickstart](/agents/getting-started/) or
[browse generated exports](/reference/agents/readme/).

| Import path                             | Use                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `@providerkit/agents`                   | Agents, requests, specialists, sessions and host-backed memory            |
| `@providerkit/agents/runs`              | Bind execution to an existing host run service                            |
| `@providerkit/agents/workflow`          | Saved workflow steps and typed child execution                            |
| `@providerkit/agents/code-mode`         | Bounded programs over registered tools                                    |
| `@providerkit/agents/code-mode/quickjs` | Optional QuickJS driver                                                   |
| `@providerkit/agents/a2a`               | Remote agents, serving, protocol codecs and explicit signing/push helpers |
| `@providerkit/agents/mcp`               | Recorded, allowlisted MCP tools                                           |
| `@providerkit/agents/evals`             | Offline scoring, scenarios, mocks and explicit model judges               |
| `@providerkit/agents/otel`              | Optional execution tracing composed with Core provider spans              |

## Optional peers

`/mcp` uses `@modelcontextprotocol/sdk` `^1.32.2`. `/otel` uses `@opentelemetry/api` `^1.10.0`.
The QuickJS driver uses `quickjs-emscripten-core` and the release-sync wasm package at `^0.32.0`.
Normal SDK imports load none of those integrations.

The host-run binding supports `@gusnips/server` `^0.19.0 || ^0.20.0 || ^0.21.0`; awaited progress
specifically requires 0.21's `Run.append`. The A2A entry and its process-local run binding need
no optional server package.

## Read outcomes before using output

A result can be completed, suspended, cancelled, limited or failed. Check its status. Execution
trees contain agent, workflow and remote nodes, each with its own journal shape. A remote
receipt with unknown billing is not a local model usage record.

Host authorization, checkpoints and retention remain outside the package. See
[package boundaries](/concepts/package-boundaries/) before connecting execution to a browser.
