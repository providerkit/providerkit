import assert from "node:assert/strict";
import type { AgentHost } from "../src/types.ts";
import { defineAgent } from "../src/run.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { isRecord } from "../src/snapshot.ts";

const writer = defineAgent({
  id: "offline-writer",
  version: "1",
  instructions: "Write a short draft.",
  provider: {
    id: "offline",
    model: "fixture",
    async *createStream() {
      yield {
        type: "delta",
        content: "An index helps a database find rows.",
        finishReason: "stop",
      };
    },
  },
});
const report = defineWorkflow({
  id: "report",
  version: "1",
  input: {
    schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    validate(raw) {
      if (!isRecord(raw) || typeof raw.topic !== "string") throw new TypeError("Provide a topic.");
      return { topic: raw.topic };
    },
  },
  agents: [writer],
  async run({ topic }, ctx) {
    const draft = await ctx.agent("draft", writer, topic);
    if (draft.status !== "completed") throw new Error("The writer did not finish.");
    const title = await ctx.ask(
      { key: "title", message: "What title should this use?" },
      (answer) => {
        if (!answer.text) throw new TypeError("Provide a title.");
        return answer.text;
      },
    );
    return ctx.step("format", () => `${title}\n${draft.output}`, {
      input: { title, draft: draft.output },
    });
  },
});
// Fixture authority only. A real host checks authenticated ownership and its current lease.
const host = {
  authorizeResume() {},
  beforeTool() {},
  beforeStep() {},
  prepareRequest: () => ({
    scope: {
      actorId: "fixture",
      resource: { id: "report", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
  resolveRequest(_request, evidence) {
    if (evidence !== "offline-fixture-claim") throw new Error("Unknown fixture evidence.");
    return { type: "answer", answer: { text: "Database indexes" } };
  },
} satisfies AgentHost;
const waiting = await report.run({ topic: "Database indexes" }, { host });
assert.equal(waiting.status, "suspended");
if (waiting.status !== "suspended" || !waiting.requests[0]) throw new Error("Missing question.");
const done = await report.resume(JSON.parse(JSON.stringify(waiting.snapshot)), {
  host,
  answers: { [waiting.requests[0].id]: "offline-fixture-claim" },
});
assert.equal(done.status, "completed");
if (done.status === "completed") console.log(done.output);
