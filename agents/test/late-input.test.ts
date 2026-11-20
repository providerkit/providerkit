import { describe, expect, it } from "vitest";
import type { ChatMessage, Provider, ProviderChunk } from "@providerkit/core";
import { createMemoryInbox, defineAgent, type RunSnapshot } from "../src/index.ts";
import { assertAgent } from "./fixtures/assertions.ts";

const base = { id: "late-steer", version: "1", instructions: "Answer the user." };
const runId = "late-steer-run";
const usage = { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 };

const text = (content: string): ProviderChunk[] => [
  { type: "delta", content },
  { type: "usage", usage },
  { type: "finish", finishReason: "stop" },
];

function wire(
  turns: ProviderChunk[][],
  onTurn?: (position: number, messages: ChatMessage[]) => void | Promise<void>,
) {
  const sent: ChatMessage[][] = [];
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream(messages) {
      const position = sent.length;
      sent.push(structuredClone(messages));
      await onTurn?.(position, messages);
      const chunks = turns[position];
      if (!chunks) throw new Error("Unexpected model call");
      yield* chunks;
    },
  };
  return { sent, provider };
}

describe("steering.answerLateInput (opt-in late input turn)", () => {
  it("leaves late input queued for recall by default", async () => {
    const inbox = createMemoryInbox(runId);
    const model = wire([text("First answer"), text("Should not run")], (position) => {
      if (position === 0) inbox.enqueue({ id: "late-1", content: "Also mention caching." });
    });
    const agent = defineAgent({ ...base, provider: model.provider });

    const outcome = await agent.run("Explain indexes.", { runId, host: { inbox } });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") expect(outcome.output).toBe("First answer");
    expect(model.sent).toHaveLength(1);
    expect(inbox.list()[0]?.status).toBe("queued");
  });

  it("runs another turn to answer input queued while the model finished when enabled", async () => {
    const inbox = createMemoryInbox(runId);
    const model = wire([text("First answer"), text("Updated answer with caching")], (position) => {
      if (position === 0) inbox.enqueue({ id: "late-1", content: "Also mention caching." });
    });
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      steering: { answerLateInput: true },
    });

    const outcome = await agent.run("Explain indexes.", { runId, host: { inbox } });
    expect(outcome.status, JSON.stringify(outcome.snapshot.state)).toBe("completed");
    if (outcome.status === "completed") expect(outcome.output).toBe("Updated answer with caching");
    expect(model.sent).toHaveLength(2);
    expect(model.sent[1]).toMatchObject([
      { role: "system" },
      { role: "user", content: "Explain indexes." },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Also mention caching." },
    ]);
    expect(inbox.list()[0]?.status).toBe("consumed");
    expect(outcome.inputs).toEqual([
      expect.objectContaining({ id: "late-1", beforeModel: 1, status: "consumed" }),
    ]);
  });

  it("resumes cleanly if a crash happens right after accepting late input before the follow-up turn", async () => {
    const inbox = createMemoryInbox(runId);
    let saved: RunSnapshot | undefined;
    let crashNext = false;
    const model = wire([text("First answer"), text("Answered after resume")], (position) => {
      if (position === 0) {
        inbox.enqueue({ id: "late-1", content: "One more thing." });
        crashNext = true;
      }
    });
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      steering: { answerLateInput: true },
    });

    const first = await agent.run("Explain indexes.", {
      runId,
      host: {
        inbox,
        checkpoint(snapshot) {
          assertAgent(snapshot);
          saved = structuredClone(snapshot);
          if (crashNext && snapshot.inputs.length > 0) {
            crashNext = false;
            throw new Error("Worker crashed after accepting late input");
          }
        },
      },
    });
    expect(first.status).toBe("failed");
    expect(saved?.inputs).toHaveLength(1);
    expect(saved?.models).toHaveLength(1);

    const resumed = await agent.resume(saved, {
      host: { inbox, authorizeResume: () => {} },
    });
    expect(resumed.status, JSON.stringify(resumed.snapshot.state)).toBe("completed");
    if (resumed.status === "completed") expect(resumed.output).toBe("Answered after resume");
    expect(model.sent).toHaveLength(2);
    expect(inbox.list()[0]?.status).toBe("consumed");
  });

  it("leaves late input queued when no turn budget remains instead of turning a completed answer into limited", async () => {
    const inbox = createMemoryInbox(runId);
    const model = wire([text("First answer"), text("Should not run")], (position) => {
      if (position === 0) inbox.enqueue({ id: "late-1", content: "One more thing." });
    });
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      limits: { turns: 1 },
      treeLimits: { modelCalls: 1 },
      steering: { answerLateInput: true },
    });

    const outcome = await agent.run("Explain indexes.", { runId, host: { inbox } });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") expect(outcome.output).toBe("First answer");
    expect(model.sent).toHaveLength(1);
    expect(inbox.list()[0]?.status).toBe("queued");
  });

  it("rejects invalid steering configuration", () => {
    const { provider } = wire([]);
    expect(() =>
      defineAgent({
        ...base,
        provider,
        steering: { answerLateInput: "yes" as unknown as boolean },
      }),
    ).toThrow(TypeError);
    expect(() =>
      defineAgent({
        ...base,
        provider,
        steering: { extra: true } as unknown as { answerLateInput?: boolean },
      }),
    ).toThrow(TypeError);
  });
});
