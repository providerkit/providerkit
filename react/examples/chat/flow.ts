import { setTimeout as delay } from "node:timers/promises";
import { defineAgent, defineClientTool, defineHandoff, questionTool } from "@providerkit/agents";
import { defineTool, type Provider } from "@providerkit/core";
import { cardInput, cardResult, cardSchema, type DemoStats } from "./shared.ts";

/** Fixed providers exercise the SDK, without keys, remote services or model-written authority. */
export function requestAgent(stats: DemoStats, tickMs: number) {
  const makeCard = defineClientTool({
    name: "make_sample_card",
    description: "Create one fictional card in this local demo.",
    inputSchema: cardSchema,
    validate: cardInput,
    needsApproval: true,
    result: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, label: { type: "string" } },
        required: ["id", "label"],
        additionalProperties: false,
      },
      validate: cardResult,
    },
    summarize: (value) => `Created the sample card: ${value.label}`,
  });
  const wait = defineTool({
    name: "prepare_sample",
    description: "Wait so a person can send another message before the next model call.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: () => undefined,
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(_input, context) {
      stats.toolCalls++;
      await delay(tickMs * 40, undefined, { signal: context.signal });
      return "Sample ready.";
    },
  });
  const targetProvider: Provider = {
    id: "local-script",
    model: "visit-helper",
    async *createStream(messages, _tools, options) {
      stats.modelCalls++;
      if (!messages.some((message) => message.role === "tool" && message.name === wait.name)) {
        yield {
          type: "delta",
          toolCalls: [{ index: 0, id: "prepare", name: wait.name, arguments: "{}" }],
        };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }
      const text =
        "The visit helper now answers this conversation. Your questions and card result went through the SDK. Messages received before this call are included in its history. This fixed script does not interpret them. Nothing was booked or sent outside this demo.\n\nA message sent while this last paragraph arrives may remain waiting. It will not start another reply by itself.";
      for (let offset = 0; offset < text.length; offset += 12) {
        await delay(tickMs * 2, undefined, { signal: options?.signal });
        yield { type: "delta", content: text.slice(offset, offset + 12) };
      }
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const helper = defineAgent({
    id: "visit-helper",
    version: "1",
    instructions: "Use the fixed local script.",
    provider: targetProvider,
    tools: [wait],
  });
  const transfer = defineHandoff({
    name: "transfer_visit",
    description: "Let the registered visit helper finish the reply.",
    to: helper,
  });
  const question = questionTool();
  const provider: Provider = {
    id: "local-script",
    model: "request-guide",
    async *createStream(messages, _tools, options) {
      stats.modelCalls++;
      await delay(tickMs * 8, undefined, { signal: options?.signal });
      const tools = messages.filter((message) => message.role === "tool");
      yield { type: "delta", reasoning: "INTERNAL_ONLY_DEMO_REASONING" };
      if (!tools.some((message) => message.name === question.name)) {
        yield {
          type: "delta",
          toolCalls: [
            {
              index: 0,
              id: "time",
              name: question.name,
              arguments: JSON.stringify({
                message: "When would you like to visit?",
                choices: [
                  { id: "morning", label: "Morning" },
                  { id: "afternoon", label: "Afternoon" },
                ],
              }),
            },
            {
              index: 1,
              id: "note",
              name: question.name,
              arguments: JSON.stringify({
                message: "What should the sample plan mention?",
                freeText: true,
              }),
            },
          ],
        };
      } else if (!tools.some((message) => message.name === makeCard.name)) {
        yield {
          type: "delta",
          toolCalls: [
            {
              index: 0,
              id: "card",
              name: makeCard.name,
              arguments: JSON.stringify({ label: "Reading room visit" }),
            },
          ],
        };
      } else {
        yield {
          type: "delta",
          toolCalls: [
            {
              index: 0,
              id: "transfer",
              name: transfer.name,
              arguments: JSON.stringify({ note: "INTERNAL_ONLY_DEMO_HANDOFF_NOTE" }),
            },
          ],
        };
      }
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  return defineAgent({
    id: "request-guide",
    version: "1",
    instructions: "Follow the offline request script.",
    provider,
    tools: [question, makeCard, transfer],
    limits: { parallelTools: 2 },
  });
}
