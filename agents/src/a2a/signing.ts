// Card-signing design adapted from Mastra's agent-card-signing.ts (Apache-2.0).
// Copyright (c) 2025 Kepler Software, Inc. JCS: RFC 8785; detached JWS: RFC 7515.
import { A2AError, parseA2AJson, type A2AAgentCard, type A2AJson, type A2AObject } from "./wire.ts";

export interface A2ACardSigner {
  key: CryptoKey;
  kid: string;
  alg: "ES256" | "EdDSA" | "RS256";
}
const encoder = new TextEncoder();

/** JCS sorts UTF-16 keys and uses ECMAScript number formatting. Reject non-JSON values and
 * lone surrogates instead of signing a lossy serialization. Also used for message identity. */
export function canonicalA2AJson(value: A2AJson): string {
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw new A2AError("invalid");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new A2AError("invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalA2AJson).join(",")}]`;
  if (
    !value ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new A2AError("invalid");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${canonicalA2AJson(key)}:${canonicalA2AJson(value[key]!)}`)
    .join(",")}}`;
}
/** Stores content identity without retaining another copy of a message or credential. */
export async function hashA2AJson(value: A2AJson): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalA2AJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function encode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new A2AError("invalid");
  const bytes = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  if (encode(bytes) !== text) throw new A2AError("invalid");
  return bytes;
}
function algorithm(
  alg: string,
  key: CryptoKey,
  usage: "sign" | "verify",
): AlgorithmIdentifier | EcdsaParams {
  if (key.type !== (usage === "sign" ? "private" : "public") || !key.usages.includes(usage))
    throw new A2AError("invalid");
  if (
    alg === "ES256" &&
    key.algorithm.name === "ECDSA" &&
    "namedCurve" in key.algorithm &&
    key.algorithm.namedCurve === "P-256"
  )
    return { name: "ECDSA", hash: "SHA-256" };
  if (alg === "EdDSA" && key.algorithm.name === "Ed25519") return "Ed25519";
  if (alg === "RS256" && key.algorithm.name === "RSASSA-PKCS1-v1_5" && "hash" in key.algorithm) {
    const hash = key.algorithm.hash;
    if (hash && typeof hash === "object" && "name" in hash && hash.name === "SHA-256")
      return "RSASSA-PKCS1-v1_5";
  }
  throw new A2AError("invalid");
}
// A2A 1.0 §8.4.1 normalizes protobuf fields BEFORE JCS, unlike 0.3's raw-card JCS.
// Field list: a2aproject/A2A v1.0.0 a2a.proto. Empty-value removal matched against
// a2a-js 1.3.0 src/signature.ts (Apache-2.0).
function object(value: A2AJson | undefined): A2AObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new A2AError("invalid");
  return value;
}
function fields(value: A2AJson, names: string[]): A2AObject {
  const source = object(value);
  return Object.fromEntries(
    names
      .filter((name) => source[name] !== undefined && source[name] !== null)
      .map((name) => {
        if (typeof source[name] !== "string") throw new A2AError("invalid");
        return [name, source[name]!];
      }),
  );
}
function array(value: A2AJson, map: (entry: A2AJson) => A2AJson): A2AJson[] {
  if (!Array.isArray(value)) throw new A2AError("invalid");
  return value.map(map);
}
function strings(value: A2AJson): A2AJson[] {
  return array(value, (entry) => {
    if (typeof entry !== "string") throw new A2AError("invalid");
    return entry;
  });
}
function mapping(value: A2AJson, map: (entry: A2AJson) => A2AJson): A2AObject {
  return Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key, map(entry)]));
}
function present(
  source: A2AObject,
  target: A2AObject,
  key: string,
  map: (v: A2AJson) => A2AJson,
): void {
  if (source[key] !== undefined && source[key] !== null) target[key] = map(source[key]);
}
function boolean(value: A2AJson): boolean {
  if (typeof value !== "boolean") throw new A2AError("invalid");
  return value;
}
function requirements(value: A2AJson): A2AJson[] {
  return array(value, (entry) => {
    const result: A2AObject = {};
    present(object(entry), result, "schemes", (schemes) =>
      mapping(schemes, (scope) => {
        const list: A2AObject = {};
        present(object(scope), list, "list", strings);
        return list;
      }),
    );
    return result;
  });
}
function flow(value: A2AJson, name: string): A2AObject {
  const names =
    name === "authorizationCode"
      ? ["authorizationUrl", "tokenUrl", "refreshUrl"]
      : name === "implicit"
        ? ["authorizationUrl", "refreshUrl"]
        : name === "deviceCode"
          ? ["deviceAuthorizationUrl", "tokenUrl", "refreshUrl"]
          : ["tokenUrl", "refreshUrl"];
  const result = fields(value, names);
  const source = object(value);
  present(source, result, "scopes", (scopes) =>
    mapping(scopes, (scope) => {
      if (typeof scope !== "string") throw new A2AError("invalid");
      return scope;
    }),
  );
  if (
    name === "authorizationCode" &&
    source.pkceRequired !== undefined &&
    boolean(source.pkceRequired)
  )
    result.pkceRequired = true;
  return result;
}
function security(value: A2AJson): A2AObject {
  const source = object(value);
  const variants = [
    "apiKeySecurityScheme",
    "httpAuthSecurityScheme",
    "oauth2SecurityScheme",
    "openIdConnectSecurityScheme",
    "mtlsSecurityScheme",
  ].filter((key) => source[key] !== undefined && source[key] !== null);
  if (variants.length > 1) throw new A2AError("invalid");
  if (!variants.length) return {};
  const key = variants[0]!;
  const scheme = object(source[key]);
  const names =
    key === "apiKeySecurityScheme"
      ? ["description", "location", "name"]
      : key === "httpAuthSecurityScheme"
        ? ["description", "scheme", "bearerFormat"]
        : key === "oauth2SecurityScheme"
          ? ["description", "oauth2MetadataUrl"]
          : key === "openIdConnectSecurityScheme"
            ? ["description", "openIdConnectUrl"]
            : ["description"];
  const result = fields(scheme, names);
  if (key === "oauth2SecurityScheme")
    present(scheme, result, "flows", (value) => {
      const source = object(value);
      const keys = [
        "authorizationCode",
        "clientCredentials",
        "implicit",
        "password",
        "deviceCode",
      ].filter((name) => source[name] !== undefined && source[name] !== null);
      if (keys.length > 1) throw new A2AError("invalid");
      return Object.fromEntries(keys.map((name) => [name, flow(source[name]!, name)]));
    });
  return { [key]: result };
}
function cleanEmpty(value: A2AJson): A2AJson | undefined {
  if (value === "" || value === null) return undefined;
  if (Array.isArray(value)) {
    const result = value.map(cleanEmpty).filter((entry): entry is A2AJson => entry !== undefined);
    return result.length ? result : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).flatMap(([key, entry]) => {
      const cleaned = cleanEmpty(entry);
      return cleaned === undefined ? [] : [[key, cleaned]];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}
/** 1.0 signatures cover only schema fields after protobuf normalization. Unknown fields and
 * empty extension values are NOT authenticated. Do not use them as permission or trust data. */
export function canonicalA2ACard(card: A2AAgentCard): string {
  const { signatures: _signatures, ...document } = card.document;
  // Validate Unicode even in fields normalization later drops.
  canonicalA2AJson(document);
  if (card.version === "0.3") return canonicalA2AJson(document);
  const result = fields(document, [
    "name",
    "description",
    "version",
    "documentationUrl",
    "iconUrl",
  ]);
  present(document, result, "supportedInterfaces", (v) =>
    array(v, (entry) => fields(entry, ["url", "protocolBinding", "protocolVersion", "tenant"])),
  );
  present(document, result, "provider", (v) => fields(v, ["url", "organization"]));
  present(document, result, "capabilities", (v) => {
    const source = object(v);
    const capabilities: A2AObject = {};
    for (const key of ["streaming", "pushNotifications", "extendedAgentCard"])
      present(source, capabilities, key, boolean);
    present(source, capabilities, "extensions", (v) =>
      array(v, (entry) => {
        const extension = fields(entry, ["uri", "description"]);
        const original = object(entry);
        if (original.required !== undefined && boolean(original.required))
          extension.required = true;
        present(original, extension, "params", object);
        return extension;
      }),
    );
    return capabilities;
  });
  present(document, result, "securitySchemes", (v) => mapping(v, security));
  present(document, result, "securityRequirements", requirements);
  for (const key of ["defaultInputModes", "defaultOutputModes"])
    present(document, result, key, strings);
  present(document, result, "skills", (v) =>
    array(v, (entry) => {
      const skill = fields(entry, ["id", "name", "description"]);
      const source = object(entry);
      for (const key of ["tags", "examples", "inputModes", "outputModes"])
        present(source, skill, key, strings);
      present(source, skill, "securityRequirements", requirements);
      return skill;
    }),
  );
  return canonicalA2AJson(cleanEmpty(result) ?? {});
}
function payload(card: A2AAgentCard): string {
  return encode(encoder.encode(canonicalA2ACard(card)));
}

/** Signs the version's canonical public document. Sign each version separately. Possession
 * of a signing key does not authorize task access or tool execution. */
export async function signAgentCard(
  card: A2AAgentCard,
  signer: A2ACardSigner,
): Promise<A2AAgentCard> {
  if (!signer.kid || signer.kid.length > 512) throw new A2AError("invalid");
  const copy = structuredClone(card);
  const protectedHeader = encode(
    encoder.encode(canonicalA2AJson({ alg: signer.alg, kid: signer.kid, typ: "JOSE" })),
  );
  const signature = await crypto.subtle.sign(
    algorithm(signer.alg, signer.key, "sign"),
    signer.key,
    encoder.encode(`${protectedHeader}.${payload(copy)}`),
  );
  copy.document.signatures = [
    { protected: protectedHeader, signature: encode(new Uint8Array(signature)) },
  ];
  return copy;
}

/** Keys are pinned by the host. Never follows jku/x5u or trusts a key embedded in a card.
 * True means one pinned signature is valid, not that the signer has any application permission. */
export async function verifyAgentCard(
  card: A2AAgentCard,
  keys: Readonly<Record<string, CryptoKey>>,
): Promise<boolean> {
  try {
    const signatures = card.document.signatures;
    if (!Array.isArray(signatures) || !signatures.length || signatures.length > 16) return false;
    const encoded = payload(card);
    for (const signature of signatures) {
      if (
        !signature ||
        typeof signature !== "object" ||
        Array.isArray(signature) ||
        typeof signature.protected !== "string" ||
        typeof signature.signature !== "string"
      )
        continue;
      try {
        const header = parseA2AJson(
          new TextDecoder("utf-8", { fatal: true }).decode(decode(signature.protected)),
          { bodyBytes: 8192 },
        );
        if (
          !header ||
          typeof header !== "object" ||
          Array.isArray(header) ||
          typeof header.kid !== "string" ||
          typeof header.alg !== "string" ||
          (card.version === "1.0" && (typeof header.typ !== "string" || !header.typ)) ||
          !Object.hasOwn(keys, header.kid)
        )
          continue;
        // No unencoded payloads or critical extensions. Key discovery is deliberately absent.
        if (Object.keys(header).some((key) => !["alg", "kid", "typ"].includes(key))) continue;
        if (
          signature.header &&
          typeof signature.header === "object" &&
          Object.keys(signature.header).some((key) => Object.hasOwn(header, key))
        )
          continue;
        const key = keys[header.kid]!;
        if (
          await crypto.subtle.verify(
            algorithm(header.alg, key, "verify"),
            key,
            decode(signature.signature),
            encoder.encode(`${signature.protected}.${encoded}`),
          )
        )
          return true;
      } catch {
        /* An unsupported or invalid signature cannot establish trust. */
      }
    }
  } catch {
    /* Refuse malformed canonical JSON without retaining peer content. */
  }
  return false;
}
