---
title: MCP tools
description: Import a recorded, host-allowed MCP tool catalog through the optional adapter.
---

Read a server's tool catalog:

```ts
const recorded = await listMcpTools(server);
```

This connects to the server you configure. Discovery is not permission to call every tool it
returns. Install the optional peer and import the adapter on its own entry:

```sh
bun add @modelcontextprotocol/sdk@^1.32.2
```

```ts
import { listMcpTools, mcpTools } from "@providerkit/agents/mcp";

const server = { url: "https://your-server.example/mcp" };
const recorded = await listMcpTools(server);
const catalog = mcpTools({
  ...server,
  recorded,
  allow: { search: { pin: { workspaceId }, needsApproval: true } },
});
```

Replace the endpoint and take `workspaceId` from your authenticated host context. Register
`catalog.tools` on the agent. Close the catalog when its host scope ends; a later call reconnects.

## Keep the model inside your allowlist

Only names in `allow` become Core tools. `pin` removes host-owned fields from the model's schema
and supplies those fields itself. A model attempting to override one is refused. Use a description
you approve and `wrap` when server text needs a clear untrusted-data boundary.

Read-only status comes from the server's `readOnlyHint`; the host can narrow it to false, not
invent a true hint. This is not an authorization grant or proof of free work. Tools not marked
read-only need an explicit approval policy. Your host still checks the actual action.

## Bound the connection and the call

The call's timeout includes the lazy handshake. The adapter checks the live tool list against
the recorded contract before invocation. Discovery metadata containing the configured credential
is refused, and unsafe header text is not sent.

A transport failure may leave an external effect unknown. Do not repeat a mutating operation
because a socket closed or a local request ID exists. Reconcile the backend's own record first.

The adapter uses the official MCP SDK only on `/mcp`; normal agent imports do not load it.
See [the MCP reference](/reference/agents/) for transport, prefix, timeout and wrapping options.
