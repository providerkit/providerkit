import { describe, expect, it } from "vitest";
import {
  checkSession,
  createMemorySession,
  SessionConflictError,
  type AgentMessage,
  type Session,
  type SessionTurn,
} from "../src/index.ts";

const signal = new AbortController().signal;
const turn: AgentMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello" },
];

/** A store with one deliberate flaw, to prove checkSession notices it. */
function flawed(flaw: "duplicates" | "ignores revision" | "shares arrays" | "plain conflict") {
  return (): Session => {
    let messages: AgentMessage[] = [];
    let revision: string | null = null;
    const turns = new Map<string, string>();
    const conflict = () =>
      flaw === "plain conflict" ? new Error("Conflict") : new SessionConflictError("flawed");
    return {
      id: crypto.randomUUID(),
      async load({ limit }) {
        const window = limit === undefined ? messages : messages.slice(-limit);
        return { messages: flaw === "shares arrays" ? window : structuredClone(window), revision };
      },
      async append(next: SessionTurn) {
        const seen = turns.get(next.runId);
        if (seen !== undefined && flaw !== "duplicates") {
          if (seen !== JSON.stringify(next)) throw conflict();
          return { revision: revision ?? "0" };
        }
        if (next.after !== revision && flaw !== "ignores revision") throw conflict();
        messages = [...messages, ...structuredClone(next.messages)];
        revision = String(Number(revision ?? 0) + 1);
        turns.set(next.runId, JSON.stringify(next));
        return { revision };
      },
    };
  };
}

describe("sessions", () => {
  it("createMemorySession meets the contract a host store must meet", async () => {
    await expect(checkSession(() => createMemorySession())).resolves.toBeUndefined();
  });

  it.each([
    ["duplicates", "repeating the same turn succeeds and writes nothing"],
    ["ignores revision", "a stale revision throws SessionConflictError"],
    ["shares arrays", "changing a loaded array changes nothing stored"],
    ["plain conflict", "the same runId with other messages throws SessionConflictError"],
  ] as const)("checkSession catches a store that %s", async (flaw, rule) => {
    await expect(checkSession(flawed(flaw))).rejects.toThrow(rule);
  });

  it("starts from the messages it is given and copies them", async () => {
    const start = structuredClone(turn);
    const session = createMemorySession({ id: "thread", messages: start });
    start[0] = { role: "user", content: "Changed" };
    expect(await session.load({ signal })).toEqual({ messages: turn, revision: "1" });
    expect(await session.load({ limit: 1, signal })).toEqual({
      messages: [turn[1]],
      revision: "1",
    });
    expect((await session.load({ limit: 0, signal })).messages).toEqual([]);
    const saved = await session.append(
      { runId: "run-1", after: "1", messages: [{ role: "user", content: "Again" }] },
      { signal },
    );
    expect(saved).toEqual({ revision: "2" });
  });

  it("refuses what it cannot store, and conflicts by class", async () => {
    const session = createMemorySession();
    const malformed = { runId: "", after: null, messages: [] };
    await expect(session.append(malformed, { signal })).rejects.toThrow(TypeError);
    const system = JSON.parse(
      '{"runId":"run-1","after":null,"messages":[{"role":"system","content":"x"}]}',
    );
    await expect(session.append(system, { signal })).rejects.toThrow("system message");
    await expect(
      session.append({ runId: "run-2", after: "7", messages: turn }, { signal }),
    ).rejects.toBeInstanceOf(SessionConflictError);
    expect(() => createMemorySession({ id: " " })).toThrow(TypeError);
    await expect(session.load({ limit: -1, signal })).rejects.toThrow(TypeError);
    expect((await session.load({ signal })).messages).toEqual([]);
  });
});
