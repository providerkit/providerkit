import assert from "node:assert/strict";
import type { FetchLike } from "@providerkit/core";
import { createChatClient } from "@providerkit/react";
import { createSseTransport } from "@providerkit/react/sse";
import { emptyChatView, reduceChat, type ChatEvent } from "@providerkit/react/protocol";
import { clientActions } from "./client-actions.ts";

/** Called by check.ts against its own subprocess, never the browser acceptance server. */
export async function checkFlow({
  base,
  request,
  state,
  counters,
  events,
  until,
}: {
  base: string;
  request(path: string, body?: unknown, headers?: HeadersInit): Promise<Response>;
  state(): Promise<Extract<ChatEvent, { type: "snapshot" }>>;
  counters(): Promise<Record<string, unknown>>;
  events(): Promise<ChatEvent[]>;
  until(check: () => boolean | Promise<boolean>): Promise<void>;
}) {
  const path = "/api/alex/visit";
  const answer = (requestId: string, response: unknown) =>
    request(`${path}/respond`, { answers: [{ requestId, response }] });
  async function pending() {
    await until(async () => (await state()).run.status === "waiting");
    return (await state()).messages
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          (part.type === "approval" || part.type === "question" || part.type === "client-tool") &&
          part.state === "pending",
      );
  }
  async function approval() {
    const part = (await pending()).find((part) => part.type === "approval");
    assert(part?.type === "approval");
    return part;
  }
  assert.equal((await request(`${path}/approval`, {})).status, 204);
  const questions = await pending();
  assert.equal(questions.length, 2);
  const time = questions.find((part) => part.type === "question" && part.choices);
  const note = questions.find((part) => part.type === "question" && part.freeText);
  assert(time && note);
  const flowId = (await state()).run.id;
  assert(flowId);
  assert.equal(
    (await request(`${path}/state`, undefined, { "X-Demo-Profile": "sam" })).status,
    403,
  );
  assert.equal(
    (
      await request("/api/alex/notes/respond", {
        answers: [{ requestId: time.id, response: { type: "cancel" } }],
      })
    ).status,
    409,
  );
  assert.equal((await answer(note.id, { type: "answer", answer: { text: "x" } })).status, 422);
  assert.equal((await counters()).continuations, 0, "Host validation refuses before continuation.");
  assert.equal(
    (await answer(time.id, { type: "answer", answer: { choices: ["unlisted"] } })).status,
    204,
  );
  assert.equal((await pending()).length, 2, "SDK validation leaves a bad answer open.");
  assert((await pending()).some((part) => part.id === time.id && "problem" in part));
  assert.equal(
    (await answer(note.id, { type: "answer", answer: { text: "Bring a notebook" } })).status,
    204,
  );
  assert.equal((await pending()).length, 1, "Partial answers keep the other question open.");
  const beforeDuplicate = await counters();
  assert.equal(
    (await answer(note.id, { type: "answer", answer: { text: "Bring a notebook" } })).status,
    204,
  );
  assert.equal((await counters()).continuations, beforeDuplicate.continuations);
  assert.equal(
    (await answer(note.id, { type: "answer", answer: { text: "Different answer" } })).status,
    409,
  );

  assert.equal(
    (
      await request(`${path}/enqueue`, {
        clientId: "recall-me",
        text: "Not needed",
        rootRunId: flowId,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`${path}/recall`, { id: "recall-me", rootRunId: "wrong" })).status,
    404,
  );
  const recalled = await request(`${path}/recall`, { id: "recall-me", rootRunId: flowId });
  assert.equal(recalled.status, 200);
  assert.equal((await recalled.json()).status, "recalled");
  assert.equal(
    (await answer(time.id, { type: "answer", answer: { choices: ["morning"] } })).status,
    204,
  );
  const cardApproval = await approval();
  const beforeBadEdit = await counters();
  assert.equal(
    (await answer(cardApproval.id, { type: "approve", arguments: { label: "x" } })).status,
    422,
  );
  assert.equal((await counters()).continuations, beforeBadEdit.continuations);
  const edited = { type: "approve", arguments: { label: "Approved notebook card" } };
  const simultaneous = await Promise.all([
    answer(cardApproval.id, edited),
    answer(cardApproval.id, edited),
  ]);
  assert.deepEqual(
    simultaneous.map((reply) => reply.status).sort(),
    [204, 409],
    "Only one continuation can claim the journal.",
  );
  const clientRequest = (await pending()).find((part) => part.type === "client-tool");
  assert(clientRequest?.type === "client-tool");
  assert.deepEqual(
    clientRequest.input,
    edited.arguments,
    "Use approved arguments, not model-written arguments.",
  );
  assert.equal(
    (
      await answer(clientRequest.id, {
        type: "result",
        value: { id: "forged", label: edited.arguments.label },
      })
    ).status,
    403,
  );
  const view = (await events()).reduce(reduceChat, emptyChatView());
  const claimInput = {
    requestId: clientRequest.id,
    runId: flowId,
    segment: view.cursor?.segment,
    name: clientRequest.name,
    input: clientRequest.input,
  };
  assert.equal((await request(`${path}/claim`, { ...claimInput, runId: "wrong" })).status, 403);
  assert.equal((await request(`${path}/claim`, { ...claimInput, segment: "old" })).status, 409);
  assert.equal(
    (await request(`${path}/claim`, { ...claimInput, input: { label: "Unapproved card" } })).status,
    403,
  );
  const granted = await (await request(`${path}/claim`, claimInput)).json();
  assert.equal(granted.status, "granted");
  assert.equal((await (await request(`${path}/claim`, claimInput)).json()).status, "busy");
  const execute = { ...claimInput, token: granted.token };
  assert.equal((await request(`${path}/execute`, { ...execute, token: "forged" })).status, 403);
  assert.equal(
    (await request(`${path}/execute`, { ...execute, input: { label: "Unapproved card" } })).status,
    403,
  );
  assert.equal((await request(`${path}/execute?lose=1`, execute)).status, 503);
  assert.equal((await counters()).clientEffects, 1);
  const reconciled = await (await request(`${path}/claim`, claimInput)).json();
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.value.label, edited.arguments.label);
  assert.equal(
    (
      await request(`${path}/complete`, {
        ...execute,
        value: { id: "forged", label: edited.arguments.label },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`${path}/complete?lose=1`, { ...execute, value: reconciled.value })).status,
    503,
  );
  assert.equal(
    (await request(`${path}/complete`, { ...execute, value: reconciled.value })).status,
    200,
  );
  assert.equal(
    (await counters()).clientCompletions,
    1,
    "Completion is idempotent after a lost reply.",
  );

  // A fresh client after uncertain delivery obtains the saved result and continues the real SDK.
  const scopedFetch: FetchLike = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      base,
    );
    return fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        "X-Demo-Request": "1",
        "X-Demo-Profile": "alex",
      },
    });
  };
  const transport = createSseTransport({
    fetch: scopedFetch,
    observe: () => new URL(`${path}/events`, base),
    respond: () => new URL(`${path}/respond`, base),
  });
  const restored = createChatClient({
    transport,
    clientTools: clientActions(
      { principalId: "alex", conversationId: "visit" },
      false,
      scopedFetch,
    ),
    reconnect: { attempts: 0 },
  });
  const detach = restored.attach();
  try {
    await until(() =>
      restored.getState().requests.some((item) => item.part.id === clientRequest.id),
    );
    const continuation = restored.startClientTool(clientRequest.id);
    await until(async () => (await state()).run.owner?.agentId === "visit-helper");
    const childId = (await state()).run.owner?.runId;
    assert(childId && childId !== flowId);
    assert.equal(
      (
        await request(`${path}/enqueue`, {
          clientId: "use-this",
          text: "Use the shorter version",
          rootRunId: flowId,
        })
      ).status,
      200,
    );
    await until(async () => (await counters()).reservations === 1);
    assert.equal(
      (await state()).inputs?.find((item) => item.id === "use-this")?.status,
      "queued",
      "The checkpoint delay exposes a stale queued view.",
    );
    assert.equal(
      (await request(`${path}/recall`, { id: "use-this", rootRunId: flowId })).status,
      409,
      "Reservation, not the queued label, is recall authority.",
    );
    await until(
      async () =>
        (await state()).inputs?.some(
          (item) => item.id === "use-this" && item.status === "accepted",
        ) ?? false,
    );
    assert.equal((await state()).inputs?.find((item) => item.id === "use-this")?.runId, childId);
    assert.equal(
      (
        await request(`${path}/enqueue`, {
          clientId: "late-input",
          text: "Keep this for later",
          rootRunId: flowId,
        })
      ).status,
      200,
    );
    assert((await continuation).ok);
    await until(async () => (await state()).run.status === "completed");
    const finished = await state();
    assert.equal(finished.run.id, flowId);
    assert.equal(finished.inputs?.find((item) => item.id === "use-this")?.status, "consumed");
    assert.equal(finished.inputs?.find((item) => item.id === "late-input")?.status, "queued");
    assert(
      finished.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === "text" && part.agentId === childId && part.text.includes("visit helper"),
        ),
    );
    assert.equal(
      (await counters()).clientEffects,
      1,
      "Reload and a second client must not repeat a claimed action.",
    );
    assert.equal((await counters()).runs, 2, "Late input never starts a new run.");
  } finally {
    detach();
  }
  await events(); // Sentinel privacy includes request journals and handoff notes.

  assert.equal((await request(`${path}/approval`, {})).status, 204);
  const deniedQuestions = await pending();
  assert.equal(
    (
      await request(`${path}/respond`, {
        answers: deniedQuestions.map((part) => ({
          requestId: part.id,
          response: { type: "cancel" },
        })),
      })
    ).status,
    204,
  );
  const denied = await approval();
  assert.equal((await answer(denied.id, { type: "deny" })).status, 204);
  assert.equal((await state()).run.status, "completed");
  assert.equal((await counters()).clientEffects, 1);

  // The registered handler itself claims, executes, loses delivery, then a fresh client reconciles.
  assert.equal((await request(`${path}/approval`, {})).status, 204);
  const actionQuestions = await pending();
  assert.equal(
    (
      await request(`${path}/respond`, {
        answers: actionQuestions.map((part) => ({
          requestId: part.id,
          response: { type: "cancel" },
        })),
      })
    ).status,
    204,
  );
  assert.equal((await answer((await approval()).id, { type: "approve" })).status, 204);
  const actionRequest = (await pending()).find((part) => part.type === "client-tool");
  assert(actionRequest);
  const uncertainClient = createChatClient({
    transport,
    clientTools: clientActions({ principalId: "alex", conversationId: "visit" }, true, scopedFetch),
  });
  const detachUncertain = uncertainClient.attach();
  try {
    await until(() =>
      uncertainClient.getState().requests.some((item) => item.part.id === actionRequest.id),
    );
    assert.equal((await counters()).clientEffects, 1, "Mount never executes a client action.");
    const result = await uncertainClient.startClientTool(actionRequest.id);
    assert(result.ok && result.outcome === "unknown");
    assert.equal((await counters()).clientEffects, 2);
  } finally {
    detachUncertain();
  }
  const secondClient = createChatClient({
    transport,
    clientTools: clientActions({ principalId: "alex", conversationId: "visit" }, true, scopedFetch),
  });
  const detachSecond = secondClient.attach();
  try {
    await until(() =>
      secondClient.getState().requests.some((item) => item.part.id === actionRequest.id),
    );
    assert((await secondClient.startClientTool(actionRequest.id)).ok);
    assert.equal(
      (await counters()).clientEffects,
      2,
      "A fresh handler must not run after uncertain delivery.",
    );
    assert.equal((await counters()).clientCompletions, 2);
  } finally {
    detachSecond();
  }

  assert.equal((await request(`${path}/approval?mode=expire`, {})).status, 204);
  const expiring = await pending();
  await until(async () =>
    (await pending()).every((part) => !expiring.some((old) => old.id === part.id)),
  );
  assert.equal((await answer(expiring[0]!.id, { type: "cancel" })).status, 409);
  assert(
    (await state()).messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "question" && part.state === "expired"),
  );
  assert.equal((await request(`${path}/stop`, {})).status, 204);
  assert.equal((await state()).run.status, "stopped");

  assert.equal((await request(`${path}/approval?mode=unknown`, {})).status, 204);
  const uncertain = (await pending())[0]!;
  assert.equal((await answer(uncertain.id, { type: "cancel" })).status, 503);
  const afterUnknown = await counters();
  assert.equal((await answer(uncertain.id, { type: "cancel" })).status, 503);
  assert.equal((await counters()).continuations, afterUnknown.continuations);
  assert.equal((await request(`${path}/connect`, {})).status, 204);
  const stopRequest = (await pending())[0]!;
  assert.equal((await answer(stopRequest.id, { type: "stop" })).status, 503);
  assert.equal((await state()).run.status, "stopped");
  assert.equal((await request(`${path}/connect`, {})).status, 204);

  // This is a synthetic host marker, not a database persistence test.
  assert.equal(
    (await request(`${path}/send?gap=1`, { clientId: "gap-fixture", text: "Try missing progress" }))
      .status,
    204,
  );
  await until(async () =>
    (await state()).messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.incomplete),
  );
  const gapState = await state();
  assert(
    (await events())
      .reduce(reduceChat, emptyChatView())
      .messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.incomplete),
      ),
  );
  await until(async () => (await state()).run.status === "completed");
  assert(
    !(await state()).messages
      .filter((message) => message.id === gapState.run.messageId)
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.incomplete),
  );
  assert.equal((await counters()).gaps, 1);
}
