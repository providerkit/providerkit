// Adapted from TanStack AI's ai-code-mode/type-generator/json-schema-to-ts.ts
// (MIT, Copyright (c) 2025 Tanner Linsley) and Mastra's tools/code-mode/stub-generator.ts
// (Apache-2.0, Copyright (c) 2025 Kepler Software, Inc.).
// Changes: per-tool reference aliases, intersections, safe keys/comments and no runtime dependency.
// See THIRD_PARTY_NOTICES.md and LICENSE-APACHE-2.0.
import type { Tool } from "@providerkit/core";

/** Prompt-only typings. The tool's validator, not these declarations, checks each call. */
export function toolTypings(tools: readonly Tool[]): string {
  const declarations: string[] = [];
  const methods: string[] = [];
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (names.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
    // Position avoids collisions between names like a-b/a_b, and between input/output $defs.
    const input = `Tool${index + 1}Input`;
    const output = `Tool${index + 1}Output`;
    declarations.push(...schemaDeclarations(tool.inputSchema, input));
    if (tool.outputSchema !== undefined) {
      declarations.push(...schemaDeclarations(tool.outputSchema, output));
    }
    methods.push(
      `  ${comment(tool.description)}\n  ${JSON.stringify(tool.name)}(input: ${input}): Promise<${tool.outputSchema === undefined ? "unknown" : output}>;`,
    );
  }
  return [...declarations, `declare const tools: {\n${methods.join("\n")}\n};`].join("\n\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comment(value: string): string {
  return `/** ${value.replaceAll("*/", "* /").replace(/\s+/g, " ")} */`;
}

function union(parts: readonly string[]): string {
  const choices = [...new Set(parts)].filter((part) => part !== "never");
  if (choices.includes("unknown")) return "unknown";
  return choices.join(" | ") || "never";
}

function intersection(parts: readonly (readonly string[])[]): readonly string[] {
  const constraints = new Map(parts.map((part) => [union(part), part]));
  constraints.delete("unknown");
  if (constraints.has("never")) return ["never"];
  if (constraints.size < 2) return constraints.values().next().value ?? ["unknown"];
  return [[...constraints.keys()].map((part) => `(${part})`).join(" & ")];
}

function literal(value: unknown, depth = 0): string {
  if (depth > 32) return "unknown";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => literal(item, depth + 1)).join(", ")}]`;
  if (record(value)) {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${literal(item, depth + 1)};`)
      .join(" ")} }`;
  }
  return "unknown";
}

function schemaDeclarations(root: unknown, name: string): string[] {
  const aliases = new Map<string, { name: string; type: string }>();
  aliases.set("#", { name, type: "unknown" });

  function reference(ref: string, ancestors: ReadonlySet<string>, depth: number): string {
    if (ancestors.has(ref)) return "unknown";
    let target: unknown = root;
    if (ref !== "#") {
      if (!ref.startsWith("#/")) return "unknown";
      try {
        for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
          const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!record(target) || !Object.hasOwn(target, key)) return "unknown";
          target = target[key];
        }
      } catch {
        return "unknown";
      }
    }
    const existing = aliases.get(ref);
    if (existing) return existing.name;
    const alias = { name: `${name}Ref${aliases.size}`, type: "unknown" };
    aliases.set(ref, alias);
    alias.type = union(render(target, new Set([...ancestors, ref]), depth + 1));
    return alias.name;
  }

  function object(schema: Record<string, unknown>, depth: number): string {
    const properties = record(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields: string[] = [];
    const fieldTypes: string[] = [];
    for (const [key, value] of Object.entries(properties)) {
      const type = render(value, new Set(), depth + 1);
      fieldTypes.push(...type);
      const description =
        record(value) && typeof value.description === "string"
          ? `${comment(value.description)} `
          : "";
      fields.push(
        `${description}${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${union(type)};`,
      );
    }
    // A required name can exist without a corresponding properties schema.
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(properties, key)) {
        fieldTypes.push("unknown");
        fields.push(`${JSON.stringify(key)}: unknown;`);
      }
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      return fields.length ? `{ ${fields.join(" ")} }` : "Record<string, never>";
    }
    const value = render(additional, new Set(), depth + 1);
    if (!fields.length) return `Record<string, ${union(value)}>`;
    // TS cannot exclude named fields from a string index. Widen only that index,
    // preserving each declared field instead of producing an impossible intersection.
    return `{ ${fields.join(" ")} } & Record<string, ${union([...value, ...fieldTypes])}>`;
  }

  function array(schema: Record<string, unknown>, depth: number): string {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : schema.items;
    if (!Array.isArray(prefix))
      return `Array<${union(render(schema.items, new Set(), depth + 1))}>`;
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    const tail = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
    const fields = prefix.map((item, index) => {
      const type = union(render(item, new Set(), depth + 1));
      return index < minimum ? type : `(${type})?`;
    });
    if (tail !== false) fields.push(`...Array<${union(render(tail, new Set(), depth + 1))}>`);
    return `[${fields.join(", ")}]`;
  }

  function typed(type: unknown, schema: Record<string, unknown>, depth: number): string {
    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "object":
        return object(schema, depth);
      case "array":
        return array(schema, depth);
      default:
        return "unknown";
    }
  }

  function render(
    schema: unknown,
    ancestors: ReadonlySet<string>,
    depth: number,
  ): readonly string[] {
    if (schema === false) return ["never"];
    // ponytail: unsupported constraints and deeply nested schemas become unknown.
    // This is model guidance, not a second JSON Schema validator.
    if (!record(schema) || depth > 64) return ["unknown"];
    const parts: (readonly string[])[] = [];
    if (typeof schema.$ref === "string") parts.push([reference(schema.$ref, ancestors, depth)]);
    if (Object.hasOwn(schema, "const")) parts.push([literal(schema.const)]);
    else if (Array.isArray(schema.enum)) parts.push(schema.enum.map((item) => literal(item)));
    else if (Array.isArray(schema.type)) {
      parts.push(schema.type.map((type) => typed(type, schema, depth)));
    } else if (schema.type !== undefined) parts.push([typed(schema.type, schema, depth)]);
    else if (schema.properties !== undefined || schema.additionalProperties !== undefined) {
      parts.push([object(schema, depth)]);
    } else if (schema.items !== undefined || schema.prefixItems !== undefined)
      parts.push([array(schema, depth)]);
    for (const key of ["anyOf", "oneOf"] as const) {
      const choices = schema[key];
      if (Array.isArray(choices))
        parts.push(choices.flatMap((item) => render(item, ancestors, depth + 1)));
    }
    if (Array.isArray(schema.allOf)) {
      parts.push(...schema.allOf.map((item) => render(item, ancestors, depth + 1)));
    }
    return intersection(parts);
  }

  aliases.get("#")!.type = union(render(root, new Set(["#"]), 0));
  return [...aliases.values()].map((alias) => `type ${alias.name} = ${alias.type};`);
}
