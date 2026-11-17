// Run with: bun agents/examples/structured-handoff.ts. No network or API key needed.
import type { Provider } from "@providerkit/core";
import { defineAgent, defineHandoff, type Agent } from "../src/index.ts";

type Summary = { kind: "summary"; summary: string };
type InvoiceCount = { kind: "count"; count: number };

function scriptedProvider(name: string, args: Record<string, unknown>): Provider {
  return {
    id: "offline",
    model: name,
    async *createStream() {
      yield {
        type: "delta",
        toolCalls: [{ index: 0, id: name, name, arguments: JSON.stringify(args) }],
      };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

const counter = defineAgent({
  id: "counter",
  version: "1",
  instructions: "Count open invoices and submit the count.",
  provider: scriptedProvider("submit_result", { count: 3 }),
  output: {
    schema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 0 } },
      required: ["count"],
    },
    validate(value): InvoiceCount {
      if (
        typeof value !== "object" ||
        value === null ||
        !("count" in value) ||
        typeof value.count !== "number" ||
        !Number.isSafeInteger(value.count) ||
        value.count < 0
      )
        throw new Error("Return a non-negative whole count.");
      return { kind: "count", count: value.count };
    },
  },
});

const help = defineAgent({
  id: "help",
  version: "1",
  instructions: "For invoice counts, transfer to counter. Otherwise submit a summary.",
  provider: scriptedProvider("transfer", {}),
  tools: [
    defineHandoff({ name: "transfer", description: "Let counter count invoices.", to: counter }),
  ],
  output: {
    schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
    validate(value): Summary {
      if (
        typeof value !== "object" ||
        value === null ||
        !("summary" in value) ||
        typeof value.summary !== "string"
      )
        throw new Error("Return a summary string.");
      return { kind: "summary", summary: value.summary };
    },
  },
});

// Inferred without a cast. The counter stays Agent<InvoiceCount> when called directly.
const source: Agent<Summary | InvoiceCount> = help;
const result = await source.run("Count open invoices.");
if (result.status !== "completed") throw new Error(`Run ended with ${result.status}.`);
// The output's tag narrows the union. activeAgent identifies who owns the next turn.
if (
  result.output.kind !== "count" ||
  result.output.count !== 3 ||
  result.activeAgent.id !== "counter"
)
  throw new Error("Expected the counter's checked result.");

const resumed = await source.resume(result.snapshot, { host: { authorizeResume() {} } });
if (resumed.status !== "completed" || resumed.output.kind !== "count" || resumed.output.count !== 3)
  throw new Error("Resume did not restore the counter's result.");
console.log(
  `${result.output.count} open invoices. The next turn belongs to ${result.activeAgent.id}.`,
);
