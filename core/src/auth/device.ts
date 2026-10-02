// RFC 8628 device authorization: the sign-in that shows a code instead of
// bouncing through a redirect. Kimi, GitHub Copilot, xAI and Meta all use it.
import { SignInError, authError, num, postToken, str, webUrl, type AuthHost } from "./oauth.ts";

/** RFC 8628: a `slow_down` answer adds this to the poll interval. */
const SLOW_DOWN_STEP_MS = 5000;
/** The poll never goes faster than this, whatever the vendor says. */
const MIN_INTERVAL_MS = 1000;
/** A vendor that leaves out `expires_in` gets this. */
const DEFAULT_EXPIRES_SEC = 900;

/** Where a vendor's device flow lives, and what it wants on the wire. */
export interface DeviceEndpoint {
  /** POST here to get a user code. */
  deviceUrl: string;
  /** POST here, again and again, until the user approves. */
  tokenUrl: string;
  clientId: string;
  /** Sent with the code request, for vendors that want scopes. */
  scope?: string;
  /** Extra fields on the code request only (xAI wants a `referrer`). */
  extra?: Record<string, string>;
  encode: "form" | "json";
}

/** What the user must do, and how long we keep asking. */
export interface DevicePrompt {
  /** Show it as is: it must match what the vendor's page displays. */
  userCode: string;
  /** The approval page, with the code filled in when the vendor offers that. */
  verificationUrl: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}

/** Step 1: ask the vendor for a code the user can approve on the web. */
export async function requestDeviceCode(
  host: AuthHost,
  endpoint: DeviceEndpoint,
): Promise<DevicePrompt> {
  const body = await postToken(
    host,
    endpoint.deviceUrl,
    {
      client_id: endpoint.clientId,
      ...(endpoint.scope ? { scope: endpoint.scope } : {}),
      ...endpoint.extra,
    },
    { encode: endpoint.encode },
  );
  const userCode = str(body.user_code);
  const deviceCode = str(body.device_code);
  // The complete URL carries the code, so there is nothing to type.
  const verificationUrl =
    webUrl(str(body.verification_uri_complete)) ?? webUrl(str(body.verification_uri));
  if (!userCode || !deviceCode || !verificationUrl) {
    throw authError(
      "device_response_invalid",
      "The sign-in server's reply has no code, device code or http(s) approval page.",
    );
  }
  return {
    userCode,
    verificationUrl,
    deviceCode,
    intervalMs: Math.max(MIN_INTERVAL_MS, (num(body.interval) ?? 5) * 1000),
    expiresAt: Date.now() + (num(body.expires_in) ?? DEFAULT_EXPIRES_SEC) * 1000,
  };
}

/**
 * Step 2: poll until the user approves, and return the raw token body. Turning
 * it into a credential is the caller's job, because the bodies differ: GitHub
 * answers with a bare token and no expiry, Meta with an identity token that
 * still has to be traded for a key.
 */
export async function pollDeviceToken(
  host: AuthHost,
  endpoint: DeviceEndpoint,
  prompt: DevicePrompt,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let waitMs = prompt.intervalMs;
  while (Date.now() < prompt.expiresAt) {
    await sleep(waitMs, signal);
    // Pending is the normal answer for most of the loop, and GitHub sends it
    // as a 200 with an `error` field, so the body decides, never the status.
    const body = await postToken(
      host,
      endpoint.tokenUrl,
      {
        client_id: endpoint.clientId,
        device_code: prompt.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      { encode: endpoint.encode, allowErrorBody: true },
    );
    if (str(body.access_token)) return body;

    switch (str(body.error)) {
      case "authorization_pending":
        break;
      case "slow_down":
        // Honour the longer of our step and an interval the server names.
        waitMs = Math.max(waitMs + SLOW_DOWN_STEP_MS, (num(body.interval) ?? 0) * 1000);
        break;
      case "access_denied":
      case "authorization_denied":
        throw new SignInError("denied");
      case "expired_token":
        throw new SignInError("expired");
      default:
        throw authError(
          "token_refused",
          `The sign-in server refused the request: ${str(body.error_description) ?? str(body.error) ?? "no reason given"}`,
        );
    }
  }
  throw new SignInError("expired");
}

/** A delay that a cancelled sign-in cuts short. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SignInError("cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SignInError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
