import type { DraftScope } from "@providerkit/react";

export const maxFileBytes = 1024 * 1024;
export const fileTypes = ["image/png", "image/jpeg", "text/plain"];
export const draftRetentionMs = 24 * 60 * 60 * 1000;
export type SendMode = "normal" | "delay" | "refuse" | "unknown";
export type UploadMode = "normal" | "slow" | "late" | "fail";
export type ApprovalMode = "pending" | "expire" | "unknown";
export type TransportMode = "sse" | "port";

export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DemoStats {
  runs: number;
  modelCalls: number;
  toolCalls: number;
  decisions: number;
  observers: number;
  events: number;
  continuations: number;
  clientEffects: number;
  clientCompletions: number;
  reservations: number;
  gaps: number;
}

export const cardSchema = {
  type: "object" as const,
  properties: { label: { type: "string", minLength: 3, maxLength: 40 } },
  required: ["label"],
  additionalProperties: false,
};

export function cardInput(raw: unknown): { label: string } {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof raw.label !== "string" ||
    raw.label.trim().length < 3 ||
    raw.label.length > 40
  )
    throw new Refusal(422, "card_label", "Use a card label of 3 to 40 characters.");
  return { label: raw.label };
}

export function cardResult(raw: unknown): { id: string; label: string } {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    typeof raw.id !== "string" ||
    !/^[\w-]{1,100}$/.test(raw.id)
  )
    throw new Refusal(422, "card_result", "This card result is invalid. Check action result.");
  return { id: raw.id, ...cardInput({ label: raw.label }) };
}

export function apiPath(scope: DraftScope): string {
  return `/api/${encodeURIComponent(scope.principalId)}/${encodeURIComponent(scope.conversationId)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
