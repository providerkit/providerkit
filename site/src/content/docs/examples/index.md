---
title: Examples
description: Start with a runnable task, with the package, runtime and setup stated beside it.
---

## Core examples

**Classify a failure in your browser.** [Run the local example](/#example) or
[try a response body in the classifier](/demos/errors/). No API key, model call or upload.

**Stream a model's answer.** [Follow the Core quickstart](/guides/getting-started/).
Run it on Node or Bun with a provider key. It makes a live request that may be billed.

**Use a provider's tools.** [Configure hosted search or image generation](/guides/tools/#hosted-tools).
Run it in trusted code with a provider that serves that tool. Provider charges apply.

**Make or transcribe audio.** The [speech](/guides/speech/) and
[transcription](/guides/transcription/) guides show the call and returned data. These are paid
requests, not browser demos. Core does not automatically replay ambiguous failures.

## Agents examples

These sources match the released Agents 0.1 implementation.

**Run one agent offline.** [The quickstart](/agents/getting-started/) gives the install and run
commands. The [basic source](https://github.com/providerkit/providerkit/blob/7891647/agents/examples/basic.ts)
uses a scripted provider and returns two example tasks. No API key.

**Ask two specialists.** With the same installed package, run:

```sh
bun node_modules/@providerkit/agents/examples/specialists.ts
```

The [specialist source](https://github.com/providerkit/providerkit/blob/7891647/agents/examples/specialists.ts)
runs offline and returns the children's notes in order. No model calls.

**Connect background work.** Read the
[host-run integration example](https://github.com/providerkit/providerkit/blob/7891647/agents/examples/background.ts).
It shows where your existing run service, queue and trusted policy connect. It is host setup code,
not a standalone command or a hosted demo.

## React example work

[The local chat example under development](/react/) will be the source for the site's chat demo
when the package is published. Today, use Core or Agents behind your existing conversation screen.
