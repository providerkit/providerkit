---
title: Retries and fallback
description: Full-jitter backoff, the commitment rule that keeps a retried stream from replaying tokens, and walking a list of backup models.
---

## Backoff

```ts
import { withRetry, backoffMs, sleep } from "@providerkit/core";

const result = await withRetry((attempt) => callProvider(attempt), {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  signal,
  onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, error }),
});
```

Defaults: 3 attempts, 1s base, 30s ceiling. `backoffMs` is **full jitter** — a random point in
`[0, min(max, base · 2^attempt))` rather than the exact doubling. Exact doubling synchronises
every client that failed at the same moment into retrying at the same moment, which is how a
provider blip turns into a self-inflicted thundering herd.

A server-requested `retryAfterMs` always wins over the computed delay.

By default only transient kinds are retried, and `sleep` is abortable — a caller pressing Stop
during a backoff wait returns immediately rather than after the delay.

## Streams: retry only while nothing has been emitted

This is the rule that matters, and the one that is easy to get wrong.

```ts
import { withStreamRetry } from "@providerkit/core";

const stream = withStreamRetry(
  (signal, attempt) => provider.createStream(messages, tools, { signal }),
  { maxAttempts: 3 },
);
```

Once a single chunk has reached the caller, the turn is **committed**. Retrying after that
replays tokens the user has already seen — the answer restarts mid-sentence, or worse, restarts
in a different model's voice. So `withStreamRetry` retries only while nothing has been yielded,
and after the first chunk a failure propagates.

Each attempt gets its own `AbortController`, so abandoning an attempt actually cancels its
in-flight request instead of leaving it running.

## Backup models

```ts
import { streamWithBackupModels } from "@providerkit/core";

const stream = streamWithBackupModels(
  (model, signal) => provider.createStream(messages, tools, { model, signal }),
  {
    models: ["claude-sonnet-5", "claude-haiku-4-5", "gpt-5"],
    onFallback: ({ model, position, total }) =>
      log.info(`falling back to ${model} (${position}/${total})`),
  },
);
```

The list is `[primary, ...backups]` — position 1 is the primary, so a fallback is anything past
it. By default the walker advances only on `isBackupEligible` kinds (`overload`, `rate`), because
those are the failures a _different model_ actually fixes. An auth failure or a bad request will
fail identically on every model in the list, and walking it just multiplies the same error.

:::caution[The commitment rule applies to the walker too]
`streamWithBackupModels` carries the same "nothing emitted yet" guard. A walker without it will
switch models mid-answer and emit the second model's response after the first model's opening —
the reader sees the answer restart in a different voice.
:::

`withBackupModels` is the non-streaming equivalent.
