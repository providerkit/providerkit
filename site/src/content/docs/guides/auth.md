---
title: Sign in to a subscription
description: Sign a person in to ChatGPT, Kimi, Grok, GitHub Copilot, Meta or OpenRouter, and keep their token fresh, without a vendor SDK.
---

A subscription backend takes a short-lived token, not an API key. `@providerkit/core/auth` gets
that token and renews it. It uses only `fetch`, so it runs in a browser extension, a worker or a
server.

Once you have signed a person in, getting a token is one call:

```ts
const { accessToken } = await token.getToken(); // a token that works now
```

`token` comes from `tokenSource`, below. If the stored token has expired, this call renews it first.

To sign in the first time, your app supplies the two things a package can't do: opening a browser
page and catching a redirect. It also decides where tokens are stored.

```ts
import { createAuthFlow, tokenSource, type AuthHost } from "@providerkit/core/auth";
import { createPresetProvider } from "@providerkit/core";

const host: AuthHost = {
  appName: "MyApp/1.0", // sent to Copilot and xAI to say who is signing in
  openUrl: (url) => openInBrowser(url),
  captureRedirect: ({ authorizeUrl, redirectUri, state, signal }) =>
    openAndWaitForCode(authorizeUrl, redirectUri, state, signal), // resolves to the `code`
};

const flow = createAuthFlow("github-copilot", host);

// Once: show the code, wait for the user to approve it, keep the result.
const credential = await flow.signIn(signal, ({ url, userCode }) => showCode(userCode, url));
await save(credential);

// Every call: a token that works now.
const token = tokenSource({ load, save, refresh: flow.refresh });
const { accessToken, baseUrl } = await token.getToken();
const provider = createPresetProvider("github-copilot", { apiKey: accessToken, baseUrl });
```

`createAuthFlow` takes `chatgpt`, `kimi-plan`, `grok`, `github-copilot`, `meta` or `openrouter`.
ChatGPT and OpenRouter send the user through a redirect, so they call your `captureRedirect`. The
others show a code and call your `openUrl` with the approval page.

## What `getToken` does

- Two calls at the same moment refresh once, and the new token is saved before anyone uses it.
- If the server rejects the refresh, it reloads what is stored. When another tab or process saved
  a newer token in the meantime, it uses that one. Otherwise it throws.
- A network failure keeps the credential and rethrows the network error. The user is not told to
  sign in again because their wifi dropped.

Read the stored credential in `load` every time. These tokens rotate when they are used, and a
copy you kept in memory may hold one that is already spent.

One case is not covered: two contexts that both lose a refresh before either saves. Closing it
needs a lock on your storage.

## Errors

A sign-in that ends without a credential throws `SignInError` with a `reason` of `denied`,
`expired` or `cancelled`. The rest are `ProviderError`s with a `code`:

| Code                      | What happened                                                    |
| ------------------------- | ---------------------------------------------------------------- |
| `token_refused`           | The sign-in server said no. `status` and `body` say why.         |
| `token_incomplete`        | Its reply had no token or no expiry.                             |
| `device_response_invalid` | Its reply had no code, or no http(s) approval page.              |
| `setup_required`          | Meta account without Muse set up. The message has the link.      |
| `refresh_dead`            | The refresh was rejected, or nobody is signed in. Sign in again. |

Show your own text for each code. The package's messages are English and meant for logs.

## GitHub Copilot

Copilot's device sign-in ends in a GitHub token that the Copilot API doesn't take. The flow trades
it for a Copilot token that lasts about 25 minutes. Trading again is the refresh, so
`getToken` handles it. The credential also carries `baseUrl`, because each plan has its own host.
Pass it to the preset, as above.

The preset sends `X-Initiator: user` when the last message is the user's and `agent` after a tool
result. GitHub bills one premium request per `user` turn, so this decides what the run costs. To
name your app in `Editor-Version`, pass `headers: copilotHeaders("MyApp/1.0", "user")` too.
GitHub Enterprise Server isn't supported: its endpoints live on the tenant's own domain.
