---
title: Agents
description: Run model-driven tasks and saved workflows while your app keeps control of permissions and storage.
---

Give an agent a task:

```ts
await assistant.run("List the tasks.");
```

[Set up this offline assistant](/agents/getting-started/). It returns two example tasks without
calling a live model.

**Agents 0.2.0** is an experimental package built on Core. It runs tools, coordinates specialists
and records execution so your host can save and resume work. Its API may change before 1.0.

## Build the execution you need

Use an agent when a model should choose the next tool. Use a [workflow](/agents/workflows/) when
your code chooses the steps. Both share child execution, request handling and tree-wide limits.

- Start with [conversation input and media](/agents/conversations/) and [tools and guards](/agents/tools/).
- Ask the person a [question or approval](/agents/requests/), then continue from an authorized answer.
- Add [specialists or model-created helpers](/agents/specialists/), with capabilities your host grants.
- Keep [memory](/agents/memory/) in a store your app controls.
- Let a model combine tools in [bounded code mode](/agents/code-mode/), or connect [MCP tools](/agents/mcp/).
- Call or serve [remote agents through A2A](/agents/a2a/).
- Check behavior with [evals](/agents/evals/) and observe execution with [tracing](/agents/tracing/).

## What stays in your app

You decide who may run a tool, approve it or resume saved work. Snapshots contain private input
and execution data. Keep them out of browser responses and use [React's server projector](/react/transport/)
for the fields a viewer may see.

The main entry has no database, queue or vendor SDK dependency. [Background runs](/agents/background-runs/)
use your existing run service, not an SDK scheduler. A checkpoint or idempotency key alone does
not prove that an interrupted external action did not happen.

Core owns provider routing and stream retries. Agents adds explicit policies for
[execution recovery and tool retries](/agents/recovery/), without silently replaying unknown work.

## Upgrade from 0.1

Use Core `^0.33.1`. Finish old runs before upgrading: format-2 snapshots are not accepted by the
format-3 runtime. Replace the old single approval decision with the request-keyed host contract.
Execution trees can contain `agent`, `workflow` and `remote` nodes; check `kind` before reading
model journals or workflow steps.

[Browse the API](/reference/agents/) or [run a complete example](/examples/#agents-examples).
