// Jev on four hosts. The same questions go out in four envelopes and the same
// answers must come back — the Jev twin of golden.test.ts, where a divergence
// passes on the host a developer tried and breaks the app that switches.
import { describe, expect, expectTypeOf, it } from "vitest";
import { ProviderError } from "../src/errors.ts";
import {
  createJevClient,
  readAnswer,
  type ChoiceQuestion,
  type JevConfig,
  type JevHost,
  type JevQuestion,
} from "../src/jev.ts";

const QUESTIONS = {
  next: {
    type: "choice",
    instructions: "Which control finishes the purchase?",
    criteria: { PAY: "The Pay now button", SHOP: "The Continue shopping link", NONE: null },
  },
  is_checkout: { type: "noul", instructions: "Is this a checkout page?" },
  urgency: {
    type: "score",
    instructions: "How close is the user to finishing?",
    criteria: ["Far", "Midway", "One click away"],
  },
} satisfies Record<string, JevQuestion>;

const STATE = { page: "Checkout. Cart has 2 items. Button: Pay now. Link: Continue shopping." };

// Recorded live from OpenRouter's /api/v1/systemone, 2026-09-27, for exactly
// QUESTIONS and STATE. TypeSafe sends the same shape without the cost.
const OPENROUTER_REPLY = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    next: {
      type: "choice",
      choice: "PAY",
      probabilities: { PAY: 1, SHOP: 0, NONE: 0 },
      confidence: 1,
    },
    is_checkout: { type: "noul", noul: 0.98 },
    urgency: {
      type: "score",
      score: 1.99,
      legend: { "0": "Far", "1": "Midway", "2": "One click away" },
      probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
      confidence: 0.98,
    },
  },
  usage: { input_tokens: 397, output_tokens: 70, cost: 0.000016674 },
  id: "gen-dec-1790487643-suDfOd8OSujSuT3SWqgk",
  provider: "TypeSafe",
};

const { usage: _cost, ...withoutCost } = OPENROUTER_REPLY;
const TYPESAFE_REPLY = {
  ...withoutCost,
  model: "jev-1.13.0",
  usage: { input_tokens: 397, output_tokens: 70 },
};

// Cloudflare's v4 envelope around the same reply, as its model page shows it.
const CLOUDFLARE_REPLY = { result: TYPESAFE_REPLY, success: true, errors: [], messages: [] };

// ponytail: Vercel's reply is built from @jkudish/jev-agent-tools' adapter,
// not recorded — no Vercel key has run it here.
const VERCEL_REPLY = {
  answers: {
    next: { type: "choice", choice: "PAY", probabilities: { PAY: 1, SHOP: 0, NONE: 0 } },
    is_checkout: { type: "boolean", probability: 0.98 },
    urgency: { type: "score", score: 1.99, probabilities: { "0": 0, "1": 0.01, "2": 0.99 } },
  },
  usage: { inputTokens: 397, outputTokens: 70 },
  providerMetadata: { typesafe: { confidence: { next: 1, urgency: 0.98 } } },
};

const REPLIES: Record<JevHost, unknown> = {
  typesafe: TYPESAFE_REPLY,
  openrouter: OPENROUTER_REPLY,
  cloudflare: CLOUDFLARE_REPLY,
  vercel: VERCEL_REPLY,
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

/** A fetch that answers each call from `responses` in turn and records what
 *  was sent. The cast is the test seam: a plain function standing in for
 *  fetch's overloaded type. */
function fakeFetch(...responses: (Response | (() => Promise<Response>))[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      signal: init.signal ?? undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no response left");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const noWait = { sleep: async () => {} };

function client(host: JevHost, fetchImpl: typeof fetch, extra: Partial<JevConfig> = {}) {
  return createJevClient({
    host,
    apiKey: "k",
    accountId: "acc",
    fetchImpl,
    retry: noWait,
    ...extra,
  });
}

describe("four hosts, one answer", () => {
  const hosts: JevHost[] = ["typesafe", "openrouter", "cloudflare", "vercel"];

  it.each(hosts)("%s reads the same answers and token counts", async (host) => {
    const { fetchImpl } = fakeFetch(Response.json(REPLIES[host]));
    const reply = await client(host, fetchImpl).ask(STATE, QUESTIONS);
    expect(reply.answers).toEqual({
      next: {
        type: "choice",
        choice: "PAY",
        probabilities: { PAY: 1, SHOP: 0, NONE: 0 },
        confidence: 1,
      },
      is_checkout: { type: "noul", noul: 0.98 },
      urgency: {
        type: "score",
        score: 1.99,
        probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
        confidence: 0.98,
      },
    });
    expect(reply.usage.inputTokens).toBe(397);
    expect(reply.usage.outputTokens).toBe(70);
  });

  it("takes OpenRouter's bill, and no other host's", async () => {
    // The live figure is 397 tokens at $0.042 per million, to the digit.
    const or = fakeFetch(Response.json(OPENROUTER_REPLY));
    expect((await client("openrouter", or.fetchImpl).ask(STATE, QUESTIONS)).usage).toEqual({
      inputTokens: 397,
      cachedInputTokens: 0,
      outputTokens: 70,
      reportedCostUsd: 0.000016674,
    });
    const other = fakeFetch(
      Response.json({ ...TYPESAFE_REPLY, usage: { ...TYPESAFE_REPLY.usage, cost: 9 } }),
    );
    const usage = (await client("typesafe", other.fetchImpl).ask(STATE, QUESTIONS)).usage;
    expect(usage.reportedCostUsd).toBeUndefined();
  });

  it("names the model that answered, else the one asked for", async () => {
    const or = fakeFetch(Response.json(OPENROUTER_REPLY));
    expect((await client("openrouter", or.fetchImpl).ask(STATE, QUESTIONS)).model).toBe(
      "typesafe/jev-1.13-20260917",
    );
    const vercel = fakeFetch(Response.json(VERCEL_REPLY));
    expect((await client("vercel", vercel.fetchImpl).ask(STATE, QUESTIONS)).model).toBe(
      "typesafe-ai/jev",
    );
  });
});

describe("each host's envelope", () => {
  it("TypeSafe: the model and questions in the body, a bearer key", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json(TYPESAFE_REPLY));
    await client("typesafe", fetchImpl).ask(STATE, QUESTIONS);
    expect(sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[0]?.headers.Authorization).toBe("Bearer k");
    expect(sent[0]?.body).toEqual({ model: "jev-latest", state: STATE, questions: QUESTIONS });
  });

  it("OpenRouter: the latest alias, and the app named when asked", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json(OPENROUTER_REPLY));
    await client("openrouter", fetchImpl, {
      attribution: { siteUrl: "https://tabrunner.app", siteName: "TabRunner" },
    }).ask(STATE, QUESTIONS);
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(sent[0]?.body.model).toBe("~typesafe/jev-latest");
    expect(sent[0]?.headers["HTTP-Referer"]).toBe("https://tabrunner.app");
    expect(sent[0]?.headers["X-Title"]).toBe("TabRunner");
  });

  it("Cloudflare: the account in the URL, state and questions under `input`", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json(CLOUDFLARE_REPLY));
    await client("cloudflare", fetchImpl).ask(STATE, QUESTIONS);
    expect(sent[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run");
    expect(sent[0]?.body).toEqual({
      model: "typesafe/jev",
      input: { state: STATE, questions: QUESTIONS },
    });
  });

  it("Cloudflare: reads a reply wrapped a second time in a task record", async () => {
    const wrapped = { success: true, result: { status: "Completed", result: TYPESAFE_REPLY } };
    const { fetchImpl } = fakeFetch(Response.json(wrapped));
    const reply = await client("cloudflare", fetchImpl).ask(STATE, QUESTIONS);
    expect(reply.answers.next?.choice).toBe("PAY");
  });

  it("Cloudflare: refuses to build a URL with no account", () => {
    expect(() => createJevClient({ host: "cloudflare", apiKey: "k" })).toThrow(/accountId/);
  });

  it("Vercel: the gateway headers, the model in a header, noul spelled boolean", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json(VERCEL_REPLY));
    await client("vercel", fetchImpl).ask(STATE, QUESTIONS);
    expect(sent[0]?.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    expect(sent[0]?.headers).toMatchObject({
      Authorization: "Bearer k",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
    });
    expect(sent[0]?.body.model).toBeUndefined();
    expect(sent[0]?.body.questions).toMatchObject({
      is_checkout: { type: "boolean", instructions: "Is this a checkout page?" },
      next: { type: "choice" },
    });
  });
});

describe("readAnswer — an answer becomes an action only if it checks out", () => {
  const choice: ChoiceQuestion<"A" | "B" | "C"> = {
    type: "choice",
    criteria: { A: null, B: null, C: null },
  };
  const good = { type: "choice", choice: "A", probabilities: { A: 0.6, B: 0.3, C: 0.1 } };

  it("keeps the whole distribution, and a missing confidence as null", () => {
    expect(readAnswer(choice, good)).toEqual({ ...good, confidence: null });
  });

  it("refuses a pick without its distribution, whatever the confidence says", () => {
    // Confidence measures spread, not the pick: a distribution rebuilt from
    // it can crown the option that lost.
    expect(readAnswer(choice, { type: "choice", choice: "A", confidence: 0.35 })).toBeNull();
  });

  it("refuses a distribution missing an offered option, or naming one never offered", () => {
    const missing = { ...good, probabilities: { A: 0.7, B: 0.3 } };
    const extra = { ...good, probabilities: { A: 0.6, B: 0.3, C: 0.05, D: 0.05 } };
    expect(readAnswer(choice, missing)).toBeNull();
    expect(readAnswer(choice, extra)).toBeNull();
  });

  it("refuses a pick that is not offered, or not the most likely", () => {
    expect(readAnswer(choice, { ...good, choice: "D" })).toBeNull();
    expect(readAnswer(choice, { ...good, choice: "B" })).toBeNull();
  });

  it("accepts a tie at two decimals", () => {
    const tie = { type: "choice", choice: "B", probabilities: { A: 0.5, B: 0.5, C: 0 } };
    expect(readAnswer(choice, tie)?.choice).toBe("B");
  });

  it("allows the rounding drift of many live options, and no more", () => {
    // Eight options each rounded to two decimals can honestly sum to 0.98.
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const wide: JevQuestion = {
      type: "choice",
      criteria: Object.fromEntries(ids.map((id) => [id, null])),
    };
    const p = (values: number[]) => Object.fromEntries(ids.map((id, i) => [id, values[i]]));
    const drift = [0.3, 0.2, 0.15, 0.12, 0.08, 0.07, 0.04, 0.02]; // sums to 0.98
    expect(
      readAnswer(wide, { type: "choice", choice: "a", probabilities: p(drift) }),
    ).not.toBeNull();
    const garbage = [0.3, 0.2, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05]; // sums to 0.90
    expect(readAnswer(wide, { type: "choice", choice: "a", probabilities: p(garbage) })).toBeNull();
  });

  it("caps the drift at 5%, however many options carry weight", () => {
    // Twenty live options would earn 10% by the per-option rule; the cap
    // keeps a sum of 0.93 failing.
    const ids = Array.from({ length: 20 }, (_, i) => `o${i}`);
    const wide: JevQuestion = {
      type: "choice",
      criteria: Object.fromEntries(ids.map((id) => [id, null])),
    };
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.36 : 0.03]));
    expect(readAnswer(wide, { type: "choice", choice: "o0", probabilities })).toBeNull();
  });

  it("refuses probabilities or a confidence outside 0..1", () => {
    expect(readAnswer(choice, { ...good, probabilities: { A: 1.2, B: -0.1, C: -0.1 } })).toBeNull();
    expect(readAnswer(choice, { ...good, confidence: 3 })).toBeNull();
  });

  it("reads a score as the fraction it is", () => {
    // TypeSafe's own docs example: 0 × 0 + 1 × 0.57 + 2 × 0.43 = 1.43.
    const scale: JevQuestion = { type: "score", criteria: ["low", "mid", "high"] };
    const answer = {
      type: "score",
      score: 1.43,
      probabilities: { "0": 0, "1": 0.57, "2": 0.43 },
      confidence: 0.35,
    };
    expect(readAnswer(scale, answer)).toEqual(answer);
    expect(readAnswer(scale, { ...answer, score: 2.5 })).toBeNull();
  });

  it("refuses a noul outside 0..1 and an answer of the wrong type", () => {
    const yes: JevQuestion = { type: "noul", instructions: "Is it?" };
    expect(readAnswer(yes, { type: "noul", noul: 1.5 })).toBeNull();
    expect(readAnswer(yes, good)).toBeNull();
  });

  it("fails one answer alone, not the call", async () => {
    // A fan-out asks speculative questions it may never act on; one of them
    // coming back malformed must not cost the answer the caller does use.
    const broken = {
      ...TYPESAFE_REPLY,
      answers: { ...TYPESAFE_REPLY.answers, urgency: { type: "score", score: "high" } },
    };
    const { fetchImpl } = fakeFetch(Response.json(broken));
    const reply = await client("typesafe", fetchImpl).ask(STATE, QUESTIONS);
    expect(reply.answers.urgency).toBeNull();
    expect(reply.answers.next?.choice).toBe("PAY");
  });
});

describe("failures", () => {
  it("waits out a 429, then answers", async () => {
    const { sent, fetchImpl } = fakeFetch(
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      Response.json(TYPESAFE_REPLY),
    );
    const reply = await client("typesafe", fetchImpl).ask(STATE, QUESTIONS);
    expect(reply.answers.next?.choice).toBe("PAY");
    expect(sent).toHaveLength(2);
  });

  it("fails a rejected key at once, classified", async () => {
    // TypeSafe's own words for a bad key, recorded 2026-09-27.
    const body =
      '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}';
    const { sent, fetchImpl } = fakeFetch(new Response(body, { status: 401 }));
    await expect(client("typesafe", fetchImpl).ask(STATE, QUESTIONS)).rejects.toMatchObject({
      provider: "jev:typesafe",
      kind: "auth",
      status: 401,
    });
    expect(sent).toHaveLength(1);
  });

  it("reads OpenRouter's unknown model as a model to fix", async () => {
    // Recorded 2026-09-27.
    const body = '{"error":{"message":"Model typesafe/jev-9 does not exist","code":400}}';
    const { fetchImpl } = fakeFetch(new Response(body, { status: 400 }));
    await expect(
      client("openrouter", fetchImpl, { model: "typesafe/jev-9" }).ask(STATE, QUESTIONS),
    ).rejects.toMatchObject({ kind: "model" });
  });

  it("times out its own deadline, and retries it", async () => {
    // Invariant 2: our timeout is ours to retry.
    // Never answers: only the deadline's abort ends it.
    const hangs = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    let calls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls++;
      return calls === 1 ? hangs(url, init) : Response.json(TYPESAFE_REPLY);
    }) as unknown as typeof fetch;
    const reply = await client("typesafe", fetchImpl, { timeoutMs: 20 }).ask(STATE, QUESTIONS);
    expect(reply.answers.next?.choice).toBe("PAY");
    expect(calls).toBe(2);
  });

  it("reports a deadline that never lifts as a classified timeout", async () => {
    // Not the platform's bare TimeoutError: a caller branches on `kind` and
    // names the host from `provider`.
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as unknown as typeof fetch;
    await expect(
      client("typesafe", fetchImpl, { timeoutMs: 20, retry: { ...noWait, maxAttempts: 2 } }).ask(
        STATE,
        QUESTIONS,
      ),
    ).rejects.toMatchObject({ name: "ProviderError", provider: "jev:typesafe", kind: "timeout" });
  });

  it("lets the caller's Stop through untouched, and never retries it", async () => {
    const stop = new AbortController();
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        stop.abort(new DOMException("stopped", "AbortError"));
      });
    }) as unknown as typeof fetch;
    const failure = await client("typesafe", fetchImpl)
      .ask(STATE, QUESTIONS, { signal: stop.signal })
      .catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("classifies a failure that arrives inside a 200", async () => {
    // Invariant 11. Cloudflare's envelope can report a failure with no answers.
    const body = {
      result: null,
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    };
    const { fetchImpl } = fakeFetch(Response.json(body));
    await expect(client("cloudflare", fetchImpl).ask(STATE, QUESTIONS)).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("does not retry a 200 it cannot read at all", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json({ hello: "world" }));
    await expect(client("typesafe", fetchImpl).ask(STATE, QUESTIONS)).rejects.toMatchObject({
      kind: "unknown",
    });
    expect(sent).toHaveLength(1);
  });
});

describe("checkKey", () => {
  const ok = {
    model: "jev-1.13.0",
    answers: {
      ok: {
        type: "choice",
        choice: "YES",
        probabilities: { YES: 0.99, NO: 0.01 },
        confidence: 0.97,
      },
    },
    usage: { input_tokens: 41, output_tokens: 9 },
  };

  it("passes when one real question comes back readable", async () => {
    const { sent, fetchImpl } = fakeFetch(Response.json(ok));
    await expect(client("openrouter", fetchImpl).checkKey()).resolves.toBeUndefined();
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
  });

  it("throws the classified failure for a bad key", async () => {
    const { fetchImpl } = fakeFetch(new Response("", { status: 401 }));
    await expect(client("vercel", fetchImpl).checkKey()).rejects.toMatchObject({ kind: "auth" });
  });

  it("throws when the key works but the answer does not check out", async () => {
    const garbled = { ...ok, answers: { ok: { type: "choice", choice: "MAYBE" } } };
    const { fetchImpl } = fakeFetch(Response.json(garbled));
    await expect(client("typesafe", fetchImpl).checkKey()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("types", () => {
  it("carries a choice's options through to its answer", async () => {
    const { fetchImpl } = fakeFetch(Response.json(TYPESAFE_REPLY));
    const reply = await client("typesafe", fetchImpl).ask(STATE, QUESTIONS);
    expectTypeOf(reply.answers.next?.choice).toEqualTypeOf<"PAY" | "SHOP" | "NONE" | undefined>();
    expectTypeOf(reply.answers.is_checkout?.noul).toEqualTypeOf<number | undefined>();
    expectTypeOf(reply.answers.urgency?.score).toEqualTypeOf<number | undefined>();
  });
});
