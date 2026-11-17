---
title: Package boundaries
description: Choose what belongs in provider calls, agent execution, a browser view and your app.
---

Use the smallest part you need. Core works without Agents. Agents uses Core. React can display
your app's data without owning its agent engine or state store.

| Part               | What it does                                           | What you supply                                               |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| [Core](/core/)     | Calls providers, reads streams and classifies failures | Credentials, models, prompts and retry policy                 |
| [Agents](/agents/) | Runs agents and workflows, recording their execution   | Instructions, tools, permission checks and checkpoint storage |
| [React](/react/)   | Shows conversations and sends browser actions          | Authorized display data and an app transport                  |
| Your app           | Owns the person, the data and the effects of a task    | Sign-in, authorization, uploads, billing and retention        |

## Keep trusted work on the server

Provider credentials and tools with privileged access belong in trusted code. Core can also run
in a local app or extension when the person supplies their own credentials.

An execution snapshot can contain prompts, tool arguments, results and provider metadata.
Do not send it to a browser as a chat response. Select the text and activity the person is allowed
to see. Validate each incoming browser command against the signed-in person and current server state.

## A loop is not a host

Agents can save a checkpoint through a host callback. Your app must store it, check its owner and
prevent two workers from continuing it at once. The optional `@providerkit/agents/runs` binding uses
an existing run service; it does not supply a queue or deploy a worker.

See [retry, resume and reconnect](/concepts/retry-resume-reconnect/) before wiring recovery, and
[tools and permissions](/concepts/tools-and-permissions/) before allowing actions with side effects.
