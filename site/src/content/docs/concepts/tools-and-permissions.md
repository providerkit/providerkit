---
title: Tools and permissions
description: Know who runs a tool and who must authorize its effects.
---

A model asking for an action is not permission to perform it.

## Tools your code runs

Core tools describe their inputs and validate calls before execution. An optional `outputSchema`
describes a result's shape; it is metadata, not a replacement for runtime validation.
[The tools guide](/guides/tools/) covers definitions, outcomes and cancellation.

Agents uses those tools inside its loop. Unmarked tools run serially. Marking a tool read-only or
safe to run concurrently is a promise your implementation must keep, not a permission check.
Tools run in your process. [Code mode](/agents/code-mode/) isolates model-written programs,
not your tool implementations.

## Tools a provider runs

Search or image generation can happen at the provider. These are
[hosted tools](/guides/tools/#hosted-tools), not local functions your loop should execute again.
Core sends the configured tool and its limits or refuses unsupported settings. Hosted work may
have its own provider charge.

## Actions a person approves

A tool marked `needsApproval` requires host policy. Your server authenticates the
person, checks the resource and decision expiry, consumes the request-keyed approval and checks current access
before the tool runs. A saved approval flag cannot bypass those checks.

Browser input is untrusted. Validate it against current server state rather than accepting a
snapshot or claimed owner from the client. See [package boundaries](/concepts/package-boundaries/).

## An interrupted action

Cancellation does not unsend an email or reverse a payment. If an action was running when the
process stopped, inspect its result before repeating it. Where the receiving service supports an
idempotency key, use one to identify the same operation across attempts.

[Retry, resume and reconnect](/concepts/retry-resume-reconnect/) describes the different recovery paths.
