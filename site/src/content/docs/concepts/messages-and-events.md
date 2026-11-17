---
title: Messages and events
description: Provider history, saved agent work and visible conversation messages have different jobs.
---

A model request, a saved run and a chat screen need different data. Do not use one as a substitute
for the others.

## Provider history

Core `ChatMessage` values are the conversation sent to a provider. They include roles, content, tool
calls and tool results. Some providers also need reasoning metadata or signatures returned on a
later turn. Keep the complete message when [saving provider history](/guides/resume/).

History repair makes that sequence valid to send. It does not tell you whether an interrupted
tool action happened.

## Saved execution and progress

Agents records execution in kind-specific journals: model/tool operations for agents, steps for
workflows and remote receipts for A2A nodes. Its host can save checkpoints to continue trusted
work later. Progress events follow a live run; they do not replace the saved state.

A completed output is only one possible result. A run can be waiting for approval, stopped by a
limit, cancelled or failed. [The Agents quickstart](/agents/getting-started/#read-the-result)
shows the status check.

## What a person sees

A conversation screen needs the answer, useful activity and actions the person can take. It does
not need raw snapshots, private reasoning or every tool argument. Your server decides which data
may leave it.

[React's display protocol](/react/transport/) separates visible messages from execution state.
The server validates and projects the allowed fields, then the browser folds those display events
into its view. Data that describes a request does not authorize its answer.
