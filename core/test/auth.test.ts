// The sign-in flows and the token source, against recorded replies. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatgptAccountIdFromToken,
  chatgptAuthorizeUrl,
  createAuthFlow,
  postToken,
  requestDeviceCode,
  SignInError,
  tokenSource,
  type AuthHost,
  type Credential,
} from "../src/auth/index.ts";
import { ProviderError } from "../src/errors.ts";

type Reply = Response | Error;
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A fetch that serves each URL's replies in order and records every request. */
function scripted(script: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: String(init.body ?? ""),
    });
    const reply = script[url]?.shift();
    if (!reply) throw new Error(`no scripted reply for ${url}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function hostWith(fetchImpl: typeof fetch, over: Partial<AuthHost> = {}): AuthHost {
  return {
    appName: "TestApp/1.0",
    openUrl: vi.fn(),
    captureRedirect: vi.fn(),
    fetchImpl,
    ...over,
  };
}

const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims))}.s`;

describe("postToken", () => {
  it("takes a token in the body over the status", async () => {
    const { fetchImpl } = scripted({
      "https://t/token": [
        json({ access_token: "a", refresh_token: "r", expires_in: 60, error: "rate" }, 429),
      ],
    });
    const body = await postToken(hostWith(fetchImpl), "https://t/token", {}, { encode: "form" });
    expect(body.access_token).toBe("a");
  });

  it("throws a coded error that carries the status and classifies invalid_grant as auth", async () => {
    const { fetchImpl } = scripted({
      "https://t/token": [json({ error: "invalid_grant", error_description: "revoked" }, 400)],
    });
    const error = await postToken(
      hostWith(fetchImpl),
      "https://t/token",
      {},
      { encode: "form" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "token_refused", status: 400, kind: "auth" });
  });
});

describe("device code", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const KIMI = {
    device: "https://auth.kimi.ai/api/oauth/device_authorization",
    token: "https://auth.kimi.ai/api/oauth/token",
  };
  const code = (over: Record<string, unknown> = {}) =>
    json({
      user_code: "ABCD-1234",
      device_code: "dev",
      verification_uri: "https://kimi.ai/device",
      interval: 1,
      expires_in: 600,
      ...over,
    });
  const pair = json({
    access_token: jwt({ email: "A@B.com" }),
    refresh_token: "r1",
    expires_in: 3600,
  });

  it("opens the page with the code filled in, and waits through pending and slow_down", async () => {
    const { calls, fetchImpl } = scripted({
      [KIMI.device]: [code({ verification_uri_complete: "https://kimi.ai/device?c=ABCD" })],
      [KIMI.token]: [
        json({ error: "authorization_pending" }, 400),
        json({ error: "slow_down" }, 400),
        pair,
      ],
    });
    const host = hostWith(fetchImpl);
    const onPrompt = vi.fn();
    const pending = createAuthFlow("kimi-plan", host).signIn(
      new AbortController().signal,
      onPrompt,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url === KIMI.token)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url === KIMI.token)).toHaveLength(2);
    // slow_down adds 5 s: the next poll is 6 s after the one that got it.
    await vi.advanceTimersByTimeAsync(5999);
    expect(calls.filter((c) => c.url === KIMI.token)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    const credential = await pending;
    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://kimi.ai/device?c=ABCD",
      userCode: "ABCD-1234",
    });
    expect(host.openUrl).toHaveBeenCalledWith("https://kimi.ai/device?c=ABCD");
    expect(credential).toMatchObject({ refreshToken: "r1", account: "a@b.com" });
    expect(credential.expiresAt).toBe(Date.now() - 5 * 60 * 1000 + 3600 * 1000);
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ])("ends a %s answer as SignInError %s", async (error, reason) => {
    const { fetchImpl } = scripted({
      [KIMI.device]: [code()],
      [KIMI.token]: [json({ error }, 400)],
    });
    const pending = createAuthFlow("kimi-plan", hostWith(fetchImpl))
      .signIn(new AbortController().signal, vi.fn())
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ reason });
    expect(await pending).toBeInstanceOf(SignInError);
  });

  it("stops waiting the moment the user cancels", async () => {
    const { fetchImpl } = scripted({ [KIMI.device]: [code()] });
    const abort = new AbortController();
    const pending = createAuthFlow("kimi-plan", hostWith(fetchImpl))
      .signIn(abort.signal, vi.fn())
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
  });

  it("refuses an approval page that is not http(s), and floors the interval at 1 s", async () => {
    const bad = scripted({
      [KIMI.device]: [code({ verification_uri: "javascript:alert(1)" })],
    });
    const endpoint = {
      deviceUrl: KIMI.device,
      tokenUrl: KIMI.token,
      clientId: "c",
      encode: "form",
    } as const;
    await expect(requestDeviceCode(hostWith(bad.fetchImpl), endpoint)).rejects.toMatchObject({
      code: "device_response_invalid",
    });

    const fast = scripted({ [KIMI.device]: [code({ interval: 0 })] });
    const prompt = await requestDeviceCode(hostWith(fast.fetchImpl), endpoint);
    expect(prompt.intervalMs).toBe(1000);
  });

  it("keeps the old refresh token when a refresh response leaves it out", async () => {
    const { fetchImpl } = scripted({
      [KIMI.token]: [json({ access_token: "new", expires_in: 3600 })],
    });
    const refreshed = await createAuthFlow("kimi-plan", hostWith(fetchImpl)).refresh({
      accessToken: "old",
      refreshToken: "keep-me",
      expiresAt: 0,
    });
    expect(refreshed).toMatchObject({ accessToken: "new", refreshToken: "keep-me" });
  });
});

describe("github copilot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const MINT = "https://api.github.com/copilot_internal/v2/token";
  const expiresAt = () => Math.floor(Date.now() / 1000) + 1500;

  it("mints a Copilot token after the device flow and pins the host the reply names", async () => {
    const { calls, fetchImpl } = scripted({
      "https://github.com/login/device/code": [
        json({
          user_code: "WXYZ",
          device_code: "d",
          verification_uri: "https://github.com/login/device",
        }),
      ],
      "https://github.com/login/oauth/access_token": [json({ access_token: "gho_1" })],
      [MINT]: [
        json({
          token: "tid=1;proxy-ep=proxy.business.githubcopilot.com",
          expires_at: expiresAt(),
          endpoints: { api: "https://api.enterprise.githubcopilot.com" },
        }),
      ],
      "https://api.github.com/user": [json({ login: "octocat" })],
    });
    const pending = createAuthFlow("github-copilot", hostWith(fetchImpl)).signIn(
      new AbortController().signal,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const credential = await pending;

    expect(credential).toMatchObject({
      refreshToken: "gho_1",
      baseUrl: "https://api.enterprise.githubcopilot.com",
      account: "octocat",
    });
    const mint = calls.find((c) => c.url === MINT)!;
    expect(mint.headers.get("authorization")).toBe("Bearer gho_1");
    expect(mint.headers.get("editor-version")).toBe("TestApp/1.0");
  });

  it("falls back to the host in the token, then to the individual host", async () => {
    const mint = async (token: string) => {
      const { fetchImpl } = scripted({
        [MINT]: [json({ token, expires_at: expiresAt() })],
      });
      return createAuthFlow("github-copilot", hostWith(fetchImpl)).refresh({
        accessToken: "old",
        refreshToken: "gho_1",
        expiresAt: 0,
        account: "octocat",
      });
    };
    expect((await mint("a=1;proxy-ep=proxy.business.githubcopilot.com;b=2")).baseUrl).toBe(
      "https://api.business.githubcopilot.com",
    );
    expect((await mint("opaque")).baseUrl).toBe("https://api.individual.githubcopilot.com");
  });

  it("reads a revoked GitHub token as a rejection", async () => {
    const { fetchImpl } = scripted({ [MINT]: [json({ message: "Bad credentials" }, 401)] });
    await expect(
      createAuthFlow("github-copilot", hostWith(fetchImpl)).refresh({
        accessToken: "old",
        refreshToken: "gho_dead",
        expiresAt: 0,
      }),
    ).rejects.toMatchObject({ code: "token_refused", status: 401 });
  });
});

describe("the other flows", () => {
  it("sends the ChatGPT user through the redirect and reads the account id off the token", async () => {
    const idToken = jwt({
      email: "Me@X.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    });
    const { calls, fetchImpl } = scripted({
      "https://auth.openai.com/oauth/token": [
        json({ access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken }),
      ],
    });
    const captureRedirect = vi.fn(
      async (_request: Parameters<AuthHost["captureRedirect"]>[0]) => "the-code",
    );
    const credential = await createAuthFlow(
      "chatgpt",
      hostWith(fetchImpl, { captureRedirect }),
    ).signIn(new AbortController().signal, vi.fn());
    expect(credential).toMatchObject({ account: "me@x.com", chatgptAccountId: "acct_1" });
    const request = captureRedirect.mock.calls[0]![0];
    expect(request.redirectUri).toBe("http://localhost:1455/auth/callback");
    expect(request.authorizeUrl).toContain(`state=${request.state}`);
    expect(new URLSearchParams(calls[0]!.body).get("code")).toBe("the-code");
    expect(new URLSearchParams(calls[0]!.body).get("code_verifier")).toBeTruthy();
  });

  it("pins the ChatGPT authorize params and finds the account id in each place", () => {
    const url = new URL(chatgptAuthorizeUrl("chal", "st"));
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(chatgptAccountIdFromToken(jwt({ chatgpt_account_id: "a" }))).toBe("a");
    expect(chatgptAccountIdFromToken(jwt({ organizations: [{ id: "o" }] }))).toBe("o");
    expect(chatgptAccountIdFromToken("not-a-jwt")).toBeUndefined();
  });

  it("exchanges the OpenRouter code for a key that never expires", async () => {
    const { fetchImpl } = scripted({
      "https://openrouter.ai/api/v1/auth/keys": [json({ key: "sk-or-1" })],
    });
    const host = hostWith(fetchImpl, { captureRedirect: vi.fn(async () => "c") });
    const flow = createAuthFlow("openrouter", host);
    const credential = await flow.signIn(new AbortController().signal, vi.fn());
    expect(credential).toMatchObject({ accessToken: "sk-or-1", refreshToken: "" });
    expect(await flow.refresh(credential)).toBe(credential);
  });

  it("says where to finish when Meta answers 200 with no key", async () => {
    const { fetchImpl } = scripted({
      "https://api.meta.ai/muse-code/key": [json({ action_url: "https://meta.ai/muse" })],
    });
    const error = await createAuthFlow("meta", hostWith(fetchImpl))
      .refresh({ accessToken: "k", refreshToken: "id", expiresAt: 0 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "setup_required" });
    expect(String(error)).toContain("https://meta.ai/muse");
  });
});

describe("tokenSource", () => {
  const stale: Credential = { accessToken: "old", refreshToken: "r1", expiresAt: 0 };
  const fresh: Credential = {
    accessToken: "new",
    refreshToken: "r2",
    expiresAt: Date.now() + 3_600_000,
  };

  function store(initial: Credential | undefined) {
    let stored = initial;
    return {
      load: vi.fn(async () => stored),
      save: vi.fn(async (credential: Credential) => {
        stored = credential;
      }),
      set: (credential: Credential) => {
        stored = credential;
      },
    };
  }

  it("hands out a credential that is still good without refreshing", async () => {
    const s = store(fresh);
    const refresh = vi.fn();
    expect(await tokenSource({ ...s, refresh }).getToken()).toBe(fresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once for two concurrent calls, and saves before returning", async () => {
    const s = store(stale);
    const refresh = vi.fn(async () => fresh);
    const source = tokenSource({ ...s, refresh });
    const [a, b] = await Promise.all([source.getToken(), source.getToken()]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(s.save).toHaveBeenCalledWith(fresh);
    expect([a, b]).toEqual([fresh, fresh]);
  });

  it("adopts a newer stored token when the refresh is rejected", async () => {
    const s = store(stale);
    const refresh = vi.fn(async () => {
      s.set(fresh); // another tab saved while ours was in flight
      throw new ProviderError("auth", "auth", "refused", { status: 400, code: "token_refused" });
    });
    expect(await tokenSource({ ...s, refresh }).getToken()).toBe(fresh);
    expect(s.save).not.toHaveBeenCalled();
  });

  it("says to sign in again when the refresh is rejected and nothing newer is stored", async () => {
    const s = store(stale);
    const refresh = vi.fn(async () => {
      throw new ProviderError("auth", "auth", "refused", { status: 401, code: "token_refused" });
    });
    await expect(tokenSource({ ...s, refresh }).getToken()).rejects.toMatchObject({
      code: "refresh_dead",
      kind: "auth",
    });
  });

  it("keeps the credential and rethrows on a network error", async () => {
    const s = store(stale);
    const offline = new TypeError("fetch failed");
    const source = tokenSource({ ...s, refresh: vi.fn(async () => Promise.reject(offline)) });
    await expect(source.getToken()).rejects.toBe(offline);
    expect(s.save).not.toHaveBeenCalled();
    // And the next call tries again instead of remembering the failure.
    const retry = vi.fn(async () => fresh);
    expect(await tokenSource({ ...s, refresh: retry }).getToken()).toBe(fresh);
  });

  it("says to sign in when nothing is stored", async () => {
    await expect(
      tokenSource({ ...store(undefined), refresh: vi.fn() }).getToken(),
    ).rejects.toMatchObject({ code: "refresh_dead" });
  });
});
