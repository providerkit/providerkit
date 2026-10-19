// A provider that signs every call with the stored sign-in, and renews the token
// once when a server refuses it before it expired. The sibling of
// `withKeyPool`: that one rotates between keys, this one renews the one token.
//
// Type-only imports from the sign-in side, so core's root can export this
// without pulling the flows in.
import { ProviderError } from "../errors.ts";
import type { PresetProviderConfig } from "../providers/factory.ts";
import type { Provider } from "../types.ts";
import type { Credential } from "./oauth.ts";
import type { TokenSource } from "./token-source.ts";

/** The credential half of `PresetProviderConfig`, so `build` can spread it in. */
export type TokenAuth = Pick<PresetProviderConfig, "apiKey" | "baseUrl" | "headers">;

/**
 * Give any provider the signed-in user's token, read fresh on every call.
 *
 * ```ts
 * const provider = withToken(token, (auth) => createPresetProvider("github-copilot", auth));
 * ```
 *
 * `build` runs once per attempt and must do no I/O, like `withKeyPool`'s
 * factory. It gets the access token as `apiKey`, the credential's own host as
 * `baseUrl` (Copilot gives each plan its own) and its `ChatGPT-Account-Id`
 * header, which the Codex backend refuses the request without. To add headers
 * of your own, merge them with `auth.headers` rather than replacing them.
 *
 * A 401 before any output renews the token and replays the call once: a token
 * can be refused before its expiry, and without this the caller sees an auth
 * failure that a fallback pool benches for an hour. A second 401 is a real one
 * and surfaces. A 401 after output never replays (invariant 1).
 *
 * Only 401 counts. A 400 or 403 on a model call is a bad request or a plan
 * that lacks the model, and a new token fixes neither.
 */
export function withToken<C extends Credential>(
  source: TokenSource<C>,
  build: (auth: TokenAuth) => Provider,
): Provider {
  // Building does no I/O, so a throwaway instance reads `id` and `model`
  // without a token.
  const identity = build({ apiKey: "" });

  return {
    id: identity.id,
    model: identity.model,

    async *createStream(messages, tools, opts = {}) {
      const credential = await unlessAborted(source.getToken(), opts.signal);
      let emitted = false;
      try {
        for await (const chunk of build(authOf(credential)).createStream(messages, tools, opts)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (emitted || !(error instanceof ProviderError) || error.status !== 401) throw error;
      }
      const renewed = await unlessAborted(
        source.getToken({ rejected: credential.accessToken }),
        opts.signal,
      );
      yield* build(authOf(renewed)).createStream(messages, tools, opts);
    },
  };
}

function authOf(credential: Credential): TokenAuth {
  return {
    apiKey: credential.accessToken,
    ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    ...(credential.chatgptAccountId
      ? { headers: { "ChatGPT-Account-Id": credential.chatgptAccountId } }
      : {}),
  };
}

/**
 * Wait for the token, or reject with the caller's abort, whichever is first.
 *
 * The refresh itself is never aborted. It is shared by every caller, and once
 * its POST is out the server may already have rotated the refresh token, so
 * abandoning it before the save loses the only copy of the new one. And
 * without the race an unanswered refresh would outlive the watchdog, which
 * aborts the signal but never races a read.
 */
function unlessAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
