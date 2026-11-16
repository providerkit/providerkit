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
Keep controlled values in the host if cards can leave the transcript.
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
when it belongs to the conversation chain. Current SDK handoffs accept text-output agents only.
There is no structured-output handoff support.

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
has an explicit jump-to-latest action instead of forcing someone back to the bottom when new
output arrives. Real-browser scrolling and layout acceptance checks are still pending before
release.

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

The AG-UI mapping is still being built. Hook-only imports load no CSS, Markdown parser or server
runtime. The `/agents` entry imports SDK types only; it does not execute an agent.

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
- Try a sample approval. The host uses the existing `respond` interface and publishes its own
  authoritative display updates, deduplicated by request ID. This is a separate host simulation,
  not SDK approval continuation. Connecting the SDK's new request journal is still pending.

Conversations, uploads and work live only in server memory. Browser reloads do not restart them;
restarting the server clears them. Demo profiles are not authentication. This is not a production
server. Optional diagnostics show only synthetic counters, never raw SDK snapshots or tool args.

Run the focused runtime check by hand:

```sh
bun --no-env-file run --filter @providerkit/react example:check
```

It starts its own Bun subprocess on a free loopback port and stops only that process. It checks
cursor replay, reload, observer close versus Stop, duplicate sends and decisions, projection
privacy, unknown delivery through the port transport, draft preservation and attachment-only
uploads. It does not run in CI or in a general check script. Example types are checked by
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
