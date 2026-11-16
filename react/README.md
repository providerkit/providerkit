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
`part`, `text` and `run`. A server that supports replay includes `segment` and `seq` in the JSON
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

## Server responsibilities

Keep authentication, tenant checks, tool permissions, approval claims, billing and retention on the
server. Never accept a browser's snapshot or approval flag as execution authority.

A run's stored progress is not its execution journal. Use saved run state to recover completed
work. Handle missing or pruned progress as unavailable history, not as a successful run.

## License

MIT
