// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TransportError,
  type ChatTransport,
  type CommandResult,
  type RequestView,
} from "../src/client.ts";
import { useAgentRun } from "../src/hooks.ts";
import type { AgentPart, ApprovalPart, SourcePart, ToolPart } from "../src/protocol.ts";
import { SpecialistActivity, ToolCall } from "../src/ui/activity.tsx";
import { ApprovalCard, type ApprovalActions } from "../src/ui/approval.tsx";
import { Sources } from "../src/ui/sources.tsx";
import { ConnectionStatusDisplay, RunStatusDisplay } from "../src/ui/status.tsx";

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
  vi.useRealTimers();
});
const draw = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function button(part: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-part="${part}"]`);
  if (!element) throw new Error(`Missing button: ${part}`);
  return element;
}
type ApprovalRequest = RequestView & { part: ApprovalPart };
const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  messageId: "answer",
  part: {
    type: "approval",
    id: "permission",
    title: "Send the report?",
    summary: "This will email the report to the team.",
    state: "pending",
  },
  ...overrides,
});

it("keeps failed tools visible, authorized details escaped and actions outside the trigger", async () => {
  const retry = vi.fn();
  const tool: ToolPart = {
    type: "tool",
    id: "tool",
    name: "lookup",
    label: "Server fallback",
    state: "running",
    summary: "Looking for the record",
    detail: "<b>Safe text</b>\nSecond line",
    data: { secret: "hidden-tool-result" },
  };
  await draw(
    <ToolCall
      tool={tool}
      toolLabels={{ lookup: "Find record" }}
      defaultOpen
      actions={<button onClick={retry}>Retry lookup</button>}
    />,
  );
  const details = container.querySelector("details");
  expect(details?.open).toBe(true);
  expect(container.textContent).toContain("Find record");
  expect(container.querySelector("b")).toBeNull();
  expect(container.textContent).not.toContain("hidden-tool-result");
  expect(container.querySelector("summary button")).toBeNull();
  await draw(
    <ToolCall
      tool={{ ...tool, state: "failed", summary: "The record could not be read. Try again." }}
      toolLabels={{ lookup: "Find record" }}
      actions={<button onClick={retry}>Retry lookup</button>}
    />,
  );
  expect(container.querySelector("details")).toBe(details);
  expect(details?.open).toBe(true);
  expect(container.textContent).toContain("Failed");
  expect(container.textContent).toContain("Try again.");
  await act(async () => container.querySelector("button")?.click());
  expect(retry).toHaveBeenCalledOnce();
});

it("shows six different specialist states and no child Stop control", async () => {
  const states: AgentPart["state"][] = [
    "running",
    "waiting",
    "completed",
    "stopped",
    "limited",
    "failed",
  ];
  await draw(
    <>
      {states.map((state) => (
        <SpecialistActivity
          key={state}
          agent={{ type: "agent", id: state, parentId: "parent", label: "Specialist", state }}
        />
      ))}
    </>,
  );
  expect(
    [...container.querySelectorAll("[data-part='activity-state']")].map((node) => node.textContent),
  ).toEqual([
    "Working",
    "Waiting for your answer",
    "Completed",
    "Stopped",
    "Stopped at a limit",
    "Failed",
  ]);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelectorAll("[data-parent-id='parent']")).toHaveLength(6);
});

it("uses the server fallback when a name is absent from the host's own label map", async () => {
  await draw(
    <>
      <ToolCall
        tool={{
          type: "tool",
          id: "call",
          name: "constructor",
          label: "Server tool",
          state: "done",
        }}
        toolLabels={{}}
      />
      <SpecialistActivity
        agent={{ type: "agent", id: "toString", label: "Server specialist", state: "completed" }}
        specialistLabels={{}}
      />
    </>,
  );
  expect(container.textContent).toContain("Server tool");
  expect(container.textContent).toContain("Server specialist");
});

describe("host sources", () => {
  it("links only HTTP and HTTPS, preserving unsafe sources as text", async () => {
    const urls = [
      "https://example.com/report",
      "http://example.com/plain",
      "javascript:alert(1)",
      "data:text/html,hello",
      "//example.com/relative",
      "/relative",
      "file:///report",
      "not a url",
    ];
    const sources: SourcePart[] = urls.map((url, i) => ({
      type: "source",
      id: `source-${i}`,
      marker: `${i + 1}`,
      title: `Source ${i + 1}`,
      url,
    }));
    await draw(<Sources sources={sources} />);
    expect([...container.querySelectorAll("a")].map((link) => link.href)).toEqual(urls.slice(0, 2));
    expect(container.querySelectorAll("li")).toHaveLength(urls.length);
    expect(container.querySelector("[data-part='source-marker']")?.textContent).toBe("1");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
  it("lets the host navigate without creating any link", async () => {
    const source: SourcePart = {
      type: "source",
      id: "source",
      title: "Private document",
      url: "host:document",
    };
    const navigate = vi.fn();
    await draw(
      <Sources sources={[source]} onSource={navigate} labels={{ sources: "References" }} />,
    );
    expect(container.querySelector("ul")?.getAttribute("aria-label")).toBe("References");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => button("source-link").click());
    expect(navigate).toHaveBeenCalledWith(source);
  });
});

describe("approval decisions", () => {
  it("shows pending immediately and waits for the host after a successful callback", async () => {
    const call = deferred<CommandResult>();
    const respond = vi.fn(() => call.promise);
    const initial = request();
    await draw(<ApprovalCard request={initial} onRespond={respond} />);
    await act(async () => {
      button("approve").click();
      button("deny").click();
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith("permission", { type: "approve" });
    expect(container.querySelector("section")?.dataset.state).toBe("submitting");
    expect(button("deny").disabled).toBe(true);
    await act(async () => call.resolve({ ok: true }));
    expect(container.querySelector("section")?.dataset.state).toBe("submitting");
    expect(container.textContent).not.toContain("Approved");
    await draw(
      <ApprovalCard
        request={{ ...initial, part: { ...initial.part, state: "approved" } }}
        onRespond={respond}
      />,
    );
    expect(container.querySelector("section")?.dataset.state).toBe("approved");
    expect(button("approve").disabled).toBe(true);
  });

  it("shows immediate feedback over a prior refusal and enables retry only after refusal", async () => {
    const call = deferred<CommandResult>();
    const respond = vi.fn(() => call.promise);
    const initial = request({
      local: {
        status: "failed",
        response: { type: "approve" },
        error: { code: "denied", message: "Review the new report first." },
      },
    });
    await draw(<ApprovalCard request={initial} onRespond={respond} />);
    expect(button("approve").disabled).toBe(false);
    await act(async () => button("approve").click());
    expect(container.querySelector("section")?.dataset.state).toBe("submitting");
    // A host with its own reducer may copy the same local status on unrelated updates.
    await draw(
      <ApprovalCard
        request={{ ...initial, local: initial.local ? { ...initial.local } : undefined }}
        onRespond={respond}
      />,
    );
    expect(container.querySelector("section")?.dataset.state).toBe("submitting");
    await act(async () =>
      call.resolve({
        ok: false,
        error: { code: "denied", message: "You need permission. Ask an admin." },
      }),
    );
    expect(container.querySelector("section")?.dataset.state).toBe("failed");
    expect(button("approve").disabled).toBe(false);
    expect(container.textContent).toContain("Ask an admin.");
  });

  it("honors host submitting and uncertain states, including in a custom dialog slot", async () => {
    const respond = vi.fn();
    let slot: ApprovalActions | undefined;
    for (const status of ["submitting", "unconfirmed"] as const) {
      await draw(
        <ApprovalCard
          request={request({ local: { status, response: { type: "approve" } } })}
          onRespond={respond}
          renderActions={(actions) => {
            slot = actions;
            return <button disabled={actions.disabled}>Host dialog</button>;
          }}
        />,
      );
      expect(container.querySelector("button")?.disabled).toBe(true);
      expect(slot?.request.part.id).toBe("permission");
      await act(async () => slot?.onRespond?.({ type: "deny" }));
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it.each(["submitting", "unconfirmed", "approved", "expired"] as const)(
    "blocks a retained dialog callback after the request becomes %s",
    async (state) => {
      const respond = vi.fn();
      const initial = request();
      let retained: ApprovalActions["onRespond"];
      const renderActions = (actions: ApprovalActions) => {
        retained ??= actions.onRespond;
        return null;
      };
      await draw(
        <ApprovalCard request={initial} onRespond={respond} renderActions={renderActions} />,
      );
      expect(retained).toBeTypeOf("function");
      const next =
        state === "submitting" || state === "unconfirmed"
          ? request({ local: { status: state, response: { type: "approve" } } })
          : state === "approved"
            ? request({ part: { ...initial.part, state } })
            : initial;
      await draw(
        <ApprovalCard
          request={next}
          onRespond={respond}
          expired={state === "expired"}
          renderActions={renderActions}
        />,
      );
      await act(async () => retained?.({ type: "deny" }));
      expect(respond).not.toHaveBeenCalled();
    },
  );

  it.each(["request", "message", "unmount"] as const)(
    "invalidates a retained dialog callback after %s replacement",
    async (change) => {
      const respond = vi.fn();
      const initial = request();
      let retained: ApprovalActions["onRespond"];
      await draw(
        <ApprovalCard
          request={initial}
          onRespond={respond}
          renderActions={(actions) => {
            retained = actions.onRespond;
            return null;
          }}
        />,
      );
      expect(retained).toBeTypeOf("function");
      await draw(
        change === "unmount" ? null : (
          <ApprovalCard
            request={
              change === "message"
                ? { ...initial, messageId: "next-message" }
                : { ...initial, part: { ...initial.part, id: "next-request" } }
            }
            onRespond={respond}
          />
        ),
      );
      await act(async () => retained?.({ type: "approve" }));
      expect(respond).not.toHaveBeenCalled();
      if (change !== "unmount") {
        await act(async () => button("approve").click());
        expect(respond).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses the current responder through a retained dialog callback and keeps its uncertain lock", async () => {
    const previousRespond = vi.fn();
    const currentRespond = vi.fn(async (): Promise<CommandResult> => ({
      ok: false,
      error: { code: "unconfirmed", message: "Check for updates before answering again." },
    }));
    const initial = request();
    let retained: ApprovalActions["onRespond"];
    await draw(
      <ApprovalCard
        request={initial}
        onRespond={previousRespond}
        renderActions={(actions) => {
          retained = actions.onRespond;
          return null;
        }}
      />,
    );
    expect(retained).toBeTypeOf("function");
    await draw(<ApprovalCard request={initial} onRespond={currentRespond} />);
    await act(async () => retained?.({ type: "approve" }));
    expect(previousRespond).not.toHaveBeenCalled();
    expect(currentRespond).toHaveBeenCalledOnce();
    expect(container.querySelector("section")?.dataset.state).toBe("unconfirmed");
    await act(async () => retained?.({ type: "deny" }));
    expect(currentRespond).toHaveBeenCalledOnce();
  });

  it("does not turn an unknown outcome into another enabled decision", async () => {
    const call = deferred<CommandResult>();
    const respond = vi.fn(() => call.promise);
    await draw(<ApprovalCard request={request()} onRespond={respond} />);
    await act(async () => button("approve").click());
    await act(async () => call.reject(new Error("Network failed")));
    expect(container.querySelector("section")?.dataset.state).toBe("unconfirmed");
    expect(button("approve").disabled).toBe(true);
    expect(container.textContent).toContain("may have arrived");
    await act(async () => button("deny").click());
    expect(respond).toHaveBeenCalledOnce();
  });

  it("discards a late callback after the host has supplied a newer decision status", async () => {
    const call = deferred<CommandResult>();
    const respond = vi.fn(() => call.promise);
    const initial = request();
    await draw(<ApprovalCard request={initial} onRespond={respond} />);
    await act(async () => button("approve").click());
    await draw(
      <ApprovalCard
        request={{ ...initial, local: { status: "unconfirmed", response: { type: "approve" } } }}
        onRespond={respond}
      />,
    );
    await act(async () =>
      call.resolve({ ok: false, error: { code: "denied", message: "Old refusal" } }),
    );
    expect(container.querySelector("section")?.dataset.state).toBe("unconfirmed");
    expect(container.textContent).not.toContain("Old refusal");
  });

  it("does not transfer a late decision or a lock to another request", async () => {
    const call = deferred<CommandResult>();
    const respond = vi.fn(() => call.promise);
    const initial = request();
    await draw(<ApprovalCard request={initial} onRespond={respond} />);
    await act(async () => button("approve").click());
    await draw(
      <ApprovalCard
        request={{ ...initial, part: { ...initial.part, id: "next", title: "Next request" } }}
        onRespond={respond}
      />,
    );
    await act(async () =>
      call.resolve({ ok: false, error: { code: "denied", message: "Old refusal" } }),
    );
    expect(container.querySelector("section")?.dataset.state).toBe("pending");
    expect(button("approve").disabled).toBe(false);
    expect(container.textContent).not.toContain("Old refusal");
  });

  it("expires once, retains the explanation and cleans up its timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const initial = request();
    initial.part.expiresAt = 10_500;
    await draw(<ApprovalCard request={initial} onRespond={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector("section")?.dataset.state).toBe("expired");
    expect(button("approve").disabled).toBe(true);
    expect(container.textContent).toContain("This will email the report");
    expect(container.textContent).toContain("Ask for a new request");
    await draw(
      <ApprovalCard
        request={{ ...initial, part: { ...initial.part, id: "later", expiresAt: 20_000 } }}
        onRespond={vi.fn()}
      />,
    );
    expect(vi.getTimerCount()).toBe(1);
    await draw(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors an externally supplied expiry and explains a read-only request", async () => {
    const respond = vi.fn();
    const initial = request();
    initial.part.expiresAt = 0;
    await draw(<ApprovalCard request={initial} onRespond={respond} expired={false} />);
    expect(button("approve").disabled).toBe(false);
    await act(async () => button("approve").click());
    expect(respond).toHaveBeenCalledOnce();
    await draw(<ApprovalCard request={initial} onRespond={respond} expired />);
    expect(button("approve").disabled).toBe(true);
    await draw(
      <ApprovalCard
        request={request({ part: { ...initial.part, id: "read-only", expiresAt: undefined } })}
      />,
    );
    expect(button("approve").disabled).toBe(true);
    expect(container.textContent).toContain("Open the request where you can answer it");
  });
});

describe("run and connection states", () => {
  it("waits for actual run state, not the connection or the previous run's completion", async () => {
    await draw(
      <>
        <RunStatusDisplay run={{ status: "running" }} />
        <ConnectionStatusDisplay connection="lost" />
      </>,
    );
    expect(container.textContent).toContain("Working");
    expect(container.textContent).not.toContain("Completed");
    expect(container.querySelector("button")).toBeNull();
    await draw(<RunStatusDisplay run={{ status: "completed" }} status="running" />);
    expect(container.textContent).toBe("Working");
  });

  it("offers only supported reconnect and reflects the press before host data changes", async () => {
    const connect = deferred<void>();
    const reconnect = vi.fn(() => connect.promise);
    await draw(
      <ConnectionStatusDisplay connection="lost" onReconnect={reconnect} canReconnect={false} />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("open this view again");
    await draw(<ConnectionStatusDisplay connection="lost" onReconnect={reconnect} canReconnect />);
    await act(async () => {
      button("reconnect").click();
      button("reconnect").click();
    });
    expect(reconnect).toHaveBeenCalledOnce();
    expect(button("reconnect").textContent).toBe("Reconnecting...");
    await act(async () => connect.reject(new Error("Offline")));
    expect(container.textContent).toContain("Check your connection and try again");
    expect(button("reconnect").getAttribute("aria-disabled")).toBe("false");
    await draw(<ConnectionStatusDisplay connection="open" onReconnect={reconnect} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps Stop pending until the host confirms, without stopping on unmount", async () => {
    const call = deferred<CommandResult>();
    const stop = vi.fn(() => call.promise);
    await draw(<RunStatusDisplay run={{ id: "run", status: "running" }} onStop={stop} canStop />);
    await act(async () => {
      button("stop").click();
      button("stop").click();
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(button("stop").textContent).toBe("Stopping...");
    await act(async () => call.resolve({ ok: true }));
    expect(button("stop").textContent).toBe("Stopping...");
    await draw(<RunStatusDisplay run={{ id: "run", status: "stopped" }} onStop={stop} />);
    expect(container.textContent).toBe("Stopped");
    expect(container.querySelector("button")).toBeNull();
    await draw(null);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("unlocks Stop after external pending clears with a refusal", async () => {
    const stop = vi.fn(async () => ({ ok: true as const }));
    await draw(
      <RunStatusDisplay
        run={{ id: "run", status: "running" }}
        status="running"
        onStop={stop}
        canStop
      />,
    );
    await act(async () => button("stop").click());
    await draw(
      <RunStatusDisplay
        run={{ id: "run", status: "running" }}
        status="stopping"
        onStop={stop}
        canStop={false}
      />,
    );
    await draw(
      <RunStatusDisplay
        run={{ id: "run", status: "running" }}
        status="running"
        onStop={stop}
        canStop
      />,
    );
    expect(button("stop").getAttribute("aria-disabled")).toBe("false");
    await act(async () => button("stop").click());
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("shows a refused Stop from useAgentRun after its pending status clears", async () => {
    vi.useFakeTimers();
    const call = deferred<void>();
    const stop = vi.fn(() => call.promise);
    const transport: ChatTransport = {
      stop,
      async *observe({ signal }) {
        yield { v: 1, type: "run", run: { id: "run", status: "running" } };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    function Panel() {
      const run = useAgentRun({ transport });
      return (
        <RunStatusDisplay
          run={run.run}
          status={run.status}
          canStop={run.canStop}
          onStop={run.stop}
        />
      );
    }
    await draw(<Panel />);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.querySelector("[data-part='run-status']")?.getAttribute("data-state")).toBe(
      "running",
    );
    await act(async () => button("stop").click());
    expect(button("stop").textContent).toBe("Stopping...");
    const message = "You do not have permission to stop this run. Ask an admin.";
    await act(async () => call.reject(new TransportError("refused", { code: "access", message })));
    expect(container.querySelector("[data-part='status-error']")?.textContent).toBe(message);
    expect(button("stop").getAttribute("aria-disabled")).toBe("false");
    expect(container.textContent).toContain("Working");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not transfer an old Stop refusal to a different run", async () => {
    const call = deferred<CommandResult>();
    const stop = vi.fn(() => call.promise);
    await draw(<RunStatusDisplay run={{ id: "first", status: "running" }} onStop={stop} />);
    await act(async () => button("stop").click());
    await draw(<RunStatusDisplay run={{ id: "next", status: "running" }} onStop={stop} />);
    await act(async () =>
      call.resolve({ ok: false, error: { code: "access", message: "Old refusal" } }),
    );
    expect(container.textContent).not.toContain("Old refusal");
    expect(button("stop").getAttribute("aria-disabled")).toBe("false");
  });

  it("shows actionable limit and failure text and accepts host recovery actions", async () => {
    await draw(
      <RunStatusDisplay
        run={{ status: "limited" }}
        recoveryAction={<a href="/limits">Change limit</a>}
        labels={{ limitedHelp: "The call limit was reached. Raise it to continue." }}
      />,
    );
    expect(container.textContent).toContain("Raise it to continue");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/limits");
    await draw(
      <RunStatusDisplay
        run={{
          status: "failed",
          error: { code: "access", message: "Access was removed. Ask an admin." },
        }}
      />,
    );
    expect(container.textContent).toContain("Ask an admin");
  });
});
