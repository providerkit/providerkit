// The OAuth plumbing every signed-in provider shares: PKCE, the token POST, the
// credential it builds, and the errors a sign-in can end in. Fetch only, no
// Node built-ins. What differs per vendor stays in flows.ts.
import { classifyHttp, ProviderError } from "../errors.ts";

/** What the host app supplies. Opening a browser and catching a redirect are
 *  the two things a fetch-only package can't do. */
export interface AuthHost {
  /** Names the app on the wire: Copilot's `Editor-Version`, xAI's `referrer`.
   *  Use `name/version`, like `TabRunner/1.4.0`. */
  appName: string;
  /** Opens a page for the user. Device-code flows call it with the approval page. */
  openUrl(url: string): void | Promise<void>;
  /**
   * Opens `authorizeUrl`, waits for the browser to land on `redirectUri`, and
   * returns the `code` from that URL. Reject with a `SignInError` when the user
   * denies (`denied`), closes the page (`cancelled`) or takes too long
   * (`expired`). Check `state` against the one in the URL when it is set.
   */
  captureRedirect(request: {
    authorizeUrl: string;
    redirectUri: string;
    state?: string;
    signal: AbortSignal;
  }): Promise<string>;
  /** Replaces `fetch`, for tests. */
  fetchImpl?: typeof fetch;
}

/** The stored result of a sign-in. */
export interface Credential {
  accessToken: string;
  /** What renews `accessToken`. Copilot keeps the GitHub token here and Meta
   *  its identity token. Empty for a key that never expires (OpenRouter). */
  refreshToken: string;
  /** Epoch ms, already moved earlier by {@link REFRESH_SKEW_MS}: refresh at or
   *  after this, it is not the server's own expiry. */
  expiresAt: number;
  /** For display: the account the token belongs to. */
  account?: string;
  /** ChatGPT only: send it as the `ChatGPT-Account-Id` header. */
  chatgptAccountId?: string;
  /** Set when the vendor gives each account its own host (Copilot). */
  baseUrl?: string;
}

export type SignInFailure = "denied" | "expired" | "cancelled";

/** How a sign-in ended without a credential. The reason picks the wording. */
export class SignInError extends Error {
  constructor(readonly reason: SignInFailure) {
    super(reason);
    this.name = "SignInError";
  }
}

/** The coded errors a sign-in or a refresh throws, as `ProviderError.code`. */
export type AuthErrorCode =
  | "token_refused"
  | "token_incomplete"
  | "device_response_invalid"
  | "setup_required"
  | "refresh_dead";

export function authError(
  code: AuthErrorCode,
  message: string,
  opts: { status?: number; body?: string } = {},
): ProviderError {
  const body = opts.body ?? "";
  // `invalid_grant` and a 401 classify as `auth`, a 429 as `rate`, a 5xx as an outage.
  const kind = opts.status === undefined ? "auth" : classifyHttp(opts.status, body);
  return new ProviderError("auth", kind, message, { ...opts, code });
}

/** Refresh this long before the server's own expiry. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/** RFC 7636 code verifier and S256 challenge. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

/** Opaque CSRF state: 128 bits, hex. */
export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * POST to a token endpoint and return the parsed body.
 *
 * A token in the body wins over the status: a vendor can return a usable
 * credential next to a non-2xx (Anthropic answers 429 for a plan over its usage
 * limit). Only a body without one is an error. The device-code poll sets
 * `allowErrorBody`, because it gets a 4xx for most of the wait.
 */
export async function postToken(
  host: AuthHost,
  url: string,
  params: Record<string, string>,
  opts: { encode: "json" | "form"; allowErrorBody?: boolean },
): Promise<Record<string, unknown>> {
  const json = opts.encode === "json";
  const res = await (host.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });
  const text = await res.text().catch(() => "");
  const record = asRecord(safeJson(text));

  if (isTokenPair(record)) return record;
  if (res.ok || (opts.allowErrorBody && res.status < 500)) return record;

  const detail = errorDetail(record) ?? String(res.status);
  throw authError("token_refused", `The sign-in server refused the request: ${detail}`, {
    status: res.status,
    body: text.slice(0, 2_000),
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isTokenPair(body: Record<string, unknown>): boolean {
  return (
    str(body.access_token) !== undefined &&
    str(body.refresh_token) !== undefined &&
    num(body.expires_in) !== undefined
  );
}

/** A reason out of an OAuth error body: RFC 6749's `error_description` and
 *  `error`, or the nested `error.message` Anthropic and OpenAI use. */
export function errorDetail(record: Record<string, unknown>): string | undefined {
  const description = str(record.error_description);
  if (description) return description;
  const error = record.error;
  if (typeof error === "string") return error;
  const nested = asRecord(error);
  return str(nested.message) ?? str(nested.type);
}

/** The credential a token response describes. Naming the account is the
 *  caller's job: every vendor puts it under a different claim. */
export function toCredential(body: Record<string, unknown>, fallbackRefresh?: string): Credential {
  const accessToken = str(body.access_token);
  // A refresh response may leave out the refresh token. Keep the old one then.
  const refreshToken = str(body.refresh_token) ?? fallbackRefresh;
  const expiresIn = num(body.expires_in);
  if (!accessToken || !refreshToken || expiresIn === undefined) {
    throw authError(
      "token_incomplete",
      "The sign-in server's reply is missing a token or its expiry.",
    );
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS };
}

/** A JWT's payload, read WITHOUT checking the signature. Safe here because
 *  nothing is authorized on it: it only names the account for display. */
export function jwtClaims(token?: string): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    return asRecord(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch {
    return undefined;
  }
}

/** The account a token names, trying the claims in order. An email wins and is
 *  lowercased, because one mailbox written two ways is one account. */
export function accountFromToken(
  token: string | undefined,
  ...claims: string[]
): string | undefined {
  const payload = jwtClaims(token);
  if (!payload) return undefined;
  for (const claim of claims) {
    const value = str(payload[claim]);
    if (value) return claim === "email" ? value.toLowerCase() : value;
  }
  return undefined;
}

/** The URL if it is http(s), else undefined. It comes off the network and ends
 *  up in `openUrl`, so a `javascript:` or `data:` URL must not get through. */
export function webUrl(
  value: string | undefined,
  protocols = ["https:", "http:"],
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
