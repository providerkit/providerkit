---
title: Remote agents and A2A
description: Call a remote specialist or serve an agent through A2A without moving authorization into peer messages.
---

An A2A server uses a standard request handler:

```ts
const response = await server.fetch(request);
```

The [offline serving example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/a2a-server.ts)
returns `Hello` through real workflow execution and an in-process A2A client. The
[remote example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/a2a-remote.ts)
returns `Done` without a socket or paid model.

All A2A functions live on `@providerkit/agents/a2a`. Choose protocol version `1.0` or `0.3` and
JSON-RPC or HTTP+JSON explicitly. Unsupported or lossy conversions are refused rather than
silently dropped. The official A2A SDK is not a production dependency.

## Call a remote specialist

`defineRemoteAgent` creates a real `remote` node. Register it with a delegation or workflow; it
has no synthetic local model history or token usage. The host owns the card, endpoint policy,
credentials and output validation. Card text and helper instructions cannot grant an endpoint.

An agent that never uses A2A bundles none of its code. So a process that resumes a run holding a
remote agent must define that agent first, as it does the run's other agents.

Sends and follow-ups save intent and identity before dispatch. An uncertain send is not repeated
after a timeout, worker loss or model retry. Known tasks can be observed through polling or a
subscription. A read of an old task does not prove that an uncertain follow-up arrived.

Route input with `inputRequired: "ask"` to use authenticated local requests. Parent routing
returns a scoped, one-use continuation handle for a single free-text question; multiple questions
or forms need ask routing. Peer approvals and client-action grants are refused.

Remote receipts carry `billing: "unknown"`. Local `treeUsage` is not the remote bill. Files become
labels by default; peer URLs are never fetched. Inline images require explicit output validation.

## Serve your own execution

`createA2AServer` composes an `A2ARuns` service and task store. `createMemoryRuns` and
`createMemoryTaskStore` are bounded, process-local implementations, not crash-durable storage.
Use your existing run service and a persistent task store when work must survive a restart.

Authentication runs before body parsing. Tasks stay scoped to the authenticated owner and caller,
plus the tenant chosen by the host. `publicCard` opens only discovery. `allowAnonymous` is a
development-only shared partition; failed authentication never falls back to it.

Final output and transient text require explicit `projectOutput` and `projectText` callbacks.
Current disclosure policy also applies to stored history. `exposeRequest` only narrows visibility.
`a2aPolicy` keeps the real host's claims and decisions authoritative, and `a2aSegments` follows
continuations created outside the HTTP handler. Recover their original partition from storage,
not from peer metadata. Context IDs group tasks; session reuse needs an owner-checked factory.

## Cancel deliberately

Aborting a signal or closing an observation stops local work only. Use an explicit authorized
`remote.cancel` request to ask the peer to stop. Accepted is not confirmed cancelled. Unknown
cancel delivery is not resent automatically. Reconcile it with the peer before trying again.

Durable cancellation follows the returned physical segment. Paused work requires the host's
atomic continuation capability. See [background runs](/agents/background-runs/).

## Signing and notifications

Card signatures use host-selected keys. A2A 1.0 signs normalized known protobuf fields, not unknown
extensions or removed empty values. Version 0.3 signs the raw public card without its signatures.
A valid signature is not authorization.

Push delivery rechecks current access and egress policy. Attempts are recorded before sending;
unknown delivery is not replayed. URL checks alone do not establish where DNS resolves. The host
must check and pin destinations. Timestamped HMAC helpers are an optional providerkit extension,
not an A2A standard, and require host replay storage.

[Look up the public A2A contracts](/reference/agents/).
