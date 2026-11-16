// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  InputStatusList,
  SpecialistActivity,
  RunStatusDisplay,
  RequestCard,
} from "../src/ui/index.ts";
import type { ChatClient, InputView } from "../src/client.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows handoff ownership with per-run labels and keeps target text in its existing group", async () => {
  await act(async () =>
    root.render(
      <>
        <RunStatusDisplay
          run={{
            id: "root",
            status: "running",
            owner: { runId: "opaque-child", agentId: "billing", label: "Billing" },
          }}
        />
        <SpecialistActivity
          agent={{
            type: "agent",
            id: "opaque-child",
            agentId: "billing",
            label: "Server label",
            state: "running",
            kind: "handoff",
          }}
          specialistLabels={{ billing: "Agent label", "opaque-child": "Run label" }}
        >
          <p>Permitted answer</p>
        </SpecialistActivity>
      </>,
    ),
  );
  expect(container.textContent).toContain("Conversation with Billing");
  expect(container.textContent).toContain("Run label");
  expect(container.textContent).not.toContain("Agent label");
  expect(container.querySelector('[data-kind="handoff"]')?.textContent).toContain(
    "Took over the conversation",
  );
  expect(container.textContent).toContain("Permitted answer");
});

it("keeps delivery states distinct and only exposes a host-provided recall capability", async () => {
  const inputs: InputView[] = ["queued", "accepted", "consumed", "unconfirmed"].map(
    (status, index) => ({
      id: String(index),
      rootRunId: "root",
      text: `Message ${index}`,
      status:
        status === "queued"
          ? "queued"
          : status === "accepted"
            ? "accepted"
            : status === "consumed"
              ? "consumed"
              : "unconfirmed",
      canRecall: false,
    }),
  );
  await act(async () =>
    root.render(<InputStatusList inputs={inputs} run={{ id: "root", status: "completed" }} />),
  );
  expect(
    [...container.querySelectorAll('[data-part="input"]')].map((node) =>
      node.getAttribute("data-state"),
    ),
  ).toEqual(["queued", "accepted", "consumed", "unconfirmed"]);
  expect(container.textContent).toContain("The answer ended. Check for updates");
  expect(container.querySelector("button")).toBeNull();
  const result = Promise.withResolvers<Awaited<ReturnType<ChatClient["recallInput"]>>>();
  const recall = vi.fn(() => result.promise);
  await act(async () =>
    root.render(
      <InputStatusList
        scopeKey="one"
        inputs={[{ ...inputs[0]!, canRecall: true }]}
        onRecall={recall}
      />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector("button")?.disabled).toBe(true);
  expect(container.textContent).toContain("Recalling...");
  await act(async () =>
    result.resolve({
      ok: false,
      error: { code: "claimed", message: "Already claimed. Check the answer." },
    }),
  );
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(container.textContent).toContain("Already claimed. Check the answer.");
  expect(container.textContent).toContain("Message 0");
});

it("drops recall feedback after a scope change and never resends the input", async () => {
  const result = Promise.withResolvers<Awaited<ReturnType<ChatClient["recallInput"]>>>();
  const recall = vi.fn(() => result.promise);
  const input: InputView = {
    id: "same",
    rootRunId: "same-run",
    status: "queued",
    canRecall: true,
    text: "First account",
  };
  await act(async () =>
    root.render(<InputStatusList scopeKey="one" inputs={[input]} onRecall={recall} />),
  );
  const oldButton = container.querySelector("button")!;
  await act(async () => oldButton.click());
  await act(async () =>
    root.render(
      <InputStatusList
        scopeKey="two"
        inputs={[{ ...input, text: "Second account" }]}
        onRecall={recall}
      />,
    ),
  );
  await act(async () =>
    result.resolve({ ok: false, error: { code: "old", message: "Private old error" } }),
  );
  await act(async () => oldButton.click());
  expect(container.textContent).not.toContain("Private old error");
  expect(container.textContent).toContain("Second account");
  expect(recall).toHaveBeenCalledOnce();
});

it("offers reconciliation, not another execution, for an uncertain claimed action", async () => {
  const start = vi.fn(async () => ({ ok: true as const, outcome: "unknown" as const }));
  await act(async () =>
    root.render(
      <RequestCard
        onRespond={async () => {}}
        onStartClientTool={start}
        request={{
          messageId: "reply",
          canRun: true,
          canReconcile: true,
          part: {
            type: "client-tool",
            id: "request",
            title: "Device action",
            name: "write",
            state: "pending",
          },
          local: { status: "unconfirmed", response: { type: "result", value: null } },
        }}
      />,
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Check action result",
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(start).toHaveBeenCalledWith("request");
});
