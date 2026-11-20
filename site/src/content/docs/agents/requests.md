---
title: Questions and approvals
description: Pause for a person, validate their response on the host and continue the same execution.
---

An agent can ask a question, request approval for a tool or wait for a browser-side action.
These all use a saved request with an ID. They are not special strings in a model answer.

Use `questionTool` for choices, text or a form. A tool can raise `InputRequired` when it reaches a
question while running. `defineClientTool` describes an operation the authenticated browser must
perform. A tool marked `needsApproval` asks before the external action, and an approval may
include edited arguments.

## The host decides

For a direct `agent.resume`, the host has three jobs:

1. `authorizeResume` checks the saved run, its owner and the current worker's exclusive right to continue. The SDK does not acquire a lock for you.
2. `prepareRequest` binds a new request to the authenticated person, resource and current policy.
3. `resolveRequest` verifies the evidence and returns the decision the host accepts.

The optional [background binding](/agents/background-runs/) adds `claimContinuation` to its own policy. It claims the continuation across worker segments; direct agent runs do not call it.

Keep those records in authoritative storage. A request ID is a lookup key, not permission.
Neither model output nor browser JSON can assert that a host claim succeeded.

A suspended result exposes the requests that still need answers. Continue the saved run with
request-keyed evidence and the current host policy. Partial answers remain pending. A denied,
expired or changed request does not authorize the original action. An edited approval is checked
against the arguments that will actually execute, not just the earlier proposal.

## One ask per turn, checked first

By default, every remaining approval-required call in a turn opens together so a person can answer
them in one batch. Pass `requests` on `defineAgent` to narrow that:

- `requests: { onePerTurn: true }` opens only the first pending request in a turn and suspends,
  opening the next one on resume after the first settles.
- `requests: { validateBeforeAsk: true }` runs each tool's `accepts(arguments)` (or a client tool's
  argument validator) before opening an approval for it. A call with invalid arguments skips
  approval and returns `invalid_input` to the model so nobody is asked to approve a call that would
  fail.

## Active time and in-process waits

`limits.elapsedMs` is the wall-clock limit across resumes, including time spent waiting for a
person. Set `limits.activeMs` to cap the working time of each attempt separately: it pauses while
`host.answerNow(request, { signal })` waits for a person in process, never counts time suspended
between attempts, and starts fresh on each resume. While `answerNow` waits, `limits.elapsedMs`,
`treeLimits.elapsedMs` and the caller's signal still abort the wait through `signal`. Reaching
`activeMs` ends the run with `status: "limited"` and `limit: "activeMs"`.

## Browser actions

A non-repeatable client action needs a host claim before it runs and a saved completion before
the result is delivered. If delivery is uncertain, reconcile the recorded result; do not execute
the action again to obtain another answer. Manual-review copy alone is not a durable claim.

The [React request controls](/react/requests/) send decisions through your transport and remain
pending until the server acknowledges them. They do not call the agent or grant capabilities.

## Stop and cancel are different decisions

Stopping local execution does not undo external effects. In A2A, stopping local observation also
does not cancel the peer's task. An explicit remote cancellation needs current host permission,
and acceptance is not proof that the task stopped.

For paused durable work, continuing or cancelling may create a new physical worker segment while
keeping the logical run ID. [Background runs](/agents/background-runs/) explains the host transaction
and lease requirements.

See the [request API](/reference/agents/) and the
[shipped host contract](https://github.com/providerkit/providerkit/blob/340d8af/agents/README.md#asking-the-person)
for complete callback signatures and decision examples.
