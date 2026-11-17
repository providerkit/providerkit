import { setTimeout as delay } from "node:timers/promises";
import { defineAgent, defineDelegation } from "@providerkit/agents";
import { defineTool, type Provider } from "@providerkit/core";
import type { SourcePart } from "@providerkit/react/protocol";
import type { DemoStats } from "./shared.ts";

export const sources: readonly SourcePart[] = [
  {
    type: "source",
    id: "sample-note",
    marker: "1",
    title: "Sample meeting note",
    snippet: "Synthetic record: the reading room opens at 10:00. Bring a notebook.",
  },
  {
    type: "source",
    id: "sample-checklist",
    marker: "2",
    title: "Sample visit checklist",
    snippet: "Synthetic record: check the opening time, then pack a notebook. No booking needed.",
  },
];

const answer = `## A short plan for your visit

This is a scripted example, not a live answer. The two sample records agree: the reading room opens at **10:00**, and you should bring a notebook. [1] [2]

1. Check the opening time.
2. Pack a notebook.
3. Choose what you want to read.

### A small code example

Copy this code to see the code block's copy action:

\`\`\`ts
const openingTime = "10:00";
console.log(openingTime);
\`\`\`

### What the two checks found

| Check | Sample result |
| --- | --- |
| Opening time | Both notes say 10:00 |
| What to bring | A notebook |
| Booking | Not needed in this fictional example |

The source buttons open records supplied by this local example. They are not web search results. An attachment shows that you uploaded a file, but this script never reads its contents.

### Keep reading while this arrives

Scroll up to the opening lines while the reply is still being written. New text should not pull you away. Use **Jump to latest** when you want to catch up.

The reply keeps running on the local server if you close its read-only view or reload this page. Reconnect catches up with that same reply; it does not ask the script to start again.

> Stopping is a separate action. It ends the current script, not the conversation.

You can send another message when this reply finishes. Every message gets the same sample answer, so you can compare the UI states without calling a model.
`;

/** No network calls. Each provider follows the same two-turn script using real SDK tools. */
export function scriptedAgent(counters: DemoStats, tickMs: number) {
  function provider(id: string, toolName: string, text: string): Provider {
    return {
      id: "local-script",
      model: id,
      async *createStream(messages, _tools, options) {
        counters.modelCalls += 1;
        await delay(tickMs * 8, undefined, { signal: options?.signal });
        if (!messages.some((message) => message.role === "tool" && message.name === toolName)) {
          // Deliberately private synthetic fields let the runtime check detect projection leaks.
          yield { type: "delta", reasoning: "INTERNAL_ONLY_DEMO_REASONING" };
          if (id === "guide")
            yield {
              type: "delta",
              content: "I’ll check the two sample records before writing the plan.\n\n",
            };
          yield {
            type: "delta",
            toolCalls: [
              {
                index: 0,
                id: `call-${id}`,
                name: toolName,
                arguments: '{"note":"INTERNAL_ONLY_DEMO_ARGUMENT"}',
              },
            ],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        for (let offset = 0; offset < text.length; offset += 24) {
          await delay(tickMs, undefined, { signal: options?.signal });
          yield { type: "delta", content: text.slice(offset, offset + 24) };
        }
        yield { type: "finish", finishReason: "stop" };
      },
    };
  }

  function specialist(id: string, name: string) {
    const read = defineTool({
      name,
      description: "Read a fixed sample record.",
      inputSchema: { type: "object", properties: { note: { type: "string" } } },
      validate: () => undefined,
      isReadOnly: true,
      isConcurrencySafe: true,
      run: async (_input, context) => {
        counters.toolCalls += 1;
        await delay(tickMs * 20, undefined, { signal: context.signal });
        return "INTERNAL_ONLY_DEMO_RESULT";
      },
    });
    return defineAgent({
      id,
      version: "1",
      instructions: "Follow the local sample script. Do not call a network service.",
      provider: provider(id, name, "INTERNAL_ONLY_DEMO_SPECIALIST_TEXT"),
      tools: [read],
    });
  }

  const facts = specialist("facts", "read_sample");
  const format = specialist("format", "check_format");
  const review = defineDelegation({
    name: "review_sample",
    description: "Check the sample with two specialists.",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
    validate: () => undefined,
    specialists: [facts, format],
    async run(_input, context) {
      const children = await context.join([
        context.child("facts", facts, "Check the fixed opening-time record."),
        context.child("format", format, "Check the fixed visit checklist."),
      ]);
      return children.map((child) => child.status);
    },
    summarize: () => "The two sample checks finished.",
  });
  return defineAgent({
    id: "guide",
    version: "1",
    instructions: "Follow the local sample script. This is not a live assistant.",
    provider: provider("guide", review.name, answer),
    tools: [review],
    treeLimits: { maxParallel: 3, modelCalls: 8 },
  });
}
