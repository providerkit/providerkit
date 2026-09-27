---
title: Jev decisions
description: Ask TypeSafe's Jev model typed questions on any of the four hosts that serve it, and get back checked answers with their probabilities.
---

Jev is a model from TypeSafe that answers questions instead of writing text. You give it some
state, as text or JSON, and a few typed questions. It answers each one with the probabilities
behind the answer, usually in under a second. TypeSafe lists it at $0.042 per million input
tokens, with output free (read 2026-09-27).

Jev is not a chat model, so it is not a `Provider`. It has its own entry point:

```ts
import { createJevClient } from "@providerkit/core/jev";

const jev = createJevClient({ host: "openrouter", apiKey });

const { answers } = await jev.ask("Your order has shipped.", {
  shipped: { type: "noul", instructions: "Does the text say the order shipped?" },
});

answers.shipped?.noul; // 0.98: the probability that it's true
```

## Question types

| Type     | Asks                 | Answer                                                                      |
| -------- | -------------------- | --------------------------------------------------------------------------- |
| `choice` | Pick one option      | `choice`, `probabilities` for every option, `confidence`                    |
| `noul`   | Is this true?        | `noul`, the probability of yes                                              |
| `score`  | Where on this scale? | `score`, a fraction between levels; `probabilities` per level; `confidence` |

One call can mix all three:

```ts
const { answers } = await jev.ask(page, {
  next: {
    type: "choice",
    instructions: "Which control finishes the purchase?",
    criteria: { PAY: "The Pay now button", SHOP: "The Continue shopping link", NONE: null },
  },
  progress: {
    type: "score",
    instructions: "How close is the user to finishing?",
    criteria: ["Far", "Midway", "One click away"],
  },
});

answers.next?.choice; // "PAY", typed as "PAY" | "SHOP" | "NONE"
answers.next?.probabilities; // { PAY: 1, SHOP: 0, NONE: 0 }
answers.progress?.score; // 1.99: almost level 2
```

Two fields are easy to misread:

- **`confidence` is not the probability of the pick.** It says how peaked the distribution is.
  TypeSafe's own example spreads 0.57 and 0.43 and reports 0.35. When you need the chance of
  an option, read `probabilities`.
- **`score` is a weighted position, not a level.** 1.43 sits between level 1 and level 2.

## Hosts

The same questions work on all four hosts. The client handles what differs: the URL, the
headers, the body wrapper, and where the answers and usage sit in the reply.

| `host`       | Default model          | You need                                                 |
| ------------ | ---------------------- | -------------------------------------------------------- |
| `typesafe`   | `jev-latest`           | A TypeSafe key                                           |
| `openrouter` | `~typesafe/jev-latest` | An OpenRouter key                                        |
| `cloudflare` | `typesafe/jev`         | An API token with Workers AI access, and the `accountId` |
| `vercel`     | `typesafe-ai/jev`      | An AI Gateway key                                        |

Pass `model` to pin a version, like `typesafe/jev-1.13` on OpenRouter. On OpenRouter,
`attribution: { siteUrl, siteName }` sends your app's URL and name, which OpenRouter uses to
credit your traffic.

OpenRouter was checked with live calls. The Cloudflare and Vercel replies follow their docs
and another open-source client, but no live call has confirmed them yet. If either host
answers differently, please [open an issue](https://github.com/providerkit/providerkit/issues).

## When an answer doesn't pass its checks

Each answer is checked against the question that asked it. If it fails, that answer is `null`
and the others are unaffected. So when you ask several questions and act on only one, a bad
answer to another question doesn't cost you the one you need.

A choice passes only when:

- the pick is one of the options you offered,
- `probabilities` covers exactly those options, each between 0 and 1,
- they add up to 1, give or take the drift from rounding to two decimals (1% to 5%, depending
  on how many options have any weight),
- and the pick is the most likely option.

Treat `null` as "no decision" and don't act on it. If you send the request yourself,
`readAnswer(question, raw)` runs the same checks.

## Failures

A Jev call fails and retries like a chat call, with the same [error kinds](/guides/errors/):

- A throttle or an overload is retried, and a `Retry-After` is honoured. There are three
  attempts by default; change that with `retry`.
- A call still open after 15 seconds times out and is retried. Change that with `timeoutMs`.
- A bad key fails at once as `auth`. So does Cloudflare's 404 for an account ID that doesn't
  exist.
- Your own `signal` stops the call. The abort comes back unchanged and isn't retried.
- A reply with no answers throws. It's classified when the reply names a failure, and
  `unknown` when it doesn't.

## Check a key

`await jev.checkKey()` asks one real question. That costs about 40 input tokens, a few
millionths of a dollar. It proves that the key, the account and the model work together,
which a free call like a model list can't. It throws the same errors as `ask`.

## Cost

No prices ship in this package. OpenRouter reports what each call cost, and that lands in
`usage.reportedCostUsd`. For the other hosts, price the usage yourself:

```ts
import { costUsd } from "@providerkit/core";

const { usage } = await jev.ask(state, questions);
costUsd(usage, { input: 0.042, output: 0, cacheRead: 0 }); // TypeSafe's list price
```

You pay for the state once per call, however many questions you ask about it. An adopter
measured this on 2026-09-27 with the same state of about 22,000 characters: one question cost
6,601 input tokens, and three cost 6,681. So ask everything you need about a state in one
call, and keep page data out of each question's options. Data repeated in every question is
billed every time.

## Limits

Jev reads text only. A request holds up to 64k tokens, and the state plus the longest question
up to 32k. A choice takes up to 255 options, and a score 2 to 10 levels (TypeSafe, read
2026-09-27). The client doesn't check these. A request past them comes back as an error from
the host.
