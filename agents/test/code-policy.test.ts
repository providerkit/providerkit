import { describe, expect, it, vi } from "vitest";
import { defineTool, type Provider } from "@providerkit/core";
import { defineAgent } from "../src/run.ts";
import { codeMode, CODE_LIMITS, type CodeDriver } from "../src/code-mode.ts";
import { readSnapshot } from "../src/snapshot.ts";
import type { RunSnapshot } from "../src/types.ts";

function fixture(options: { calls?: number; isReadOnly?: boolean; name?: string } = {}) {
  const invoke = vi.fn(async () => 7);
  const name = options.name ?? "read";
  const tool = defineTool({
    name,
    description: "Read fixture data.",
    inputSchema: { type: "object" },
    isReadOnly: options.isReadOnly ?? true,
    run: invoke,
  });
  const drive = vi.fn<CodeDriver["run"]>(async (job) => {
    await job.call(name, "{}");
    return { ok: true, envelope: '{"ok":true,"value":7}' };
  });
  const provider: Provider = {
    id: "offline",
    model: "fixture",
    async *createStream(messages) {
      if (messages.at(-1)?.role === "tool") {
        yield { type: "finish", content: "Done", finishReason: "stop" };
      } else {
        yield {
          type: "finish",
          finishReason: "tool_calls",
          toolCalls: [
            {
              index: 0,
              id: "code",
              name: "run_code",
              arguments: JSON.stringify({ code: "return await tools.read({});" }),
            },
          ],
        };
      }
    },
  };
  const agent = defineAgent({
    id: "code-policy",
    version: "1",
    instructions: "Read, then answer.",
    provider,
    tools: [
      codeMode({
        tools: [tool],
        driver: { run: drive },
        limits: options.calls ? { calls: options.calls } : undefined,
      }),
    ],
  });
  return { agent, invoke, drive };
}

function archive(snapshot: RunSnapshot): RunSnapshot {
  const raw: unknown = JSON.parse(JSON.stringify(snapshot));
  return readSnapshot(raw, snapshot.agentId, snapshot.version, snapshot.limits);
}

describe("recorded code validation policy", () => {
  it("validates a plain archived journal without a driver or live tools", async () => {
    const { agent, invoke, drive } = fixture();
    const result = await agent.run("Work");
    expect(result.status).toBe("completed");
    expect(result.snapshot.definition.codeTools).toEqual({
      run_code: {
        name: "run_code",
        limits: CODE_LIMITS,
        tools: [{ name: "read", isReadOnly: true }],
      },
    });
    expect(archive(result.snapshot)).toEqual(result.snapshot);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it.each(["binding", "limit", "missing"] as const)(
    "refuses a corrupt archived %s policy",
    async (change) => {
      const { agent } = fixture();
      const result = await agent.run("Work");
      const changed = structuredClone(result.snapshot);
      const policy = changed.definition.codeTools?.run_code;
      if (!policy?.tools[0]) throw new Error("Missing code policy fixture");
      if (change === "binding") policy.tools[0].name = "other";
      else if (change === "limit") policy.limits.calls = 0;
      else delete changed.definition.codeTools;
      expect(() => archive(changed)).toThrow();
    },
  );

  it("does not turn coherent archived metadata into execution authority", async () => {
    const { agent, invoke, drive } = fixture();
    const result = await agent.run("Work");
    const changed = structuredClone(result.snapshot);
    const policy = changed.definition.codeTools?.run_code;
    if (!policy) throw new Error("Missing code policy fixture");
    policy.limits.calls++;
    // Structural reading is not proof that the host registered this policy.
    expect(() => archive(changed)).not.toThrow();
    await expect(agent.resume(changed, { host: { authorizeResume() {} } })).rejects.toThrow(
      "code bindings or limits changed",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it.each([{ calls: 33 }, { isReadOnly: false }, { name: "other" }])(
    "refuses changed live code registration %j even for a completed journal",
    async (options) => {
      const original = fixture();
      const result = await original.agent.run("Work");
      const current = fixture(options);
      await expect(
        current.agent.resume(result.snapshot, { host: { authorizeResume() {} } }),
      ).rejects.toThrow("code bindings or limits changed");
      expect(current.drive).not.toHaveBeenCalled();
      expect(current.invoke).not.toHaveBeenCalled();
    },
  );
});
