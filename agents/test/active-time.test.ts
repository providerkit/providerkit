import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent, type AgentHost, type Decision, type RunOutcome } from "../src/index.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "active-time", version: "1", instructions: "Act promptly." };
const usage = { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 };

function calls(...names: string[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: names.map((name, index) => ({
        index,
        id: `wire-${index}`,
        name,
        arguments: "{}",
      })),
    },
    { type: "finish", finishReason: "tool_calls", usage },
  ];
}

const text: ProviderChunk[] = [{ type: "finish", finishReason: "stop", content: "Done", usage }];

function pending<T>(result: RunOutcome<T>) {
  expect(result.status, JSON.stringify(result.snapshot.state)).toBe("suspended");
  if (result.status !== "suspended") throw new Error(JSON.stringify(result));
  return result;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function host(
  overrides: Partial<AgentHost> = {},
): AgentHost & { authorizeResume: NonNullable<AgentHost["authorizeResume"]> } {
  return {
    authorizeResume: vi.fn(() => {}),
    prepareRequest: vi.fn(() => ({
      scope: {
        actorId: "person",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 86_400_000,
      },
    })),
    resolveRequest: vi.fn(() => ({ type: "approve" }) satisfies Decision),
    beforeTool: vi.fn(() => {}),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("limits.activeMs", () => {
  it("stops an attempt that exceeds activeMs while elapsedMs still has room", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      id: "fake",
      model: "fake",
      async *createStream(_messages, _tools, options) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
        yield* text;
      },
    };
    const agent = defineAgent({
      ...base,
      provider,
      limits: { elapsedMs: 60_000, activeMs: 100 },
      treeLimits: { elapsedMs: 60_000 },
    });

    const running = agent.run("Work");
    await vi.advanceTimersByTimeAsync(120);
    const outcome = await running;
    expect(outcome.status).toBe("limited");
    if (outcome.status === "limited") expect(outcome.limit).toBe("activeMs");
  });

  it("pauses activeMs while host.answerNow waits for a person in process", async () => {
    vi.useFakeTimers();
    const turn1Ready = deferred();
    const turn1Done = deferred();
    const turn2Ready = deferred();
    const turn2Done = deferred();
    let turns = 0;
    const provider: Provider = {
      id: "fake",
      model: "fake",
      async *createStream() {
        const index = turns++;
        if (index === 0) {
          turn1Ready.resolve();
          await turn1Done.promise;
          yield* calls("write");
        } else {
          turn2Ready.resolve();
          await turn2Done.promise;
          yield* text;
        }
      },
    };
    const effect = vi.fn(async () => "Written");
    const write = defineTool({
      name: "write",
      description: "Write a record.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: effect,
    });
    const agent = defineAgent({
      ...base,
      provider,
      tools: [write],
      limits: { elapsedMs: 60_000, activeMs: 150 },
      treeLimits: { elapsedMs: 60_000 },
    });

    const answerEntered = deferred();
    const answerDecision = deferred<Decision>();
    let answerSignal: AbortSignal | undefined;
    const policy = host({
      answerNow(_request, { signal }) {
        answerSignal = signal;
        answerEntered.resolve();
        return answerDecision.promise;
      },
    });

    // Two model turns take 40ms + 40ms = 80ms active time (under 150ms), while the in-process
    // human wait lasts 500ms (well over 150ms). The run completes because answerNow pauses activeMs.
    const running = agent.run("Write", { host: policy });
    await turn1Ready.promise;
    await vi.advanceTimersByTimeAsync(40);
    turn1Done.resolve();

    await answerEntered.promise;
    await vi.advanceTimersByTimeAsync(500);
    answerDecision.resolve({ type: "approve" });

    await turn2Ready.promise;
    await vi.advanceTimersByTimeAsync(40);
    turn2Done.resolve();

    const settled = await running;
    expect(settled.status, JSON.stringify(settled.snapshot.state)).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(answerSignal).toBeInstanceOf(AbortSignal);
    expect(answerSignal?.aborted).toBe(false);
  });

  it("still aborts an in-process answerNow wait when elapsedMs fires", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      id: "fake",
      model: "fake",
      async *createStream() {
        yield* calls("write");
      },
    };
    const write = defineTool({
      name: "write",
      description: "Write a record.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: async () => "Written",
    });
    const agent = defineAgent({
      ...base,
      provider,
      tools: [write],
      limits: { elapsedMs: 250, activeMs: 100 },
      treeLimits: { elapsedMs: 60_000 },
    });

    const answerEntered = deferred();
    let waitSignalAborted = false;
    const policy = host({
      answerNow(_request, { signal }) {
        answerEntered.resolve();
        return new Promise<Decision>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              waitSignalAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });

    const running = agent.run("Write", { host: policy });
    await answerEntered.promise;
    await vi.advanceTimersByTimeAsync(150);
    expect(waitSignalAborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    const outcome = await running;
    expect(waitSignalAborted).toBe(true);
    expect(outcome.status).toBe("limited");
    if (outcome.status === "limited") expect(outcome.limit).toBe("elapsedMs");
  });

  it("never counts time suspended between attempts and starts each resume with a fresh activeMs allowance", async () => {
    vi.useFakeTimers();
    const turn1Ready = deferred();
    const turn1Done = deferred();
    const turn2Ready = deferred();
    const turn2Done = deferred();
    let turns = 0;
    const provider: Provider = {
      id: "fake",
      model: "fake",
      async *createStream() {
        const index = turns++;
        if (index === 0) {
          turn1Ready.resolve();
          await turn1Done.promise;
          yield* calls("write");
        } else {
          turn2Ready.resolve();
          await turn2Done.promise;
          yield* text;
        }
      },
    };
    const effect = vi.fn(async () => "Written");
    const write = defineTool({
      name: "write",
      description: "Write a record.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: effect,
    });
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const agent = defineAgent({
      ...base,
      provider,
      tools: [write],
      limits: { elapsedMs: sevenDaysMs, activeMs: 120 },
      treeLimits: { elapsedMs: sevenDaysMs },
    });
    const policy = host({
      prepareRequest: vi.fn(() => ({
        scope: {
          actorId: "person",
          resource: { id: "record", version: "1" },
          expiresAt: Date.now() + sevenDaysMs,
        },
      })),
    });

    const start = agent.run("Write", { host: policy });
    await turn1Ready.promise;
    await vi.advanceTimersByTimeAsync(80);
    turn1Done.resolve();
    const waiting = pending(await start);

    // Three days pass while the run sits suspended waiting for approval.
    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // Resuming gets a fresh 120ms activeMs allowance (80ms second turn completes cleanly).
    const resumed = agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "approve"),
    });
    await turn2Ready.promise;
    await vi.advanceTimersByTimeAsync(80);
    turn2Done.resolve();
    const settled = await resumed;
    expect(settled.status, JSON.stringify(settled.snapshot.state)).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("validates activeMs bounds", () => {
    const provider: Provider = {
      id: "fake",
      model: "fake",
      async *createStream() {
        yield* text;
      },
    };
    expect(() => defineAgent({ ...base, provider, limits: { activeMs: 0 } })).toThrow(TypeError);
    expect(() => defineAgent({ ...base, provider, limits: { activeMs: -10 } })).toThrow(TypeError);
    expect(() => defineAgent({ ...base, provider, limits: { activeMs: 2_147_483_648 } })).toThrow(
      TypeError,
    );
  });
});
