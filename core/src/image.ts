// Keeping images a backend would refuse out of the request.
//
// Some backends fail the WHOLE request over one image they won't take — too
// small, too large, a format they can't size. The image is replaced with a
// note the model reads, `[image omitted: image/webp] (<reason>)`, so the turn
// still runs and the model knows something was there. Never a silent drop: a
// model answering about a screenshot it never saw is worse than one told why.
//
// Sizes come from the file header alone; nothing here decodes pixels. Ported
// from cc-proxy's Grok translator, where the limits were measured.
import type { ChatMessage, ContentPart, ImageMimeType, ImagePart } from "./types.ts";

/** What a backend accepts as an image. Every limit is measured on the backend. */
export interface ImageLimits {
  /** Smallest side, in pixels. */
  minSide: number;
  /** Smallest area, in square pixels. */
  minArea: number;
  /** Largest decoded size — width × height × bytes per pixel — in bytes. */
  maxDecodedBytes: number;
  /** Most images in one request. The newest win; older ones become notes. */
  maxImages: number;
}

interface Raster {
  width: number;
  height: number;
  /** Conservative: room for alpha whenever the format may carry it. */
  bytesPerPixel: number;
}

type RasterReader = (bytes: Uint8Array) => Raster | undefined;

const MIB = 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** By bit depth. */
const PNG_BYTES_PER_CHANNEL: Record<number, number> = { 1: 1, 2: 1, 4: 1, 8: 1, 16: 2 };
/** By color type. Grayscale and RGB may still carry transparency in a tRNS
 *  chunk, so each gets an alpha channel's room. */
const PNG_CHANNELS: Record<number, number> = { 0: 2, 2: 4, 3: 4, 4: 2, 6: 4 };

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function pngRaster(bytes: Uint8Array): Raster | undefined {
  // Signature (8), IHDR length (4), "IHDR" (4), then the IHDR fields.
  if (bytes.length < 26 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return undefined;
  const data = view(bytes);
  if (data.getUint32(8) !== 13 || ascii(bytes, 12, 16) !== "IHDR") return undefined;
  const bytesPerChannel = PNG_BYTES_PER_CHANNEL[bytes[24]!];
  const channels = PNG_CHANNELS[bytes[25]!];
  if (!bytesPerChannel || !channels) return undefined;
  return {
    width: data.getUint32(16),
    height: data.getUint32(20),
    bytesPerPixel: bytesPerChannel * channels,
  };
}

function gifRaster(bytes: Uint8Array): Raster | undefined {
  if (bytes.length < 10) return undefined;
  const signature = ascii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true), bytesPerPixel: 4 };
}

function jpegRaster(bytes: Uint8Array): Raster | undefined {
  // Walk the segments after SOI to the first frame header (SOF).
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const data = view(bytes);
  let cursor = 2;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor] !== 0xff) return undefined;
    const marker = bytes[cursor + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      cursor += 2;
      continue;
    }
    const length = data.getUint16(cursor + 2);
    if (length < 2 || cursor + 2 + length > bytes.length) return undefined;
    // SOF0..SOF15, minus DHT (c4), JPG (c8) and DAC (cc), which share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      // Length (2), precision (1), height (2), width (2), components (1).
      const components = bytes[cursor + 9] ?? 0;
      if (length < 8 || components === 0 || length < 8 + 3 * components) return undefined;
      return {
        width: data.getUint16(cursor + 7),
        height: data.getUint16(cursor + 5),
        bytesPerPixel: Math.ceil(bytes[cursor + 4]! / 8) * components,
      };
    }
    cursor += 2 + length;
  }
  return undefined;
}

// No reader for WebP: its size can't be checked, and an image that can't be
// checked can fail the whole request, so it becomes a note like any other.
const RASTER_READERS: Partial<Record<ImageMimeType, RasterReader>> = {
  "image/png": pngRaster,
  "image/jpeg": jpegRaster,
  "image/gif": gifRaster,
};

function mb(bytes: number): string {
  return `${Number((bytes / MIB).toFixed(1))}MB`;
}

/** Why the backend would refuse this image, or undefined when it would take it. */
function refusal(image: ImagePart, limits: ImageLimits): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  } catch {
    return "undecodable base64";
  }
  const raster = RASTER_READERS[image.mimeType]?.(bytes);
  if (!raster) return `unreadable dimensions for ${image.mimeType}`;
  const { width, height } = raster;
  const size = `${width}x${height}`;
  if (Math.min(width, height) < limits.minSide) {
    return `${size} below minimum side ${limits.minSide}px`;
  }
  if (width * height < limits.minArea) return `${size} below minimum area ${limits.minArea}px`;
  const decoded = width * height * raster.bytesPerPixel;
  if (decoded > limits.maxDecodedBytes) {
    return `${size} too large (decoded ~${mb(decoded)} > ${mb(limits.maxDecodedBytes)} cap)`;
  }
  return undefined;
}

function imagesOf(message: ChatMessage): ImagePart[] {
  if (message.role === "tool") return message.images ?? [];
  if (message.role === "user" && typeof message.content !== "string") {
    return message.content.filter((part): part is ImagePart => part.type === "image");
  }
  return [];
}

function omitted(image: ImagePart, reason: string): string {
  return `[image omitted: ${image.mimeType}] (${reason})`;
}

/**
 * The history with every image the limits refuse replaced by a note naming the
 * reason. In a user turn the note takes the image's place; in a tool result it
 * joins the result's text. Of the images that pass, only the newest
 * `maxImages` stay, so the latest screenshot is the one the model sees.
 */
export function gateImages(messages: readonly ChatMessage[], limits: ImageLimits): ChatMessage[] {
  // One verdict per image, in conversation order: a reason, or undefined to
  // keep it. Past the cap, the oldest images that pass give way.
  const verdicts = messages.flatMap(imagesOf).map((image) => refusal(image, limits));
  let surplus = verdicts.filter((reason) => reason === undefined).length - limits.maxImages;
  for (let i = 0; surplus > 0; i++) {
    if (verdicts[i] !== undefined) continue;
    verdicts[i] = `only the last ${limits.maxImages} images are attached per request`;
    surplus--;
  }

  let next = 0;
  return messages.map((message): ChatMessage => {
    if (message.role === "user" && typeof message.content !== "string") {
      const content = message.content.map((part): ContentPart => {
        if (part.type !== "image") return part;
        const reason = verdicts[next++];
        return reason === undefined ? part : { type: "text", text: omitted(part, reason) };
      });
      return { ...message, content };
    }
    if (message.role === "tool" && message.images?.length) {
      const images: ImagePart[] = [];
      const notes: string[] = [];
      for (const image of message.images) {
        const reason = verdicts[next++];
        if (reason === undefined) images.push(image);
        else notes.push(omitted(image, reason));
      }
      if (notes.length === 0) return message;
      const content = [message.content, ...notes].filter(Boolean).join("\n");
      return { ...message, content, images };
    }
    return message;
  });
}
