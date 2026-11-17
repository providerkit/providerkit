---
title: Agents API
description: The two public entry points in @providerkit/agents 0.1.0.
---

These signatures describe the experimental **@providerkit/agents 0.1.0** release, not the next
release's development branch. [The quickstart](/agents/getting-started/) runs its offline example.

| Import path                | Use                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `@providerkit/agents`      | [Define an agent](/reference/agents/index/functions/defineagent/) and coordinate specialists   |
| `@providerkit/agents/runs` | [Bind an agent to a host run service](/reference/agents/runs/functions/createbackgroundagent/) |

[Browse all generated exports](/reference/agents/readme/). Core `^0.30.0` is the peer supported by
Agents 0.1. The `/runs` entry also needs `@gusnips/server` `^0.19.0`.

A run result tells you whether work completed, failed, was cancelled, hit a limit or awaits
approval. Check the status before using its output. Your host still owns authorization,
checkpoint storage and recovery policy.

See [package boundaries](/concepts/package-boundaries/) before connecting these APIs to a browser.
