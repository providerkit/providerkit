import type { RunSnapshot } from "../../src/index.ts";
import { requestRecords } from "../../src/tree.ts";
import { assertCall } from "./assertions.ts";

export function firstRequest(snapshot: RunSnapshot) {
  const entry = [...requestRecords(snapshot)].find(
    ({ record, execution }) =>
      execution.status !== "completed" && !record.closed && !record.decision,
  );
  if (!entry) throw new Error("Expected a pending request");
  assertCall(entry.record.request);
  return entry.record.request;
}

export function evidenceFor(snapshot: RunSnapshot, evidence: unknown) {
  return { [firstRequest(snapshot).id]: evidence };
}
