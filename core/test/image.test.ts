import { describe, expect, it } from "vitest";
import { gateImages, type ImageLimits } from "../src/image.ts";
import type { ChatMessage, ImagePart } from "../src/types.ts";

const LIMITS: ImageLimits = {
  minSide: 8,
  minArea: 512,
  maxDecodedBytes: 5 * 1024 * 1024,
  maxImages: 4,
};

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16be = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u32be = (n: number) => [...u16be(n >>> 16), ...u16be(n & 0xffff)];
const image = (mimeType: ImagePart["mimeType"], bytes: number[]): ImagePart => ({
  type: "image",
  mimeType,
  data: btoa(String.fromCharCode(...bytes)),
});

// Only the header the gate reads; the pixels never matter.
const png = (width: number, height: number) =>
  image("image/png", [
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32be(13),
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // RGBA
    ...[0, 0, 0, 0, 0, 0, 0],
  ]);
const gif = (width: number, height: number) =>
  image("image/gif", [...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0]);
// SOI, a JFIF APP0 segment the walk has to skip, then a 3-component SOF0.
const jpeg = (width: number, height: number) =>
  image("image/jpeg", [
    ...[0xff, 0xd8],
    ...[0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    ...[0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3],
    ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  ]);
const webp: ImagePart = { type: "image", mimeType: "image/webp", data: btoa("RIFF....WEBP") };

const userWith = (...images: ImagePart[]): ChatMessage => ({ role: "user", content: images });
const CAP_NOTE = "only the last 4 images are attached per request";

describe("gateImages", () => {
  it("keeps every image the limits accept, in each format it can size", () => {
    const messages = [userWith(png(32, 32), gif(64, 16), jpeg(1280, 720))];
    expect(gateImages(messages, LIMITS)).toEqual(messages);
  });

  it.each([
    ["too narrow", png(4, 4), "[image omitted: image/png] (4x4 below minimum side 8px)"],
    ["too small", png(8, 8), "[image omitted: image/png] (8x8 below minimum area 512px)"],
    [
      "too large",
      png(1920, 1080),
      "[image omitted: image/png] (1920x1080 too large (decoded ~7.9MB > 5MB cap))",
    ],
    ["webp", webp, "[image omitted: image/webp] (unreadable dimensions for image/webp)"],
    [
      "a header that lies",
      { ...jpeg(32, 32), mimeType: "image/png" } as ImagePart,
      "[image omitted: image/png] (unreadable dimensions for image/png)",
    ],
    [
      "not base64",
      { type: "image", mimeType: "image/png", data: "!!" } as ImagePart,
      "[image omitted: image/png] (undecodable base64)",
    ],
  ])("puts a note with the reason where a refused image was (%s)", (_, refused, note) => {
    const [message] = gateImages([userWith(refused)], LIMITS);
    expect(message).toEqual({ role: "user", content: [{ type: "text", text: note }] });
  });

  it("keeps only the newest images that pass, across user turns and tool results", () => {
    const oldest = png(32, 32);
    const gated = gateImages(
      [
        userWith(oldest, webp),
        { role: "tool", toolCallId: "c1", name: "shot", content: "", images: [png(40, 40)] },
        userWith(png(48, 48), png(56, 56), png(64, 64)),
      ],
      LIMITS,
    );
    expect(gated[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: `[image omitted: image/png] (${CAP_NOTE})` },
        {
          type: "text",
          text: "[image omitted: image/webp] (unreadable dimensions for image/webp)",
        },
      ],
    });
    expect(gated[1]).toMatchObject({ images: [png(40, 40)] });
    expect(gated[2]).toEqual(userWith(png(48, 48), png(56, 56), png(64, 64)));
  });

  it("adds a tool result's notes after its text and keeps the images that pass", () => {
    const [result] = gateImages(
      [
        {
          role: "tool",
          toolCallId: "c1",
          name: "shot",
          content: "saved",
          images: [png(4, 4), png(32, 32)],
        },
      ],
      LIMITS,
    );
    expect(result).toEqual({
      role: "tool",
      toolCallId: "c1",
      name: "shot",
      content: "saved\n[image omitted: image/png] (4x4 below minimum side 8px)",
      images: [png(32, 32)],
    });
  });
});
