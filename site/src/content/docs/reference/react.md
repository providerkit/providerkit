---
title: React API
description: Public hooks, display contracts and component props in @providerkit/react 0.1.0.
---

These signatures match the experimental **@providerkit/react 0.1.0** release.
[Start with a chat](/react/getting-started/) or [browse generated exports](/reference/react/readme/).

| Import path                     | Use                                                                |
| ------------------------------- | ------------------------------------------------------------------ |
| `@providerkit/react`            | Client/composer state and React hooks                              |
| `@providerkit/react/protocol`   | Display types, parsing and reduction without React                 |
| `@providerkit/react/sse`        | Fetch-based event observation and commands                         |
| `@providerkit/react/agents`     | Server-side safe projection of SDK events and snapshots            |
| `@providerkit/react/ui`         | Plain-data conversation, composer, content and activity components |
| `@providerkit/react/markdown`   | Markdown, code blocks and citations                                |
| `@providerkit/react/ag-ui`      | Portable AG-UI reader/writer and answer mapping                    |
| `@providerkit/react/styles.css` | Optional scoped stylesheet                                         |

React `^19` is the required peer. `/sse` uses Core `^0.33.1`. The server projector uses public
Agents 0.2 or 0.3 contracts, not the execution engine at runtime. Hook-only imports load no UI,
Markdown parser or CSS. `/protocol` and `/ag-ui` have no React runtime dependency.

## Keep your state owner

Components accept plain values and callbacks. `useChat` supplies them, but your app can keep its
own reducer or store. Conversation/run IDs, worker segments and local observer generations are
separate; none is an authorization grant.

The stylesheet has no TypeScript API. Its [styling guide](/react/styles/) covers layers, classes,
state attributes and full label overrides. The [transport guide](/react/transport/) covers the
server's command and observation contract.
