---
title: Requests and client actions
description: Show questions and approvals, preserve entered answers and let the host decide what is authorized.
---

Send a request-keyed answer:

```ts
await chat.respond([{ requestId, response: { type: "approve" } }]);
```

A tool can ask more than once. Use the request ID, not its operation ID, and never parse that ID
to find a child. Your server looks it up in the authoritative journal.

## Wait for acceptance

`respond` accepts one request or a batch. Partial batches leave unanswered requests open. Delivery
can be accepted or unknown; accepted does not mean approved or completed. Only host updates close
the request. Refused answers keep their values for correction, and unknown delivery is not resent
automatically.

Responses include `approve`, `deny`, `answer`, `result`, `cancel` and `stop`. Edited arguments and
form data are available only when the host exposes them. `parseRequestAnswers` validates shape,
not permission. The server resolves evidence through the SDK request policy before resuming.

## Choose the visible fields

Request projection starts with a generic waiting row. The host selects the question, choices,
form fields and safe summary for this viewer. Closed records remain closed after reload without
exposing private answers, tokens, scope IDs or failure details.

An older pending checkpoint does not erase an observed decision for the same request. Expired or
replaced authority still wins; this is display reconciliation, not a browser grant.

## Execute a client action once

A client-tool handler is selected by host configuration, not by model arguments. A non-repeatable
action requires a real host claim before dispatch and persisted completion before result delivery.
An unknown result is reconciled without running the effect again. A read-only action can still
have a cost or privacy impact, so keep its policy explicit.

Workflow-step requests cannot select browser tool handlers. The server owns the route from a
request to its authorized execution context.

## Keep drafts in the correct account

Hooks supply a local `scopeKey` to `Conversation`. Plain-data hosts and standalone `RequestCard`
users must set it too when the screen can switch account or conversation. This resets in-memory
request drafts and stale callbacks even if IDs happen to repeat. It is never execution authority.

Use the default request cards, or provide your own `renderRequest`/`renderApproval` controls with
the same pending, error and acknowledgement behavior. See [the component API](/reference/react/)
and [the complete host contract](/agents/requests/).
