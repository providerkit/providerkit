// One-use mock matching adapted from Google ADK JS (Apache-2.0),
// core/src/cli/cli_eval.ts. Copyright 2026 Google LLC.
// Changed: replace both core tool entry points, never fall through to real execution.
import { defineTool, type Tool } from "@providerkit/core";
import { isCodeTool, type CodeTool } from "../code.ts";
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
        (key) =>
          !["path", "ask", "key", "decision"].includes(key) &&
          !(
            answer.workflowId !== undefined
              ? ["workflowId", "step", "input"]
              : ["agentId", "tool", "arguments"]
          ).includes(key),
      ) ||
      (answer.workflowId !== undefined
        ? !isId(answer.workflowId) ||
          !isId(answer.step) ||
          answer.workflowId === "*" ||
          answer.step === "*"
        : !isId(answer.agentId) ||
          !isId(answer.tool) ||
          answer.agentId === "*" ||
          answer.tool === "*") ||
      (answer.path !== undefined &&
        (!Array.isArray(answer.path) || !answer.path.every((key) => isId(key) && key !== "*"))) ||
      (answer.arguments !== undefined && !isRecord(answer.arguments)) ||
      typeof answer.ask !== "string" ||
      !(
        answer.workflowId !== undefined
          ? ["approval", "question"]
          : ["approval", "question", "client"]
      ).includes(answer.ask) ||
      (answer.ask === "question" && (!isId(answer.key) || answer.key === "*")) ||
      !isRecord(answer.decision) ||
      typeof answer.decision.type !== "string" ||
      !["approve", "deny", "answer", "result", "cancel", "stop"].includes(answer.decision.type)
    )
      throw new TypeError(
        "Each scripted answer needs an exact agent/tool or workflow/step selector and a decision.",
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
  // A direct tool and every code binding must still point at one object in the SDK registry.
  const replacements = new Map<Tool, Tool>();
  const codeReplacements = new Map<CodeTool, CodeTool>();
  function stubTool(tool: Tool): Tool {
    if (!mocks.some((mock) => mock.name === tool.name)) return tool;
    const held = replacements.get(tool);
    if (held) return held;
    applied.add(tool.name);
    const definition = copyData(tool.definition());
    const replacement = defineTool({
      ...definition,
      ...(tool.outputSchema !== undefined && { outputSchema: copyData(tool.outputSchema) }),
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
    replacements.set(tool, replacement);
    replacements.set(replacement, replacement);
    return replacement;
  }
  function checkDecision(decided?: { request: PendingRequest; decision: Decision }): void {
    if (
      decided &&
      (!equalData(issued.get(decided.request.id), decided.request) ||
        !equalData(accepted.get(decided.request.id), decided.decision))
    )
      throw new Error("This decision was not issued by the current test driver.");
  }
  const requestHost: Pick<AgentHost, "prepareRequest" | "answerNow" | "beforeTool" | "beforeStep"> =
    {
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
        const matches = answers.flatMap((answer, index) =>
          !usedAnswers.has(index) &&
          (answer.workflowId !== undefined
            ? request.step !== undefined &&
              answer.workflowId === request.step.workflowId &&
              answer.step === request.step.key &&
              (answer.input === undefined || equalData(answer.input, request.step.input))
            : request.call !== undefined &&
              answer.agentId === request.call.agentId &&
              answer.tool === request.call.call.name &&
              (answer.arguments === undefined ||
                equalData(answer.arguments, request.call.arguments))) &&
          answer.ask === request.ask.type &&
          equalData(
            answer.path ?? [],
            request.path.map((step) => step.key),
          ) &&
          (answer.ask !== "question" ||
            (request.ask.type === "question" && answer.key === request.ask.key))
            ? [{ answer, index }]
            : [],
        );
        const match = matches[0];
        // Script order cannot choose between competing grants of authority.
        if (matches.length !== 1 || !match) return;
        const { answer, index } = match;
        usedAnswers.add(index);
        accepted.set(request.id, copyData(answer.decision));
        // The SDK validates this against the actual ask and saves it before any effect.
        return copyData(answer.decision);
      },
      async beforeTool(call, decided) {
        checkDecision(decided);
        await host?.beforeTool?.(call, decided);
      },
      async beforeStep(step, decided) {
        checkDecision(decided);
        await host?.beforeStep?.(step, decided);
      },
    };
  return {
    host: requestHost,
    stub(tools: EvalTools): EvalTools {
      return tools.map((tool) => {
        if ("kind" in tool) {
          if (mocks.some((mock) => mock.name === tool.name))
            throw new TypeError(
              "Mock ordinary tools only. Use scripted answers for client tools and scripted providers for specialists.",
            );
          if (!isCodeTool(tool)) return tool;
          const held = codeReplacements.get(tool);
          if (held) return held;
          const bound = tool.tools.map(stubTool);
          if (bound.every((binding, index) => binding === tool.tools[index])) return tool;
          if (typeof tool.withTools !== "function")
            throw new TypeError("This code tool cannot replace its bindings. No mock was run.");
          // Creator and helper grants compare the descriptor itself, not just its bindings.
          const replacement = tool.withTools(bound);
          codeReplacements.set(tool, replacement);
          codeReplacements.set(replacement, replacement);
          return replacement;
        }
        return stubTool(tool);
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
