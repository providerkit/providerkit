---
title: Transport and display data
description: Connect commands and observation to your app without exposing private execution state.
---

Validate an incoming display event:

```ts
const event = parseChatEvent(value);
```

It returns a typed event or `null`, never a partially trusted object. Import the parser, display
types and `reduceChat` from `@providerkit/react/protocol`; that entry needs no React runtime.

## Separate commands from observation

`ChatTransport` supports sending a message, observing updates, stopping work and responding to
requests. A host may stream the send response, create a run and expose a separate event stream,
or use its own message channel. The client does not require a conversation database or HTTP.

`createSseTransport` on `/sse` uses Core's public stream parser. You choose URLs, cursor placement
and the `fetch` implementation. Return `text/event-stream` for event streams. Authentication and
token refresh remain in your app.

Commands are not automatically replayed. A send or answer can have an accepted or unknown delivery
outcome. Idempotency keys help identify a request; the host still has to enforce its meaning.

## Keep identities separate

Conversation ID, logical run ID, physical segment and observer generation serve different jobs.
The display envelope carries version `v: 1` and optional `seq`/`segment`. A new worker segment
resets the replay cursor without creating another conversation. Old observations must not update
a view after its account, conversation or segment changes.

Messages and parts have stable IDs. Text, activity, requests, sources and approved custom data use
one display model. Unknown event types are skipped, and malformed known events are rejected.

## Project SDK state on the server

Use `createAgentProjector` from `@providerkit/react/agents` with explicit `runId` and `messageId`.
Feed authorized SDK events through `event` and checkpoints through `snapshot`. It imports public
SDK contracts but does not execute agents, authenticate a request or own a route.

By default, the viewer sees text from the root and from the agent that takes over the conversation in a handoff. Text from other specialists is hidden. Set `text: (source) => source.root` to show only root text, or `text: () => false` to show none. The filter applies to live events and saved runs.

Tool arguments and results, reasoning, code logs and raw failure messages stay private. Host callbacks select safe tool details, requests, structured output and other display parts. Do not spread a raw snapshot into JSON.

Workflow steps remain steps. Code calls retain `parentOperationId`, and remote nodes retain their
registered identity and last peer state. A local stop yields an unknown remote outcome when the
peer has not confirmed completion. A wake time is display data, not permission to resume.

## Recover with the data you have

Mounted clients resume after their cursor. A fresh projector can rebuild from retained events,
then reconcile with a saved snapshot. The SDK does not provide an atomic snapshot-plus-tail
watermark. A host that only polls can send snapshots without patches.

End of stream is not success. Keep received output and offer a reconnect when it can work.
[Recovery and drafts](/react/recovery/) explains gaps, unconfirmed commands and local state.
