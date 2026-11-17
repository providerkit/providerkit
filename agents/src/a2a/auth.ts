// Bearer authentication policy adapted from google-adk-js core/src/a2a/auth.ts.
// Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0
import { A2AError } from "./wire.ts";

export interface A2APrincipal {
  owner: string;
  actorId: string;
}
export type A2AAuthenticate = (
  request: Request,
) => A2APrincipal | null | Promise<A2APrincipal | null>;

/** A host-owned secret maps to a host-owned principal, never to a card or message claim. */
export function bearerToken(secret: string, principal: A2APrincipal): A2AAuthenticate {
  if (
    !/^[A-Za-z0-9\-._~+/]+=*$/.test(secret) ||
    secret.length > 8192 ||
    !principal.owner ||
    !principal.actorId
  )
    throw new A2AError("invalid");
  const identity = { owner: principal.owner, actorId: principal.actorId };
  const encoder = new TextEncoder();
  // WebCrypto verifies a fixed-length MAC; no JavaScript string comparison of the secret.
  const key = crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const expected = key.then((k) => crypto.subtle.sign("HMAC", k, encoder.encode(secret)));
  return async (request) => {
    const header = request.headers.get("authorization");
    const token = header && /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header)?.[1];
    if (!token || token.length > 8192) return null;
    try {
      return (await crypto.subtle.verify("HMAC", await key, await expected, encoder.encode(token)))
        ? { ...identity }
        : null;
    } catch {
      return null;
    }
  };
}

/** Server integrations use this before any task lookup. Missing authentication refuses access. */
export async function authenticateA2A(
  request: Request,
  authenticate?: A2AAuthenticate,
): Promise<A2APrincipal | null> {
  if (!authenticate) return null;
  try {
    const principal = await authenticate(request);
    return principal &&
      typeof principal.owner === "string" &&
      principal.owner.length > 0 &&
      typeof principal.actorId === "string" &&
      principal.actorId.length > 0
      ? { owner: principal.owner, actorId: principal.actorId }
      : null;
  } catch {
    return null;
  }
}
