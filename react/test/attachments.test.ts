import { describe, expect, it } from "vitest";
import { attachmentUrl, normalizeAttachmentRef, validateAttachment } from "../src/attachments.ts";

const file = { name: "notes.TXT", type: "text/plain", size: 12 };
const reference = { id: "file-1", name: file.name, mediaType: file.type, size: file.size };

describe("attachment boundaries", () => {
  it("checks host-selected count, size and native accept rules", () => {
    expect(validateAttachment(file, { maxFiles: 1 }, 1)?.code).toBe("attachment_count");
    expect(validateAttachment(file, { maxFileBytes: 10 })?.message).toContain("12 bytes");
    expect(validateAttachment(file, { maxFileBytes: 12, accept: [".txt"] })).toBeUndefined();
    expect(validateAttachment(file, { accept: ["text/*"] })).toBeUndefined();
    expect(validateAttachment(file, { accept: ["image/png", ".pdf"] })?.code).toBe(
      "attachment_type",
    );
    expect(validateAttachment(file)).toBeUndefined();
  });

  it("copies only confirmed reference fields, never file bytes or preview metadata", () => {
    expect(
      normalizeAttachmentRef({
        ...reference,
        file: { bytes: "private" },
        base64: "private",
        previewUrl: "blob:local",
      }),
    ).toEqual(reference);
  });

  it.each([
    "blob:local",
    "data:image/png;base64,aaaa",
    "javascript:alert(1)",
    "//outside.example/x",
    "/\\outside.example/x",
    "https://user:secret@example.com/file",
    "\nhttps://example.com/file",
  ])("refuses unsafe file addresses: %s", (url) => {
    expect(attachmentUrl(url)).toBeUndefined();
    expect(normalizeAttachmentRef({ ...reference, url })).toBeNull();
  });

  it.each(["/files/one", "https://example.com/files/one", "http://localhost:3000/files/one"])(
    "allows an ordinary server address: %s",
    (url) => {
      expect(attachmentUrl(url)).toBe(url);
      expect(normalizeAttachmentRef({ ...reference, url })?.url).toBe(url);
    },
  );

  it.each([
    { id: "" },
    { name: " " },
    { mediaType: "" },
    { size: -1 },
    { size: 0.1 },
    { size: Infinity },
    { url: 12 },
  ])("rejects malformed references: %j", (invalid) => {
    expect(normalizeAttachmentRef({ ...reference, ...invalid })).toBeNull();
  });
});
