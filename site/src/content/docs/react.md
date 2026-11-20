---
title: React
description: Add chat state and optional components without replacing your app's transport or styles.
---

Send a message through your app's transport:

```ts
await chat.send("Summarize this page.");
```

**React 0.2.0** is the experimental chat package. It keeps messages and connection state, handles
requests and provides optional components. You can use its hooks, keep your own state owner, or
use both. [Set up your first chat](/react/getting-started/).

## Choose what you need

| Import               | What it provides                                               |
| -------------------- | -------------------------------------------------------------- |
| `@providerkit/react` | Chat and composer state, `useChat` and `useAgentRun`           |
| `/protocol`          | Portable display data, validation and one reducer              |
| `/sse`               | A fetch transport for event streams                            |
| `/agents`            | Server-side projection of SDK execution into safe display data |
| `/ui`                | Conversation, composer, messages and activity controls         |
| `/markdown`          | Markdown, code blocks and citations                            |
| `/ag-ui`             | Conversion between display events and AG-UI                    |
| `/styles.css`        | Optional default styles                                        |

Hook imports load no UI, Markdown parser or styles. `/protocol` has no React dependency. Components
receive plain data and callbacks, so an app can keep its existing store. Tailwind is not required.

## Keep authority on the server

Your app owns sign-in, permissions, uploads and retention. It authorizes every read, send, stop
and response. A request ID or a browser view does not grant permission to run a tool.

The server projector hides private execution state by default. Tool details and structured
results need a host-selected projection. Never send a raw agent snapshot to a browser.
[Transport and display data](/react/transport/) explains where projection belongs.

## Pick a starting point

- [Build a chat](/react/getting-started/) or [try the component demo](/demos/chat/).
- [Handle questions and client actions](/react/requests/) without treating the browser as an authority.
- [Use the components](/react/components/) and [your own styles](/react/styles/).
- [Recover a conversation](/react/recovery/) without replaying a command.
- [Build on React Native](/react/native/) with your own stream reader and classes.
- [Connect an AG-UI host](/react/ag-ui/) or [look up an export](/reference/react/).
