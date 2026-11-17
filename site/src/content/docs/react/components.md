---
title: Components and content
description: Use plain-data chat components with your hook values or an existing application store.
---

Show the messages from an existing chat value:

```tsx
<Conversation chat={chat} />
```

The default child is a message list. The components do not require the package's state owner.
Pass a `useChat`/`useAgentRun` value or equivalent data and callbacks from your app.
Add a composer and your own header when you need them:

```tsx
import { draftScopeKey, useChat, useComposer } from "@providerkit/react";
import type { ChatTransport, DraftScope } from "@providerkit/react";
import {
  Composer,
  Conversation,
  MessageList,
  ConnectionStatusDisplay,
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

Take `scope.principalId` and `scope.conversationId` from authenticated app state. They separate
local drafts and callbacks; the server still authorizes every command.

## Compose the screen

`Composer` is controlled. It does not send, clear or persist text by itself; `useComposer` supplies
that behavior. Its uploader is injected by your app. Pending uploads and unsent files are not
proof that an agent can read the attachment.

`MessageList` and `Message` render only display data. Use slots for rich results, approvals and
custom parts. Unknown custom data draws nothing by default. Tool and specialist labels can come
from the app's own maps, with server labels as the fallback.

Activity rows distinguish tools, workflow steps, nested code calls and remote agents. A remote
row may say its status is unknown after local execution stops. It does not claim remote rollback
or cancellation.

## Add Markdown deliberately

`/ui` renders plain text unless you provide a renderer. `/markdown` separately adds code blocks,
copy controls and host-resolved citations. Raw model HTML is not rendered. Unsafe link schemes
are refused, and model-authored images do not make network requests by default.

Approved user attachments and tool media are different from arbitrary Markdown images. The host
selects URLs, content types and access policy. A citation points only to a supplied source; an
unknown marker does not invent a link.

## Respect the reader

The transcript follows live output only while the reader stays at the bottom. Scrolling away
pauses it, and sending does not pull the reader back. Jump to latest is explicit. Native browser
anchoring preserves leading visible text; unsupported browsers retain prepend recovery, not an
identical resize guarantee.

[Try the components](/demos/chat/), [style them](/react/styles/) or [browse the props](/reference/react/).
