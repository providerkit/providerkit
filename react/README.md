# @providerkit/react

Send a message and keep its streamed answer on screen:

```ts
await chat.send("Summarize this page.");
```

This package is under development. Version 0.1.0 has not been released.

The hooks manage messages, live updates, connection state and pending actions. Your server runs
agents, keeps conversations and checks access. Use the hooks with your own components, or use the
optional chat components and stylesheet. Tailwind is not required.

## Connect your server

React 19 is required. Install core too when using the SSE adapter, which reads a stream of server
updates through `fetch`:

```sh
bun add @providerkit/react @providerkit/core
```

Configure the transport once:

```ts
import { createSseTransport } from "@providerkit/react/sse";

export const transport = createSseTransport({
  send: () => "/api/chat/send",
  observe: (cursor) => ({
    url: "/api/chat/events",
    headers: cursor ? { "Last-Event-ID": JSON.stringify(cursor) } : {},
  }),
});
```

These are example endpoints, not routes the package creates. Your server must accept this cursor
format and return display events. The adapter sends the message as JSON and reads observations
with GET. Pass your app's `fetch` function if it already handles authentication.

Use the same transport object for the lifetime of one conversation:

```tsx
import { useChat } from "@providerkit/react";
import { transport } from "./transport.ts";

function Chat() {
  const chat = useChat({ id: "example", transport });

  return (
    <section aria-label="Conversation">
      {chat.messages.map((message) => (
        <div key={message.id}>
          {message.parts.map((part) =>
            part.type === "text" ? <p key={part.id}>{part.text}</p> : null,
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={!chat.canSend}
        onClick={() => void chat.send("Summarize this page.")}
      >
        {chat.status === "sending" ? "Sending..." : "Send a message"}
      </button>
      {chat.error && <p role="alert">{chat.error.message}</p>}
      {chat.canReconnect && (
        <button type="button" onClick={chat.reconnect}>
          Reconnect
        </button>
      )}
    </section>
  );
}
```

This small example draws only text. An app can also draw tool results, sources, attachments and
requests from the other message parts. No model key belongs in this component.

When the person changes account or conversation, pass a new `id` and a transport scoped to that
account and conversation. The hook detaches the old observer. The server still checks the caller
on every endpoint; a browser ID is not permission.

## Keep run state separate from connection state

A run can keep working while its connection is lost. `chat.run.status` describes the work;
`chat.connection` describes the observer.

- Closing the screen detaches its observer. It does not stop background work.
- `chat.stop()` asks the host to stop when the transport supplies a stop command. Stop does not
  undo actions that already happened.
- A lost observation can reconnect. The client never repeats a send or approval just to restore
  the screen.
- A send with no confirmed reply can have reached the server. Keep it visible as unconfirmed and
  check the saved conversation before offering a resend. A successful `send` result includes
  `outcome: "accepted" | "unknown"`; a custom composer clears its submitted draft only when
  `result.ok && result.outcome === "accepted"`. `ok` alone means the message remains in the view,
  not that the server confirmed it.

For a read-only screen, use `useAgentRun({ id, transport })`. It observes the same display events
without exposing a send action.

A transport can use SSE, a message port or an app-specific connection. Keep commands that start or
change work separate from observation. `createChatClient` exposes the same state without React
hooks; call `attach()` to observe and call the returned function to detach.

## Display events

`@providerkit/react/protocol` contains the types, parser and reducer. It has no React or DOM
requirement, so another state library can use it too.

Events use `v: 1` and stable message and part IDs. The event types are `snapshot`, `message`,
`part`, `text`, `run` and `input`. Input receipts report delivery, not an answer. A server that supports replay includes `segment` and `seq` in the JSON
data. The SSE parser does not expose `id:` fields, so an SSE ID alone is not enough.

`parseChatEvent` validates a received value. `reduceChat` applies a valid event, drops duplicate
sequence numbers and keeps settled output from becoming live again. Use a new segment when a
continuation creates a new physical run; do not reuse the old segment's cursor.

A snapshot reconciles saved messages with live output. It is not proof that every streamed token
was stored. A closed stream is not proof that the agent finished.

## Project agent runs on the server

Agent events and snapshots contain private data. Do not send them directly to a browser.

```ts
import { createAgentProjector } from "@providerkit/react/agents";

const projector = createAgentProjector({
  messageId: assistantMessageId,
  runId: logicalAgentRunId,
});
```

Allocate `assistantMessageId` once when the run starts and keep it with the conversation. The
logical agent run ID stays the same across approval continuations; the physical segment ID can
change.

Feed the projector the agent events in their recorded order. Pass `{ segment, seq }` to
`projector.event` for their location in the host's log. One agent event can produce several
display events; keep their order, including the unnumbered events before the last numbered one.

To restore an observer after its cursor, feed a fresh projector the retained log from its start
and send only the output for entries after the cursor. For a fresh observer, send the retained
log, then an authoritative snapshot read after that log, then new events. Sending the snapshot
first and replaying older progress into it can make a waiting run appear active again.

The projector hides the run input, reasoning, specialist text, tool arguments and results, raw
failure messages and approval scope by default. Host callbacks opt specific display data in.
Those callbacks must check what the current viewer may see. Rendering policy never replaces
server authorization.

A checked output reaches the `output` callback as the submitted candidate, not as a transformed
validator result. Validate it with the agent's own output validator before exposing fields. A
result supplied through that callback can become text or a host-rendered data card.

The host's conversation store remains the source of the person's messages. A run input can hold
private context and must not become a user message on screen.

## Show workflow steps

```ts
const message = projector.snapshot(savedWorkflow);
```

The same projector accepts agent and workflow snapshots (`TreeNode`). A workflow has steps and
children, not model history. It can sit under an agent or start the tree itself. For a workflow
root, pass `workflowId` instead of `agentId` when creating the projector. There is no workflow-start
event to supply that identity. `run(saved)` works without calling `snapshot(saved)` first.

Steps use the existing activity row: `ToolPart` with `kind: "step"`. They are not model tool calls.
The row ID is the SDK operation ID. `attempt` follows saved effect attempts; continuing a question
or sleep does not count as a new attempt. Retried children have separate child rows. A workflow
child is an `AgentPart` with `kind: "workflow"` and `workflowId`, never a fake `agentId`. It does
not take over the conversation. Agent handoffs still determine `RunInfo.owner` and visible text.

Default step labels are "Step" or "Waiting to continue". Use `labels.step`, `labels.workflow`
or the `step(activity)` callback for approved labels and details. Step keys can contain app data,
so they are not copied into labels. Keep keys safe for display IDs too: the SDK embeds keys in
operation IDs. Never put personal data in those keys.

The callback receives private server data. Saved steps can include input, result and error;
live progress can include a private payload. None crosses by default. Live result events contain
status, not the saved result value. Read a checkpoint before projecting result details. Do not
spread an activity into a display part.

Step-origin questions and approvals use the same request cards and `respond` command. Their
`toolId` links to the step row; it does not turn the request into a model call. The SDK request
has `step` instead of `call`. Client-tool projection accepts only actual tool-origin requests;
a step request cannot select a browser handler.

A suspended run has `waitingFor: "response"` when an open request needs an answer, otherwise
`"continuation"`. `run(saved)` includes the earliest saved `wakeAt` for a scheduled pause or retry.
Live state events do not carry that time, so the host must send the saved snapshot. The UI says
"Waiting to continue" rather than asking for approval. `waitingUntil` and `waitingContinuation`
labels customize that copy. No client timer resumes work. A wake time is not permission: the host
must claim the continuation and recheck access before resuming, even with an empty answer map.

## Answer requests

Requests have their own IDs. A tool can ask more than once, so never use its operation ID as the
answer key or parse a request ID to find a child run. The server looks up that ID in its saved journal.

```ts
await chat.respond(requestId, { type: "approve" });
await chat.respond(requestId, { type: "answer", answer: { text: "Use the short version." } });
```

`respond` also accepts a list. Send several answers together when your host starts one continuation
for the batch. Partial batches are supported; unanswered requests remain open. The host must claim
a continuation and prevent concurrent answers from starting the same work twice.

```ts
await chat.respond([
  { requestId: firstId, response: { type: "approve" } },
  { requestId: secondId, response: { type: "answer", answer: { choices: ["short"] } } },
]);
```

Responses are `approve`, `deny`, `answer`, `result`, `cancel` and `stop`. An approval can include
replacement `arguments` and form `data` only when the host exposes those controls. An answer holds
`choices`, `text` or `data` under `answer`; a client result uses `value`. Stop goes on its own.
`parseRequestAnswers` checks the wire shape, not permission. The server still resolves evidence
through the SDK's `resolveRequest` and passes request-keyed evidence to `resume(snapshot, { answers })`.
Never turn a browser response directly into a trusted SDK decision.

The response result has `outcome: "accepted" | "unknown"`. Accepted means delivery, not approval
or completion. Only host updates close requests. A refusal keeps the submitted values for correction.
An unknown outcome keeps them unconfirmed and is never resent automatically. Read the saved
conversation before offering a manual retry. Keep the same authenticated principal and conversation
in the hook's `id`; change it when either changes. Retained hook callbacks stop working after that
scope closes. Plain clients must also be replaced when their scope changes. Hooks pass that local
identity to `Conversation` as `scopeKey`. Plain-data hosts and standalone `RequestCard` users must
set `scopeKey` too when a screen can change account or conversation. It resets in-memory request
drafts and retained callbacks even if two scopes use the same message IDs. It is never rendered
or sent as execution authority.

### Choose what the viewer sees

The projector reads open and closed `asks` records under every tool and child. A decided, closed
or finished record is never pending. It preserves closed requests on reload without exposing
answers, edited arguments, receipt tokens, scope identities or private problem messages.

Questions and client actions show a generic waiting row by default. Use `request` to return only
fields this viewer may read. Do not spread the raw request or its decision into display data.

```ts
const projector = createAgentProjector({
  messageId,
  runId,
  request: ({ request }) => {
    // Check viewer access here before returning question text or choices.
    if (request.ask.type !== "question") return undefined;
    return { title: request.ask.message, choices: request.ask.choices };
  },
});
```

Return `canAnswer: false` for a viewer who can read but cannot answer. A question needs an explicit
title before it becomes answerable. The callback is also where the host can supply a safe problem
message, a form schema or approval edit controls. Approval schemas and edits use a host action slot;
the default card offers Skip instead of silently dropping required fields.

`RequestCard`, `QuestionFields` and `SchemaForm` are composable. `QuestionFields` and `SchemaForm`
are controlled: pass their values and change callbacks. `RequestCard` keeps drafts in memory by
request ID, or accepts controlled `value` and `onValueChange` props. It never clears an answer on
submission, refusal or closure. Plain-data hosts can report rejection with a new pending `part`
that includes `problem`; the card restores its controls without requiring `RequestView.local`.
Keep controlled values in the host if cards can leave the transcript. If focus is inside the card
when submitting, it moves to the labelled region before controls are disabled. After refusal it
returns to an editable field, or an available control. With no available control, focus stays in
the region. It does not restore focus if you moved elsewhere or the request or scope was replaced.
There is no automatic storage. Use a host-owned, principal-and-conversation-scoped draft adapter
if you need persistence, and disclose what is saved. Replacing a request must not move its old
answer into the new request.

Use `renderRequest` on `MessageList`, or `renderActions` on a card, for host dialogs and custom
controls. The slot's callbacks still check expiry, closure and unmount. Use `renderForm` for richer
forms. The built-in subset supports up to 20 flat fields: strings with length bounds, numbers and
integers with bounds, booleans, string enums and unique arrays of string enums (up to 100 options).
Unknown keywords refuse the whole form. This includes `pattern`, `$ref`, nested objects, defaults
and conditional schemas. Nothing fetches schemas, runs code or evaluates model-written regexes.
The card explains the limit and offers Skip. Native controls help with input; the host must validate
all fields again. Labels, including recovery text, can be replaced through `labels`.

### Run a client action

Client handlers are app code registered by name. Receiving a request, reconnecting, mounting in
Strict Mode or reloading never runs a handler. The server opts an input into display with a
`clientTools` callback. It receives `PendingRequest.call.arguments`, the effective approved input,
not the original model-written `call.call.arguments` string. Filter and validate it for the viewer.

A pure, read-only handler can look like this:

```ts
const clientTools = {
  countText: {
    safety: "read-only",
    run(input: unknown) {
      if (typeof input !== "string") throw new TypeError("Expected sample text.");
      return { length: input.length };
    },
  },
};
```

Pass that registry to `useChat` or `createChatClient`. Call `chat.startClientTool(requestId)` only
from an explicit user action, never from an effect or a replay listener. Every handler declares
`safety: "read-only"` or `"repeatable"` only when repeating it is safe. All other handlers require
`safety: "claimed"` and a host-owned `claim` function. A warning is not a substitute for a claim.

```ts
import type { ClientToolHandler } from "@providerkit/react";
import { claimPublish, publish } from "./authorized-actions.ts";

const publishAction: ClientToolHandler = {
  safety: "claimed",
  claim: claimPublish,
  run: publish,
};
```

These functions belong to your app. `claim` receives `requestId`, logical `runId`, optional
`segment`, handler `name`, viewer-safe `input` and an abort `signal`. It returns one of:

- `{ status: "granted", complete(value) }`: exclusive permission to run once. The client awaits
  `complete` to save the result before sending it to the SDK. This function must be idempotent.
- `{ status: "completed", value }`: send the saved, validated result without running again.
- `{ status: "denied" | "busy" | "unknown" }`: do not run. Denied and busy show a refusal;
  unknown keeps the request unconfirmed for host reconciliation.

The app binds the claim and completion functions to authenticated endpoints. The server must bind
principal, resource, logical run and exact saved request/input; validate access and values; persist
claims and results; exclude concurrent tabs; and reconcile uncertain effects before granting again.
An expired lease is not proof that an effect did not happen. A literal key or a local Map is not
this authority. The tests use one simulated claim service across separate clients to check this
binding, not real distributed storage. This package does not promise exactly-once execution.

Handlers validate input and respect cancellation. A grant received after the view closes, the
request expires or its run/segment changes does not execute locally. The host must reconcile any
unused grant. If the same request remains open after a segment change, **Check action result**
asks the host again, even if this client has a saved result. It never uses the old grant or reruns
the handler. If execution starts, closing the view cannot undo it. A result that arrives afterward
still goes through its bound `complete` function, but is not sent as a delayed SDK response.

A failed claim, interrupted execution or failed completion stays uncertain. It never reruns here.
An explicit `startClientTool` can ask the host for reconciliation. A second grant cannot rerun work
this client already considers uncertain. If only SDK result delivery failed, it sends the retained
result instead. A fresh client asks the same durable claim service. The default card offers
**Check action result** when that check is available. The SDK still checks current permissions and
validates the returned result.

### Recover an interrupted attempt

`operation_restart` replaces one operation's partial text. `model_chunk.attemptId` also detects
a new attempt if the restart event was missed. The display wire carries a monotone `attempt`
number on restarted text and its deltas. Older attempts cannot append to or replace the newer
one. Other specialists and completed operations stay intact.

An authoritative `snapshot` seeds the projector from saved attempt receipts, including interrupted
attempts. Feed the retained log before that read, not after it. Keep logical `runId` separate from
physical `segment` and its cursor. Browser input never chooses either execution routing or snapshot
authority.

### Recover missing progress

```ts
projector.gap();
```

Call this when the host observes `agent.gap` or `agent.resync`. These are `/runs` **RunEvent**
records, not SDK `AgentEvent` values. Do not cast their payloads into `projector.event`.

The host recipe is:

1. Read the retained log in order. Project `agent` records normally. At a gap or resync, publish
   the events returned by `projector.gap({ segment, seq })` before reading more progress.
2. Read the authoritative execution journal after that prefix. Publish a display snapshot built
   with `projector.snapshot(saved)`, `projector.run(saved)` and the host's full conversation and
   input receipts. Keep the same message, logical run and physical segment identities.
3. Continue after the recorded cursor, reconciling again at checkpoints and at the end. The
   projector now takes text from checkpoints only for the rest of this logical run. Later deltas
   cannot prove they include the missing span. Requests and other activity still update.

A retained prefix has `TextPart.incomplete: true`. The reducer blocks deltas and ordinary patches
from clearing that flag; an authoritative completed text snapshot can clear it. A running snapshot
with no complete text keeps the prefix visibly incomplete, including after Stop. A real restarted
attempt replaces only that operation's old prefix, still waiting for its complete checkpoint.
The components show a missing-text notice even with a custom `renderText`; plain-data renderers
must show it too. This does not start an attempt, change a segment or discard a pending send.

The example's missing-progress switch tests this boundary with a synthetic omission. It does not
exercise PostgreSQL. Checkpoints recover completed work, not every partial token lost in a crash.

## Show who answers after a handoff

`RunInfo.owner` holds `{ runId, agentId, label }` for the conversation's current owner. The root
logical `run.id` does not change when a child takes over. Supply the projector's optional `agentId`
when you need the root label before the first snapshot or handoff.

The projector reads the SDK's `handoff` receipt (`runId`, `childRunId`, `from`, `to` and
`operationId`). It marks the target's agent part with `kind: "handoff"` and `toolId`, then shows
that target's answer text under its row. A snapshot rebuilds this from `delegations[].kind`, the
registered `target` and child snapshots. No ID is parsed. `labels.agent` uses registered agent IDs;
`labels.run` overrides a particular run. The components' `specialistLabels` support both too.

Only the root's handoff chain gains default text visibility. An ordinary specialist's transcript,
including its own handoffs, stays hidden. Notes, history and reasoning never cross by default.
The `text` callback can further restrict visibility; a child source includes `handoff: true` only
when it belongs to the conversation chain. A target can also return structured output. Use the
SDK outcome's `activeAgent` identity to choose the target's output contract. The projector's
`output` callback receives the raw saved candidate, not the validator's transformed return value;
validate and select safe fields before rendering it. Do not treat a target's result as the source
agent's output type.

## Send a message while the agent works

```ts
await chat.send("Use the shorter version.");
```

Add `enqueue` to your `ChatTransport` to enable this during a running or waiting run. The same
send action uses `enqueue` instead of `send`; outside a run it still uses `send`. You can add it
beside the methods returned by `createSseTransport`. Leave `allowSendWhileRunning` off unless your
host separately supports overlapping ordinary sends. Retries still use ordinary `send` and stay
blocked during an active run unless you enable that option. No composer changes are needed.

`enqueue(input, { signal })` receives the usual `SendInput` plus `rootRunId`. The host authenticates
the person, checks the conversation/run, validates text and attachment references, and persists
immutable user content through its SDK `InputInbox` binding. Use `clientId` as the inbox input ID.
A browser's root ID is only a requested destination. The host chooses the actual recipient, which
may be a handoff child. This endpoint never approves tools, stops work or starts another run.

Return a `DisplayInput` with the matching `id` and `rootRunId` and one of these states:

- `queued`: saved by the host, not yet accepted by the SDK.
- `accepted`: checkpointed by the SDK; include the actual recipient's `runId`.
- `consumed`: a model call including it finished; include that recipient's `runId`. This does not
  prove that the model followed the message, and is not completed assistant output.

A successful enqueue returns the existing send outcome `accepted`, meaning delivery to the host.
Its `messageId` is the steering input ID, not a new transcript message.
Only then may the composer clear the submitted draft. A lost reply or mismatched receipt returns
`unknown` and keeps the text unconfirmed. Refusal keeps the draft for correction. Nothing resends
input, drains a queue or starts a follow-up run automatically, including after completion.

Send delivery updates as `{ v: 1, type: "input", input }`. The SDK event holds its recipient in
`event.receipt.runId`, not a top-level `runId`. The projector handles that shape and refuses a
receipt with another `rootRunId`. `projectInputReceipt` is also available from `/agents` for a host
acknowledgement handler. `projector.inputs(snapshot)` rebuilds accepted/consumed receipts without
raw content. Its optional `input` callback can return viewer-safe text. Include those receipts and
still-queued host inbox entries in the display snapshot's `inputs` array. Later updates can add
viewer-safe text without moving delivery backward or changing a known recipient. A snapshot's
omission is not proof that a queued message was discarded. Keep late input visible even when the
run ends.

`chat.inputs` reports delivery separately from `chat.messages`. `InputStatusList` from `/ui` draws
these values, or accepts plain `inputs`, `run`, `scopeKey` and `onRecall` props. It never sends text.

### Recall only when the host can prove it is safe

`recallInput` is optional on the transport. Without it there is no recall button. It receives
`{ id, rootRunId }` and `{ signal }`, then returns a matching `DisplayInput` with `status: "recalled"`
only after the host has excluded acceptance. It may refuse with `TransportError("refused", error)`
or return an accepted/consumed receipt instead. A failed or unknown recall preserves the text.

A stale `queued` view is not proof that recall is safe. SDK poll is non-destructive, checkpoint
comes before acknowledgement, and the agent may have taken the input while the inbox still says
queued. A host offering recall must reserve against poll or reconcile that race under its own
transaction/lease. Refuse once claimed or accepted. `createMemoryInbox` alone has no safe recall
capability. Never implement recall by deleting its queued entry. The UI offers only a manual host
check, never a local claim that the agent did not see the message.

## Use the optional components

Keep your own header and layout. The components accept the hook values or equivalent data from
your app's store:

```tsx
import { draftScopeKey, useChat, useComposer } from "@providerkit/react";
import type { ChatTransport, DraftScope } from "@providerkit/react";
import {
  Composer,
  ConnectionStatusDisplay,
  Conversation,
  MessageList,
  RunStatusDisplay,
} from "@providerkit/react/ui";
import { Markdown } from "@providerkit/react/markdown";
import "@providerkit/react/styles.css";

export function ChatPanel({ transport, scope }: { transport: ChatTransport; scope: DraftScope }) {
  const id = draftScopeKey(scope);
  const chat = useChat({ id, transport });
  const composer = useComposer({ scope, send: chat.send, canSend: chat.canSend });

  return (
    <Conversation chat={chat}>
      <ConnectionStatusDisplay />
      <MessageList
        renderText={(part, context) => (
          <Markdown text={part.text} streaming={!part.settled} sources={context.sources} />
        )}
      />
      <RunStatusDisplay />
      <Composer
        key={id}
        text={composer.text}
        onTextChange={composer.setText}
        onSubmit={composer.submit}
        submitting={composer.submitting}
        canSubmit={composer.canSubmit}
        error={composer.error}
      />
    </Conversation>
  );
}
```

`scope` names the current principal and conversation. It keeps delayed saves, uploads and send
receipts from changing another person's draft. Use your authenticated app state to choose it;
server authorization still checks every request.

`Composer` is controlled: it does not send, clear or persist text itself. `useComposer` supplies
that behavior. Add a host uploader through its `attachments` option and pass its attachment values
and callbacks to the component. Draft persistence is opt-in through an injected storage adapter;
there is no automatic localStorage capture. Before navigation that must wait for a save, await
`composer.flushDraft()`. If it returns false, keep the draft open and offer `retryDraft()`.

The transcript uses the published headless scroller with automatic turn anchoring disabled. It
follows live output only while you stay at the bottom. Scrolling away pauses following; sending a
message does not pull you back. **Jump to latest** explicitly returns to live following.

Where the browser supports CSS scroll anchoring, `MessageList` preserves the **leading visible
text** when content above it changes size or older messages are prepended. A line below an image
growing inside the viewport can move with ordinary reflow. It does not pin every visible line or
infer where you are looking. Host media renderers should reserve known dimensions before loading,
using `width`/`height` or an `aspect-ratio` container.

The wrapper sets `overflow-anchor` even without the optional stylesheet. It disables the scroller's
`preserveScrollOnPrepend` when native anchoring is supported, so the two do not compensate twice.
Browsers without native anchoring keep the published prepend fallback, but cannot promise the same
resize preservation. Final browser acceptance of these changes remains separate from unit checks.

Replace labels through component props, tool-label maps and specialist-label maps. Use
`renderPart` for your own cards and `renderApproval` for an approval action that opens a host
dialog. Unknown data parts are not displayed automatically. An approval slot cannot grant
permission; its response still goes through the server.

Every component accepts ordinary CSS customization. The optional stylesheet uses the
`providerkit` layer, scoped `pk-*` classes and `data-part`/`data-state` attributes. It installs no
font or global reset. With Tailwind 4, put it under the utilities layer:

```css
@import "tailwindcss";
@import "@providerkit/react/styles.css" layer(components);
```

Omit the stylesheet when your app supplies the styles. Omit the Markdown renderer when you need
only plain text; the UI entry does not import its parser.

## Imports

| Import               | Responsibility                                             |
| -------------------- | ---------------------------------------------------------- |
| `@providerkit/react` | Client state and React hooks                               |
| `/protocol`          | Display types, event validation and reduction              |
| `/sse`               | Fetch-based stream transport; requires `@providerkit/core` |
| `/agents`            | Server-side projection of agent events and snapshots       |
| `/markdown`          | Markdown, code blocks and source markers                   |
| `/ui`                | Chat components                                            |
| `/ag-ui`             | AG-UI event mapping                                        |
| `/styles.css`        | Optional default styles                                    |

Hook-only imports load no CSS, Markdown parser or server
runtime. The `/agents` entry imports SDK types only; it does not execute an agent.

## Use AG-UI events

Convert one event, then handle both the display events and any mapping issues:

```ts
const { events, issues } = reader.read(event);
```

The optional `@providerkit/react/ag-ui` entry uses portable types and no React, SDK or server
runtime. Bind the conversation, logical run and execution segment explicitly:

```ts
import { createAgUiReader, createAgUiWriter } from "@providerkit/react/ag-ui";

const binding = {
  threadId: "conversation",
  runId: "logical-run",
  segment: "physical-segment",
  agUiRunId: "native-execution",
};
const reader = createAgUiReader({ binding });
const writer = createAgUiWriter({ binding });
```

Use a new mapper for each segment or connection, initialized from a snapshot. `writer.write`
returns native events plus display extensions. Send them in order. `reader.read` returns events
for `reduceChat`; external native events may also receive a host-owned sequence and segment as
its second argument. Call `end()` to detect an unfinished stream, not to invent a completion.

Native clients receive text, tool, step, run and snapshot events. The owned
`providerkit.display.v1` custom events retain display fields that native events cannot express,
including requests, input receipts, handoff ownership, attempts and missing-text markers. Keep
those extensions when you need a full display round trip. Native-only snapshots lack settled
and attempt flags, so imported saved text is sealed and an issue explains the loss. Unknown or
unsupported events also return issues; do not treat them as successful conversion.

Workflow step rows emit native `STEP_STARTED` / `STEP_FINISHED`, never `TOOL_CALL_*` events.
Native steps have only a name, so the writer uses an opaque name per operation and attempt.
Their readable labels, failure/waiting states and operation identity stay in the display extension.
Native readers draw steps with the same activity component and report the missing attempt framing.
Workflow children have no native agent equivalent; their kind and nesting use the extension only.
A native-only child beneath a workflow loses that parent link. Step-origin requests have no native
tool-call route. Scheduled pauses use an interrupt outcome with no requests; `wakeAt` also requires
the extension. These losses are reported as `unsupported` issues even when the extension preserves
the full view.

Arguments, raw results, reasoning, private messages, vendor errors and opaque app state are
hidden by default. Explicit projection callbacks choose what may be shown. Shared-state patches
need a state projection; only safe `add`, `replace`, `remove` and `test` operations are supported.
The default limits are 2,048 retained items and 1,048,576 characters. They are bounds, not silent
truncation settings.

Use `toResumeEntry` for native approval or cancellation data, including permitted edited
arguments. It returns `null` rather than discard unsupported answer fields.
`toProviderkitResumeEntry` encodes richer request answers with binding metadata.
`readResumeEntry` validates either shape against the supplied saved request and binding.
Native entries contain no binding metadata, so the host must resolve the request itself.
These helpers return evidence only: they never authorize, execute a tool or resume a run.
A native pending tool-call ID is not an answerable request ID. No `RunAgentInput` parser or
automatic continuation is supplied.

## Markdown and media

The Markdown entry is separate from the message components. Model text cannot insert raw HTML.
Model-authored images are blocked by default, because displaying them would make the reader's
browser request an address chosen by the model. User attachments and host-approved tool media
have separate display policies.

A source marker resolves only through a source record supplied by the host. A link written by a
model is not a verified citation. A code block stays readable without a syntax highlighter.

The host handles file upload, access, storage and retention. An attachment shown on screen does
not mean the agent received its bytes. The send endpoint must resolve the uploaded reference into
an input the selected model can read.

## Run the local example

From a fresh workspace, run `bun install` and `bun run build` once. The example imports the
packages through their public exports, so their builds must exist. Then start it with the Bun
version pinned in the root `packageManager` (currently 1.4.4):

```sh
bun --no-env-file run --filter @providerkit/react dev:example
```

Open `http://127.0.0.1:4317`. The terminal prints the exact URL and server PID. To choose another
port, run `bun --no-env-file react/examples/chat/server.ts --port 4320` from the workspace root.
The launch commands do not load `.env` files. The server listens only on loopback and calls no
model provider or app service. Stop it with Ctrl+C in its terminal.

The page uses the package's hooks, composer, message list, Markdown and activity components.
Choose **Host styles** to see CSS overrides and host-owned result and approval slots. Choose
**Message port** to wrap the same local HTTP host in a browser `MessageChannel`; this changes the
transport, not the chat store. No Chrome APIs are used.

Try these flows:

- Send a message. A real `defineAgent` root calls a `defineDelegation` with two specialists, all
  using scripted providers. The server projects their events with `createAgentProjector`.
  Replies are fixed examples, not live intelligence. Source buttons open synthetic records.
- While it runs, open the read-only view, close it, then reopen it after completion. Reload the
  page or drop live updates and reconnect. These actions reuse the same run. **Stop** is separate.
- Under **Try connection, send and upload states**, delay or refuse a send, or lose its
  acknowledgement. Unknown delivery keeps the draft. **Check saved conversation** observes the
  saved reply without sending again. Only an accepted send clears the submitted draft.
- Attach a file without text. Try a slow upload, remove it to cancel, or fail each file once and
  choose Retry. PNG, JPEG and text files are limited to 1 MB each, up to three per message. The
  server discards contents and keeps only opaque references with synthetic labels. Local image
  previews are temporary; the script never reads uploaded contents.
- Opt into **Save drafts** before reloading. Drafts are scoped to both the demo profile and the
  conversation. Text and confirmed references expire after 24 hours; pending local files need
  reselection. Anyone using this browser can read saved drafts. Turning the option off deletes
  that scope's saved draft. Expired records are removed on the next access.
- Choose **Try questions, card and handoff**. Two real SDK `questionTool` requests wait together.
  Answer either first, try a one-letter text answer, then correct it. Edit the sample card's label
  before approving, or skip it. Expiry replaces the first questions; Stop closes the run.
- **Run action** uses `defineClientTool` and the public claim/complete handler contract. The host
  binds a claim to the profile, conversation, run, saved request and approved label. The fictional
  effect and its result are recorded in server memory before replying. **Lose the card action
  reply** lets a reload or another tab recover that result without creating another card. No
  claim is granted again just because its result is unknown. This one-process example is not
  production authentication, durable storage or an exactly-once external-effect guarantee.
- Choose **Try workflow and pause**. A real agent calls a workflow, which calls a scripted agent.
  Answer its question, edit and approve the label, then observe the five-second pause with no open
  request. **Check scheduled work** asks the local host to continue once due. An early check is
  refused with a retry instruction. Reloading never starts a timer or repeats the checked step.
  This uses the same request journal and in-memory continuation claim, not a durable scheduler.
- Watch the visit helper take over. Send a message while it prepares; `InputStatusList` shows
  queued, accepted and consumed separately. Recall succeeds only before the host's poll reservation,
  even if a stale view still says queued. Late unused input stays visible and starts no new run.
- **Omit part of the next scripted reply** marks a normal reply's retained prefix incomplete and
  withholds later deltas until its saved text arrives. With the same checkbox on, choose **Try
  questions, card and handoff** to omit a tool update before the two real SDK questions. The run
  should stay waiting with no assistant text, including after reload. **Synthetic progress gaps**
  under **Demo counters and limits** increases once. This is synthetic progress loss, not proof of
  database crash recovery.
- **Add tool, image and link samples**, then **Load image after 3 seconds**. The known image space
  is reserved while it loads. Choose **Enlarge after 3 seconds** or **Shrink after 3 seconds**, then
  scroll so **A line to keep in view** is the leading visible text. It should stay in place when the
  image above it changes size. Repeat with earlier text and the image still inside the viewport:
  the lower line may move with ordinary reflow. That is not a promise to pin every visible line.

Conversations, uploads and work live only in server memory. Browser reloads do not restart them;
restarting the server clears them. Demo profiles are not authentication. This is not a production
server. Optional diagnostics show only synthetic counters, never raw SDK snapshots or tool args.

Run the focused runtime check by hand:

```sh
bun --no-env-file run --filter @providerkit/react example:check
```

It starts its own Bun subprocess on a free loopback port and stops only that process. It checks
cursor replay, reload, observer close versus Stop, request-keyed evidence, partial answers,
corrections, denial, expiry, exclusive continuations, claimed client effects and result recovery,
handoff ownership, inbox reservation versus recall, late input and synthetic missing progress.
It also keeps the projection privacy, unknown port delivery, draft preservation, history, media
and attachment-only upload checks. It does not run in CI or in a general check script. Example types are checked by
`typecheck:example`; package lint includes the example files.

Browser acceptance remains separate: check desktop and phone layouts, both themes, reduced
motion, keyboard focus, citation/code actions, draft scope changes, upload retry and cancellation,
and scrolling up during a long reply without being pulled back to the bottom.

## Server responsibilities

Keep authentication, tenant checks, tool permissions, approval claims, billing and retention on the
server. Never accept a browser's snapshot or approval flag as execution authority.

A run's stored progress is not its execution journal. Use saved run state to recover completed
work. Handle missing or pruned progress as unavailable history, not as a successful run.

## License

MIT
