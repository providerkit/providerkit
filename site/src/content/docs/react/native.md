---
title: React Native
description: Share @providerkit/react chat state on phones with your own stream reader, storage and classes.
---

Send a message and keep its streamed answer on screen in React Native:

```ts
await chat.send("Summarize this page.");
```

`@providerkit/native` (experimental, 0.1.0) pairs with `@providerkit/react` so phone and web apps
share one event reducer, cursor, reconnect policy and request model, with no DOM code and no
shipped stylesheet.

## Install

React 19, React Native 0.86 or newer and `@providerkit/react` are peer dependencies:

```sh
bun add @providerkit/native @providerkit/react
```

The package imports only `@providerkit/react` and `@providerkit/react/protocol`. Never import
`@providerkit/react/sse`, `/ui`, `/markdown`, `styles.css` or `@providerkit/agents` in a phone
bundle: `/sse` relies on `fetch` body streams and `TextDecoder`, `/ui` and `/markdown` render DOM,
and agents stay on the server.

## Pass your stream reader and API client

Stock React Native resolves `fetch` only after the whole response finishes, and Hermes has no
`TextDecoder`. Phone apps stream over `XMLHttpRequest` through a reader that already handles
sign-in and token refresh. `createSseTransport` uses the same request builders as
`@providerkit/react/sse` and takes two functions from your app:

- `open(request, handlers)`: opens one event stream, passes each frame's `data` to `onData`,
  errors to `onError`, and stream end to `onClose`, and returns `{ abort() }`.
- `command(request, { signal })`: sends `send`, `respond` or `stop` and resolves once the server
  accepts the command with a short JSON receipt. Live events stay on `observe`.

Throw `new TransportError("refused", error)` when the server rejects a request (for example a
4xx). Any other error is treated as an unknown outcome so the client never sends a command twice on
its own.

```ts
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { createSseTransport, watchDevice } from "@providerkit/native";

export const device = watchDevice({ appState: AppState, netInfo: NetInfo });

export const transport = createSseTransport({
  observe: (cursor) =>
    cursor
      ? { url: "/api/chat/events", headers: { "Last-Event-ID": JSON.stringify(cursor) } }
      : "/api/chat/events",
  send: () => "/api/chat/send",
  respond: () => "/api/chat/respond",
  stop: () => "/api/chat/stop",
  open: openAppEventStream,
  command: sendAppCommand,
  device,
  silenceMs: 30_000,
});
```

`maxStreamChars` (default `1_000_000`) ends a long stream so `XMLHttpRequest.responseText` stops
growing in memory; while a run is active, the client reattaches from its cursor. With `device`,
reconnects wait until the app is on screen and online, and `silenceMs` counts only foreground time.

## Store drafts and unsent messages

Pass your app's `AsyncStorage` to `createDraftStorage` and `createPendingSendStorage` so drafts
and unconfirmed sends survive restarts, keyed by person and conversation:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDraftStorage, createPendingSendStorage, removeExpired } from "@providerkit/native";

export const draftStorage = createDraftStorage(AsyncStorage);
export const pendingSendStorage = createPendingSendStorage(AsyncStorage);
```

Run `removeExpired(AsyncStorage)` on startup or sign-out to clear expired entries. Neither adapter
imports AsyncStorage directly.

## Style with a class map and labels

Every component on `@providerkit/native/ui` is unstyled and forwards `className` and `style`. Set a
`ChatClassNames` map once in your app's source (where Tailwind scans for classes) and provide it
with `ChatClasses`, or pass `styles` (`ChatStyles`) for plain `StyleSheet` objects:

```tsx
import { useChat, useComposer } from "@providerkit/react";
import {
  ChatClasses,
  Composer,
  MessageList,
  QueuedMessages,
  RunBand,
  type ChatClassNames,
  type ChatLabelOverrides,
} from "@providerkit/native/ui";

const chatClasses: ChatClassNames = {
  list: { root: "flex-1", content: "gap-3 px-4 py-3" },
  message: {
    user: "self-end rounded-2xl bg-surface px-4 py-3",
    assistant: "self-start gap-2",
    userText: "font-sans text-base text-ink",
  },
  composer: {
    field: "flex-row items-end gap-2",
    input: "flex-1 font-sans text-base text-ink",
    button: "rounded-full bg-accent px-4 py-2 data-[state=disabled]:opacity-40",
    buttonText: "font-sans text-sm text-on-accent",
  },
};

const labels: ChatLabelOverrides = {
  composer: { placeholder: "Write a message", send: "Send", stop: "Stop" },
  list: { jumpToLatest: "Jump to latest" },
};

export function ChatScreen({
  id,
  scope,
}: {
  id: string;
  scope: { principalId: string; conversationId: string };
}) {
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  const chat = useChat({
    id,
    transport,
    pendingSend: { storage: pendingSendStorage, scope, retentionMs },
  });
  const composer = useComposer({
    scope,
    send: chat.send,
    canSend: chat.canSend,
    draft: { storage: draftStorage, retentionMs },
  });

  return (
    <ChatClasses value={chatClasses} colors={{ placeholder: "#7f8a96", spinner: "#414cac" }}>
      <MessageList
        chat={chat}
        labels={labels}
        markdown={{ linkSchemes: ["https"], onLink: openUrl }}
      />
      <RunBand chat={chat} labels={labels} />
      <QueuedMessages chat={chat} labels={labels} />
      <Composer composer={composer} chat={chat} labels={labels} />
    </ChatClasses>
  );
}
```

- Stateful parts expose `data-[state=...]`, `data-[pressed=true]`, `data-[selected=true]`,
  `data-[action=...]` and `data-[level=...]` through `dataSet` for selector styling.
- Pass `placeholder`, `cursor`, `spinner` and `switchOn` through `ChatClasses`'s `colors` prop,
  and pass tinted icon nodes through each component's `icons` prop. No icons, fonts, modals or
  safe areas ship in the package.
- Pass `renderPart` on `MessageList` to draw app cards (return `undefined` for the default row or
  `null` to hide a part), and pass `tools` (`ToolTable`) to map tool names to your own words,
  icons and quiet-folding rules.
- `@providerkit/native/markdown` parses streamed model text in linear time and re-parses only the
  growing block. Links open only when their scheme is listed in `linkSchemes` and you supply
  `onLink`; model-written images do not fetch unless you supply `renderImage`.

## Entries

| Import                         | Responsibility                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `@providerkit/native`          | `createSseTransport`, AsyncStorage adapters and `watchDevice`   |
| `@providerkit/native/markdown` | Linear-time streaming Markdown parser with no React Native view |
| `@providerkit/native/ui`       | Unstyled chat components, `ChatClasses`, labels and `Markdown`  |

Importing `@providerkit/native` or `@providerkit/native/markdown` loads no React Native views.

Read [transport and display data](/react/transport/) for server projection and
[recovery and drafts](/react/recovery/) for unconfirmed sends and cursor resume.
