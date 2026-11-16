import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createChatClient, createComposer } from "@providerkit/react";
import { parseSseStream } from "@providerkit/core";
import { createSseTransport } from "@providerkit/react/sse";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type Cursor,
} from "@providerkit/react/protocol";
import { portTransport } from "./transport.ts";
import { isRecord } from "./shared.ts";
import {
  earlierMessages,
  fixtureMessageId,
  hiddenSample,
  sampleImageId,
  sampleToolId,
} from "./samples.ts";

// A focused runtime check, invoked by hand. It owns and stops only this subprocess.
assert.equal(Bun.version, "1.4.4", "Run the example check with the repo's Bun 1.4.4.");
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    new URL("./server.ts", import.meta.url).pathname,
    "--port",
    "0",
    "--tick-ms",
    "8",
  ],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
);
const timeout = setTimeout(() => child.kill(), 45000);
let base = "";

async function request(path: string, body?: unknown, headers?: HeadersInit): Promise<Response> {
  return fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Demo-Request": "1", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const path = "/api/alex/visit";
async function state() {
  const response = await request(`${path}/state`);
  assert.equal(response.status, 200);
  const event = parseChatEvent(await response.json());
  assert(event?.type === "snapshot");
  return event;
}
async function pendingApproval() {
  const approval = (await state()).messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "approval" && part.state === "pending");
  assert(approval?.type === "approval");
  return approval;
}
async function counters() {
  const value: unknown = await (await request(`${path}/stats`)).json();
  assert(isRecord(value));
  return value;
}
async function events(cursor?: Cursor) {
  const suffix = cursor ? `&after=${encodeURIComponent(JSON.stringify(cursor))}` : "";
  const response = await request(`${path}/events?once=1${suffix}`);
  assert.equal(response.status, 200);
  assert(response.body);
  const output: ChatEvent[] = [];
  for await (const data of parseSseStream(response.body)) {
    const event = parseChatEvent(JSON.parse(data));
    assert(event, "Every server event must be valid display data.");
    output.push(event);
  }
  assert(
    !JSON.stringify(output).includes("INTERNAL_ONLY_DEMO"),
    "Private synthetic SDK data leaked.",
  );
  return output;
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 6000;
  while (!(await check())) {
    assert(Date.now() < end, "The local operation did not settle in time.");
    await delay(20);
  }
}

try {
  const reader = child.stdout.getReader();
  let line = "";
  const decoder = new TextDecoder();
  while (!line.includes("\n")) {
    const chunk = await reader.read();
    assert(!chunk.done, "The server exited before printing its address.");
    line += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  const started: unknown = JSON.parse(line.split("\n")[0] ?? "");
  assert(isRecord(started) && typeof started.url === "string");
  base = started.url;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(new URL("/app.js", base))).status, 200);
  assert.equal((await fetch(new URL("/app.css", base))).status, 200);
  assert.equal((await fetch(new URL(`${path}/state`, base))).status, 403);
  assert.equal(
    (await request(`${path}/state`, undefined, { Origin: "https://foreign.invalid" })).status,
    403,
  );

  const input = { clientId: "stable-message", text: "Run the synthetic example." };
  assert.equal((await request(`${path}/send`, input)).status, 204);
  const initial = await state();
  assert.equal(initial.run.status, "running");
  const runId = initial.run.id;

  // Closing a real HTTP stream is observer cleanup, not an execution cancellation signal.
  const observer = await request(`${path}/events`);
  assert(observer.body);
  const stream = observer.body.getReader();
  assert(!(await stream.read()).done);
  await stream.cancel();
  assert.equal((await state()).run.status, "running");
  assert.equal((await request(`${path}/send`, input)).status, 204);
  assert.equal(
    (await request(`${path}/send`, { ...input, text: "Different content" })).status,
    409,
  );

  const midRun = (await events()).reduce(reduceChat, emptyChatView());
  assert.equal(midRun.run.id, runId);
  assert.equal(midRun.run.status, "running");
  assert(midRun.cursor);
  const cursor = midRun.cursor;
  const replay = await events(cursor);
  assert(replay.every((event) => event.seq === undefined || event.seq > cursor.seq));
  assert.equal(replay.reduce(reduceChat, midRun).run.id, runId);
  await until(async () => (await state()).run.status === "completed");
  const reopened = (await events()).reduce(reduceChat, emptyChatView());
  assert.equal(reopened.run.id, runId);
  assert.equal(reopened.run.status, "completed");
  assert.equal(
    reopened.messages.filter((message) => message.clientId === input.clientId).length,
    1,
  );
  assert.equal(
    reopened.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "agent" && part.state === "completed").length,
    2,
  );
  const text = reopened.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert(
    text.includes('```ts\nconst openingTime = "10:00";'),
    "Streaming must preserve code whitespace.",
  );
  assert.equal((await request(`${path}/send`, input)).status, 204);
  const counts = await counters();
  assert.equal(counts.runs, 1);
  assert.equal(counts.modelCalls, 6);
  assert.equal(counts.toolCalls, 2);
  await until(async () => (await counters()).observers === 0);

  // Earlier history is a real prepend through snapshots, never a second run or a reordered tail.
  const beforeHistory = await state();
  assert.equal((await request(`${path}/history?page=1&mode=fail`, {})).status, 503);
  assert.deepEqual(await state(), beforeHistory);
  const firstPage = await Promise.all([
    request(`${path}/history?page=1`, {}),
    request(`${path}/history?page=1`, {}),
  ]);
  assert(firstPage.every((reply) => reply.status === 204));
  assert.deepEqual((await state()).messages, [
    ...earlierMessages.slice(4),
    ...beforeHistory.messages,
  ]);
  const afterFirst = await counters();
  assert.equal((await request(`${path}/history?page=1`, {})).status, 204);
  assert.deepEqual(
    await counters(),
    afterFirst,
    "A repeated page must not publish another snapshot.",
  );
  assert.equal((await request(`${path}/history?page=2`, {})).status, 204);
  assert.deepEqual((await state()).messages, [...earlierMessages, ...beforeHistory.messages]);
  const allHistory = await counters();
  assert.equal((await request(`${path}/history?page=3`, {})).status, 204);
  assert.deepEqual(await counters(), allHistory, "An empty page must be a no-op.");
  assert.equal((await request(`${path}/history?page=99`, {})).status, 400);
  assert.equal((await state()).run.id, runId);
  assert.equal((await counters()).modelCalls, 6);

  assert.equal((await request(`${path}/fixtures`, {})).status, 204);
  const fixtures = (await state()).messages.find((message) => message.id === fixtureMessageId);
  assert(fixtures);
  const tool = fixtures.parts.find((part) => part.id === sampleToolId);
  assert(tool?.type === "tool" && tool.detail?.includes("Generated sample record"));
  assert.equal(tool.data, undefined, "The hosted tool must not copy raw SDK arguments or results.");
  const imagePart = fixtures.parts.find((part) => part.id === sampleImageId);
  assert(imagePart?.type === "attachment" && imagePart.url === undefined);
  assert(
    fixtures.parts.some(
      (part) =>
        part.type === "data" &&
        part.kind === "unhandled-sample" &&
        JSON.stringify(part.data).includes(hiddenSample),
    ),
  );
  const afterFixtures = await counters();
  assert.equal((await request(`${path}/fixtures`, {})).status, 204);
  assert.deepEqual(await counters(), afterFixtures);
  assert.equal((await counters()).modelCalls, 6);
  assert.equal((await counters()).toolCalls, 2);
  await events(); // The original SDK sentinel privacy assertion includes every new fixture.

  // Only the fixed, generated PNG can be served. Uploads, paths and remote URLs are not inputs.
  assert.equal((await fetch(new URL(`${path}/sample-image`, base))).status, 403);
  assert.equal(
    (await request(`${path}/sample-image`, undefined, { Origin: "https://foreign.invalid" }))
      .status,
    403,
  );
  assert.equal((await request(`${path}/sample-image?file=other.png`)).status, 400);
  assert.equal(
    (await request(`${path}/sample-image?url=https://example.invalid/image.png`)).status,
    400,
  );
  assert.equal((await request(`${path}/sample-image?mode=forever`)).status, 400);
  const imageStarted = Date.now();
  const image = await request(`${path}/sample-image?mode=slow`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert(Date.now() - imageStarted >= 2800, "The controlled image load must really wait.");
  assert.deepEqual(
    await image.arrayBuffer(),
    await Bun.file(new URL("./sample-image.png", import.meta.url)).arrayBuffer(),
  );
  assert.equal(
    (await fetch(new URL("/sample-link", base))).headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );

  // Host display approvals are deliberately separate from the SDK specialist run.
  assert.equal((await request(`${path}/approval`, {})).status, 204);
  const approval = await pendingApproval();
  const answers = { answers: [{ requestId: approval.id, response: { type: "approve" } }] };
  const decisions = await Promise.all([
    request(`${path}/respond`, answers),
    request(`${path}/respond`, answers),
  ]);
  assert(decisions.every((reply) => reply.status === 204));
  assert.equal((await request(`${path}/respond`, answers)).status, 204);
  assert.equal(
    (
      await request(`${path}/respond`, {
        answers: [{ requestId: approval.id, response: { type: "deny" } }],
      })
    ).status,
    409,
  );
  assert.equal((await counters()).decisions, 1);
  assert.equal((await counters()).modelCalls, 6);

  assert.equal((await request(`${path}/approval?mode=expire`, {})).status, 204);
  const expiring = await pendingApproval();
  assert.equal(typeof expiring.expiresAt, "number");
  await until(async () => (await state()).run.status === "completed");
  assert.equal(
    (
      await request(`${path}/respond`, {
        answers: [{ requestId: expiring.id, response: { type: "approve" } }],
      })
    ).status,
    409,
  );
  assert.equal((await counters()).decisions, 1);

  assert.equal((await request(`${path}/approval?mode=replace`, {})).status, 204);
  const replaced = await pendingApproval();
  const replaceAnswer = { answers: [{ requestId: replaced.id, response: { type: "approve" } }] };
  const replacements = await Promise.all([
    request(`${path}/respond`, replaceAnswer),
    request(`${path}/respond`, replaceAnswer),
  ]);
  assert(replacements.every((reply) => reply.status === 204));
  const replacement = await pendingApproval();
  assert.notEqual(replacement.id, replaced.id);
  assert(
    (await state()).messages
      .flatMap((message) => message.parts)
      .some(
        (part) => part.id === replaced.id && part.type === "approval" && part.state === "expired",
      ),
  );
  assert.equal((await request(`${path}/respond`, replaceAnswer)).status, 409);
  assert.equal((await counters()).decisions, 1, "Replacing a pending choice must not apply it.");
  assert.equal((await request(`${path}/stop`, {})).status, 204);

  assert.equal((await request(`${path}/approval?mode=unknown`, {})).status, 204);
  const uncertain = await pendingApproval();
  const uncertainAnswer = { answers: [{ requestId: uncertain.id, response: { type: "approve" } }] };
  assert.equal((await request(`${path}/respond`, uncertainAnswer)).status, 503);
  assert.equal((await request(`${path}/events?once=1`)).status, 503);
  assert.equal((await counters()).decisions, 2);
  assert.equal((await request(`${path}/respond`, uncertainAnswer)).status, 503);
  assert.equal(
    (await counters()).decisions,
    2,
    "A lost decision reply must not apply the choice twice.",
  );
  assert.equal((await request(`${path}/connect`, {})).status, 204);
  const recovered = (await events()).reduce(reduceChat, emptyChatView());
  assert(
    recovered.messages
      .flatMap((message) => message.parts)
      .some(
        (part) => part.id === uncertain.id && part.type === "approval" && part.state === "approved",
      ),
  );
  assert.equal((await counters()).modelCalls, 6, "No approval fixture continues an SDK run.");

  assert.equal(
    (await request(`${path}/send`, { clientId: "stop-this-run", text: "Stop test" })).status,
    204,
  );
  assert.equal((await request(`${path}/stop`, {})).status, 204);
  assert.equal((await state()).run.status, "stopped");

  // Unknown delivery goes through the public port transport and composer, not a mock reducer.
  const other = "/api/sam/notes";
  const http = createSseTransport({
    send: () => new URL(`${other}/send?mode=unknown`, base),
    observe: (after) =>
      new URL(
        `${other}/events${after ? `?after=${encodeURIComponent(JSON.stringify(after))}` : ""}`,
        base,
      ),
    respond: () => new URL(`${other}/respond`, base),
    stop: () => new URL(`${other}/stop`, base),
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), "X-Demo-Request": "1" },
      }),
  });
  const client = createChatClient({ transport: portTransport(http), reconnect: { attempts: 0 } });
  const detach = client.attach();
  const composer = createComposer({
    scope: { principalId: "sam", conversationId: "notes" },
    initialText: "Keep this draft after a lost reply.",
    send: client.send,
  });
  const detachComposer = composer.attach();
  try {
    const sent = await composer.submit();
    assert(sent?.ok && sent.outcome === "unknown");
    assert.equal(composer.getState().text, "Keep this draft after a lost reply.");
    assert.equal((await request(`${other}/connect`, {})).status, 204);
    client.reconnect();
    await until(() => client.getState().run.status === "completed");
    const value: unknown = await (await request(`${other}/stats`)).json();
    assert(isRecord(value));
    assert.equal(value.runs, 1);
    assert.equal(value.modelCalls, 6);
    assert.equal(value.toolCalls, 2);
    assert.equal(client.getState().messages.filter((message) => message.role === "user").length, 1);
    const retry = await client.retry(sent.messageId);
    // The host echo may have already settled the send; neither branch may execute it again.
    assert(!retry.ok && retry.error.code === "not_unconfirmed");
    const after: unknown = await (await request(`${other}/stats`)).json();
    assert(isRecord(after));
    assert.equal(after.runs, 1);
  } finally {
    detachComposer();
    detach();
  }

  const lateUpload = await fetch(new URL(`${path}/upload`, base), {
    method: "POST",
    body: new Blob(["DISCARD_UPLOAD_BODY_SAMPLE"], { type: "text/plain" }),
    headers: { "X-Demo-Request": "1", "X-Demo-Upload": "late" },
  });
  assert.equal(lateUpload.status, 200);
  const lateReference: unknown = await lateUpload.json();
  assert(isRecord(lateReference) && typeof lateReference.id === "string");
  assert.deepEqual(Object.keys(lateReference).sort(), ["id", "mediaType", "name", "size"]);
  assert(!JSON.stringify(lateReference).includes("DISCARD_UPLOAD_BODY_SAMPLE"));
  assert.equal((await request(`${path}/upload/${lateReference.id}`)).status, 404);
  assert.deepEqual(
    await (await request(`${path}/sample-image`)).arrayBuffer(),
    await Bun.file(new URL("./sample-image.png", import.meta.url)).arrayBuffer(),
    "Uploads cannot replace the generated image.",
  );

  const file = new Blob(["Synthetic upload"], { type: "text/plain" });
  const failedUpload = await fetch(new URL(`${path}/upload`, base), {
    method: "POST",
    body: file,
    headers: { "X-Demo-Request": "1", "X-Demo-Upload": "fail" },
  });
  assert.equal(failedUpload.status, 503);
  const upload = await fetch(new URL(`${path}/upload`, base), {
    method: "POST",
    body: file,
    headers: { "X-Demo-Request": "1" },
  });
  assert.equal(upload.status, 200);
  const reference: unknown = await upload.json();
  assert(isRecord(reference));
  assert.equal(reference.name, "Sample note.txt");
  assert.equal(
    (await request(`${path}/send`, { clientId: "file-only", text: "", attachments: [reference] }))
      .status,
    204,
  );
  assert.equal((await request(`${path}/stop`, {})).status, 204);
  console.log(
    "PASS: HTTP replay, two specialists, idempotent sends/decisions/history/fixtures, observer close, Stop, SDK projection privacy, bounded local image, discarded late upload contents, approval expiry/replacement/unknown delivery, unknown port send, preserved draft and attachment-only upload. Layout and focus still require a browser.",
  );
} finally {
  clearTimeout(timeout);
  child.kill();
  await child.exited;
}
