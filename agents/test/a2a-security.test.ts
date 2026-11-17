import { describe, expect, it, vi } from "vitest";
import {
  AgentCard,
  canonicalizeAgentCard,
  generateAgentCardSignature,
  verifyAgentCardSignature,
} from "@a2a-js/sdk";
import {
  canonicalA2ACard,
  canonicalA2AJson,
  signAgentCard,
  verifyAgentCard,
} from "../src/a2a/signing.ts";
import { checkA2APushConfig, deliverA2APush, signA2APush, verifyA2APush } from "../src/a2a/push.ts";
import { createMemoryTaskStore, type A2ATaskRecord } from "../src/a2a/tasks.ts";
import { decodeA2AAgentCard, type A2AAgentCard, type A2AObject } from "../src/a2a/wire.ts";

function card(version: "1.0" | "0.3" = "1.0", extra: A2AObject = {}): A2AAgentCard {
  return decodeA2AAgentCard(
    {
      name: "Signed agent",
      description: "Echoes public input.",
      version: "1",
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      capabilities: { streaming: true, pushNotifications: false, extensions: [] },
      ...(version === "1.0"
        ? {
            supportedInterfaces: [
              {
                url: "https://agent.test/jsonrpc",
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
          }
        : { url: "https://agent.test/jsonrpc", protocolVersion: "0.3.0" }),
      ...extra,
    },
    version,
  );
}
async function ec() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

describe("A2A card signatures", () => {
  it("uses canonical JSON without silently replacing malformed Unicode", () => {
    expect(canonicalA2AJson({ z: -0, a: [1e30, "x\n"] })).toBe('{"a":[1e+30,"x\\n"],"z":0}');
    expect(() => canonicalA2AJson("\ud800")).toThrow();
    expect(() => canonicalA2AJson(Number.NaN)).toThrow();
  });
  it("matches SDK 1.0 normalization including security schemes and extension defaults", () => {
    const source = card("1.0", {
      unknown: "unsigned",
      documentationUrl: "",
      capabilities: {
        streaming: false,
        extendedAgentCard: false,
        extensions: [
          {
            uri: "https://ext.test",
            required: false,
            description: "",
            params: { empty: "", nil: null, list: ["", "kept"], disabled: false },
          },
        ],
      },
      provider: { organization: "Host", url: "https://host.test" },
      securitySchemes: {
        key: {
          apiKeySecurityScheme: {
            description: "",
            location: "header",
            name: "X-Key",
            unknown: true,
          },
        },
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
        oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: "https://auth.test" } },
        mtls: { mtlsSecurityScheme: { description: "Client certificate" } },
        oauth: {
          oauth2SecurityScheme: {
            oauth2MetadataUrl: "https://auth.test/metadata",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.test/login",
                tokenUrl: "https://auth.test/token",
                pkceRequired: false,
                scopes: { read: "Read", empty: "" },
              },
            },
          },
        },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] }, oauth: { list: ["read"] } } }],
      skills: [
        {
          id: "echo",
          name: "Echo",
          description: "Echoes text.",
          tags: ["text"],
          securityRequirements: [{ schemes: { oauth: { list: ["read"] } } }],
        },
      ],
    });
    // SDK's signature function reads wire JSON internally despite declaring its protobuf type.
    // A typed oneof passed through fromJSON twice loses security schemes. Only this test casts.
    expect(canonicalA2ACard(source)).toBe(
      canonicalizeAgentCard(source.document as unknown as AgentCard),
    );
  });
  it("signs and verifies in both directions against official SDK 1.3.0", async () => {
    const keys = await ec();
    const source = card();
    const signed = await signAgentCard(source, { key: keys.privateKey, kid: "host", alg: "ES256" });
    const verifier = verifyAgentCardSignature(async (kid) => {
      expect(kid).toBe("host");
      return keys.publicKey;
    });
    await expect(verifier(AgentCard.fromJSON(signed.document))).resolves.toBeUndefined();
    // Same raw-wire contract mismatch as above; no production assertion is needed.
    const official = await generateAgentCardSignature(keys.privateKey, {
      alg: "ES256",
      kid: "host",
      typ: "JOSE",
    })(source.document as unknown as AgentCard);
    expect(
      await verifyAgentCard(decodeA2AAgentCard(JSON.parse(JSON.stringify(official)), "1.0"), {
        host: keys.publicKey,
      }),
    ).toBe(true);
    expect(source.document.signatures).toBeUndefined();
  });
  it("requires a pinned matching key and refuses tampered signed fields", async () => {
    const keys = await ec();
    const other = await ec();
    const signed = await signAgentCard(card(), { key: keys.privateKey, kid: "host", alg: "ES256" });
    expect(await verifyAgentCard(signed, {})).toBe(false);
    expect(await verifyAgentCard(signed, { host: other.publicKey })).toBe(false);
    const changed = structuredClone(signed);
    changed.document.name = "Attacker";
    expect(await verifyAgentCard(changed, { host: keys.publicKey })).toBe(false);
    await expect(
      signAgentCard(card(), { key: keys.privateKey, kid: "host", alg: "RS256" }),
    ).rejects.toThrow();
  });
  it("keeps version-specific coverage explicit", async () => {
    const keys = await ec();
    const legacy = await signAgentCard(card("0.3", { unknown: "covered" }), {
      key: keys.privateKey,
      kid: "host",
      alg: "ES256",
    });
    expect(await verifyAgentCard(legacy, { host: keys.publicKey })).toBe(true);
    legacy.document.unknown = "changed";
    expect(await verifyAgentCard(legacy, { host: keys.publicKey })).toBe(false);
    const modern = await signAgentCard(card(), { key: keys.privateKey, kid: "host", alg: "ES256" });
    modern.document.unknown = "not authenticated by the 1.0 schema";
    expect(await verifyAgentCard(modern, { host: keys.publicKey })).toBe(true);
  });
  it.each(["EdDSA", "RS256"] as const)("supports %s with WebCrypto", async (alg) => {
    const keys =
      alg === "EdDSA"
        ? await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
        : await crypto.subtle.generateKey(
            {
              name: "RSASSA-PKCS1-v1_5",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["sign", "verify"],
          );
    if (!("privateKey" in keys)) throw new Error("Expected key pair");
    const signed = await signAgentCard(card(), { key: keys.privateKey, kid: "host", alg });
    expect(await verifyAgentCard(signed, { host: keys.publicKey })).toBe(true);
  });
});

const scope = { owner: "team", actorId: "alice", tenant: "one" };
async function taskWithPush() {
  const tasks = createMemoryTaskStore();
  const record: A2ATaskRecord = {
    ...scope,
    id: "task",
    contextId: "context",
    hops: 0,
    state: "completed",
    messages: [{ id: "message", fingerprint: "same", kind: "start", acceptance: "accepted" }],
    history: [],
    push: [
      {
        config: {
          taskId: "task",
          id: "callback",
          url: "https://callback.test/notify",
          token: "notification-token",
          authentication: { schemes: ["Bearer"], credentials: "host-approved-token" },
          tenant: "one",
        },
        dialect: { version: "1.0", binding: "HTTP+JSON" },
      },
    ],
    deliveries: [],
    createdAt: 1,
    updatedAt: 1,
    revision: "",
  };
  await tasks.create(record);
  return { tasks, record };
}
const event = {
  kind: "task" as const,
  id: "task",
  contextId: "context",
  status: { state: "completed" as const, timestamp: "2026-11-17T00:00:00Z" },
};
describe("opt-in push delivery", () => {
  it.each([
    "http://127.0.0.1/",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.169.254/",
    "https://[::ffff:127.0.0.1]/",
    "https://user:pass@callback.test/",
    "http://callback.test/",
  ])("refuses unsafe target %s before egress", async (url) => {
    const allow = vi.fn(() => true);
    await expect(
      checkA2APushConfig({ url }, scope, { authorize: () => true, allow }),
    ).rejects.toMatchObject({ kind: "endpoint" });
    expect(allow).not.toHaveBeenCalled();
  });
  it("requires host egress permission and rejects unsupported credential schemes", async () => {
    await expect(
      checkA2APushConfig({ url: "https://callback.test/" }, scope, {
        authorize: () => true,
        allow: () => false,
      }),
    ).rejects.toMatchObject({ kind: "endpoint" });
    await expect(
      checkA2APushConfig(
        {
          url: "https://callback.test/",
          authentication: { schemes: ["Basic"], credentials: "secret" },
        },
        scope,
        { authorize: () => true, allow: () => true },
      ),
    ).rejects.toMatchObject({ code: -32004 });
  });
  it("records one uncertain attempt without replay and keeps task time stable", async () => {
    const { tasks } = await taskWithPush();
    const send = vi.fn(async () => {
      throw new Error("Lost response with private token");
    });
    const policy = { authorize: () => true, allow: () => true, fetch: send };
    expect(
      (await deliverA2APush({ tasks, scope, taskId: "task", event, policy }))[0]?.outcome,
    ).toBe("unknown");
    expect(
      (await deliverA2APush({ tasks, scope, taskId: "task", event, policy }))[0]?.outcome,
    ).toBe("unknown");
    expect(send).toHaveBeenCalledOnce();
    expect((await tasks.get(scope, "task"))?.updatedAt).toBe(1);
    expect(JSON.stringify((await tasks.get(scope, "task"))?.deliveries)).not.toContain(
      "private token",
    );
    await expect(
      deliverA2APush({ tasks, scope: { ...scope, tenant: "two" }, taskId: "task", event, policy }),
    ).rejects.toMatchObject({ code: -32001 });
  });
  it("rechecks current authorization and config deletion before sending", async () => {
    const { tasks } = await taskWithPush();
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const denied = await deliverA2APush({
      tasks,
      scope,
      taskId: "task",
      event,
      policy: { authorize: () => false, allow: () => true, fetch: send },
    });
    expect(denied[0]?.outcome).toBe("refused");
    expect(send).not.toHaveBeenCalled();
    const second = await taskWithPush();
    const deleted = await deliverA2APush({
      tasks: second.tasks,
      scope,
      taskId: "task",
      event,
      policy: {
        authorize: () => true,
        allow: async () => {
          const record = (await second.tasks.get(scope, "task"))!;
          await second.tasks.update(scope, "task", { push: [] }, record.revision);
          return true;
        },
        fetch: send,
      },
    });
    expect(deleted[0]?.outcome).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses a callback deleted during the final authorization check", async () => {
    const { tasks } = await taskWithPush();
    const entered = Promise.withResolvers<void>();
    const authorized = Promise.withResolvers<boolean>();
    const authorize = vi.fn(() => Promise.resolve(true)).mockImplementationOnce(async () => true);
    authorize.mockImplementationOnce(() => {
      entered.resolve();
      return authorized.promise;
    });
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const delivery = deliverA2APush({
      tasks,
      scope,
      taskId: "task",
      event,
      policy: { authorize, allow: () => true, fetch: send },
    });
    await entered.promise;
    const current = (await tasks.get(scope, "task"))!;
    await tasks.update(scope, "task", { push: [] }, current.revision);
    authorized.resolve(true);
    expect((await delivery)[0]?.outcome).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });
  it("bounds stalled egress policy and never sends after the deadline", async () => {
    const { tasks } = await taskWithPush();
    const allow = Promise.withResolvers<boolean>();
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverA2APush({
      tasks,
      scope,
      taskId: "task",
      event,
      policy: { authorize: () => true, allow: () => allow.promise, timeoutMs: 5, fetch: send },
    });
    expect(result[0]?.outcome).toBe("refused");
    allow.resolve(true);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
  it("sends only allowed headers, refuses redirects and verifies opt-in HMAC", async () => {
    const { tasks } = await taskWithPush();
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer host-approved-token");
      expect(headers.get("X-A2A-Notification-Token")).toBe("notification-token");
      expect(await verifyA2APush(String(init?.body), headers, "host-secret")).toBe(true);
      return new Response(null, { status: 302, headers: { location: "https://other.test" } });
    });
    const policy = {
      authorize: () => true,
      allow: () => true,
      fetch: send,
      signingSecret: "host-secret",
    };
    expect(
      (await deliverA2APush({ tasks, scope, taskId: "task", event, policy }))[0]?.outcome,
    ).toBe("unknown");
    await deliverA2APush({ tasks, scope, taskId: "task", event, policy });
    expect(send).toHaveBeenCalledOnce();
  });
  it("rejects stale timestamps, changed payloads and wrong HMAC keys", async () => {
    const signed = await signA2APush("payload", "secret", 100);
    const headers = new Headers({
      "X-A2A-Signature": signed.signature,
      "X-A2A-Timestamp": signed.timestamp,
    });
    expect(await verifyA2APush("payload", headers, "secret", { now: 100_000 })).toBe(true);
    expect(await verifyA2APush("payload", headers, "wrong", { now: 100_000 })).toBe(false);
    expect(await verifyA2APush("changed", headers, "secret", { now: 100_000 })).toBe(false);
    expect(await verifyA2APush("payload", headers, "secret", { now: 1_000_000 })).toBe(false);
  });
});
