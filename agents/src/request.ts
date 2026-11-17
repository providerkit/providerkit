import {
  defineTool,
  messageOf,
  type JsonObjectSchema,
  type Tool,
  type ToolContext,
  type ToolDefinition,
} from "@providerkit/core";
import { copyData, equalData, immutableCopy, isId, isRecord, isScope } from "./snapshot.ts";
import { emitEvent, fail, Halt, untilAbort, type ExecutionScope } from "./tree.ts";
import type {
  Answer,
  Ask,
  AskRecord,
  Decision,
  QuestionAsk,
  Resolution,
  RunOptions,
  ToolRequest,
  StepRequest,
  RequestOrigin,
} from "./types.ts";

const INPUT_REQUIRED = Symbol.for("@providerkit/agents/InputRequired");
const QUESTION_TOOL = Symbol.for("@providerkit/agents/questionTool");

/** @internal Known asking tools cannot be installed in a non-suspending guest program. */
export function isQuestionTool(tool: Tool): boolean {
  return QUESTION_TOOL in tool;
}

/** A replay-safe pre-effect boundary, not a saved JavaScript stack. The entire tool runs
 * again with context.answers. Never throw this after an external effect, even a read that
 * incurs a charge. An interrupted invocation is still unknown and is never replayed. */
export class InputRequired extends Error {
  readonly [INPUT_REQUIRED] = true;
  readonly ask: QuestionAsk;
  constructor(
    question: Omit<QuestionAsk, "type">,
    readonly problem?: string,
  ) {
    super(problem ?? question.message);
    this.name = "InputRequired";
    this.ask = immutableCopy({ ...question, type: "question" });
    if (!isAsk(this.ask)) throw new TypeError("Provide a valid question with a stable key.");
  }
}

export function isInputRequired(value: unknown): value is InputRequired {
  return (
    typeof value === "object" &&
    value !== null &&
    INPUT_REQUIRED in value &&
    value[INPUT_REQUIRED] === true &&
    "ask" in value &&
    isAsk(value.ask) &&
    value.ask.type === "question"
  );
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function schema(value: unknown): value is JsonObjectSchema {
  return isRecord(value) && value.type === "object";
}

export function isAsk(value: unknown): value is Ask {
  if (!isRecord(value)) return false;
  if (value.type === "approval")
    return (
      keys(value, ["type", "message", "editable", "approveSchema", "denySchema"]) &&
      (value.message === undefined || isId(value.message)) &&
      (value.editable === undefined || typeof value.editable === "boolean") &&
      (value.approveSchema === undefined || schema(value.approveSchema)) &&
      (value.denySchema === undefined || schema(value.denySchema))
    );
  if (value.type === "client")
    return keys(value, ["type", "resultSchema"]) && schema(value.resultSchema);
  return (
    value.type === "question" &&
    keys(value, ["type", "key", "message", "choices", "multiple", "freeText", "schema"]) &&
    isId(value.key) &&
    isId(value.message) &&
    (value.multiple === undefined || typeof value.multiple === "boolean") &&
    (value.freeText === undefined || typeof value.freeText === "boolean") &&
    (value.schema === undefined || schema(value.schema)) &&
    (value.choices === undefined ||
      (Array.isArray(value.choices) &&
        value.choices.length > 0 &&
        value.choices.every(
          (choice) =>
            isRecord(choice) &&
            keys(choice, ["id", "label", "description"]) &&
            isId(choice.id) &&
            isId(choice.label) &&
            (choice.description === undefined || isId(choice.description)),
        ) &&
        new Set(value.choices.map((choice) => choice.id)).size === value.choices.length)) &&
    (!value.multiple || value.choices !== undefined) &&
    !(value.schema !== undefined && value.choices !== undefined)
  );
}

export function isAnswer(value: unknown): value is Answer {
  return (
    isRecord(value) &&
    keys(value, ["choices", "text", "data"]) &&
    (value.text === undefined || isId(value.text)) &&
    (value.choices === undefined || (Array.isArray(value.choices) && value.choices.every(isId)))
  );
}

/** Fit checks adapted from PydanticAI (MIT), ask_user/_types.py, check_response and
 * _check_answer. Forms are checked by the trusted host and the asker's runtime validator. */
export function checkDecision(ask: Ask, raw: unknown): Decision {
  const invalid = () =>
    new TypeError(
      "The answer does not fit this request. Check its choices, fields and edit policy.",
    );
  if (!isRecord(raw) || (raw.receipt !== undefined && !isId(raw.receipt))) throw invalid();
  const common = ["type", "receipt"];
  if (raw.type === "cancel" || raw.type === "stop") {
    if (!keys(raw, common)) throw invalid();
    return { type: raw.type, ...(raw.receipt ? { receipt: raw.receipt } : {}) };
  }
  if (ask.type === "approval") {
    if (
      raw.type === "approve" &&
      keys(raw, [...common, "arguments", "data"]) &&
      (raw.arguments === undefined || (ask.editable === true && isRecord(raw.arguments))) &&
      (raw.data === undefined || (ask.approveSchema !== undefined && isRecord(raw.data)))
    )
      return copyData({
        type: "approve",
        arguments: raw.arguments,
        data: raw.data,
        receipt: raw.receipt,
      });
    if (
      raw.type === "deny" &&
      keys(raw, [...common, "message", "data"]) &&
      (raw.message === undefined || isId(raw.message)) &&
      (raw.data === undefined || (ask.denySchema !== undefined && isRecord(raw.data)))
    )
      return copyData({ type: "deny", message: raw.message, data: raw.data, receipt: raw.receipt });
    throw invalid();
  }
  if (ask.type === "client") {
    if (raw.type !== "result" || !keys(raw, [...common, "value"]) || raw.value === undefined)
      throw invalid();
    return copyData({ type: "result", value: raw.value, receipt: raw.receipt });
  }
  if (raw.type !== "answer" || !keys(raw, [...common, "answer"]) || !isAnswer(raw.answer))
    throw invalid();
  const answer = raw.answer;
  const choices = answer.choices ?? [];
  if (
    (answer.choices !== undefined && !ask.choices) ||
    choices.some((id) => !ask.choices?.some((choice) => choice.id === id)) ||
    new Set(choices).size !== choices.length ||
    (!ask.multiple && choices.length > 1) ||
    (answer.text !== undefined && !(ask.freeText || (!ask.choices && !ask.schema))) ||
    (answer.data !== undefined && (!ask.schema || !isRecord(answer.data))) ||
    (ask.schema && answer.data === undefined) ||
    (!choices.length && answer.text === undefined && answer.data === undefined)
  )
    throw invalid();
  return copyData({ type: "answer", answer, receipt: raw.receipt });
}

/** Canonical object ordering ported from TanStack AI (MIT), interrupt-serialization.ts.
 * Reuse our JSON check and Web Crypto instead of carrying another SHA-256 implementation. */
export async function requestHash(value: unknown): Promise<string> {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (isRecord(item))
      return `{${Object.keys(item)
        .filter((key) => item[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
        .join(",")}}`;
    return JSON.stringify(item);
  }
  const bytes = new TextEncoder().encode(canonical(copyData(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface ClientToolSpec<I, O> {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  /** Pure argument validation, before a client request is exposed. */
  validate: (raw: unknown) => I;
  result: { schema: JsonObjectSchema; validate: (raw: unknown) => O };
  summarize?: (output: O) => string;
  needsApproval?: boolean;
}

/** A host-registered deferred call, never an invokable local tool. */
export interface ClientTool {
  readonly kind: "client";
  readonly name: string;
  readonly needsApproval: boolean;
  readonly resultSchema: JsonObjectSchema;
  definition(): ToolDefinition;
  validateArguments(raw: unknown): void;
  result(raw: unknown): { output: unknown; summary: string };
}

export function isClientTool(value: { readonly name: string }): value is ClientTool {
  return "kind" in value && value.kind === "client";
}

export function defineClientTool<I, O>(spec: ClientToolSpec<I, O>): ClientTool {
  if (
    !isId(spec.name) ||
    !isId(spec.description) ||
    !schema(spec.inputSchema) ||
    !schema(spec.result?.schema) ||
    typeof spec.validate !== "function" ||
    typeof spec.result.validate !== "function" ||
    (spec.summarize !== undefined && typeof spec.summarize !== "function")
  )
    throw new TypeError("A client tool needs a name, schemas and input and result validators.");
  const definition = immutableCopy({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  });
  const validate = spec.validate;
  const validateResult = spec.result.validate;
  const summarize = spec.summarize;
  return Object.freeze({
    kind: "client",
    name: spec.name,
    needsApproval: spec.needsApproval ?? false,
    resultSchema: immutableCopy(spec.result.schema),
    definition: () => copyData(definition),
    validateArguments(raw: unknown) {
      validate(copyData(raw));
    },
    result(raw: unknown) {
      const output = validateResult(copyData(raw));
      const summary = summarize ? summarize(output) : JSON.stringify(output);
      if (typeof summary !== "string") throw new TypeError("A client result summary must be text.");
      return { output, summary };
    },
  });
}

/** Read only SDK-supplied answers; a host context cannot grant itself a decision. */
export function answerOf(context: ToolContext, key: string): Answer | undefined {
  const answers = context.answers;
  if (!isRecord(answers) || !Object.hasOwn(answers, key)) return undefined;
  const answer = answers[key];
  return isAnswer(answer) ? copyData(answer) : undefined;
}

/** The model can ask for text, one choice or several choices. For typed forms use a
 * host-defined InputRequired question or a coordinator's ask with a runtime validator. */
export function questionTool(options: { name?: string; description?: string } = {}): Tool {
  const tool = defineTool({
    name: options.name ?? "ask_question",
    description: options.description ?? "Ask the person a question and wait for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        choices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        multiple: { type: "boolean" },
        freeText: { type: "boolean" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    validate(raw) {
      if (!isRecord(raw) || !keys(raw, ["message", "choices", "multiple", "freeText"]))
        throw new TypeError("Pass a question and optional choices.");
      const ask = { ...raw, type: "question", key: "answer" };
      if (!isAsk(ask) || ask.type !== "question")
        throw new TypeError("Provide a question with distinct choices.");
      return ask;
    },
    async run(ask, context) {
      const answer = answerOf(context, ask.key);
      if (answer) return answer;
      throw new InputRequired(ask);
    },
  });
  return Object.assign(tool, { [QUESTION_TOOL]: true });
}

/** One call's request receipts. No second store or independent continuation engine. */
export class RequestJournal<C extends ToolRequest | StepRequest = ToolRequest> {
  constructor(
    readonly execution: { asks?: AskRecord[] },
    readonly call: C,
    private readonly options: RunOptions,
    private readonly scope: ExecutionScope,
    private readonly signal: AbortSignal,
    private readonly identity: () => Promise<string>,
    private readonly validate: (decision: Decision) => void = () => {},
    // Decisions can contain a client result or answer before toolOutput checks it. Keep the
    // authoritative decision in the private journal, never bypass the guard through progress.
    private readonly withholdDecisions = false,
  ) {}

  latest(ask: Ask): AskRecord | undefined {
    return [...(this.execution.asks ?? [])]
      .reverse()
      .find(
        (record) =>
          !record.closed &&
          record.request.ask.type === ask.type &&
          (ask.type !== "question" ||
            (record.request.ask.type === "question" && record.request.ask.key === ask.key)),
      );
  }

  async open(ask: Ask, problem?: AskRecord["problem"]): Promise<AskRecord> {
    if (!isAsk(ask)) throw new TypeError("Invalid human request.");
    const prepare = this.options.host?.prepareRequest;
    if (!prepare)
      fail(
        "request_host_missing",
        "Provide host.prepareRequest to ask for input.",
        this.call.operationId,
      );
    const origin: RequestOrigin =
      "workflowId" in this.call ? { step: this.call } : { call: this.call };
    const draft = {
      id: `${this.call.operationId}/ask/${(this.execution.asks?.length ?? 0) + 1}`,
      path: this.scope.path,
      ...origin,
      definitionHash: await this.identity(),
      ask,
      createdAt: Date.now(),
    };
    const prepared = await untilAbort(Promise.resolve(prepare(immutableCopy(draft))), this.signal);
    if (
      !prepared ||
      !isScope(prepared.scope) ||
      prepared.scope.expiresAt <= Date.now() ||
      (prepared.ask !== undefined &&
        (ask.type !== "approval" || !isAsk(prepared.ask) || prepared.ask.type !== "approval"))
    )
      fail(
        "invalid_request_scope",
        "Supply an actor, resource version and future expiry. Only approval policy may be changed.",
        this.call.operationId,
      );
    const record: AskRecord = {
      request: copyData({ ...draft, ask: prepared.ask ?? ask, scope: prepared.scope }),
      ...(problem ? { problem } : {}),
    };
    (this.execution.asks ??= []).push(record);
    await this.scope.tree.save();
    emitEvent(this.options, { type: "request", request: record.request });
    // A replacement needs a fresh answer. Reapplying a standing decision here could leave
    // the caller suspended with no open request after expiry or failed form validation.
    if (!problem) {
      const answer = await untilAbort(
        Promise.resolve(this.options.host?.answerNow?.(immutableCopy(record.request))),
        this.signal,
      );
      if (answer !== undefined) await this.accept(record, answer);
    }
    return record;
  }

  async accept(record: AskRecord, resolution: Resolution): Promise<void> {
    if (record.closed || record.decision) throw new TypeError("This request is no longer pending.");
    try {
      if (isRecord(resolution) && resolution.type === "pending") {
        if (resolution.problem !== undefined && !isId(resolution.problem))
          throw new TypeError("A request problem must be text.");
        record.problem = {
          code: "refused",
          message:
            resolution.problem ??
            "The host has not accepted this answer. Check access and try again.",
        };
      } else {
        const decision = checkDecision(record.request.ask, resolution);
        this.validate(decision);
        record.decision = decision;
        delete record.problem;
      }
    } catch (error) {
      record.problem = { code: "invalid_answer", message: messageOf(error) };
    }
    await this.scope.tree.save();
    if (record.decision && !this.withholdDecisions)
      emitEvent(this.options, {
        type: "decision",
        requestId: record.request.id,
        decision: record.decision,
      });
    // A later request can stop while an earlier one is still open. Cancel at acceptance,
    // not when execution eventually reaches this call, and only after saving the decision.
    if (record.decision?.type === "stop") {
      this.scope.tree.stop();
      throw new Halt({ status: "cancelled" });
    }
  }

  async refresh(record: AskRecord): Promise<AskRecord> {
    const stale = record.request.definitionHash !== (await this.identity());
    // Identity checks may await host policy. Measure expiry after that callback, not before it.
    const expired = record.request.scope.expiresAt <= Date.now();
    if (!expired && !stale) return record;
    // Exposing a client request can start an external effect. Expiry or definition drift is
    // not proof that the receiver did nothing, so never issue a replacement automatically.
    if (record.request.ask.type === "client")
      fail(
        "client_result_unknown",
        "The client request expired or changed. Reconcile its result with the host; it will not be sent again.",
        this.call.operationId,
      );
    record.closed = expired ? "expired" : "stale";
    return this.open(record.request.ask, {
      code: record.closed,
      message: expired
        ? "This request expired. Answer the new request."
        : "The tool changed. Review the new request before answering.",
    });
  }

  async ensure(ask: Ask): Promise<AskRecord> {
    const existing = this.latest(ask);
    if (!existing) return this.open(ask);
    if (ask.type === "question" && !equalData(ask, existing.request.ask)) {
      existing.closed = "stale";
      return this.open(ask, {
        code: "stale",
        message: "The question changed. Answer the new request.",
      });
    }
    return this.refresh(existing);
  }

  async resolve(record: AskRecord, evidence: unknown): Promise<void> {
    if ((await this.refresh(record)) !== record) return;
    const resolve = this.options.host?.resolveRequest;
    if (!resolve)
      fail(
        "request_host_missing",
        "Provide host.resolveRequest to authenticate and consume answers.",
      );
    const resolution = await untilAbort(
      Promise.resolve(resolve(immutableCopy(record.request), immutableCopy(evidence))),
      this.signal,
    );
    if (record.request.scope.expiresAt <= Date.now()) {
      await this.refresh(record);
      return;
    }
    await this.accept(record, resolution);
  }

  async assertFresh(): Promise<void> {
    for (const record of this.execution.asks ?? [])
      if (!record.closed && record.decision && (await this.refresh(record)) !== record)
        throw new Halt({ status: "suspended" });
  }

  async recheck(call: C): Promise<void> {
    const decided = (this.execution.asks ?? []).filter(
      (record) => record.decision && !record.closed,
    );
    const host = this.options.host;
    const isStep = "workflowId" in call;
    if ((isStep || decided.length) && !(isStep ? host?.beforeStep : host?.beforeTool))
      fail(
        "request_host_missing",
        isStep
          ? "Provide host.beforeStep to check ownership before workflow work."
          : "Provide host.beforeTool to recheck access before using an answer.",
        call.operationId,
      );
    const current: ToolRequest | StepRequest = call;
    const before = (record?: AskRecord) => {
      const decision = record?.decision
        ? immutableCopy({ request: record.request, decision: record.decision })
        : undefined;
      return "workflowId" in current
        ? host?.beforeStep?.(immutableCopy(current), decision)
        : host?.beforeTool?.(immutableCopy(current), decision);
    };
    for (const record of decided) {
      if ((await this.refresh(record)) !== record) throw new Halt({ status: "suspended" });
      await untilAbort(Promise.resolve(before(record)), this.signal);
      if ((await this.refresh(record)) !== record) throw new Halt({ status: "suspended" });
    }
    if (!decided.length) await untilAbort(Promise.resolve(before()), this.signal);
  }
}
