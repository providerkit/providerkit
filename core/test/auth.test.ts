// The sign-in flows and the token source, against recorded replies. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  antigravityAuthorizeUrl,
  chatgptAccountIdFromToken,
  chatgptAuthorizeUrl,
  createAuthFlow,
  postToken,
  requestDeviceCode,
  SignInError,
  tokenSource,
  withToken,
  type AuthHost,
  type Credential,
  type TokenAuth,
} from "../src/auth/index.ts";
import { ProviderError } from "../src/errors.ts";
import { withFallbackProviders } from "../src/fallback.ts";
import { createPresetProvider } from "../src/providers/factory.ts";
import type { ChatMessage, Provider, ProviderChunk } from "../src/types.ts";

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

  it("opencode-zen: resolves relative verification_uri_complete and refreshes when a refresh token is returned", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = scripted({
      "https://opencode.ai/console/auth/device/code": [
        json({
          device_code: "dev_1",
          user_code: "VHDD-TRPN",
          verification_uri: "/console/device",
          verification_uri_complete: "/console/device?user_code=VHDD-TRPN&client_id=opencode-cli",
          expires_in: 600,
          interval: 5,
        }),
      ],
      "https://opencode.ai/console/auth/device/token": [
        json({
          access_token: "oc_tok_1",
          refresh_token: "oc_ref_1",
          expires_in: 3600,
          org_id: "org-alpha",
        }),
        json({
          access_token: "oc_tok_2",
          refresh_token: "oc_ref_2",
          expires_in: 3600,
        }),
      ],
    });
    const host = hostWith(fetchImpl);
    const onPrompt = vi.fn();
    const pending = createAuthFlow("opencode-zen", host).signIn(
      new AbortController().signal,
      onPrompt,
    );
    await vi.advanceTimersByTimeAsync(5000);
    const cred = await pending;
    expect(JSON.parse(calls[0]!.body)).toEqual({
      client_id: "opencode-cli",
      supports_org_scope: true,
    });
    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://opencode.ai/console/device?user_code=VHDD-TRPN&client_id=opencode-cli",
      userCode: "VHDD-TRPN",
    });
    expect(cred.accessToken).toBe("oc_tok_1");
    expect(cred.refreshToken).toBe("oc_ref_1");
    expect(cred.account).toBe("org-alpha");

    const refreshed = await createAuthFlow("opencode-zen", host).refresh(cred);
    expect(refreshed.accessToken).toBe("oc_tok_2");
    expect(refreshed.account).toBe("org-alpha");
    vi.useRealTimers();
  });

  it("antigravity: exchanges PKCE code, discovers Cloud Code Assist projectId, and forwards it via withToken", async () => {
    const url = new URL(antigravityAuthorizeUrl("chal", "state-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51121/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");

    const { calls, fetchImpl } = scripted({
      "https://oauth2.googleapis.com/token": [
        json({
          access_token: "ya29.tok1",
          refresh_token: "1//ref1",
          expires_in: 3600,
          id_token: jwt({ email: "Dev@Example.com" }),
        }),
      ],
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": [
        json({ cloudaicompanionProject: "cca-proj-42" }),
      ],
    });
    const host = hostWith(fetchImpl, {
      captureRedirect: vi.fn(async () => "auth-code-1"),
    });
    const cred = await createAuthFlow("antigravity", host).signIn(
      new AbortController().signal,
      vi.fn(),
    );
    expect(cred.accessToken).toBe("ya29.tok1");
    expect(cred.refreshToken).toBe("1//ref1");
    expect(cred.account).toBe("dev@example.com");
    expect(cred.projectId).toBe("cca-proj-42");
    expect(calls[1]!.headers.get("user-agent")).toContain("antigravity/ide/");

    const modelFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n',
        ),
      );
    const source = tokenSource({
      load: async () => cred,
      save: async () => {},
      refresh: async (c) => c,
    });
    const provider = withToken(source, (auth) =>
      createPresetProvider("antigravity", { ...auth, fetchImpl: modelFetch }),
    );
    for await (const _ of provider.createStream([{ role: "user", content: "hi" }], [])) void _;
    const sentBody = JSON.parse(String(modelFetch.mock.calls[0]?.[1]?.body));
    expect(sentBody.project).toBe("cca-proj-42");
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

  it("renews a refused token before it expires, and only the token that was refused", async () => {
    const s = store(fresh);
    const renewed: Credential = { ...fresh, accessToken: "newer", refreshToken: "r3" };
    const refresh = vi.fn(async () => renewed);
    const source = tokenSource({ ...s, refresh });
    // Refused on a token the store has already moved past: nothing to renew.
    expect(await source.getToken({ rejected: "old" })).toBe(fresh);
    expect(refresh).not.toHaveBeenCalled();
    expect(await source.getToken({ rejected: "new" })).toBe(renewed);
    expect(refresh).toHaveBeenCalledWith(fresh);
    expect(s.save).toHaveBeenCalledWith(renewed);
  });

  it("never spends a refresh token twice when a read races a refresh that just saved", async () => {
    const s = store(fresh);
    const slowRead = Promise.withResolvers<void>();
    let reads = 0;
    const load = vi.fn(async () => {
      const seen = await s.load();
      if (++reads === 1) await slowRead.promise; // this caller read "new", then stalls
      return seen;
    });
    const renewed: Credential = { ...fresh, accessToken: "newer", refreshToken: "r3" };
    const refresh = vi.fn(async () => renewed);
    const source = tokenSource({ load, save: s.save, refresh });

    const late = source.getToken({ rejected: "new" });
    expect(await source.getToken({ rejected: "new" })).toBe(renewed);
    slowRead.resolve(); // its read is stale now, and the refresh it joined is gone
    expect(await late).toBe(renewed);
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("gives up on a token POST that never answers, and keeps the stored credential", async () => {
    // Real timers: the deadline is the platform's own AbortSignal.timeout.
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const s = store(stale);
    const flow = createAuthFlow("kimi-plan", hostWith(hang, { timeoutMs: 20 }));
    const error = await tokenSource({ ...s, refresh: flow.refresh })
      .getToken()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(s.save).not.toHaveBeenCalled();
    expect(await s.load()).toBe(stale);
  });
});

describe("withToken", () => {
  const T1: Credential = {
    accessToken: "T1",
    refreshToken: "r1",
    expiresAt: Date.now() + 3_600_000,
  };
  const T2: Credential = { ...T1, accessToken: "T2", refreshToken: "r2" };
  const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

  function signedIn(initial: Credential, renew: () => Promise<Credential>) {
    let stored = initial;
    const save = vi.fn(async (credential: Credential) => {
      stored = credential;
    });
    const refresh = vi.fn(renew);
    return { source: tokenSource({ load: async () => stored, save, refresh }), save, refresh };
  }

  const unauthorized = () => new ProviderError("fake", "auth", "fake 401", { status: 401 });

  /** Refuses T1 with a 401, and answers with the token it was built with. */
  function fake(auth: TokenAuth): Provider {
    return {
      id: "fake",
      model: "m",
      async *createStream() {
        if (auth.apiKey === "T1") throw unauthorized();
        yield { type: "delta", content: auth.apiKey };
      },
    };
  }

  async function text(stream: AsyncIterable<ProviderChunk>): Promise<string> {
    let out = "";
    for await (const chunk of stream) out += chunk.content ?? "";
    return out;
  }

  it("renews once for five calls refused on one token, replays all five, and benches nothing", async () => {
    // The refresh outlasts the five 401s, so every call is waiting on it at once.
    const { source, refresh } = signedIn(T1, () => new Promise((r) => setTimeout(r, 10, T2)));
    const built: string[] = [];
    const pool = withFallbackProviders([
      withToken(source, (auth) => {
        built.push(auth.apiKey);
        return fake(auth);
      }),
    ]);

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => text(pool.createStream(hi, []))),
    );
    expect(answers).toEqual(["T2", "T2", "T2", "T2", "T2"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(built.filter((key) => key === "T1")).toHaveLength(5);
    expect(built.filter((key) => key === "T2")).toHaveLength(5);
    const [entry] = pool.fallbacks.status();
    expect(entry?.retryAtMs).toBe(0);
    expect(entry?.kind).toBeUndefined();
  });

  it("never replays a 401 that lands after output", async () => {
    const { source, refresh } = signedIn(T1, async () => T2);
    const provider = withToken(source, () => ({
      id: "fake",
      model: "m",
      async *createStream() {
        yield { type: "delta", content: "partial" };
        throw unauthorized();
      },
    }));
    const seen: ProviderChunk[] = [];
    const error = await (async () => {
      for await (const chunk of provider.createStream(hi, [])) seen.push(chunk);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ type: "delta", content: "partial" }]);
    expect(error).toMatchObject({ status: 401 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends the account header on each attempt, and lets a second 401 through as auth", async () => {
    const { source, refresh } = signedIn({ ...T1, chatgptAccountId: "acct_1" }, async () => ({
      ...T2,
      chatgptAccountId: "acct_2",
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    const provider = withToken(source, (auth) =>
      createPresetProvider("chatgpt", { ...auth, fetchImpl }),
    );

    const error = await text(provider.createStream(hi, [])).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "auth", status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    const sent = fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent.map((h) => [h.get("authorization"), h.get("chatgpt-account-id")])).toEqual([
      ["Bearer T1", "acct_1"],
      ["Bearer T2", "acct_2"],
    ]);
  });

  it("posts to the host the credential names and replays there on the renewed token", async () => {
    const host = "https://api.business.githubcopilot.com";
    const { source } = signedIn({ ...T1, baseUrl: host }, async () => ({ ...T2, baseUrl: host }));
    const sse = [
      '{"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]
      .map((payload) => `data: ${payload}\n\n`)
      .join("");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer T1"
          ? new Response("Unauthorized", { status: 401 })
          : new Response(sse),
      );
    const provider = withToken(source, (auth) =>
      createPresetProvider("github-copilot", { ...auth, fetchImpl }),
    );

    expect(await text(provider.createStream(hi, []))).toBe("hi");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${host}/chat/completions`,
      `${host}/chat/completions`,
    ]);
  });

  it("lets a caller stop while a refresh is out, and the refresh still lands and saves", async () => {
    const renewal = Promise.withResolvers<Credential>();
    const { source, refresh, save } = signedIn(T1, () => renewal.promise);
    const provider = withToken(source, fake);

    const stop = new AbortController();
    const stopped = text(provider.createStream(hi, [], { signal: stop.signal })).catch(
      (e: unknown) => e,
    );
    const patient = text(provider.createStream(hi, []));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    stop.abort();
    // Rejected while the refresh is still out: the caller did not wait for it.
    expect(await stopped).toMatchObject({ name: "AbortError" });

    renewal.resolve(T2);
    expect(await patient).toBe("T2");
    expect(save).toHaveBeenCalledWith(T2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
