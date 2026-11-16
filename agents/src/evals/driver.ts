// One-use mock matching adapted from Google ADK JS (Apache-2.0),
// core/src/cli/cli_eval.ts. Copyright 2026 Google LLC.
// Changed: replace both core tool entry points, never fall through to real execution.
import { defineTool } from "@providerkit/core";
import type { AgentHost, Decision, PendingRequest } from "../index.ts";
import { copyData, equalData, isId, isRecord } from "../snapshot.ts";
import type { EvalDriver, EvalHost, EvalTools } from "./types.ts";

export function checkDriver(driver: EvalDriver): void {
  copyData(driver);
  if (
    !isRecord(driver) ||
    Object.keys(driver).some((key) => !["answers", "toolMocks"].includes(key))
  )
    throw new TypeError("A driver accepts only answers and toolMocks.");
  if (driver.answers !== undefined && !Array.isArray(driver.answers))
    throw new TypeError("Scripted answers must be a finite array.");
  for (const answer of driver.answers ?? []) {
    if (
      !isRecord(answer) ||
      Object.keys(answer).some(
        (key) => !["agentId", "tool", "path", "arguments", "ask", "key", "decision"].includes(key),
      ) ||
      !isId(answer.agentId) ||
      !isId(answer.tool) ||
      answer.agentId === "*" ||
      answer.tool === "*" ||
      (answer.path !== undefined &&
        (!Array.isArray(answer.path) || !answer.path.every((key) => isId(key) && key !== "*"))) ||
      (answer.arguments !== undefined && !isRecord(answer.arguments)) ||
      typeof answer.ask !== "string" ||
      !["approval", "question", "client"].includes(answer.ask) ||
      (answer.ask === "question" && (!isId(answer.key) || answer.key === "*")) ||
      !isRecord(answer.decision) ||
      typeof answer.decision.type !== "string" ||
      !["approve", "deny", "answer", "result", "cancel", "stop"].includes(answer.decision.type)
    )
      throw new TypeError(
        "Each scripted answer needs exact agent, tool and request selectors and a decision.",
      );
  }
  if (driver.toolMocks !== undefined && !Array.isArray(driver.toolMocks))
    throw new TypeError("Tool mocks must be a finite array.");
  for (const mock of driver.toolMocks ?? []) {
    if (
      !isRecord(mock) ||
      !isId(mock.name) ||
      Object.keys(mock).some((key) => !["name", "arguments", "result", "error"].includes(key)) ||
      (mock.arguments !== undefined && !isRecord(mock.arguments)) ||
      (mock.error !== undefined && typeof mock.error !== "string") ||
      (mock.error !== undefined && Object.hasOwn(mock, "result"))
    )
      throw new TypeError(
        "A tool mock needs a name, optional arguments and either a result or an error.",
      );
  }
}

/** Built anew for each case/repeat. No stored request, model prose or wildcard grants authority. */
export function createDriver(caseId: string, driver: EvalDriver = {}, host?: EvalHost) {
  const answers = copyData(driver.answers ?? []);
  const mocks = copyData(driver.toolMocks ?? []);
  const usedAnswers = new Set<number>();
  const usedMocks = new Set<number>();
  const applied = new Set<string>();
  const issued = new Map<string, PendingRequest>();
  const accepted = new Map<string, Decision>();
  const requestHost: Pick<AgentHost, "prepareRequest" | "answerNow" | "beforeTool"> = {
    async prepareRequest(draft) {
      const prepared = (await host?.prepareRequest?.(draft)) ?? {
        scope: {
          actorId: "eval",
          resource: { id: caseId, version: "1" },
          expiresAt: Date.now() + 900_000,
        },
      };
      issued.set(
        draft.id,
        copyData({ ...draft, scope: prepared.scope, ask: prepared.ask ?? draft.ask }),
      );
      return prepared;
    },
    answerNow(request) {
      if (!equalData(issued.get(request.id), request) || request.scope.expiresAt <= Date.now())
        return;
      const prior = accepted.get(request.id);
      if (prior) return copyData(prior);
      const index = answers.findIndex(
        (answer, index) =>
          !usedAnswers.has(index) &&
          answer.agentId === request.call.agentId &&
          answer.tool === request.call.call.name &&
          answer.ask === request.ask.type &&
          equalData(
            answer.path ?? [],
            request.path.map((step) => step.key),
          ) &&
          (answer.ask !== "question" ||
            (request.ask.type === "question" && answer.key === request.ask.key)) &&
          (answer.arguments === undefined || equalData(answer.arguments, request.call.arguments)),
      );
      const answer = answers[index];
      if (!answer) return;
      usedAnswers.add(index);
      accepted.set(request.id, copyData(answer.decision));
      // The SDK validates this against the actual ask and saves it before any effect.
      return copyData(answer.decision);
    },
    async beforeTool(call, decided) {
      if (
        decided &&
        (!equalData(issued.get(decided.request.id), decided.request) ||
          !equalData(accepted.get(decided.request.id), decided.decision))
      )
        throw new Error("This decision was not issued by the current test driver.");
      await host?.beforeTool?.(call, decided);
    },
  };
  return {
    host: requestHost,
    stub(tools: EvalTools): EvalTools {
      return tools.map((tool) => {
        if (!mocks.some((mock) => mock.name === tool.name)) return tool;
        if ("kind" in tool)
          throw new TypeError(
            "Mock ordinary tools only. Use scripted answers for client tools and scripted providers for specialists.",
          );
        applied.add(tool.name);
        const definition = copyData(tool.definition());
        return defineTool({
          ...definition,
          timeoutMs: tool.timeoutMs,
          isReadOnly: tool.isReadOnly,
          needsApproval: tool.needsApproval,
          isConcurrencySafe: tool.isConcurrencySafe,
          isTerminal: tool.isTerminal,
          async run(args) {
            const index = mocks.findIndex(
              (mock, index) =>
                !usedMocks.has(index) &&
                mock.name === tool.name &&
                (mock.arguments === undefined || equalData(mock.arguments, args)),
            );
            const mock = mocks[index];
            if (!mock)
              throw new Error("No mock for these arguments. Add an unused matching tool mock.");
            usedMocks.add(index);
            if (mock.error !== undefined) throw new Error(mock.error);
            return copyData(mock.result ?? null);
          },
          summarize: (result) => (typeof result === "string" ? result : JSON.stringify(result)),
        });
      });
    },
    assertApplied() {
      if (mocks.some((mock) => !applied.has(mock.name)))
        throw new Error(
          "Some tool mocks were not applied. Build the agent with factory.stub(tools) before running it.",
        );
    },
  };
}
