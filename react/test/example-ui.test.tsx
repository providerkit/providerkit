// @vitest-environment happy-dom
import "../examples/styles.d.ts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SampleImage } from "../examples/chat/fixtures.tsx";
import { command, demoFetch } from "../examples/chat/transport.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot(...args: Parameters<typeof actual.createRoot>) {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});
vi.mock("../examples/chat/transport.ts", async (original) => ({
  ...(await original<typeof import("../examples/chat/transport.ts")>()),
  sseTransport: () => ({}), // Mount the real draft owner without opening a network observer.
  command: vi.fn(),
  demoFetch: vi.fn(),
}));
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function checkbox(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!found) throw new Error(`Missing checkbox: ${label}`);
  return found;
}

it("keeps failed navigation in the draft owner and clears only that failure after retry", async () => {
  await act(async () => {
    await import("../examples/chat/app.tsx");
  });
  await act(async () => checkbox("Save drafts on this browser for 24 hours").click());
  await act(async () => checkbox("Refuse draft saves").click());
  await act(async () => button("Use a sample message").click());
  const draft = container.querySelector("textarea")!.value;
  const assign = vi.spyOn(location, "assign");
  await act(async () => button("Reload this page").click());
  expect(assign).not.toHaveBeenCalled();
  expect(container.querySelector('[data-part="composer-draft"]')?.getAttribute("data-state")).toBe(
    "failed",
  );
  expect(container.querySelector(".host-feedback")?.textContent).toBe("");
  expect(container.textContent).not.toContain("Retry saving");
  expect(container.querySelector("textarea")?.value).toBe(draft);

  // An unrelated host error must survive draft recovery. The same toggle reaches the request path.
  await act(async () => checkbox("Omit part of the next scripted reply").click());
  vi.mocked(command).mockRejectedValueOnce(
    new Error("The request example could not start. Try it again."),
  );
  await act(async () => button("Try questions, card and handoff").click());
  expect(command).toHaveBeenLastCalledWith(
    { principalId: "alex", conversationId: "visit" },
    "approval",
    { mode: "pending", gap: "1" },
  );
  await act(async () => checkbox("Refuse draft saves").click());
  await act(async () => button("Try again").click());
  expect(container.querySelector('[data-part="composer-draft"]')?.textContent).toBe("Draft saved.");
  expect(container.querySelector(".host-feedback")?.textContent).toBe(
    "The request example could not start. Try it again.",
  );
  expect(container.textContent).not.toContain("Your draft was not saved");
  expect(container.querySelector('[data-part="draft-retry"]')).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe(draft);
});

it("reserves the sample media frame while loading and keeps deliberate resizing available", async () => {
  vi.useFakeTimers();
  const load = Promise.withResolvers<Response>();
  vi.mocked(demoFetch).mockReturnValue(load.promise);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated-sample");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const root = createRoot(container);
  await act(async () =>
    root.render(<SampleImage scope={{ principalId: "alex", conversationId: "visit" }} />),
  );
  const frame = container.querySelector(".sample-image-frame");
  expect(frame).not.toBeNull();
  await act(async () => button("Load image after 3 seconds").click());
  expect(container.querySelector(".sample-image-frame")).toBe(frame);
  await act(async () =>
    load.resolve(
      new Response(new Blob(["synthetic image"]), { headers: { "Content-Type": "image/png" } }),
    ),
  );
  const image = container.querySelector("img")!;
  expect(image.width).toBe(720);
  expect(image.height).toBe(480);
  await act(async () => image.dispatchEvent(new Event("load")));
  await act(async () => button("Enlarge after 3 seconds").click());
  expect(container.querySelector("figure")?.dataset.size).toBe("small");
  await act(async () => vi.advanceTimersByTime(3000));
  expect(container.querySelector("figure")?.dataset.size).toBe("large");
  await act(async () => button("Reload image after 3 seconds").click());
  expect(container.querySelector(".sample-image-frame")).toBe(frame);
  expect(container.querySelector("figure")?.dataset.size).toBe("large");
});
