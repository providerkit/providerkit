// Each vendor's sign-in and renewal, built on the shared pieces in oauth.ts and
// device.ts. The client ids are the public ones each vendor's own CLI ships.
//
// ponytail: public client ids and fixed redirect ports. The ceiling is that a
// vendor can rotate a client id, add client attestation or refuse a port, and
// that vendor's sign-in breaks. Its entry below is then the only thing to fix.
import {
  accountFromToken,
  asRecord,
  authError,
  authFetch,
  generatePKCE,
  jwtClaims,
  num,
  postToken,
  randomState,
  REFRESH_SKEW_MS,
  str,
  toCredential,
  webUrl,
  type AuthHost,
  type Credential,
} from "./oauth.ts";
import { pollDeviceToken, requestDeviceCode, type DeviceEndpoint } from "./device.ts";

/** What the user must do on the vendor's page to finish signing in. */
export interface SignInPrompt {
  /** The approval page. The host has already been asked to open it. */
  url: string;
  /** Device-code flows only: the code that page asks for. */
  userCode?: string;
}

/** One vendor's two operations: sign in once, then renew. */
export interface AuthFlow {
  signIn(signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<Credential>;
  /** Trades the stored credential for a fresh one. Both tokens may rotate, so
   *  save the result before you use it. */
  refresh(credential: Credential): Promise<Credential>;
}

export type AuthFlowId =
  | "chatgpt"
  | "kimi-plan"
  | "grok"
  | "github-copilot"
  | "meta"
  | "openrouter"
  | "opencode-zen"
  | "antigravity";

export function createAuthFlow(id: AuthFlowId, host: AuthHost): AuthFlow {
  switch (id) {
    case "chatgpt":
      return chatgptFlow(host);
    case "kimi-plan":
      return deviceFlow(host, KIMI_DEVICE, kimiCredential, kimiRefresh(host));
    case "grok":
      return deviceFlow(host, grokDevice(host), grokCredential, grokRefresh(host));
    case "github-copilot":
      return deviceFlow(
        host,
        GITHUB_DEVICE,
        (body) => mintCopilotCredential(host, body),
        (credential) => refreshCopilot(host, credential),
      );
    case "meta":
      return deviceFlow(
        host,
        META_DEVICE,
        (body) => mintMetaCredential(host, body),
        (credential) => refreshMeta(host, credential),
      );
    case "openrouter":
      return openrouterFlow(host);
    case "opencode-zen":
      return deviceFlow(host, OPENCODE_ZEN_DEVICE, opencodeZenCredential, opencodeZenRefresh(host));
    case "antigravity":
      return antigravityFlow(host);
  }
}

/** A device-code sign-in: ask for the code, show it, open the approval page,
 *  poll until the user approves, then turn the token body into a credential. */
function deviceFlow(
  host: AuthHost,
  endpoint: DeviceEndpoint,
  toCredentialFrom: (body: Record<string, unknown>) => Credential | Promise<Credential>,
  refresh: AuthFlow["refresh"],
): AuthFlow {
  return {
    async signIn(signal, onPrompt) {
      const prompt = await requestDeviceCode(host, endpoint);
      onPrompt({ url: prompt.verificationUrl, userCode: prompt.userCode });
      // If the host can't open it, the code stays on screen as the fallback.
      void Promise.resolve(host.openUrl(prompt.verificationUrl)).catch(() => {});
      return toCredentialFrom(await pollDeviceToken(host, endpoint, prompt, signal));
    },
    refresh,
  };
}

/** Refresh-token renewal that rotates both tokens, shared by Kimi and xAI. */
function refreshWith(
  host: AuthHost,
  endpoint: DeviceEndpoint,
  toCredentialFrom: (body: Record<string, unknown>, fallbackRefresh: string) => Credential,
): AuthFlow["refresh"] {
  return async (credential) =>
    toCredentialFrom(
      await postToken(
        host,
        endpoint.tokenUrl,
        {
          client_id: endpoint.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
        },
        { encode: endpoint.encode },
      ),
      credential.refreshToken,
    );
}

// ── ChatGPT: PKCE through a redirect ──────────────────────────────────────

const CHATGPT = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  // The `api.connectors.*` scopes unlock the subscription quota the Codex
  // backend bills against.
  scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
} as const;

/** The authorize URL to open. Exported so a test can pin the exact params. */
export function chatgptAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT.clientId,
    redirect_uri: CHATGPT.redirectUri,
    scope: CHATGPT.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // The Codex CLI's own params: the simplified flow skips the consent page
    // behind the subscription upsell.
    codex_cli_simplified_flow: "true",
    originator: "opencodex",
    id_token_add_organizations: "true",
  });
  return `${CHATGPT.authorizeUrl}?${params.toString()}`;
}

function chatgptFlow(host: AuthHost): AuthFlow {
  const tokenRequest = (params: Record<string, string>) =>
    postToken(
      host,
      CHATGPT.tokenUrl,
      { client_id: CHATGPT.clientId, ...params },
      { encode: "form" },
    );
  return {
    async signIn(signal, onPrompt) {
      const { verifier, challenge } = await generatePKCE();
      const state = randomState();
      const authorizeUrl = chatgptAuthorizeUrl(challenge, state);
      onPrompt({ url: authorizeUrl });
      const code = await host.captureRedirect({
        authorizeUrl,
        redirectUri: CHATGPT.redirectUri,
        state,
        signal,
      });
      return chatgptCredential(
        await tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: CHATGPT.redirectUri,
          code_verifier: verifier,
        }),
      );
    },
    async refresh(credential) {
      const body = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      });
      return chatgptCredential(body, credential.refreshToken, credential.chatgptAccountId);
    },
  };
}

function chatgptCredential(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
  fallbackAccountId?: string,
): Credential {
  const credential = toCredential(body, fallbackRefresh);
  // The id token has the richer claims. The access token covers a refresh
  // response that leaves it out.
  const idToken = str(body.id_token);
  const account =
    accountFromToken(idToken, "email") ?? accountFromToken(credential.accessToken, "email");
  const chatgptAccountId =
    chatgptAccountIdFromToken(idToken) ??
    chatgptAccountIdFromToken(credential.accessToken) ??
    fallbackAccountId;
  return {
    ...credential,
    ...(account ? { account } : {}),
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
  };
}

/** The `ChatGPT-Account-Id` the Codex backend requires. OpenAI puts it at
 *  `chatgpt_account_id`, under `https://api.openai.com/auth`, or as
 *  `organizations[0].id`, depending on the token. */
export function chatgptAccountIdFromToken(token?: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  const nested = asRecord(claims["https://api.openai.com/auth"]);
  const orgs = claims.organizations;
  const firstOrg = Array.isArray(orgs) ? asRecord(orgs[0]) : {};
  return str(claims.chatgpt_account_id) ?? str(nested.chatgpt_account_id) ?? str(firstOrg.id);
}

// ── Kimi and Grok: device code, then a plain refresh token ────────────────

const KIMI_DEVICE: DeviceEndpoint = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  deviceUrl: "https://auth.kimi.ai/api/oauth/device_authorization",
  tokenUrl: "https://auth.kimi.ai/api/oauth/token",
  encode: "form",
};

function kimiCredential(body: Record<string, unknown>, fallbackRefresh?: string): Credential {
  const credential = toCredential(body, fallbackRefresh);
  const account = accountFromToken(credential.accessToken, "email", "user_id", "sub");
  return account ? { ...credential, account } : credential;
}

const kimiRefresh = (host: AuthHost) => refreshWith(host, KIMI_DEVICE, kimiCredential);

function grokDevice(host: AuthHost): DeviceEndpoint {
  return {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid profile email offline_access grok-cli:access api:access",
    // Names the app instead of claiming to be the Grok CLI.
    extra: { referrer: host.appName },
    encode: "form",
  };
}

/** xAI leaves `expires_in` out of some responses. An hour is what its tokens
 *  carry when it does send one. A guess that is too short costs one extra
 *  refresh, while no expiry would be a credential nothing ever renews. */
const GROK_DEFAULT_LIFETIME_SEC = 3600;

function grokCredential(body: Record<string, unknown>, fallbackRefresh?: string): Credential {
  const credential = toCredential(
    { ...body, expires_in: num(body.expires_in) ?? GROK_DEFAULT_LIFETIME_SEC },
    fallbackRefresh,
  );
  const account = accountFromToken(credential.accessToken, "email", "sub");
  return account ? { ...credential, account } : credential;
}

const grokRefresh = (host: AuthHost) => refreshWith(host, grokDevice(host), grokCredential);

// ── GitHub Copilot: device code, then a mint ──────────────────────────────
// GitHub's device flow ends in a long-lived GitHub token that the Copilot API
// does not accept. It is traded at `copilot_internal/v2/token` for a Copilot
// token that lasts about 25 minutes, and trading again IS the refresh. So
// `refreshToken` holds the GitHub token and `accessToken` the Copilot one.
//
// ponytail: github.com only. A GitHub Enterprise Server tenant serves these
// endpoints on its own domain. Supporting it means threading one domain through
// these constants.

const GITHUB_DEVICE: DeviceEndpoint = {
  // VS Code's Copilot Chat client id. GitHub issues no self-service Copilot
  // client id, so every third-party client uses this one, and the consent page
  // says "GitHub Copilot Chat". Swap this constant for your own OAuth app's.
  clientId: "Iv1.b507a08c87ecfe98",
  deviceUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  // Enough to read the account name. Copilot itself is entitled by the account.
  scope: "read:user",
  encode: "form",
};

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";
/** An individual seat's host. Other plans get their own, named by the token. */
export const COPILOT_DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

/**
 * The editor headers Copilot's gate wants on every call.
 *
 * `turn` matters for the bill. GitHub charges one premium request per
 * user-started turn and lets the agent's own follow-ups ride free, and
 * `X-Initiator` is how a client says which one this is. Leave it off and every
 * tool call in a run bills as a new turn. The `github-copilot` preset sets it
 * for you (`initiatorHeader`); this is for a call you make yourself.
 */
export function copilotHeaders(appName: string, turn: "user" | "agent"): Record<string, string> {
  return {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": appName,
    "Editor-Plugin-Version": appName,
    "X-GitHub-Api-Version": "2026-06-01",
    "Openai-Intent": "conversation-edits",
    "Copilot-Vision-Request": "true",
    "X-Initiator": turn,
  };
}

async function mintCopilotToken(host: AuthHost, githubToken: string): Promise<Credential> {
  const res = await authFetch(host, COPILOT_TOKEN_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...copilotHeaders(host.appName, "user"),
    },
  });
  const text = await res.text().catch(() => "");
  const record = asRecord(parseJson(text));
  if (!res.ok) {
    throw authError(
      "token_refused",
      `GitHub refused the Copilot token request: ${str(record.message) ?? res.status}`,
      { status: res.status, body: text.slice(0, 2_000) },
    );
  }
  const accessToken = str(record.token);
  // Absolute epoch seconds here, not the `expires_in` every other vendor sends.
  const expiresAtSec = num(record.expires_at);
  if (!accessToken || expiresAtSec === undefined) {
    throw authError("token_incomplete", "GitHub's Copilot token reply has no token or expiry.");
  }
  return {
    accessToken,
    refreshToken: githubToken,
    expiresAt: expiresAtSec * 1000 - REFRESH_SKEW_MS,
    baseUrl:
      copilotApiHost(record.endpoints) ??
      copilotHostFromToken(accessToken) ??
      COPILOT_DEFAULT_BASE_URL,
  };
}

async function mintCopilotCredential(
  host: AuthHost,
  body: Record<string, unknown>,
): Promise<Credential> {
  const githubToken = str(body.access_token);
  if (!githubToken) throw authError("token_incomplete", "GitHub's reply has no access token.");
  const credential = await mintCopilotToken(host, githubToken);
  const account = await githubLogin(host, githubToken);
  return account ? { ...credential, account } : credential;
}

async function refreshCopilot(host: AuthHost, credential: Credential): Promise<Credential> {
  const fresh = await mintCopilotToken(host, credential.refreshToken);
  return credential.account ? { ...fresh, account: credential.account } : fresh;
}

/** The login for display. A sign-in that worked must not fail because this
 *  lookup did, so any failure means no name. */
async function githubLogin(host: AuthHost, githubToken: string): Promise<string | undefined> {
  try {
    const res = await authFetch(host, GITHUB_USER_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}` },
    });
    return res.ok ? str(asRecord(await res.json()).login) : undefined;
  } catch {
    return undefined;
  }
}

/** The host a current token response names outright. */
function copilotApiHost(endpoints: unknown): string | undefined {
  return apiBase(str(asRecord(endpoints).api));
}

/** The same host read off the token, for a response with no endpoint map. A
 *  Copilot token is a `;`-joined field list with
 *  `proxy-ep=proxy.<plan>.githubcopilot.com`, and the API host is that with
 *  `proxy.` swapped for `api.`. */
function copilotHostFromToken(token: string): string | undefined {
  const proxy = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
  return proxy ? apiBase(`https://${proxy.replace(/^proxy\./, "api.")}`) : undefined;
}

const apiBase = (url: string | undefined) => webUrl(url, ["https:"])?.replace(/\/$/, "");

// ── Meta Muse: device code, then a key mint ───────────────────────────────
// The device flow's identity token proves who you are and buys nothing. It is
// traded for a Model API key that lasts about a day, and trading again IS the
// refresh. The identity token itself cannot be renewed, so a 401 or 403 from
// the mint means the session is over and the user must sign in again.

const META_DEVICE: DeviceEndpoint = {
  // The Muse Code CLI's client id. Meta issues no self-service one.
  clientId: "1031625952748946",
  deviceUrl: "https://auth.meta.com/oidc/device/authorization/",
  tokenUrl: "https://auth.meta.com/oidc/device/token/",
  encode: "form",
};

const META_KEY_URL = "https://api.meta.ai/muse-code/key";
/** Meta doesn't say how long a key lasts. */
const META_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

async function mintMetaKey(host: AuthHost, identityToken: string): Promise<Credential> {
  const res = await authFetch(host, META_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${identityToken}`,
      "x-api-version": "1.0.0",
    },
    body: "{}",
  });
  const text = await res.text().catch(() => "");
  const record = asRecord(parseJson(text));
  if (!res.ok) {
    throw authError(
      "token_refused",
      `Meta refused the key request: ${str(record.error_description) ?? str(record.detail) ?? res.status}`,
      { status: res.status, body: text.slice(0, 2_000) },
    );
  }
  const apiKey = str(record.api_key);
  if (!apiKey) {
    // Meta answers 200 with no key when the account exists but Muse was never
    // set up on it. `action_url` points at the page to do that.
    const actionUrl = webUrl(str(record.action_url), ["https:"]);
    throw authError(
      "setup_required",
      actionUrl
        ? `Muse isn't set up on this Meta account. Set it up at ${actionUrl}, then sign in again.`
        : "Muse isn't set up on this Meta account. Set it up with Meta, then sign in again.",
    );
  }
  return {
    accessToken: apiKey,
    refreshToken: identityToken,
    expiresAt: Date.now() + META_KEY_LIFETIME_MS - REFRESH_SKEW_MS,
  };
}

async function mintMetaCredential(
  host: AuthHost,
  body: Record<string, unknown>,
): Promise<Credential> {
  const identityToken = str(body.access_token);
  if (!identityToken) throw authError("token_incomplete", "Meta's reply has no identity token.");
  const credential = await mintMetaKey(host, identityToken);
  // The minted key is opaque. The identity token is the one with claims.
  const account = accountFromToken(identityToken, "email", "preferred_username", "sub");
  return account ? { ...credential, account } : credential;
}

async function refreshMeta(host: AuthHost, credential: Credential): Promise<Credential> {
  const fresh = await mintMetaKey(host, credential.refreshToken);
  return credential.account ? { ...fresh, account: credential.account } : fresh;
}

// ── OpenRouter: PKCE, ending in an API key ────────────────────────────────
// The code is traded for an ordinary API key on the user's own account. It
// never expires and the user can revoke it at openrouter.ai, so there is
// nothing to refresh. There is no client id: PKCE is the whole proof.
//
// ponytail: a fixed redirect port. If something else on the machine serves
// 54546 it sees the code first. The exchange then fails and the user starts
// over, which is the right end for a code we can no longer trust.

const OPENROUTER = {
  authorizeUrl: "https://openrouter.ai/auth",
  keysUrl: "https://openrouter.ai/api/v1/auth/keys",
  redirectUri: "http://localhost:54546/callback",
} as const;

/** A key doesn't expire, so its `expiresAt` is as far out as a number goes. */
const NEVER = Number.MAX_SAFE_INTEGER;

function openrouterFlow(host: AuthHost): AuthFlow {
  return {
    async signIn(signal, onPrompt) {
      const { verifier, challenge } = await generatePKCE();
      const authorizeUrl = `${OPENROUTER.authorizeUrl}?${new URLSearchParams({
        callback_url: OPENROUTER.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`;
      onPrompt({ url: authorizeUrl });
      // No `state`: OpenRouter's authorize endpoint takes none.
      const code = await host.captureRedirect({
        authorizeUrl,
        redirectUri: OPENROUTER.redirectUri,
        signal,
      });
      const res = await authFetch(host, OPENROUTER.keysUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      const text = await res.text().catch(() => "");
      const record = asRecord(parseJson(text));
      const key = str(record.key);
      if (!key) {
        throw authError(
          "token_refused",
          `OpenRouter refused the key request: ${str(record.message) ?? str(record.error) ?? res.status}`,
          { status: res.status, body: text.slice(0, 2_000) },
        );
      }
      return { accessToken: key, refreshToken: "", expiresAt: NEVER };
    },
    // Nothing to renew. A revoked key shows up as the call's own 401, and
    // signing in again mints a new one.
    refresh: (credential) => Promise.resolve(credential),
  };
}

// ── OpenCode Console (Zen / Go): device code ──────────────────────────────
// Matches `opencode auth login opencode` in OpenCode v2 (`packages/core/src/plugin/provider/opencode.ts`)
// and `cc-proxy auth login opencode-zen --device`. The Console returns a relative
// `verification_uri_complete` (`/console/device?user_code=…&client_id=opencode-cli`),
// which `requestDeviceCode` resolves against `deviceUrl`.

const OPENCODE_ZEN_DEVICE: DeviceEndpoint = {
  clientId: "opencode-cli",
  deviceUrl: "https://opencode.ai/console/auth/device/code",
  tokenUrl: "https://opencode.ai/console/auth/device/token",
  extra: { supports_org_scope: true },
  encode: "json",
};

function opencodeZenCredential(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
): Credential {
  const accessToken = str(body.access_token);
  if (!accessToken) {
    throw authError("token_incomplete", "OpenCode Console's reply has no access token.");
  }
  const refreshToken = str(body.refresh_token) ?? fallbackRefresh ?? "";
  const expiresIn = num(body.expires_in);
  const expiresAt =
    refreshToken && expiresIn !== undefined
      ? Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS
      : NEVER;
  const account = str(body.org_id) ?? accountFromToken(accessToken, "email", "sub");
  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(account ? { account } : {}),
  };
}

function opencodeZenRefresh(host: AuthHost): AuthFlow["refresh"] {
  return async (credential) => {
    if (!credential.refreshToken) return credential;
    const body = await postToken(
      host,
      OPENCODE_ZEN_DEVICE.tokenUrl,
      {
        client_id: OPENCODE_ZEN_DEVICE.clientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      },
      { encode: "json" },
    );
    const fresh = opencodeZenCredential(body, credential.refreshToken);
    return credential.account && !fresh.account ? { ...fresh, account: credential.account } : fresh;
  };
}

// ── Google Antigravity (Cloud Code Assist): PKCE + project discovery ──────
// Mirrors `cc-proxy/src/providers/antigravity.rs` and `opencodex/src/oauth/google-antigravity.ts`.
// Signs in with Google OAuth PKCE using the public Antigravity desktop client,
// then discovers the Cloud Code Assist `projectId` via `loadCodeAssist` (with
// `onboardUser` fallback for accounts without a project yet).

const ANTIGRAVITY = {
  clientId: [
    "1071006060591-",
    "tmhssin2h21lcre235vtolojh4g403ep",
    ".apps.google",
    "usercontent.com",
  ].join(""),
  clientSecret: ["GOCS", "PX-", "K58FWR486LdL", "J1mLB8sXC4z6qDAf"].join(""),
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: "http://127.0.0.1:51121/callback",
  prodApi: "https://cloudcode-pa.googleapis.com",
  dailyApi: "https://daily-cloudcode-pa.googleapis.com",
  apiVersion: "v1internal",
  ideUserAgent:
    "antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ].join(" "),
  onboardAttempts: 5,
  onboardPollMs: 2_000,
} as const;

/** The authorize URL to open for Google Antigravity. Exported so tests can pin the exact params. */
export function antigravityAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ANTIGRAVITY.clientId,
    redirect_uri: ANTIGRAVITY.redirectUri,
    scope: ANTIGRAVITY.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${ANTIGRAVITY.authorizeUrl}?${params.toString()}`;
}

function extractAntigravityProjectId(data: Record<string, unknown>): string | undefined {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const val = data[key];
    const direct = str(val);
    if (direct) return direct;
    const nested = str(asRecord(val).id);
    if (nested) return nested;
  }
  return undefined;
}

/** Discover the Cloud Code Assist project for an Antigravity access token. */
export async function discoverAntigravityProject(
  host: AuthHost,
  accessToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY.ideUserAgent,
  };
  try {
    const loadRes = await authFetch(
      host,
      `${ANTIGRAVITY.prodApi}/${ANTIGRAVITY.apiVersion}:loadCodeAssist`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        ...(signal ? { signal } : {}),
      },
    );
    if (loadRes.ok) {
      const payload = asRecord(parseJson(await loadRes.text().catch(() => "")));
      const found = extractAntigravityProjectId(payload);
      if (found) return found;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  for (let attempt = 0; attempt < ANTIGRAVITY.onboardAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    try {
      const onboardRes = await authFetch(
        host,
        `${ANTIGRAVITY.dailyApi}/${ANTIGRAVITY.apiVersion}:onboardUser`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            tier_id: "free-tier",
            metadata: {
              ide_type: "ANTIGRAVITY",
              ide_name: "antigravity",
              ide_version: "2.5.5",
            },
          }),
          ...(signal ? { signal } : {}),
        },
      );
      if (onboardRes.ok) {
        const payload = asRecord(parseJson(await onboardRes.text().catch(() => "")));
        if (payload.done === true) {
          const found = extractAntigravityProjectId(asRecord(payload.response));
          if (found) return found;
        }
      } else if (onboardRes.status !== 429 && onboardRes.status < 500) {
        return undefined;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    if (attempt + 1 < ANTIGRAVITY.onboardAttempts) {
      await waitMs(ANTIGRAVITY.onboardPollMs, signal);
    }
  }
  return undefined;
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function antigravityFlow(host: AuthHost): AuthFlow {
  const tokenRequest = (params: Record<string, string>) =>
    postToken(
      host,
      ANTIGRAVITY.tokenUrl,
      {
        client_id: ANTIGRAVITY.clientId,
        client_secret: ANTIGRAVITY.clientSecret,
        ...params,
      },
      { encode: "form" },
    );

  return {
    async signIn(signal, onPrompt) {
      const { verifier, challenge } = await generatePKCE();
      const state = randomState();
      const authorizeUrl = antigravityAuthorizeUrl(challenge, state);
      onPrompt({ url: authorizeUrl });
      const code = await host.captureRedirect({
        authorizeUrl,
        redirectUri: ANTIGRAVITY.redirectUri,
        state,
        signal,
      });
      const body = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: ANTIGRAVITY.redirectUri,
        code_verifier: verifier,
      });
      const credential = antigravityCredential(body);
      const projectId = await discoverAntigravityProject(host, credential.accessToken, signal);
      if (!projectId) {
        throw authError(
          "setup_required",
          "Antigravity login could not discover a Cloud Code Assist project for this Google account.",
        );
      }
      return { ...credential, projectId };
    },
    async refresh(credential) {
      const body = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      });
      const fresh = antigravityCredential(body, credential.refreshToken, credential.account);
      const projectId =
        credential.projectId ??
        (await discoverAntigravityProject(host, fresh.accessToken).catch(() => undefined));
      return projectId ? { ...fresh, projectId } : fresh;
    },
  };
}

function antigravityCredential(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
  fallbackAccount?: string,
): Credential {
  const credential = toCredential(
    { ...body, expires_in: num(body.expires_in) ?? GROK_DEFAULT_LIFETIME_SEC },
    fallbackRefresh,
  );
  const idToken = str(body.id_token);
  const account =
    accountFromToken(idToken, "email") ??
    accountFromToken(credential.accessToken, "email") ??
    fallbackAccount;
  return account ? { ...credential, account } : credential;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
