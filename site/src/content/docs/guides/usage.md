---
title: Usage and cost
description: One token-usage shape across providers that disagree about what counts as input, plus cost and cache savings.
---

## The shape

```ts
interface TokenUsage {
  inputTokens: number; // the FULL input, cached or not
  cachedInputTokens: number; // the cached slice OF that input
  cacheWriteTokens?: number;
  outputTokens: number;
  reportedCostUsd?: number; // what the provider billed, when it says
}
```

`inputTokens` is every token the request put in the window. That is what "context size" means
everywhere else — the gauge, the compaction threshold — so it is what the field means here.

This needs reconciling because the vendors disagree:

- **Anthropic** reports `input_tokens` **excluding** cache reads and cache writes. The adapter
  adds them back, so `inputTokens = input_tokens + cache_read + cache_creation`.
- **OpenAI** reports `cached_tokens` as a **subset** of `prompt_tokens`. Nothing to add.

Hand both through unreconciled and the same conversation reports two different context sizes and
two different costs.

:::caution[OpenAI-shape endpoints send no usage unless you ask]
The adapter always sends `stream_options: { include_usage: true }`. Without it the stream simply
ends with no usage chunk at all, and every call silently costs nothing in your metrics.
:::

## Cost

```ts
import { costUsd, addUsage, UsageTracker, type ModelRate } from "@providerkit/core";

const rate: ModelRate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const tracker = new UsageTracker();
tracker.add(usage, rate);

tracker.totals; // summed TokenUsage
tracker.costUsd; // running cost
tracker.cacheSavingsUsd; // what the cache saved, versus paying full input
tracker.isOverBudget(5); // stop a runaway run
```

Rates are **USD per million tokens**. `costUsd` clamps `cachedInputTokens` to `inputTokens`
before charging, so a provider that reports more cached than total cannot produce a negative bill.

:::note[No price tables ship with this package]
Prices change weekly, a stale table is worse than no table, and a table would make this package
something that needs releasing every time a vendor moves a number. Bring your own `ModelRate`.
:::

### When the provider says what it cost

OpenRouter puts the price of each call in its response. The OpenAI-shape adapter reads it into
`usage.reportedCostUsd`, in US dollars. `costUsd` and `UsageTracker` bill that number instead of
your rate, and a tracker counts it even when you pass no rate at all.

This matters because a rate can be right and still bill the wrong amount. OpenRouter serves one
model id from many hosts, and they charge different prices. Only the response knows which host
answered.

- A free call reports `0`, and stays `0` even if you pass a rate.
- If you bring your own provider key, OpenRouter's `cost` is only its fee. The adapter adds what
  your provider billed for the call, so `reportedCostUsd` is the whole bill.
- A value that is not a price (negative, or not a number) is dropped, and your rate prices the call.
- Other providers report no cost, so your rate prices their calls, as before.
- `addUsage` drops `reportedCostUsd`. The sum of two calls is not one bill, so keep a running total
  in a `UsageTracker`.

`cacheSavingsUsd` is the number worth putting on a dashboard: it is the difference between what
the cached tokens cost and what they would have cost at the full input rate — the direct measure
of whether your caching strategy is earning anything.

## Rollbacks and speculative turns

When rolling back an optimistic turn or speculative stream, use `subtractUsage` or `tracker.subtract`:

```ts
import { subtractUsage } from "@providerkit/core";

// Clamps every bucket at zero so the ledger cannot drift negative
tracker.subtract(rolledBackUsage, rate);
```
