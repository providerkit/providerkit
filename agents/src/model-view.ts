import {
  gateImages,
  type ChatMessage,
  type ImageMimeType,
  type ImagePart,
} from "@providerkit/core";
import type {
  AgentMessage,
  ModelExecution,
  RunDefinition,
  RunSnapshot,
  ToolHistoryPolicy,
  ToolImageHistory,
} from "./types.ts";

const TEXT_ONLY = "This model cannot read images.";
const OLD_IMAGE = "Older tool image removed to make room for newer ones.";
const OLD_RESULT = "Older tool result omitted. Look it up again if you need it.";
const MAX_RESULT_CHARS = 120_000;
const KEEP_RESULT_CHARS = 60_000;

type ToolMedia = ToolImageHistory & { images?: ImagePart[] };

export function isToolHistory(value: unknown): value is ToolHistoryPolicy {
  return (
    typeof value === "object" &&
    value !== null &&
    "keepImages" in value &&
    typeof value.keepImages === "number" &&
    Number.isSafeInteger(value.keepImages) &&
    value.keepImages >= 0
  );
}

type ImagePolicy = Pick<RunDefinition, "supportsVision" | "toolHistory">;

function imageLimit(definition: ImagePolicy): number | undefined {
  return definition.supportsVision === false ? 0 : definition.toolHistory?.keepImages;
}

/** Retire only a prefix of the images. Keep the result text untouched: receipts and past
 * compaction cuts still describe that text, even after the image bytes have gone. */
export function keepImages<T extends ToolMedia>(source: T, keep: number): T {
  const images = source.images;
  if (!images || images.length <= keep) return source;
  const drop = images.length - keep;
  return {
    ...source,
    images: images.slice(drop),
    omittedImages: [
      ...(source.omittedImages ?? []),
      ...images.slice(0, drop).map((image) => image.mimeType),
    ],
  };
}

/** Result order in the model's request, not the order parallel tools happened to finish. */
function modelToolMedia(models: readonly ModelExecution[]): ToolMedia[] {
  const results: ToolMedia[] = [];
  for (const model of models) {
    if (model.status !== "completed") continue;
    for (const tool of model.tools) {
      if (tool.status === "completed" && tool.result.ok) results.push(tool.result);
    }
  }
  return results;
}

/** Newer tool results take slots before any images from the run's starting history. */
export function retainHistoryImages(
  history: AgentMessage[],
  policy: ImagePolicy,
  models: readonly ModelExecution[] = [],
): AgentMessage[] {
  let limit = imageLimit(policy);
  if (limit === undefined) return history;
  for (const tool of modelToolMedia(models))
    limit = Math.max(0, limit - (tool.images?.length ?? 0));
  const kept = [...history];
  for (let i = kept.length - 1; i >= 0; i--) {
    const message = kept[i]!;
    if (message.role !== "tool") continue;
    const result = keepImages(message, limit);
    kept[i] = result;
    limit -= result.images?.length ?? 0;
  }
  return kept;
}

export function toolMediaOf(snapshot: RunSnapshot): ToolMedia[] {
  return [
    ...snapshot.history.filter((message) => message.role === "tool"),
    ...modelToolMedia(snapshot.models),
  ];
}

/** Each result's remaining slots after newer results took theirs. Includes results that
 * already lost all their images so a host cannot erase a known, still-retained image. */
export function imageBudgets(snapshot: RunSnapshot): Map<ToolMedia, number> {
  const budgets = new Map<ToolMedia, number>();
  let remaining = imageLimit(snapshot.definition);
  if (remaining === undefined) return budgets;
  for (const source of toolMediaOf(snapshot).reverse()) {
    budgets.set(source, remaining);
    remaining = Math.max(0, remaining - (source.images?.length ?? 0));
  }
  return budgets;
}

/** The count policy has no pixel or format policy. Ask core for its omission notes only for
 * the images being omitted; retained WebP, for example, needs no dimension check here. */
export function omitImages(messages: ChatMessage[], textOnly: boolean): ChatMessage[] {
  return gateImages(
    messages,
    { minSide: 0, minArea: 0, maxDecodedBytes: Infinity, maxImages: 0 },
    {
      toolResultsOnly: !textOnly,
      reason: textOnly ? TEXT_ONLY : OLD_IMAGE,
    },
  );
}

export function imagePlaceholder(mimeType: ImageMimeType): ImagePart {
  return { type: "image", mimeType, data: "" };
}

/** Replay the high and low marks in message order. Recomputing a rolling last-60k window
 * instead would rewrite the oldest cached prefix on every turn after the first cut. */
export function pruneToolText(messages: AgentMessage[]): AgentMessage[] {
  const view = [...messages];
  let chars = 0;
  let oldest = 0;
  for (const [i, message] of view.entries()) {
    if (message.role !== "tool") continue;
    chars += message.content.length;
    if (chars <= MAX_RESULT_CHARS || view[i + 1]?.role === "tool") continue;
    while (chars > KEEP_RESULT_CHARS && oldest < i) {
      const index = oldest++;
      const old = view[index]!;
      if (old.role !== "tool" || old.content.length <= OLD_RESULT.length) continue;
      chars -= old.content.length - OLD_RESULT.length;
      view[index] = { ...old, content: OLD_RESULT };
    }
  }
  return view;
}
