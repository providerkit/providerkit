// Endpoint checks adapted from google-adk-js core/src/a2a/agent_card.ts.
// Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0
// No DNS lookup or address pinning: those remain the host's responsibility.
import {
  A2AError,
  type A2AAgentCard,
  type A2ABinding,
  type A2AInterface,
  type A2AVersion,
} from "./wire.ts";

export type A2AEndpointUse = "card" | "rpc" | "push";
export interface A2AEndpointPolicy {
  /** Host configuration, never peer/model input. Check resolved addresses in an egress proxy or pinned fetch. */
  allow: (url: URL, use: A2AEndpointUse) => boolean | Promise<boolean>;
  allowInsecure?: boolean;
  allowCrossOrigin?: boolean;
}

function ipv6(host: string): number[] | undefined {
  if (!host.startsWith("[")) return undefined;
  const halves = host.slice(1, -1).split("::");
  const left = halves[0] ? halves[0].split(":").map((n) => Number.parseInt(n, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((n) => Number.parseInt(n, 16)) : [];
  return halves.length === 1
    ? left
    : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}
function address(host: string): { loopback: boolean; private: boolean; forbidden: boolean } {
  host = host.toLowerCase().replace(/\.$/, "");
  const v6 = ipv6(host);
  let v4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").map(Number) : undefined;
  if (v6?.slice(0, 5).every((n) => n === 0) && v6[5] === 0xffff)
    v4 = [v6[6]! >>> 8, v6[6]! & 255, v6[7]! >>> 8, v6[7]! & 255];
  if (v4) {
    const [a, b] = v4;
    return {
      loopback: a === 127,
      private:
        a === 10 ||
        (a === 172 && b! >= 16 && b! <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b! >= 64 && b! <= 127),
      forbidden:
        a === 0 || (a === 169 && b === 254) || a! >= 224 || v4.join(".") === "100.100.100.200",
    };
  }
  if (v6) {
    const local = v6.slice(0, 7).every((n) => n === 0);
    return {
      loopback: local && v6[7] === 1,
      private: (v6[0]! & 0xfe00) === 0xfc00,
      forbidden:
        (v6[0]! & 0xffc0) === 0xfe80 || (v6[0]! & 0xff00) === 0xff00 || (local && v6[7] === 0),
    };
  }
  return {
    loopback: host === "localhost" || host.endsWith(".localhost"),
    private: false,
    forbidden: host === "metadata.google.internal" || host === "metadata.goog",
  };
}
function endpoint(value: string): URL {
  try {
    if (value.length > 2048) throw new Error();
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      address(url.hostname).forbidden
    )
      throw new Error();
    return url;
  } catch {
    throw new A2AError("endpoint");
  }
}
function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.origin === b.origin ||
    (address(a.hostname).loopback &&
      address(b.hostname).loopback &&
      a.protocol === b.protocol &&
      a.port === b.port)
  );
}

/** Literal checks are not a claim about DNS safety. Every destination also needs the host's allow hook. */
export async function checkA2AEndpoint(
  value: string,
  use: A2AEndpointUse,
  policy: A2AEndpointPolicy,
  cardUrl?: string,
): Promise<URL> {
  const url = endpoint(value);
  const host = address(url.hostname);
  if (url.protocol !== "https:" && !host.loopback && !policy?.allowInsecure)
    throw new A2AError("endpoint");
  if (use === "push" && (host.private || host.loopback)) throw new A2AError("endpoint");
  if (use === "rpc" && cardUrl && !policy.allowCrossOrigin && !sameOrigin(endpoint(cardUrl), url))
    throw new A2AError("endpoint");
  let allowed = false;
  try {
    allowed = (await policy?.allow(new URL(url.href), use)) === true;
  } catch {
    /* A policy exception may contain secrets. */
  }
  if (!allowed) throw new A2AError("endpoint");
  return url;
}

export function a2aCardUrl(source: string): string {
  const url = endpoint(source);
  if (!url.pathname.endsWith("/agent-card.json"))
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/.well-known/agent-card.json`;
  return url.href;
}

export async function checkA2ACardEndpoints(
  card: A2AAgentCard,
  source: string,
  policy: A2AEndpointPolicy,
): Promise<void> {
  for (const entry of card.interfaces) await checkA2AEndpoint(entry.url, "rpc", policy, source);
}

/** No auto negotiation or fallback: a rejected mutation must not move to another interface. */
export function selectA2AInterface(
  card: A2AAgentCard,
  version: A2AVersion,
  binding: A2ABinding,
  extensions: readonly string[] = [],
): A2AInterface {
  for (const extension of card.capabilities.extensions ?? []) {
    if (extension.required && !extensions.includes(extension.uri))
      throw new A2AError("protocol", { code: -32008 });
  }
  const found = card.interfaces.find(
    (entry) =>
      entry.binding === binding &&
      (entry.version === version ||
        new RegExp(`^${version.replace(".", "\\.")}\\.\\d+$`).test(entry.version)),
  );
  if (!found) throw new A2AError("protocol", { code: -32009 });
  return { ...found };
}
