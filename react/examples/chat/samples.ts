import type { DisplayMessage } from "@providerkit/react/protocol";

export const fixtureMessageId = "host-sample-fixtures";
export const sampleToolId = "host-sample-tool";
export const sampleImageId = "host-sample-image";
export const hiddenSample = "HIDDEN_CUSTOM_PART_SAMPLE";
export const pasteText = "Sample paste: bring a notebook.";
export const historyPageSize = 4;

/** Fixed older messages, not previous model runs. IDs and text stay the same on every request. */
export const earlierMessages: readonly DisplayMessage[] = [
  "Which room is this sample about?",
  "The fictional reading room. These older messages are generated fixtures, not a real person's history.",
  "What time does the sample room open?",
  "The sample note says 10:00. This is not a real opening time. Check the venue before planning a visit.",
  "What should I bring in this example?",
  "Bring a notebook. There is no booking or payment in this demo, and these messages do not run a model.",
  "Can I keep reading an older message?",
  "Yes. Loading earlier messages should leave this line in the same place. Use Jump to latest only when you want to move to the end.",
].map((text, index) => ({
  id: `sample-history-${index + 1}`,
  role: index % 2 === 0 ? "user" : "assistant",
  state: "settled",
  parts: [{ type: "text", id: "text", text, settled: true }],
}));

export function sampleFixtures(origin: string): DisplayMessage {
  return {
    id: fixtureMessageId,
    role: "assistant",
    state: "settled",
    parts: [
      {
        type: "text",
        id: "intro",
        text: "## Local display samples\n\nThese fixtures were added by the demo host. No model ran and no uploaded content is shown below.",
        settled: true,
      },
      {
        type: "tool",
        id: sampleToolId,
        label: "Check the sample room",
        state: "done",
        summary: "The fictional room opens at 10:00.",
        detail:
          "Generated sample record\nOpening time: 10:00\nBring: a notebook\nBooking: none\n\nThese are host-written display fields, not SDK arguments or results.",
      },
      {
        type: "attachment",
        id: sampleImageId,
        name: "Generated notebook image",
        mediaType: "image/png",
      },
      {
        type: "data",
        id: "unknown-sample",
        kind: "unhandled-sample",
        data: { note: hiddenSample },
      },
      {
        type: "text",
        id: "reading-anchor",
        text: `### A line to keep in view\n\nKeep this paragraph in view while the generated image loads or changes size above it. The image is a local drawing made for this demo, not an upload.\n\n### Try a safe link\n\n[Open the local sample page](${origin}/sample-link). It opens a new tab on this same local server. Your draft stays in this tab.\n\nThis [blocked script link](javascript:void%280%29) must stay plain text, with no link to focus or activate.\n\nThe host also included an unknown custom data part with harmless test text. The default renderer must leave it hidden.\n\n### End of the samples\n\nNothing was sent, booked or charged. You can still send a message to run the separate scripted reply.`,
        settled: true,
      },
    ],
  };
}
