// A phone picker returns no web `File`: React Native's `{ uri, name, type }`, with the size only
// when the picker knows it. No DOM here on purpose: a phone composer runs without one.
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { validateAttachment, type AttachmentUploader } from "../src/attachments.ts";
import type { AttachmentRef } from "../src/client.ts";
import { createComposer, useComposer, type ComposerOptions } from "../src/composer.ts";
import type { DraftScope } from "../src/drafts.ts";

interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
}

const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };
const reference: AttachmentRef = { id: "server-1", name: "scan.jpg", mediaType: "image/jpeg" };
const send: ComposerOptions["send"] = async () => ({
  ok: true,
  messageId: "message-1",
  outcome: "accepted",
});
const scan: PickedFile = { uri: "file:///cache/scan.jpg", name: "scan.jpg", type: "image/jpeg" };

const microtasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// Never called. It only lets the type test read what useComposer returns.
const useBlobComposer = () =>
  useComposer({ scope, send, attachments: { upload: async (_file: Blob) => reference } });

describe("files from a phone picker", () => {
  it("keeps the picker's object and hands that same object to upload, canRetry and error", async () => {
    const upload = vi
      .fn<AttachmentUploader<PickedFile>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(reference);
    const canRetry = vi.fn((_error: unknown, _file: PickedFile) => true);
    const composer = createComposer({
      scope,
      send,
      attachments: {
        upload,
        canRetry,
        error: (_error, file) => ({
          code: "upload_failed",
          message: `${file.name} did not upload. Try again.`,
        }),
      },
    });
    const picked = { ...scan, size: 2048 };
    composer.addFiles([picked]);
    await microtasks();
    const failed = composer.getState().attachments[0]!;
    expect(failed).toMatchObject({
      state: "failed",
      name: "scan.jpg",
      mediaType: "image/jpeg",
      size: 2048,
      error: { message: "scan.jpg did not upload. Try again." },
    });
    expect(failed.file).toBe(picked);
    expect(upload.mock.calls[0]?.[0]).toBe(picked);
    expect(canRetry.mock.calls[0]?.[1]).toBe(picked);

    composer.retryAttachment(failed.id);
    await microtasks();
    expect(upload.mock.calls[1]?.[0]).toBe(picked);
    expect(composer.getState().attachments[0]).toMatchObject({ state: "ready", reference });
    expect(await composer.submit()).toMatchObject({ ok: true });
    expect(composer.getState().attachments).toEqual([]);
  });

  it("checks the size limit only when the picker knows the size", async () => {
    const upload = vi.fn<AttachmentUploader<PickedFile>>(async () => reference);
    const composer = createComposer({
      scope,
      send,
      attachments: { upload, rules: { maxFileBytes: 1000 } },
    });
    composer.addFiles([{ ...scan, size: 2048 }, scan]);
    await microtasks();
    expect(composer.getState().attachments).toMatchObject([
      { state: "failed", error: { code: "attachment_size" } },
      { state: "ready" },
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(scan);
    expect(validateAttachment(scan, { maxFileBytes: 0 })).toBeUndefined();
  });

  it("takes a picker's type from upload, and keeps a web File when upload can take one", () => {
    const phone = createComposer({
      scope,
      send,
      attachments: { upload: async (_file: PickedFile) => reference },
    });
    expectTypeOf(phone.addFiles).parameter(0).toEqualTypeOf<readonly PickedFile[]>();
    expectTypeOf(phone.getState().attachments[0]?.file).toEqualTypeOf<PickedFile | undefined>();
    const web = createComposer({ scope, send });
    expectTypeOf(web.addFiles).parameter(0).toEqualTypeOf<readonly File[]>();
    // A web uploader that takes any Blob compiled before the file type existed. It still gets a File.
    const blob = createComposer({
      scope,
      send,
      attachments: { upload: async (_file: Blob) => reference },
    });
    expectTypeOf(blob.addFiles).parameter(0).toEqualTypeOf<readonly File[]>();
    expectTypeOf<ReturnType<typeof useBlobComposer>["addFiles"]>()
      .parameter(0)
      .toEqualTypeOf<readonly File[]>();
  });
});
