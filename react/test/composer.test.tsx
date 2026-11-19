// @vitest-environment happy-dom
import { act, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentItem, AttachmentUploader } from "../src/attachments.ts";
import type { AttachmentRef, SendResult } from "../src/client.ts";
import {
  createComposer,
  useComposer,
  type ComposerOptions,
  type ComposerValue,
} from "../src/composer.ts";
import { createStoredDraft, type DraftScope, type DraftStorage } from "../src/drafts.ts";
import { Composer, type ComposerProps } from "../src/ui/composer.tsx";
import { AttachmentList } from "../src/ui/attachments.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };
const reference: AttachmentRef = {
  id: "server-1",
  name: "photo.png",
  mediaType: "image/png",
  url: "/files/1",
};
const accepted: SendResult = { ok: true, messageId: "message-1", outcome: "accepted" };
const sendMessage: ComposerOptions["send"] = async () => accepted;
const image = (name = "photo.png") => new File(["image bytes"], name, { type: "image/png" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let container: HTMLElement;
let root: Root;
let latest: ComposerValue;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Harness({ options, children }: { options: ComposerOptions; children?: ReactNode }) {
  const composer = useComposer(options);
  useEffect(() => {
    latest = composer;
  });
  return (
    <Composer
      key={JSON.stringify(options.scope)}
      text={composer.text}
      onTextChange={composer.setText}
      onSubmit={composer.submit}
      submitting={composer.submitting}
      canSubmit={composer.canSubmit}
      error={composer.error}
      attachments={composer.attachments}
      onFiles={composer.addFiles}
      onRemoveAttachment={composer.removeAttachment}
      onRetryAttachment={composer.retryAttachment}
      draft={composer.draft}
      onRetryDraft={composer.retryDraft}
      onDismissMissingFiles={composer.dismissMissingFiles}
    >
      {children}
    </Composer>
  );
}

function textarea(): HTMLTextAreaElement {
  const node = container.querySelector("textarea");
  if (!node) throw new Error("Missing textarea");
  return node;
}
async function key(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event;
}

const microtasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("composer send revisions", () => {
  it("sends attachments alone and prevents duplicate submits synchronously", async () => {
    const reply = deferred<SendResult>();
    const send = vi.fn<ComposerOptions["send"]>(() => reply.promise);
    const composer = createComposer({ scope, send, initialAttachments: [reference] });
    const first = composer.submit();
    expect(composer.getState().submitting).toBe(true);
    expect(await composer.submit()).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ text: "", attachments: [reference] });
    reply.resolve(accepted);
    await first;
    expect(composer.getState().attachments).toHaveLength(0);
  });

  it.each<SendResult>([
    { ok: false, error: { code: "refused", message: "Not sent. Try again.", retryable: true } },
    { ok: true, messageId: "message-1", outcome: "unknown" },
  ])("retains text and files without retry for %j", async (result) => {
    const send = vi.fn<ComposerOptions["send"]>(async () => result);
    const composer = createComposer({
      scope,
      send,
      initialText: "Keep this",
      initialAttachments: [reference],
    });
    expect(await composer.submit()).toEqual(result);
    expect(composer.getState()).toMatchObject({ text: "Keep this", submitting: false, result });
    expect(composer.getState().attachments).toHaveLength(1);
    expect(composer.getState().error).toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains work after a thrown host send without classifying it as accepted", async () => {
    const composer = createComposer({
      scope,
      initialText: "Keep",
      send: async () => {
        throw new Error("private server details");
      },
    });
    expect(await composer.submit()).toBeUndefined();
    expect(composer.getState()).toMatchObject({
      text: "Keep",
      error: { code: "unconfirmed" },
      submitting: false,
    });
    expect(composer.getState().error?.message).not.toContain("private");
  });

  it("a late acceptance clears only the submitted text and attachments, not later edits or paste", async () => {
    const reply = deferred<SendResult>();
    const composer = createComposer({
      scope,
      send: () => reply.promise,
      initialText: "First",
      initialAttachments: [reference],
      attachments: { upload: async () => ({ ...reference, id: "server-2" }) },
    });
    const sending = composer.submit();
    composer.setText("First plus more typing");
    composer.addFiles([image("later.png")]);
    await microtasks();
    reply.resolve(accepted);
    await sending;
    expect(composer.getState().text).toBe("First plus more typing");
    expect(composer.getState().attachments).toHaveLength(1);
    expect(composer.getState().attachments[0]).toMatchObject({
      name: "later.png",
      state: "ready",
      reference: { id: "server-2" },
    });
  });

  it("a revision still protects text typed back to its previous value", async () => {
    const reply = deferred<SendResult>();
    const composer = createComposer({ scope, send: () => reply.promise, initialText: "First" });
    const sending = composer.submit();
    composer.setText("Second");
    composer.setText("First");
    reply.resolve(accepted);
    await sending;
    expect(composer.getState().text).toBe("First");
  });

  it("lets go of a message the client stored for a reload, and saves the empty draft at once", async () => {
    // The stored message stays in the conversation with Retry on it. Kept here too, the same
    // words could go again as a new message.
    const saved: string[] = [];
    const storage: DraftStorage = {
      load: async () => null,
      save: async (_scope, draft) => {
        saved.push(draft.text);
      },
    };
    const stored: SendResult = {
      ok: true,
      messageId: "message-1",
      outcome: "unknown",
      stored: true,
    };
    const composer = createComposer({
      scope,
      send: async () => stored,
      initialText: "Hello",
      draft: { storage, retentionMs: 60_000 },
    });
    expect(await composer.submit()).toEqual(stored);
    expect(composer.getState()).toMatchObject({ text: "", error: undefined });
    // Without waiting out the save delay, which a reload could fall inside.
    expect(saved).toEqual([""]);
  });
});

describe("uploads", () => {
  it("starts concurrent files, shows progress and ignores late results after removal", async () => {
    const first = deferred<AttachmentRef>();
    const second = deferred<AttachmentRef>();
    const requests: Parameters<AttachmentUploader>[1][] = [];
    const upload = vi.fn<AttachmentUploader>((file, options) => {
      requests.push(options);
      return file.name === "first.png" ? first.promise : second.promise;
    });
    const composer = createComposer({ scope, send: sendMessage, attachments: { upload } });
    composer.addFiles([image("first.png"), image("second.png")]);
    expect(composer.getState().attachments.map((item) => item.state)).toEqual(["queued", "queued"]);
    await microtasks();
    expect(upload).toHaveBeenCalledTimes(2);
    requests[1]?.onProgress(0.5);
    expect(composer.getState().attachments[1]).toMatchObject({ state: "uploading", progress: 0.5 });
    composer.removeAttachment(composer.getState().attachments[0]!.id);
    expect(requests[0]?.signal.aborted).toBe(true);
    requests[0]?.onProgress(0.9);
    first.resolve(reference);
    second.resolve({ ...reference, id: "server-2" });
    await microtasks();
    expect(composer.getState().attachments).toHaveLength(1);
    expect(composer.getState().attachments[0]).toMatchObject({
      state: "ready",
      reference: { id: "server-2" },
    });
  });

  it("keeps failed files and retries only when the host explicitly permits it", async () => {
    const upload = vi
      .fn<AttachmentUploader>()
      .mockRejectedValueOnce(new Error("private failure"))
      .mockResolvedValue(reference);
    const composer = createComposer({
      scope,
      send: sendMessage,
      attachments: { upload, canRetry: () => true },
    });
    composer.addFiles([image()]);
    await microtasks();
    const failed = composer.getState().attachments[0]!;
    expect(failed).toMatchObject({ state: "failed", canRetry: true });
    expect(JSON.stringify(failed)).not.toContain("private failure");
    expect(upload).toHaveBeenCalledTimes(1);
    composer.retryAttachment(failed.id);
    composer.retryAttachment(failed.id);
    await microtasks();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(composer.getState().attachments[0]?.state).toBe("ready");

    const unsafeUpload = vi.fn<AttachmentUploader>(async () => {
      throw new Error("unknown");
    });
    const unsafe = createComposer({
      scope,
      send: sendMessage,
      attachments: { upload: unsafeUpload },
    });
    unsafe.addFiles([image()]);
    await microtasks();
    unsafe.retryAttachment(unsafe.getState().attachments[0]!.id);
    expect(unsafeUpload).toHaveBeenCalledTimes(1);
    expect(unsafe.getState().attachments[0]).toMatchObject({ state: "failed", canRetry: false });
  });

  it("rejects bad server references and checks file rules before uploading", async () => {
    const upload = vi.fn<AttachmentUploader>(async () => ({ ...reference, url: "blob:preview" }));
    const composer = createComposer({
      scope,
      send: sendMessage,
      attachments: { upload, rules: { maxFiles: 1 } },
    });
    composer.addFiles([image(), image("extra.png")]);
    await microtasks();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(composer.getState().attachments).toMatchObject([
      { state: "failed", error: { code: "attachment_reference" } },
      { state: "failed", error: { code: "attachment_count" } },
    ]);
  });
});

describe("controlled composer", () => {
  it("uses the same native form validation for Enter and the send button", async () => {
    const onSubmit = vi.fn();
    const props: ComposerProps = {
      text: "",
      onTextChange: vi.fn(),
      onSubmit,
      textareaProps: { required: true },
    };
    await act(async () => root.render(<Composer {...props} />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-part="composer-send"]')!.click();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect((await key({ key: "Enter" })).defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => root.render(<Composer {...props} text="Ready" />));
    await key({ key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps IME and Shift+Enter out of send, and keeps focus and editing while sending", async () => {
    const reply = deferred<SendResult>();
    const send = vi.fn<ComposerOptions["send"]>(() => reply.promise);
    await act(async () => root.render(<Harness options={{ scope, send, initialText: "Hello" }} />));
    expect(container.querySelector("label")?.htmlFor).toBe(textarea().id);
    expect((await key({ key: "Enter", shiftKey: true })).defaultPrevented).toBe(false);
    expect((await key({ key: "Enter", isComposing: true })).defaultPrevented).toBe(false);
    await act(async () => {
      textarea().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await key({ key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      textarea().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect((await key({ key: "Enter" })).defaultPrevented).toBe(true);
    await key({ key: "Enter" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea());
    expect(textarea().disabled).toBe(false);
    expect(textarea().readOnly).toBe(false);
    expect(container.textContent).toContain("You can keep writing");
    await act(async () => latest.setText("Next message"));
    await act(async () => {
      reply.resolve(accepted);
    });
    expect(textarea().value).toBe("Next message");
    expect(document.activeElement).toBe(textarea());
  });

  it("preserves mixed text/file paste and later typing while the upload resolves", async () => {
    const uploaded = deferred<AttachmentRef>();
    await act(async () =>
      root.render(
        <Harness
          options={{
            scope,
            send: sendMessage,
            initialText: "Before after",
            attachments: { upload: () => uploaded.promise },
          }}
        />,
      ),
    );
    textarea().setSelectionRange(7, 7);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "pasted ");
    clipboardData.items.add(image());
    await act(async () => {
      textarea().dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    expect(textarea().value).toBe("Before pasted after");
    expect(textarea().selectionStart).toBe(14);
    expect(latest.attachments[0]?.state).toBe("uploading");
    await act(async () => latest.setText("Before pasted after, and more"));
    await act(async () => uploaded.resolve(reference));
    expect(textarea().value).toBe("Before pasted after, and more");
    expect(latest.attachments[0]?.state).toBe("ready");
  });

  it("keeps focus in the composer when a retry removes the focused upload action", async () => {
    const uploaded = deferred<AttachmentRef>();
    const upload = vi
      .fn<AttachmentUploader>()
      .mockRejectedValueOnce(new Error("Upload refused"))
      .mockImplementation(() => uploaded.promise);
    await act(async () =>
      root.render(
        <Harness
          options={{ scope, send: sendMessage, attachments: { upload, canRetry: () => true } }}
        />,
      ),
    );
    await act(async () => latest.addFiles([image()]));
    const retry = container.querySelector<HTMLButtonElement>('[data-part="attachment-retry"]')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => retry.click());
    expect(upload).toHaveBeenCalledTimes(2);
    expect(latest.attachments[0]?.state).toBe("uploading");
    expect(container.querySelector('[data-part="attachment-retry"]')).toBeNull();
    expect(document.activeElement).toBe(textarea());

    const otherInput = document.createElement("input");
    container.append(otherInput);
    otherInput.focus();
    await act(async () => uploaded.resolve(reference));
    expect(document.activeElement).toBe(otherInput);
  });

  it("accepts files from the picker and drop without erasing text", async () => {
    const onFiles = vi.fn();
    const props: ComposerProps = {
      text: "Keep",
      onTextChange: vi.fn(),
      onSubmit: vi.fn(),
      onFiles,
    };
    await act(async () => root.render(<Composer {...props} />));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(image());
    const form = container.querySelector("form")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    // happy-dom's DragEvent constructor does not implement dataTransfer.
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    await act(async () => {
      form.dispatchEvent(drop);
    });
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: dataTransfer.files });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls[0]?.[0][0]?.name).toBe("photo.png");
    expect(textarea().value).toBe("Keep");
    expect(picker.value).toBe("");
  });

  it("works without hooks, guards duplicate plain callbacks and replaces visible labels", async () => {
    const reply = deferred<void>();
    const onSubmit = vi.fn(() => reply.promise);
    await act(async () =>
      root.render(
        <Composer
          text="Hello"
          onTextChange={vi.fn()}
          onSubmit={onSubmit}
          labels={{ message: "Your words", send: "Post", sending: "Posting" }}
          className="host-form"
        />,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-part="composer-send"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-part="composer-send"]')!.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Posting");
    expect(container.querySelector("label")?.textContent).toBe("Your words");
    expect(container.querySelector("form")?.classList.contains("host-form")).toBe(true);
    await act(async () => reply.resolve());
    expect(textarea().value).toBe("Hello");
  });

  it("switches principal/conversation with upload, draft load and send still pending", async () => {
    const load = deferred<unknown>();
    const uploaded = deferred<AttachmentRef>();
    const reply = deferred<SendResult>();
    const storage: DraftStorage = { load: vi.fn(() => load.promise), save: async () => {} };
    const upload = vi.fn<AttachmentUploader>(() => uploaded.promise);
    const options: ComposerOptions = {
      scope,
      send: () => reply.promise,
      draft: { storage, retentionMs: 60_000 },
      attachments: { upload },
    };
    await act(async () => root.render(<Harness options={options} />));
    const old = latest;
    await act(async () => latest.setText("Old message"));
    let sending: Promise<SendResult | undefined> | undefined;
    await act(async () => {
      sending = latest.submit();
      latest.addFiles([image()]);
    });
    const nextScope = { principalId: "person-2", conversationId: "chat-2" };
    await act(async () => root.render(<Harness options={{ ...options, scope: nextScope }} />));
    expect(textarea().value).toBe("");
    expect(upload.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.mocked(storage.load).mock.calls[0]?.[1].signal.aborted).toBe(true);
    await act(async () => {
      latest.setText("New message");
      load.resolve(
        createStoredDraft(
          scope,
          { text: "Old saved text", attachments: [], pendingFiles: 0 },
          60_000,
        ),
      );
      uploaded.resolve(reference);
      reply.resolve(accepted);
      await sending;
    });
    expect(latest.text).toBe("New message");
    expect(latest.attachments).toHaveLength(0);
    expect(latest.error).toBeUndefined();
    expect(old.text).not.toBe("New message");
  });

  it("creates previews only in effects and revokes each URL exactly once", async () => {
    let count = 0;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:preview-${++count}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const items: AttachmentItem[] = [
      {
        id: "1",
        name: "first.png",
        mediaType: "image/png",
        state: "queued",
        file: image("first.png"),
      },
      {
        id: "2",
        name: "second.png",
        mediaType: "image/png",
        state: "queued",
        file: image("second.png"),
      },
    ];
    renderToString(<AttachmentList items={items} />);
    expect(create).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <StrictMode>
          <AttachmentList items={items} />
        </StrictMode>,
      ),
    );
    expect(container.querySelectorAll("img")).toHaveLength(2);
    await act(async () =>
      root.render(
        <StrictMode>
          <AttachmentList items={items.slice(1)} />
        </StrictMode>,
      ),
    );
    await act(async () => root.render(null));
    const created = create.mock.results.map((result) => result.value);
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(created.sort());
    expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(created.length);
  });

  it("server-renders without reading layout or accessing storage", () => {
    const measure = vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => {
      throw new Error("Measured during render");
    });
    const storage: DraftStorage = { load: vi.fn(async () => null), save: vi.fn(async () => {}) };
    const html = renderToString(
      <Harness options={{ scope, send: sendMessage, draft: { storage, retentionMs: 60_000 } }} />,
    );
    expect(html).toContain("Message");
    expect(measure).not.toHaveBeenCalled();
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });
});
