import type { RequestView } from "@providerkit/react";
import {
  checkResponse,
  type ApprovalPart,
  type QuestionPart,
  type RunInfo,
} from "@providerkit/react/protocol";
import { describe, expect, it } from "vitest";
import {
  approvalAnswer,
  approveOptions,
  bandState,
  composerButton,
  formatDuration,
  noticeView,
  questionAnswer,
  requestCard,
  type BandInput,
  type BandMemory,
  type ComposerInput,
} from "../src/ui/rules.ts";

const run = (status: RunInfo["status"], extra: Partial<RunInfo> = {}): RunInfo => ({
  id: "run-1",
  status,
  ...extra,
});
const approval = (extra: Partial<ApprovalPart> = {}): ApprovalPart => ({
  type: "approval",
  id: "ask-1",
  title: "Send the email?",
  state: "pending",
  ...extra,
});
const request = (part: RequestView["part"], extra: Partial<RequestView> = {}): RequestView => ({
  part,
  messageId: "m1",
  canRespond: true,
  ...extra,
});

/** The band across renders, the way a component holds its memory, with what it announced. */
function band() {
  let memory: BandMemory = {};
  const announced: string[] = [];
  return {
    announced,
    show(input: Partial<BandInput> & { run: RunInfo }) {
      const result = bandState({ status: "ready", canStop: true, requests: [], ...input }, memory);
      memory = result.memory;
      if (result.announce) announced.push(result.announce);
      return result.view;
    },
  };
}

describe("bandState", () => {
  it("shows work with Stop, and what a parked run waits for without Stop", () => {
    const view = band();
    expect(view.show({ run: run("running"), status: "running" })).toEqual({
      phase: "working",
      label: "working",
      stop: "ready",
    });
    expect(view.show({ run: run("running"), status: "running", canStop: false })).toMatchObject({
      stop: "none",
    });
    expect(view.show({ run: run("idle"), status: "sending" })).toMatchObject({ label: "sending" });
    expect(view.show({ run: run("running"), status: "stopping" })).toEqual({
      phase: "working",
      label: "stopping",
      stop: "pending",
    });
    const parked = run("waiting", { waitingFor: "response" });
    expect(view.show({ run: parked, status: "waiting", requests: [request(approval())] })).toEqual({
      phase: "waiting",
      label: "approval",
      stop: "none",
    });
    const question: QuestionPart = { type: "question", id: "q", title: "Which?", state: "pending" };
    expect(
      view.show({ run: parked, status: "waiting", requests: [request(question)] }),
    ).toMatchObject({
      label: "answer",
      stop: "none",
    });
  });

  it("keeps Stop when no request here can be answered, or the run waits for a scheduled time", () => {
    const view = band();
    const parked = run("waiting", { waitingFor: "response" });
    expect(
      view.show({
        run: parked,
        status: "waiting",
        requests: [request(approval({ canAnswer: false }))],
      }),
    ).toMatchObject({ stop: "ready" });
    expect(
      view.show({ run: run("waiting", { waitingFor: "continuation" }), status: "waiting" }),
    ).toEqual({ phase: "waiting", label: "continuation", stop: "ready" });
  });

  it("announces the result once, however many times the screen draws it", () => {
    const view = band();
    const working = run("running");
    for (let token = 0; token < 50; token++) view.show({ run: working, status: "running" });
    expect(view.announced).toEqual([]);
    const done = run("completed");
    expect(view.show({ run: done })).toEqual({ phase: "ended", result: "completed" });
    view.show({ run: done });
    view.show({ run: run("completed") });
    expect(view.announced).toEqual(["completed"]);
    // The next run ends with its own announcement.
    view.show({ run: run("running", { id: "run-2" }), status: "running" });
    view.show({ run: run("stopped", { id: "run-2" }) });
    expect(view.announced).toEqual(["completed", "stopped"]);
  });

  it("shows a saved result silently when the screen opens", () => {
    const view = band();
    expect(view.show({ run: run("completed") })).toEqual({ phase: "ended", result: "completed" });
    expect(view.announced).toEqual([]);
  });

  it("announces nothing for a send the host turned down, and still a run too quick to see", () => {
    const view = band();
    const before = run("completed");
    view.show({ run: before });
    view.show({ run: before, status: "sending" });
    expect(view.show({ run: before })).toEqual({ phase: "ended", result: "completed" });
    expect(view.announced).toEqual([]);
    view.show({ run: before, status: "sending" });
    expect(view.show({ run: run("failed", { id: "run-2" }) })).toEqual({
      phase: "ended",
      result: "failed",
    });
    expect(view.announced).toEqual(["failed"]);
  });
});

describe("formatDuration", () => {
  it("says seconds, then minutes with two-digit seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(9_400)).toBe("9s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("composerButton", () => {
  const base: ComposerInput = {
    text: "Hello",
    hasFiles: false,
    uploading: false,
    submitting: false,
    canSubmit: true,
    status: "ready",
    canSend: true,
    canStop: false,
    offline: false,
  };

  it("sends when there is something to send", () => {
    expect(composerButton(base)).toEqual({ action: "send", enabled: true, pending: false });
    expect(composerButton({ ...base, text: "  " })).toMatchObject({
      action: "send",
      enabled: false,
    });
    expect(composerButton({ ...base, text: "", hasFiles: true })).toMatchObject({ enabled: true });
    expect(composerButton({ ...base, submitting: true })).toMatchObject({
      enabled: false,
      pending: true,
    });
  });

  it("is Stop while a run works and the box is empty, and Queue once there are words", () => {
    const working = { ...base, status: "running" as const, canStop: true };
    expect(composerButton({ ...working, text: "" })).toEqual({
      action: "stop",
      enabled: true,
      pending: false,
    });
    expect(composerButton(working)).toEqual({ action: "queue", enabled: true, pending: false });
    expect(composerButton({ ...working, status: "stopping" })).toMatchObject({
      action: "stop",
      enabled: false,
      pending: true,
    });
  });

  it("keeps Stop for a host that takes no messages during a run", () => {
    const working = { ...base, status: "running" as const, canStop: true, canSend: false };
    expect(composerButton(working)).toMatchObject({ action: "stop", enabled: true });
    expect(composerButton({ ...working, canStop: false })).toMatchObject({
      action: "send",
      enabled: false,
    });
  });

  it("is Send while the run waits for the person, because a message answers too", () => {
    const parked = { ...base, status: "waiting" as const, parked: true, canStop: true };
    expect(composerButton(parked)).toMatchObject({ action: "send", enabled: true });
    expect(composerButton({ ...parked, parked: false, text: "" })).toMatchObject({
      action: "stop",
    });
  });

  it("says why Send is off, and never cuts the text to fit", () => {
    const long = "x".repeat(12);
    expect(composerButton({ ...base, text: long, maxLength: 10 })).toEqual({
      action: "send",
      enabled: false,
      pending: false,
      note: { kind: "tooLong", length: 12, limit: 10 },
    });
    expect(composerButton({ ...base, offline: true })).toMatchObject({
      enabled: false,
      note: { kind: "offline" },
    });
    expect(composerButton({ ...base, uploading: true })).toMatchObject({
      enabled: false,
      note: { kind: "uploading" },
    });
    // Offline, Stop is still the way out of a run.
    expect(
      composerButton({ ...base, text: "", offline: true, status: "running", canStop: true }),
    ).toMatchObject({ action: "stop", enabled: true });
  });
});

describe("noticeView", () => {
  const error = { code: "server", message: "The server failed." };

  it("says the describer's cause and fix, with its reference", () => {
    expect(
      noticeView(
        error,
        { cause: "Our server failed.", fix: "Try again.", reference: "req_1" },
        false,
        false,
      ),
    ).toEqual({ message: "Our server failed. Try again.", reference: "req_1", retry: "hidden" });
    expect(noticeView(error, undefined, false, false).message).toBe("The server failed.");
  });

  it("offers Retry only when one can work", () => {
    expect(noticeView(error, undefined, true, false).retry).toBe("on");
    expect(noticeView({ ...error, retryable: false }, undefined, true, false).retry).toBe("hidden");
    expect(noticeView(error, { recover: "wait" }, true, false).retry).toBe("on");
    expect(noticeView(error, { recover: "none" }, true, false).retry).toBe("hidden");
    expect(noticeView(error, { recover: "signin" }, true, false).retry).toBe("hidden");
    expect(noticeView(error, undefined, false, false).retry).toBe("hidden");
    expect(noticeView(error, undefined, true, true).retry).toBe("off");
  });
});

describe("the request card", () => {
  const remember = {
    type: "object",
    properties: { remember: { type: "boolean", title: "Don't ask again in this chat" } },
  };

  it("draws a form of switches, such as Remember, and refuses any other form", () => {
    expect(approveOptions(undefined)).toEqual([]);
    expect(approveOptions(remember)).toEqual([
      { name: "remember", label: "Don't ask again in this chat" },
    ]);
    expect(approveOptions({ type: "object", properties: { note: { type: "string" } } })).toBeNull();
    expect(
      approveOptions({ type: "object", properties: { a: { type: "boolean", default: true } } }),
    ).toBeNull();
    expect(approveOptions({ ...remember, additionalProperties: true })).toBeNull();
    expect(approveOptions({ type: "object", properties: {} })).toBeNull();
  });

  it("shows the host's state first, then expiry, then what this client did", () => {
    const now = 1_000;
    expect(requestCard(request(approval()), now, true)).toMatchObject({
      state: "pending",
      enabled: true,
      supported: true,
    });
    expect(requestCard(request(approval({ expiresAt: 1_000 })), now, true)).toMatchObject({
      state: "expired",
      enabled: false,
    });
    expect(requestCard(request(approval({ state: "stale" })), now, true)).toMatchObject({
      state: "stale",
      enabled: false,
    });
    const sent = { status: "submitting" as const, response: { type: "approve" as const } };
    expect(requestCard(request(approval(), { local: sent }), now, true)).toMatchObject({
      state: "submitting",
      enabled: false,
    });
    const refused = { code: "refused", message: "This request was answered on another device." };
    expect(
      requestCard(
        request(approval(), { local: { ...sent, status: "failed", error: refused } }),
        now,
        true,
      ),
    ).toMatchObject({ state: "failed", enabled: true, error: refused });
  });

  it("answers only where the host and the client allow it, and only forms it can draw", () => {
    expect(requestCard(request(approval({ canAnswer: false })), 0, true)).toMatchObject({
      allowed: false,
      enabled: false,
    });
    expect(requestCard(request(approval()), 0, false).allowed).toBe(false);
    expect(
      requestCard(request(approval({ edit: { schema: {}, value: {} } })), 0, true),
    ).toMatchObject({ supported: false, enabled: false });
    const question = {
      type: "question" as const,
      id: "q",
      title: "Which?",
      state: "pending" as const,
    };
    expect(requestCard(request({ ...question, schema: remember }), 0, true).supported).toBe(false);
    expect(requestCard(request({ ...question, freeText: false }), 0, true).supported).toBe(false);
    expect(
      requestCard(request({ ...question, choices: [{ id: "a", label: "A" }] }), 0, true).supported,
    ).toBe(true);
    const action = {
      type: "client-tool" as const,
      id: "c",
      title: "Open the camera",
      state: "pending" as const,
    };
    const unconfirmed = {
      status: "unconfirmed" as const,
      response: { type: "result" as const, value: null },
    };
    expect(
      requestCard(request(action, { canReconcile: true, local: unconfirmed }), 0, true).enabled,
    ).toBe(false);
  });

  it("builds answers the client accepts, a denial's note being what the model reads", () => {
    const options = approveOptions(remember) ?? [];
    const approve = approvalAnswer(true, "", options, { remember: true });
    expect(approve).toEqual({ type: "approve", data: { remember: true } });
    expect(checkResponse(approval({ approveForm: remember }), approve)).toBeNull();
    expect(approvalAnswer(true, "", [], {})).toEqual({ type: "approve" });
    expect(approvalAnswer(false, "  Use the other address.  ", options, {})).toEqual({
      type: "deny",
      message: "Use the other address.",
    });
    expect(approvalAnswer(false, " ", options, {})).toEqual({ type: "deny" });
    const question = {
      type: "question" as const,
      id: "q",
      title: "Which?",
      state: "pending" as const,
      choices: [{ id: "a", label: "A" }],
      freeText: true,
    };
    const answer = questionAnswer(["a"], "  and soon ");
    expect(answer).toEqual({ type: "answer", answer: { choices: ["a"], text: "and soon" } });
    expect(checkResponse(question, answer)).toBeNull();
  });
});
