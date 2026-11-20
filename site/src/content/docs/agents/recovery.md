---
title: Recovery and retries
description: Distinguish a provider retry from restoring an interrupted agent or reconnecting a viewer.
---

A retry, a resume and a reconnect solve different failures. None grants permission to repeat an
external action whose outcome is unknown.

## Provider streams

Core may retry a transient provider failure only before any output is emitted. Once output has
started, the stream is committed. By default, Agents uses the provider you supply rather than
adding another retry loop. [Core's retry guide](/guides/retries/) covers routing and fallback.

For background runs whose stream nobody watches, you can opt in with
`retryAfterOutput: { maxRetries, baseDelayMs?, maxDelayMs? }` on `defineAgent`. When a transient
`ProviderError` fails a turn after chunks arrived, Agents drops the partial turn, waits with
full-jitter backoff and calls the provider again up to `maxRetries` times (1 to 10). Each attempt
is journaled, priced and counted toward `limits.costUsd` and `treeLimits.modelCalls`. The option
is refused when `hostedTools` are configured on the agent or run, because a hosted delta commits
the stream and replaying it would rerun and rebill the vendor's tool.

## Interrupted execution

A saved operation can be pending, running or settled. Restoring a running operation does not
prove it never reached the provider or tool. Recovery is explicit and records a new attempt of
the same operation, including earlier usage and any unknown charge.

An inference-only recovery policy cannot replay a call configured with hosted tools: a remote
search or other provider effect may already have happened. Read-only tool recovery requires the
host's assertion about that tool. Interrupted writes need authoritative reconciliation. Merely
sending an idempotency key is not proof that the receiver enforces it.

Saved definitions, limits, recovery rules and guard identities must match when a run resumes.
Code journals can be read as data without constructing executable tools, but execution still
checks the real registered code bindings and limits. Saved metadata is not authority.

## Tool retries

A tool retry budget is separate from provider retry and crash recovery. It requires an explicit
read-only policy or a host reconciliation proving the attempt did not run. Retry receipts retain
their actual effect attempt IDs. A changed policy or input cannot silently reuse an old grant.

A tool failure is normally data for the model. Suspension, caller cancellation, exhausted
root budgets and integrity failures still halt the execution tree. A specialist's own local
failure can return a failed tool result so its parent can choose another action.

## Checkpoints and context

Checkpoints store execution, not a replay permission. A host compares the supplied snapshot with
its authoritative record before resuming. Use format 3; finish older runs before upgrading from
Agents 0.1.

Compaction changes the model's working context, not the canonical conversation. It uses Core's
history rules so a cut does not separate a tool call from its result. Summary calls still count
against the execution budget.

## Reconnect a viewer

A React viewer reconnects to existing work. It does not start the agent again. Gaps and a lost
buffered tail remain explicit; a completed checkpoint can recover a result, not every partial
token. See [React recovery](/react/recovery/) and [background progress](/agents/background-runs/).
