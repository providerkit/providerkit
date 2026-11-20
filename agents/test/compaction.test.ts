import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  ProviderError,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
} from "@providerkit/core";
import {
  createMemoryInbox,
  createMemorySession,
  defineAgent,
  defineDelegation,
  type AgentMessage,
  type RunSnapshot,
} from "../src/index.ts";
import { checkChildProgress } from "../src/snapshot.ts";
import { assertAgent } from "./fixtures/assertions.ts";

const base = { id: "compact", version: "1", instructions: "Keep these instructions." };
const policy = { identity: "trim-1", contextWindow: 1_000, keepTokens: 5 };
const usage = { inputTokens: 8, outputTokens: 2, cachedInputTokens: 0 };
const old: AgentMessage[] = [
  { role: "user", content: "Old question ".repeat(30) },
  { role: "assistant", content: "Old answer ".repeat(30) },
];
const input = { messages: [...old, { role: "user" as const, content: "New question" }] };
const authorizeResume = () => {};
function text(content: string): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "usage", usage },
    { type: "finish", finishReason: "stop" },
  ];
}
function call(): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: "read-call", name: "read", arguments: "{}" }] },
    { type: "usage", usage },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function fake(turns: ProviderChunk[][]) {
  const requests: { messages: ChatMessage[]; options?: StreamOptions }[] = [];
  const provider: Provider = {
    id: "offline",
    model: "fake",
    async *createStream(messages, _tools, options) {
      const chunks = turns[requests.length];
      requests.push({ messages: structuredClone(messages), options });
      if (!chunks) throw new Error("Unexpected model call");
      yield* chunks;
    },
  };
  return { provider, requests };
}
function saved(value: RunSnapshot | undefined): RunSnapshot {
  if (!value) throw new Error("Missing checkpoint");
  return value;
}

// All calls use fake providers. A thrown checkpoint simulates losing the worker before its
// next boundary; only the last successfully saved snapshot is handed to resume.
describe("model-only compaction", () => {
  it("trims without a paid call and keeps full session history, newMessages and instructions", async () => {
    const wire = fake([text("Answer")]);
    const session = createMemorySession({ messages: old });
    const agent = defineAgent({ ...base, provider: wire.provider, compaction: policy });
    const result = await agent.run("New question", { session });
    expect(result).toMatchObject({
      status: "completed",
      output: "Answer",
      session: { status: "saved" },
    });
    expect(wire.requests[0]?.messages).toEqual([
      { role: "system", content: base.instructions },
      { role: "user", content: expect.stringContaining("No summary was generated") },
      { role: "user", content: "New question" },
    ]);
    expect(result.history).toEqual([
      ...old,
      { role: "user", content: "New question" },
      { role: "assistant", content: "Answer" },
    ]);
    expect(result.newMessages).toEqual(result.history.slice(old.length));
    const loaded = await session.load({ signal: new AbortController().signal });
    expect(loaded.messages).toEqual(result.history);
    const resumed = await agent.resume(JSON.parse(JSON.stringify(result.snapshot)), {
      session,
      host: { authorizeResume },
    });
    expect(resumed.newMessages).toEqual(result.newMessages);
    expect((await session.load({ signal: new AbortController().signal })).messages).toEqual(
      loaded.messages,
    );
    expect(wire.requests).toHaveLength(1);
  });

  it("keeps call/result pairs and every unread steer verbatim at their original positions", async () => {
    const wire = fake([call(), text("Answer")]);
    const inbox = createMemoryInbox("steered-compaction");
    const first = "First correction ".repeat(20);
    const second = "Second correction ".repeat(20);
    const read = defineTool({
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      run: async () => {
        inbox.enqueue({ id: "first", content: first });
        inbox.enqueue({ id: "second", content: second });
        return "Large tool result ".repeat(50);
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: policy,
      tools: [read],
    });
    const result = await agent.run(input, { runId: "steered-compaction", host: { inbox } });
    expect(result.status).toBe("completed");
    const messages = wire.requests[1]?.messages ?? [];
    // Core may evict the whole tool round, but never keep an orphan result.
    for (const [index, message] of messages.entries()) {
      if (message.role !== "tool") continue;
      expect(
        messages
          .slice(0, index)
          .some(
            (item) =>
              item.role === "assistant" &&
              item.toolCalls?.some((call) => call.id === message.toolCallId),
          ),
      ).toBe(true);
    }
    expect(messages.slice(-2)).toEqual([
      { role: "user", content: first },
      { role: "user", content: second },
    ]);
    expect(result.snapshot.inputs.map((entry) => entry.beforeModel)).toEqual([1, 1]);
    expect(result.inputs.map((receipt) => receipt.status)).toEqual(["consumed", "consumed"]);
    expect(result.history.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(result.newMessages.slice(-3)).toEqual([
      { role: "user", content: first },
      { role: "user", content: second },
      { role: "assistant", content: "Answer" },
    ]);
    expect(
      (await agent.resume(result.snapshot, { host: { authorizeResume, inbox } })).history,
    ).toEqual(result.history);
  });

  it("keeps a large newest tool round even when it exceeds the requested tail budget", async () => {
    const wire = fake([call(), text("Answer")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: policy,
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          run: async () => "Large result ".repeat(100),
        }),
      ],
    });
    const result = await agent.run(input);
    expect(result.status).toBe("completed");
    expect(wire.requests[1]?.messages.slice(-2).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(result.snapshot.compactions).toHaveLength(2);
    expect((await agent.resume(result.snapshot, { host: { authorizeResume } })).status).toBe(
      "completed",
    );
  });

  it("uses reported input usage plus the new round rather than an old full-history estimate", async () => {
    const wire = fake([call(), text("Answer")]);
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      compaction: { ...policy, contextWindow: 40_000 },
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          run: async () => "x".repeat(40_000),
        }),
      ],
    }).run("Read");
    expect(result.status).toBe("completed");
    expect(result.snapshot.compactions[0]?.beforeModel).toBe(1);
  });

  it("counts paid summaries, applies guards and saves their output before the next model call", async () => {
    const summary = fake([text("Earlier facts")]);
    const wire = fake([text("Answer")]);
    const modelInputs = vi.fn(() => ({ allow: true as const }));
    const modelOutputs = vi.fn(() => ({ allow: true as const }));
    const events: unknown[] = [];
    let flushed = false;
    const checkpoints: RunSnapshot[] = [];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: {
        ...policy,
        summarize: {
          provider: summary.provider,
          instructions: "Summarize the earlier facts.",
          maxTokens: 40,
        },
      },
      guardrails: {
        identity: "summary-guards",
        modelInput: modelInputs,
        modelOutput: modelOutputs,
      },
    });
    const result = await agent.run(input, {
      onEvent: (event) => {
        events.push(event);
      },
      host: {
        progress: {
          push: () => {
            flushed = false;
          },
          flush: async () => {
            flushed = true;
          },
        },
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          expect(flushed).toBe(true);
          checkpoints.push(snapshot);
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(summary.requests).toHaveLength(1);
    expect(summary.requests[0]?.options).toMatchObject({
      maxAttempts: 1,
      maxTokens: 40,
      toolChoice: "none",
      hostedTools: [],
    });
    expect(summary.requests[0]?.messages[0]).toEqual({
      role: "system",
      content: "Summarize the earlier facts.",
    });
    expect(wire.requests[0]?.messages[1]?.content).toContain("Earlier facts");
    expect(result.usage).toMatchObject({ inputTokens: 16, outputTokens: 4 });
    expect(result.treeUsage).toEqual(result.usage);
    expect(result.receipts.filter((entry) => entry.kind === "model")).toHaveLength(2);
    expect(result.receipts).toContainEqual(
      expect.objectContaining({
        kind: "model",
        purpose: "compaction",
        billing: "reported",
        status: "completed",
      }),
    );
    expect(modelInputs).toHaveBeenCalledTimes(2);
    expect(modelOutputs).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain("Earlier facts");
    expect(
      checkpoints.some(
        (snapshot) =>
          snapshot.compactions[0]?.status === "completed" && snapshot.models.length === 0,
      ),
    ).toBe(true);
    expect((await agent.resume(result.snapshot, { host: { authorizeResume } })).status).toBe(
      "completed",
    );
    expect(summary.requests).toHaveLength(1);
  });

  it.each(["before-dispatch", "during-summary", "before-next-model"] as const)(
    "recovers %s without silently purchasing a summary twice",
    async (point) => {
      const summary = fake([text("Facts")]);
      const wire = fake([text("Answer")]);
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        recovery: { identity: "inference", inferenceOnly: true, maxAttempts: 3 },
        compaction: {
          ...policy,
          summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
        },
      });
      let checkpoint: RunSnapshot | undefined;
      const result = await agent.run(input, {
        host: {
          checkpoint: (snapshot) => {
            assertAgent(snapshot);
            const entry = snapshot.compactions[0];
            if (
              (point === "before-dispatch" && entry?.model) ||
              (point === "during-summary" && entry?.status === "completed") ||
              (point === "before-next-model" && snapshot.models.length > 0)
            )
              throw new Error("Worker lost");
            checkpoint = structuredClone(snapshot);
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(wire.requests).toHaveLength(0);
      const restored = await agent.resume(saved(checkpoint), { host: { authorizeResume } });
      if (point === "before-next-model") {
        expect(restored).toMatchObject({ status: "completed", output: "Answer" });
        expect(summary.requests).toHaveLength(1);
      } else {
        expect(restored).toMatchObject({
          status: "failed",
          error: { code: "interrupted_compaction" },
        });
        expect(summary.requests).toHaveLength(point === "before-dispatch" ? 0 : 1);
        if (point === "during-summary") expect(restored.usage).toMatchObject(usage);
      }
    },
  );

  it("reuses the same compacted input on interrupted inference recovery", async () => {
    const summary = fake([text("Facts")]);
    const wire = fake([text("Interrupted"), text("Answer")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      recovery: { identity: "inference", inferenceOnly: true, maxAttempts: 2 },
      compaction: {
        ...policy,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    let checkpoint: RunSnapshot | undefined;
    await agent.run(input, {
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          if (snapshot.models[0]?.status === "completed") throw new Error("Worker lost");
          checkpoint = structuredClone(snapshot);
        },
      },
    });
    const result = await agent.resume(saved(checkpoint), { host: { authorizeResume } });
    expect(result).toMatchObject({ status: "completed", output: "Answer" });
    expect(wire.requests[1]?.messages).toEqual(wire.requests[0]?.messages);
    expect(summary.requests).toHaveLength(1);
    expect(result.snapshot.compactions).toHaveLength(1);
    expect(result.snapshot.models[0]?.interrupted).toHaveLength(1);
  });

  it("refuses unusable paid summaries without trimming history or dispatching their tools", async () => {
    const summary = fake([call()]);
    const wire = fake([]);
    const effect = vi.fn(async () => "Do not run");
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          run: effect,
        }),
      ],
      compaction: {
        ...policy,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    const result = await agent.run(input);
    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_compaction" } });
    expect(result.history).toEqual(input.messages);
    expect(effect).not.toHaveBeenCalled();
    expect(wire.requests).toHaveLength(0);
    await agent.resume(result.snapshot, { host: { authorizeResume } });
    expect(summary.requests).toHaveLength(1);
  });

  it("counts a child's summary against shared model admissions and tree usage", async () => {
    const summary = fake([text("Facts")]);
    const childWire = fake([]);
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      compaction: {
        ...policy,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    const wire = fake([call()]);
    const parent = defineAgent({
      ...base,
      provider: wire.provider,
      treeLimits: { modelCalls: 2 },
      tools: [
        defineDelegation({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          specialists: [child],
          validate: (value) => value,
          run: async (_value, context) => {
            await context.child("child", child, input).join();
            return "Done";
          },
        }),
      ],
    });
    const result = await parent.run("Read");
    expect(result).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(childWire.requests).toHaveLength(0);
    expect(summary.requests).toHaveLength(1);
    expect(result.treeUsage).toMatchObject({ inputTokens: 16, outputTokens: 4 });
    expect((await parent.resume(result.snapshot, { host: { authorizeResume } })).treeUsage).toEqual(
      result.treeUsage,
    );
  });

  it("rejects changed cuts, dropped summary receipts and child-host rewrites", async () => {
    const wire = fake([text("Answer")]);
    const agent = defineAgent({ ...base, provider: wire.provider, compaction: policy });
    const result = await agent.run(input);
    const changed = structuredClone(result.snapshot);
    const entry = changed.compactions[0];
    if (!entry || entry.status !== "completed") throw new Error("Missing completed cut");
    entry.cut--;
    await expect(agent.resume(changed, { host: { authorizeResume } })).rejects.toThrow();
    const rewritten = structuredClone(result.snapshot);
    const rewrittenEntry = rewritten.compactions[0];
    if (!rewrittenEntry || rewrittenEntry.status !== "completed")
      throw new Error("Missing completed cut");
    rewrittenEntry.summary = "Changed";
    expect(() => checkChildProgress(result.snapshot, rewritten)).toThrow("compaction");
    await expect(
      agent.resume({ ...result.snapshot, compactions: undefined }, { host: { authorizeResume } }),
    ).rejects.toThrow("snapshot");
    const other = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: { ...policy, identity: "changed" },
    });
    await expect(other.resume(result.snapshot, { host: { authorizeResume } })).rejects.toThrow(
      "policy changed",
    );
  });

  it("does not load evicted media and never trims the only new user turn", async () => {
    const wire = fake([text("Answer"), text("Answer")]);
    const loadMedia = vi.fn(async () => "AQID");
    const agent = defineAgent({ ...base, provider: wire.provider, compaction: policy });
    const result = await agent.run(
      {
        messages: [
          { role: "user", content: [{ type: "media", id: "old-picture", mimeType: "image/png" }] },
          ...old,
          { role: "user", content: "New" },
        ],
      },
      { host: { loadMedia } },
    );
    expect(result.status).toBe("completed");
    expect(loadMedia).not.toHaveBeenCalled();
    const only = await agent.run("Only turn ".repeat(100));
    expect(only.snapshot.compactions).toEqual([]);
    expect(wire.requests[1]?.messages[1]?.content).toBe("Only turn ".repeat(100));
  });
});

describe("reactive compaction under pressure", () => {
  type Step = ProviderChunk[] | (() => AsyncIterable<ProviderChunk>);

  function scripted(steps: Step[]) {
    const requests: { messages: ChatMessage[]; options?: StreamOptions }[] = [];
    const provider: Provider = {
      id: "offline",
      model: "fake",
      async *createStream(messages, _tools, options) {
        const step = steps[requests.length];
        requests.push({ messages: structuredClone(messages), options });
        if (!step) throw new Error("Unexpected model call");
        if (typeof step === "function") yield* step();
        else yield* step;
      },
    };
    return { provider, requests };
  }

  function reject(error: () => ProviderError): Step {
    return () => ({
      [Symbol.asyncIterator]: () => ({
        async next() {
          throw error();
        },
      }),
    });
  }

  function rejectContext(message = "prompt is too long: 137500 tokens > 135000 maximum"): Step {
    return reject(() => new ProviderError("offline", "context", message, { status: 400 }));
  }

  const reactive = {
    identity: "reactive-1",
    contextWindow: 100_000,
    keepTokens: 5,
    retryOnContextLimit: true,
  } as const;

  it("folds once and retries on the same turn without spending a turn, reporting measured overflow", async () => {
    const wire = scripted([rejectContext(), text("Recovered")]);
    const onContextLimit = vi.fn();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: reactive,
      limits: { turns: 1 },
    });
    const result = await agent.run(input, { host: { onContextLimit } });
    expect(result).toMatchObject({ status: "completed", output: "Recovered" });
    expect(wire.requests).toHaveLength(2);
    expect(result.snapshot.models).toHaveLength(1);
    expect(result.snapshot.models[0]?.interrupted).toHaveLength(1);
    expect(result.receipts).toContainEqual(
      expect.objectContaining({ kind: "model", status: "context_rejected" }),
    );
    expect(result.receipts).toContainEqual(
      expect.objectContaining({ kind: "model", status: "completed" }),
    );
    expect(onContextLimit).toHaveBeenCalledWith({
      runId: result.runId,
      operationId: `${result.runId}/model/1`,
      provider: "offline",
      model: "fake",
      inputTokens: 137_500,
      contextLimit: 135_000,
    });
    expect(wire.requests[1]?.messages).toEqual([
      { role: "system", content: base.instructions },
      { role: "user", content: expect.stringContaining("No summary was generated") },
      { role: "user", content: "New question" },
    ]);
    expect((await agent.resume(result.snapshot, { host: { authorizeResume } })).status).toBe(
      "completed",
    );
  });

  it("retries at most once per run and fails if the shortened request is still rejected", async () => {
    const wire = scripted([rejectContext(), rejectContext()]);
    const onContextLimit = vi.fn();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: reactive,
    });
    const result = await agent.run(input, { host: { onContextLimit } });
    expect(result).toMatchObject({ status: "failed", error: { code: "model_failed" } });
    expect(wire.requests).toHaveLength(2);
    expect(onContextLimit).toHaveBeenCalledTimes(2);
    expect(result.snapshot.compactions).toHaveLength(1);
  });

  it("never retries a context rejection after output chunks were emitted or when hostedTools are configured", async () => {
    const partial = scripted([
      async function* () {
        yield { type: "delta", content: "Partial" };
        throw new ProviderError("offline", "context", "model_context_window_exceeded");
      },
    ]);
    const partialAgent = defineAgent({
      ...base,
      provider: partial.provider,
      compaction: reactive,
    });
    const partialResult = await partialAgent.run(input);
    expect(partialResult).toMatchObject({ status: "failed", error: { code: "model_failed" } });
    expect(partial.requests).toHaveLength(1);
    expect(partialResult.snapshot.compactions).toEqual([]);

    const hosted = scripted([rejectContext()]);
    const hostedAgent = defineAgent({
      ...base,
      provider: hosted.provider,
      compaction: reactive,
      modelSettings: { hostedTools: [{ type: "web_search" }] },
    });
    const hostedResult = await hostedAgent.run(input);
    expect(hostedResult).toMatchObject({ status: "failed", error: { code: "model_failed" } });
    expect(hosted.requests).toHaveLength(1);
    expect(hostedResult.snapshot.compactions).toEqual([]);
  });

  it("pins the run task through compaction cuts and keeps call/result pairs intact", async () => {
    const wire = scripted([call(), call(), rejectContext(), text("Finished")]);
    let count = 0;
    const read = defineTool({
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      run: async () => `Result ${++count} ` + "detail ".repeat(40),
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: reactive,
      tools: [read],
    });
    const result = await agent.run({
      messages: [...old, { role: "user", content: "Keep this exact task." }],
    });
    expect(result).toMatchObject({ status: "completed", output: "Finished" });
    const retried = wire.requests[3]?.messages ?? [];
    expect(retried[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("No summary was generated"),
    });
    expect(retried[2]).toEqual({ role: "user", content: "Keep this exact task." });
    for (const [index, message] of retried.entries()) {
      if (message.role !== "tool") continue;
      expect(
        retried
          .slice(0, index)
          .some(
            (item) =>
              item.role === "assistant" &&
              item.toolCalls?.some((toolCall) => toolCall.id === message.toolCallId),
          ),
      ).toBe(true);
    }
    expect((await agent.resume(result.snapshot, { host: { authorizeResume } })).status).toBe(
      "completed",
    );
  });

  it("prunes old tool text before paying for a summary when retryOnContextLimit is on", async () => {
    const summary = fake([text("Compact summary")]);
    const wire = scripted([call(), call(), call(), text("Done")]);
    const outputs = ["a".repeat(60_000), "b".repeat(60_000), "c".repeat(35_000)];
    const read = defineTool({
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      run: async () => outputs.shift()!,
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read],
      compaction: {
        identity: "prune-before-summary",
        contextWindow: 50_000,
        keepTokens: 5,
        retryOnContextLimit: true,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    const result = await agent.run("Read files");
    expect(result).toMatchObject({ status: "completed", output: "Done" });
    // Turn 2's 35k result trips A5's 120k text ceiling and prunes earlier tool results, keeping
    // the view under the 50k token window without buying a summary.
    expect(summary.requests).toHaveLength(0);
    expect(
      wire.requests[3]?.messages.some(
        (m) => m.role === "tool" && m.content.includes("Look it up again"),
      ),
    ).toBe(true);
  });

  it("falls back to the deterministic trim note when a paid summary is interrupted on restart", async () => {
    const summary = fake([text("Never saved")]);
    const wire = scripted([rejectContext(), text("Answered after trim")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: {
        ...reactive,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    let checkpoint: RunSnapshot | undefined;
    const crashed = await agent.run(input, {
      host: {
        checkpoint(node) {
          assertAgent(node);
          const entry = node.compactions[0];
          if (entry?.status === "completed") throw new Error("Worker lost");
          checkpoint = structuredClone(node);
        },
      },
    });
    expect(crashed.status).toBe("failed");
    expect(summary.requests).toHaveLength(1);
    expect(wire.requests).toHaveLength(1);
    const resumed = await agent.resume(saved(checkpoint), { host: { authorizeResume } });
    expect(resumed).toMatchObject({ status: "completed", output: "Answered after trim" });
    expect(summary.requests).toHaveLength(1);
    expect(wire.requests).toHaveLength(2);
    expect(wire.requests[1]?.messages[1]?.content).toContain("No summary was generated");
    expect(resumed.snapshot.compactions[0]).toMatchObject({
      status: "completed",
      interruptedSummary: true,
    });
    expect(resumed.receipts).toContainEqual(
      expect.objectContaining({ kind: "model", purpose: "compaction", status: "interrupted" }),
    );
    expect(resumed.usage).toMatchObject({ inputTokens: 16, outputTokens: 4 });
    checkChildProgress(saved(checkpoint), resumed.snapshot);
  });

  it("honors tree modelCalls budget and caller abort during context retry", async () => {
    const budgetWire = scripted([rejectContext(), text("Must not run")]);
    const budgetAgent = defineAgent({
      ...base,
      provider: budgetWire.provider,
      compaction: reactive,
      treeLimits: { modelCalls: 1 },
    });
    const limited = await budgetAgent.run(input);
    expect(limited).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(budgetWire.requests).toHaveLength(1);

    const controller = new AbortController();
    const abortWire = scripted([
      reject(() => {
        controller.abort("Stopped");
        return new ProviderError("offline", "context", "prompt is too long: 2000 > 1000");
      }),
      text("Must not run"),
    ]);
    const abortAgent = defineAgent({
      ...base,
      provider: abortWire.provider,
      compaction: reactive,
    });
    const cancelled = await abortAgent.run(input, { signal: controller.signal });
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(abortWire.requests).toHaveLength(1);
  });

  it("does not retry on context limit or change default behavior without retryOnContextLimit", async () => {
    const wire = scripted([rejectContext(), text("Must not run")]);
    const onContextLimit = vi.fn();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      compaction: { identity: "default-1", contextWindow: 100_000, keepTokens: 5 },
    });
    const result = await agent.run(input, { host: { onContextLimit } });
    expect(result).toMatchObject({ status: "failed", error: { code: "model_failed" } });
    expect(wire.requests).toHaveLength(1);
    expect(result.snapshot.compactions).toEqual([]);
    expect(onContextLimit).toHaveBeenCalledTimes(1);
  });
});
