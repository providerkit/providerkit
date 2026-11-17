---
title: Agents
description: Give an agent instructions, a Core provider and tools, then run a task.
---

An agent calls a model, runs the tools it requests and returns an answer. **Agents 0.1.0** is an
experimental package built on Core. Its API may change before 1.0.

```ts
await assistant.run("List the tasks.");
```

[Set up this offline assistant](/agents/getting-started/). Its result contains two example tasks.
No API key is needed.

## What you can do

Keep a provider, instructions and tools in one agent definition. Check a result with your own
validator. Call a configured specialist as a tool, or coordinate several children with
`defineDelegation`. Save checkpoints through your host and resume authorized work.

The main entry has no database, queue or vendor SDK dependency. The optional `/runs` entry binds
an agent to the host's existing run service. It does not create a worker or queue for you.

## What stays in your app

You decide who may run a tool, who may approve it and who may resume saved work. Snapshots can
contain prompts, tool arguments and results. Store them privately and keep them out of browser
responses. A checkpoint cannot prove that an interrupted external action did not happen.

Provider routing, deadlines and retry policy stay in [Core](/core/). The agent uses the provider
you give it without adding another provider retry loop.

Start with the [quickstart](/agents/getting-started/), look up the
[0.1 API](/reference/agents/) or run the [published examples](/examples/#agents-examples).
