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

`cacheSavingsUsd` is the number worth putting on a dashboard: it is the difference between what
the cached tokens cost and what they would have cost at the full input rate — the direct measure
of whether your caching strategy is earning anything.
