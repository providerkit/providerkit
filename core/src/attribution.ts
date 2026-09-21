// App attribution for OpenRouter — `HTTP-Referer` + `X-Title`.
//
// OpenRouter documents both headers as optional and uses them to attribute
// traffic on openrouter.ai (rankings, analytics). They are public, not
// secret, and other vendors ignore unknown headers — so sending them whenever
// the caller names an app is safe on any endpoint.
//
// An explicit entry in `headers` always wins, matched case-insensitively:
// HTTP header names are case-insensitive but this seam carries them as a
// plain record, so `http-referer` and `HTTP-Referer` must mean the same opt-out.
export interface Attribution {
  /** Site URL, sent as `HTTP-Referer` — e.g. "https://your.app". */
  siteUrl?: string;
  /** App name, sent as `X-Title` — e.g. "Your App". */
  siteName?: string;
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const want = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === want);
}

/** Attribution headers not already covered by an explicit `headers` entry. */
export function attributionHeaders(
  attribution: Attribution,
  existing?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (attribution.siteUrl && !hasHeader(existing, "http-referer")) {
    out["HTTP-Referer"] = attribution.siteUrl;
  }
  // `X-Title` is the spelling the fleet already sends and the docs example
  // uses; OpenRouter also accepts the `X-OpenRouter-Title` alias for the same
  // field, so either explicit entry suppresses the default.
  if (
    attribution.siteName &&
    !hasHeader(existing, "x-title") &&
    !hasHeader(existing, "x-openrouter-title")
  ) {
    out["X-Title"] = attribution.siteName;
  }
  return out;
}
