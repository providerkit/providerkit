---
title: Background runs
description: Bind agents, workflows and remote execution to a durable run service your app already owns.
---

`createBackgroundAgent` on `@providerkit/agents/runs` binds an agent, workflow or remote node to
host-managed runs. It does not create a database, queue or scheduler. The host owns workers,
leases, authorization and retention.

Use the [complete host example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/background.ts)
and [the binding API](/reference/agents/) with your existing service. Unlike the offline examples,
this setup needs real host storage and worker infrastructure.

## Create and enqueue deliberately

The injected creation function can save the run row and related domain records in one host
transaction. Return only after that transaction commits, then enqueue. Resolving a create call
inside an uncommitted outer transaction is not commit proof. Never hold that transaction open
through model or tool execution.

After uncertain enqueue, keep the same run ID and reconcile the queue. A second create can leave
two jobs doing the same work. The SDK does not replace the host transaction with its own SQL.

## Keep logical runs and physical workers separate

A logical run can cross several worker segments after a question, sleep or recovery. Continuation
records require `kind: "answers"` or `kind: "cancel"`. Current host policy runs again; saved
answers do not waive ownership or lease checks.

`onSegment` is awaited before dispatch and after SDK journal settlement. Its private snapshot is
not browser data. An end hook does not prove that the host worker row committed success, and
hooks may repeat after worker loss. Reconcile external effects rather than treating hook delivery
as exactly once.

## Cancel paused work safely

Cancellation returns `{ id, requested }`. Follow the returned physical segment. Acceptance is
not proof that work stopped, and a second stop must not abort the worker settling cancellation.

A paused durable run needs the optional `createContinuation` capability. The host must atomically
authorize the source and create or reconcile the owner/source/claim-bound segment with the exact
input, commit, then return its physical ID. An idempotency string or process-local cache is not
that capability. Without it, paused logical cancellation is refused before creation or enqueue.
Ordinary running-row cancellation remains available.

## Store progress at the durability you need

Best-effort progress coalesces adjacent text deltas and flushes at execution boundaries. Awaited
progress uses `Run.append` from `@gusnips/server` 0.21 and a bounded buffer. The binding still
supports the declared older server peers when awaited mode is not selected.

Rejected appends are not replayed automatically. Missing spans produce `agent.gap` and recovery
produces `agent.resync`; they are not promises that every partial token survived a crash. A
completed checkpoint can recover a final result even when a buffered tail was lost.

## Observe through your application

Authorize every log read and reconnect. Raw run events can contain private arguments and results;
project them on the server before sending display events to [React](/react/transport/). Closing
a viewer only detaches observation. A browser timer cannot resume a workflow or grant a tool.
