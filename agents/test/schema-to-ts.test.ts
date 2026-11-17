// Schema cases adapted from TanStack AI (MIT, Copyright (c) 2025 Tanner Linsley)
// and Mastra (Apache-2.0, Copyright (c) 2025 Kepler Software, Inc.).
// Changes: scoped references, nullable intersections and native TypeScript compilation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type JsonObjectSchema } from "@providerkit/core";
import { describe, expect, it } from "vitest";
import { toolTypings } from "../src/schema-to-ts.ts";

function tool(name: string, inputSchema: JsonObjectSchema, outputSchema?: Record<string, unknown>) {
  return defineTool({
    name,
    description: "Read a value.",
    inputSchema,
    outputSchema,
    run: async () => null,
  });
}

const first = tool(
  "read-a",
  {
    type: "object",
    properties: { value: { $ref: "#/$defs/Item" } },
    required: ["value"],
    additionalProperties: false,
    $defs: { Item: { type: "string" } },
  },
  {
    $ref: "#/definitions/Item",
    definitions: { Item: { type: "boolean" } },
  },
);
const second = tool("read_a", {
  type: "object",
  properties: { value: { $ref: "#/$defs/Item" } },
  required: ["value"],
  additionalProperties: false,
  $defs: { Item: { type: "number" } },
});

function compile(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), "providerkit-typings-"));
  try {
    const file = join(dir, "consumer.ts");
    writeFileSync(file, source);
    execFileSync(
      fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)),
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        file,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("code tool typings", () => {
  it("scopes references by tool and by input/output document", () => {
    const result = toolTypings([first, second]);
    expect(result).toContain("type Tool1InputRef1 = string;");
    expect(result).toContain("type Tool1OutputRef1 = boolean;");
    expect(result).toContain("type Tool2InputRef1 = number;");
    expect(result).toContain('"read-a"(input: Tool1Input): Promise<Tool1Output>;');
    expect(result).toContain('"read_a"(input: Tool2Input): Promise<unknown>;');
  });

  it("renders intersections, deduplicates nullable unions and handles malformed subschemas", () => {
    const result = toolTypings([
      tool("read", {
        type: "object",
        properties: {
          joined: {
            allOf: [
              { type: "object", properties: { id: { type: "string" } } },
              { type: "object", properties: { count: { type: "number" } } },
            ],
          },
          optional: { anyOf: [{ type: ["string", "null"] }, { type: "null" }, { type: "string" }] },
          missing: null,
          empty: { enum: [] },
        },
        additionalProperties: false,
      }),
    ]);
    expect(result).toContain('"optional"?: string | null;');
    expect(result).toContain('"missing"?: unknown;');
    expect(result).toContain('"empty"?: never;');
    expect(result).toContain(") & (");
  });

  it("keeps dictionary value types without making declared fields impossible", () => {
    const result = toolTypings([
      tool(
        "read",
        { type: "object" },
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: { type: "number" },
        },
      ),
    ]);
    expect(result).toContain('{ "title": string; } & Record<string, number | string>');
    expect(
      toolTypings([
        tool(
          "read",
          { type: "object" },
          { type: "object", additionalProperties: { type: "boolean" } },
        ),
      ]),
    ).toContain("Record<string, boolean>");
    expect(toolTypings([tool("read", { type: "object", additionalProperties: false })])).toContain(
      "Record<string, never>",
    );
  });

  it("resolves escaped JSON pointers without fetching remote schemas", () => {
    const result = toolTypings([
      tool("read", {
        type: "object",
        properties: {
          a: { $ref: "#/$defs/a~1b~0c" },
          b: { $ref: "https://example.test/schema.json" },
          c: { $ref: "#/%zz" },
          d: { $ref: "#/toString" },
        },
        $defs: { "a/b~c": { type: "string" } },
        additionalProperties: false,
      }),
    ]);
    expect(result).toContain("type Tool1InputRef1 = string;");
    expect(result).toContain('"b"?: unknown; "c"?: unknown; "d"?: unknown;');
  });

  it("preserves structured recursion and refuses circular aliases", () => {
    const result = toolTypings([
      tool("read", {
        type: "object",
        properties: {
          next: { $ref: "#" },
          broken: { $ref: "#/$defs/A" },
        },
        $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
        additionalProperties: false,
      }),
    ]);
    expect(result).toContain('"next"?: Tool1Input;');
    expect(result).toContain("type Tool1InputRef2 = unknown;");
  });

  it("quotes names and escapes comments without changing tool names", () => {
    const result = toolTypings([
      defineTool({
        name: 'a-b"\\c',
        description: "Read. */ declare const escaped: true; /*",
        inputSchema: {
          type: "object",
          properties: { 'x"\\y': { type: "string", description: "first\nsecond */ third" } },
          additionalProperties: false,
        },
        run: async () => null,
      }),
    ]);
    expect(result).toContain('"a-b\\"\\\\c"(input:');
    expect(result).toContain("Read. * / declare const escaped: true; /* */");
    expect(result).toContain("first second * / third");
    compile(result);
  });

  it("handles JSON literals, optional tuples and boolean schemas", () => {
    const result = toolTypings([
      tool("read", {
        type: "object",
        properties: {
          fixed: { const: { name: "a", values: [1, null] } },
          tuple: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            minItems: 1,
            items: false,
          },
          free: true,
          impossible: false,
        },
        additionalProperties: false,
      }),
    ]);
    expect(result).toContain('"fixed"?: { "name": "a"; "values": [1, null]; };');
    expect(result).toContain('"tuple"?: [string, (number)?];');
    expect(result).toContain('"free"?: unknown; "impossible"?: never;');
    compile(result);
  });

  it("leaves unknown output unknown and refuses duplicate tool names", () => {
    expect(toolTypings([second])).toContain("Promise<unknown>");
    expect(() => toolTypings([first, first])).toThrow("Duplicate tool name");
    expect(toolTypings([])).toBe("declare const tools: {\n\n};");
  });

  it("produces usable declarations that keep reference types distinct", () => {
    compile(`${toolTypings([first, second])}
      const a: Promise<boolean> = tools["read-a"]({ value: "text" });
      tools.read_a({ value: 42 });
      // @ts-expect-error The second tool's Item is a number, not the first tool's string.
      tools.read_a({ value: "text" });
      // @ts-expect-error An output without metadata is unknown, never guessed from its input.
      const b: Promise<number> = tools.read_a({ value: 1 });
    `);
  });
});
