// Async result wrapping adapted from TanStack AI's ai-code-mode/src/code-wrapper.ts
// (MIT, Copyright (c) 2025 Tanner Linsley). Changes: indirect evaluation, hidden
// string bridges, JSON-only values and closed bridges before result/error inspection.
// See THIRD_PARTY_NOTICES.md.

/** Build the guest side only. The host bridge still owns permission checks, limits and receipts. */
export function codeScript(expression: string, toolNames: readonly string[]): string {
  return `(() => {
  "use strict";
  const call = globalThis.__pk_call;
  const log = globalThis.__pk_log;
  delete globalThis.__pk_call;
  delete globalThis.__pk_log;
  const evaluate = eval;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const create = Object.create;
  const define = Object.defineProperty;
  const freeze = Object.freeze;
  const prototype = Object.getPrototypeOf;
  const setPrototype = Object.setPrototypeOf;
  const descriptor = Object.getOwnPropertyDescriptor;
  const owns = Object.hasOwn;
  const keys = Reflect.ownKeys;
  const isArray = Array.isArray;
  const finite = Number.isFinite;
  const PlainObject = Object.prototype;
  const ErrorClass = Error;
  const promise = Promise.resolve.bind(Promise);
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const join = Function.prototype.call.bind(Array.prototype.join);
  const names = ${JSON.stringify(toolNames)};
  let open = true;

  function requireOpen() {
    if (!open) throw new ErrorClass("The program has finished. No more tool calls can start.");
  }

  function json(value, parents = []) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && finite(value)) return value;
    if (typeof value !== "object") throw new ErrorClass("Use JSON values only.");
    for (const parent of parents) {
      if (parent === value) throw new ErrorClass("A JSON value cannot contain a cycle.");
    }
    const array = isArray(value);
    if (!array && prototype(value) !== PlainObject && prototype(value) !== null) {
      throw new ErrorClass("Use plain objects and arrays, not class instances.");
    }
    const next = [...parents, value];
    const result = array ? setPrototype([], null) : create(null);
    let count = 0;
    for (const key of keys(value)) {
      if (typeof key !== "string") throw new ErrorClass("JSON objects cannot have symbol keys.");
      if (array && key === "length") continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new ErrorClass("JSON arrays cannot have extra properties.");
      }
      const field = descriptor(value, key);
      if (!field || !owns(field, "value")) throw new ErrorClass("JSON values cannot have getters or setters.");
      define(result, key, { value: json(field.value, next), enumerable: true });
      count++;
    }
    if (array && count !== value.length) throw new ErrorClass("JSON arrays cannot have missing entries.");
    return result;
  }

  function encode(value) {
    return stringify(json(value));
  }

  const bindings = create(null);
  for (const name of names) {
    define(bindings, name, { enumerable: true, value: async (input) => {
      requireOpen();
      if (!input || typeof input !== "object" || isArray(input)) {
        throw new ErrorClass("Pass one JSON object to a tool.");
      }
      const encoded = encode(input);
      requireOpen();
      const reply = parse(await call(name, encoded));
      if (reply.ok) return reply.value;
      const error = new ErrorClass(reply.error.message);
      error.name = "ToolError";
      error.tool = name;
      error.kind = reply.error.kind;
      throw error;
    }});
  }
  const tools = new Proxy(freeze(bindings), { get(target, name) {
    if (typeof name === "symbol") return undefined;
    if (owns(target, name)) return target[name];
    throw new ErrorClass("Unknown tool. Choose one of: " + join(names, ", ") + ".");
  }});
  define(globalThis, "tools", { value: tools, enumerable: true });
  define(globalThis, "console", { value: freeze({ log(...values) {
    requireOpen();
    const parts = [];
    for (const value of values) {
      parts.push(typeof value === "string" ? value : value === undefined ? "undefined" : encode(value));
    }
    requireOpen();
    log(join(parts, " "));
  }}) });

  function failure(error) {
    open = false;
    const result = create(null);
    result.name = "ProgramError";
    result.message = "The program threw an error.";
    try {
      if (error && error.name === "SyntaxError") result.name = "SyntaxError";
      if (error && typeof error.message === "string") result.message = slice(error.message, 0, 2048);
      else if (typeof error === "string") result.message = slice(error, 0, 2048);
    } catch {}
    const envelope = create(null);
    envelope.ok = false;
    envelope.error = result;
    return stringify(envelope);
  }

  try {
    // Indirect eval gives the program global scope, not access to this closure's bridges.
    // The expression may end in a semicolon after host TypeScript transpilation.
    const program = evaluate(${JSON.stringify(expression)});
    if (typeof program !== "function") throw new ErrorClass("The program must be an async function.");
    return then(promise(program()), (value) => {
      open = false;
      try {
        const envelope = create(null);
        envelope.ok = true;
        if (value !== undefined) {
          envelope.value = json(value);
        }
        return stringify(envelope);
      } catch (error) { return failure(error); }
    }, failure);
  } catch (error) { return failure(error); }
})()`;
}
