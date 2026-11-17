// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatTransport, RequestView, RespondResult } from "../src/client.ts";
import { useChat, type ChatValue } from "../src/hooks.ts";
import type { QuestionPart } from "../src/protocol.ts";
import type { QuestionAnswer } from "../src/requests.ts";
import { RequestCard, type RequestActions } from "../src/ui/approval.tsx";
import { SchemaForm, formFields } from "../src/ui/schema-form.tsx";

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
const question: QuestionPart = {
  type: "question",
  id: "question",
  title: "Tell us more",
  state: "pending",
  freeText: true,
};
const request = (part = question): RequestView => ({ part, messageId: "reply" });

it("keeps controlled answers and focus after refusal and after the host closes the request", async () => {
  const respond = vi.fn(async (): Promise<RespondResult> => ({
    ok: false,
    error: { code: "refused", message: "Review the answer and try again." },
  }));
  let change: ((value: QuestionAnswer) => void) | undefined;
  function Controlled({ part }: { part: QuestionPart }) {
    const [value, setValue] = useState<QuestionAnswer>({ text: "Draft answer" });
    change = setValue;
    return (
      <RequestCard
        request={request(part)}
        onRespond={respond}
        value={value}
        onValueChange={setValue}
      />
    );
  }
  await draw(<Controlled part={question} />);
  const input = container.querySelector("textarea")!;
  input.focus();
  await act(async () => change?.({ text: "Unsent answer" }));
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(respond).toHaveBeenCalledWith("question", {
    type: "answer",
    answer: { text: "Unsent answer" },
  });
  expect(input.value).toBe("Unsent answer");
  expect(container.querySelector("textarea")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(container.textContent).toContain("Review the answer");
  await draw(<Controlled part={{ ...question, state: "answered" }} />);
  expect(container.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("Unsent answer");
  expect(input.readOnly).toBe(true);
});

it.each(["question", "edited approval"])(
  "holds pending focus and returns a rejected %s to its editable field",
  async (kind) => {
    const result = Promise.withResolvers<RespondResult>();
    const respond = vi.fn(() => result.promise);
    const approval = kind === "edited approval";
    const schema = { type: "object", properties: { label: { type: "string" } } };
    await draw(
      <RequestCard
        request={
          approval
            ? {
                messageId: "reply",
                part: {
                  type: "approval",
                  id: "approval",
                  title: "Approve label",
                  state: "pending",
                  edit: { schema, value: { label: "x" } },
                },
              }
            : request()
        }
        onRespond={respond}
        value={approval ? { data: { label: "x" } } : { text: "x" }}
        renderActions={
          approval
            ? (actions) => (
                <>
                  <SchemaForm
                    schema={schema}
                    value={{ label: "x" }}
                    onChange={() => {}}
                    disabled={actions.disabled}
                    unsupported="Use the host form."
                    chooseLabel="Choose"
                    trueLabel="Yes"
                    falseLabel="No"
                  />
                  <button
                    disabled={actions.disabled}
                    onClick={() =>
                      void actions.onRespond?.({ type: "approve", arguments: { label: "x" } })
                    }
                  >
                    Approve label
                  </button>
                </>
              )
            : undefined
        }
      />,
    );
    const button = container.querySelector("button")!;
    button.focus();
    await act(async () => button.click());
    const region = container.querySelector("section")!;
    expect(region.dataset.state).toBe("submitting");
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(region);
    expect(region.hasAttribute("aria-labelledby")).toBe(true);
    await act(async () =>
      result.resolve({
        ok: false,
        error: { code: "refused", message: "Use at least three letters." },
      }),
    );
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    )!;
    expect(field.value).toBe("x");
    expect(document.activeElement).toBe(field);
    expect(container.textContent).toContain("Use at least three letters.");
    // A fast retry can fail in one render batch, with the same display state as before.
    button.focus();
    await act(async () => button.click());
    expect(respond).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(field);
  },
);

it("keeps an accepted partial answer focused in its region, without jumping to another request", async () => {
  const result = Promise.withResolvers<RespondResult>();
  const respond = vi.fn(() => result.promise);
  const view = (part: QuestionPart) => (
    <>
      <RequestCard
        request={request(part)}
        onRespond={respond}
        value={{ text: "Keep this answer" }}
      />
      <RequestCard request={request({ ...question, id: "other" })} onRespond={respond} />
    </>
  );
  await draw(view(question));
  const button = container.querySelector("button")!;
  button.focus();
  await act(async () => button.click());
  const region = container.querySelector("section")!;
  await draw(view({ ...question, state: "answered" }));
  await act(async () => result.resolve({ ok: true, outcome: "accepted" }));
  expect(document.activeElement).toBe(region);
  expect(container.querySelector("textarea")?.value).toBe("Keep this answer");
  expect(container.querySelectorAll("section")[1]?.dataset.state).toBe("pending");
});

it.each(["elsewhere", "body", "returned", "scope", "replacement", "unmount"])(
  "does not restore request focus after %s",
  async (ending) => {
    const result = Promise.withResolvers<RespondResult>();
    const respond = vi.fn(() => result.promise);
    const view = (scope = "first", id = "question", mounted = true) => (
      <>
        {mounted && (
          <RequestCard
            scopeKey={scope}
            request={request({ ...question, id })}
            onRespond={respond}
            value={{ text: "Draft" }}
          />
        )}
        <input aria-label="Elsewhere" />
      </>
    );
    await draw(view());
    const button = container.querySelector("button")!;
    button.focus();
    await act(async () => button.click());
    if (ending === "elsewhere" || ending === "body" || ending === "returned") {
      const other = container.querySelector<HTMLInputElement>('[aria-label="Elsewhere"]')!;
      other.focus();
      if (ending === "body") other.blur();
      if (ending === "returned") container.querySelector("section")?.focus();
    } else
      await draw(
        view(
          ending === "scope" ? "second" : "first",
          ending === "replacement" ? "new" : "question",
          ending !== "unmount",
        ),
      );
    const focused = document.activeElement;
    await act(async () =>
      result.resolve({ ok: false, error: { code: "refused", message: "Correct the answer." } }),
    );
    expect(document.activeElement).toBe(focused);
    expect(document.activeElement).not.toBe(container.querySelector("textarea"));
  },
);

it("unlocks a plain-data card after authoritative rejection, including the same problem twice", async () => {
  const respond = vi.fn(async (): Promise<RespondResult> => ({ ok: true, outcome: "accepted" }));
  let actions: RequestActions | undefined;
  const renderActions = (next: RequestActions) => {
    actions = next;
    return null;
  };
  await draw(<RequestCard request={request()} onRespond={respond} renderActions={renderActions} />);
  await act(async () => actions?.onValueChange({ text: "Keep my answer" }));
  await draw(<RequestCard request={request()} onRespond={respond} />);
  const input = container.querySelector("textarea")!;
  input.focus();
  let part = question;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await act(async () => container.querySelector("form")?.requestSubmit());
    expect(container.querySelector("section")?.dataset.state).toBe("submitting");
    await draw(<RequestCard request={request(part)} onRespond={respond} />);
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    part = {
      ...part,
      problem: { code: "invalid_answer", message: "Review the answer and try again." },
    };
    await draw(<RequestCard request={request(part)} onRespond={respond} />);
    expect([...container.querySelectorAll("button")].every((button) => !button.disabled)).toBe(
      true,
    );
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe("Keep my answer");
    expect(document.activeElement).toBe(input);
  }
  expect(respond).toHaveBeenCalledTimes(2);
});

it("lets a plain-data rejection supersede a pending callback without unlocking its replacement", async () => {
  const calls: ((value: RespondResult) => void)[] = [];
  const respond = vi.fn(() => new Promise<RespondResult>((resolve) => calls.push(resolve)));
  const value = { text: "Keep my answer" };
  await draw(<RequestCard request={request()} onRespond={respond} value={value} />);
  await act(async () => container.querySelector("form")?.requestSubmit());
  const rejected = {
    ...question,
    problem: { code: "invalid_answer", message: "Review your answer." },
  };
  await draw(<RequestCard request={request(rejected)} onRespond={respond} value={value} />);
  await act(async () => container.querySelector("form")?.requestSubmit());
  expect(respond).toHaveBeenCalledTimes(2);
  await act(async () => calls[0]?.({ ok: false, error: { code: "old", message: "Old refusal" } }));
  expect(container.querySelector("section")?.dataset.state).toBe("submitting");
  expect(container.textContent).not.toContain("Old refusal");
  await act(async () => calls[1]?.({ ok: true, outcome: "accepted" }));
});

it.each([false, true])(
  "submits untouched optional fields but keeps native required validation (%s)",
  async (required) => {
    const respond = vi.fn(async (): Promise<RespondResult> => ({ ok: true, outcome: "accepted" }));
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      ...(required && { required: ["name"] }),
    };
    await draw(
      <RequestCard
        request={request({ ...question, freeText: false, schema })}
        onRespond={respond}
      />,
    );
    const form = container.querySelector("form")!;
    expect(form.checkValidity()).toBe(!required);
    await act(async () => form.requestSubmit());
    if (required) expect(respond).not.toHaveBeenCalled();
    else expect(respond).toHaveBeenCalledWith("question", { type: "answer", answer: { data: {} } });
  },
);

it.each(["expired", "replaced", "closed", "unmounted"])(
  "invalidates a retained question callback when %s",
  async (ending) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const respond = vi.fn();
    const initial = { ...question, expiresAt: 10_100 };
    let retained: RequestActions["onRespond"];
    await draw(
      <RequestCard
        request={request(initial)}
        onRespond={respond}
        renderActions={(actions) => {
          retained = actions.onRespond;
          return null;
        }}
      />,
    );
    if (ending === "expired") vi.setSystemTime(10_200);
    else
      await draw(
        ending === "unmounted" ? null : (
          <RequestCard
            request={request(
              ending === "closed"
                ? { ...initial, state: "answered" }
                : { ...initial, id: "replacement" },
            )}
            onRespond={respond}
          />
        ),
      );
    await act(async () => retained?.({ type: "answer", answer: { text: "Old answer" } }));
    expect(respond).not.toHaveBeenCalled();
  },
);

it("refuses unsupported schema requirements as a whole and offers a host renderer or Skip", async () => {
  const schema = { type: "object", properties: { name: { type: "string", pattern: "(a+)+$" } } };
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(formFields(schema)).toBeNull();
  expect(formFields({ ...schema, $ref: "https://example.com/form" })).toBeNull();
  const respond = vi.fn();
  const formQuestion = { ...question, freeText: false, schema };
  await draw(<RequestCard request={request(formQuestion)} onRespond={respond} />);
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("Open it in the app that started it");
  expect([...container.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
    "Skip",
  ]);
  await act(async () => container.querySelector("button")?.click());
  expect(respond).toHaveBeenCalledWith("question", { type: "cancel" });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

it("uses native choices and a bounded object form with host labels", async () => {
  const choices = {
    ...question,
    choices: [
      { id: "a", label: "<script>choice</script>" },
      { id: "b", label: "B" },
    ],
    multiple: true,
  };
  const respond = vi.fn();
  await draw(
    <RequestCard
      request={request(choices)}
      onRespond={respond}
      labels={{ chooseMany: "Pick any" }}
    />,
  );
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(container.querySelector("script")).toBeNull();
  await act(async () => container.querySelector<HTMLInputElement>("input")?.click());
  expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 5 },
      name: { type: "string", minLength: 2, maxLength: 8 },
      agreed: { type: "boolean" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, uniqueItems: true },
    },
    required: ["count"],
  };
  expect(formFields(schema)).toHaveLength(4);
  await draw(
    <RequestCard
      request={request({ ...question, id: "form", freeText: false, schema })}
      onRespond={respond}
      value={{ data: { count: 3, name: "Name", agreed: false, tags: ["a"] } }}
      onValueChange={() => {}}
      labels={{ yes: "Yes please", no: "No thanks" }}
    />,
  );
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.min).toBe("1");
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("3");
  expect(container.querySelectorAll("select")).toHaveLength(2);
  expect(container.textContent).toContain("No thanks");
});

it("shows hidden requests without any callback that can answer them", async () => {
  let actions: RequestActions | undefined;
  const respond = vi.fn();
  await draw(
    <RequestCard
      request={request({ ...question, canAnswer: false })}
      onRespond={respond}
      renderActions={(value) => {
        actions = value;
        return null;
      }}
    />,
  );
  expect(actions?.onRespond).toBeUndefined();
  expect(container.textContent).toContain("This view cannot answer");
});

it("does not carry an unsent answer or retained callback into another view scope", async () => {
  const respond = vi.fn();
  let actions: RequestActions | undefined;
  const renderActions = (value: RequestActions) => {
    actions = value;
    return null;
  };
  await draw(
    <RequestCard
      scopeKey="first"
      request={request()}
      onRespond={respond}
      renderActions={renderActions}
    />,
  );
  await act(async () => actions?.onValueChange({ text: "First person's draft" }));
  expect(actions?.value.text).toBe("First person's draft");
  const retained = actions?.onRespond;
  await draw(
    <RequestCard
      scopeKey="second"
      request={request()}
      onRespond={respond}
      renderActions={renderActions}
    />,
  );
  expect(actions?.value).toEqual({});
  await act(async () => retained?.({ type: "answer", answer: { text: "Late" } }));
  expect(respond).not.toHaveBeenCalled();
  expect(container.innerHTML).not.toContain("first");
});

it("invalidates retained hook responses on principal changes and unmount", async () => {
  const respond = vi.fn<NonNullable<ChatTransport["respond"]>>(async () => {});
  const transport = { respond };
  let chat: ChatValue | undefined;
  function App({ id }: { id: string }) {
    chat = useChat({
      id,
      transport,
      initialMessages: [{ id: "reply", role: "assistant", state: "live", parts: [question] }],
    });
    return null;
  }
  await draw(<App id="first-principal/conversation" />);
  const first = chat!.respond;
  await draw(<App id="second-principal/conversation" />);
  expect((await first("question", { type: "answer", answer: { text: "Late" } })).ok).toBe(false);
  const second = chat!.respond;
  await draw(null);
  expect((await second("question", { type: "answer", answer: { text: "Late" } })).ok).toBe(false);
  expect(respond).not.toHaveBeenCalled();
});
