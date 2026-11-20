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
  /** Server-requested wait (`retry-after`), which a retry policy honours. */
  retryAfterMs?: number;
  /** Which subscription window bound, when it could be named at all. */
  window?: RateLimitWindow;
  /** How full the binding window is, as the headers report it (1 is full).
   *  Set only when a window's fill rode the response: Anthropic's unified
   *  5h/7d headers, or the ChatGPT backend's `x-codex-*` ones. */
  utilization?: number;
}

/** A window's fill off a response that reported one: what
 *  `StreamOptions.onRateLimit` receives. */
export type RateLimitReading = RateLimitReset & { utilization: number; resetAtMs: number };

const RETRY_AFTER = "retry-after";
const RETRY_AFTER_MS = "retry-after-ms";
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

/**
 * The ChatGPT backend's two windows. Both ride every response. The slots are
 * "primary" and "secondary", NOT "5h" and "weekly", so the window is named by
 * its own `-window-minutes` (300 and 10080 in every capture), and its
 * `-used-percent` says which one is full. Recorded by cc-proxy off a live turn
 * that spent the 5-hour window, 2026-09.
 */
const CODEX_SLOTS = ["primary", "secondary"] as const;

/** One window as a response reports it: how full, and when it resets. */
interface WindowReading {
  window?: RateLimitWindow;
  utilization?: number;
  reset?: number;
}
type Dated = WindowReading & { utilization: number; reset: number };

function windowForMinutes(minutes: number | undefined): RateLimitWindow | undefined {
  return minutes !== undefined && minutes > 0 ? windowForMs(minutes * 60_000) : undefined;
}

function codexWindow(
  headers: Headers,
  slot: (typeof CODEX_SLOTS)[number],
  now: number,
): WindowReading {
  const name = (suffix: string) => headers.get(`x-codex-${slot}-${suffix}`);
  const percent = numeric(name("used-percent"));
  const after = numeric(name("reset-after-seconds"));
  return {
    window: windowForMinutes(numeric(name("window-minutes"))),
    // A percentage here; Anthropic's unified utilization is a fraction.
    utilization: percent === undefined ? undefined : percent / 100,
    reset:
      unixSecondsToMs(name("reset-at")) ?? (after === undefined ? undefined : now + after * 1000),
  };
}

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

/** Matches Go-style duration strings like "2m59.56s", "7.66s", "500ms", "1h30m". */
const DURATION_PATTERN =
  /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)m?s)?$/i;

function parseDurationMs(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const hours = Number(match[1]) || 0;
  const minutes = Number(match[2]) || 0;
  const seconds = Number(match[3]) || 0;
  const isMs = text.toLowerCase().endsWith("ms");
  const secMs = isMs ? seconds : seconds * 1000;
  const total = Math.round(hours * 3_600_000 + minutes * 60_000 + secMs);
  return total >= 0 ? total : undefined;
}

/** Absolute reset time from a header that spells it either way: epoch seconds
 *  (the unified reset, most gateways), Go-style duration ("2m59s" from OpenAI),
 *  or an RFC 3339 / HTTP-date string (the API-key reset headers). */
function resetHeaderMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > EPOCH_SECONDS_FLOOR ? seconds * 1000 : now + seconds * 1000;
  }
  const duration = parseDurationMs(trimmed);
  if (duration !== undefined) {
    return now + duration;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : at;
}

/** `retry-after` is delay-seconds, Go-style duration ("60s"), or an absolute
 *  HTTP date, and all three occur across providers this package speaks to. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const duration = parseDurationMs(trimmed);
  if (duration !== undefined) return duration;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Parse the rate-limit headers off a (usually 429) response.
 *
 * Anthropic's `anthropic-ratelimit-unified-*` pair rides on every OAuth
 * response, so both windows are always reported and only one of them is the
 * reason for this 429. API-key accounts get the `anthropic-ratelimit-*-reset`
 * RFC 3339 timestamps instead. Everything is optional: an unrecognized shape
 * yields an empty result, and the caller falls back to its generic message.
 */
export function parseRateLimitReset(headers: Headers, now = Date.now()): RateLimitReset {
  const result: RateLimitReset = {};

  // `retry-after-ms` is Anthropic's millisecond spelling of the same header;
  // when both ride a response the coarser one is the same deadline rounded.
  const afterMs = numeric(headers.get(RETRY_AFTER_MS));
  const after = afterMs ?? parseRetryAfter(headers.get(RETRY_AFTER), now);
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
    ...CODEX_SLOTS.map((slot) => codexWindow(headers, slot, now)),
  ].filter(
    (w): w is Dated => w.utilization !== undefined && w.reset !== undefined && w.reset > now,
  );
  // The fuller window binds. Between two as full as each other (both spent,
  // usually) the later reset does: the request passes only once both have
  // cleared, and waiting out the earlier one walks into the other wall. On a
  // dead heat the later slot wins (the sort is stable), as cc-proxy's `max_by`
  // does.
  const binding = windows.sort((a, b) => a.utilization - b.utilization || a.reset - b.reset).at(-1);
  if (binding) {
    if (binding.window) result.window = binding.window;
    result.utilization = binding.utilization;
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

/** The window a span this long belongs to. */
function windowForMs(ms: number): RateLimitWindow {
  if (ms <= FIVE_HOUR_MAX_MS) return "5h";
  if (ms <= WEEKLY_MAX_MS) return "weekly";
  return "monthly";
}

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

const PROSE_RETRY_PATTERNS = [
  /try again in (\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i,
  /retry after (\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i,
  /resets? (?:in|after) (\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i,
  /retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)?/i,
];

function secondsMs(value: unknown): number | undefined {
  const seconds = jsonSeconds(value);
  if (seconds === undefined || seconds < 0) return undefined;
  const ms = Math.round(seconds * 1000);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseProseRetryMs(text: string): number | undefined {
  const google = text.match(/\bplease retry in (\d+(?:\.\d+)?)\s*s\b/i);
  if (google) return secondsMs(google[1]);
  for (const pattern of PROSE_RETRY_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const val = Number.parseFloat(match[1]);
    if (!Number.isFinite(val) || val <= 0) continue;
    const unit = (match[2] ?? "s").toLowerCase();
    const multiplier = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
    const ms = Math.ceil(val * multiplier);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** SDKs may append a serialized reply to a status line. Only the text before it is
 *  prose: a partial JSON body cannot tell us which words belong to the provider. */
function plainMessageDelay(text: string): number | undefined {
  const jsonAt = text.search(/\{|\[/u);
  return parseProseRetryMs(jsonAt < 0 ? text : text.slice(0, jsonAt));
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface BodyHints {
  accountAt?: number;
  delay?: number;
  prose?: number;
}

/** A real account reset survives a shorter Retry-After. A guess from prose does not. Keep
 *  those sources separate until the headers are known. Never scan a serialized request: a
 *  gateway may echo the entire prompt alongside its error. */
function bodyHints(text: string, now: number): BodyHints {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { prose: plainMessageDelay(text) };
  }
  if (typeof decoded === "string") return { prose: parseProseRetryMs(decoded) };
  const hints: BodyHints = {};
  for (const row of Array.isArray(decoded) ? decoded : [decoded]) {
    const outer = fields(row);
    if (!outer) continue;
    const error = fields(outer.error) ?? outer;
    const message = typeof outer.error === "string" ? outer.error : error.message;
    if (typeof message === "string") hints.prose ??= parseProseRetryMs(message);
    // Codex's relative reset is authoritative when it also gives an epoch. Gateways
    // can add a later account reset in metadata, including on a Google ErrorInfo detail.
    const relative = secondsMs(error.resets_in_seconds);
    const epoch = secondsMs(error.resets_at);
    const at = relative !== undefined ? now + relative : epoch;
    if (at !== undefined && at > 0) hints.accountAt = Math.max(hints.accountAt ?? now, at);
    hints.delay ??=
      secondsMs(error.retry_after) ??
      secondsMs(error.retry_after_seconds) ??
      secondsMs(outer.retry_after_seconds);
    const details: unknown[] = Array.isArray(error.details) ? error.details : [];
    for (const value of [outer, error, ...details]) {
      const item = fields(value);
      const deadline = fields(item?.metadata)?.resetsAt;
      if (typeof deadline === "string") {
        const ms = Date.parse(deadline);
        if (Number.isFinite(ms)) hints.accountAt = Math.max(hints.accountAt ?? now, ms);
      }
      // RetryInfo spells even whole seconds as a string. A mention of "retryDelay=1s"
      // inside the model's error message is not this field.
      if (typeof item?.retryDelay === "string") {
        hints.delay ??= secondsMs(/^(\d+(?:\.\d+)?)s$/.exec(item.retryDelay)?.[1]);
      }
    }
  }
  return hints;
}

interface HintOptions {
  headers?: Headers;
  accountWindow?: boolean;
  normalizedDelay?: number;
  fallbackMessage?: string;
}

function mergedReset(text: string, options: HintOptions, now: number): RateLimitReset {
  const header = options.headers ? parseRateLimitReset(options.headers, now) : {};
  const body = bodyHints(text, now);
  const aboutWindow = options.accountWindow !== false;
  const explicit = options.normalizedDelay ?? header.retryAfterMs;
  // A Retry-After header alone supplies no independent account horizon. In particular,
  // it cannot restore a longer delay that the caller has already normalized.
  let headerAt = aboutWindow ? header.resetAtMs : undefined;
  if (
    header.retryAfterMs !== undefined &&
    headerAt === now + header.retryAfterMs &&
    !header.window
  ) {
    headerAt = undefined;
  }
  const accountAt = aboutWindow ? body.accountAt : undefined;
  let bodyWait = body.delay;
  if (accountAt !== undefined) bodyWait = Math.max(accountAt - now, bodyWait ?? 0);
  if (explicit === undefined && headerAt === undefined && bodyWait === undefined) {
    bodyWait = body.prose ?? parseProseRetryMs(options.fallbackMessage ?? "");
  }
  const delay = explicit ?? bodyWait;
  if (!aboutWindow) return delay === undefined ? {} : { retryAfterMs: delay };
  const end = Math.max(headerAt ?? 0, accountAt ?? 0, delay === undefined ? 0 : now + delay);
  const bodySetsEnd =
    end > 0 &&
    (end === accountAt ||
      (explicit === undefined && bodyWait !== undefined && end === now + bodyWait));
  let window: RateLimitWindow | undefined;
  if (header.window && headerAt === end) {
    window = header.window;
  } else if (bodySetsEnd && end - now > WINDOW_FLOOR_MS) {
    window = windowForMs(end - now);
  }
  return {
    ...(end > 0 ? { resetAtMs: end } : {}),
    ...(delay !== undefined ? { retryAfterMs: delay } : {}),
    ...(window ? { window } : {}),
  };
}

/** Read a usage deadline, RetryInfo field or wait stated in the provider's own message. */
export function parseUsageLimitBody(bodyText: string, now = Date.now()): RateLimitReset {
  return mergedReset(bodyText, {}, now);
}

/** Read both places an endpoint can report its reset. A short Retry-After is
 *  not evidence that a longer subscription window has lifted. */
export function parseRateLimitResponse(
  headers: Headers,
  bodyText: string,
  now = Date.now(),
): RateLimitReset {
  return mergedReset(bodyText, { headers }, now);
}

/** @internal A failed rate-limited call can use a known account deadline as its wait even
 *  without Retry-After. Standing account headers say nothing about unrelated failures. */
export function failureReset(bodyText: string, options: HintOptions): RateLimitReset {
  const now = Date.now();
  const reset = mergedReset(bodyText, options, now);
  if (reset.retryAfterMs === undefined && reset.resetAtMs !== undefined) {
    reset.retryAfterMs = Math.max(0, reset.resetAtMs - now);
  }
  return reset;
}
