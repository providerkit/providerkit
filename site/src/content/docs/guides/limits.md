---
title: Limits and key pools
description: A 429 says a limit was hit, never which one — and the difference between a per-minute throttle and a weekly window is three days.
---

A 429 discloses that a limit was hit. It never says **which** limit. A per-minute throttle and a
Claude subscription's weekly window arrive with the same status and much the same wording, and one
of them lifts in seconds while the other lifts in days.

Guess wrong in the optimistic direction and you tell the user "try again in a moment" for three
days. Guess wrong in the other and you fail a run that a 20-second sleep would have cleared.

## Reading when, not whether

Only the headers tell them apart, and only some vendors send them.

```ts
import { parseRateLimitReset, parseUsageLimitBody } from "@providerkit/core";

const reset = parseRateLimitReset(res.headers, Date.now());
// { resetAtMs?: number, retryAfterMs?: number, window?: "5h" | "weekly" | "monthly" }

if (reset.window) {
  // A subscription window. Say when it lifts; do not sleep on it.
  show(`${reset.window} limit — back ${formatRelative(reset.resetAtMs)}`);
} else {
  retryIn(reset.retryAfterMs ?? 60_000);
}
```

`window` is only ever set when something in the response actually named or implied one. Absent
means "no evidence" — treat it as an ordinary throttle rather than assuming the short case.

Some backends put the reset in the body instead of the headers; OpenAI's ChatGPT-subscription
backend carries `resets_at` only on the 429 body. `parseUsageLimitBody` reads that shape. Headers
outrank the body where both are present — the headers name the window, the body only implies it
from the length of the wait.

:::caution[This is not the number your retry policy wants]
`retryAfterFromHeaders` (in the transport) answers a different question: _how long do I sleep?_
It treats `Retry-After` as authoritative. This one answers _when does the user get their tool
back?_, where the window's reset **outranks** `Retry-After` — Anthropic sends `retry-after: 60`
next to a weekly window that lifts in three days. Sixty seconds is the correct sleep and the
wrong horizon.
:::

Rendering `resetAtMs` as "in 4 hours (6:47 PM)" is deliberately **not** here. Relative-time
wording is locale work, and a library that ships it either drags in an i18n dependency or
hardcodes English into everyone's UI.

## Several keys for one provider

Rate limits are scoped per project or per account, so more keys is more throughput. `KeyPool`
walks free-tier keys round-robin and keeps the paid key for last, so free quota burns before
money.

```ts
import { KeyPool, withKeyPool, createGeminiProvider } from "@providerkit/core";

const pool = new KeyPool("gemini", {
  keys: [freeA, freeB, freeC],
  paidKey: paid,
  onEvict: ({ tier, kind, forMs }) => log.warn(`benched a ${tier} key: ${kind} for ${forMs}ms`),
});

const provider = withKeyPool(pool, (apiKey) => createGeminiProvider({ apiKey, model }));
```

`withKeyPool` returns an ordinary `Provider`, so everything downstream — the watchdog, the retry
policy, the loop — is unchanged. A key that fails is benched for a period matched to _why_:

| Kind            | Benched for | Why that long                                                            |
| --------------- | ----------- | ------------------------------------------------------------------------ |
| `rate`          | 1 minute    | A per-minute throttle: the window it named is the next one.              |
| `quota`         | 1 hour      | A balance or a daily window. Minutes will not bring it back.             |
| `auth`          | 12 hours    | Durable, but key-specific — one dead key must not sink the pool.         |
| transient (5xx) | 1 minute    | The vendor's bad time, not the key's; a sibling key may route elsewhere. |

When every key is benched, `with()` throws `NoAvailableKeyError` carrying `retryAtMs` — when the
soonest one comes back — so the caller can say something better than "try again later".

:::danger[One key is not a pool]
With a single key there is nothing to rotate to, so **nothing is evicted** and the error
propagates untouched. Benching the only key would switch a single-key deployment off for a minute
over a transient 503 — where the caller's own retry is the entire recovery there is.
:::
