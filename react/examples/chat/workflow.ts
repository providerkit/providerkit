import { setTimeout as delay } from "node:timers/promises";
import { defineAgent } from "@providerkit/agents";
import { defineWorkflow } from "@providerkit/agents/workflow";
import type { Provider } from "@providerkit/core";
import { cardInput, cardSchema, type DemoStats } from "./shared.ts";

/** A real mixed execution tree with fixed providers. It never contacts a model or creates a card. */
export function workflowAgent(stats: DemoStats, tickMs: number) {
  const checker = defineAgent({
    id: "workflow-checker",
    version: "1",
    instructions: "Follow the offline script.",
    provider: {
      id: "local-script",
      model: "workflow-checker",
      async *createStream() {
        stats.modelCalls++;
        yield { type: "delta", content: "INTERNAL_ONLY_DEMO_WORKFLOW_CHECK" };
        yield { type: "finish", finishReason: "stop" };
      },
    },
  });
  const workflow = defineWorkflow({
    id: "visit-workflow",
    version: "1",
    input: { schema: cardSchema, validate: cardInput },
    agents: [checker],
    async run(input, context) {
      await context.agent("check", checker, "Check the fictional visit plan.");
      await context.ask(
        {
          key: "time",
          message: "When would you like to visit?",
          choices: [
            { id: "morning", label: "Morning" },
            { id: "afternoon", label: "Afternoon" },
          ],
        },
        (answer) => answer.choices?.[0],
      );
      await context.step(
        "label",
        async ({ input, signal, report }) => {
          stats.toolCalls++;
          report("INTERNAL_ONLY_DEMO_WORKFLOW_PROGRESS");
          await delay(tickMs * 8, undefined, { signal });
          return { label: input.label, private: "INTERNAL_ONLY_DEMO_WORKFLOW_RESULT" };
        },
        { input, needsApproval: true, validateInput: cardInput },
      );
      await context.sleep("pause", 5000);
      return "The fictional visit plan was checked. No card was created.";
    },
  });
  const tool = workflow.asTool({
    name: "check_visit_plan",
    description: "Check a fictional visit plan.",
  });
  const provider: Provider = {
    id: "local-script",
    model: "workflow-guide",
    async *createStream(messages) {
      stats.modelCalls++;
      if (!messages.some((message) => message.role === "tool" && message.name === tool.name)) {
        yield {
          type: "delta",
          toolCalls: [
            {
              index: 0,
              id: "workflow",
              name: tool.name,
              arguments: JSON.stringify({ label: "Reading room visit" }),
            },
          ],
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield {
          type: "delta",
          content: "No card was created and nothing was booked.",
        };
        yield { type: "finish", finishReason: "stop" };
      }
    },
  };
  return defineAgent({
    id: "workflow-guide",
    version: "1",
    instructions: "Follow the offline script.",
    provider,
    tools: [tool],
  });
}
