// One place that hands out a token that works: refreshes it once however many
// callers ask, saves the new pair before anyone uses it, and recovers when a
// second tab or process spent the refresh token first.
import { isTransportFailure, ProviderError } from "../errors.ts";
import { authError, type Credential } from "./oauth.ts";

export interface TokenSourceOptions<C extends Credential = Credential> {
  /** Read the stored credential. Read it on every call, never cache it: the
   *  refresh token rotates, and a cached copy would spend one already used. */
  load(): Promise<C | undefined>;
  /** Persist a refreshed credential. Awaited before the new token is used. */
  save(credential: C): Promise<void>;
  /** Trade the credential for a fresh one: `createAuthFlow(id, host).refresh`. */
  refresh(credential: C): Promise<C>;
}

export interface TokenSource<C extends Credential = Credential> {
  /** A credential whose `accessToken` is good now. Throws a `ProviderError`
   *  coded `refresh_dead` when the user must sign in again.
   *
   *  Pass `rejected`, the access token a server just answered 401 to, to renew
   *  it even though it has not expired. A server can refuse a token early: it
   *  was revoked, or another client rotated it. */
  getToken(opts?: { rejected?: string }): Promise<C>;
}

/**
 * Refresh when the stored credential has expired or was rejected, and only then.
 *
 * - Concurrent calls share one refresh and the result is saved before use.
 * - When the server rejects the refresh, the stored credential is reloaded. If
 *   another context saved a newer one meanwhile, that one is used. Otherwise
 *   the session is dead and the error says so.
 * - A network failure keeps the credential and rethrows, so a user on bad wifi
 *   isn't told to sign in again.
 *
 * ponytail: two contexts can both lose a refresh before either one saves, and
 * then both fail. Closing that needs a lock on the storage.
 */
export function tokenSource<C extends Credential>(options: TokenSourceOptions<C>): TokenSource<C> {
  let inFlight: Promise<C> | undefined;

  async function loadSignedIn(): Promise<C> {
    const credential = await options.load();
    if (!credential) throw authError("refresh_dead", "Not signed in. Sign in first.");
    return credential;
  }

  async function refreshStored(rejected: string | undefined): Promise<C> {
    // Read again inside the single flight. A caller whose read raced a refresh
    // that had just saved would otherwise start a second one with the refresh
    // token the first already spent. Five calls refused on one token is the
    // normal case for that race, and a server that rotates refresh tokens may
    // take a reused one as stolen and end the whole sign-in.
    const stale = await loadSignedIn();
    if (isUsable(stale, rejected)) return stale;
    try {
      const fresh = await options.refresh(stale);
      await options.save(fresh);
      return fresh;
    } catch (error) {
      if (!isRejected(error)) throw error;
      const stored = await options.load();
      if (stored && isNewer(stored, stale) && Date.now() < stored.expiresAt) return stored;
      throw authError("refresh_dead", "The sign-in expired and can't be renewed. Sign in again.");
    }
  }

  return {
    async getToken({ rejected } = {}) {
      const credential = await loadSignedIn();
      if (isUsable(credential, rejected)) return credential;
      inFlight ??= refreshStored(rejected).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/** Unexpired, and not the token a server just refused. */
function isUsable(credential: Credential, rejected: string | undefined): boolean {
  return Date.now() < credential.expiresAt && credential.accessToken !== rejected;
}

/** A refresh the server turned down for good, as opposed to one that never
 *  reached it or came back unreadable. */
function isRejected(error: unknown): error is ProviderError {
  if (isTransportFailure(error) || !(error instanceof ProviderError)) return false;
  return error.status === 400 || error.status === 401 || error.status === 403;
}

function isNewer(stored: Credential, stale: Credential): boolean {
  return stored.refreshToken !== stale.refreshToken || stored.expiresAt > stale.expiresAt;
}
