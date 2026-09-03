// Every header shape a 429 arrives in, and the one question they answer that
// the body cannot: whether the wait is a minute or three days.
import { describe, expect, it } from "vitest";
import { parseRateLimitReset, parseUsageLimitBody } from "../src/rate-limit.ts";
import { retryAfterFromHeaders } from "../src/transport.ts";

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Epoch seconds, the unit Anthropic's unified reset headers use. */
const inSeconds = (ms: number) => String(NOW_SECONDS + ms / 1000);

describe("parseRateLimitReset", () => {
  it("reads retry-after as delay-seconds", () => {
    const result = parseRateLimitReset(new Headers({ "retry-after": "30" }), NOW);
    expect(result).toEqual({ retryAfterMs: 30_000, resetAtMs: NOW + 30_000 });
  });

  it("reads retry-after as an absolute HTTP-date", () => {
    const headers = new Headers({ "retry-after": new Date(NOW + 45_000).toUTCString() });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      retryAfterMs: 45_000,
      resetAtMs: NOW + 45_000,
    });
  });

  it("clamps a retry-after date already in the past to zero", () => {
    const headers = new Headers({ "retry-after": new Date(NOW - 60_000).toUTCString() });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ retryAfterMs: 0, resetAtMs: NOW });
  });

  it("defaults now to the wall clock", () => {
    const result = parseRateLimitReset(new Headers({ "retry-after": "30" }));
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.resetAtMs).toBeCloseTo(Date.now() + 30_000, -3);
  });

  it("names the unified 5h window when it is the more utilized one", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "97",
      "anthropic-ratelimit-unified-5h-reset": inSeconds(4 * HOUR),
      "anthropic-ratelimit-unified-7d-utilization": "12",
      "anthropic-ratelimit-unified-7d-reset": inSeconds(6 * DAY),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      window: "5h",
      resetAtMs: NOW + 4 * HOUR,
    });
  });

  it("names the weekly window when it is the more utilized one", () => {
    // Both windows ride on every OAuth response; only the binding one is the
    // reason for this 429.
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "20",
      "anthropic-ratelimit-unified-5h-reset": inSeconds(HOUR),
      "anthropic-ratelimit-unified-7d-utilization": "99",
      "anthropic-ratelimit-unified-7d-reset": inSeconds(3 * DAY),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      window: "weekly",
      resetAtMs: NOW + 3 * DAY,
    });
  });

  it("lets the window's reset outrank retry-after", () => {
    // The whole point: 60 seconds is the correct sleep and the wrong horizon.
    const headers = new Headers({
      "retry-after": "60",
      "anthropic-ratelimit-unified-7d-utilization": "100",
      "anthropic-ratelimit-unified-7d-reset": inSeconds(3 * DAY),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      window: "weekly",
      retryAfterMs: 60_000,
      resetAtMs: NOW + 3 * DAY,
    });
  });

  it("ignores a window whose reset already elapsed", () => {
    // It rolled over between the response and the parse — naming it would put
    // a past time in front of the user.
    const headers = new Headers({
      "retry-after": "30",
      "anthropic-ratelimit-unified-5h-utilization": "100",
      "anthropic-ratelimit-unified-5h-reset": inSeconds(-HOUR),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      retryAfterMs: 30_000,
      resetAtMs: NOW + 30_000,
    });
  });

  it("ignores a window that reports a reset but no utilization", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-reset": inSeconds(4 * HOUR),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({});
  });

  it("falls back to the API-key RFC 3339 reset timestamps", () => {
    const headers = new Headers({
      "anthropic-ratelimit-requests-reset": new Date(NOW + 90_000).toISOString(),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 90_000 });
  });

  it("skips an RFC 3339 reset already in the past and takes the next header", () => {
    const headers = new Headers({
      "anthropic-ratelimit-requests-reset": new Date(NOW - 5_000).toISOString(),
      "anthropic-ratelimit-tokens-reset": new Date(NOW + 120_000).toISOString(),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 120_000 });
  });

  it("does not consult the RFC 3339 fallback once retry-after answered", () => {
    const headers = new Headers({
      "retry-after": "30",
      "anthropic-ratelimit-requests-reset": new Date(NOW + 900_000).toISOString(),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({
      retryAfterMs: 30_000,
      resetAtMs: NOW + 30_000,
    });
  });

  it("reads the singular unified reset, written in epoch seconds", () => {
    // Plenty of OAuth 429s carry this instead of the 5h/7d pair. transport.ts
    // has always dated it, so answering {} here meant ProviderError.retryAfterMs
    // knew the wait was three days while the user-facing message stayed generic.
    const headers = new Headers({ "anthropic-ratelimit-unified-reset": inSeconds(3 * DAY) });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 3 * DAY });
  });

  it("reads the x-ratelimit-* reset spellings every non-Anthropic provider sends", () => {
    const headers = new Headers({ "x-ratelimit-reset-requests": inSeconds(2 * HOUR) });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 2 * HOUR });
  });

  it("reads a small integer reset as a countdown rather than the year 120", () => {
    // Date.parse("120") is not a rejection — it is a date two millennia back.
    const headers = new Headers({ "x-ratelimit-reset": "120" });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 120_000 });
  });

  it("skips an epoch-seconds reset already elapsed and takes the next header", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-reset": inSeconds(-HOUR),
      "x-ratelimit-reset-tokens": inSeconds(30 * 60_000),
    });
    expect(parseRateLimitReset(headers, NOW)).toEqual({ resetAtMs: NOW + 30 * 60_000 });
  });

  it("yields an empty result for an unrecognized shape", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "0", "content-type": "text/plain" });
    expect(parseRateLimitReset(headers, NOW)).toEqual({});
  });

  it("yields an empty result for an unparseable retry-after", () => {
    expect(parseRateLimitReset(new Headers({ "retry-after": "soon" }), NOW)).toEqual({});
  });
});

describe("parseUsageLimitBody", () => {
  const body = (error: Record<string, unknown>) => JSON.stringify({ error });

  it("reads resets_in_seconds off the codex error envelope", () => {
    const text = body({ type: "usage_limit_reached", resets_in_seconds: 4 * 3_600 });
    expect(parseUsageLimitBody(text, NOW)).toEqual({
      retryAfterMs: 4 * HOUR,
      resetAtMs: NOW + 4 * HOUR,
      window: "5h",
    });
  });

  it("reads resets_at as epoch seconds when there is no relative field", () => {
    const text = body({ resets_at: NOW_SECONDS + 2 * 3_600 });
    expect(parseUsageLimitBody(text, NOW)).toEqual({
      retryAfterMs: 2 * HOUR,
      resetAtMs: NOW + 2 * HOUR,
      window: "5h",
    });
  });

  it("prefers resets_in_seconds when both are present", () => {
    const text = body({ resets_in_seconds: 3_600, resets_at: NOW_SECONDS + 99 * 3_600 });
    expect(parseUsageLimitBody(text, NOW).retryAfterMs).toBe(HOUR);
  });

  it("clamps a resets_at already in the past to zero", () => {
    expect(parseUsageLimitBody(body({ resets_at: NOW_SECONDS - 600 }), NOW)).toEqual({
      retryAfterMs: 0,
      resetAtMs: NOW,
    });
  });

  it("does not let a null resets_in_seconds swallow a real resets_at", () => {
    // Number(null) is 0, and 0 is finite and non-negative, so the relative
    // branch used to win and report a three-day lockout as "retry immediately".
    const text = body({ resets_in_seconds: null, resets_at: NOW_SECONDS + 3 * 86_400 });
    expect(parseUsageLimitBody(text, NOW)).toEqual({
      retryAfterMs: 3 * DAY,
      resetAtMs: NOW + 3 * DAY,
      window: "weekly",
    });
  });

  // Every value Number() quietly turns into a real 0 or a real number it is not.
  for (const blank of [null, "", "   ", [], false, {}, [3]]) {
    it(`ignores resets_in_seconds: ${JSON.stringify(blank)} and reads resets_at`, () => {
      const text = body({ resets_in_seconds: blank, resets_at: NOW_SECONDS + 3 * 86_400 });
      expect(parseUsageLimitBody(text, NOW).window).toBe("weekly");
    });
  }

  it("yields an empty result when both reset fields are null", () => {
    expect(parseUsageLimitBody(body({ resets_in_seconds: null, resets_at: null }), NOW)).toEqual(
      {},
    );
  });

  it("still reads the fields when a relay stringifies them", () => {
    expect(parseUsageLimitBody(body({ resets_in_seconds: "7200" }), NOW).retryAfterMs).toBe(
      2 * HOUR,
    );
    const at = body({ resets_at: String(NOW_SECONDS + 7_200) });
    expect(parseUsageLimitBody(at, NOW).retryAfterMs).toBe(2 * HOUR);
  });

  it("accepts the fields at the top level, as gateway relays send them", () => {
    const text = JSON.stringify({ resets_in_seconds: 3 * 3_600 });
    expect(parseUsageLimitBody(text, NOW).window).toBe("5h");
  });

  it("names no window under the ten-minute floor", () => {
    // A 45-second retry is a per-minute throttle; "5-hour window" would be a lie.
    expect(parseUsageLimitBody(body({ resets_in_seconds: 45 }), NOW)).toEqual({
      retryAfterMs: 45_000,
      resetAtMs: NOW + 45_000,
    });
  });

  it("names a window just past the floor", () => {
    expect(parseUsageLimitBody(body({ resets_in_seconds: 11 * 60 }), NOW).window).toBe("5h");
  });

  it("names the weekly window for a multi-day wait", () => {
    const text = body({ resets_in_seconds: (2 * DAY) / 1000 });
    expect(parseUsageLimitBody(text, NOW).window).toBe("weekly");
  });

  it("names the monthly window past a week", () => {
    const text = body({ resets_in_seconds: (30 * DAY) / 1000 });
    expect(parseUsageLimitBody(text, NOW).window).toBe("monthly");
  });

  it("yields an empty result for malformed JSON", () => {
    expect(parseUsageLimitBody("upstream said no", NOW)).toEqual({});
    expect(parseUsageLimitBody("", NOW)).toEqual({});
  });

  it("yields an empty result for JSON that is not an object", () => {
    expect(parseUsageLimitBody("null", NOW)).toEqual({});
    expect(parseUsageLimitBody('"rate limited"', NOW)).toEqual({});
  });

  it("yields an empty result when the body names no reset at all", () => {
    expect(parseUsageLimitBody(body({ type: "rate_limit_error" }), NOW)).toEqual({});
  });

  it("defaults now to the wall clock", () => {
    const result = parseUsageLimitBody(body({ resets_in_seconds: 60 }));
    expect(result.resetAtMs).toBeCloseTo(Date.now() + 60_000, -3);
  });
});

// The two parsers answer different questions, but they must never disagree
// about which headers can be dated at all: a header only transport reads is a
// 429 whose ProviderError.retryAfterMs knows the wait while the user-facing
// answer is empty. Future values only — transport clamps an elapsed reset to
// zero where this one skips it.
describe("parity with retryAfterFromHeaders", () => {
  const names = [
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
  ];
  const spellings = {
    "epoch seconds": inSeconds(3 * DAY),
    "an RFC 3339 timestamp": new Date(NOW + 3 * DAY).toISOString(),
    "a countdown in seconds": String((3 * DAY) / 1000),
  };
  const expected = (value: number) => Object.fromEntries(names.map((n) => [n, value]));

  for (const [spelling, value] of Object.entries(spellings)) {
    it(`dates every reset header written as ${spelling}`, () => {
      const one = (name: string) => new Headers({ [name]: value });
      const waits = names.map((n) => [n, retryAfterFromHeaders(one(n), NOW)]);
      const resets = names.map((n) => [n, parseRateLimitReset(one(n), NOW).resetAtMs]);
      expect(Object.fromEntries(waits)).toEqual(expected(3 * DAY));
      expect(Object.fromEntries(resets)).toEqual(expected(NOW + 3 * DAY));
    });
  }
});
