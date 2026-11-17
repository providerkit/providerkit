// Target/token policy adapted from Mastra (Apache-2.0, Kepler Software, Inc.).
// Timestamped HMAC design adapted from CrewAI (MIT, Copyright (c) 2025 crewAI, Inc.).
import type { FetchLike } from "@providerkit/core";
import { untilAbort } from "../tree.ts";
import { checkA2AEndpoint } from "./policy.ts";
import { equalData } from "../snapshot.ts";
import { hashA2AJson } from "./signing.ts";
import {
  A2ATaskConflict,
  type A2ATaskScope,
  type A2ATaskStore,
  type A2APushAttempt,
} from "./tasks.ts";
import {
  A2AError,
  encodeA2AEvent,
  parseA2AJson,
  type A2APushConfig,
  type A2AEvent,
} from "./wire.ts";

export interface A2APushPolicy {
  /** Rechecked before every delivery. Must enforce current task access, not just the URL. */
  authorize(scope: A2ATaskScope, taskId: string): boolean | Promise<boolean>;
  /** Rechecked before every delivery. DNS/address pinning belongs to this hook's egress proxy
   * or fetch implementation; portable literal checks alone cannot prove DNS safety. */
  allow(url: URL, scope: A2ATaskScope): boolean | Promise<boolean>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Optional providerkit extension, not an A2A standard signature header. */
  signingSecret?: string;
}
const encoder = new TextEncoder();
async function hmacKey(secret: string) {
  if (!secret) throw new A2AError("invalid");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signA2APush(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<{ signature: string; timestamp: string }> {
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${timestamp}.${body}`)),
  );
  return {
    signature: `sha256=${[...bytes].map((n) => n.toString(16).padStart(2, "0")).join("")}`,
    timestamp: String(timestamp),
  };
}
/** Host must also dedupe notification identities. Timestamp tolerance alone is not replay storage. */
export async function verifyA2APush(
  body: string,
  headers: Headers,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const timestamp = headers.get("X-A2A-Timestamp");
  const signature = headers.get("X-A2A-Signature");
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    Math.abs((options.now ?? Date.now()) / 1000 - Number(timestamp)) > tolerance
  )
    return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (pair) =>
    Number.parseInt(pair, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    bytes,
    encoder.encode(`${timestamp}.${body}`),
  );
}

export async function checkA2APushConfig(
  config: A2APushConfig,
  scope: A2ATaskScope,
  policy: A2APushPolicy,
): Promise<void> {
  if (config.tenant !== undefined && config.tenant !== scope.tenant) throw new A2AError("invalid");
  if (
    config.authentication &&
    (config.authentication.schemes.length !== 1 ||
      config.authentication.schemes[0]?.toLowerCase() !== "bearer" ||
      !config.authentication.credentials ||
      !/^[A-Za-z0-9\-._~+/]+=*$/.test(config.authentication.credentials))
  )
    throw new A2AError("protocol", { code: -32004 });
  if (config.token && /[^\x20-\x7e]/.test(config.token)) throw new A2AError("invalid");
  await checkA2AEndpoint(config.url, "push", {
    allow: (url) => policy.allow(url, structuredClone(scope)),
  });
}

/** One attempt per immutable public update/config pair. A timeout, 5xx or lost reply stays
 * unknown. There is no timer retry or token-renewal resend. Reconcile in the host, never replay. */
export async function deliverA2APush(options: {
  tasks: A2ATaskStore;
  scope: A2ATaskScope;
  taskId: string;
  event: A2AEvent;
  policy: A2APushPolicy;
}): Promise<A2APushAttempt[]> {
  const { tasks, scope, taskId, policy } = options;
  const timeout = policy.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new A2AError("invalid");
  let task = await tasks.get(scope, taskId);
  if (!task) throw new A2AError("protocol", { code: -32001 });
  const event = structuredClone(options.event);
  if (
    (event.kind === "task" ? event.id : event.taskId) !== task.id ||
    event.contextId !== task.contextId
  )
    throw new A2AError("invalid");
  const outcomes: A2APushAttempt[] = [];
  for (const configured of task.push) {
    const config = configured.config;
    if (!config.id) throw new A2AError("invalid");
    const body = JSON.stringify(encodeA2AEvent(event, configured.dialect));
    const id = await hashA2AJson({
      body,
      config: parseA2AJson(JSON.stringify(config)),
      dialect: { ...configured.dialect },
    });
    let reservation: A2APushAttempt | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      task = await tasks.get(scope, taskId);
      if (!task) throw new A2AError("protocol", { code: -32001 });
      const previous = task.deliveries.find((delivery) => delivery.id === id);
      if (previous) {
        outcomes.push(previous);
        break;
      }
      // A deleted/replaced callback loses permission immediately. Never use a stale credential.
      if (!task.push.some((entry) => equalData(entry, configured))) break;
      reservation = {
        id,
        configId: config.id,
        revision: task.revision,
        at: Date.now(),
        outcome: "pending",
      };
      try {
        await tasks.update(
          scope,
          taskId,
          { deliveries: [...task.deliveries, reservation] },
          task.revision,
        );
        break;
      } catch (error) {
        reservation = undefined;
        if (!(error instanceof A2ATaskConflict) || attempt === 3) throw error;
      }
    }
    if (!reservation) continue;
    let outcome: A2APushAttempt["outcome"] = "refused";
    let sent = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (
        !(await untilAbort(
          Promise.resolve(policy.authorize(structuredClone(scope), taskId)),
          controller.signal,
        ))
      )
        throw new A2AError("endpoint");
      await untilAbort(checkA2APushConfig(config, scope, policy), controller.signal);
      const headers = new Headers({
        "content-type": "application/a2a+json",
        "A2A-Version": configured.dialect.version,
      });
      if (config.authentication?.credentials)
        headers.set("authorization", `Bearer ${config.authentication.credentials}`);
      if (config.token) headers.set("X-A2A-Notification-Token", config.token);
      if (policy.signingSecret) {
        const signed = await signA2APush(body, policy.signingSecret);
        headers.set("X-A2A-Timestamp", signed.timestamp);
        headers.set("X-A2A-Signature", signed.signature);
      }
      if (
        !(await untilAbort(
          Promise.resolve(policy.authorize(structuredClone(scope), taskId)),
          controller.signal,
        ))
      )
        throw new A2AError("endpoint");
      // Finish every async policy before the final callback check. A revoked callback must
      // not receive either the task or its old credential while authorization is waiting.
      const current = await tasks.get(scope, taskId);
      if (!current?.push.some((p) => equalData(p, configured))) throw new A2AError("endpoint");
      controller.signal.throwIfAborted();
      sent = true;
      const pending = (policy.fetch ?? globalThis.fetch)(config.url, {
        method: "POST",
        body,
        headers,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      // A non-cooperative host fetch may finish late. Always release its body, but never send again.
      void pending.then(
        (response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await untilAbort(pending, controller.signal);
      void response.body?.cancel().catch(() => {});
      outcome = response.ok && !response.redirected ? "delivered" : "unknown";
    } catch {
      outcome = sent ? "unknown" : "refused";
    } finally {
      clearTimeout(timer);
    }
    const settled = { ...reservation, outcome };
    // Failure to record completion leaves pending, which also forbids replay.
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await tasks.get(scope, taskId);
      if (!current) break;
      try {
        await tasks.update(
          scope,
          taskId,
          { deliveries: current.deliveries.map((d) => (d.id === id ? settled : d)) },
          current.revision,
        );
        break;
      } catch (error) {
        if (!(error instanceof A2ATaskConflict) || attempt === 3) throw error;
      }
    }
    outcomes.push(settled);
  }
  return outcomes;
}
