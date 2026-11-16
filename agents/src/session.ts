// A conversation store the run reads once and appends to once.
//
// Load happens before the run is saved, so the history is frozen in the snapshot. The append
// happens after the run settles, keyed by its run id, so a resumed or retried run writes its
// turn once. A revision check keeps a run from appending over turns that landed after it
// loaded: a full replace would let the last writer erase them.
import { messageOf } from "@providerkit/core";
import { copyData, equalData, isId, isRecord, isRevision } from "./snapshot.ts";
import { readStored } from "./input.ts";
import type { AgentMessage, Session, SessionTurn } from "./types.ts";

/** The session changed after the run loaded it, or this run id already appended another turn.
 * Load the conversation again before continuing it. */
export class SessionConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Conversation ${sessionId} changed after this run loaded it. Load it again before you add to it.`,
    );
    this.name = "SessionConflictError";
  }
}

function readTurn(value: unknown): SessionTurn {
  if (!isRecord(value) || !isId(value.runId) || !isRevision(value.after))
    throw new TypeError("A session turn needs a runId, the revision it follows and its messages.");
  return { runId: value.runId, after: value.after, messages: readStored(value.messages, "A turn") };
}

// The duplicate and conflict rule is ported from OpenAI Agents JS (MIT),
// packages/agents-core/src/memory/memorySession.ts: an id that already applied the same change
// succeeds without applying it again, and the same id with another change fails. The revision
// check and the copies on every read and write follow PydanticAI's (MIT) InMemoryConversationStore,
// pydantic_ai_slim/pydantic_ai/conversation_store.py.
/**
 * A session kept in this process, for tests, examples and single-process tools. It copies on
 * every read and write, so changing what it returned or what you appended never changes what
 * it holds. Everything is lost when the process ends.
 */
export function createMemorySession(
  options: { id?: string; messages?: readonly AgentMessage[] } = {},
): Session {
  const id = options.id ?? crypto.randomUUID();
  if (!isId(id)) throw new TypeError("A session id must be non-empty text.");
  let messages = readStored(options.messages ?? [], "The starting messages");
  let count = messages.length > 0 ? 1 : 0;
  let revision: string | null = count > 0 ? String(count) : null;
  const turns = new Map<string, { turn: SessionTurn; revision: string }>();
  return Object.freeze({
    id,
    async load({ limit, signal }: { limit?: number; signal: AbortSignal }) {
      signal.throwIfAborted();
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        throw new TypeError("limit must be a whole number, 0 or more.");
      let window = messages;
      if (limit !== undefined) window = limit === 0 ? [] : messages.slice(-limit);
      return { messages: copyData(window), revision };
    },
    async append(raw: SessionTurn, { signal }: { signal: AbortSignal }) {
      signal.throwIfAborted();
      const turn = readTurn(raw);
      const applied = turns.get(turn.runId);
      if (applied) {
        if (!equalData(applied.turn, turn)) throw new SessionConflictError(id);
        return { revision: applied.revision };
      }
      if (turn.after !== revision) throw new SessionConflictError(id);
      messages = [...messages, ...turn.messages];
      count++;
      revision = String(count);
      turns.set(turn.runId, { turn, revision });
      return { revision };
    },
  });
}

/**
 * Check a session store against the contract the run relies on, by writing to fresh sessions
 * from `create`. Each call to `create` must return a new, empty session. Throws an Error that
 * names the first rule the store breaks. Run it against a test database, never a real one.
 */
export async function checkSession(create: () => Session | Promise<Session>): Promise<void> {
  const signal = new AbortController().signal;
  function expect(ok: boolean, rule: string): asserts ok {
    if (!ok) throw new Error(`The session store breaks a rule: ${rule}`);
  }
  /** A step that must succeed. If it throws, name the rule, with the store's error as cause. */
  async function must<T>(work: () => Promise<T>, rule: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new Error(`The session store breaks a rule: ${rule} It threw: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }
  async function conflicts(work: Promise<unknown>): Promise<boolean> {
    try {
      await work;
      return false;
    } catch (error) {
      return error instanceof Error && error.name === "SessionConflictError";
    }
  }
  const first: AgentMessage[] = [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
  ];
  const second: AgentMessage[] = [
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second answer" },
  ];

  const session = await create();
  expect(isId(session.id), "a session has a non-empty id.");
  const empty = await must(() => session.load({ signal }), "a new session loads.");
  expect(
    empty.messages.length === 0 && empty.revision === null,
    "a new session loads no messages and a null revision.",
  );
  const turn: SessionTurn = { runId: "run-1", after: null, messages: copyData(first) };
  const saved = await must(
    () => session.append(turn, { signal }),
    "the first append to a new session, after null, succeeds.",
  );
  expect(isId(saved.revision), "append returns the new revision as non-empty text.");
  turn.messages[0] = { role: "user", content: "Changed after append" };
  const loaded = await session.load({ signal });
  expect(
    equalData(loaded.messages, first) && loaded.revision === saved.revision,
    "load returns what was appended, oldest first, with the revision append returned, and changing the appended array afterwards changes nothing stored.",
  );
  loaded.messages.pop();
  expect(
    equalData((await session.load({ signal })).messages, first),
    "changing a loaded array changes nothing stored.",
  );
  const repeated = await must(
    () => session.append({ runId: "run-1", after: null, messages: copyData(first) }, { signal }),
    "repeating the same turn succeeds and writes nothing.",
  );
  expect(
    isId(repeated.revision) && equalData((await session.load({ signal })).messages, first),
    "repeating the same turn succeeds and writes nothing.",
  );
  expect(
    await conflicts(
      session.append({ runId: "run-1", after: null, messages: copyData(second) }, { signal }),
    ),
    "the same runId with other messages throws SessionConflictError.",
  );
  expect(
    await conflicts(
      session.append({ runId: "run-2", after: null, messages: copyData(second) }, { signal }),
    ),
    "a stale revision throws SessionConflictError.",
  );
  expect(
    equalData((await session.load({ signal })).messages, first),
    "a refused append writes nothing.",
  );
  await must(
    () =>
      session.append(
        { runId: "run-2", after: saved.revision, messages: copyData(second) },
        {
          signal,
        },
      ),
    "an append after the current revision succeeds.",
  );
  const window = await must(() => session.load({ limit: 3, signal }), "load takes a limit.");
  expect(
    equalData(window.messages, [...first.slice(1), ...second]),
    "load({ limit }) returns the newest messages, oldest first.",
  );
  const other = await create();
  expect(other.id !== session.id, "create returns a new session each time.");
}
