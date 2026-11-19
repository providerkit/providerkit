---
title: Examples
description: Run a complete example with its package, runtime and required services stated beside it.
---

## Core examples

[Classify a failure in the browser](/demos/errors/) without a key, model call or upload.
For a live provider call, follow [the Core quickstart](/guides/getting-started/); that request may
be billed. [Hosted tools](/guides/tools/#hosted-tools), [speech](/guides/speech/) and
[transcription](/guides/transcription/) also use the provider's paid services.

## Agents examples

These files ship in Agents 0.3.0. Start with this offline command:

```sh
bun node_modules/@providerkit/agents/examples/basic.ts
```

It returns two example tasks. [The quickstart](/agents/getting-started/) gives the install command.
Replace the filename to run another standalone sample:

| File                    | What it shows                                            |
| ----------------------- | -------------------------------------------------------- |
| `basic.ts`              | A scripted provider calling a real tool                  |
| `specialists.ts`        | Registered specialists and ordered child results         |
| `conversation.ts`       | Conversation input and sessions                          |
| `steering.ts`           | Accepted input consumed at the next model boundary       |
| `structured-handoff.ts` | A handoff whose active target validates its result       |
| `guardrails.ts`         | Blocking checks before protected work                    |
| `workflow.ts`           | Saved steps, requests and suspension                     |
| `subagents.ts`          | Model-created helpers under host grants                  |
| `memory.ts`             | Scoped facts in a process-local reference store          |
| `a2a-server.ts`         | A local workflow served through an in-process A2A client |
| `a2a-remote.ts`         | A remote node with recorded sends and unknown billing    |
| `evals.ts`              | Repeatable scenarios, mocks and scripted answers         |
| `otel.ts`               | Closed SDK/Core spans recorded without an exporter       |
| `code-mode.ts`          | Real QuickJS running a bounded tool program              |

[Read the release-matched source](https://github.com/providerkit/providerkit/tree/340d8af/agents/examples).
Tracing needs its optional API peer; code mode needs its optional engine peers. These samples use
local data and scripted providers, not paid models. Replacing a scripted provider with a live one
sends real requests and may cost money.

`background.ts` is different: it shows where your real run service, queue and trusted policy
connect. It is host setup code, not a standalone demo. Read [background runs](/agents/background-runs/)
before connecting it to storage.

## React examples

[Try the chat components](/demos/chat/) with sample responses. The page uses the released package,
not a lookalike composer or reducer. [The quickstart](/react/getting-started/) shows a real host
transport and [the component guide](/react/components/) shows a controlled chat panel.

The [complete local example](https://github.com/providerkit/providerkit/tree/340d8af/react/examples/chat)
uses a Bun server, public SDK execution and both SSE and a custom transport. It covers questions,
client actions, reconnects, drafts, workflow/code activity and remote status. Run it from a source
checkout as described in [its README](https://github.com/providerkit/providerkit/blob/340d8af/react/README.md#run-the-local-example).
No application credentials or paid provider are needed.
