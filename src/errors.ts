// One error shape for every provider, classified once.
//
// `kind` drives the four decisions a caller actually makes — retry it? try a
// different model? rotate the key? what do we tell the user? — so no call site
// ever string-matches an SDK message again.
//
// The ordering is the hard-won part. Providers file the same root cause under
// whatever status they like: quota exhaustion arrives as 429 (OpenAI), 402
// (DeepSeek), 403 (xAI) and 400 (Anthropic). So for the 4xx family the BODY is
// read before the status — status alone gives the wrong advice ("retry" for an
// empty balance, "check your key" for a plan that never included the API).

/** What kind of failure this is, named by what actually fixes it. */
export type ErrorKind =
  /** Our own cancel — the caller pressed Stop. Never retried. */
  | "aborted"
  /** Our own deadline, or the provider's 408. Retry. */
  | "timeout"
  /** The request never reached the provider: socket died, DNS, proxy. Retry. */
  | "network"
  /** Theirs, and temporary: 5xx, Anthropic's 529, "overloaded". Retry, and
   *  worth trying a different model. */
  | "overload"
  /** 429 per-minute throttle. Wait — or rotate to another key or model. */
  | "rate"
  /** Balance or usage window exhausted. Waiting minutes will not fix it. */
  | "quota"
  /** The plan never included this API. Neither a new key nor a top-up fixes it. */
  | "entitlement"
  /** 401/403 — the key is wrong, not the request. */
  | "auth"
  /** The model id does not exist or is not served here. */
  | "model"
  /** The prompt outgrew the context window. The fix is to send less. */
  | "context"
  /** Safety filter or refusal. */
  | "content"
  /** Any other 4xx — a bug in what we sent. */
  | "invalid"
  | "unknown";

/** Worth a cheap retry on the same key and model. */
const TRANSIENT: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "timeout",
  "network",
  "overload",
  "rate",
]);

/** Worth walking to a backup MODEL rather than just waiting. A throttle and an
 *  overload are per-model-endpoint; nothing else on this list is. */
const BACKUP_ELIGIBLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["overload", "rate"]);

export function isTransient(kind: ErrorKind): boolean {
  return TRANSIENT.has(kind);
}

export function isBackupEligible(kind: ErrorKind): boolean {
  return BACKUP_ELIGIBLE.has(kind);
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** Honoured when the provider said how long to wait (Retry-After, or
   *  Gemini's RetryInfo.retryDelay). */
  readonly retryAfterMs?: number;
  /** The provider's own response body, truncated — the actual reason, which is
   *  otherwise lost behind "400 status code (no body)". */
  readonly body?: string;

  constructor(
    provider: string,
    kind: ErrorKind,
    message: string,
    opts: {
      status?: number;
      code?: string;
      retryAfterMs?: number;
      body?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }

  get isTransient(): boolean {
    return isTransient(this.kind);
  }

  get isBackupEligible(): boolean {
    return isBackupEligible(this.kind);
  }

  /** Wrap anything thrown into a classified ProviderError. Already-wrapped
   *  errors pass through untouched, so classification happens exactly once. */
  static from(provider: string, err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const status = readNumber(err, "status");
    const code = readString(err, "code") ?? readString(err, "type");
    const message = messageOf(err);
    const body = bodyTextOf(err);
    return new ProviderError(provider, classify(err, status, body), message, {
      status,
      code,
      retryAfterMs: parseRetryAfterMs(err, body),
      body: body.slice(0, 2_000) || undefined,
      cause: err,
    });
  }
}

// ── reading whatever shape was thrown ─────────────────────────────────────

function readNumber(err: unknown, key: string): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function readString(err: unknown, key: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const message = readString(err, "message");
  if (message !== undefined) return message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Everything readable about the failure as one searchable string: the message
 * plus the parsed provider body. SDKs park the parsed body on `.error`, and
 * that is where the real reason lives ("max_tokens too large", the quotaId,
 * `"type": "billing_error"`). Scanned as TEXT — the error-type strings
 * serialize into it, so no JSON walking is needed.
 */
function bodyTextOf(err: unknown): string {
  const message = messageOf(err);
  if (typeof err !== "object" || err === null) return message;
  const body = (err as Record<string, unknown>).error;
  if (body === undefined) return message;
  try {
    return `${message} ${typeof body === "string" ? body : JSON.stringify(body)}`;
  } catch {
    return message;
  }
}

// ── transport: the failure with no status at all ──────────────────────────

/** Node/undici codes meaning "the socket died", not "the request was wrong".
 *  They usually sit on `cause`, not on the thrown error itself. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * The same faults when only a message survives. Engine wordings differ:
 * Chromium says "Failed to fetch", Firefox "NetworkError when attempting to
 * fetch resource", Safari "Load failed", Node/Bun "fetch failed".
 */
const TRANSPORT_MESSAGES =
  /failed to fetch|fetch failed|network\s?error|load failed|unable to connect|socket hang up|socket (?:connection )?(?:was )?closed|connection (?:error|closed|refused|reset)|premature close|stream (?:ended|closed) unexpectedly|und_err/i;

/** How far up the `cause` chain to look before giving up. */
const CAUSE_DEPTH = 5;

function isAbort(err: unknown): boolean {
  const name = readString(err, "name");
  const code = readString(err, "code");
  return name === "AbortError" || name === "APIUserAbortError" || code === "ABORT_ERR";
}

/**
 * A transport fault: the socket died before or during the response, so there
 * is NO status and no body for the patterns below to read.
 *
 * The chain is walked because the useful code is rarely on the thrown error —
 * it sits on `cause`, sometimes several wrappers deep. Without this walk every
 * network blip classifies as permanent, and a long run dies on its first
 * hiccup, which is the single likeliest way to lose a minutes-long job.
 *
 * A deliberate abort short-circuits to false: the caller pressed Stop, and
 * retrying that just re-fails against the same dead signal.
 */
export function isTransportFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < CAUSE_DEPTH; depth++) {
    if (typeof current !== "object") return false;
    if (isAbort(current)) return false;
    const name = readString(current, "name");
    const code = readString(current, "code");
    const message = readString(current, "message");
    if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
    if (code !== undefined && TRANSPORT_CODES.has(code)) return true;
    // A bare TypeError is also what a real bug throws ("x is not a function"),
    // so the MESSAGE is checked, not just the type — misfiling one of those
    // would retry a genuine bug three times and hide it.
    if (message !== undefined && TRANSPORT_MESSAGES.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ── body patterns, most-specific first ────────────────────────────────────

// The request outgrew the model's window. Distinct from quota in the one way
// that matters: nothing about the account is wrong and waiting fixes nothing —
// the fix is to send less, which is what compaction does.
const CONTEXT_PATTERNS: readonly RegExp[] = [
  /context[_\s]length[_\s]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (?:input )?tokens/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  // Scoped to the thing that overflowed: a bare "exceeds the maximum" also
  // covers image counts and per-minute token rates, which compaction can't fix.
  /exceeds? the (?:model'?s? )?maximum (?:input |prompt |context )?(?:tokens?|length|context)/i,
];

// A plan that never included this API — neither a new key nor a top-up fixes
// it, and its wording overlaps both other categories ("plan" appears in all
// three), so it is checked first.
const ENTITLEMENT_PATTERNS: readonly RegExp[] = [
  /plan does(?:n't| not) (?:include|support)/i,
  /not included (?:in|with) your .{0,40}plan/i,
  /upgrade to [\w ]{1,30}(?:or higher|plan)/i,
  /no api access/i,
];

// Balance or usage window used up. Chinese-market providers report it in
// Chinese, which is why the literal strings are here rather than a rule.
const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /insufficient (?:balance|credits?)/i,
  /credit balance is too low/i,
  /(?:no|out of) credits/i,
  // Both word orders occur in the wild.
  /usage limits? (?:reached|exceeded|hit)/i,
  /reached your (?:usage|weekly|monthly|daily) limit/i,
  /(?:weekly|monthly|daily|plan) usage limit/i,
  /purchase extra usage/i,
  /upgrade your plan/i,
  /quota\b[^.]{0,40}\b(?:exhausted|exceeded|will be refreshed)/i,
  /balance (?:is )?(?:too low|not enough|insufficient)/i,
  /per\s*day|PerDay|insufficient_quota|billing/i,
  /余额不足/,
  /欠费/,
  /额度(?:不足|已用完)/,
];

const MODEL_PATTERNS: readonly RegExp[] = [
  /(?:model|models\/)[^.{\n]{0,40}(?:not found|does not exist|unknown)/i,
  /no model named/i,
  /unsupported model/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid (?:x-api-key|api[ _-]?key|token|credentials?)/i,
  /api[ _-]?key (?:is )?(?:not valid|invalid|incorrect)/i,
  /unauthorized|UNAUTHENTICATED|PERMISSION_DENIED/i,
  /authentication[_\s](?:failed|invalid|error)/i,
  /account (?:disabled|suspended|deactivated|banned)/i,
];

const CONTENT_PATTERNS: readonly RegExp[] = [
  /content[_\s]filter/i,
  /content policy/i,
  /safety|PROHIBITED_CONTENT|blocked|refusal/i,
];

/** Theirs and temporary, said in words rather than a status. Gemini reports
 *  UNAVAILABLE/INTERNAL in the body; gateways say "capacity". */
const OVERLOAD_PATTERNS: readonly RegExp[] = [
  /overloaded|overloaded_error/i,
  /\bunavailable\b|UNAVAILABLE/,
  /internal error|INTERNAL/,
  /\bcapacity\b/i,
  /"code"\s*:\s*5\d\d/,
];

const matches = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/**
 * The kind of failure, from whatever was thrown.
 *
 * Body patterns outrank status for the 4xx family; within them, context beats
 * entitlement beats quota beats auth — each earlier category's fix is useless
 * for the later ones.
 */
export function classify(err: unknown, status?: number, body?: string): ErrorKind {
  if (isAbort(err)) return "aborted";
  if (isTransportFailure(err)) return "network";

  const code = status ?? readNumber(err, "status");
  const text = body ?? bodyTextOf(err);
  const name = readString(err, "name");

  if (name === "TimeoutError" || code === 408) return "timeout";

  // Context first: a 429 whose body says "too many tokens" is either a
  // per-minute rate limit or an oversized prompt, and only the wordings here —
  // which name the WINDOW, not the rate — land on context. Compaction is the
  // fix, and unlike "wait" it is one the caller can act on immediately.
  const clientError = code === undefined || code < 500;
  if (clientError && matches(CONTEXT_PATTERNS, text)) return "context";
  if (clientError && matches(ENTITLEMENT_PATTERNS, text)) return "entitlement";
  if (clientError && matches(QUOTA_PATTERNS, text)) return "quota";
  if (matches(MODEL_PATTERNS, text)) return "model";
  if (code === 401 || code === 403 || matches(AUTH_PATTERNS, text)) return "auth";
  if (code === 402) return "quota";
  if (code === 404) return "model";
  if (code === 429) return "rate";
  if (matches(CONTENT_PATTERNS, text)) return "content";
  // 529 is Anthropic's own "overloaded". 409 is how several gateways say
  // "the model is still loading" — both are worth another attempt.
  if (code === 529 || code === 409) return "overload";
  if (code !== undefined && code >= 500) return "overload";
  if (matches(OVERLOAD_PATTERNS, text)) return "overload";
  if (/timed out|timeout/i.test(text)) return "timeout";
  if (code !== undefined && code >= 400) return "invalid";
  return "unknown";
}

/**
 * How long the provider asked us to wait, in ms. Two dialects: Gemini's
 * RetryInfo (`"retryDelay": "52s"`, inside the body) and the `Retry-After`
 * header, which SDKs keep on the error. Honouring it beats guessing — a
 * backoff shorter than the window just burns an attempt.
 */
export function parseRetryAfterMs(err: unknown, body?: string): number | undefined {
  const text = body ?? bodyTextOf(err);
  const delay = text.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (delay?.[1]) return Math.round(parseFloat(delay[1]) * 1000);

  if (typeof err !== "object" || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  const value =
    headers instanceof Headers
      ? headers.get("retry-after")
      : typeof headers === "object" && headers !== null
        ? (headers as Record<string, unknown>)["retry-after"]
        : undefined;
  if (typeof value !== "string") return undefined;
  // Seconds, or an HTTP-date — both are legal per RFC 9110.
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The loggable surface of a failure — so a dead run never reads
 *  "400 status code (no body)". */
export function describeProviderError(err: unknown): Record<string, unknown> {
  if (err instanceof ProviderError) {
    return {
      provider: err.provider,
      kind: err.kind,
      status: err.status,
      code: err.code,
      retryAfterMs: err.retryAfterMs,
      error: err.message,
      body: err.body,
    };
  }
  return { error: messageOf(err), kind: classify(err) };
}
