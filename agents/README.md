# @providerkit/agents

An agent calls a model, runs the tools it requests and returns an answer.
Keep its instructions, provider and tools in one place:

```ts
const result = await writer.run("Explain why a database index speeds up a search.");
```

A completed result has `status: "completed"` and an `output` value. Other results say whether the
run failed, was cancelled, reached a limit or is waiting for input. Check the status before
using the output.

The API may change before 1.0. This package uses `@providerkit/core` for model calls. Its main
entry has no database, queue or vendor SDK dependency and sends no traces to an external service.

## Set up an agent

Install the agent package and core:

```sh
bun add @providerkit/agents @providerkit/core
```

Pass a provider you already configured with core:

```ts
import { defineAgent } from "@providerkit/agents";
import type { Provider } from "@providerkit/core";

export function createWriter(provider: Provider) {
  return defineAgent({
    id: "writer",
    version: "1",
    instructions: "Explain technical topics in short sentences.",
    provider,
  });
}
```

Set up routing, fallback models, provider deadlines and retry policy in core. The agent uses that
provider as supplied; it does not retry a failed live call. Opt-in crash recovery is separate,
as described under checkpoints and recovery.

Change the agent's version when its instructions, tools or result contract change. A saved run
from another version is refused rather than resumed under different rules.

## Model settings

Give the agent an output ceiling, especially on services that reserve the whole context window
when no ceiling is set:

```ts
const writer = defineAgent({
  id: "writer",
  version: "1",
  instructions: "Explain technical topics in short sentences.",
  provider,
  modelSettings: { maxTokens: 2_048 },
});
```

Override settings for one run:

```ts
await writer.run("Explain database indexes.", { modelSettings: { maxTokens: 512 } });
```

`ModelSettings` is core's `StreamOptions` without `signal`, `sessionId` or `json`. The SDK owns
those three: use `RunOptions.signal` to stop, and `output` for checked results. Provider defaults
apply first, agent settings override them, and run settings win last. Unset or `undefined` fields
inherit; `0` and `false` do not. All settings go to every model call. Support still depends on the
provider, which may refuse a setting.

The resolved settings are saved in `snapshot.definition.modelSettings`. Resume cannot change
them. The two observers, `onActivity` and `onRateLimit`, are functions, so they stay in memory
rather than in JSON. After a restart, only observers from the rebuilt agent apply; reattach
progress through `onEvent`.

`toolChoice` accepts `"auto"`, `"none"`, `"required"` or `{ name: "lookup" }`. A named tool must
be enabled. After a tool call, a forced choice becomes `"auto"` for the rest of that run,
including after resume. `"none"` stays `"none"`: calls a provider returns anyway are refused.
A checked-output agent refuses `"none"` at creation because it needs `submit_result` to finish.

## Instructions and tools per run

Build instructions from trusted host context:

```ts
const writer = defineAgent({
  id: "writer",
  version: "1",
  instructions: (run) => `Reply in ${run.context.locale ?? "en"}.`,
  provider,
});
await writer.run("Explain database indexes.", { context: { locale: "es" } });
```

The callback receives a `RunContext`: the agent id and version, run id, prepared history, new
input, host `context` and cancellation `signal`. History and input are frozen copies. Host
services in `context`, such as a database handle, stay in memory and are not saved.

`enabledTools` takes registered tool names or a function that returns them:

```ts
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the records you need, then answer.",
  provider,
  tools: [lookup, update],
  enabledTools: (run) => (run.context.canWrite ? ["lookup", "update"] : ["lookup"]),
});
await reader.run("Find this record.", { enabledTools: ["lookup"] });
```

An empty list disables ordinary tools. The reserved `submit_result` stays enabled when there
is an output contract. A run may narrow the agent's list, never enable a tool its policy disabled.
Tools keep their definition order, which is part of the provider's cached prompt. Disabled tools
are hidden from the model and refused if it calls them anyway, before approval or invocation.
`beforeTool` must still check current access: a saved allow-list is not authorization.

Instructions and tool selection resolve once, after history preparation and before the first
checkpoint. They are saved in `snapshot.definition`, alongside the model settings and stopping
tools. A resumed run uses that record, even if host context changed. It never calls these
functions again. If a function throws, creation throws before any model call or checkpoint.
Keep paid work and effects out of these callbacks: a process that dies before the first save
can call them again.

A specialist resolves its own definition using the shared host context, but never inherits its
parent's run-level model settings or tool selection. Reusing a saved child never resolves it
again.

## Results and progress

```ts
const result = await writer.run("Explain database indexes.", {
  signal: controller.signal,
  onEvent(event) {
    if (event.type === "model_chunk") {
      render(event.chunk.content ?? "");
    }
  },
});

if (result.status === "completed") {
  console.log(result.output);
}
```

The same reader collects the answer and reports progress. An observer failure does not stop the
work. Tool results and provider metadata stay in the recorded history.

When an agent hands work to a specialist (see below), a `child` event arrives before that
specialist's own events. It holds the parent's run ID as `parentRunId`, the delegation's
`operationId`, the child `key`, the specialist's `runId`, and its `agentId` and `version`. Use it
to show a specialist's work under the agent that called it. It carries no status: read that from
the specialist's `state` events or from the snapshot. Like any progress event, it can be missed.
A specialist that resumes after an approval or an interruption sends it again with the same
values, so update the entry you keep for that `runId` and do not add another. A specialist that
already finished is reused and sends nothing.

| Status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `completed` | The answer passed the configured result validator.                         |
| `suspended` | An approval, question or client tool needs a reply.                        |
| `cancelled` | The caller stopped the run. Cancellation does not undo an external action. |
| `limited`   | A turn, tool-call, time or provider output limit stopped the run.          |
| `failed`    | Execution could not continue. Read `error.code` and `error.message`.       |

Reasoning without an answer is not success. A provider's length-limited answer is not accepted as
a complete result. Increase the provider's output allowance when appropriate rather than blindly
repeating a paid request.

## Lifecycle hooks and guards

Use a guard to refuse work or output. Use a hook to observe it. A hook is not permission.

```ts
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the records and answer.",
  provider,
  tools: [lookup],
  guardrails: {
    identity: "reader-policy-1",
    modelInput: ({ messages }) => ({ allow: messages.length <= 100 }),
    modelOutput: (turn) => ({ allow: !turn.message.content.includes("private") }),
    toolOutput: ({ result }) => ({ allow: result.ok }),
  },
});
```

These checks are examples, not a privacy policy. Supply your own checks for your data. Each
callback returns `{ allow: true }` or `{ allow: false }`. Guards never rewrite arguments, replace
results or approve requests. A rejection ends the run with `guard_rejected`; a thrown exception
or malformed verdict ends it with `guard_failed`. The SDK saves no exception text from a guard
and does not ask the model to retry that operation.

| Guard         | Checked value                                                       | Boundary                                                                                                             |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `modelInput`  | `{ messages, tools, settings }`                                     | Every model attempt, after new inbox input and media loading, before the provider call.                              |
| `modelOutput` | Core `Turn`, including reasoning, tool arguments and hosted results | After collection, before progress, recorded model history or local tool dispatch.                                    |
| `toolInput`   | `ToolRequest` with the effective, approved `arguments`              | Before ordinary tools, delegation, handoff or a client request. Core validation and host authorization still follow. |
| `toolOutput`  | `{ request, result }` with the SDK `ToolResult`                     | Before a settled result enters history, progress or terminal state. Includes failed and denied results.              |

`modelOutput` checks every turn, not just the final answer. It also checks the arguments of
`submit_result`. `toolOutput` checks tool-produced content and a stopping tool's recorded
`final.candidate`. It does not recall the model's earlier words or arguments. Use both when
both model and tool output need checks. Result validators still run; a validator's transformed
application object remains the host's responsibility, not a new model response.

With `modelOutput`, no model chunk is published until the verdict passes and its completed
receipt is saved. It then publishes one `model_chunk` containing that checked turn, not the raw
chunks: earlier metadata replaced during collection was not part of the verdict. The SDK collects
at most 4,096 chunks and 1,000,000 UTF-8 JSON bytes per model
attempt. Reasoning, tool arguments and provider metadata count too. Set `maxOutputBytes` to a
positive whole number to change the byte bound. With `toolOutput`, the same byte bound applies
to one normalized result. Exceeding either bound ends with `guard_output_limit`, without a
retry or partial disclosure. Usage reports still checkpoint while output is withheld. This
bounds retained SDK output, not allocations inside a provider or callback.

`toolOutput` also withholds raw `decision` progress events, which can contain an unchecked
client result or answer. The private request journal still records decisions before work.
Read that journal for decision status; use the later checked `tool_result` for output. Requests
and question prompts are a separate host-controlled surface: `prepareRequest` and your display
projector must check what they expose. No guard makes raw snapshots safe for a browser.

Guards are local to one agent. Set them on every specialist and handoff target whose output
needs protection. A parent's tool guard does not intercept a child's own progress. Hosted
provider tools may already have acted before a model output guard runs; use the input guard
and provider configuration to prevent their dispatch. Tools with guards run serially within
that agent, so a rejected result cannot start the next tool in its batch. Other already-running
children and external effects cannot be recalled.

Guard identity, configured stages and bounds live in `snapshot.definition.guardrails`.
`snapshot.guards` records operation/attempt ids, input hashes and verdicts. Change `identity`
when policy code changes. Resume refuses a changed policy or missing verdicts. A completed
receipt reuses its verdict. A guard interrupted before saving a verdict fails closed, even if
the callback would be safe to rerun. If a call returned but its guarded receipt was not saved,
resume refuses to repeat it with `guarded_output_unsettled`. Reconcile it on the host. An
interrupted inference-only stream can still use the existing recovery policy if no output
check started; the replacement attempt gets its own guards.

### Observe execution

Set `onLifecycle(event, context)` on the agent or in `RunOptions`. At each boundary, the agent
hook runs first, then the run hook. Run hooks reach descendants too; completed cached children
and completed resumed runs do not re-emit lifecycle hooks.

The event types are `run_start`, `run_end`, `model_start`, `model_end`, `model_error`,
`tool_start`, `tool_end` and `tool_error`. For each live model call the order is input guard,
start hook, dispatch, end hook, output guard, checkpoint, then progress. A tool follows the
same order, with the host's `beforeTool` and request freshness checks after its start hook.
A tool end hook also sees settled refusals that never dispatched. `model_error` reports a stream
failure; `tool_error` reports an error escaping the tool phase, including guard failure. An output
guard can fail after an end hook. `run_end`
receives the attempt's final state, including suspension or failure. A tool that pauses with
`InputRequired` has no settled result yet, so its start hook has no matching end hook on that
attempt. Use `run_end` to close any unfinished observation; resuming starts a new attempt.

Hooks are awaited to preserve order, but their return values and exceptions are ignored.
They cannot change frozen callback data or waive host checks. End hooks see **unchecked raw
output** for privileged server inspection. Do not forward them to a browser or log their
payloads without a policy. `onEvent` remains the non-awaited progress observer, not a hook.

All new callbacks receive a frozen `LifecycleContext`: `agentId`, `version`, `runId`,
`attemptId`, host `context` and `signal`. Cancellation stops waiting and prevents later SDK
work. Hooks are skipped when that signal is already aborted, including end hooks. It cannot
stop callback code that ignores the signal, undo an external effect or count hidden calls
inside a callback against tree budgets. Keep guards free of effects; hooks are not exactly-once
notifications and can repeat after a crash. For background runs, configure hooks on the agent;
`policy.context` supplies worker-only host services. No callbacks are serialized.

See [the offline guard example](examples/guardrails.ts). It makes no network calls.

## Conversations

Pass the thread's messages. The last one is the new user turn:

```ts
const result = await writer.run({
  messages: [
    { role: "user", content: "Explain database indexes." },
    { role: "assistant", content: "An index is a sorted copy of one column." },
    { role: "user", content: "When does an index slow things down?" },
  ],
});
```

The agent's `instructions` are its system prompt, so a conversation never carries a system
message: one is refused. So is an empty list, or one whose last message is not a user turn. A tool
call in the history never runs. The run answers it as interrupted and runs only the calls the
model makes now.

`result.history` holds the earlier messages, the new turn and every settled round, without the
system prompt. Send it back next time with the next turn added. `result.newMessages` holds only
what this run added. Invalid input throws a `TypeError` before anything is saved or loaded.

A browser can forge the history it sends. The run keeps only the fields a model reads: it drops
`reasoningDetails`, `reasoningItems` and each call's `thoughtSignature`, which belong to the
provider, and it refuses a tool result that answers no call. The model still reads every word
of that history, so `beforeTool` must check each action, as it already does.

### Images and files

A user turn can be a list of parts:

```ts
await writer.run([
  { type: "text", text: "What does this chart show?" },
  { type: "image", mimeType: "image/png", data: chartBase64 },
]);
```

An image must be JPEG, PNG, WebP or GIF. A file part (`type: "file"`) takes an `application/`,
`audio/`, `video/` or `text/` type. Core sends files only to Gemini; the other adapters refuse
them, and the run fails. Bytes are padded base64 text. A blank text part beside an attachment is
dropped.

A run accepts 5 MB of inline images and files across its history and new turn
(`limits.inlineBytes`). The snapshot keeps them, and every checkpoint writes the whole snapshot
again, so larger files belong behind a reference.

### Media references

Keep the bytes on your server and send a reference:

```ts
await writer.run(
  [
    { type: "text", text: "Summarize this report." },
    { type: "media", id: "upload-81", mimeType: "application/pdf" },
  ],
  { host: { loadMedia: (ref, run) => readUpload(ref.id, run.signal) } },
);
```

The run stores only the id. Right before a model call it asks `host.loadMedia` for the bytes as
base64, once per id per attempt. The bytes go into the provider request and nowhere else: not the
snapshot, the outcome, the session or an event. With no loader, or one that fails, the run fails
with `media_unavailable` before the model call starts.

`loadMedia` must check that the run's owner may read that id. The bytes behind an id must never
change: one earlier byte that changes makes the provider bill its whole prompt cache again. Set
`limits.inlineBytes: 0` to accept references only.

### Sessions

A session keeps the conversation on your server, so each request sends only the new turn:

```ts
import { createMemorySession } from "@providerkit/agents";

const thread = createMemorySession();
await writer.run("Explain database indexes.", { session: thread });
const next = await writer.run("When do they slow down writes?", { session: thread });
```

The run loads the history once, before it saves anything, and freezes it in the snapshot. When
the run ends (completed, failed, cancelled or limited) and its last checkpoint is saved, it
appends the new turn and its settled rounds once, keyed by its run ID. A run waiting for approval
appends when it finishes. A run the person stops still saves the turn they sent. The background
binding is the exception: cancelling a background run stops all of its writes, the session's
included.

`historyLimit` loads only the newest messages. A window that starts inside a tool round is
repaired before it is sent. `prepareHistory` runs once on the history, before the run is saved,
to trim or summarize it. It runs before the first checkpoint, so a paid summary can run again if
the process dies before that save.

`next.session` says what happened to the turn:

| Status    | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `saved`   | The session has it, at `revision`.                                                     |
| `pending` | Not appended yet: the run waits, its last checkpoint failed, or no session was passed. |
| `unsaved` | The append failed. Read `error.code` and `error.message`.                              |

`session_conflict` means another turn landed after this run loaded the history, say from a
second tab while this run waited for approval. Load the conversation again before you continue
it. An append that fails never changes the run's own status.

Resume never loads a session again. Pass the run's own session to `resume` so the turn is
appended when the run settles; another session is refused. A specialist never gets its parent's
session.

`createMemorySession` keeps everything in this process and loses it when the process ends. For
your own store, implement `Session` (`load` and `append`) and check it with
`await checkSession(() => createTestSession())`. It writes to fresh sessions, so point it at a
test database.

### Trim context while a run works

Configure `compaction` to shorten only what the next model call reads:

```ts
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the records and answer.",
  provider,
  compaction: { identity: "reader-context-1", contextWindow: 128_000 },
});
```

Supply the actual context window for this provider and model. The SDK does not guess it from a
model name. Core's `needsCompaction` decides when to trim, using the last reported input usage
plus an estimate of new messages. Before any usage report, it estimates text. Images and files
have provider-specific costs that this estimate cannot count. Core's `pickCut` keeps recent
messages without splitting tool calls from results. `keepTokens` overrides core's default tail
budget, `historyBudgetTokens(contextWindow)`. The newest message and unread inbox messages stay
verbatim even when they exceed that budget. Trimming cannot guarantee that a request fits.

Without `summarize`, trimming costs no extra call. It inserts a note saying that earlier messages
were omitted. The system prompt stays unchanged. `snapshot.history`, model/tool journals,
`result.history`, `newMessages` and the session append keep the full conversation. Input positions
and accepted/consumed receipts do not move. A delegated child or handoff still receives its normal
history policy, not the shortened model view.

For a paid summary, explicitly add `compaction.summarize` with `provider`, `instructions` and a
positive `maxTokens`. That provider must perform inference only. The SDK sends the removed
messages with those instructions, no tools, `hostedTools: []`, `toolChoice: "none"` and
`maxAttempts: 1`. Configure wrappers to honor that limit; hidden provider retries remain outside
the SDK's control. The same model guards, lifecycle hooks, usage checkpoints, shared model-call
budget and deadlines apply. Summary text never streams as the agent's answer. Its model receipt
has `purpose: "compaction"`; its usage counts in `usage` and `treeUsage`.

`snapshot.compactions` saves the cut and summary before the next model call. Resume reuses them,
including when recovering that model call. A summary left running fails with
`interrupted_compaction`, even under inference recovery: it may already have been billed. There
is no automatic second summary or fallback to untrimmed history. Reconcile the saved operation
on the host. A rejected or incomplete summary stops the run without dispatching tools. As with
other journals, persistence requires `host.checkpoint`; without it the record lives in memory.

Change `compaction.identity` when the prompt or hidden provider configuration changes. Resume
refuses a different recorded policy or summary provider identity. Unlike `prepareHistory`, this
feature runs inside the journal and never rewrites the session's stored transcript.

### Send messages while a run works

Add a correction or more context without interrupting the current call:

```ts
inbox.enqueue({ id: "correction-1", content: "Use short sentences." });
```

For a process-local run, create its inbox before starting:

```ts
import { createMemoryInbox } from "@providerkit/agents";

const runId = crypto.randomUUID();
const inbox = createMemoryInbox(runId);
const work = writer.run("Explain database indexes.", { runId, host: { inbox } });

inbox.enqueue({ id: "correction-1", content: "Use short sentences." });
const result = await work;
const deliveries = inbox.list();
```

The host must authenticate the person sending the message. `createMemoryInbox` does not check
access and loses everything when the process ends. It is a reference helper, not a background
queue. Keep it on the server; never put the agent or a provider key in the browser.

New input joins before the next model call, after the previous model and all its tools finish.
It cannot replace history, instructions, tools, permissions or the conversation owner. It uses
the same text and media validation as a new user turn. Inline attachments count toward the
agent's existing `inlineBytes` limit; media references still use `host.loadMedia`.

The root receives these messages until a handoff admits its target. Then that target receives
them. Delegated specialists, including their own handoff targets, never poll the root's inbox.
The callback gets explicit root and owner identities; it does not parse ids to find an owner.

An executing model or tool keeps working with its original input. The SDK does not cancel or
replay it to insert a correction. A waiting approval, question or client tool still needs its
explicit request-keyed answer. Writing "approve", "deny" or "stop" in a message does none of
those things. Waiting does not extend the run's original time or call budgets.

Delivery has three states:

| State      | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `queued`   | The host has it. The run has not saved it yet.                                                         |
| `accepted` | The run saved the content and its position before a model call. Consumption is not confirmed.          |
| `consumed` | A model call containing the message completed and was saved. This does not mean the model followed it. |

A running or interrupted call may already have read an accepted message and incurred a charge.
The SDK cannot prove that until it saves the completed call. `result.inputs` contains delivery
receipts for recorded inputs, with their root run, receiving run, model position and completed
attempt when known. Best-effort `input` events report the same receipts without content. Missed
events do not change the journal. Without `host.checkpoint`, these states describe only the
in-memory journal, not durable storage. `snapshot.inputs` holds the private content and its position
on each receiving node. `history` and `newMessages` include it in order, without splitting tool
calls from results. Session append keeps its original run id and revision, including on resume
and through handoffs, so a message is not appended twice.

A final answer can win the race with enqueue. Messages arriving after the last poll stay
`queued`; accepted messages whose call never completed stay unconfirmed. Keep both kinds for
explicit recall or a new run. Do not display them as read, discard them on completion or start
another paid run automatically. After the run settles, `inbox.list()` lets the host offer their
content back to the person. Reconcile any interrupted call before sending it again. An accepted
message may already be in the session: use the saved history rather than appending that same
message a second time.

### Implement a durable inbox

Supply `AgentHost.inbox`, an `InputInbox`, from trusted server code:

- `poll({ rootRunId, runId, agent, limit, signal })` returns a non-destructive, oldest-first
  prefix of `{ id, content }` records. Return promptly, without waiting for new messages. Respect
  the requested count and UTF-8 JSON byte limit. Keep offered records available and immutable
  until acknowledgement. Never silently truncate or rewrite a message to make it fit.
- `acknowledge(receipts, { signal })` records delivery idempotently. Repeating a receipt succeeds
  without another effect. An accepted receipt can become consumed, never the reverse. A known id
  with a different receiving run or model position is a conflict. Keep unconsumed content.

Persist an input before acknowledging enqueue to the app. The id is stable within its logical
root run, at most 256 characters. Use opaque ids, not message text; progress events include them.
Repeating the same normalized content returns its existing
status; changed content under that id must fail. Use a new id for a new message. The memory
helper throws `InputConflictError` for these conflicts.

The SDK checkpoints accepted content and its model position **before** acknowledging delivery,
then starts the model call. A crash before that save leaves it queued. A crash after save but
before acknowledgement repeats the acknowledgement from the journal. Resume uses the saved
content, not a new value from the inbox. Consumed acknowledgement follows the completed model
checkpoint. Host poll or acknowledgement errors stop execution, without an automatic resend.
Reconcile the inbox with authoritative saved state before recalling messages after such an error.

`INPUT_LIMITS` bounds a logical run and its handoff chain: 32 pending messages per poll, 128
accepted messages in total and 5,000,000 UTF-8 JSON bytes across normalized `{ id, content }`
records. Hosts must also bound pending storage at enqueue. The memory helper enforces those
ceilings and retains all entries, including consumed ones, for deduplication. When the run has
no remaining input budget, further messages stay with the host. Large attachments belong behind
media references. These bounds do not grant extra model turns.

For `createBackgroundAgent`, supply the durable inbox through `policy(...).inbox`. Bind it to
the authenticated owner and stored logical `snapshot.runId`, not the physical worker segment:
an approval continuation has a new segment but the same logical input ids. Poll includes that
logical id and the active receiving agent. Check access and fence writes under the host's run
lease. The SDK does not supply an enqueue HTTP route, inbox tables or a queue service. The
existing injected `runs.create` and commit-before-enqueue boundary are unchanged; enqueuing a
message must not call `start` or `resume`. An app's delivery endpoint and UI must distinguish
queued, accepted and consumed messages, and expose recall without automatic resend.

### Edit or regenerate a turn

Send the conversation up to the user turn whose answer you want again:

```ts
await writer.run({ messages: messages.slice(0, userTurnIndex + 1) });
```

To edit that turn, replace it and leave out everything after it:

```ts
await writer.run({
  messages: [
    ...messages.slice(0, userTurnIndex),
    { role: "user", content: "Explain indexes with one short SQL query." },
  ],
});
```

Both calls start a new run; `resume` continues an existing one. A session only appends, so start
another one from the earlier messages, for example
`createMemorySession({ messages: messages.slice(0, userTurnIndex) })`, then send the edited turn
with that session. Things the agent already did, like a sent email, stay done.

### What a browser may see

Snapshots, receipts, raw progress events and session revisions are for your server. They hold
prompts, tool arguments and results, and the fields a provider owns, which `model_chunk` events
carry too. Send a browser the display data your server builds. When it needs the messages, send
`toClientMessages(result.history)`, which leaves out the provider-owned fields. Replace inline
bytes with references, and serve the bytes from a route that checks access.

## Remember facts across conversations

A session keeps one conversation. Memory keeps facts for later conversations with the same
person. Start with the process-local reference store:

```ts
const store = createMemoryStore();
```

It loses everything when the process ends. For production, implement `MemoryStore` over your
own storage. The SDK adds no database, vector index, embedding calls or paid extraction.

```ts
import { createMemoryStore, defineAgent, memoryTools } from "@providerkit/agents";

const store = createMemoryStore();
const notes = memoryTools();
const helper = defineAgent({
  id: "helper",
  version: "1",
  instructions: "Use saved facts only when they help answer the person.",
  provider,
  memory: true,
  tools: [notes.search, notes.save, notes.forget],
});

// Get these ids from authentication, never from model arguments or unchecked request data.
const scope = await store.access({ tenantId: workspace.id, userId: person.id }, { signal });
await helper.run("How do I take my coffee?", { memory: { store, scope }, signal, host });
```

`memory: true` enables recall only. Register the tools you want; none is added automatically.
Reuse the **same tool objects** on a creator and its helper template when allowing generated
helpers to use memory. The helper's admitted tool list still applies. A host template can enable
recall independently, but a model cannot choose another store, scope or retention period.

### Scope and versions

Every scope names a `tenantId`, even in a single-tenant app. Optional `userId`, `sessionId` and
`namespace` match exactly; omitting one never widens a read. Ids are nonempty, at most 200 characters
and contain no control characters. The store's `access` returns the scope with an erasure
`revision`. That revision prevents work started before an erasure from putting the data back.
It is not permission: your host must check ownership and current access.

`MemoryBinding.scope` is the only writable scope and must name a person. `shared` holds exact,
read-only scopes in the same tenant. There may be at most eight scopes altogether. The binding
is frozen into `snapshot.tree.memory` and inherited by specialists. Resume must supply the same
scopes, revisions and `keepForMs`, before authorization callbacks run. The store itself stays in
memory, not in the snapshot. `keepForMs` sets expiry on tool-created notes; the host owns cleanup.

The three tools use the normal journal, guards, approvals, limits and host `beforeTool` check:

- `memory_search({ query, limit? })` reads up to ten notes. Its result includes note keys and
  versions in at most 4,000 characters. Large notes return a preview marked `truncated: true`,
  with their key and version intact. If some matches do not fit, search with a smaller `limit`.
  Queries contain 1 to 500 characters.
- `memory_save({ notes: [{ text, version: null }] })` creates a note with an operation-derived key.
  Supply `key` and `version: null` to create a named note. To replace one, supply its current
  version from search. A call saves at most five notes, atomically. Each accepts 1,000 characters
  by default; `memoryTools({ maxNoteChars })` raises that up to 16,000.
- `memory_forget({ notes: [{ key, version }] })` deletes up to ten notes, atomically. A stale
  version refuses the whole call. It never erases a conversation or another person's notes.

Only one writer can win a note-version race. Search again after a conflict. The store must never
reuse versions, even after delete/recreate. Interrupted writes are **not replayed**. A timeout or
lost reply needs host reconciliation, not another write. Search can use the existing explicit
read-only recovery policy. `memoryTools({ needsApproval: true })` requires approval for save and
forget; the host can require it through `needsApproval` too. Store exception text is not shown
to the model or saved in the journal.

### Recall and resume

Recall runs once per agent run, before its first model call. It searches using the first 2,000
characters of the new input. A handoff keeps the source's latest user input across further
transfers, including accepted messages sent while it ran. Transfer notices never become recall
queries. An ordinary delegated task uses its own input.
`memory: { limit, maxChars, onError }` changes the defaults of five matches and 4,000 characters.
The ceilings are 20 matches and 16,000 characters, including the complete block's framing.
Notes that do not fit are omitted whole. Search results from another scope always fail closed.

Recall is stored in `snapshot.recall` and passes the existing checkpoint/progress barrier before
any model sees it. Resume reuses that record without searching again, including a recorded read
failure. `onError: "continue"` is the default; `"fail"` stops before the model when the store is
unavailable. Neither mode permits another scope's data or an erased access revision.

The block is user-role data, not system instructions or authorization. JSON quoting and escaped
opening brackets prevent stored tags from closing the block. This is not a prompt-injection
security boundary: host tool checks and guards still matter. Recall stays separate from the full
conversation, session append and steering positions. Compaction reattaches the same recorded
block without changing those records. An already-running model may still quote a recalled fact.

### Save facts after a run

Ingestion is an explicit host action. No observer hook writes memory or makes an extraction call:

```ts
const saved = await ingestMemory(result, {
  memory: { store, scope },
  notes: [{ key: "answer-style", text: "Prefers short answers", version: null }],
});
```

Import `ingestMemory` from the main entry. Pass a completed root outcome from authoritative
server state, after its final checkpoint and session append. Choose and authorize the facts in
host code. The SDK removes memory tool rounds from the ingestion transcript, but answers may
still quote earlier notes. The original conversation remains unchanged. An ingestion request
accepts at most 20 notes and 1,000,000 UTF-8 JSON bytes, transcript included.

The store must implement `ingest` and `receipt` together. It must atomically check note versions
and the erasure revision, write the notes and commit a receipt keyed by the exact access and
logical run id. It computes a fingerprint of the complete request. The same request returns the
original receipt, even after later edits; different content for that run must conflict. A string
id or an in-process flag without that transaction is not idempotency.

`status: "saved"` carries the store's receipt. `"refused"` means a version conflict or erasure.
`"unknown"` means the write may have committed. The SDK never retries it. Query
`store.receipt({ access: scope, runId: result.runId }, { signal })` and reconcile with the original
request on the host. A missing receipt while an old call can still finish is not proof of no write.
Keep paid extraction outside these methods and under its own explicit execution policy.

### Erase a person's memory

```ts
await store.erase({ tenantId: workspace.id, userId: person.id }, { signal });
```

This operation covers exactly that tenant and person, across their sessions and namespaces.
The store must remove notes, ingestion receipts and derived data, then invalidate every old
access revision atomically. A late write or ingestion using an old revision must throw
`MemoryErasedError`, even if that namespace had no notes when erasure ran.

**The host must also cancel active runs and erase their snapshots, checkpoints, event logs,
session messages and any other copies.** Those records can contain recalled notes and quoted
answers. Deleting store records cannot withdraw data already sent to a model. Apply your own
access rules and retention schedule to every copy. Resume authorization must reject erased runs;
reusing an old binding alone cannot recall information already sent.

The reference store uses a linear word search with Unicode and accent handling. It has no vector
ranking, automatic consolidation or notebook merge. Run
`await checkMemoryStore({ disposable: createMemoryStore() })` to check the contract. The helper
writes and erases test records, so supply a disposable store only. A passing check cannot prove
that a production adapter enforces your authorization or transaction boundaries.

For background jobs, set `createBackgroundAgent({ ..., memory: owner => openMemory(owner) })`.
The factory checks the authenticated owner at start and the stored owner in the worker. Start
freezes scopes without recalling; the worker recalls under the existing lease. A changed scope
or erasure revision is refused before continuation claims. Ingestion stays a separate explicit
host action, never a worker completion hook.

See [the offline memory example](examples/memory.ts). It uses no live provider or store.

## Tools and checked output

Pass core `Tool` instances in `tools`. Their input validation, timeouts and error outcomes remain
core's responsibility. Unmarked tools run serially. Parallel tool execution requires both the
core tool's `isConcurrencySafe` flag and the host's permission to batch it. Tools run in your
process; this package does not provide a sandbox for untrusted code.

For a checked result, supply `output.schema` and `output.validate`. The schema tells the model what
to submit; the validator checks the actual value. Return the desired TypeScript value or throw a
message explaining what to correct. The SDK reserves the `submit_result` tool name for this path.
A validator should be pure: it can run again when a completed result is restored.

### Text, JSON and image results

Return a JSON value from an ordinary core tool. Its existing `summarize` function controls the
text the next model reads; core defaults to JSON text. The successful SDK receipt also keeps
that JSON value in `result.output`. It is private host data, not automatic browser content.
A non-JSON typed value with a text summary still works, but only the summary is saved.

To return text with an image, return core content parts from the same tool's `run` function:

```ts
return [
  { type: "text", text: "The front of the package." },
  { type: "image", mimeType: "image/png", data: pictureBase64 },
];
```

The SDK recognizes nonempty arrays of content parts. It joins text with newlines and puts
images in core's tool-message `images` field. No second tool wrapper is needed. Empty arrays
stay JSON. JPEG, PNG, WebP and GIF use the same padded-base64 checks as user attachments.
Files and media references are not supported in tool results: return text and inline images.
Tool images count toward the run's total `limits.inlineBytes`, including earlier tool results
and user attachments. Too many bytes stops the run with `tool_media_limit`, without repeating
the tool. Results retain images across checkpoints, sessions and resume. Client tools and
pure delegations use the same normalization. Display projectors must still opt in to tool
content and replace inline bytes with authorized references.

### End on a tool result

When a tool already has the answer, avoid paying the model to rewrite it:

```ts
const finder = defineAgent({
  id: "finder",
  version: "1",
  instructions: "Use lookup to find matching records.",
  provider,
  tools: [lookup],
  stopAtTools: ["lookup"],
});
```

The run ends after that tool succeeds, without another model call. A text agent returns the
summary the tool supplies. With an `output` contract, the tool's raw output must pass its validator;
the summary still goes into history. A failure or rejected result goes back to the model to
correct. An invalid result does not undo the tool's effects.

`stopAtTools` names ordinary host tools, not delegations or `submit_result`. If a turn calls
several tools, all of them settle before the run ends. The first successful stopping tool in the
model's call order supplies the answer, regardless of which one finishes first.

Core tools marked `isTerminal: true` also stop the run this way, but must be called alone. For
these host tools the final answer comes from the tool's result, not its input. `submit_result`
still validates its input. Stopping results are recorded in the tool receipt, so resume never
repeats a finished effect or asks the model to rephrase it.

## Specialists and parallel work

An orchestrator can call another configured agent as a tool:

```ts
const editor = defineAgent({
  id: "editor",
  version: "1",
  instructions: "Ask the reviewer for feedback, then write the final answer.",
  provider,
  tools: [
    reviewer.asTool({
      name: "review",
      description: "Review a draft and identify changes it needs.",
    }),
  ],
});
```

The specialist gets only the input sent to it, not the parent's conversation. Its result returns
to the orchestrator; this is not a conversation handoff. Use `defineHandoff`, below, when the target
should answer the person directly. Each agent can use a different core provider.
`asTool` returns a failed tool result for a specialist's own turn, tool-call, time or output
limit, or a known model/result failure. The parent can answer using its other results. Core
`ProviderError` failures and the SDK's `model_failed`, `invalid_model_output`, `content_filtered`,
`incomplete_turn`, `missing_result` and `empty_output` codes are local failures. An unclassified
exception is not: custom providers should throw core's `ProviderError` for provider failures.

Suspension still reaches the host. Cancellation, shared tree limits and host or journal failures
still stop the parent. Every admitted child settles, and its usage and completed receipts remain.
Use `defineDelegation` when your code needs to combine explicit child outcomes or share the
conversation. Its coordinator cannot waive cancellation, tree limits or integrity failures.

A delegation declares its fixed `specialists` list, input schema and validator. Inside its `run`
callback, start children before joining them:

```ts
const draft = context.child("draft", writer, input);
const review = context.child("review", reviewer, input);
const [draftResult, reviewResult] = await context.join([draft, review]);
```

Children start immediately, subject to the shared limit. Joining returns outcomes in the order you
requested, not the order they finish. Check their statuses and return only what the parent needs,
not their full snapshots. A suspended child pauses the parent instead of becoming a success string.

A child takes the same input as `run`: text, parts or `{ messages }`. To let a child read what came
before, forward `context.conversation`, the parent's messages before this tool call, without the
system prompt or the unfinished round:

```ts
const review = context.child("review", reviewer, {
  messages: [...context.conversation, { role: "user", content: input }],
});
```

Your coordinator is trusted code, so provider-owned fields in the forwarded messages are kept.
Media references stay references, and the child reads them through the same `host.loadMedia`.

Coordination callbacks must be pure: use `child`, `join` and `ask` for work. The callback can run again
after an interruption, but completed children are reused. Reusing a child key with a different
input, history or agent is refused. Every admitted child settles before the delegation ends.

A child key becomes part of the child's run ID and of every operation ID under it. Progress events
carry those IDs, and a screen that shows the run may send them to a browser. So key children by
position or by a fixed name, such as `topic-1`, and never by their input.

## Helpers the model creates

Let an agent split a task among helpers:

```ts
await explainer.run("When does a database index help?");
```

The host supplies a template. The model writes each helper's task and optional instructions,
then selects tools and a model alias from the host's menu. It cannot add code, credentials,
permissions, hosted capabilities or higher run limits.

```ts
import { defineAgent, subagentTool } from "@providerkit/agents";

const helper = defineAgent({
  id: "helper",
  version: "1",
  instructions: "Answer only the task you receive.",
  provider,
  tools: [lookup],
});
const explainer = defineAgent({
  id: "explainer",
  version: "1",
  instructions: "Ask helpers about separate parts of the question, then combine their answers.",
  provider,
  tools: [
    lookup,
    subagentTool({
      name: "create_helpers",
      description: "Start helpers for separate parts of the question.",
      agent: helper,
    }),
  ],
});
```

A model call to `create_helpers` takes `{ agents: [{ name, task, instructions?, tools?, model? }] }`.
`name` is private text: 1 to 64 letters, digits, `_` or `-`, unique among helpers admitted by this
creation tool in this run. A new helper needs a new name. `tools` contains registered tool names. Omitted tools means
none; `defaultTools: "all"` grants the currently available set. A tool must be the **same object**
on both the creator and the template, and enabled on the creator. Two tools with the same name
are not interchangeable. The template's own tool-selection policy still applies.

Handoffs and ordinary delegations cannot be granted. The checked-output tool `submit_result`
stays available when the template needs it. Several helpers in one call run in parallel under
the existing tree limit. Their results return in declaration order. Separate creation calls
in one turn still run one after another, like other delegations.

Use `agent: "self"` to reuse the creator's recorded instructions and model settings. Its
instruction callbacks do not run again. Explicit templates resolve their own callbacks once.
The helper gets no parent history, session or inbox. Its host instructions come first, followed
by the model-written instructions. These instructions are not permission to use a tool.
Forking a conversation and continuing a helper by name are not exposed by this tool. Use a
host-defined delegation when you need to choose or forward history.

### Bound helper creation

Defaults are `maxPerCall: 4`, `maxPerRun: 8` and `maxLevels: 1`. Set `maxPerRun: 0` to refuse
creation. Counts must be whole numbers up to 1,024. Only `maxPerRun` accepts zero. The entire
model-supplied batch must fit in 65,536 UTF-8 JSON bytes (`SUBAGENT_SPEC_BYTES`). Unknown fields,
unknown aliases, repeated names and oversized batches are refused before any child starts.

Recursive creation needs `maxLevels` greater than one, and the helper must receive this same
creation tool in its `tools` list. Every ancestor's creation ceiling still applies. Root
`treeLimits` always bound depth, total children, model calls, parallel work and elapsed time.
A preflight shortage of child slots returns tool feedback. A racing admission can still reach
the tree's hard limit. Waiting or resuming never refreshes a budget.

`models` maps aliases to `{ description, settings }`. The host writes these settings; the model
only selects a key. Choices cannot set `hostedTools`, `toolChoice` or observer callbacks. The
template owns its provider and hosted capabilities. Hidden provider changes require a version
change, as with other agents. Hosted calls still cannot replay after an interruption.

Optional `prepare(draft, context)` is trusted, pure admission policy. It may rewrite the task
or instructions, remove requested tools, lower `limits`, or return `{ refuse: "Reason" }`.
It cannot change the name or model alias, add tools the model did not request or raise the
template's limits. Invalid or thrown policy results fail closed. The context contains the
private `call`, child `depth`, created-helper `level`, `grantable` names and cancellation `signal`.
One prepared definition must also fit in 65,536 UTF-8 JSON bytes.

### Saved work and permissions

The admitted definition, template configuration, model choice and task are saved in the ordinary
child journal before execution. Resume uses that record, never another model call to recreate
the helper. It refuses changed definitions, revoked tools or model aliases, and changed approved
arguments after admission. Completed children are reused. `prepare` never runs again for an
admitted child; it can run again for a helper that was refused or not yet saved. Keep effects
out of it. Bump the relevant agent version when callback code or hidden provider behavior changes.

All template guards, lifecycle hooks, result checks, tool serialization and usage accounting
still apply. `needsApproval: true` on `subagentTool` gates the creation call only. Each helper's
own approvals, questions and client results stay in its own request journal. They reach the
host through the normal request paths. `ToolRequest.subagent` carries the private model-written
name so host policy can recognize created helpers; it is not an authorization claim.
`beforeTool` must still check current access immediately before every action, including after
resume. A saved allowlist is not current permission.

A helper's own model/result failure or local limit becomes a `failed` result for the parent.
Suspension, cancellation, tree-wide limits, guard failures and host/journal failures keep their
existing stopping behavior. Results are `{ name, runId, status: "completed", output }`,
`{ name, runId, status: "failed", error }` or `{ name, status: "refused", error }`.
`output` is the template's checked, JSON-serializable candidate, not a validator's transformed
application object. `summarize(results)` is an optional pure callback; by default, the parent
gets JSON in declaration order. The tool succeeds when at least one helper completes.

The private record lives at `delegations[].children[].snapshot.subagent`. The existing `child`
event adds only `subagent: true`; its key is positional (`helper-1`, for example), and its agent
id belongs to the host template. It carries no model-written name, instructions or task. Display
helpers under a host-written label. Only expose a model-written name or output after your own
explicit display check. Raw tool events, snapshots and request records still contain private
prompts and must stay on the server.

See [the offline helper example](examples/subagents.ts). It creates two helpers without an API key.

## Hand off a conversation

A handoff lets another agent answer the person. The source makes no further model call after the
target starts. For example, a help agent can transfer an invoice question to a billing agent:

```ts
const result = await help.run("Why was I charged twice?");
```

Register one fixed target per handoff tool:

```ts
import { defineAgent, defineHandoff } from "@providerkit/agents";

const help = defineAgent({
  id: "help",
  version: "1",
  instructions: "For billing questions, call transfer_to_billing alone and stop.",
  provider,
  tools: [
    defineHandoff({
      name: "transfer_to_billing",
      description: "Let billing answer a question about an invoice or charge.",
      to: billing,
    }),
  ],
});
```

The model can pass `{ note: "Background for billing" }` or `{}`. It cannot choose an agent name,
add tools or grant access. The note is quoted background in a user-role transfer message, never
a system instruction or permission. `beforeTool` and the request journal still control actions.
The target resolves its own instructions, provider settings and enabled tools once. It does not
inherit source overrides. Either agent may use text or a checked `output` contract. The target
validates its own result, including after resume. The source never checks that result against
its own schema or asks a model to rewrite it.

`defineAgent` infers the union of its own output and every registered handoff target's output,
including further handoffs. A text agent that can transfer to an `Agent<{ count: number }>` returns
`RunOutcome<string | { count: number }>`. Two checked agents with different schemas return the
union of those two types, without adding `string`. An agent without handoffs keeps its original
output type. Ordinary delegations do not widen their parent's output.

Check `status`, then narrow the output by its value or by a tag your validators return:

```ts
const result = await help.run("Count open invoices.");
if (result.status === "completed") {
  if (typeof result.output === "string") console.log(result.output);
  else console.log(result.output.count);
}
```

This example assumes `help` has text output and a counter target. `activeAgent` names the owner;
its id does not narrow the output's TypeScript type. Keep a tag such as `kind` in distinct object
outputs when you need that distinction. See [the offline typed example](examples/structured-handoff.ts)
for two different checked schemas and resume, with no casts.

`Handoff<T>` and `HandoffSpec<T>` retain their target's output type. Keep that generic in helpers
instead of annotating a descriptor as bare `Handoff`, which forgets the output type. Let
`defineAgent` infer its tools. For a cyclic graph, annotate one agent with the full output union,
for example `Agent<InvoiceCount | Summary>`. If you annotate a definition, `AgentDefinition<T, H>`
separates its own output `T` from the handoff output union `H` (default `never`). A definition whose
`output` is optional also allows text results.

A handoff must be the only call in its model turn. Mixed calls, two transfers, a self target,
a missing target or conflicting definitions for one target id produce tool feedback. Other
calls in a mixed turn still settle or ask for approval. The model can then request a lone
handoff. Each admitted target uses the existing child host hook, shared leases and limits. Each
hop consumes one child and one depth level, so cycles stop at the configured tree limit. Waiting
for replies does not reset any deadline or model budget.

### Choose what the target reads

`history` on `defineHandoff` controls transfer:

- `"conversation"` (default) keeps user messages and non-empty assistant text. It removes tool
  calls, results, private reasoning and provider-owned fields.
- `"full"` keeps the settled conversation, including tool rounds and provider-private fields.
  Use it only with trusted history and compatible providers.
- A pure function receives `{ from, to, messages, note? }` and returns the messages to transfer.
  Its input is frozen. It cannot insert a system message. The SDK validates its result like a
  trusted child input, then saves it with that child.

Every mode excludes the source system prompt and the current unfinished handoff round. The
SDK appends its transfer message after the selected history. Media references remain references;
`host.loadMedia` still checks access. The filter is not called again for a saved child. As with
other creation callbacks, a crash before the first child checkpoint can call it again.

`conversationOnly(messages)` exports the default filter for host-directed routing. It is a
model-input filter, not a browser display policy.

### Continue or resume

Every outcome returns `activeAgent: { id, version }` and ordered `handoffs` receipts. The last
admitted target owns the next turn, even when it failed or is waiting for replies. A handoff
inside a delegated specialist changes that child's owner only, not the root's owner.

For a **new turn**, the host picks the registered agent by both identity fields:

```ts
const nextAgent = agents.find(
  (agent) => agent.id === result.activeAgent.id && agent.version === result.activeAgent.version,
);
if (!nextAgent) {
  throw new Error("Restore the saved agent version before continuing this conversation.");
}
await nextAgent.run({
  messages: [...result.history, { role: "user", content: "Which invoice was that?" }],
});
```

`history` is the active agent's settled conversation, including the SDK's transfer message. It
is server data, not a display transcript. `newMessages` retains the original new turn and settled
rounds along the handoff chain, without copied history or synthetic transfer inputs. A session
appends those messages under the original run id and revision, once. Sessions do not store the
active agent: save that identity in your host. When routing a new session turn to another agent,
choose a history policy explicitly, such as `prepareHistory: conversationOnly`.

For a **waiting or interrupted run**, resume the agent that started it, using its original
snapshot and the normal `answers` map. Requests from every target retain their exact call and
child path. Partial replies preserve the remaining requests and completed work. An approved
transfer does not approve any target tool. A host may allow edits to the note before the target
starts. Changing it after admission fails with `handoff_input_changed`; reconcile the saved run
before starting different work. Denying a renewed transfer approval after its target
started stops that conversation; it cannot undo completed actions or return to a source model
turn. A saved completed target is reused, never called again. Its raw candidate stays in its child
snapshot and in the source's completed state; only the owning target's pure validator rebuilds
the returned value. A failed target validation returns tool feedback to that target's loop. It
cannot become source-schema success; if the target cannot finish, the source returns its failure
or limit. Safe recovery remains opt-in; configured hosted tools still block interrupted model replay.

For cycles, `to: () => billing` lets two definitions reference each other. Keep this function
pure. It resolves once per handoff descriptor. After a restart, a different target id or version
is refused, including while the transfer itself waits for approval. Bump the source version when
its registered handoffs or history policy change.

Each journal entry has `kind: "delegation" | "handoff"`; a handoff also records `target` and its
optional note. Child snapshots stay at `delegations[].children[].snapshot`. Saved delegation
entries without `kind` are refused. Operation receipts also distinguish `"handoff"`. A
`handoff` event names `runId`, `operationId`, `childRunId`, `from` and `to` before target progress;
it also carries `attemptId` and the optional note. It repeats on target resume, so upsert by
operation id. Snapshots and receipts remain authoritative if an event is missed. Do not forward
raw histories, notes or events to a browser. Project only approved identities, labels and content.

## Limits and usage

Per-run defaults are 12 model turns, 32 tool calls, 5 minutes, at most 3 approved concurrent
ordinary tools and 5 MB (`inlineBytes: 5_000_000`) of inline images and files. Change these
through `limits` when configuring an agent. Once a text agent uses all its model turns, it gets
one final call with no tools to answer from what it found. That call still counts against the
tree's model-call and time budgets. Any tool calls it returns are refused. Checked-output agents
keep the hard turn cap because a tool-free call cannot submit their result.

The root's `treeLimits` apply across all descendants:

| Setting       | Default | Counts                                                                            |
| ------------- | ------- | --------------------------------------------------------------------------------- |
| `maxParallel` | 4       | Active agents, including the root. A parent waiting on children lends its slot.   |
| `maxChildren` | 32      | Children in total, not per parent.                                                |
| `maxDepth`    | 4       | Descendant levels; the root is depth 0.                                           |
| `modelCalls`  | 128     | Calls from agent loops to core. Provider-internal retries can send more requests. |
| `elapsedMs`   | 300000  | Wall time, including queueing and waiting for approval, across attempts.          |

A child's local limits still apply. Set enough time for a human decision when using approval.
Resuming does not reset the deadline or give the tree a fresh call budget.

`usage` describes the current agent's model calls. `treeUsage` includes registered descendants
without counting recorded work twice. Only model usage reported by providers is known; an
interrupted call may have cost more than its last report. Ordinary tools' external service charges
are not included. Prices and billing stay with the host, and these counters are not an exact
spending cap. Use SDK delegation rather than calling another model directly inside an ordinary
tool when that work must share the tree's limits and usage.

## Asking the person

A suspended run returns `requests`, including requests from its specialists. Each has a stable
`id`, the exact call and child `path`, the tool definition's hash, and a host-supplied actor,
resource version and expiry. Approvals, questions and client tools use the same tool journal.
The SDK saves a request before reporting it. It saves each accepted decision before any effect.

Reply by request id, using the snapshot your server stored:

```ts
await writer.resume(savedSnapshot, {
  host,
  answers: { [requestId]: authenticatedEvidence },
});
```

`answers` is evidence, not permission. Never accept a browser's snapshot as authority.
`host.authorizeResume` must load authoritative state, check ownership and exclude concurrent
attempts. It runs for every node, including specialists. Unknown, closed and already-decided
request ids are refused before host callbacks. HTTP hosts must also reject duplicate keys in
raw JSON before parsing an answer map.

The host supplies these callbacks:

- `prepareRequest(draft)` returns `{ scope }`: the actor id, resource id and version, and a future
  `expiresAt` in milliseconds. For approvals it can also return `ask` to set the message,
  `editable`, `approveSchema` or `denySchema`. Editing is off by default.
- `resolveRequest(request, evidence)` authenticates and consumes evidence for that exact request.
  It returns a `Decision`, or `{ type: "pending", problem? }` when the request is still open.
  Validate any form data against the host's schema here, before accepting it.
- `beforeTool(call, decided?)` checks current access and resource version immediately before
  execution. `call.arguments` holds the arguments that will run. `decided` holds `{ request,
  decision }`; a saved decision cannot bypass this check. The callback is required when using
  an answer and before exposing a client-tool request.
- Optional `needsApproval(call)` requires approval even for an unmarked tool. It cannot waive
  a tool's own `needsApproval` flag. Optional `answerNow(request)` returns a standing policy
  decision, or `undefined` to ask the person. This is trusted policy, not model output.

A `Decision` is one of:

| Type      | Value and result                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve` | Runs the approved call. Optional `arguments` replace all model arguments, only when `editable` is true. The tool's validator still checks them. |
| `deny`    | Does not run the call. Its optional `message` becomes the tool result.                                                                          |
| `answer`  | Supplies `{ answer: { choices?, text?, data? } }` to a question.                                                                                |
| `result`  | Supplies `{ value }` for a registered client tool. Its result validator must accept it.                                                         |
| `cancel`  | Dismisses the request and returns a cancelled tool result. Does not undo an action already taken.                                               |
| `stop`    | Cancels the run tree and closes its open requests. Does not undo past effects.                                                                  |

Each decision may carry an opaque `receipt`. An approval or denial may carry `data` only when
its corresponding schema was declared. Form schemas describe what to show; the SDK does not
ship a JSON Schema evaluator. Your host must validate their data. Wrong kinds, forbidden edits,
unknown or repeated choices, disallowed text and blank answers stay pending with a `problem`.
Invalid edited arguments become a failed tool result without executing the tool.

You may answer a subset. All approval-required calls remaining in a turn open together, within
the tool budget. A later call waits behind an earlier open request. Specialists can wait on
several requests at once; answering one keeps the other requests and completed work intact.
Usage and admissions do not reset. Cancelling a coordinator's question also stops its unfinished
children; settled children remain. Progress includes `request` and `decision` events, but these
can be missed: the journal is the durable record.

An expired approval or question is replaced under a new id and fresh host scope. A changed tool
definition does the same. Old evidence never answers the replacement. Replacements need a fresh
answer through `resolveRequest`, not another automatic `answerNow` decision. Access and expiry are
checked again before an effect, including after the tool-start observer.

### Questions and forms

Give the model `questionTool()` to ask for text or choices:

```ts
import { questionTool } from "@providerkit/agents";

const questions = questionTool();
```

Put `questions` in the agent's `tools`. Its `ask_question` call takes `message`, optional
`choices` (`id`, `label`, optional `description`), `multiple` and `freeText`. An answer chooses
only offered ids, with no duplicates, and one at most unless `multiple` is true. The answer
becomes the tool result, not an instruction with tool authority.

Pure coordinators can call `context.ask(question, validate)`:

```ts
const count = await context.ask(
  { key: "count", message: "How many copies?", schema: countSchema },
  (answer) => validateCount(answer.data),
);
```

`validateCount` is your pure runtime validator. It returns the typed value or throws. A rejected
form opens a new request with the problem. Parallel asks use distinct keys. The coordinator runs
again from its start and reads recorded answers by key; its JavaScript stack is not saved. Do not
put external effects in it. Catching or ignoring an unanswered `ask` still suspends the run.

An ordinary core tool may throw `new InputRequired({ key, message, ... })` only at a replay-safe
boundary **before every external effect**. On resume the entire tool runs again; use
`answerOf(context, key)` to read its saved answer. The SDK supplies frozen `context.answers` and
`context.decision`, overriding values with those names in host context. A second question can
use another key. Throwing again for an answered key rejects that answer and opens a new request.
Never write, send, or make a paid call before throwing: the SDK cannot prove your code was safe.

### Client tools

Register a deferred tool with `defineClientTool({ name, description, inputSchema, validate,
result: { schema, validate }, summarize? })` in trusted server code. Its arguments are validated
before the request opens. The host exposes only the allowed client request; the client cannot
choose a new tool definition or grant itself authority. Return a `result` decision through the
same authenticated channel. The registered result validator runs before it is recorded.
Validators and summaries must be pure: recovery can call them again. Dispatch with
`request.call.arguments`, which includes approved edits. `request.call.call` keeps the original
model call for identity checks, not the arguments to execute.

There is no local `run` callback and no local duplicate execution. A pending client request keeps
its id on reconnect, and a resolved one is never sent again. The host must deduplicate client
dispatch by request id and recheck access before dispatch. A browser event is not permission.
An expired or changed client request fails with `client_result_unknown`, rather than issuing
another potentially repeated effect. Reconcile it with the host. An idempotency key alone does
not prove that the receiver enforces it.

### Checkpoints and recovery

`host.checkpoint` persists the entire journal before returning. Completed results can be reused.
An operation recorded as running has an unknown outcome after a crash. The default is refusal,
with `interrupted_operation`, not replay. A model may have run provider-hosted tools even if no
tool call appeared in its stream. A tool may have acted before it could report `InputRequired`.
Neither an empty stream nor an idempotency key proves that repeating it is safe.

#### Opt in to safe replay

For a provider profile you know performs inference only, configure recovery before starting:

```ts
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the records you need, then answer.",
  provider,
  tools: [lookup],
  recovery: {
    identity: "inference-and-lookup-v1",
    maxAttempts: 3,
    inferenceOnly: true,
    readOnlyTools: ["lookup"],
  },
});
```

`inferenceOnly: true` is your host's assertion about the configured provider, including its
wrappers and defaults. Never set it for provider-hosted search, code execution or any other
remote tool. An interrupted call with a non-empty recorded `modelSettings.hostedTools` list is
refused even if this flag is set. Leave it out to refuse interrupted model calls. `readOnlyTools`
is an explicit allow-list, not a tool hint: each named tool must also have `isReadOnly: true`. A replay requires
`host.beforeTool`, which checks access again before invocation. Read-only does not mean free:
a repeated request can incur another charge or return newer data.

Calls with any approval, question or client-request history cannot replay under this policy.
A decision for a previous attempt is never permission to repeat an unknown effect. Client tools,
writes and hosted effects require authoritative host reconciliation. There is no force-replay
switch. Do not restart the whole run as a substitute: that repeats completed work too.

The policy is saved in `snapshot.definition.recovery`, together with the provider id/model and
hashes of advertised tools and permitted read-only definitions. Resume checks the same policy
and provider identity; replay checks the tool definitions. Resolved instructions, model settings
and enabled tools stay frozen. Change `identity` when hidden provider defaults, hosted
capabilities or tool implementations change. The SDK cannot inspect code inside a provider
wrapper or prove that a receiver enforces an idempotency key.

Recovery repeats only the interrupted operation. It keeps that operation's `id` and changes its
`attemptId`. Completed siblings and tools are reused. `maxAttempts` includes the first attempt;
when used up, the run fails with `recovery_exhausted`. A reserved attempt counts even if the
worker died before sending it. Each new model attempt consumes a tree `modelCalls` admission.
Each new tool attempt consumes a local `toolCalls` admission. Neither retries nor observation
reset counters, local deadlines or the tree deadline. Retries replace the same logical turn;
they do not grant another tool-capable turn. Settled failures and cancelled runs are not retried.

Each model/tool journal entry has an `interrupted` array. Model entries retain the last measured
usage for every interrupted attempt, and usage updates are checkpointed before reading more
chunks. `usage` and `treeUsage` include every attempt once. Outcome `receipts` contains one entry
per attempt: key billing by `(id, attemptId)`, not just `id`. Model receipts have
`billing: "unknown"` while running or interrupted, and `"reported"` once a stream with a usage
report completes. A completed stream without usage stays `"unknown"`. Reported is not an audited
bill. A process can die before saving a new usage report, and an
interrupted request may cost more than its saved usage. Ordinary tool charges remain unknown.

Before replacement output, `operation_restart` reports `kind`, `runId`, `operationId`,
`previousAttemptId` and `attemptId`. A display projector must clear the interrupted attempt's
partial text before applying the replacement, not append to it. Keep the operation's row.
`model_chunk.attemptId` and the snapshot's current attempt also identify the replacement if the
best-effort restart event is missed. Reading or reconnecting an observer never starts a retry;
only an authorized executor holding the host's lease may resume. Partial text is not durable in
the execution journal. This policy does not add event batching or awaited event storage.

The host's decision store must insert requests once, move pending requests to one decision,
and reserve a submitted batch atomically. A crash can occur after evidence is consumed but before
the decision checkpoint. Resolving the same authorized claim must return the same decision;
another claim, segment, actor or resource version must be refused. No in-memory boolean can
provide that guarantee across a restart.

Snapshots and raw events hold private prompts, arguments and answers. Keep them on the server
and build an allowlisted display view. Question text and choices may come from the model: treat
them as untrusted display content. Snapshot format 3 includes resolved recovery policy and
per-operation attempt histories, an `inputs` journal, a `guards` journal and a `compactions` journal
on every node. Each tool entry requires `retries`, including an empty list when unused.
Its definition includes `guardrails`, `compaction` and `toolRetries` (null when unused). Checked `submit_result` receipts keep
`final.candidate`, just as stopping tools do, rather than reconstructing it from model arguments.
Older formats, earlier format-3 shapes without those fields and the old single-approval state are
refused, not converted.

### Retry a failed tool call

Ordinary tool failures still return to the model as data. There is no automatic retry by default.
To allow bounded retries of one registered read-only tool:

```ts
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the records and answer.",
  provider,
  tools: [lookup],
  toolRetries: {
    identity: "lookup-retries-1",
    tools: { lookup: { maxAttempts: 2, replay: "read-only" } },
  },
});
```

`lookup` must have `isReadOnly: true`, and the run must supply `host.beforeTool`. A retry checks
current access again, after its input guard and start hook. Read-only is not free: each attempt
may incur another charge or return newer data. Attempts consume `limits.toolCalls`, share the
tree's tool serialization and keep the original deadlines. They do not buy another model turn.

`maxAttempts` includes the first attempt and crash recovery attempts for that operation. Only
`failed` and `timeout` tool outcomes qualify. Invalid arguments or output need correction, not
another identical call. When the budget ends, the last failure returns to the model. A new model
call to the same tool is a new operation, still bounded by the run's tool and model limits.

For a write, use `replay: "reconcile"` and supply `host.reconcileToolRetry(attempt, context)`.
The callback receives the exact failed `request` and `result`. It must query authoritative host
or service state, not dispatch work. Return `{ outcome: "not_run", receipt }` only after confirming
that this attempt did not run **and cannot still complete**. Return `{ outcome: "unknown" }`
otherwise. Missing or uncertain reconciliation stops the run with `tool_retry_unsafe`. A timeout,
an error string saying "nothing happened" or an idempotency key does not prove safety.
For background runs, supply the same callback as `policy.reconcileToolRetry`;
it runs under the existing worker signal and checkpoint barriers.

Retries keep the same operation and arguments but get a distinct `attemptId`. Every failed attempt
stays in `tools[].retries`, with its arguments, result and any reconciliation receipt. Outcome
`receipts` retains each attempt. The failed result is saved before reconciliation, and its receipt
is saved before another attempt is admitted. Resume checks current authorization again without
repeating a saved reconciliation. A running retry still has an unknown outcome after a crash:
only the existing read-only recovery policy can replay it. Interrupted writes remain refused.

Client tools, delegations, handoffs, stopping tools and tools requiring approval cannot be named
in this policy. A call with any approval or question history never uses it, including a call with
edited arguments. A new approval requirement, Stop, guard rejection, lease loss or failed progress
write cannot become a retry. Calls configured for retry run serially within their agent. Change
`toolRetries.identity` when the implementation or hidden effect policy changes; definitions and
policy are checked against the saved run.

## Background runs

`@providerkit/agents/runs` binds an agent to `@gusnips/server/runs` 0.19, 0.20 or 0.21.
Awaited progress needs 0.21. Install that optional peer only when using this entry. Supply your
existing run service, durable queue callback and trusted policy factory:

```ts
import { createBackgroundAgent } from "@providerkit/agents/runs";

const jobs = createBackgroundAgent({
  agent: writer,
  kind: "writer-v1",
  runs,
  enqueue,
  policy,
});

const { id } = await jobs.start(authenticatedOwner, "Write a release note.");
const saved = await jobs.wait(authenticatedOwner, id);
```

The owner must come from your authentication code, not an unchecked request field. Reads,
observation, waiting, cancellation and resume all require it. A worker calls
`runs.drive(id, jobs.handlers)`. Run `runs.sweep` on boot and periodically to queue unfinished work,
and call `runs.drain` before shutting down. See [the background example](examples/background.ts)
for these connections. A stored job without a worker and recovery sweep does not run itself.

`start` saves the input before returning an ID. If queueing fails, `BackgroundEnqueueError.id`
identifies the saved run. Requeue that ID or let the sweep find it; do not create another run.

You can inject `runs.create` to save the run and your own records in one transaction. It must
resolve only after commit, not from inside an uncommitted outer transaction. The SDK calls
`enqueue` afterward. A rollback must reject creation, so nothing is queued. Never keep that
transaction open through model or tool execution. The host owns its transaction client and
must reconcile an unknown commit before trying creation again.

`start` takes the same input as `run`. For a conversation, pass a session factory and the
conversation's id:

```ts
const jobs = createBackgroundAgent({
  agent: writer,
  kind: "writer-v1",
  runs,
  enqueue,
  policy,
  session: openConversation,
});
const { id } = await jobs.start(authenticatedOwner, "Add a section on costs.", { sessionId });
```

`openConversation(owner, id)` is your trusted code, and returns a `Session`. It must check that
the owner may use that conversation: an id from a request is not authorization. `start` reads the history inside the authenticated
request and freezes it in the saved run. The worker gets the session again from the factory, with
the stored owner, and appends the turn when the run settles; `saved.outcome.session` says whether
that worked. `historyLimit` and `prepareHistory` on `createBackgroundAgent` apply in `start`.
Media references are read in the worker through `policy.loadMedia`.

`start` also takes `context`, `modelSettings` and `enabledTools`. Build these in trusted server
code. Context is available to the definition callbacks while `start` runs, but is not stored.
Only the resolved definition is saved. The worker's tools get fresh context from `policy.context`.
Background `start` refuses model-setting observers because functions cannot survive the queue.
Put them on the agent instead.

`read` and `wait` return two statuses. `saved.status` describes the host worker run;
`saved.outcome?.status` describes the agent. A successful worker run can contain a suspended or
failed agent outcome. Read the latter before treating the answer as complete. `saved.snapshot`
holds the whole conversation: keep it, and every raw event `observe` yields, on the server.

Pass an observer signal to `observe` or `wait` to stop listening. That does not cancel the work.
`cancel(owner, id)` cancels the whole run tree. Children execute in-process under their root's
lease; they are not independently owned distributed jobs.

### Stored progress

Background storage merges adjacent text or reasoning deltas from the same run, operation and
attempt. Only single-field text deltas with the same provider source merge. Tool calls, usage,
signatures, other payloads and boundary events stay separate. Raw `onEvent` callbacks on portable
runs still receive every original event, without waiting for storage.

By default, `events: "best-effort"` sends these records through `Run.emit`. The SDK flushes its
buffer after 100 ms, at a boundary event, at a checkpoint and before returning an outcome.
This does not await database writes: storage failures still go to the host's `onError`. Older
server minors remain valid, and this mode cannot bound the host's own unacknowledged emit queue.

To await storage, set the option when binding the agent:

```ts
const jobs = createBackgroundAgent({
  agent: writer,
  kind: "writer-v1",
  runs,
  enqueue,
  policy,
  events: "awaited",
});
```

The worker requires `Run.append` before any model or tool work. Events are stored in order, with
one append in flight. Every journal save waits for earlier progress, and every outcome waits for
its final state event, including child outcomes. Input acknowledgement still follows the saved
journal. This is not one atomic event-and-checkpoint transaction. A crash between writes can
leave events ahead of a checkpoint, or omit a state event emitted after its checkpoint.

`observe` still yields raw host `RunEvent` rows. Their types are:

- `agent`: the existing `AgentEvent`, possibly with merged text.
- `agent.gap`: `{ dropped, unconfirmed }`. Counts refer to original events before merging.
  `dropped` means the buffer refused them. `unconfirmed` means an append rejected and may already
  have stored them. It does not mean they are definitely missing.
- `agent.resync`: `{ crashes }`, stored before a recovered worker resumes the agent in awaited mode.
- `end`: the host's terminal record, after its handler finishes.

On a gap or resync, read the saved run and rebuild the display from its journal before applying
later events. A gap is not proof that work failed, and an event is not proof that a checkpoint
committed. The execution journal remains authoritative. Continue strictly after the last `seq`;
the cursor belongs to that physical run id. A request continuation returns a new id and cursor.
Observation never replays an effect or starts a model attempt.

Each buffer holds at most 64 records and 256 KiB of UTF-8 event JSON, counted before merging.
There is one waiting buffer and one in-flight batch. Overflow drops a suffix, never reorders it;
a new gap record follows that prefix. An oversized event is dropped too. In awaited mode, a
rejected append is never resent by the SDK. It tries to append a new uncertainty marker instead.
Execution continues only after that marker is stored. If even the marker fails, the worker stops
and reports the storage failure. Stop and lease loss also stop writes, without undoing effects.
An in-flight append is allowed to settle before cleanup; it is not abandoned or replayed.

A killed worker can lose the still-buffered tail. The next worker's resync marker tells readers
to reload; it cannot count those lost events. A final checkpoint can recover settled output, not
every partial token. Raw logs contain private reasoning, tool arguments and results: keep them
server-side, apply the host's access and retention rules, and project only safe display data.

Custom portable hosts can implement `AgentHost.progress` with synchronous `push` and awaited
`flush`. `push` accepts a frozen event into bounded storage; `flush` must surface write failures.
Unlike `onEvent`, these failures are not ignored. The SDK awaits this hook at every journal-save
boundary and final outcome. It supplies no lease or storage of its own.

### Background request policy

The required `policy` factory receives the authoritative owner and host run ID. It provides the
same resume and tool checks described above, plus `claimContinuation`. Keep these rules in trusted
server code:

- `authorizeResume` checks stored state and ownership on every attempt.
- `prepareRequest` supplies the actor, resource version and request expiry.
- `claimContinuation(snapshot, continuation)` authenticates `continuation.answers` and atomically
  reserves every named request for `continuation.id` and this host segment. Repeating the exact
  claim during recovery must succeed; a different claim, segment or resource version must fail.
- `resolveRequest` returns each decision only for that claim. `beforeTool` checks current access
  and resource version again immediately before the action.

Return database handles or other worker-only tool values through `policy.context`. They are not
serialized. Do not put secrets or handles in a saved snapshot.

`resume(owner, id, answers)` saves a new host run with the same logical agent history. Answer
all or some requests by id. It queues evidence, not permission. The worker claims the batch under
its lease after the row exists; read or wait on the returned ID to learn whether it was accepted.
Recovery skips decisions already in the journal and resolves only still-open ids from that exact
batch. It never applies old evidence to a new request. Completed children, usage and pending
session state survive partial resolution. The host must store claims durably.

Expired submissions are refused before queueing. Renew approvals or questions through a trusted
portable resume after reconciling stored state; do not submit a new snapshot from the browser.

This binding stores token-usage receipts, not money. It does not call the run service's additive
`spend()` method or claim atomic billing with checkpoints. Account for recorded operations using
operation and attempt IDs in your own billing system. Configure `recovery` on each agent that
may replay interrupted work; `runs.sweep` and the same leased worker handler resume it without
starting another logical run.

## Check your agent

Run a set of checks and get a report:

```ts
const report = await runEvals(checks);
```

Import evaluation helpers from `@providerkit/agents/evals`. They run the same agent loop and
score its saved journal; they do not replay stored effects.

This setup uses an offline provider. It sends no network requests:

```ts
import { defineAgent } from "@providerkit/agents";
import { assertReport, exact, runEvals, scriptedProvider } from "@providerkit/agents/evals";

const checks = {
  agent: () =>
    defineAgent({
      id: "greeting",
      version: "1",
      instructions: "Say hello.",
      provider: scriptedProvider(["Hello"]),
    }),
  cases: [{ id: "hello", input: "Hi", expected: "Hello" }],
  scorers: [exact()],
};

const report = await runEvals(checks);
assertReport(report); // Throws if the checks did not pass.
```

Use `contains`, `schema`, `similarity`, `trajectory`, `toolArguments`, `answeredBy` and the
`max*` budget scorers, or supply a custom scorer. `formatReport` returns text;
`reportJson` returns JSON, and `compareReports` compares matching cases. Repeats are grouped by
source case so a case with more measured repeats does not outweigh another. Failed, skipped,
unscored and cancelled work remains counted; missing scores do not become passes.

A case supplies exactly one of `input`, `turns` or `user`. Multiple turns share a fresh SDK
memory session. Supply `resolveAgent` when a handoff changes which registered agent owns the
next turn. The [offline example](examples/evals.ts) shows multiple turns, tool mocks and scripted
approval answers. From this repository, run it with `bun run agents/examples/evals.ts`.

Keep scripted answers and tool mocks in `drivers`, separate from stored case data. Answers
match the request actually issued, including its agent, tool, question and child path. They do
not turn model-written text into permission. `stub` replaces both tool execution paths and
backend validation; it does not prove that the replaced backend checks work.

Simulated users need an explicit provider and `allowSimulation: true`. Model judges, including
`grounded`, need an explicit provider/rubric and `allowJudge: true`. These make extra provider
calls and may cost money. A judge's score is an assessment, not proof that an answer is true.
Pass current model and hosted-tool rates yourself. Spending thresholds stop more work from
starting; they are not hard financial caps on calls already in flight or on external work that
ignores cancellation. Configure SDK limits and use test data for tools that can change records.

Reports omit inputs, outputs, snapshots, reasons and exception messages by default. Use
non-sensitive case IDs: those remain in reports. `includePrivateData` opts the omitted fields
in; store and share the result accordingly. Unknown charges stay unknown. `caseFromRun` extracts
supported completed runs without executing them, and refuses input timing it cannot reproduce.
The resulting golden case contains private run data and needs review before sharing. `createLiveScorer` scores only runs
the host explicitly submits; it adds no queue or telemetry. The host owns sampling deduplication,
storage and retention.

## Development

From the repository root, run `bun install` and `bun run build`. Then, from `agents/`:

```sh
bun run lint
bun run typecheck
bun run test test/request.test.ts
bun run test test/recovery.test.ts
bun run test test/lifecycle.test.ts
bunx vitest run test/definition.test.ts
bunx vitest run test/delegation.test.ts
bunx vitest run test/subagents.test.ts
bunx vitest run test/memory.test.ts
bunx vitest run test/handoff.test.ts
bunx vitest run test/structured-handoff.test.ts
bunx vitest run test/steering.test.ts
bunx vitest run test/input.test.ts
bunx vitest run test/session.test.ts
bunx vitest run test/extensions.test.ts
bunx vitest run test/compaction.test.ts
bunx vitest run test/tool-retry.test.ts
bun examples/guardrails.ts
bun examples/basic.ts
bun examples/specialists.ts
bun examples/subagents.ts
bun examples/memory.ts
bun examples/conversation.ts
bun examples/handoff.ts
bun examples/structured-handoff.ts
bun examples/steering.ts
```

These checks and examples use fake providers and tools. They do not call a live model or any app.
The basic example runs a model/tool round. The specialist example runs a manager with two children
and returns their notes in order. The conversation example runs two turns on a session, one with
a picture sent by reference. The handoff example transfers an invoice question, then routes the
next turn to the returned active agent. The structured-handoff example transfers between two
checked schemas and restores the target's typed result. The steering example adds a message while a tool works
and retains a message sent too late for the model to read. None needs an API key.

The background integration file needs a disposable local PostgreSQL database named
`providerkit_agents`. It creates and drops its own schema and starts worker processes that it
kills deliberately to check recovery. It refuses non-loopback database URLs:

```sh
AGENTS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/providerkit_agents \
  bunx vitest run test/runs.test.ts
```

Use a throwaway database, not an app database. These checks never call a live model.
