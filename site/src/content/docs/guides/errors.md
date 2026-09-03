---
title: Errors
description: Thirteen failure kinds, each named by what fixes it — and why an HTTP status alone will tell you to retry an empty balance.
---

An error only ever answers one question: **what do I do now?** So the taxonomy is organised by
the fix, not by the vendor or the status code.

```ts
import { ProviderError, isTransient, isBackupEligible } from "@providerkit/core";

try {
  /* ... */
} catch (raw) {
  const err = ProviderError.from("anthropic", raw);

  if (err.kind === "context") return compactAndRetry();
  if (isBackupEligible(err.kind)) return otherModel();
  if (isTransient(err.kind)) return retry(err.retryAfterMs);
  surface(err); // .body has their actual words
}
```

## The thirteen kinds

| Kind          | What fixes it                                                |
| ------------- | ------------------------------------------------------------ |
| `aborted`     | Nothing. The caller pressed Stop — this is not a failure.    |
| `timeout`     | Retry. Our deadline fired, not their answer.                 |
| `network`     | Retry. The request never reached them.                       |
| `overload`    | Retry, or fall back to another model.                        |
| `rate`        | Wait out the window, or rotate the key or model.             |
| `quota`       | Top up, or wait for the reset. Retrying will not help.       |
| `entitlement` | Change the plan. A new key and a top-up both fail here.      |
| `auth`        | Fix the credential. Every retry lands the same.              |
| `model`       | Use a model this endpoint actually serves.                   |
| `context`     | Send less. Compact the conversation — waiting fixes nothing. |
| `content`     | A safety filter caught the prompt or the answer.             |
| `invalid`     | Fix the request. This one is our bug.                        |
| `unknown`     | Unrecognised. Surface the body and look at it.               |

`isTransient` covers `timeout`, `network`, `overload` and `rate`. `isBackupEligible` covers
`overload` and `rate` — the two where a _different model_ is a real fix.

## Why the status code is not enough

Running out of credit arrives as **429** from OpenAI (`insufficient_quota`), **402** from some
gateways, **403** from others, and **400** from Moonshot with a Chinese-language body. Retrying an
empty balance is pure waste, and status alone tells you to do exactly that.

The reverse trap is worse. A 429 is usually a throttle, where waiting is the whole fix. But a
context overflow also arrives as 400 — and sometimes 429 — where waiting fixes nothing and the
only cure is sending less.

So the classifier **reads the body before the status** for 4xx. The body says what is actually
wrong; the status says only how the vendor chose to file it.

:::note[Quota wordings are matched in several languages]
Including `余额不足`, `欠费` and `额度不足` — a Chinese-language balance message under a 400 is
still a quota failure, and treating it as a bad request sends the caller to fix their code.
:::

## Failures with no status at all

A dead socket carries no HTTP response. Node wraps the real reason several layers deep, so the
useful code sits on `cause.cause.cause`. `isTransportFailure` walks the `cause` chain five levels
looking for the signatures — `ECONNRESET`, `UND_ERR_SOCKET`, `fetch failed`, and friends.

Miss that walk and every transient network blip reads as a permanent failure, which is how a run
dies on a hiccup that a single retry would have cleared.

## Retry-After

`parseRetryAfterMs` reads a server-requested wait from a `Retry-After` header (both the seconds
and the HTTP-date form) and from Gemini's `RetryInfo` body, where the delay is a string like
`"48s"`. It lands on `err.retryAfterMs`.

A long one is information, not just a delay: a wait measured in hours is a usage window, not a
blip, and a run is usually better off failing fast with the reset time than sleeping into the
same wall.

## The error object

```ts
class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly body?: string; // their words, kept for the surface
  get isTransient(): boolean;
  get isBackupEligible(): boolean;
  static from(provider: string, err: unknown): ProviderError;
}
```

`ProviderError.from` is idempotent — passing one back in returns it unchanged, so wrapping at
several layers is safe.

Keep `body`. When a failure lands as `unknown`, the vendor's own words are the only thing that
tells you what to add to the classifier.
