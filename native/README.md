# @providerkit/native

Send a message and show its streamed answer in a React Native app:

```ts
await chat.send("Summarize this page.");
```

This package is experimental (0.1.0). It builds on `@providerkit/react` so your phone app shares
the same message reducer, reconnect rules and request handling as the web, without any DOM code.

It gives you three pieces:

- A stream transport that uses your app's own stream reader and API client.
- Storage and device adapters for AsyncStorage, `AppState` and NetInfo.
- Unstyled chat components and a streaming Markdown renderer styled through your own classes or
  `StyleSheet` objects.

No stylesheets, Tailwind classes, icons, fonts, modals or safe areas ship here. Your app supplies
its look and its words.

## Install

React 19, React Native 0.86 or newer and `@providerkit/react` are peer dependencies:

```sh
bun add @providerkit/native @providerkit/react
```

## Connect your server

Stock React Native cannot stream a `fetch` response as it arrives, and Hermes has no
`TextDecoder`. Phone apps read streams over `XMLHttpRequest` through a reader that already holds
the user's session and token refresh. Instead of shipping a second reader that can drift from your
API client, `createSseTransport` takes two functions from your app:

- `open(request, handlers)`: opens one event stream, calls `handlers.onData(data)` for each
  frame's data, `handlers.onError(error)` on failure and `handlers.onClose()` when it ends, and
  returns `{ abort() }`.
- `command(request, { signal })`: sends one `send`, `respond` or `stop` request and resolves once
  the server accepts it.

Either function signals a server refusal (such as a 4xx) by throwing
`new TransportError("refused", error)`. The client then takes the command back or stops
reconnecting. Any other error counts as an unknown outcome, so the client never sends a command
again on its own.

Because React Native's `fetch` resolves only when a response finishes, `send` and `respond` return
a short JSON receipt while live events stay on `observe`.

```ts
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { TransportError } from "@providerkit/react";
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
  open: (request, handlers) => openAppEventStream(request, handlers),
  command: async (request, { signal }) => {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    });
    if (res.status >= 400 && res.status < 500) {
      throw new TransportError("refused", { code: `http_${res.status}`, message: res.statusText });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  },
  device,
  silenceMs: 30_000,
});
```

These routes are examples your server implements. `createSseTransport` uses the same request
builders as `@providerkit/react/sse`, so web and phone can share them.

- `maxStreamChars` (default `1_000_000`) ends a long stream so `XMLHttpRequest.responseText` does
  not grow without bound; while a run is active, the client reconnects from its cursor.
- `silenceMs` closes a stream that sends no frame for that long (off by default). With `device`,
  silence counts only while the app is on screen, and reconnects wait until the app is on screen
  and online.

## Keep drafts and unsent messages

Pass your app's `AsyncStorage` to keep drafts and unconfirmed sends across restarts, scoped to
both the person and the conversation:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDraftStorage, createPendingSendStorage, removeExpired } from "@providerkit/native";

export const draftStorage = createDraftStorage(AsyncStorage);
export const pendingSendStorage = createPendingSendStorage(AsyncStorage);

// Clean up expired copies on app start or sign-out.
await removeExpired(AsyncStorage);
```

Pass `draftStorage` to `useComposer({ draft: { storage: draftStorage, retentionMs } })` and
`pendingSendStorage` to `useChat({ pendingSend: { storage: pendingSendStorage, scope, retentionMs } })`.
Reads and writes run in order through one queue so a quick screen close and reopen never reads
stale text. This package does not depend on AsyncStorage.

## Style the components with a class map

Every component under `@providerkit/native/ui` is a set of unstyled React Native parts. Set a
`ChatClassNames` map once outside your screen, inside your app's source where Tailwind scans for
classes, and provide it with `ChatClasses`:

```tsx
import { useChat, useComposer } from "@providerkit/react";
import {
  ChatClasses,
  Composer,
  MessageList,
  QueuedMessages,
  RunBand,
  type ChatClassNames,
} from "@providerkit/native/ui";

const chatClasses: ChatClassNames = {
  list: { root: "flex-1", content: "gap-3 px-4 py-3" },
  message: {
    user: "self-end rounded-2xl bg-surface px-4 py-3",
    assistant: "self-start gap-2",
    userText: "font-sans text-base text-ink",
  },
  markdown: {
    paragraph: "font-sans text-base text-ink",
    code: "rounded-lg bg-surface p-3",
    codeText: "font-mono text-sm text-ink",
    link: "underline text-accent",
  },
  composer: {
    root: "border-t border-line px-4 py-2",
    field: "flex-row items-end gap-2",
    input: "flex-1 font-sans text-base text-ink",
    button: "rounded-full bg-accent px-4 py-2 data-[state=disabled]:opacity-40",
    buttonText: "font-sans text-sm text-on-accent",
  },
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
      <MessageList chat={chat} markdown={{ linkSchemes: ["https"], onLink: openUrl }} />
      <RunBand chat={chat} />
      <QueuedMessages chat={chat} />
      <Composer composer={composer} chat={chat} />
    </ChatClasses>
  );
}
```

How styling works here:

- Classes live in your app: Tailwind skips `node_modules`, so no class strings ship in this
  package. Every `Text` part has its own slot because React Native has no inherited global font.
- No NativeWind required: pass `styles` (`ChatStyles`, the same keys as `ChatClassNames`) on
  `ChatClasses` to style every part with plain `StyleSheet` objects instead.
- Colors as values: React Native takes `placeholderTextColor`, `cursorColor` and
  `ActivityIndicator` color as values, not classes. Pass them through `ChatClasses`'s `colors`
  prop, and pass icons already tinted.
- State in `dataSet`: stateful parts expose `dataSet` (`data-[state=running]:`,
  `data-[state=disabled]:`, `data-[pressed=true]:`, `data-[selected=true]:`, `data-[level=1]:`,
  `data-[action=stop]:`).
- Custom cards: pass `renderPart` to `MessageList` to draw your own data or tool cards. Return
  `undefined` to keep the default row, or `null` to hide the part.

## Replace every word with labels

Every visible string and screen-reader label comes from `defaultChatLabels` in English. Pass a
partial `ChatLabelOverrides` object to any component's `labels` prop to translate or rewrite only
the sections you change:

```tsx
import type { ChatLabelOverrides } from "@providerkit/native/ui";

const ptLabels: ChatLabelOverrides = {
  composer: {
    placeholder: "Escreva uma mensagem",
    send: "Enviar",
    stop: "Parar",
    offline: "Sem conexão. Conecte-se para enviar.",
  },
  list: {
    jumpToLatest: "Ir para o final",
  },
};

<Composer composer={composer} chat={chat} labels={ptLabels} />;
```

Tool rows also accept a `tools` table (`ToolTable`) keyed by tool name so each call shows your
app's running, done and failed words, an optional tinted icon and whether the call is quiet (quiet
calls fold into one expandable line; non-quiet calls stay in view).

## Streaming Markdown

`MessageList` renders assistant text with `Markdown` from `@providerkit/native/ui` (or your own
renderer through `renderText`). The parser also lives on its own React-free entry,
`@providerkit/native/markdown`:

- Parses paragraphs, headings, lists, fenced code, bold, italic, inline code, links, citations and
  image markers in linear time, and re-parses only the last growing block while text streams.
- Links open only when their scheme is listed in `linkSchemes` and you pass `onLink`. `javascript`,
  `vbscript` and `data` never open.
- Model-written images do not fetch by default. They show as alt text unless you pass
  `renderImage`.

## Imports

| Import                         | What it provides                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@providerkit/native`          | `createSseTransport`, AsyncStorage adapters (`createDraftStorage`, `createPendingSendStorage`, `removeExpired`), `watchDevice`                                                                         |
| `@providerkit/native/markdown` | Linear-time streaming Markdown parser (`parseMarkdown`, `continueMarkdown`, `allowedLink`), no React Native import                                                                                     |
| `@providerkit/native/ui`       | `ChatClasses`, `MessageList`, `MessageText`, `Markdown`, `ToolRow`, `ToolGroup`, `ThinkingRow`, `RunBand`, `Composer`, `QueuedMessages`, `RequestCard`, `ErrorNotice`, `defaultChatLabels`, `toolView` |

Importing `@providerkit/native` or `@providerkit/native/markdown` loads no React Native views.

## License

MIT
