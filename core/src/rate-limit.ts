// Rate-limit headers, read for the one thing a 429 never says in its body: WHEN.
//
// A 429 discloses that a limit was hit, never which limit. A per-minute
// throttle and a Claude OAuth subscription window (5-hour, or weekly) arrive
// as the same status with the same wording, and the second one resets in DAYS.
// Only the headers tell them apart. Without them a caller can say nothing
// better than "try again in a moment", which is a lie for the multi-day case.
//
// Parsing only. Rendering `resetAtMs` as "in 4 hours (6:47 PM)" belongs to the
// caller: relative-time wording is locale work, and a library that ships it
// either drags in an i18n dependency or hardcodes English.
//
// The overlap with `retryAfterFromHeaders` in transport.ts is deliberate, and
// the two are not interchangeable. That one answers the retry policy's
// question — one number, how long to sleep — so it treats `Retry-After` as
// authoritative whenever it is present, and falls back to any vendor reset
// header it can find. This one answers the user-facing question, where the
// unified window's reset OUTRANKS `Retry-After`: Anthropic sends
// `retry-after: 60` beside a weekly window that lifts in three days, and 60
// seconds is the correct sleep and the wrong horizon. Delegating here would
// also fill `retryAfterMs` — documented as what the SERVER asked for — with a
// vendor reset header on every response that carries no `Retry-After` at all.
// What must NOT differ is which headers the two can date: the fallback list
// below is transport's list, because a header only one of them reads is a 429
// whose `ProviderError.retryAfterMs` knows the wait is three days while the
// user-facing answer is empty.

/** Which subscription window bound. Only Anthropic's unified headers name one
 *  outright; the codex body shape has it inferred from the wait. */
export type RateLimitWindow = "5h" | "weekly" | "monthly";

export interface RateLimitReset {
  /** Absolute time the binding window resets, when any header disclosed it. */
  resetAtMs?: number;
  /** Server-requested wait (`retry-after`) — what a retry policy honours. */
  retryAfterMs?: number;
  /** Which subscription window bound, when it could be named at all. */
  window?: RateLimitWindow;
}

const RETRY_AFTER = "retry-after";
const UNIFIED_5H = "anthropic-ratelimit-unified-5h-";
const UNIFIED_7D = "anthropic-ratelimit-unified-7d-";

/** Reset headers that name a time rather than a window, in the order
 *  transport.ts reads them and kept in step with that list. The singular
 *  `anthropic-ratelimit-unified-reset` rides on OAuth responses that carry no
 *  5h/7d pair, and the `x-ratelimit-*` spellings are what every non-Anthropic
 *  provider and gateway sends. */
const RESET_HEADERS = [
  "anthropic-ratelimit-unified-reset",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-reset",
];

/** Seconds since 1970 passed a billion in 2001, so a bare integer above this is
 *  a timestamp and anything below it is a countdown. Vendors disagree on which
 *  they send under the same header name, so magnitude decides. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;

/** A non-negative finite number, or nothing. The null guard carries weight:
 *  `Number("")` is 0, so an absent header would otherwise read as a real zero. */
function numeric(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function unixSecondsToMs(value: string | null): number | undefined {
  const n = numeric(value);
  return n === undefined ? undefined : n * 1000;
}

/** Absolute reset time from a header that spells it either way: epoch seconds
 *  (the unified reset, most gateways) or an RFC 3339 / HTTP-date string (the
 *  API-key reset headers). The digit test runs first because `Date.parse("120")`
 *  is not a rejection — it is the year 120, two millennia in the past. */
function resetHeaderMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > EPOCH_SECONDS_FLOOR ? seconds * 1000 : now + seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

/** `retry-after` is delay-seconds, but RFC 9110 also allows an absolute date,
 *  and both forms occur across the providers this package speaks to. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Parse the rate-limit headers off a (usually 429) response.
 *
 * Anthropic's `anthropic-ratelimit-unified-*` pair rides on every OAuth
 * response, so both windows are always reported and only one of them is the
 * reason for this 429. API-key accounts get the `anthropic-ratelimit-*-reset`
 * RFC 3339 timestamps instead. Everything is optional — an unrecognized shape
 * yields an empty result, and the caller falls back to its generic message.
 */
export function parseRateLimitReset(headers: Headers, now = Date.now()): RateLimitReset {
  const result: RateLimitReset = {};

  const after = parseRetryAfter(headers.get(RETRY_AFTER), now);
  if (after !== undefined) {
    result.retryAfterMs = after;
    result.resetAtMs = now + after;
  }

  // The window with the higher utilization is the one a "would exceed your
  // rate limit" 429 is about. A reset already in the past belongs to a window
  // that rolled over between the response and this parse — naming it would put
  // a past time in front of the user — so it drops out here.
  const windows = [
    {
      window: "5h" as const,
      utilization: numeric(headers.get(`${UNIFIED_5H}utilization`)),
      reset: unixSecondsToMs(headers.get(`${UNIFIED_5H}reset`)),
    },
    {
      window: "weekly" as const,
      utilization: numeric(headers.get(`${UNIFIED_7D}utilization`)),
      reset: unixSecondsToMs(headers.get(`${UNIFIED_7D}reset`)),
    },
  ].filter((w) => w.utilization !== undefined && w.reset !== undefined && w.reset > now);
  const binding = windows.sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
  if (binding) {
    result.window = binding.window;
    // The window's own reset outranks retry-after: it names the real horizon,
    // where retry-after names the next polite attempt.
    if (binding.reset !== undefined) result.resetAtMs = binding.reset;
  }

  // No window named the horizon, so take the first reset header that dates the
  // future. These stay below `retry-after`, which is the server speaking about
  // this request; they only fill a silence.
  if (result.resetAtMs === undefined) {
    for (const name of RESET_HEADERS) {
      const at = resetHeaderMs(headers.get(name), now);
      if (at !== undefined && at > now) {
        result.resetAtMs = at;
        break;
      }
    }
  }

  return result;
}

/** Under ten minutes the wait is a per-minute throttle whatever the body calls
 *  it, and calling a 40-second retry a "5-hour window" would be its own lie. */
const WINDOW_FLOOR_MS = 10 * 60_000;
/** Bucket edges, padded: a window's reset lands wherever inside it the first
 *  request fell, so a 5-hour window routinely reports four hours and change. */
const FIVE_HOUR_MAX_MS = 5.5 * 3_600_000;
const WEEKLY_MAX_MS = 7.5 * 86_400_000;

/** A finite number off a JSON field, the string form a relay may stringify it
 *  into included. Bare `Number()` is the trap `numeric()` guards against one
 *  layer up: `Number(null)`, `Number("")`, `Number([])` and `Number(false)` are
 *  all 0, and 0 is finite and non-negative, so a relay that nulls out
 *  `resets_in_seconds` beside a real `resets_at` would win the branch below and
 *  report a three-day lockout as "retry now". */
function jsonSeconds(value: unknown): number | undefined {
  const usable = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  const n = usable ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * ChatGPT's codex backend puts the reset IN THE 429 BODY, not the headers:
 * `{"error":{"type":"usage_limit_reached","resets_at":1788801754,"resets_in_seconds":2501465}}`.
 * The window name is inferred from the wait itself, and only past the floor
 * above — a sub-minute retry is a throttle, not a subscription window.
 */
export function parseUsageLimitBody(bodyText: string, now = Date.now()): RateLimitReset {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};
  // The fields sit under `error` on the documented shape and at the top level
  // on some gateway relays of it. Both are read rather than guessed between.
  const source = (body as Record<string, unknown>).error;
  const error =
    typeof source === "object" && source !== null
      ? (source as Record<string, unknown>)
      : (body as Record<string, unknown>);

  const inSeconds = jsonSeconds(error.resets_in_seconds);
  const atSeconds = jsonSeconds(error.resets_at);
  const waitMs =
    inSeconds !== undefined && inSeconds >= 0
      ? inSeconds * 1000
      : atSeconds !== undefined && atSeconds > 0
        ? Math.max(0, atSeconds * 1000 - now)
        : undefined;
  if (waitMs === undefined) return {};

  const result: RateLimitReset = { retryAfterMs: waitMs, resetAtMs: now + waitMs };
  if (waitMs > WINDOW_FLOOR_MS) {
    result.window =
      waitMs <= FIVE_HOUR_MAX_MS ? "5h" : waitMs <= WEEKLY_MAX_MS ? "weekly" : "monthly";
  }
  return result;
}
