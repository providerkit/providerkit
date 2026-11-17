import type { RequestOrigin, RunSnapshot, ToolRequest, TreeNode } from "../../src/index.ts";

export function assertAgent(node: TreeNode | undefined): asserts node is RunSnapshot {
  if (node?.kind !== "agent") throw new Error("Expected an agent snapshot.");
}

export function assertCall(
  request: RequestOrigin | undefined,
): asserts request is { call: ToolRequest; step?: never } {
  if (!request?.call) throw new Error("Expected an agent tool request.");
}
