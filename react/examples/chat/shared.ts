import type { DraftScope } from "@providerkit/react";

export const maxFileBytes = 1024 * 1024;
export const fileTypes = ["image/png", "image/jpeg", "text/plain"];
export const draftRetentionMs = 24 * 60 * 60 * 1000;
export type SendMode = "normal" | "delay" | "refuse" | "unknown";
export type UploadMode = "normal" | "slow" | "late" | "fail";
export type ApprovalMode = "pending" | "expire" | "unknown" | "replace";
export type TransportMode = "sse" | "port";

export interface DemoStats {
  runs: number;
  modelCalls: number;
  toolCalls: number;
  decisions: number;
  observers: number;
  events: number;
}

export function apiPath(scope: DraftScope): string {
  return `/api/${encodeURIComponent(scope.principalId)}/${encodeURIComponent(scope.conversationId)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
