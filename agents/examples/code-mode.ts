import assert from "node:assert/strict";
import { defineTool, type Provider } from "@providerkit/core";
import { defineAgent } from "../src/index.ts";
// Source entries keep this example runnable before a build. Published imports use
// @providerkit/agents/code-mode and @providerkit/agents/code-mode/quickjs.
import { codeMode } from "../src/code-mode.ts";
import { createQuickJsDriver } from "../src/quickjs.ts";

const prices = defineTool({
  name: "prices",
  description: "Read two offline prices.",
  inputSchema: { type: "object" },
  outputSchema: { type: "array", items: { type: "number" } },
  isReadOnly: true,
  async run() {
    return [4, 7];
  },
});
const discount = defineTool({
  name: "discount",
  description: "Read the offline discount amount.",
  inputSchema: { type: "object" },
  outputSchema: { type: "number" },
  isReadOnly: true,
  async run() {
    return 2;
  },
});

let turn = 0;
const provider: Provider = {
  id: "offline",
  model: "fixture",
  async *createStream(messages) {
    if (turn++ === 0) {
      yield {
        type: "finish",
        finishReason: "tool_calls",
        toolCalls: [
          {
            index: 0,
            id: "total",
            name: "run_code",
            arguments: JSON.stringify({
              code: "const values = await tools.prices({}); const less = await tools.discount({}); return values.reduce((sum, price) => sum + price, 0) - less;",
            }),
          },
        ],
      };
      return;
    }
    const response = messages.at(-1);
    assert.equal(response?.role, "tool");
    if (response?.role !== "tool") throw new Error("Missing program result.");
    const result: unknown = JSON.parse(response.content);
    assert.deepEqual(result, { result: 9, logs: "", toolCalls: 2, toolCallsLeft: 28 });
    yield { type: "finish", finishReason: "stop", content: "Total: 9." };
  },
};
const reader = defineAgent({
  id: "offline-total",
  version: "1",
  instructions: "Read the prices and discount, then return the total.",
  provider,
  tools: [codeMode({ tools: [prices, discount], driver: createQuickJsDriver() })],
});

const result = await reader.run("Add the prices and subtract the discount.");
assert.equal(result.status, "completed");
if (result.status !== "completed") throw new Error("The offline calculation did not finish.");
assert.equal(result.output, "Total: 9.");
assert.equal(
  result.receipts.filter((receipt) => receipt.kind === "tool" && receipt.parentOperationId).length,
  2,
);
console.log(result.output);
