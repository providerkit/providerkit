---
title: Retry, resume and reconnect
description: Repeating a provider request, continuing saved work and listening again are different actions.
---

## Retry a provider call

A retry sends another request. Core's stream retry only does that before any chunk has been
emitted. Once a reader has seen output, retrying could repeat it. An error's `shouldRetry: false`
can also forbid replay even when its kind is transient.

A lost connection does not prove the provider received nothing. Paid speech and transcription
calls are not automatically replayed after ambiguous failures. Read [the retry rules](/guides/retries/)
and the capability's guide before adding a loop around a call.

## Restore provider history

Core [history repair](/guides/resume/) makes saved messages valid for a provider. It can fill a
missing tool result with an interruption notice. It does not recover a job or prove that a tool
changed nothing.

## Resume agent execution

Agents resumes a trusted snapshot only through host authorization. The host loads authoritative
state, checks its owner and prevents concurrent attempts. Completed operations can be reused.
An operation recorded as running has an unknown outcome after a crash, so the SDK refuses to
repeat it automatically.

For explicit inference-only or read-only recovery policies and host reconciliation, see
[recovery and retries](/agents/recovery/). Configured hosted tools prevent inference-only replay;
a running marker or idempotency key alone is not proof that an external action did not happen.

## Reconnect a reader

A reader losing its connection is not a new task. Reconnect to observe the existing work instead
of submitting the user's message again. In the released `/runs` binding, aborting an observer
signal stops listening; `cancel(owner, id)` separately asks the host to stop work. Follow the
returned physical segment, and do not treat acceptance as proof that an external task stopped.

Your host owns saved progress and access checks. [React recovery](/react/recovery/) reconnects
the browser to existing work without automatically replaying a message or answer.
