---
title: Context and compaction
description: Deciding when a conversation must be compacted, and where to cut it — the decisions, not the summarizer.
---

This module makes the **decisions**. It does not summarise — that needs a model call, a prompt,
and a product opinion about what is worth keeping, all of which belong in your loop.

## Deciding

```ts
import {
  needsCompaction,
  historyBudgetTokens,
  guessContextWindow,
  conversationTokens,
} from "@providerkit/core";

const window = guessContextWindow(model);

if (needsCompaction(usage.inputTokens, window)) {
  const budget = historyBudgetTokens(window);
  // ... summarise, then applyCompaction
}
```

`needsCompaction` reserves `CONTEXT_RESERVE_TOKENS` (32k) below the window. The reserve is not
padding: the next turn still has to fit the system prompt, the tool definitions, the model's
reply and its thinking. Compacting only once you are _at_ the limit is already too late.

`guessContextWindow` is a ladder over model-name patterns with a conservative floor. Use a real
number when the endpoint gives you one — OpenRouter, LM Studio and Ollama all report
`contextLength` in their model listings — and keep the guess for the endpoints that do not.

## Choosing the cut

```ts
import { pickCut, applyCompaction } from "@providerkit/core";

const cut = pickCut(messages, historyBudgetTokens(window));
const compacted = applyCompaction(messages, cut, summaryText);
```

`pickCut` walks backwards from the newest message, keeping as much recent history as the budget
allows, and returns the index where the kept tail begins.

Two rules are load-bearing:

**The newest message is always kept**, even when it alone exceeds the budget. Drop it and the
model answers a summary instead of the question the user just asked — which looks, from the
outside, exactly like the model ignoring them.

**A cut never lands on a `tool` message.** A tool result whose originating assistant turn has
been summarised away is an orphan, and providers reject a `tool` role with no matching call. So
the walk moves the cut back past any leading tool results.

`historyBudgetTokens` is `max(6000, window · 0.1)` — a floor so a small window still keeps a
usable tail, and a proportion so a large one does not spend everything on history.

## Estimating

`estimateTokens` is `length / 4`. That is deliberately crude and deliberately dependency-free: a
real tokenizer is megabytes, differs per model family, and would break the MV3 build. The
estimate only has to be good enough to decide _when_ to act, and the reserve absorbs the error.

Prefer the provider's own reported `inputTokens` whenever you have it — after the first turn, you
always do.
