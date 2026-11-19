---
title: React quickstart
description: Send a message through your app's transport, then add the components you need.
---

```ts
await chat.send("Summarize this page.");
```

The message appears before the server replies. If the connection drops before the server confirms
delivery, the client marks the message as unconfirmed. It does not send it again on its own.

## Install

React 19 is required. Add Core when using the SSE adapter:

```sh
bun add @providerkit/react@0.1.1 @providerkit/core@^0.33.1
```

Configure a transport once for the conversation:

```ts
import { createSseTransport } from "@providerkit/react/sse";

export const transport = createSseTransport({
  send: () => "/api/chat/send",
  observe: (cursor) =>
    cursor
      ? { url: "/api/chat/events", headers: { "Last-Event-ID": JSON.stringify(cursor) } }
      : "/api/chat/events",
});
```

These are routes your app implements, not routes the package creates. The server accepts your
cursor format and returns validated display events. Supply your app's `fetch` when it already
handles authentication.

## Connect a component

```tsx
import { useState } from "react";
import { useChat } from "@providerkit/react";
import { transport } from "./transport.ts";

export function Chat() {
  const chat = useChat({ id: "example", transport });
  const [refusal, setRefusal] = useState("");
  const unconfirmed = chat.messages.some(
    (message) => chat.messageErrors[message.id]?.code === "unconfirmed",
  );

  async function sendExample() {
    setRefusal("");
    const result = await chat.send("Summarize this page.");
    if (!result.ok) setRefusal(result.error.message);
    // An unknown delivery stays on its message until the host confirms it.
  }

  return (
    <section aria-label="Conversation">
      {chat.messages.map((message) => (
        <div key={message.id}>
          {message.parts.map((part) =>
            part.type === "text" ? <p key={part.id}>{part.text}</p> : null,
          )}
          {chat.messageErrors[message.id] && (
            <p role="status">
              {chat.messageErrors[message.id]?.message} Check the saved conversation before sending
              again.
            </p>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={!chat.canSend || unconfirmed}
        onClick={() => void sendExample()}
      >
        {chat.status === "sending" ? "Sending..." : "Send a message"}
      </button>
      {refusal && <p role="alert">{refusal}</p>}
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

This example draws text only. [The optional components](/react/components/) also handle requests,
attachments and activity. No model key belongs in this component.

Change `id` and the scoped transport when the account or conversation changes. The hook detaches
the old observer; the server still authorizes every request. Keep the same transport object for
the lifetime of one conversation.

[Try the chat demo](/demos/chat/), [define your transport](/react/transport/) or
[look up the hook API](/reference/react/).
