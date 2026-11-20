// Adapted from PydanticAI Harness / Vstorm (MIT), sub_agents/_toolset.py and
// _control.py, and TanStack AI (MIT), first-party/agents.ts. Fork behavior follows Mastra's
// agent-controller/tools.ts (Apache-2.0). See THIRD_PARTY_NOTICES.md.
// Changed: versioned host templates, journaled grants, bounded host-selected history and
// opaque child keys. No detached work, dynamic credentials or second execution loop.
import { parseToolArgs, type ToolDefinition } from "@providerkit/core";
import {
  AGENT_RUNTIME,
  SUBAGENT_CONTEXT,
  isDelegation,
  type Delegation,
  type DelegationContext,
} from "./delegation.ts";
import { jsonBytes } from "./extensions.ts";
import { conversationOnly, isHandoff } from "./handoff.ts";
import { conversationOf, readInput } from "./input.ts";
import { matchesChildInput } from "./child.ts";
import {
  copyData,
  childRunId,
  equalData,
  immutableCopy,
  isId,
  isNames,
  isRecord,
  readLimits,
  readModelSettings,
} from "./snapshot.ts";
import { childJournals, fail, Halt, isLocalStop, untilAbort } from "./tree.ts";
import type {
  Agent,
  AgentConfig,
  AgentMessage,
  DelegationExecution,
  RecordedModelSettings,
  RunDefinition,
  RunLimits,
  RunSnapshot,
  TreeNode,
  ToolRequest,
  ToolResult,
} from "./types.ts";

/** Only the host writes these settings. The model selects the alias, never settings or a
 * provider. Hosted capabilities and tool choice cannot be changed by a model choice. */
export interface ModelChoice {
  description: string;
  settings: Omit<RecordedModelSettings, "toolChoice" | "hostedTools">;
}

/** Private model input, not a public label or authorization. limits is host-only. */
export interface SubagentDraft {
  name: string;
  task: string;
  instructions?: string;
  tools: string[];
  model?: string;
  fork?: true;
  /** Opaque helperId from a previous result, not a name or run id. */
  continues?: string;
  limits?: Partial<RunLimits>;
}

/** Only selected, already-sanitized messages can cross the fork boundary. */
export interface SubagentForkPolicy {
  identity: string;
  maxMessages: number;
  maxBytes: number;
  /** Pure host policy. Return increasing message indices, never model-selected indices. */
  select: (
    messages: readonly AgentMessage[],
    context: SubagentContext,
  ) => readonly number[] | Promise<readonly number[]>;
}

export interface SubagentContext {
  readonly call: ToolRequest;
  readonly depth: number;
  readonly level: number;
  readonly grantable: readonly string[];
  readonly signal: AbortSignal;
}

export type SubagentResult<T = unknown> = { name: string } & (
  | { status: "completed"; runId: string; helperId: string; output: T }
  | { status: "failed"; runId: string; helperId: string; error: string }
  | { status: "refused"; error: string }
);

export interface SubagentToolSpec {
  name: string;
  description: string;
  /** Host-owned provider, instructions, tools, limits, guards and output contract. */
  agent: Agent<unknown> | "self";
  models?: Readonly<Record<string, ModelChoice>>;
  defaultTools?: "none" | "all";
  /** Omitted means task-only. Forks require host.beforeTool as a live authority check. */
  fork?: SubagentForkPolicy;
  /** Continue completed helpers owned by this creator/tool. Requires host.beforeTool. */
  followUp?: boolean;
  /** Explicit recursive spawning permission. Default 1; tree depth still applies. */
  maxLevels?: number;
  maxPerCall?: number;
  maxPerRun?: number;
  needsApproval?: boolean;
  /** Pure admission policy. May narrow tools and limits, rewrite instructions/task or refuse.
   * It runs before admission and is not called again for a saved child. */
  prepare?: (
    draft: SubagentDraft,
    context: SubagentContext,
  ) => SubagentDraft | { refuse: string } | Promise<SubagentDraft | { refuse: string }>;
  /** Pure. The default is JSON in declaration order. */
  summarize?: (results: readonly SubagentResult[]) => string;
}

interface SubagentPolicy {
  models: Record<string, ModelChoice>;
  defaultTools: "none" | "all";
  maxLevels: number;
  maxPerCall: number;
  maxPerRun: number;
  needsApproval: boolean;
  prepare: boolean;
  self: boolean;
  fork: Omit<SubagentForkPolicy, "select"> | null;
  followUp: boolean;
}

/** Private admission record in the ordinary child snapshot. No functions or credentials. */
export interface SubagentRecord {
  /** SDK-issued identity. It grants nothing outside its recorded creator and root. */
  identity: { id: string; rootRunId: string; creatorRunId: string; originRunId: string };
  previousRunId?: string;
  /** Indices into conversationOnly of the creator's settled prefix at admission. */
  fork?: { indices: number[] };
  tool: string;
  requested: SubagentDraft;
  spec: SubagentDraft;
  policy: SubagentPolicy;
  template: Record<string, unknown>;
  /** Resolved host definition, before the model-written instruction suffix. */
  base: RunDefinition;
}

/** @internal Carried only through the journaled child creation path. */
export interface SubagentCreation {
  record: Omit<SubagentRecord, "base">;
  /** Self children reuse the creator's frozen frame, not its definition callbacks. */
  source?: RunDefinition;
}

const MARK = Symbol("subagent-tool");
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** UTF-8 JSON bytes for one model-supplied batch or one prepared helper. */
export const SUBAGENT_SPEC_BYTES = 65_536;

type RegisteredTool = NonNullable<AgentConfig["tools"]>[number];
interface SubagentTool extends Delegation {
  readonly [MARK]: true;
  bind(holder: () => Agent<unknown>): BoundSubagentTool;
}
interface BoundSubagentTool extends Delegation {
  readonly [MARK]: true;
  check(parent: RunSnapshot, journal: DelegationExecution): void;
}

export function isSubagentTool(tool: RegisteredTool): tool is SubagentTool {
  return MARK in tool;
}

function count(value: number, zero = false): boolean {
  return Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 1_024;
}

export function subagentLimits(base: RunLimits, lower?: Partial<RunLimits>): RunLimits {
  if (
    lower !== undefined &&
    (!isRecord(lower) ||
      Object.keys(lower).some(
        (key) => key !== "costUsd" && key !== "activeMs" && !Object.hasOwn(base, key),
      ) ||
      Object.entries(lower).some(([key, value]) => {
        // An absent optional limit is unbounded, so a host may give a helper one of its own.
        let ceiling: number | undefined;
        if (key === "costUsd") ceiling = base.costUsd ?? Infinity;
        else if (key === "activeMs") ceiling = base.activeMs ?? Infinity;
        else ceiling = Object.entries(base).find(([name]) => name === key)?.[1];
        return typeof value !== "number" || ceiling === undefined || value > ceiling;
      }))
  )
    throw new TypeError("A helper's limits may only lower its host template's limits.");
  return readLimits({ ...base, ...lower });
}

export function subagentInstructions(base: string, instructions?: string): string {
  return instructions === undefined
    ? base
    : `${base}\n\nInstructions from the agent that created you:\n${instructions}`;
}

function readDraft(raw: unknown, host = false): SubagentDraft {
  if (
    !isRecord(raw) ||
    !isId(raw.name) ||
    !NAME.test(raw.name) ||
    !isId(raw.task) ||
    (raw.instructions !== undefined && !isId(raw.instructions)) ||
    (raw.tools !== undefined && !isNames(raw.tools)) ||
    (raw.model !== undefined && (!isId(raw.model) || !NAME.test(raw.model))) ||
    (raw.fork !== undefined && typeof raw.fork !== "boolean") ||
    (raw.continues !== undefined && !isId(raw.continues)) ||
    (raw.continues !== undefined &&
      (raw.fork !== undefined ||
        (!host &&
          [raw.instructions, raw.tools, raw.model].some((value) => value !== undefined)))) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "name",
          "task",
          "instructions",
          "tools",
          "model",
          "fork",
          "continues",
          ...(host ? ["limits"] : []),
        ].includes(key),
    ) ||
    (raw.limits !== undefined && !isRecord(raw.limits))
  )
    throw new TypeError(
      "Give each helper a unique name (1 to 64 letters, digits, _ or -), a task and only the offered tools and model alias.",
    );
  // Limits are checked by subagentLimits against the actual template before admission.
  const limits: Partial<RunLimits> = {};
  if (raw.limits !== undefined) {
    for (const key of [
      "turns",
      "toolCalls",
      "elapsedMs",
      "activeMs",
      "parallelTools",
      "inlineBytes",
      "costUsd",
    ] as const) {
      const value = raw.limits[key];
      if (value !== undefined) {
        if (typeof value !== "number") throw new TypeError("Helper limits must be numbers.");
        limits[key] = value;
      }
    }
    if (Object.keys(raw.limits).some((key) => !Object.hasOwn(limits, key)))
      throw new TypeError("Use only the template's run limits.");
  }
  return {
    name: raw.name,
    task: raw.task,
    tools: raw.tools === undefined ? [] : [...raw.tools],
    ...(raw.instructions !== undefined ? { instructions: raw.instructions } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.fork === true ? { fork: true } : {}),
    ...(raw.continues !== undefined ? { continues: raw.continues } : {}),
    ...(raw.limits !== undefined ? { limits } : {}),
  };
}

/** Shape check only; the bound descriptor checks authority and identity during restore. */
export function isSubagentRecord(value: unknown): value is SubagentRecord {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isId(value.identity.id) ||
    !isId(value.identity.rootRunId) ||
    !isId(value.identity.creatorRunId) ||
    !isId(value.identity.originRunId) ||
    (value.previousRunId !== undefined && !isId(value.previousRunId)) ||
    (value.fork !== undefined &&
      (!isRecord(value.fork) ||
        !Array.isArray(value.fork.indices) ||
        !value.fork.indices.every((index) => Number.isSafeInteger(index) && index >= 0))) ||
    !isId(value.tool) ||
    !isRecord(value.policy) ||
    !isRecord(value.template) ||
    typeof value.policy.maxLevels !== "number" ||
    !count(value.policy.maxLevels) ||
    typeof value.policy.maxPerCall !== "number" ||
    !count(value.policy.maxPerCall) ||
    typeof value.policy.maxPerRun !== "number" ||
    !count(value.policy.maxPerRun, true) ||
    !["none", "all"].includes(String(value.policy.defaultTools)) ||
    !isRecord(value.policy.models) ||
    typeof value.policy.prepare !== "boolean" ||
    typeof value.policy.self !== "boolean" ||
    typeof value.policy.needsApproval !== "boolean" ||
    typeof value.policy.followUp !== "boolean" ||
    (value.policy.fork !== null && !isForkPolicy(value.policy.fork))
  )
    return false;
  try {
    return (
      equalData(value.requested, readDraft(value.requested, true)) &&
      equalData(value.spec, readDraft(value.spec, true)) &&
      jsonBytes([value.requested, value.spec]) <= SUBAGENT_SPEC_BYTES * 2 &&
      isRecord(value.base)
    );
  } catch {
    return false;
  }
}

function isForkPolicy(value: unknown): value is Omit<SubagentForkPolicy, "select"> {
  return (
    isRecord(value) &&
    isId(value.identity) &&
    typeof value.maxMessages === "number" &&
    count(value.maxMessages) &&
    typeof value.maxBytes === "number" &&
    Number.isSafeInteger(value.maxBytes) &&
    value.maxBytes > 0 &&
    value.maxBytes <= 1_000_000
  );
}

function failure(content: string): ToolResult {
  return { ok: false, kind: "invalid_input", content };
}

export function subagentTool(spec: SubagentToolSpec): Delegation {
  if (
    spec.fork !== undefined &&
    (!isForkPolicy(spec.fork) || typeof spec.fork.select !== "function")
  )
    throw new TypeError(
      "A fork needs a policy identity, a select function, maxMessages from 1 to 1024 and maxBytes from 1 to 1000000.",
    );
  if (
    !isId(spec.name) ||
    !isId(spec.description) ||
    (spec.agent !== "self" && !spec.agent?.[AGENT_RUNTIME]) ||
    (spec.defaultTools !== undefined && !["none", "all"].includes(spec.defaultTools)) ||
    (spec.prepare !== undefined && typeof spec.prepare !== "function") ||
    (spec.summarize !== undefined && typeof spec.summarize !== "function") ||
    (spec.needsApproval !== undefined && typeof spec.needsApproval !== "boolean") ||
    (spec.followUp !== undefined && typeof spec.followUp !== "boolean") ||
    (spec.models !== undefined && !isRecord(spec.models))
  )
    throw new TypeError("A subagent tool needs a name, description and a host agent or self.");
  const models: Record<string, ModelChoice> = Object.fromEntries(
    Object.entries(spec.models ?? {}).map(([alias, choice]) => {
      if (!NAME.test(alias) || !isRecord(choice) || !isId(choice.description))
        throw new TypeError("Each model alias needs a short name and a description.");
      const settings = readModelSettings(choice.settings);
      if (
        [settings.hostedTools, settings.toolChoice, settings.onActivity, settings.onRateLimit].some(
          (value) => value !== undefined,
        )
      )
        throw new TypeError("Model choices cannot change hosted tools, tool choice or callbacks.");
      return [alias, { description: choice.description, settings }];
    }),
  );
  const policy: SubagentPolicy = immutableCopy({
    models,
    defaultTools: spec.defaultTools ?? "none",
    maxLevels: spec.maxLevels ?? 1,
    maxPerCall: spec.maxPerCall ?? 4,
    maxPerRun: spec.maxPerRun ?? 8,
    needsApproval: spec.needsApproval ?? false,
    prepare: !!spec.prepare,
    self: spec.agent === "self",
    fork: spec.fork
      ? {
          identity: spec.fork.identity,
          maxMessages: spec.fork.maxMessages,
          maxBytes: spec.fork.maxBytes,
        }
      : null,
    followUp: spec.followUp ?? false,
  });
  if (!count(policy.maxLevels) || !count(policy.maxPerCall) || !count(policy.maxPerRun, true))
    throw new TypeError("Helper counts must be whole numbers up to 1024; only maxPerRun may be 0.");
  const { name, description, prepare, summarize } = spec;
  const selectFork = spec.fork?.select;
  const target = spec.agent;
  const descriptor: SubagentTool = Object.freeze({
    [MARK]: true as const,
    kind: "delegation",
    name,
    needsApproval: policy.needsApproval,
    specialists: target === "self" ? [] : [target],
    definition() {
      throw new TypeError("Register subagentTool on an agent before reading its definition.");
    },
    async execute() {
      throw new TypeError("Start model-created helpers through their registered agent.");
    },
    bind(holder: () => Agent<unknown>) {
      const template = () => (target === "self" ? holder() : target);
      function grantable(): RegisteredTool[] {
        const owner = holder()[AGENT_RUNTIME];
        const worker = template()[AGENT_RUNTIME];
        // TanStack filters the starting turn's tools. Match objects too: an identically named
        // tool with a different implementation is not the same capability.
        return worker.tools.filter(
          (tool) =>
            owner.tools.includes(tool) &&
            (owner.enabledTools === undefined || owner.enabledTools.includes(tool.name)) &&
            (worker.enabledTools === undefined || worker.enabledTools.includes(tool.name)) &&
            !isHandoff(tool) &&
            (!isDelegation(tool) || (tool === descriptor && policy.maxLevels > 1)),
        );
      }
      function allowed(parent: RunSnapshot): string[] {
        return grantable()
          .map((tool) => tool.name)
          .filter((name) => parent.definition.enabledTools.includes(name));
      }
      function drafts(raw: unknown, parent: RunSnapshot): SubagentDraft[] {
        if (jsonBytes(raw) > SUBAGENT_SPEC_BYTES)
          throw new TypeError(
            `The helper definitions exceed ${SUBAGENT_SPEC_BYTES} UTF-8 JSON bytes. Send less text.`,
          );
        if (
          !isRecord(raw) ||
          Object.keys(raw).length !== 1 ||
          !Array.isArray(raw.agents) ||
          raw.agents.length < 1 ||
          raw.agents.length > policy.maxPerCall
        )
          throw new TypeError(`Pass agents with 1 to ${policy.maxPerCall} helper definitions.`);
        const available = allowed(parent);
        const result = raw.agents.map((raw) => {
          const draft = readDraft(raw);
          if (draft.fork && !policy.fork)
            throw new TypeError("The host has not allowed history forks. Send only a task.");
          if (draft.continues && !policy.followUp)
            throw new TypeError("The host has not allowed follow-ups. Start a new helper.");
          if (
            !draft.continues &&
            isRecord(raw) &&
            raw.tools === undefined &&
            policy.defaultTools === "all"
          )
            draft.tools = [...available];
          if (draft.tools.some((tool) => !available.includes(tool)))
            throw new TypeError(
              "A helper may use only tools enabled on its creator and offered by its host template.",
            );
          if (draft.model !== undefined && !Object.hasOwn(models, draft.model))
            throw new TypeError("Choose a model alias from the host's menu, or omit model.");
          draft.tools = available.filter((name) => draft.tools.includes(name));
          return draft;
        });
        if (new Set(result.map((draft) => draft.name)).size !== result.length)
          throw new TypeError("Use a different name for each helper in this call.");
        const targets = result.flatMap((draft) => (draft.continues ? [draft.continues] : []));
        if (new Set(targets).size !== targets.length)
          throw new TypeError(
            "Send only one follow-up per helper in a call. Wait for it to finish before sending another.",
          );
        return result;
      }
      function nodes(parent: RunSnapshot, before?: DelegationExecution): RunSnapshot[] {
        const ordered = parent.models.flatMap((model) =>
          model.status === "completed"
            ? model.tools.flatMap((tool) => {
                const entry = parent.delegations.find((entry) => entry.operationId === tool.id);
                return entry ? [entry] : [];
              })
            : [],
        );
        const entries = before ? ordered.slice(0, ordered.indexOf(before)) : ordered;
        return entries.flatMap((entry) =>
          entry.children.flatMap((child) =>
            child.snapshot.kind === "agent" && child.snapshot.subagent?.tool === name
              ? [child.snapshot]
              : [],
          ),
        );
      }
      function records(parent: RunSnapshot) {
        return nodes(parent).flatMap((node) => (node.subagent ? [node.subagent] : []));
      }
      function previous(
        parent: RunSnapshot,
        journal: DelegationExecution,
        requested: SubagentDraft,
      ): RunSnapshot {
        const node = nodes(parent, journal)
          .reverse()
          .find((node) => node.subagent?.identity.id === requested.continues);
        if (
          !node?.subagent ||
          node.subagent.spec.name !== requested.name ||
          node.subagent.identity.creatorRunId !== parent.runId ||
          node.subagent.identity.rootRunId !== parent.tree.runId
        )
          throw new TypeError(
            "Use the helperId and name returned by this tool in this run. Other helpers cannot be continued here.",
          );
        if (
          !equalData(node.subagent.policy, policy) ||
          !equalData(node.subagent.template, template()[AGENT_RUNTIME].configuration())
        )
          throw new TypeError(
            "The helper's host template changed. Restore its admitted configuration before continuing.",
          );
        if (
          node.state.status !== "completed" ||
          node.models.some(
            (model) =>
              model.status !== "completed" ||
              model.tools.some((tool) => tool.status !== "completed"),
          )
        )
          throw new TypeError(
            "This helper has unfinished or uncertain work. Resolve its requests or reconcile it on the host before continuing.",
          );
        return node;
      }
      function followupSpec(prior: SubagentRecord, task: string, helperId: string): SubagentDraft {
        const { fork: _fork, ...original } = prior.spec;
        return { ...original, task, continues: helperId };
      }
      function forkHistory(
        parent: RunSnapshot,
        journal: DelegationExecution,
        indices: readonly number[],
      ): AgentMessage[] {
        const bound = policy.fork;
        const position = parent.models.findIndex(
          (model) =>
            model.status === "completed" &&
            model.tools.some((tool) => tool.id === journal.operationId),
        );
        const source = conversationOnly(conversationOf(parent, position));
        if (
          !bound ||
          position < 0 ||
          !Array.isArray(indices) ||
          indices.length > bound.maxMessages ||
          indices.some(
            (index, i) =>
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= source.length ||
              index <= (indices[i - 1] ?? -1),
          )
        )
          throw new TypeError(
            "The fork must select an ordered subset within the host's message limit.",
          );
        const history = indices.flatMap((index) => (source[index] ? [source[index]] : []));
        if (jsonBytes(history) > bound.maxBytes)
          throw new TypeError(
            "The selected fork history exceeds the host's byte limit. Select fewer messages.",
          );
        return history;
      }
      function check(parent: RunSnapshot, journal: DelegationExecution): void {
        const runtime = template()[AGENT_RUNTIME];
        const model = parent.models.find(
          (model) =>
            model.status === "completed" &&
            model.tools.some((tool) => tool.id === journal.operationId),
        );
        const position =
          model?.status === "completed"
            ? model.tools.findIndex((tool) => tool.id === journal.operationId)
            : -1;
        const execution = model?.status === "completed" ? model.tools[position] : undefined;
        const call =
          model?.status === "completed" ? model.turn.message.toolCalls?.[position] : undefined;
        if (!call || !execution || journal.kind !== "delegation")
          throw new TypeError("Missing helper creation call.");
        // An expired approval may have edited the original call. Its admission remains pinned;
        // a later edit is checked again by execute, never used to redefine an admitted child.
        const sources: unknown[] = [
          parseToolArgs(call.arguments),
          ...(execution.asks ?? []).flatMap((ask) =>
            ask.decision?.type === "approve" && ask.decision.arguments !== undefined
              ? [ask.decision.arguments]
              : [],
          ),
        ];
        const candidates = sources.flatMap((raw) => {
          try {
            return [drafts(raw, parent)];
          } catch {
            return [];
          }
        });
        for (const child of journal.children) {
          if (child.snapshot.kind !== "agent")
            throw new TypeError("A generated helper must be an agent.");
          const index = Number(child.key.slice("helper-".length)) - 1;
          const record = child.snapshot.subagent;
          if (
            !record ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= policy.maxPerCall ||
            child.key !== `helper-${index + 1}` ||
            record.tool !== name ||
            !equalData(record.policy, policy) ||
            !equalData(record.template, runtime.configuration()) ||
            !candidates.some((items) => equalData(items[index], record.requested))
          )
            throw new TypeError(
              "The saved helper definition or capabilities changed. Restore its host configuration before resuming.",
            );
          const prior = record.requested.continues
            ? previous(parent, journal, record.requested)
            : undefined;
          if (
            record.identity.rootRunId !== parent.tree.runId ||
            record.identity.creatorRunId !== parent.runId ||
            (prior
              ? !equalData(record.identity, prior.subagent?.identity) ||
                record.previousRunId !== prior.runId
              : record.previousRunId !== undefined ||
                record.identity.originRunId !== child.snapshot.runId)
          )
            throw new TypeError(
              "The helper identity does not belong to this creator or conversation.",
            );
          let history: AgentMessage[] = [];
          if (prior?.subagent) {
            if (
              !policy.followUp ||
              jsonBytes(record.spec) > SUBAGENT_SPEC_BYTES ||
              record.fork ||
              !equalData(
                record.spec,
                followupSpec(prior.subagent, record.spec.task, prior.subagent.identity.id),
              ) ||
              !equalData(record.base, prior.subagent.base)
            )
              throw new TypeError("A follow-up must keep its helper's admitted definition.");
            // Only the new task may be rewritten by host admission policy.
            checkPrepared(
              record.requested,
              { ...record.requested, task: record.spec.task },
              parent,
            );
            history = conversationOf(prior);
          } else {
            checkPrepared(record.requested, record.spec, parent);
            if (record.spec.fork) {
              if (!record.fork) throw new TypeError("Missing admitted fork history.");
              history = forkHistory(parent, journal, record.fork.indices);
            } else if (record.fork)
              throw new TypeError("A task-only helper cannot carry fork history.");
          }
          // Child creation repairs reused tool-call ids. Compare the same canonical input,
          // not the predecessor's unchanged journal.
          const start = runtime.freeze(
            readInput(
              { messages: [...history, { role: "user", content: record.spec.task }] },
              "trusted",
            ),
          );
          if (record.spec.tools.some((name) => !allowed(parent).includes(name)))
            throw new TypeError("The helper's tools are no longer granted by its creator.");
          const expectedNames = runtime.tools
            .map((tool) => tool.name)
            .filter((name) => record.spec.tools.includes(name));
          if (runtime.configuration().output !== null) expectedNames.push("submit_result");
          const baseSettings = policy.self
            ? parent.definition.modelSettings
            : runtime.configuration().modelSettings;
          const expectedSettings = {
            ...readModelSettings(baseSettings),
            ...models[record.spec.model ?? ""]?.settings,
          };
          const baseInstructions = policy.self
            ? parent.definition.instructions
            : runtime.configuration().instructions;
          if (
            child.snapshot.agentId !== template().id ||
            child.snapshot.version !== template().version ||
            child.snapshot.session !== undefined ||
            !matchesChildInput(child.snapshot, start) ||
            !equalData(child.snapshot.limits, subagentLimits(runtime.limits, record.spec.limits)) ||
            !equalData(record.base.enabledTools, expectedNames) ||
            !equalData(record.base.modelSettings, expectedSettings) ||
            (typeof baseInstructions === "string" &&
              record.base.instructions !== baseInstructions) ||
            !equalData(child.snapshot.definition, {
              ...record.base,
              instructions: subagentInstructions(
                record.base.instructions,
                record.spec.instructions,
              ),
            })
          )
            throw new TypeError(
              "The saved helper no longer matches its admitted task, tools or definition.",
            );
        }
        const admitted = records(parent);
        const origins = admitted.filter((record) => !record.previousRunId);
        if (
          admitted.length > policy.maxPerRun ||
          new Set(origins.map((record) => record.spec.name)).size !== origins.length ||
          new Set(origins.map((record) => record.identity.id)).size !== origins.length
        )
          throw new TypeError(
            "The saved helpers exceed this tool's per-run limit or reuse a name.",
          );
      }
      function checkPrepared(
        requested: SubagentDraft,
        prepared: SubagentDraft,
        parent: RunSnapshot,
      ): void {
        if (
          (!prepare && !equalData(requested, prepared)) ||
          jsonBytes(prepared) > SUBAGENT_SPEC_BYTES ||
          prepared.name !== requested.name ||
          prepared.model !== requested.model ||
          prepared.fork !== requested.fork ||
          prepared.continues !== requested.continues ||
          (requested.continues !== undefined &&
            !equalData({ ...prepared, task: requested.task }, requested)) ||
          prepared.tools.some(
            (name) => !requested.tools.includes(name) || !allowed(parent).includes(name),
          )
        )
          throw new TypeError(
            "Admission policy may narrow tools and limits, not change identity or grant capabilities.",
          );
        subagentLimits(template()[AGENT_RUNTIME].limits, prepared.limits);
      }
      async function prepareDraft(
        requested: SubagentDraft,
        parent: RunSnapshot,
        context: SubagentContext,
      ): Promise<SubagentDraft | { refuse: string }> {
        try {
          const prepared = prepare
            ? await untilAbort(
                Promise.resolve(prepare(immutableCopy(requested), Object.freeze(context))),
                context.signal,
              )
            : requested;
          context.signal.throwIfAborted();
          if (isRecord(prepared) && isId(prepared.refuse)) {
            if (jsonBytes(prepared.refuse) > SUBAGENT_SPEC_BYTES)
              throw new TypeError("The admission refusal is too large.");
            return { refuse: prepared.refuse };
          }
          const admitted = readDraft(prepared, true);
          checkPrepared(requested, admitted, parent);
          admitted.tools = allowed(parent).filter((name) => admitted.tools.includes(name));
          return admitted;
        } catch {
          context.signal.throwIfAborted();
          fail(
            "subagent_policy_failed",
            "The helper admission policy failed or tried to grant capabilities. Check the host policy before starting new work.",
          );
        }
      }
      return Object.freeze({
        [MARK]: true as const,
        kind: "delegation" as const,
        name,
        needsApproval: policy.needsApproval,
        get specialists() {
          return [template()];
        },
        definition(): ToolDefinition {
          const aliases = Object.keys(models);
          const grants = grantable().map((tool) => tool.name);
          return {
            name,
            description,
            inputSchema: {
              type: "object",
              properties: {
                agents: {
                  type: "array",
                  minItems: 1,
                  maxItems: policy.maxPerCall,
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Private name: 1 to 64 letters, digits, _ or -.",
                      },
                      task: { type: "string" },
                      instructions: { type: "string" },
                      ...(policy.fork
                        ? {
                            fork: {
                              type: "boolean",
                              description: "Ask the host to share approved earlier messages.",
                            },
                          }
                        : {}),
                      ...(policy.followUp
                        ? {
                            continues: {
                              type: "string",
                              description:
                                "The helperId returned by this tool. Pass only name, task and continues for a follow-up.",
                            },
                          }
                        : {}),
                      tools: {
                        type: "array",
                        items: { type: "string", ...(grants.length ? { enum: grants } : {}) },
                        ...(grants.length ? {} : { maxItems: 0 }),
                        uniqueItems: true,
                      },
                      ...(aliases.length
                        ? {
                            model: {
                              type: "string",
                              enum: aliases,
                              description: aliases
                                .map((alias) => `${alias}: ${models[alias]?.description}`)
                                .join("\n"),
                            },
                          }
                        : {}),
                    },
                    required: ["name", "task"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["agents"],
              additionalProperties: false,
            },
          };
        },
        check,
        async execute(raw: unknown, context: DelegationContext): Promise<ToolResult> {
          const internal = context[SUBAGENT_CONTEXT];
          if (!internal)
            throw new TypeError("Helper creation needs a journaled delegation context.");
          const { parent, journal, scope, request, signal } = internal;
          let items: SubagentDraft[];
          try {
            items = drafts(raw, parent);
          } catch (error) {
            if (journal.children.length)
              fail(
                "subagent_input_changed",
                "An admitted helper's definition cannot change. Reconcile the saved run before starting different work.",
              );
            return failure(error instanceof Error ? error.message : "Invalid helper definitions.");
          }
          check(parent, journal);
          for (const child of journal.children)
            if (
              !equalData(
                child.snapshot.kind === "agent" ? child.snapshot.subagent?.requested : undefined,
                items[Number(child.key.slice("helper-".length)) - 1],
              )
            )
              fail(
                "subagent_input_changed",
                "An admitted helper's definition cannot change. Reconcile the saved run before starting different work.",
              );
          const ancestors = scope.path.reduce<TreeNode[]>(
            (nodes, step) => {
              const parent = nodes.at(-1);
              const node =
                parent &&
                childJournals(parent)
                  .find((entry) => entry.operationId === step.operationId)
                  ?.children.find((child) => child.key === step.key)?.snapshot;
              if (!node) throw new TypeError("Missing helper ancestor in the execution tree.");
              nodes.push(node);
              return nodes;
            },
            [scope.tree.root],
          );
          const created = ancestors.flatMap((node) =>
            node.kind === "agent" && node.subagent ? [node.subagent] : [],
          );
          const level = created.length + 1;
          if (
            level > Math.min(policy.maxLevels, ...created.map((record) => record.policy.maxLevels))
          )
            return failure(
              "Recursive helper creation is not allowed here. Complete the task with the tools you have.",
            );
          const existing = records(parent);
          const remaining = Math.min(
            policy.maxPerRun - existing.length,
            scope.tree.childRoom(scope.depth + 1),
          );
          if (items.length - journal.children.length > remaining)
            return failure(
              `There is room for ${Math.max(0, remaining)} more helpers. Request fewer helpers or do the work here.`,
            );
          const continuations = new Map<string, RunSnapshot>();
          try {
            for (const item of items)
              if (item.continues)
                continuations.set(item.continues, previous(parent, journal, item));
          } catch (error) {
            if (journal.children.length) throw error;
            return failure(error instanceof Error ? error.message : "Invalid helper follow-up.");
          }
          if (
            items.some(
              (item, index) =>
                !item.continues &&
                !journal.children.some((child) => child.key === `helper-${index + 1}`) &&
                existing.some((record) => record.spec.name === item.name),
            )
          )
            return failure("A helper with that name already exists in this run. Use a new name.");
          const handles = [];
          const results: SubagentResult[] = [];
          for (const [index, requested] of items.entries()) {
            const key = `helper-${index + 1}`;
            const saved = journal.children.find((child) => child.key === key);
            const prior = requested.continues ? continuations.get(requested.continues) : undefined;
            const admissionContext: SubagentContext = {
              call: immutableCopy(request),
              depth: scope.depth + 1,
              level,
              grantable: Object.freeze(allowed(parent)),
              signal,
            };
            if (saved && saved.snapshot.kind !== "agent")
              throw new TypeError("A generated helper must be an agent.");
            const savedHelper =
              saved?.snapshot.kind === "agent" ? saved.snapshot.subagent : undefined;
            let admitted = savedHelper?.spec;
            if (!admitted) {
              const prepared = await prepareDraft(requested, parent, admissionContext);
              if ("refuse" in prepared) {
                results.push({ name: requested.name, status: "refused", error: prepared.refuse });
                continue;
              }
              admitted = prior?.subagent
                ? followupSpec(prior.subagent, prepared.task, prior.subagent.identity.id)
                : prepared;
            }
            if (jsonBytes(admitted) > SUBAGENT_SPEC_BYTES)
              fail(
                "subagent_spec_limit",
                `The helper's saved definition and new task exceed ${SUBAGENT_SPEC_BYTES} UTF-8 JSON bytes. Send a shorter task.`,
              );
            let fork = savedHelper?.fork;
            let history = prior ? conversationOf(prior) : [];
            if (admitted.fork) {
              if (!fork) {
                if (!selectFork) throw new TypeError("Missing host fork policy.");
                try {
                  const selected = await untilAbort(
                    Promise.resolve(
                      selectFork(
                        immutableCopy(conversationOnly(context.conversation)),
                        Object.freeze(admissionContext),
                      ),
                    ),
                    signal,
                  );
                  history = forkHistory(parent, journal, selected);
                  fork = { indices: [...selected] };
                } catch {
                  signal.throwIfAborted();
                  fail(
                    "subagent_policy_failed",
                    "The fork policy failed or exceeded its limits. Check the host's history filter before trying again.",
                  );
                }
              } else history = forkHistory(parent, journal, fork.indices);
            }
            // New history use is an authority boundary, not permission inferred from prose.
            // Also recheck on replay before an unfinished child can continue.
            if (admitted.fork || prior) {
              await internal.recheck(holder(), parent);
              if (prior) await internal.recheck(template(), prior);
            }
            const identity = savedHelper?.identity ??
              prior?.subagent?.identity ?? {
                id: crypto.randomUUID(),
                rootRunId: parent.tree.runId,
                creatorRunId: parent.runId,
                originRunId: childRunId(journal.operationId, key),
              };
            const creation: SubagentCreation = {
              record: {
                identity,
                ...(prior ? { previousRunId: prior.runId } : {}),
                ...(fork ? { fork } : {}),
                tool: name,
                requested,
                spec: admitted,
                policy,
                template: template()[AGENT_RUNTIME].configuration(),
              },
              ...(prior?.subagent
                ? { source: prior.subagent.base }
                : policy.self
                  ? { source: parent.definition }
                  : {}),
            };
            const child = internal.child(
              key,
              template(),
              { messages: [...history, { role: "user", content: admitted.task }] },
              creation,
            );
            handles.push({ index: results.length, child });
            results.push({
              name: requested.name,
              helperId: identity.id,
              runId: child.runId,
              status: "failed",
              error: "The helper has not finished.",
            });
          }
          const settled = await context.join(handles.map(({ child }) => child));
          for (const [index, outcome] of settled.entries()) {
            const slot = handles[index]?.index;
            if (slot === undefined) throw new Error("Missing helper result position.");
            const previous = results[slot];
            if (!previous || previous.status === "refused")
              throw new Error("Missing helper result.");
            if (outcome.status === "completed") {
              // Each template's runtime has already checked its own output contract.
              if (outcome.snapshot.state.status !== "completed")
                throw new Error("Invalid helper outcome.");
              results[slot] = {
                name: previous.name,
                helperId: previous.helperId,
                runId: outcome.runId,
                status: "completed",
                output: outcome.snapshot.state.candidate,
              };
            } else {
              const state = outcome.snapshot.state;
              if (!isLocalStop(state)) {
                if (state.status === "running" || state.status === "completed")
                  throw new Error("Invalid helper outcome.");
                throw new Halt(state);
              }
              results[slot] = {
                name: previous.name,
                helperId: previous.helperId,
                runId: outcome.runId,
                status: "failed",
                error:
                  "The helper could not finish within its limits or returned a model or result failure. Continue with the other results.",
              };
            }
          }
          const content = summarize ? summarize(immutableCopy(results)) : JSON.stringify(results);
          if (typeof content !== "string") throw new TypeError("A helper summary must be text.");
          return results.some((result) => result.status === "completed")
            ? { ok: true, content, output: copyData(results) }
            : {
                ok: false,
                kind: results.every((result) => result.status === "refused") ? "denied" : "failed",
                content,
              };
        },
      });
    },
  });
  return descriptor;
}

/** @internal Bind per holder; a reusable self descriptor must not capture another agent. */
export function bindSubagentTool(tool: Delegation, holder: () => Agent<unknown>): Delegation {
  return isSubagentTool(tool) ? tool.bind(holder) : tool;
}

/** @internal Called before any host resume callback, including for completed children. */
export function checkSubagentChildren(
  descriptor: Delegation,
  parent: RunSnapshot,
  journal: DelegationExecution,
): void {
  if (MARK in descriptor && "check" in descriptor && typeof descriptor.check === "function")
    descriptor.check(parent, journal);
  else if (
    journal.children.some((child) => child.snapshot.kind === "agent" && child.snapshot.subagent)
  )
    throw new TypeError("A model-created helper must belong to its registered creation tool.");
}
