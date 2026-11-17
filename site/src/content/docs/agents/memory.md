---
title: Memory
description: Keep facts across conversations in a host-controlled store, with explicit access and erasure.
---

Run the process-local memory example:

```sh
bun node_modules/@providerkit/agents/examples/memory.ts
```

[Read its source](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/memory.ts).
It uses sample data and makes no embedding or model request.

## Separate a conversation from memory

A session stores conversation history. Memory stores selected facts for later conversations.
`createMemoryStore` is the process-local reference implementation; restarting the process loses
its data. Implement `MemoryStore` over your app's storage when facts must persist.

`memory: true` on an agent enables recall only. It does not add tools. Register the `search`,
`save` and `forget` tools returned by `memoryTools` when the agent is allowed to use them.

The host obtains access from the store using authenticated scope IDs and supplies the binding
to the run. Model arguments cannot choose another tenant, person, store or retention period.

## Keep changes scoped

Reads, writes and erasure use exact scopes and revisions. Erasure generations prevent a stale
run from restoring facts the person has already removed. A changed scope or stale revision is a
failure to reconcile, not a reason to widen access or overwrite newer data.

Keep the same memory tool objects on a creator and its helper template. The helper's admitted
capabilities still apply, and a model-created helper cannot enable memory access on its own.

## Recall is data

Recalled facts are journaled as user data, not trusted system instructions. Use them only when
relevant to the current task. Memory text does not grant a tool or override the host's permission
checks.

`ingestMemory` is an explicit host operation with an atomic receipt. It is not an automatic
transcript scraper. The package supplies no database, vector service, embedding calls or paid
fact extraction.

Your app owns consent, retention and export/deletion flows. Saved memory and execution snapshots
remain private; [browser projection](/react/transport/) is a separate decision.

See [the memory API](/reference/agents/) and the
[store contract](https://github.com/providerkit/providerkit/blob/340d8af/agents/README.md#remember-facts-across-conversations).
