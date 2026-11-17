import { trace, ROOT_CONTEXT, type Attributes, type Tracer } from "@opentelemetry/api";
import { defineTool, type Provider } from "@providerkit/core";
import { defineAgent } from "../src/index.ts";
import { createAgentTracing } from "../src/otel.ts";

// Run with: bun agents/examples/otel.ts
// Published imports: @providerkit/agents and @providerkit/agents/otel.
// Offline only. This tiny tracer records locally; it is not an exporter or OTel SDK.
// In your app, pass its configured tracer or omit tracer to use the registered one.
const records: {
  name: string;
  parent?: string;
  status?: number;
  ended: boolean;
  attributes: Attributes;
}[] = [];
const tracer: Tracer = {
  startSpan(name, options, parent = ROOT_CONTEXT) {
    const parentSpan = trace.getSpanContext(parent);
    const record = {
      name,
      parent: parentSpan?.spanId,
      ended: false,
      attributes: { ...options?.attributes },
      status: 0,
    };
    records.push(record);
    const span = trace.wrapSpanContext({
      traceId: parentSpan?.traceId ?? "1".repeat(32),
      spanId: records.length.toString(16).padStart(16, "0"),
      traceFlags: 1,
    });
    span.setAttributes = (attributes) => {
      Object.assign(record.attributes, attributes);
      return span;
    };
    span.setStatus = (status) => {
      record.status = status.code;
      return span;
    };
    span.end = () => {
      record.ended = true;
    };
    return span;
  },
  startActiveSpan(): never {
    throw new Error("This observer uses explicit parent contexts.");
  },
};
const provider: Provider = {
  id: "offline",
  model: "recorded",
  async *createStream(messages) {
    if (messages.some((message) => message.role === "tool")) {
      yield { type: "delta", content: "There are two matches." };
      yield { type: "finish", finishReason: "stop" };
    } else {
      yield {
        type: "delta",
        toolCalls: [{ index: 0, id: "read-1", name: "read", arguments: "{}" }],
      };
      yield { type: "finish", finishReason: "tool_calls" };
    }
    // No usage event: tracing must not turn missing measurements into a zero bill.
  },
};
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Read the count, then answer.",
  provider,
  tools: [
    defineTool({
      name: "read",
      description: "Read the sample count.",
      inputSchema: { type: "object" },
      isReadOnly: true,
      run: async () => "Two matches",
    }),
  ],
});
const tracing = createAgentTracing({ tracer, attributes: () => ({ example: "offline" }) });
try {
  const result = await reader.run("Count the matches.", tracing.options());
  if (result.status !== "completed") throw new Error(`Run ended: ${result.status}`);
  if (records.length !== 6 || records.some((record) => !record.ended))
    throw new Error(
      "Expected six closed spans: one run, two model operations, two provider calls and one tool.",
    );
  console.log(records);
} finally {
  // Always close when the host scope ends, including errors or missing callbacks.
  tracing.close();
}

// Model/tool spans end before output guards. Their "returned" outcome is not approval.
// Core activates context around provider iterator calls. Tool hooks remain observers, so
// HTTP calls inside tools need the host's own instrumentation and context manager.
// Configure exporters in the host. Raw prompts, results and errors never enter these spans.
