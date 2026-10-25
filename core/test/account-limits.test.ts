// Envelopes from anomalyco/opencode at 6ac6549a0aed2c69cc31eff17abdc1d690a585a6,
// packages/ai/test/provider-error.test.ts and packages/core/test/session-error.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionClient } from "../src/decisions.ts";
import { classifyHttp, isRetryable, ProviderError, streamError } from "../src/errors.ts";
import { parseUsageLimitBody } from "../src/rate-limit.ts";
import { createRegistry } from "../src/registry.ts";
import { drainStream } from "../src/turn.ts";

const NOW = Date.parse("2026-10-24T00:00:00.000Z");
const RESET = "2026-11-01T00:00:00.000Z";
const RESET_MS = Date.parse(RESET);
const metadata = { coverage: "models", resetsAt: RESET };
const budget = {
  type: "error",
  error: { type: "BudgetLimitError", message: "A budget policy for this model has been reached." },
  metadata,
};
const googleBudget = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "A budget policy for this model has been reached.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "BudgetLimitError",
        domain: "opencode.ai",
        metadata,
      },
    ],
  },
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const caps = [
  { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
  budget.error,
  { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
  { type: "CreditLimitExceeded", message: "Credit limit exceeded." },
  { type: "server_error", message: "Upstream request failed: Account budget exceeded" },
  { type: "server_error", message: "Upstream request failed: Insufficient account funds" },
  { type: "server_error", message: "Upstream request failed: Account invoice is overdue" },
  {
    code: "1309",
    message: "Your GLM Coding Plan package has expired and is temporarily unavailable.",
  },
  { code: "1310", message: "Weekly/Monthly Limit Exhausted." },
];

describe("account caps are not short-term throttles", () => {
  it.each(caps)("reads $type $code before HTTP status or SSE error type", (error) => {
    expect(classifyHttp(429, JSON.stringify({ error }))).toBe("quota");
    expect(classifyHttp(400, JSON.stringify({ error }))).toBe("quota");
    const inBand = streamError("plan", error);
    expect(inBand.kind).toBe("quota");
    expect(isRetryable(inBand)).toBe(false);
  });

  it("reads a budget's reason in Google's ErrorInfo", () => {
    expect(classifyHttp(429, JSON.stringify(googleBudget))).toBe("quota");
  });

  it("does not scan or log echoed request content on failed responses", () => {
    const error = streamError("plan", {
      error: { code: "server_error", message: "try again" },
      instructions: "private context window text",
      tools: [{ description: "private tool description" }],
      output: "private output",
    });
    expect(error.kind).toBe("overload");
    expect(error.body).not.toContain("private");
  });

  it("keeps type-derived rate and auth statuses ahead of generic content words", () => {
    expect(
      streamError("plan", {
        type: "rate_limit_error",
        message: "Request blocked because the rate limit was exceeded",
      }).kind,
    ).toBe("rate");
    expect(
      streamError("plan", {
        type: "authentication_error",
        message: "Account blocked",
      }).kind,
    ).toBe("auth");
  });

  it("ignores mirrored account windows on a 503 but keeps its Retry-After", () => {
    const error = streamError("plan", {
      error: { code: 503, message: "server unavailable" },
      headers: {
        "retry-after": "5",
        "anthropic-ratelimit-unified-7d-utilization": "1",
        "anthropic-ratelimit-unified-7d-reset": String(RESET_MS / 1000),
      },
      metadata,
    });
    expect(error).toMatchObject({ kind: "overload", retryAfterMs: 5_000 });
    expect(error.resetAtMs).toBeUndefined();
  });

  it("keeps headers inside error as well as beside it", () => {
    const error = streamError("plan", {
      error: {
        type: "usage_limit_reached",
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": String(RESET_MS / 1000),
        },
      },
    });
    expect(error).toMatchObject({ kind: "quota", resetAtMs: RESET_MS, window: "weekly" });
  });

  it("keeps normal throttles and invalid requests distinct", () => {
    expect(classifyHttp(429, "Rate limit exceeded. See your budget settings.")).toBe("rate");
    expect(classifyHttp(400, "Invalid budget parameter")).toBe("invalid");
    expect(
      classifyHttp(429, "Your current subscription plan does not yet include access to glm-5"),
    ).toBe("entitlement");
    expect(classifyHttp(503, JSON.stringify(budget))).toBe("overload");
    expect(streamError("plan", { code: 503, message: "Account budget exceeded" }).kind).toBe(
      "overload",
    );
    expect(
      streamError("plan", { type: "invalid_request_error", message: "Wrong field" }).kind,
    ).toBe("invalid");
    expect(
      streamError("plan", {
        error: { type: "usage_limit_reached" },
        status_code: 429,
        headers: { "retry-after": "60" },
      }),
    ).toMatchObject({ kind: "quota", status: 429, retryAfterMs: 60_000 });
  });
});

describe("budget reset metadata", () => {
  it.each([budget, { errors: [budget.error], metadata }])(
    "keeps metadata beside a decision error",
    async (payload) => {
      const client = createDecisionClient({
        host: "opencode",
        fetchImpl: async () => new Response(JSON.stringify(payload)),
      });
      await expect(
        client.ask("hello", { ok: { type: "noul", instructions: "Does it say hello?" } }),
      ).rejects.toMatchObject({ kind: "quota", resetAtMs: RESET_MS });
    },
  );

  it.each([budget, googleBudget, { error: { ...budget.error, metadata } }])(
    "reads the ISO reset from each supported envelope",
    (body) => {
      expect(parseUsageLimitBody(JSON.stringify(body), NOW)).toEqual({
        resetAtMs: RESET_MS,
        retryAfterMs: RESET_MS - NOW,
        window: "monthly",
      });
    },
  );

  it("clamps elapsed resets and ignores missing or invalid metadata", () => {
    expect(parseUsageLimitBody(JSON.stringify(budget), RESET_MS + 1)).toEqual({
      resetAtMs: RESET_MS + 1,
      retryAfterMs: 0,
    });
    for (const value of [null, [], {}, { resetsAt: null }, { resetsAt: "not a date" }]) {
      expect(parseUsageLimitBody(JSON.stringify({ error: {}, metadata: value }), NOW)).toEqual({});
    }
  });

  it("keeps SDK-shaped bodies parseable without their exception prefix", () => {
    const sdkError = Object.assign(new Error("429 status code"), { status: 429, error: budget });
    expect(ProviderError.from("plan", sdkError)).toMatchObject({
      kind: "quota",
      resetAtMs: RESET_MS,
    });
  });

  it.each([NOW - 1, NOW + 60_000])(
    "does not let metadata reset %s hide a later usage reset",
    (at) => {
      const payload = {
        error: { resets_in_seconds: 86_400 },
        metadata: { resetsAt: new Date(at).toISOString() },
      };
      expect(parseUsageLimitBody(JSON.stringify(payload), NOW).resetAtMs).toBe(NOW + 86_400_000);
    },
  );

  it("waits for the latest budget when several ErrorInfo details bind", () => {
    const body = {
      error: {
        details: [{ metadata: { resetsAt: new Date(NOW + 60_000).toISOString() } }, { metadata }],
      },
    };
    expect(parseUsageLimitBody(JSON.stringify(body), NOW).resetAtMs).toBe(RESET_MS);
  });
});

describe.each([
  { preset: "opencode-go", model: "mimo-v2.5" },
  { preset: "opencode-go", model: "minimax-m3" },
  { preset: "opencode-go", model: "muse-spark-1.3-contributor" },
  { preset: "google", model: "gemini-4-argon" },
] as const)("account caps through $preset/$model", ({ preset, model }) => {
  it.each([
    "http",
    "sse",
    ...(model.startsWith("muse-") ? ["response.failed", "response.completed"] : []),
  ])("%s caps reach the backup and stay cooled until the reset", async (wire) => {
    let now = NOW;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (!String(url).includes("openrouter.ai")) {
        const payload = preset === "google" ? googleBudget : budget;
        if (wire === "http") {
          return new Response(JSON.stringify(payload), {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        const event = wire.startsWith("response.")
          ? { type: wire, response: { ...budget, status: "failed" } }
          : payload;
        return new Response(`data: ${JSON.stringify(event)}\n\n`);
      }
      return new Response('data: {"choices":[{"delta":{"content":"backup"}}]}\n\ndata: [DONE]\n\n');
    });
    const providers = createRegistry({
      connections: {
        primary: { preset, model, apiKey: "plan-key", fetchImpl },
        backup: { preset: "openrouter", apiKey: "backup-key", fetchImpl },
      },
      chains: { chat: [`primary/${model}`, "backup/xiaomi/mimo-v2.6-flash"] },
      fallback: { now: () => now },
    });
    const provider = providers.get("chat");
    const ask = () =>
      drainStream(provider.createStream([{ role: "user", content: "hi" }], []), provider.model);
    expect(await ask()).toMatchObject({ text: "backup", provider: "openrouter" });
    expect(providers.status().primary?.candidates[0]).toMatchObject({
      kind: "quota",
      retryAtMs: RESET_MS,
    });
    now += 3_600_000;
    expect((await ask()).text).toBe("backup");
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      preset === "google" ? "generativelanguage.googleapis.com" : "opencode.ai",
      "openrouter.ai",
      "openrouter.ai",
    ]);
    now = RESET_MS;
    await ask();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
