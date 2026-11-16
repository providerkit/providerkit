import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { useChat, useComposer } from "@providerkit/react";
import { Composer, Conversation, MessageList, SpecialistActivity } from "@providerkit/react/ui";
import { parseChatEvent, type DisplayMessage } from "@providerkit/react/protocol";

const messages: DisplayMessage[] = [
  {
    id: "answer",
    role: "assistant",
    state: "settled",
    parts: [
      { type: "text", id: "text", text: "A saved answer.", settled: true },
      { type: "data", id: "private-card", kind: "custom", data: { hidden: "not-public" } },
    ],
  },
];

describe("public UI composition", () => {
  it("renders the hooks and controlled components without a browser or stylesheet", () => {
    expect(typeof globalThis.window).toBe("undefined");

    function Example() {
      const chat = useChat({ id: "thread", transport: {}, initialMessages: messages });
      const composer = useComposer({
        scope: { principalId: "viewer", conversationId: "thread" },
        send: chat.send,
        canSend: chat.canSend,
        initialText: "Keep this draft.",
      });
      return (
        <Conversation chat={chat}>
          <MessageList />
          <Composer
            text={composer.text}
            onTextChange={composer.setText}
            onSubmit={composer.submit}
            canSubmit={composer.canSubmit}
          />
        </Conversation>
      );
    }

    const html = renderToString(<Example />);
    expect(html).toContain("A saved answer.");
    expect(html).toContain("Keep this draft.");
    expect(html).toContain("<textarea");
    expect(html).not.toContain("not-public");
  });

  it("labels a specialist by its registered identity rather than parsing its run id", () => {
    const event = parseChatEvent({
      v: 1,
      type: "part",
      messageId: "answer",
      part: {
        type: "agent",
        id: "opaque-child-run",
        agentId: "researcher",
        label: "Server label",
        state: "completed",
      },
    });
    if (event?.type !== "part" || event.part.type !== "agent")
      throw new Error("The specialist part did not parse.");
    expect(event.part.agentId).toBe("researcher");
    const html = renderToString(
      <SpecialistActivity agent={event.part} specialistLabels={{ researcher: "Local label" }} />,
    );
    expect(html).toContain("Local label");
    expect(html).not.toContain("Server label");
    const specific = renderToString(
      <SpecialistActivity
        agent={event.part}
        specialistLabels={{ researcher: "Local label", "opaque-child-run": "This run" }}
      />,
    );
    expect(specific).toContain("This run");
  });

  it.each(["", 3, false])("refuses malformed specialist identity %s", (agentId) => {
    expect(
      parseChatEvent({
        v: 1,
        type: "part",
        messageId: "answer",
        part: { type: "agent", id: "run", agentId, label: "Research", state: "completed" },
      }),
    ).toBeNull();
  });

  it("renders equivalent host-owned data without the chat hooks", () => {
    const html = renderToString(
      <Conversation chat={{ messages, run: { status: "completed" } }}>
        <MessageList
          renderPart={(part) =>
            part.type === "data" ? <span>Host-rendered result</span> : undefined
          }
        />
      </Conversation>,
    );
    expect(html).toContain("A saved answer.");
    expect(html).toContain("Host-rendered result");
    expect(html).not.toContain("not-public");
    expect(html).not.toContain("<textarea");
  });
});
