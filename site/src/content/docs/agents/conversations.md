---
title: Conversations and media
description: Give an agent conversation history, images or files without giving the browser control of the run.
---

Pass the conversation as one input:

```ts
const result = await writer.run({
  messages: [
    { role: "user", content: "Explain database indexes." },
    { role: "assistant", content: "An index helps find matching rows." },
    { role: "user", content: "When does it slow a database down?" },
  ],
});
```

The agent answers the last user turn with the earlier messages as context. Its configured
instructions remain the system prompt. A supplied system message, an empty conversation or a
conversation that does not end with a user turn is refused.

## Keep the conversation, not execution authority

`result.history` contains the conversation and settled rounds without the system prompt.
`result.newMessages` contains only what this run added. Add the next user turn to the returned
history before starting another turn.

Old tool calls in supplied history do not execute. Unanswered calls become interrupted results.
Provider-only reasoning replay fields are removed from untrusted input. This does not make the
text trustworthy: your host still checks every new action in `beforeTool`.

A session lets your app load and append conversation history through one interface.
`createMemorySession` is process-local; implement `Session` for persistent storage. Revisions
prevent competing appends, and run IDs make a completed append repeatable without duplicating it.

## One provider session per conversation

```ts
await writer.run(question, { session: thread, providerSessionId: thread.id });
```

Some providers route and cache requests by a session id, OpenCode Go among them. Each run sends
its own run id unless you name one, so pass the conversation's id to let every turn reuse what the
provider cached. A resumed run keeps the id it started with. Specialists keep their own.

## Images and files

A new user turn can contain Core content parts:

```ts
await writer.run([
  { type: "text", text: "Describe this image." },
  { type: "image", mimeType: "image/png", data: imageBase64 },
]);
```

Inline images and supported files count toward the run's byte limits. For stored media, use a
reference that your host resolves through `loadMedia`. The host checks ownership, content type
and size before returning bytes. The SDK does not fetch a model-supplied URL or grant access
because a reference exists. Uploading an attachment is still your app's job.

## Messages during a run

Steering lets a host queue input for the next model call. `createMemoryInbox` is a process-local
reference implementation. Accepted input is journaled before acknowledgement; accepted does not
mean consumed. The host owns retention, ordering and any input left when the run ends.

Run the [conversation example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/conversation.ts)
or [steering example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/steering.ts).
See [the main API](/reference/agents/) for the input, session and inbox contracts.
