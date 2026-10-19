---
title: Resume after a crash
description: Save each message as the turn makes it, repair the history when you load it, and send the conversation again on the same session. What this package covers, and what stays with your job runner.
---

A process can stop in the middle of an agent turn: a deploy, a crash, a restart. When it comes
back, the conversation is wherever your store left it, maybe with a tool call that never got its
result. This guide covers how to save that history so it can be sent again, using pieces this
package already has.

## Save each message as it happens

```ts
import { collectTurn } from "@providerkit/core";

const turn = await collectTurn(provider.createStream(history, tools.definitions(), { sessionId }));
await save(conversationId, turn.message);

for (const call of turn.message.toolCalls ?? []) {
  const result = await runTool(call); // your code: invoke the tool, build the `tool` message
  await save(conversationId, result);
}
```

`collectTurn` reads one turn to the end and gives you the assistant message to append, as it is:
the text, the reasoning, and the tool calls put back together from their fragments. Save it before
you run its tools, then save each tool result as it comes back. A crash then loses at most the
step that was running: the turn being streamed, or the tool being run.

Save the message whole. `reasoning`, `reasoningDetails`, `reasoningItems` and each call's
`thoughtSignature` go back to the provider on the next request. DeepSeek answers a tool-call turn
that lacks its reasoning with a 400, and Gemini without its signature forgets the call it just
made. [The provider seam](/guides/providers/) has the rest.

A turn that dies mid-stream saves nothing. `collectTurn` returns only once the stream has ended,
so a half-written answer never lands in your history. On resume, the last saved message is a user
message or a tool result, and you send the history again.

## Repair what you load

```ts
import { repairHistory, ToolRegistry } from "@providerkit/core";

const tools = new ToolRegistry([readFile, writeFile]);

const { messages, interrupted } = repairHistory(await load(conversationId), {
  isReadOnly: (name) => tools.get(name)?.isReadOnly ?? false,
});
```

A history cut off mid-turn isn't valid to send. A tool call with no result is the usual break, and
every provider answers it with a 400. `repairHistory` fixes that and the other breaks a saved
history can have:

- A call with no result gets one under the same id, saying the call was interrupted.
- A result whose call is missing becomes a user note, so the model can still read it.
- An id used twice becomes `id_2`, `id_3` and so on, for the call and its result together.
- An assistant message with no text and no calls is dropped, so a placeholder you saved before the
  tools ran breaks nothing.

`interrupted` lists the calls that never returned, under the ids the request will carry. Log them,
or tell the user which actions may not have finished.

`isReadOnly` decides what the model reads in place of each missing result. For a read-only tool:
"This call was interrupted before it returned. It changed nothing, so it is safe to call again."
For any other: "This call was interrupted before it returned. It may have partly run, so check its
effect before calling it again." Without `isReadOnly`, every call gets the second one.

A tool counts as read-only only when it says so: `defineTool` sets `isReadOnly` to `false` when you
leave it out. Set `isReadOnly: true` only on a tool that changes nothing.

Send `messages`, the repaired list. Every adapter repairs what it sends anyway, but only your call
knows `isReadOnly`. Repair gives the same bytes for the same history every time, and repairing a
repaired history changes nothing, so the prompt cache keeps hitting.

## Stay on the same session

```ts
const stream = provider.createStream(messages, tools.definitions(), {
  sessionId: conversationId,
});
```

Pass a `sessionId` with every call: the same one for the whole conversation, kept with the
conversation. OpenCode Go routes and caches by it, and the ChatGPT backend uses it as its prompt
cache key. After a restart, the same id sends the resumed conversation back to the session that
holds its prompt cache.

A call without one sends the provider's own id, made up when the provider was built. A restarted
process builds a new provider, so the id changes. `withKeyPool` and `withToken` build a new
provider for every call, so it changes on every call: pass `instanceSessionId` to the preset to
keep them on one id. The [registry](/guides/registry/) does this for you, one id per model.

## Running many conversations at once

After a restart, every conversation that was running wants to resume at the same moment, and they
all hit the same providers together. Cap the calls per connection.

With the registry, set `maxConcurrent` on the connection. See
[Calls at once](/guides/registry/#calls-at-once).

With your own adapters, make one gate per connection and wrap every provider on it:

```ts
import { createGate, withGate, withWatchdog } from "@providerkit/core";

const gate = createGate(4); // one per connection, kept for the life of the process
const provider = withGate(withWatchdog(adapter), gate);
```

Calls past the limit wait in line, first in first out. Put `withGate` outside `withWatchdog`, as
above, so the watchdog's clocks start when the call gets its slot and not while it waits.

## What this package doesn't do

It has no job queue, no lease and no crash detection. It doesn't know which conversations were
running when the process stopped, and it can't stop two workers from resuming the same one. That
is your job runner's work: it records which conversations are in flight, notices when a worker
stops, and hands each conversation to exactly one worker. This package takes over from there,
with the history that worker loads and the calls it sends.
