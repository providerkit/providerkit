---
title: Decision models
description: Ask Jev, Mammoth, Elephant, Mercury Decide and other decision models typed questions. Get checked choices, scores and yes/no probabilities instead of chat text.
---

Decision models pick from answers you define. They can choose a route, score a result or
estimate whether a statement is true. They do not write a chat response.

## Find models

OpenRouter keeps decision models in a separate catalog:

```ts
import { listOpenRouterDecisionModels } from "@providerkit/core/decisions";

const models = await listOpenRouterDecisionModels();
models[0]?.name; // The name of the first available decision model
```

Each entry has its ID, supported input formats, the reported context limit and current token
prices in `rate`. A missing price or limit means unknown, not free or unlimited.

As of 2026-10-22, OpenRouter lists these free models:

- `baseten/mammoth-1:free`
- `baseten/elephant-1:free`
- `inception/mercury-decide:free`
- `respan/span-01-lite:free`

Free access can change. Read the catalog instead of keeping a price table in your app.
Span-01 and Span-01 Lite only accept yes/no (`noul`) questions with plain-text instructions
and criteria. Their catalog entries include `questionTypes: ["noul"]`. Missing
`questionTypes` means no restriction is known here, not that every feature was tested.

## Ask a question

```ts
import { createDecisionClient } from "@providerkit/core/decisions";

const decisions = createDecisionClient({
  host: "openrouter",
  model: "baseten/mammoth-1:free",
  apiKey,
});

const { answers } = await decisions.ask("Your order has shipped.", {
  shipped: { type: "noul", instructions: "Does the text say the order shipped?" },
});

answers.shipped?.noul; // The probability that the order shipped, between 0 and 1
```

The client is separate from the chat `Provider` interface. It shares the package's HTTP
errors, retries and usage types.

## Question types

| Type     | What it asks               | What comes back                                                |
| -------- | -------------------------- | -------------------------------------------------------------- |
| `choice` | Pick one option            | `choice`, `probabilities` for every option and `confidence`    |
| `noul`   | Is this true?              | `noul`, the probability of yes                                 |
| `score`  | Where on an ordered scale? | Fractional `score`, per-level `probabilities` and `confidence` |

A model that supports them can answer several types in one call:

```ts
const { answers } = await decisions.ask(page, {
  next: {
    type: "choice",
    instructions: "Which control opens the next page of results?",
    criteria: { NEXT: "The Next button", BACK: "The Back link", NONE: null },
  },
  progress: {
    type: "score",
    instructions: "How much of the form is complete?",
    criteria: ["Empty", "Partly filled", "All required fields filled"],
  },
});

answers.next?.choice; // Typed as "NEXT" | "BACK" | "NONE" | undefined
```

`confidence` measures how concentrated the distribution is. It is not the probability of
the chosen option. Read `probabilities[choice]` for that. A score is a weighted position:
1.43 falls between levels 1 and 2, not a fourth named level.

## Hosts

The client handles each host's URL, headers, body wrapper and reply format. Omit `model` to
use the default below, or call `defaultDecisionModel(host)` to read that default.

| `host`       | Default model          | Credential                                                            |
| ------------ | ---------------------- | --------------------------------------------------------------------- |
| `opencode`   | `jev-1.13-free`        | None for the free model; a funded OpenCode Zen account for `jev-1.13` |
| `typesafe`   | `jev-latest`           | TypeSafe key                                                          |
| `openrouter` | `~typesafe/jev-latest` | OpenRouter key                                                        |
| `cloudflare` | `typesafe/jev`         | Workers AI token and `accountId`                                      |
| `vercel`     | `typesafe-ai/jev`      | AI Gateway key                                                        |

The five host adapters do not promise that each host serves every decision model. OpenRouter
provides the live multi-vendor catalog. Other hosts keep their own model IDs and limits.
OpenRouter accepts `attribution: { siteUrl, siteName }` to identify your app.

OpenRouter and OpenCode Zen have been checked with live calls. Cloudflare and Vercel follow
their documented envelopes and another open-source client; neither has been checked live here.

## Check a connection

`await decisions.checkConnection()` asks one real question. It verifies the selected model
and credential together. It can consume credit. Span-01 uses a yes/no check; other models use
a two-option choice. A model listing alone does not prove the account can run the model.

## Invalid answers and failures

Each answer is checked against its question. An invalid answer becomes `null`; the others
remain available. A choice must name an offered option, include the whole probability
distribution and pick a most likely option. Probabilities must sum to one within rounding
tolerance. Never act on `null`. `readAnswer(question, raw)` exposes the same checks.

Transient failures retry up to three attempts by default. `Retry-After` is honored. Each
attempt has a 15-second deadline; change it with `timeoutMs`, and change retries with
`retry`. A bad credential fails without retrying. Your `signal` aborts the call without retry.
OpenCode Zen's free model retries a rejected key once without authentication.

## Cost and limits

OpenRouter's reported bill is `usage.reportedCostUsd`. OpenCode Zen's free model reports zero.
Other hosts need a caller-supplied rate for `costUsd(usage, rate)`. The catalog's `rate` uses
USD per million tokens. No price table ships in this package.

Limits differ by model. Mammoth and Elephant currently report 16,384 tokens; other models
may allow more. Check `contextLength` and the model's question limits before sending a large
state. The client validates answers, not every vendor's request limits.

## Migrate from `/jev`

Version 0.26.0 removes `@providerkit/core/jev`. Use `@providerkit/core/decisions` and
`createDecisionClient`. Rename `JevConfig`, `JevClient`, `JevHost`, `JevQuestion`, `JevAnswer`,
`JevReply` and `JevInstructions` to their `Decision` equivalents. `checkKey()` becomes
`checkConnection()`. `ChoiceQuestion`, `NoulQuestion`, `ScoreQuestion`, `AnswerTo` and
`readAnswer` keep their names. There is no deprecated alias.
