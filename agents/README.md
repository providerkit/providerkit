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
those three: use `RunOptions.signal` to stop, `RunOptions.providerSessionId` to name the provider
session (see [Sessions](#sessions)), and `output` for checked results. Provider defaults
apply first, agent settings override them, and run settings win last. Unset or `undefined` fields
inherit; `0` and `false` do not. All settings go to every model call. Support still depends on the
provider, which may refuse a setting.

The resolved settings are saved in `snapshot.definition.modelSettings`. Resume cannot change
them. The two observers, `onActivity` and `onRateLimit`, are functions, so they stay in memory
rather than in JSON. After a restart, only observers from the rebuilt agent apply; reattach
progress through `onEvent`.

`toolChoice` accepts `"auto"`, `"none"`, `"required"` or `{ name: "lookup" }`. A named tool must
be enabled. `"required"` becomes `"auto"` once a turn has called any tool. A named tool stays
forced until a call of it succeeds: a failed or denied call, or a call to another tool, forces it
again on the next turn, up to the turn limit. Use it for a step the rest of the run depends on,
such as a router. Both read the journal, so a resumed run keeps the choice where it was.
`"none"` stays `"none"`: calls a provider returns anyway are refused.
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
| `limited`   | A turn, tool-call, time, cost or provider output limit stopped the run.    |
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

## Trace a run

Add OpenTelemetry tracing to your existing run options:

```ts
const options = tracing.options(runOptions);
```

This keeps your current options, including authorization hooks, and adds tracing callbacks.
Import the adapter only where you use it:

```ts
import { createAgentTracing } from "@providerkit/agents/otel";

const tracing = createAgentTracing();
try {
  await agent.run("Summarize the changes.", tracing.options());
} finally {
  tracing.close();
}
```

Install the optional `@opentelemetry/api` peer. Your app must register its tracer and exporter,
which sends trace records to your chosen service. The package installs neither and makes no
telemetry request by itself. You can pass an existing `tracer` and `parentContext` instead.
Normal SDK imports do not load this adapter.

A span is a timed record of an operation. Agents records runs, tool calls and workflow steps.
Core records the provider stream and its reported usage. The SDK's internal model-operation span
only connects SDK identities to the Core span; it does not duplicate provider usage. Missing or
partial usage is not a zero charge, and traces are not audited bills. A resumed run starts a new
span; time between attempts is not included.

`tracing.options(existingOptions)` composes existing observers and provider instrumentation.
For manual wiring, attach `onLifecycle`, `onEvent` and `bindModelProvider` once. Apply the provider
binding last, outside other provider decorators. A directly wrapped Core provider can be rebound;
a tracing wrapper hidden inside another decorator cannot be deduplicated.

### Context and privacy

Explicit parent contexts work without installing a context manager. Core activates context
around provider iterator calls. Tool and workflow-step hooks only observe execution: they do
not activate async context for HTTP calls inside your code. Use your app's instrumentation and
context manager for those child spans.

Prompts, results and raw errors are not captured. Code, tool inputs and remote payloads stay
private too. Node, run and operation IDs are recorded, so do not use secrets or personal text as
IDs. `AgentSpanInfo` distinguishes `nodeKind` and `nodeId` for agents, workflows and remote nodes.
The optional `attributes(info)` callback accepts host-approved scalar values under
`providerkit.host.*`: at most 32 attributes, 64-character keys and 256-character strings.

Remote spans cover local observation, not the peer's full task lifetime. The last remote state
is separate from the local run state, and billing stays unknown. Explicit `remote.cancel()` has
no separate SDK operation span; its receipt still records the request. Host HTTP instrumentation
may observe that call. A status update is not proof that a send or cancellation happened.

### End an observation

`close()` stops Agents observations, not execution. It does not cancel work, replay a request or
flush an exporter. Core streams already bound by the adapter remain observed until they end or
the caller aborts. If a stream is abandoned without ending or being aborted, this adapter cannot
close its Core span.

Defaults are 128 run observations, 1,024 operation/relationship records per run and a 30-minute
observation lifetime. `maxRuns`, `maxSpansPerRun` and `maxRunMs` change those bounds. Reaching a
bound ends or skips observations only; it never changes execution permissions or limits.

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

Some providers route and cache requests by a session id: OpenCode Go's session header, the ChatGPT
backend's `session-id` and `prompt_cache_key` on the Responses shape. Each run sends its own run
id unless you name one, so each turn of a conversation starts a new provider session. Pass the
conversation's id to keep one session for all its turns:

```ts
await writer.run("When do they slow down writes?", {
  session: thread,
  providerSessionId: thread.id,
});
```

The run saves the id with its definition, and resume keeps it. Specialists and helpers keep their
own run ids, because their instructions differ and they share no cached prompt with the parent.
Workflows and remote agents make no model calls of their own, so they refuse the option. Inside a
workflow, each agent step uses its own run id as its provider session.

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
core tool's `isConcurrencySafe` flag and the host's permission to batch it. Host tools run in your
process. Optional code mode isolates model-written programs, not your tool implementations.

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

### End only on a stopping tool

Some agents must never end by talking. A browser agent that writes a question as text has not
paused, so the person never gets to answer it. Set `stopOnlyAtTools` and the run ends only
through a stopping tool:

```ts
const browser = defineAgent({
  ...config,
  tools: [snapshot, click, done],
  stopAtTools: ["done"],
  stopOnlyAtTools: { nudge: "Respond with a tool call, not plain text. Call done when finished." },
});
```

A turn that writes text and calls no tool no longer ends the run. The model reads your `nudge` as
the next user message and keeps working. The nudge stays in the conversation the run returns,
right after the turn it answered. A turn with no text and no tool call still fails with
`empty_output`, unless [`finish.emptyTurns`](#finish-a-run-that-hits-a-limit-or-gets-cut-off)
allows a few.

A stopping tool may share its turn with other calls. The calls before it run as usual. Once it
succeeds, each call after it gets a cancelled result that reads "The run ended earlier this turn
(`done`). This call did not run." In this mode a stopping tool runs on its own, never in a
parallel batch, so the calls after it have not started when it succeeds. `submit_result` and
handoffs still run alone.

When a text agent's stopping tool returns an empty summary, the turn's text is the answer. That
covers a model that writes its answer as text and calls `done` with nothing in it. When both are
empty, the model gets the empty result back and tries again. A turn cut by the output limit is
different: it ends the run with `limited: outputTokens`, before any of its calls run. With
`finish`, it gets a finish turn instead.

The stopping tool can be one named in `stopAtTools`, a tool with `isTerminal: true`, or
`submit_result` with an output contract. Without one, `defineAgent` throws. So does a run that
turns off every stopping tool, through `enabledTools` or `toolChoice: "none"`: it could never
end. The turn limit is a hard cap in this mode: there is no tool-free final call, because it
could not end the run. With `finish`, the run's last call makes the model call its stopping tool.

### Finish a run that hits a limit or gets cut off

By default a run that reaches a limit stops there, with no answer for the work it paid for. Set
`finish` and the run gets one more model call to give its answer:

```ts
const analyst = defineAgent({ ...config, output, limits: { turns: 8 }, finish: {} });
```

That call, the finish turn, comes when:

- the run reaches `limits.turns`, `limits.toolCalls` or its own `limits.costUsd`
- the output limit cut a turn off. A tool call whose arguments do not parse counts as cut, and none
  of that turn's calls run
- a checked-output agent answered in text instead of calling `submit_result`

The model reads a short note that says why. A text agent then answers with no tools, and after a
cut it is asked for a shorter answer. A checked-output agent is made to call `submit_result`, and
a `stopOnlyAtTools` agent its stopping tool. Those calls run at effort `none`, without the
reasoning of earlier turns, so the whole output budget goes to the answer. Only the one stopping
call runs: any other call the model adds gets a result that says it did not run. The note goes
with that request only, so the conversation the run returns does not include it.

A run the finish turn saves completes as usual, and `outcome.salvaged` says what would have ended
it: `"turns"`, `"toolCalls"`, `"costUsd"`, `"outputTokens"` or `"missing_result"`. When the finish
turn cannot save it, the run ends as it would have without one. The finish turn is always the
run's last call.

It is a model call like any other: priced, counted in `usage` and in the tree's call limit, and
given its own receipt. After `costUsd` that makes the cost limit soft by one bounded call. A
helper whose creator's budget is spent gets no finish turn, so a tree goes over its root's limit
by at most the root's own finish turn. Time limits, the tree's limits and a Stop stay hard.

Two more settings help a run end well:

```ts
const browser = defineAgent({
  ...config,
  finish: {
    emptyTurns: 2,
    nearEnd: "You are near the end of your budget. Call done now, or ask whether to continue.",
  },
});
```

`emptyTurns` lets that many turns in a row come back with no text and no tool call before the run
fails with `empty_output`. Each one still costs a full request, so keep it small. `nearEnd` is a
note the model reads with its last turn that has tools, one before `limits.turns`, so it can wrap
up while it still can.

### Refuse a call before it runs

Your host can look at each call before it runs and answer it with a message instead. The model
reads the message as that call's result and works around it:

```ts
await browser.run("Archive the newsletter.", {
  host: {
    screenCall(call, { earlier }) {
      const planned = earlier.some((done) => done.name === "plan" && done.result?.ok);
      if (call.call.name === "click" && !planned)
        return { refuse: "Blocked: no plan has been posted yet. Call the plan tool first." };
    },
  },
});
```

Return nothing to let the call run. `{ refuse: text }` answers this call only: the tool does not
run, no approval opens, and the result has kind `refused`. `{ cancel: text }` answers this call
and every call after it in the same model turn, each with kind `cancelled`. Use it when something
earlier in the turn changed what the rest was written for, such as a failed click:

```ts
screenCall(call, { turn, earlier }) {
  const failed = earlier.find(
    (done) => done.turn === turn && done.name === "click" && done.result?.kind === "failed",
  );
  if (failed) return { cancel: "An earlier click in this turn failed. This call did not run." };
},
```

`screenCall` runs right before each call would start. That includes calls a code program makes
and calls in a specialist's run. Its second argument holds `turn`, the model turn that asked for
the call (from 0), and `earlier`: the calls this run handled before this one, turn by turn, each
turn in the order its calls ran. A `runFirst` call comes before the calls it ran ahead of. Each
entry has its `name`, `arguments`, `turn`, and a `result` with `ok` and `kind` once it has one.
Calls let through to run together appear in `earlier` before they start, so they share an
allowance:

```ts
screenCall(call, { earlier }) {
  const searches = earlier.filter(
    (done) =>
      done.name === "search" &&
      done.result?.kind !== "refused" &&
      done.result?.kind !== "cancelled",
  );
  if (call.call.name === "search" && searches.length >= 2)
    return { refuse: "search is limited to 2 for this request. Work from what you have." };
},
```

A call that needs approval is screened before its approval opens, so nobody is asked about a
call you would refuse. When one turn opens several approvals together, the calls ahead of a call
have not run yet. A refusal or a cancel at that moment only holds back that call's approval, and
the call is screened again when its turn comes. An approved call is screened again before it
runs, after the calls ahead of it ran. That is how a failed click still cancels the approved click
behind it.

Decide from `earlier`, not from state your process keeps: after a restart, calls that had not
started are screened again. A `cancel` is saved with its call's result, so the rest of its turn
stays cancelled after a restart. A refused or cancelled call sends a `tool_result` event but no
`tool_start`, and it spends none of `limits.toolCalls`, inside a code program too. The program's
own `limits.calls` still counts it, so a program cannot loop on a refusal. `screenCall` may
return a promise, for example to read your own database. Anything other than nothing,
`{ refuse }` or `{ cancel }` with text fails the run with `invalid_screen`.

### Run a plan before the work

Models often send a plan in the same turn as the first step it describes. Name the plan tool in
`runFirst` and its calls run before the rest of their turn, so the step comes after the plan:

```ts
const browser = defineAgent({ ...config, tools: [plan, click], runFirst: ["plan"] });
```

Results keep the model's order. The rest of the turn waits for the plan's result, even when both
tools may run in parallel, so `screenCall` sees the plan in `earlier` before it decides about the
step. `submit_result` and handoffs always run alone, so `runFirst` cannot name them.

## Code mode

Let the model write a short program that calls several tools before returning an answer:

```ts
await reader.run("Add up the prices of the matching records.");
```

Install the optional QuickJS engine, then bind only the tools the program needs:

```sh
bun add quickjs-emscripten-core@^0.32.0 @jitl/quickjs-wasmfile-release-sync@^0.32.0
```

```ts
import { defineAgent } from "@providerkit/agents";
import { codeMode } from "@providerkit/agents/code-mode";
import { createQuickJsDriver } from "@providerkit/agents/code-mode/quickjs";

const program = codeMode({ tools: [lookup], driver: createQuickJsDriver() });
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Look up the records and calculate the total. Return only what the person needs.",
  provider,
  tools: [program],
  limits: { toolCalls: 64 },
});
```

The model calls `run_code` with `{ code: string }`. The code is an async function body, for
example `const rows = await tools.lookup({}); return rows.length;`. Every program starts in a
fresh sandbox. It has no network, files, process, imports or timers. It can pass JSON between
bound tools without sending every intermediate value back to the model. The host tools still
have their normal powers: authorize each action in `host.beforeTool`.

The description includes `toolTypings(tools)`, built from input schemas and core's optional
`outputSchema`. Without an output schema, that tool's return type is `unknown`. These types
help the model write code; they do not replace input validation or authorization.

### Keep control actions direct

Bindings accept ordinary core tools only. Approval-required, asking, client, terminal, delegation,
handoff, nested code and helper-creation tools are refused. A tool listed both directly and in
code must be the same object. A bound-only tool cannot be called directly by the model.

`enabledTools` narrows both the advertised code bindings and execution. Include `run_code` and
each bound name you want to permit; selecting `run_code` alone grants no inner tool. A
model-created helper needs the same explicit grants from its creator and host template.

For a dynamic `host.needsApproval` requirement, `prepareRequest`, `answerNow` and `beforeTool`
must supply a current, authoritative decision immediately. Otherwise the call returns a refusal
that code can catch; it never suspends inside the sandbox. Approved replacement arguments still
pass the tool input guard and current authorization. A stale or expired decision permits no effect.
Set `needsApproval: true` on `codeMode` to ask before the whole program starts instead.

### Limits and receipts

`codeMode({ limits })` overrides these defaults. KiB is 1,024 bytes; MiB is 1,024 KiB.

| Setting           | Default | What it bounds                                              |
| ----------------- | ------: | ----------------------------------------------------------- |
| `calls`           |      32 | Inner call attempts per program attempt, including retries  |
| `timeoutMs`       |  30,000 | Wall time, including tool waits                             |
| `cpuMs`           |   2,000 | Guest JavaScript time, excluding tool waits                 |
| `memoryBytes`     |  32 MiB | Guest heap                                                  |
| `stackBytes`      | 256 KiB | Guest stack                                                 |
| `sourceBytes`     |  64 KiB | UTF-8 program source                                        |
| `resultBytes`     |  32 KiB | JSON value returned by the program                          |
| `logBytes`        |   8 KiB | Captured console text; excess bytes are counted and dropped |
| `callInputBytes`  | 256 KiB | One inner call's JSON arguments                             |
| `callOutputBytes` |   1 MiB | One tool's JSON reply to the program                        |

The enclosing run's `parallelTools` bounds concurrent calls. Only tools marked concurrency-safe
and allowed by the host may overlap. Other calls share the tree's serial effect boundary, even
across specialists. Run and tree deadlines can end the program sooner. The driver admits at most
four programs at once by default (`maxActive`). QuickJS runs on the host thread; a busy program
can block that thread up to its CPU allowance. These guest limits do not bound allocations inside
host tools.

The program call and its inner attempts spend the run's `toolCalls` budget. An inner call your
host refuses or cancels spends none of it, though it still counts toward `codeMode.limits.calls`.
Inner calls leave one slot for a final direct tool such as `submit_result`. Raise the run budget
when needed, not just `codeMode.limits.calls`.

A successful program returns JSON text containing `result` (when defined), `logs`, `toolCalls`
and `toolCallsLeft`. A failure also includes `error` and up to 20 call summaries. Tool failures
throw a catchable `ToolError` with `tool` and `kind`. An oversized or non-JSON tool reply is refused
without erasing its effect receipt. Returning, throwing or reaching a program limit aborts
queued and running calls; their recorded outcomes settle before the program result. Queued calls
never start. Cancellation cannot undo an effect or stop a host tool that ignores its signal.

`ToolExecution.calls` holds private `ProgramCall` records. Each has a stable `id`, an `attemptId`,
the owning `programAttemptId`, tool name, original arguments and `pending`, `running` or `completed`
status. `started: false` means it never reached dispatch. Completed results retain at most 1 KiB
of text, not the full JSON output; `bytes` records the current attempt's original output size.
Retries keep their failed attempt receipts. Write starts and completions pass the existing
checkpoint barrier. Durability still requires `host.checkpoint`.

Inner `tool_start`, `tool_result` and retry `operation_restart` events carry `parentOperationId`
through their request or event. Tool receipts carry it too. Group by that field, not by parsing
ids; key attempts by `(operationId, attemptId)`. Raw events, code, arguments, logs and returned
values remain server data. Expose them only through an explicit display policy.

### After a restart

The SDK never resumes a half-run sandbox or replays a recorded write. An unfinished write fails
closed with `interrupted_operation` naming its inner operation. Reconcile it with the service
before continuing. Known completed changes stay recorded; the program closes as `interrupted`
and the model can continue without repeating those changes. Pending calls did not run.

An explicit `recovery.readOnlyTools` entry naming the code tool can restart from the beginning
only when every recorded inner call was read-only and neither program nor calls have request
history. It requires `host.beforeTool`, unchanged definitions and remaining attempt/call budgets.
The new attempt retains old receipts and continues call ids. Read-only calls may still cost money.
Provider-hosted effects keep their existing no-replay rules.

### TypeScript and Workers

No TypeScript compiler is bundled. Supply a host compiler if you want TypeScript source:

```ts
import { transform } from "sucrase"; // Install separately if you choose this compiler.

const program = codeMode({
  tools: [lookup],
  driver: createQuickJsDriver(),
  transpile: (source) => transform(source, { transforms: ["typescript"] }).code,
});
```

The hook receives an async function expression, not a raw body. Return JavaScript for that
expression; a trailing semicolon is allowed. Custom transpilers own their source mapping.

On Workers, pass an already compiled module instead of fetching and compiling WebAssembly:

```ts
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";

const driver = createQuickJsDriver({ wasmModule });
```

Browsers and extensions can set `wasmLocation` to their packaged asset. Neither the main agent
entry nor `/code-mode` imports QuickJS. A custom `CodeDriver` must honor the same fresh-sandbox,
string-bridge, limit and cleanup contract; it must never invoke host tools itself.

Run [the offline code-mode example](examples/code-mode.ts) with `bun agents/examples/code-mode.ts`.
It uses the real QuickJS driver and two local tools, with no provider key or network request.

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

## Serve tasks over A2A

A2A lets another app send tasks to your agent or workflow. Pass each HTTP request to the handler:

```ts
const response = await server.fetch(request);
```

It returns a standard `Response`. The complete [offline server example](examples/a2a-server.ts)
uses real workflow execution and an in-process client, with no socket or paid model:

```sh
bun agents/examples/a2a-server.ts
```

It prints `Hello`. The public functions live on `@providerkit/agents/a2a`:

- `createA2AServer` serves A2A 1.0 and 0.3 through JSON-RPC or HTTP+JSON.
- `createMemoryRuns` runs local agents or workflows in this process. Use your existing durable
  run service for work that must survive a restart.
- `createMemoryTaskStore` keeps owner-scoped task and message receipts. Full stores refuse new
  data rather than discard receipts that prevent duplicate work. Supply a persistent task store
  in production.

Authentication runs before body parsing. `authenticate` returns the owner and caller as
`{ owner, actorId }`; your server configuration selects the tenant. Every task, context, stream
and callback stays in that partition. `authorize` can check current access on each operation.
`bearerToken` is available for a host-owned shared secret. There is no automatic sign-in flow.

By default, even the discovery card requires authentication. `publicCard: true` opens only that
card. `allowAnonymous: true` is for development and puts callers in one shared anonymous
partition. Failed authentication never falls back to anonymous access.

Write the card's name, description and skills yourself. Prompts and private tools are not
published as skills. Supply security declarations separately in `card.security["1.0"]` and
`card.security["0.3"]`; the two formats are not interchangeable. A workflow with custom input
needs `prepare` to validate and map the incoming message. Context IDs only group tasks unless
`sessions: true` is set with an owner-checked session factory. An ID does not grant session access.

### Choose what the peer can see

No final result or transient model text leaves the process by default. `projectOutput` selects
final parts; `projectText` selects root text. Neither exposes reasoning, tool data or child
transcripts automatically. Current projection policy also applies when reading stored history.
`exposeRequest` can narrow which requests a peer sees. Remote approvals and client actions need
separate opt-ins and still use your authenticated request policy.

`a2aPolicy` checks reserved A2A evidence, then delegates to your real claim and decision handlers.
It does not turn peer text into permission. Install `a2aSegments` in workers to track continuations
started outside the HTTP handler. Its `scope(owner, runId)` must recover the original authenticated
partition from your storage. Use `server.refresh(principal, taskId)` after authoritative checkpoints
to update the task and deliver permitted notifications.

Cancellation returns `{ id, requested }`. Follow the returned physical segment; acceptance is
not proof that the task stopped. Canceling a paused durable run needs the background binding's
`createContinuation` capability. Closing an observer only detaches it. No browser timer or SDK
scheduler resumes a task automatically.

### Sign cards and send notifications

`signAgentCard` and `verifyAgentCard` use host-selected keys with ES256, EdDSA or RS256. A2A 1.0
signs normalized, known protobuf fields; unknown fields and removed empty values are not covered.
Version 0.3 signs the raw public card without its signatures. A valid signature does not authorize
an endpoint or an application action.

Push delivery requires current authorization and a host egress policy. Attempts are recorded
before sending; an uncertain delivery is never resent automatically. URL checks do not prove
where DNS resolves: your egress layer must check and pin the destination. Timestamped HMAC helpers
are an optional providerkit extension, not an A2A standard, and need host replay storage.

## Remote specialists over A2A

Run the [offline remote example](examples/a2a-remote.ts):

```sh
bun agents/examples/a2a-remote.ts
```

It prints `Done`. The peer is an in-process fetch fixture, not a live service.

`defineRemoteAgent` on `@providerkit/agents/a2a` creates a `kind: "remote"` specialist.
It has `run`, `resume`, `cancel` and `asTool`. Register it in a delegation's `specialists`
or a workflow's `agents`. Local agents, workflows and remote children use the same child
admission, host binding, checkpoints and tree limits. Remote agents are not handoff targets.
Their snapshots have a remote message journal, not made-up local models or model turns.

The main entry checks a remote node only with code that `defineRemoteAgent` hands it, so an
agent that never uses A2A bundles none of A2A's code (about 15 KB minified). A process that
resumes a run holding a remote agent must define that agent first, as it defines the run's other
agents; until then the run is refused with a TypeError that names `defineRemoteAgent`.

Configure the host-owned `id`, `agentVersion`, `card`, `version` (`"1.0"` or `"0.3"`),
`binding` (`"JSONRPC"` or `"HTTP+JSON"`) and `policy.allow`. Use `updates: "poll"` (default)
or `"stream"`; streaming requires a card that supports it. The SDK refuses missing required
extensions and options it cannot represent. No production dependency on the official A2A SDK
is needed. Credentials, headers, fetch and verification callbacks stay with the host, unsaved.
Bump `agentVersion` when hidden endpoint, authorization or output policy changes.

`run` accepts one user turn, including host-authorized media, but not a local conversation
history, session, memory binding or model settings. Children take `{ input }`.
`host.beforeTool` must authorize every send and explicit cancellation. Its `remote_send`
request includes the actual outbound message. Card text and model-written helper instructions
never grant an endpoint or tool. `asTool` uses only the description your code supplies.

Every send and follow-up saves its exact message and identity before dispatch. Cancellation
has its own receipt. None is resent after a timeout, lost reply, worker restart or model retry.
A known task can be observed with `GetTask` or a subscription; observing an old task does not
prove an uncertain follow-up arrived. Repeated read failures suspend with a `wakeAt` time.
The background binding uses the same due-wake continuation as workflows to reattach; your
existing host queue schedules it. No message is sent again and no SDK scheduler is added.
A completed result is reused only from a validated journal. Keep authoritative snapshots private and compare them in `host.authorizeResume`.

`inputRequired: "ask"` maps remote questions to local request IDs. Answers go through
`prepareRequest`, `resolveRequest` and current `beforeTool` checks. Partial or refused answers
stay pending. Remote approval and client-tool requests are refused, not converted into grants.
An authenticated `cancel` decision can request remote cancellation; `stop` ends local work only.
`inputRequired: "parent"` returns `{ kind: "input_required", handle, question }` to the parent.
Pass that handle with the next child's `{ input, continue }`. It is valid once in that root and
specialist scope, never as an arbitrary task ID. This mode accepts one free-text question;
use `"ask"` for multiple questions, choices or forms. `"fail"` declines input routing.

The default output is text from artifacts, or the final reply when there are no artifacts.
An `output` contract validates the first data part, or parsed JSON text. Peer metadata, private
error text and history are not copied into the result. Files become labels and peer URLs are
never fetched. `includeImages: true` requires an output validator and gives it
`{ content: [text and inline image parts] }`. Return those content parts to let `asTool` forward
images through the existing rich tool-result path. Input media references use `host.loadMedia`.

Defaults are 12 outbound messages, 5 minutes, 5,000,000 inline bytes and 1,048,576 result bytes.
Parent-continuation messages share the message budget. Remote work holds a tree slot and counts
as a child, not a model call. Every remote receipt has `billing: "unknown"`; `treeUsage` counts
only local reported model usage. A zero local token count does not mean a free remote task.

An aborted signal, lost worker lease or closed observation stops local work only. It does not
send `CancelTask` or undo external effects. Use `remote.cancel(snapshot, { host })` for an explicit
host-authorized request. `snapshot.remote.cancel.state === "canceled"` confirms the peer's reply;
an accepted command or an unknown reply is not cancellation proof. Repeated cancellation never
resends an uncertain request. Reconcile it with the remote operator instead.

## Workflows

A workflow is an ordinary async function with saved steps. Its input and result are typed:

```ts
const result = await totals.run({ count: 2 }); // A completed result has output: 4.
```

This small workflow needs no host because it has no effects:

```ts
import { defineWorkflow } from "@providerkit/agents/workflow";

const totals = defineWorkflow({
  id: "totals",
  version: "1",
  input: {
    schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    validate(raw) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("count" in raw) ||
        typeof raw.count !== "number"
      )
        throw new TypeError("Provide a count.");
      return { count: raw.count };
    },
  },
  async run({ count }) {
    return count * 2;
  },
});
```

For work outside that function, use its context:

- `ctx.step(key, callback, options?)` saves a host callback's result.
- `ctx.agent(key, agent, input)` runs a registered agent under the same tree budgets.
- `ctx.workflow(key, workflow, input)` runs a registered workflow under those budgets.
- `ctx.ask(question, validate)` saves a question and reads its authenticated answer.
- `ctx.sleep(key, ms)` saves a wake time and returns control while it waits.

Register children in `agents` and `workflows`. A child receives explicit input only. Agent children
keep their own guards, memory policy, tool journals and helper limits. Memory access stays bound to
this root's host-supplied scopes. A workflow has no model, transcript, session or inbox of its own.
`workflow.asTool({ name, description })` makes it a typed specialist. `defineDelegation` also accepts
workflow children. Known local failures return as tool feedback; cancellation, shared limits and
host or journal failures stop the parent.

### Put effects in steps

Supply `host.beforeStep` on every run that uses effects, children or answers. It must check current
ownership and any execution lease. The callback runs again immediately before dispatch, including
after the running marker is saved. A saved approval does not waive that check.

```ts
await ctx.step(
  "save",
  ({ input, signal, idempotencyKey }) =>
    posts.insert(input, {
      signal,
      idempotencyKey,
    }),
  { input: draft, needsApproval: true },
);
```

`posts` is your authorized host service. Step callbacks also receive `context`, `key`, `attempt`
and `report(data)`. Context stays in memory. Reported data and raw step results are server data,
not automatic display content. Use opaque fixed keys such as `save` or `review-2`, never private
input: keys appear in operation ids and progress.

Input and results must be plain JSON within `limits.resultBytes`. The first run returns the same
JSON copy as replay. Optional `validate` checks results on both paths. Approval edits require
`validateInput`; the host must explicitly allow editing. Questions and approvals use the existing
`prepareRequest`, `resolveRequest` and `answers` contracts. Workflow requests have `step`, not
`call`. Text that says "approve" and client-supplied flags grant no permission.

### Replay and parallel work

The function runs from its start after interruption. Completed effects are read from the journal,
not called again. Only context calls are recorded. Keep all other code pure: clock reads, random
values, new ids and external reads belong inside a step. Declare every value the callback uses
in `options.input`. Do not start an agent directly inside a callback or call context methods from
inside another step; that bypasses accounting or can deadlock the step gate.

Use ordinary promises for parallel branches:

```ts
const [draft, review] = await Promise.all([
  ctx.agent("draft", writer, task),
  ctx.agent("review", reviewer, task),
]);
```

A sequence uses `await`. A branch uses `if`. A map includes its position in each key; a bounded
loop includes its iteration. An evaluator loop is the same pattern: await the worker, await the
reviewer, then stop or advance the iteration. Check child statuses before using their outputs.
The barrier waits for every admitted step, even after `Promise.all` rejects or the function
returns early. A pending question or sleep still suspends a function that caught its pause.
Catch `StepFailedError` only; its `key`, `reason` and `error` describe a saved failure. A caught
failure takes the same fallback branch on replay. Do not use `Promise.race` to select a branch:
its winner is not recorded. Await every context call.

Duplicate keys in one attempt, changed step kind/input/definition and skipped recorded steps are
refused before new effects. Final output must reach every recorded step. Change `version` when
callback implementations, keys, inputs or result meaning change. Old unreleased snapshots without
the new node discriminator are refused, not converted. Keep old definitions until their runs settle.
`checkReplay(workflow, snapshot)` checks saved coordination without a host or effects; it also
compares the result of a completed journal. It cannot prove that hidden code kept the same meaning.

Defaults are 100 saved steps, four concurrent host callbacks, 262,144 UTF-8 JSON bytes per input
or result and no in-process wait. `limits.inlineWaitMs` opts into short waits in the worker.
An effect's default timeout is 60 seconds. Each step allows at most 100 recorded reservations.
Tree limits still bound children, depth, model calls and elapsed time. Workflows hold no agent
slot, so a workflow can wait on children with `maxParallel: 1`. An infinite loop without a context
call cannot be stopped by this SDK.

### Retry only repeatable work

No retry is automatic. A step left running after a crash has an unknown result and fails with
`interrupted_operation`. A timeout cannot stop code that ignores its signal. An idempotency string
or `idempotent: true` is not accepted as proof that a write can be repeated.

For a callback you know is read-only, set `retry: { maxAttempts: 2, replay: "read-only" }`.
It can still cost money or return newer data. For a write, use `replay: "reconcile"` and supply
`host.reconcileStep`. Return `{ outcome: "not_run", receipt }` only after authoritative checks
prove the entire attempt did not run **and cannot still complete**. Otherwise return
`{ outcome: "unknown" }`. The SDK saves the receipt before reserving another attempt.
Retries retain errors and every attempt id. Approval-gated steps cannot retry an old decision.

Retries default to core's full-jitter backoff with a 1-second base and 30-second cap.
`baseDelayMs`, `maxDelayMs` and a pure `retryOn` can narrow this policy. Aborts, non-transient
provider failures, quota errors and HTTP 400–407 or 409 do not retry by default. Invalid results,
failed authorization, cancellation, checkpoint failure and tree limits never become retries.
Delayed retries save their wake time before returning control.

Agent and workflow steps also accept `{ retry: { maxAttempts, replay, retryOn? } }`.
This repeats a whole child, not only its last operation. The read-only assertion must cover
**every** effect in that child. Reconciliation must cover them all too. Children with requests
or configured hosted effects cannot use whole-child retries. Each attempt gets another child
run and consumes the existing child and model-call budgets. Local limits are not retried; every
previous child and its usage remain recorded.

### Resume a wake in the background

`createBackgroundAgent({ workflow, kind, runs, enqueue, policy })` uses the same binding as agents.
It keeps injected `runs.create`'s commit-before-enqueue boundary. Set `policy.beforeStep` and use
one `kind` per workflow version. `read().wakeAt` and suspended outcomes report the earliest wake.
At that time, your existing delayed queue or scheduled job calls `resume(owner, id, {})`. An early
call is refused with the wake time. The SDK supplies no scheduler.

An empty-answer continuation has `kind: "answers"` and includes `continuation.wakeAt`.
A `kind: "cancel"` continuation has empty answers and no wake time; it cannot approve a tool
or skip ahead to a scheduled step. For a wake, your `claimContinuation` must
atomically reserve `(snapshot.runId, wakeAt)` for that claim and physical segment, even though
there are no answers. Repeating the same claim in recovery may succeed; another segment must
fail. Otherwise two delayed jobs could repeat future effects. Authentication, claims and fencing
remain host responsibilities. A wake does not refresh the tree deadline; one beyond it is a limit,
not a successful sleep. Worker cancellation and lease loss return control to the run service.

See [the offline workflow example](examples/workflow.ts). Run it with
`bun agents/examples/workflow.ts`. It asks a question, restores JSON state and reuses the completed
agent child without a live provider or application store.

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
`name` is private text: 1 to 64 letters, digits, `_` or `-`, unique among newly created helpers
admitted by this creation tool in this run. A new helper needs a new name. A follow-up uses its
helper's existing name and returned `helperId`, as described below. `tools` contains registered tool names. Omitted tools means
none; `defaultTools: "all"` grants the currently available set. A tool must be the **same object**
on both the creator and the template, and enabled on the creator. Two tools with the same name
are not interchangeable. The template's own tool-selection policy still applies.

Handoffs and ordinary delegations cannot be granted. The checked-output tool `submit_result`
stays available when the template needs it. Several helpers in one call run in parallel under
the existing tree limit. Their results return in declaration order. Separate creation calls
in one turn still run one after another, like other delegations.

Use `agent: "self"` to reuse the creator's recorded instructions and model settings. Its
instruction callbacks do not run again. Explicit templates resolve their own callbacks once.
The helper gets no parent history by default, and never gets the parent's session or inbox.
Its host instructions come first, followed by the model-written instructions. These instructions
are not permission to use a tool.

### Share approved history with a helper

A model may request `fork: true` only when the host configures `fork`:

```ts
subagentTool({
  name: "create_helpers",
  description: "Start helpers for separate parts of the question.",
  agent: helper,
  fork: {
    identity: "public-history-1",
    maxMessages: 4,
    maxBytes: 8_000,
    select: (messages) =>
      messages.flatMap((message, index) => (isApprovedForHelpers(message) ? [index] : [])),
  },
});
```

`isApprovedForHelpers` is your host's data policy, not a model judgment. `select` receives a frozen
copy of `conversationOnly` from before the creation call. System instructions, tool calls,
tool results, private reasoning and provider-owned fields have already been removed. User text,
attachments and assistant text can still be private; select only messages this helper may read.
Return their indices in increasing order. The model cannot supply indices or a filter.

Both bounds are required: up to 1,024 messages and 1,000,000 UTF-8 JSON bytes of selected history.
Too much data fails closed; it is not silently cut. The SDK saves the selected indices and exact
history before the helper runs. Replay uses that record without calling `select` again and
refuses changed source messages or history. Change `identity` when your filter changes.
The template supplies the system instructions, just as for a task-only helper. A fork never
adds tools, copies an approval or changes memory scope. References still use `host.loadMedia`.

### Send a follow-up to the same helper

Set `followUp: true` on the creation tool. A completed result includes an opaque `helperId`.
The model can then call the same tool with:

```ts
{
  agents: [{ name: "reads", continues: helperId, task: "Give one search example." }];
}
```

`helperId` comes from the earlier result. A guessed name, a run id or an id from another root,
creator or creation tool is refused. Only a completed helper with settled operations can receive
a follow-up. A suspended helper needs its explicit request answers through `resume`; a failed,
cancelled or interrupted helper cannot be restarted through `continues`.

Pass only `name`, `task` and `continues`. Instructions, tools, model settings and limits stay as
admitted. `prepare` may rewrite the new task or refuse it, not change that definition. The new
child reads the latest completed conversation, including settled tool rounds, without invoking
those tools again. Its provider session id stays the original helper's run id. It never loads
or appends an application session, and does not carry prior approvals into new operations.
Each follow-up has its own run and operation ids, so accounting does not count earlier work twice.

Forks and follow-ups require `host.beforeTool`. Check the authenticated owner, current access
and the root's execution lease there. The SDK rechecks current tool-selection policy and memory
access revisions before using earlier history. A revoked grant, changed template or inaccessible
memory fails closed. Model-written prose cannot approve these checks or choose another scope.
For stored runs, keep the existing `authorizeResume` check and exclude concurrent root attempts.
A stored helper id is a reference, not permission to run arbitrary saved work.

Two follow-ups to one helper in a batch are refused before admission. Separate calls execute
serially and use the latest settled turn. There is no second conversation store or background
scheduler. Each new follow-up consumes another child slot and `maxPerRun` admission, uses the
same local limits, and shares the root's model-call, tool serialization and time boundaries.
Neither a new turn nor an approval wait resets the root deadline.

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
existing stopping behavior. Results are `{ name, helperId, runId, status: "completed", output }`,
`{ name, helperId, runId, status: "failed", error }` or `{ name, status: "refused", error }`.
`output` is the template's checked, JSON-serializable candidate, not a validator's transformed
application object. `summarize(results)` is an optional pure callback; by default, the parent
gets JSON in declaration order. The tool succeeds when at least one helper completes.

The private record lives at `delegations[].children[].snapshot.subagent`. Its `identity` binds the
opaque id to the root, creator and original helper run. A follow-up records `previousRunId`;
a fork records its selected indices. Earlier helper records without these identity and policy
fields are refused, not converted. The existing `child`
event adds only `subagent: true`; its key is positional (`helper-1`, for example), and its agent
id belongs to the host template. It carries no model-written name, instructions or task. Display
helpers under a host-written label. Only expose a model-written name or output after your own
explicit display check. Raw tool events, snapshots and request records still contain private
prompts and must stay on the server.

See [the offline helper example](examples/subagents.ts). It creates two helpers, shares approved
history with one and sends it a follow-up. It needs no API key.

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
through `limits` when configuring an agent. A call your host refuses or cancels before it starts
does not count as a tool call. Once a text agent uses all its model turns, it gets
one final call with no tools to answer from what it found. That call still counts against the
tree's model-call and time budgets. Any tool calls it returns are refused. Checked-output agents
keep the hard turn cap because a tool-free call cannot submit their result. So do agents with
`stopOnlyAtTools`, whose run a tool-free call cannot end. With
[`finish`](#finish-a-run-that-hits-a-limit-or-gets-cut-off), every agent gets that one last call,
and so does a run that reaches its tool-call or cost limit.

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
interrupted call may have cost more than its last report. A tool's own charges, such as a paid
API, count only when the tool reports them in USD (see [Cost limit](#cost-limit)). Prices and
billing stay with the host, and these counters are not a bill. When a tool calls another model
itself, those tokens stay out of `usage` and the tree's call limits. Use SDK delegation instead
when that work must share them.

### Cost limit

`limits.costUsd` stops a run once its known spend reaches an amount in US dollars. No prices ship
in this package: your host prices each call with `priceModelCall`, and core's `costUsd` does the
arithmetic.

```ts
import { costUsd } from "@providerkit/core";

// Your own price sheet, in USD per million tokens.
const rate = { input: 0.3, output: 1.2, cacheRead: 0.03 };
const analyst = defineAgent({ ...config, limits: { costUsd: 1.5 } });

const outcome = await analyst.run("Compare the two notices.", {
  host: { priceModelCall: ({ usage }) => costUsd(usage, rate) },
});
// Once $1.50 is spent: outcome.status is "limited" and outcome.limit is "costUsd".
```

The limit covers the run's own calls, its compaction summaries and every agent it starts:
helpers, specialists and handoff targets. Before each new call, the SDK adds up the prices saved
with the calls so far. Once the total reaches the limit, no new call starts in the run or under
it, and the run ends `limited` with `costUsd`. A helper or specialist stopped this way returns a
failed tool result to its parent. A workflow's `ctx.agent` returns the `limited` outcome, so the
next step still runs.

It limits starting calls, not the bill. Calls already running when the limit is reached, such as
parallel helpers, can finish above it. A call that never reported usage adds nothing. With
[`finish`](#finish-a-run-that-hits-a-limit-or-gets-cut-off), reaching the run's own limit buys one
more call to give its answer, so the limit is soft by that one bounded call. It is priced and
counted like any other.

`priceModelCall` runs when a call's usage arrives and again when the call completes. It gets the
usage and the provider and model that served it, and must return a finite amount of 0 or more
without waiting. Anything else fails the run with `invalid_cost`. The journal keeps each price
(`costUsd` on the model execution, on its interrupted attempts and on its receipt), so a resumed
run never prices a saved call again, even when your prices change by time of day. A run with
`costUsd` and no `priceModelCall` is refused with a TypeError before it starts or resumes. A
helper's `prepare` may give one helper a lower `costUsd`.

A tool that pays for something outside the model calls, such as a paid search or a model it calls
itself, reports the amount with `reportCost` on its context:

```ts
const search = defineTool({
  name: "search",
  description: "Search the archive.",
  inputSchema: { type: "object" },
  run: async (input, context) => {
    const found = await archive.search(input);
    if (typeof context.reportCost === "function") context.reportCost(found.costUsd);
    return found.text;
  },
});
```

The check keeps the tool usable outside an agent run, where the context has no `reportCost`. The
amount joins the known cost that the limit checks before the next model call, so the rest of the
batch still runs. The SDK saves it right away in `snapshot.toolCosts`, with the call attempt that
spent it, and that attempt's receipt carries it as `costUsd`. A retried or replayed call keeps each
attempt's charge. So does a call that reports a cost and then asks the person: the answer runs the
tool again as a new attempt, and the attempt that asked gets its own receipt, with status `asked`.
Report before the tool returns: a later report, say from work that outlived the tool's timeout, is
saved with the run's next checkpoint, and is lost if the run has ended. An amount that is not a
finite number of 0 or more throws a TypeError in the tool and is not saved. `reportCost` works
without a cost limit too, so your ledger can read the charges from the receipts.

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
- Optional `screenCall(call, { turn, earlier })` refuses a call before any approval opens for
  it, so nobody is asked about work the host would refuse. See
  [Refuse a call before it runs](#refuse-a-call-before-it-runs).

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
interrupted request may cost more than its saved usage. A tool's own charges are known only when
the tool reports them with `reportCost` (see [Cost limit](#cost-limit)).

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
`cancel(owner, id)` returns `{ id, requested }`. Follow that physical ID: `requested: true`
means the command was accepted, not that execution stopped. Children run in-process under the
root's lease. Local cancellation never sends a remote A2A `CancelTask`.

A successful host row can hold a suspended logical run. To cancel it, supply the optional
`createContinuation` callback. It receives `BackgroundContinuationInput`:
`{ kind, owner, restart: "resume", input: { format: 1, snapshot, continuation } }` and returns
`BackgroundContinuationResult`, `{ id }`. In one transaction, authenticate the owner, check the
current source and create or reconcile `(owner, continuation.sourceId, continuation.id)`.
Store the exact input and commit before returning the same physical ID. Refuse a changed input
or competing claim. The cancellation claim is stable; the worker still checks and claims it
under its lease. Do not replace this transaction with a process-local cache or an idempotency flag.

Without this capability, suspended cancellation refuses before creating or queueing anything.
Running-row cancellation and users who do not cancel suspensions need no extra setup. When
supplied, the callback also admits answer/wake continuations. An uncertain callback response
must reconcile the same claim; do not create a second row. An enqueue failure exposes the saved
ID through `BackgroundEnqueueError`. A second Stop on the cancellation segment follows it
without aborting the worker that must save the cancelled outcome.

`start` can take a logical `runId`. The policy context contains that ID and the physical
`segmentId`. `onSegment` is awaited at start and after the SDK journal settles, with the owner,
physical ID, logical ID, state, private snapshot and live worker signal. It may repeat after
worker loss. End is not proof that the host committed its row. A cancellation continuation
keeps that worker signal live and passes a separate aborted signal to SDK execution.

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
- `claimContinuation(snapshot, continuation)` checks its required `kind`. For `"answers"`,
  authenticate `continuation.answers` and atomically reserve every named request for
  `continuation.id` and this host segment. For `"cancel"`, claim the current source under the
  owner without granting any pending request. Repeating the exact claim during recovery must
  succeed; a different claim, segment or resource version must fail.
- `resolveRequest` returns each decision only for that claim. `beforeTool` checks current access
  and resource version again immediately before the action.

The optional `screenCall`, `needsApproval`, `answerNow` and `canRunConcurrently` work as they do
on a direct run's host.

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
match the actual request. Select its agent/tool or workflow/step; question keys, original input
and child paths can narrow the match. They do not turn model-written text into permission.
`stub` replaces both tool execution paths and
backend validation; it does not prove that the replaced backend checks work.

Give the eval's `host` the same `screenCall`, `needsApproval` and `canRunConcurrently` your app
uses, so a check runs your agent with its own rules. An eval host cannot answer requests: that is
what `drivers` are for.

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

`remoteAttempts` contains only remote operation identities, send/cancel actions, status and
unknown billing. Remote requests are not counted as local model or tool calls, and unknown
charges are not treated as free. Peer endpoints, callbacks and task/context handles stay out of
these report records. An accepted cancellation request is not proof that the peer stopped.

## Upgrade from 0.2

Version 0.3 adds the [cost limit](#cost-limit). `LimitReason` has a new value, `costUsd`, so a map
that names every limit reason needs one more entry. Saved 0.2 snapshots stay valid, and nothing
changes for a host that sets no `costUsd` and no `priceModelCall`.

## Upgrade from 0.1

Version 0.2 requires `@providerkit/core` 0.33.1 or newer within 0.33. Finish outstanding 0.1 runs
before upgrading: stored format-2 snapshots are not accepted by the format-3 runtime.

The request API replaces the single approval decision with request-keyed answers and host
claims. Update your authorization and continuation handlers using [the request contract](#asking-the-person);
model or browser data cannot supply those grants. Execution trees now contain `agent`, `workflow`
and `remote` nodes. Check `kind` before reading model journals or workflow steps.

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
