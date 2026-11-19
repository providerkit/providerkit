---
title: Specialists and helpers
description: Delegate a task, hand off a conversation or let a model propose a bounded helper.
---

Run the offline specialist example:

```sh
bun node_modules/@providerkit/agents/examples/subagents.ts
```

The [complete source](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/subagents.ts)
uses scripted providers and real SDK child execution. It makes no paid model calls.

## Choose who controls the next step

A configured agent's `asTool` lets a parent call it for a result. `defineDelegation` lets ordinary
async code coordinate registered specialists, including parallel and background children.
All admitted children share the root's limits, checkpoints and host binding. A child is not an
independent distributed job with its own lease.

A handoff transfers the conversation to another registered agent. Use `defineHandoff`; the
active target validates its own output, including checked output. Handoffs run alone and are not
remote A2A targets. `conversationOnly` provides the normal conversation transfer rather than
copying private execution state.

A specialist's local limit or failure can return a failed tool result to its parent. Root budget
exhaustion, suspension, cancellation and integrity failures still halt the tree. A child's calls
count toward its parent's cost limit (`limits.costUsd`), and a child stops before its next call
once that budget is spent.

## Let the model propose a helper

`subagentTool` accepts model-written instructions and a task, then asks the host for a grant.
The host selects the permitted model, capabilities and limits. The model cannot grant a tool,
choose another memory scope or supply authorization through its instructions.

The admitted definition is saved. Resume rebuilds it from the current registered template and
checks its identity. Reuse the same tool objects for the creator and helper template: matching
names alone do not prove they are the same capability.

## Give a helper context deliberately

Fresh, task-only context is the default. A fork needs a bounded host filter selecting safe
conversation messages. System prompts, old tool rounds and private reasoning do not cross that
boundary automatically.

A named follow-up uses an opaque helper handle scoped to the same creator, specialist and root.
It is consumed once. Changed grants, unfinished work and competing admissions are refused rather
than silently attached to an arbitrary saved run.

## Show activity without exposing the journal

Use [React's projector](/react/transport/) for child identity and safe activity rows. Child text
and tool output are private unless the host selects them. Do not invent model turns to display a
workflow or remote child.

See [the handoff example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/structured-handoff.ts),
[remote agents](/agents/a2a/) and [the public API](/reference/agents/).
