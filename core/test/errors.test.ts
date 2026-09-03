// The acceptance suite for the merged classifier.
//
// Every case here was a real failure in one of the codebases this package was
// extracted from, and no single one of them knew all of these. A regression
// here is a lesson being un-learned.
import { describe, expect, it } from "vitest";
import {
  classifyHttp,
  classify,
  describeProviderError,
  isBackupEligible,
  isTransient,
  isTransportFailure,
  parseRetryAfterMs,
  ProviderError,
  type ErrorKind,
} from "../src/errors.ts";

/** An SDK-shaped error: status on the error, parsed body on `.error`. */
function apiError(status: number, body: unknown, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error(`${status} status code`), { status, error: body, ...extra });
}

const kindOf = (err: unknown): ErrorKind => ProviderError.from("test", err).kind;

describe("aborts are never retried", () => {
  it.each(["AbortError", "APIUserAbortError"])("%s", (name) => {
    expect(kindOf(Object.assign(new Error("cancelled"), { name }))).toBe("aborted");
  });

  it("ABORT_ERR code", () => {
    expect(kindOf(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }))).toBe("aborted");
  });

  it("an abort wrapping a socket message is still an abort, not a retry", () => {
    const err = Object.assign(new Error("fetch failed"), { name: "AbortError" });
    expect(kindOf(err)).toBe("aborted");
    expect(isTransient(kindOf(err))).toBe(false);
  });
});

describe("transport failures carry no status and must still be retried", () => {
  it.each([
    ["Failed to fetch", "Chromium"],
    ["NetworkError when attempting to fetch resource", "Firefox"],
    ["Load failed", "Safari"],
    ["fetch failed", "Node/Bun"],
    ["socket hang up", "undici"],
    ["terminated: premature close", "stream"],
  ])("%s (%s)", (message) => {
    expect(kindOf(new TypeError(message))).toBe("network");
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"])("code %s", (code) => {
    expect(kindOf(Object.assign(new Error("request failed"), { code }))).toBe("network");
  });

  it("walks the cause chain — the useful code is rarely on the thrown error", () => {
    const root = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = new Error("request failed", { cause: new Error("upstream", { cause: root }) });
    expect(isTransportFailure(wrapped)).toBe(true);
    expect(kindOf(wrapped)).toBe("network");
  });

  it("gives up past the depth limit rather than walking forever", () => {
    let err = Object.assign(new Error("deep"), { code: "ECONNRESET" }) as Error;
    for (let i = 0; i < 8; i++) err = new Error(`wrap ${i}`, { cause: err });
    expect(isTransportFailure(err)).toBe(false);
  });

  it("a real bug that happens to be a TypeError is NOT a network blip", () => {
    expect(isTransportFailure(new TypeError("x.map is not a function"))).toBe(false);
    expect(kindOf(new TypeError("x.map is not a function"))).toBe("unknown");
  });

  it("APIConnectionError by name", () => {
    expect(kindOf(Object.assign(new Error("connection"), { name: "APIConnectionError" }))).toBe(
      "network",
    );
  });
});

describe("the body outranks the status for the 4xx family", () => {
  // The whole reason this ordering exists: one root cause, five statuses.
  it.each([
    [429, "OpenAI"],
    [402, "DeepSeek"],
    [403, "xAI"],
    [400, "Anthropic"],
  ])("quota exhaustion arriving as %i (%s)", (status) => {
    expect(kindOf(apiError(status, { message: "insufficient_quota" }))).toBe("quota");
  });

  it("a plan that never included the API is entitlement, not quota", () => {
    const err = apiError(403, { message: "Your plan does not include API access" });
    expect(kindOf(err)).toBe("entitlement");
    expect(isTransient(kindOf(err))).toBe(false);
  });

  it("entitlement wins over quota when both words appear", () => {
    // "upgrade your plan" is a quota phrase; "plan does not include" is stronger.
    expect(
      kindOf(apiError(403, { message: "plan does not include this — upgrade your plan" })),
    ).toBe("entitlement");
  });

  it.each([
    ["余额不足", "Moonshot"],
    ["欠费", "Alibaba"],
    ["额度已用完", "Z.ai"],
  ])("Chinese-market quota wording %s (%s)", (message) => {
    expect(kindOf(apiError(400, { message }))).toBe("quota");
  });

  it.each([
    "credit balance is too low",
    "You exceeded your current quota",
    "weekly usage limit reached",
    "reached your monthly limit",
  ])("quota wording: %s", (message) => {
    expect(kindOf(apiError(429, { message }))).toBe("quota");
  });

  it("a plain 429 with no quota wording stays a rate limit", () => {
    const kind = kindOf(apiError(429, { message: "Rate limit reached for gpt-5.6" }));
    expect(kind).toBe("rate");
    expect(isBackupEligible(kind)).toBe(true);
  });
});

describe("classifyHttp — the response-shaped entry point", () => {
  it("keeps body-outranks-status through the new door", () => {
    // Invariant 3 has to hold whichever way the caller arrives. Three adapters
    // used to reach `classify` by inventing an error object to fill a slot they
    // had no value for, in three different spellings; nothing pinned that
    // shape, so nothing would have caught it drifting.
    expect(classifyHttp(429, "prompt is too long: 250000 tokens > 200000 maximum")).toBe("context");
    expect(classifyHttp(429, "Rate limit reached: Limit 30000 tokens per min (TPM)")).toBe("rate");
    expect(classifyHttp(400, '{"error":{"message":"credit balance is too low"}}')).toBe("quota");
  });

  it("falls back to the status when the body says nothing", () => {
    expect(classifyHttp(401, "")).toBe("auth");
    expect(classifyHttp(529, "")).toBe("overload");
    // No status either — a body-only failure, which is how the Responses
    // adapter reports a mid-stream error envelope.
    expect(classifyHttp(undefined, '{"error":{"message":"API key not valid"}}')).toBe("auth");
  });
});

describe("a quota wording must be the message, not a word inside it", () => {
  // These patterns run BEFORE the 429-means-rate fallback and `quota` is
  // permanent, so anything they over-match turns a two-second throttle into a
  // dead run telling the user to top up. The merge that pooled five
  // classifiers brought in a catch-all — /per\s*day|PerDay|insufficient_quota|billing/ —
  // whose last two alternatives are already covered precisely above and whose
  // first two fire on any body that merely NAMES a daily ceiling.
  it("leaves a per-minute throttle alone when it also states the daily ceiling", () => {
    expect(
      classifyHttp(429, "Rate limit reached: Limit 20 per minute, 1000 per day. Try again in 2s."),
    ).toBe("rate");
  });

  it("leaves a rate limit alone when the body merely links to a billing page", () => {
    expect(
      classifyHttp(429, "Rate limit exceeded. See https://console.example.com/settings/billing."),
    ).toBe("rate");
  });

  it("still names the quota wordings that mean it", () => {
    expect(
      classifyHttp(
        429,
        '{"error":{"message":"You exceeded your current quota, check your plan and billing details","type":"insufficient_quota"}}',
      ),
    ).toBe("quota");
    expect(classifyHttp(429, "You have reached your daily limit of 500 requests")).toBe("quota");
    expect(classifyHttp(400, '{"error":"insufficient_quota"}')).toBe("quota");
  });
});

describe("context overflow is not a rate limit", () => {
  it.each([
    "This model's maximum context length is 128000 tokens",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "context_length_exceeded",
    "Please reduce the length of the messages",
    "input is too long for requested model",
  ])("%s", (message) => {
    expect(kindOf(apiError(400, { message }))).toBe("context");
  });

  it("a 429 whose body names the WINDOW is context, not rate", () => {
    // The distinction that matters: compaction fixes one, waiting fixes the other.
    expect(kindOf(apiError(429, { message: "too many input tokens for context window" }))).toBe(
      "context",
    );
  });

  it("context is not transient — waiting does not shorten a prompt", () => {
    expect(isTransient("context")).toBe(false);
  });
});

describe("overload and backup-model eligibility", () => {
  it("Anthropic's 529 is an overload", () => {
    const kind = kindOf(apiError(529, { type: "overloaded_error" }));
    expect(kind).toBe("overload");
    expect(isBackupEligible(kind)).toBe(true);
  });

  it.each([500, 502, 503, 504])("%i is an overload", (status) => {
    expect(kindOf(apiError(status, { message: "server error" }))).toBe("overload");
  });

  it("409 means 'model still loading' on several gateways — worth another try", () => {
    expect(isTransient(kindOf(apiError(409, { message: "model is loading" })))).toBe(true);
  });

  it.each(["overloaded", "The service is unavailable", "internal error", "at capacity"])(
    "said in words rather than a status: %s",
    (message) => {
      expect(kindOf(apiError(200, { message }))).toBe("overload");
    },
  );

  it("Gemini's UNAVAILABLE body", () => {
    expect(kindOf(apiError(200, { error: { status: "UNAVAILABLE" } }))).toBe("overload");
  });

  it("only overload and rate are worth a different model", () => {
    const eligible: ErrorKind[] = ["overload", "rate"];
    const not: ErrorKind[] = ["auth", "quota", "entitlement", "context", "invalid", "model"];
    for (const kind of eligible) expect(isBackupEligible(kind)).toBe(true);
    for (const kind of not) expect(isBackupEligible(kind)).toBe(false);
  });
});

describe("the deterministic failures — fail fast, never burn the retry budget", () => {
  it.each([401, 403])("%i is auth", (status) => {
    expect(kindOf(apiError(status, { message: "nope" }))).toBe("auth");
  });

  it.each([
    "Invalid API key provided",
    "invalid x-api-key",
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "account suspended",
  ])("auth wording: %s", (message) => {
    expect(kindOf(apiError(400, { message }))).toBe("auth");
  });

  it("404 and unknown-model wordings are `model`", () => {
    expect(kindOf(apiError(404, { message: "not found" }))).toBe("model");
    expect(kindOf(apiError(400, { message: "The model `gpt-9` does not exist" }))).toBe("model");
  });

  it("a content filter is not a bug in our request", () => {
    expect(kindOf(apiError(400, { message: "blocked by content policy" }))).toBe("content");
    expect(kindOf(apiError(400, { type: "content_filter" }))).toBe("content");
  });

  it("any other 4xx is our own bug", () => {
    expect(kindOf(apiError(422, { message: "max_tokens must be an integer" }))).toBe("invalid");
  });

  it("none of them is transient", () => {
    for (const kind of ["auth", "entitlement", "model", "content", "invalid"] as ErrorKind[]) {
      expect(isTransient(kind)).toBe(false);
    }
  });
});

describe("retry-after — honouring it beats guessing", () => {
  it("Gemini RetryInfo in the body", () => {
    expect(parseRetryAfterMs(apiError(429, { retryDelay: "52s" }))).toBe(52_000);
  });

  it("fractional seconds", () => {
    expect(parseRetryAfterMs(apiError(429, { retryDelay: "1.5s" }))).toBe(1_500);
  });

  it("Retry-After header in seconds, as a Headers instance", () => {
    const err = apiError(429, {}, { headers: new Headers({ "retry-after": "30" }) });
    expect(parseRetryAfterMs(err)).toBe(30_000);
  });

  it("Retry-After as a plain object", () => {
    expect(parseRetryAfterMs(apiError(429, {}, { headers: { "retry-after": "12" } }))).toBe(12_000);
  });

  it("Retry-After as an HTTP-date", () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(apiError(429, {}, { headers: { "retry-after": when } }));
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("absent when the provider said nothing", () => {
    expect(parseRetryAfterMs(apiError(429, { message: "slow down" }))).toBeUndefined();
  });

  it("rides onto the wrapped error", () => {
    expect(ProviderError.from("gemini", apiError(429, { retryDelay: "8s" })).retryAfterMs).toBe(
      8_000,
    );
  });
});

describe("ProviderError.from", () => {
  it("classifies once — an already-wrapped error passes through untouched", () => {
    const first = ProviderError.from("openai", apiError(429, { message: "slow down" }));
    expect(ProviderError.from("anthropic", first)).toBe(first);
    expect(ProviderError.from("anthropic", first).provider).toBe("openai");
  });

  it("keeps the body, so a dead run never reads '400 status code (no body)'", () => {
    const err = ProviderError.from("openai", apiError(400, { message: "max_tokens too large" }));
    expect(err.body).toContain("max_tokens too large");
    expect(describeProviderError(err)).toMatchObject({
      provider: "openai",
      kind: "invalid",
      status: 400,
    });
  });

  it("preserves the original as `cause`", () => {
    const original = apiError(500, { message: "boom" });
    expect(ProviderError.from("openai", original).cause).toBe(original);
  });

  it("survives a thrown non-Error", () => {
    expect(() => ProviderError.from("openai", "just a string")).not.toThrow();
    expect(ProviderError.from("openai", "just a string").message).toBe("just a string");
    expect(ProviderError.from("openai", null).kind).toBe("unknown");
  });

  it("exposes the two predicates callers actually branch on", () => {
    const overloaded = ProviderError.from("anthropic", apiError(529, { type: "overloaded_error" }));
    expect(overloaded.isTransient).toBe(true);
    expect(overloaded.isBackupEligible).toBe(true);

    const badKey = ProviderError.from("openai", apiError(401, { message: "bad key" }));
    expect(badKey.isTransient).toBe(false);
    expect(badKey.isBackupEligible).toBe(false);
  });
});

describe("classify() is total", () => {
  it("never throws, whatever it is handed", () => {
    for (const input of [undefined, null, 0, "", [], {}, new Error(), Symbol("x")]) {
      expect(() => classify(input)).not.toThrow();
    }
  });
});
