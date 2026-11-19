import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Provider, ProviderChunk } from "@providerkit/core";
// The main entry only: nothing in this file may load the A2A entry, or the checks it installs.
import { defineAgent } from "../src/index.ts";

function wire(...turns: ProviderChunk[][]) {
  let calls = 0;
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream() {
      const turn = turns[calls];
      calls += 1;
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return provider;
}

describe("main entry", () => {
  it("bundles no A2A code into an agent that never defines a remote agent", () => {
    const cache = join(homedir(), ".cache", "providerkit", "agents-main-entry");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "bundle-"));
    try {
      const fixture = fileURLToPath(new URL("./fixtures/main-entry-consumer.ts", import.meta.url));
      execFileSync(
        "bun",
        [
          "build",
          "--minify",
          "--target=browser",
          "--sourcemap=external",
          fixture,
          `--outdir=${directory}`,
        ],
        { stdio: "pipe" },
      );
      const output = join(directory, "main-entry-consumer.js");
      const map: { sources: string[] } = JSON.parse(readFileSync(`${output}.map`, "utf8"));
      // The remote node checks once came in through snapshot.ts: about 15 KB of A2A wire code
      // in every agent bundle, measured with esbuild at 92f8868.
      expect(map.sources.filter((source) => source.includes("/a2a/"))).toEqual([]);
      // An MV3 service worker cannot load code with import().
      expect(readFileSync(output, "utf8")).not.toMatch(/\bimport\s*\(/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a run tree with a remote agent this process never defined", async () => {
    const child = defineAgent({
      id: "child",
      version: "1",
      instructions: "Review.",
      provider: wire([
        { type: "delta", content: "Reviewed" },
        { type: "finish", finishReason: "stop" },
      ]),
    });
    const parent = defineAgent({
      id: "parent",
      version: "1",
      instructions: "Ask the reviewer.",
      provider: wire(
        [
          {
            type: "delta",
            toolCalls: [{ index: 0, id: "call-1", name: "review", arguments: '{"input":"x"}' }],
          },
          { type: "finish", finishReason: "tool_calls" },
        ],
        [
          { type: "delta", content: "Done" },
          { type: "finish", finishReason: "stop" },
        ],
      ),
      tools: [child.asTool({ name: "review", description: "Review." })],
    });
    const done = await parent.run("Review");
    const journal = done.snapshot.delegations[0]?.children[0];
    if (!journal) throw new Error("Expected a child journal");
    // A remote node can only come from defineRemoteAgent, which this process never called.
    Reflect.set(journal.snapshot, "kind", "remote");
    await expect(
      parent.resume(done.snapshot, { host: { authorizeResume: vi.fn() } }),
    ).rejects.toThrow("defineRemoteAgent");
  });
});
