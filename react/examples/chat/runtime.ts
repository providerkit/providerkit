import { setTimeout as delay } from "node:timers/promises";
import type {
  Agent,
  AgentHost,
  AskRecord,
  Decision,
  InputInbox,
  PendingRequest,
  QueuedInput,
  Resolution,
  RunOptions,
  RunOutcome,
  TreeNode,
} from "@providerkit/agents";
import { createAgentProjector } from "@providerkit/react/agents";
import {
  parseRequestAnswers,
  type ChatEvent,
  type DisplayInput,
  type RequestResponse,
} from "@providerkit/react/protocol";
import {
  cardInput,
  cardResult,
  cardSchema,
  isRecord,
  Refusal,
  type ApprovalMode,
  type DemoStats,
} from "./shared.ts";

type Card = ReturnType<typeof cardResult>;
type Claim = {
  token: string;
  request: PendingRequest;
  input: ReturnType<typeof cardInput>;
  value?: Card;
  completed: boolean;
};
type Evidence = { request: PendingRequest; decision: Decision; continuation: string };
type InboxItem = { queued: QueuedInput; display: DisplayInput; reserved?: string };

/** State belongs to Conversation.work in this ONE loopback process. These synchronous reservations
 * exclude tabs here, not processes or crashes. A real host needs transactions and durable records. */
export class DemoRun {
  readonly id = crypto.randomUUID();
  readonly messageId = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly projector;
  readonly inbox = new Map<string, InboxItem>();
  private readonly claims = new Map<string, Claim>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly delivered = new Map<string, string>();
  private continuation?: string;
  private saved?: TreeNode;
  private outcome?: RunOutcome;
  private expiryScheduled = false;
  private expiredOnce = false;
  private textChunks = 0;
  private gapEmitted = false;
  done: Promise<void> = Promise.resolve();

  constructor(
    readonly principalId: string,
    readonly resourceId: string,
    private readonly agent: Agent,
    private readonly stats: DemoStats,
    private readonly publish: (event: ChatEvent) => void,
    private readonly reconcile: (run: DemoRun) => void,
    private readonly pause: () => void,
    private readonly mode: ApprovalMode = "pending",
    private readonly syntheticGap: false | "text" | "tools" = false,
  ) {
    this.projector = createAgentProjector({
      runId: this.id,
      messageId: this.messageId,
      agentId: agent.id,
      labels: {
        agent: {
          facts: "Fact checker",
          format: "Plan checker",
          "request-guide": "Sample guide",
          "visit-helper": "Visit helper",
          "workflow-guide": "Workflow guide",
          "workflow-checker": "Plan checker",
        },
        workflow: { "visit-workflow": "Visit plan" },
        step: {
          check: "Check the plan",
          time: "Choose a time",
          label: "Check the label",
          pause: "Wait five seconds",
        },
      },
      tool: ({ call, result }) => ({
        label:
          call.name === "make_sample_card"
            ? "Create a sample card"
            : call.name === "check_visit_plan"
              ? "Check a visit plan"
              : call.name,
        summary: result ? "The fixed sample step finished." : "Working with fictional records.",
      }),
      request: ({ request, problem, decision }) => {
        this.binding(request);
        const ask = request.ask;
        const original = request.call?.arguments ?? request.step?.input;
        const effective =
          decision?.type === "approve" ? (decision.arguments ?? original) : original;
        if (request.step)
          return {
            title:
              ask.type === "question"
                ? "When would you like to visit?"
                : "Use this label for the plan?",
            summary:
              ask.type === "approval"
                ? "Edit the label before checking it. This does not create a card or book a visit."
                : "Choose a time for this fictional plan.",
            ...(ask.type === "question" && { choices: ask.choices }),
            ...(ask.type === "approval" && {
              edit: { schema: cardSchema, value: cardInput(effective) },
            }),
          };
        return {
          ...(ask.type === "question"
            ? {
                title: ask.message,
                choices: ask.choices,
                freeText: ask.freeText,
                multiple: ask.multiple,
              }
            : {
                title:
                  ask.type === "approval" ? "Create this sample card?" : "Create the approved card",
              }),
          summary:
            ask.type === "approval"
              ? "Edit the label, then approve. Run action creates one fictional card on this local server."
              : ask.type === "client"
                ? "This action creates one fictional card. Reloading or another tab cannot grant a second execution in this server process."
                : "Answer either question first. For a text answer, use 3 to 80 characters. Try one letter to see a correction.",
          ...(ask.type === "approval" && {
            edit: { schema: cardSchema, value: cardInput(effective) },
          }),
          ...(problem && {
            problem: {
              code: problem.code,
              message:
                problem.code === "expired"
                  ? "This request expired. Answer the new request."
                  : "That answer was not accepted. Choose a listed time or use 3 to 80 characters of text.",
            },
          }),
        };
      },
      clientTools: {
        make_sample_card: (input, request) => {
          this.binding(request);
          return cardInput(input);
        },
      },
      input: (input) => (typeof input.content === "string" ? { text: input.content } : undefined),
    });
  }

  get snapshot(): TreeNode | undefined {
    return this.saved;
  }
  get waiting(): boolean {
    return this.outcome?.status === "suspended" && !this.continuation;
  }

  private nodes(snapshot = this.saved): TreeNode[] {
    if (!snapshot) return [];
    const journals = snapshot.kind === "workflow" ? snapshot.steps : snapshot.delegations;
    return [
      snapshot,
      ...journals.flatMap((entry) => entry.children.flatMap((child) => this.nodes(child.snapshot))),
    ];
  }

  private records(): AskRecord[] {
    return this.nodes().flatMap((node) =>
      node.kind === "workflow"
        ? node.steps.flatMap((step) => step.asks ?? [])
        : node.models.flatMap((model) =>
            model.status === "completed" ? model.tools.flatMap((tool) => tool.asks ?? []) : [],
          ),
    );
  }

  private binding(request: PendingRequest): void {
    if (
      request.scope.actorId !== this.principalId ||
      request.scope.resource.id !== this.resourceId ||
      request.scope.resource.version !== "1" ||
      ((request.call ?? request.step).runId !== this.id &&
        !this.records().some((record) => record.request.id === request.id))
    )
      throw new Refusal(
        403,
        "binding",
        "This request does not belong to this demo profile and conversation.",
      );
  }

  private pending(id: unknown, fresh = true): PendingRequest {
    const record = this.records().find((record) => record.request.id === id);
    if (
      !record ||
      record.closed ||
      record.decision ||
      !this.saved ||
      this.saved.state.status !== "suspended"
    )
      throw new Refusal(
        409,
        "closed",
        "This request is no longer open. Check the saved conversation.",
      );
    this.binding(record.request);
    if (fresh && record.request.scope.expiresAt <= Date.now())
      throw new Refusal(
        409,
        "expired",
        "This request expired. Check for its replacement before answering.",
      );
    return record.request;
  }

  private readonly host: AgentHost & {
    authorizeResume: NonNullable<AgentHost["authorizeResume"]>;
  } = {
    checkpoint: async (snapshot) => {
      // Demo delay exposes the real poll-before-checkpoint race. Recall must already be refused.
      const offered = [...this.inbox.values()].some(
        (item) => item.reserved && item.display.status === "queued",
      );
      if (offered) await delay(150);
      this.saved = snapshot;
      this.reconcile(this);
    },
    authorizeResume: (snapshot) => {
      if (
        !this.continuation ||
        !this.nodes().some(
          (node) =>
            node.runId === snapshot.runId && JSON.stringify(node) === JSON.stringify(snapshot),
        )
      )
        throw new Refusal(
          409,
          "claim",
          "This continuation is not current. Check the saved conversation.",
        );
    },
    prepareRequest: (draft) => ({
      scope: {
        actorId: this.principalId,
        resource: { id: this.resourceId, version: "1" },
        expiresAt:
          Date.now() + (this.mode === "expire" && !this.expiredOnce ? 3000 : 30 * 60 * 1000),
      },
      ...(draft.ask.type === "approval" && { ask: { ...draft.ask, editable: true } }),
    }),
    resolveRequest: (request, raw): Resolution => {
      this.binding(request);
      const evidence = typeof raw === "string" ? this.evidence.get(raw) : undefined;
      if (
        !evidence ||
        evidence.continuation !== this.continuation ||
        JSON.stringify(evidence.request) !== JSON.stringify(request)
      )
        throw new Refusal(403, "evidence", "This response was not authorized for this request.");
      return evidence.decision;
    },
    beforeStep: (step, decided) => {
      if (
        !this.nodes().some(
          (node) =>
            node.kind === "workflow" &&
            node.runId === step.runId &&
            node.workflowId === step.workflowId,
        )
      )
        throw new Refusal(
          403,
          "step_owner",
          "This step does not belong to the current demo reply.",
        );
      if (decided) this.checkDecision(decided.request, decided.decision);
      if (step.kind === "step") cardInput(step.input);
    },
    beforeTool: (call, decided) => {
      if (decided) this.checkDecision(decided.request, decided.decision);
      if (call.call.name === "make_sample_card") cardInput(call.arguments);
    },
    canRunConcurrently: () => true,
    inbox: {
      poll: (scope) => this.poll(scope),
      acknowledge: (receipts) => {
        for (const receipt of receipts) {
          const item = this.inbox.get(receipt.id);
          if (!item || receipt.rootRunId !== this.id || item.reserved !== receipt.runId)
            throw new Refusal(409, "input_binding", "This message receipt belongs to another run.");
          if (item.display.status !== "consumed")
            item.display = {
              ...item.display,
              status: receipt.status,
              runId: receipt.runId,
            };
          this.publish({ v: 1, type: "input", input: item.display });
        }
      },
    },
  };

  private checkDecision(request: PendingRequest, decision: Decision): void {
    this.binding(request);
    const trusted = [...this.evidence.values()].some(
      (item) =>
        item.request.id === request.id &&
        JSON.stringify(item.decision) === JSON.stringify(decision),
    );
    if (!trusted) throw new Refusal(403, "decision", "The saved choice is not authorized here.");
  }

  private poll(scope: Parameters<InputInbox["poll"]>[0]): QueuedInput[] {
    scope.signal.throwIfAborted();
    const owner = this.saved
      ? this.projector.run(this.saved).owner
      : { runId: this.id, agentId: this.agent.id };
    if (
      scope.rootRunId !== this.id ||
      owner?.runId !== scope.runId ||
      owner.agentId !== scope.agent.id
    )
      throw new Refusal(
        409,
        "input_owner",
        "Only the current conversation owner may receive messages.",
      );
    const offered: QueuedInput[] = [];
    let bytes = 0;
    for (const item of this.inbox.values()) {
      if (item.display.status !== "queued") continue;
      const size = new TextEncoder().encode(JSON.stringify(item.queued)).length;
      if (offered.length === scope.limit.count || bytes + size > scope.limit.bytes) break;
      // Reservation and recall check are synchronous on the same host state, BEFORE poll returns.
      if (item.reserved && item.reserved !== scope.runId)
        throw new Error("Input already reserved.");
      if (!item.reserved) this.stats.reservations++;
      item.reserved = scope.runId;
      offered.push(item.queued);
      bytes += size;
    }
    return offered;
  }

  inputs(): DisplayInput[] {
    const receipts = this.saved ? this.projector.inputs(this.saved) : [];
    return [...this.inbox.values()].map(
      (item) => receipts.find((receipt) => receipt.id === item.display.id) ?? item.display,
    );
  }

  enqueue(id: string, text: string, rootRunId: unknown): DisplayInput {
    if (rootRunId !== this.id)
      throw new Refusal(
        409,
        "input_run",
        "This reply changed. Check the conversation before sending.",
      );
    const held = this.inbox.get(id);
    if (held) {
      if (held.queued.content !== text)
        throw new Refusal(409, "input_conflict", "That message ID already holds other text.");
      return held.display;
    }
    if (!this.saved || !["running", "suspended"].includes(this.saved.state.status))
      throw new Refusal(
        409,
        "finished",
        "This reply ended. Your draft is safe; send it as a new message if needed.",
      );
    if (this.inbox.size >= 32)
      throw new Refusal(409, "input_limit", "This demo accepts 32 messages during one reply.");
    const display: DisplayInput = { id, rootRunId: this.id, text, status: "queued" };
    this.inbox.set(id, { queued: { id, content: text }, display });
    this.publish({ v: 1, type: "input", input: display });
    return display;
  }

  recall(id: unknown, rootRunId: unknown): DisplayInput {
    const item = typeof id === "string" ? this.inbox.get(id) : undefined;
    if (!item || rootRunId !== this.id)
      throw new Refusal(404, "input", "This message is not in this conversation.");
    if (item.reserved || item.display.status === "accepted" || item.display.status === "consumed")
      throw new Refusal(
        409,
        "reserved",
        "The agent may already have this message. It cannot be recalled. Check its delivery status.",
      );
    item.display = { ...item.display, status: "recalled" };
    this.publish({ v: 1, type: "input", input: item.display });
    return item.display;
  }

  private options(): RunOptions {
    return {
      signal: this.controller.signal,
      host: this.host,
      onEvent: (event) => {
        // Synthetic boundary fixture only: no PostgreSQL or storage-failure claim.
        if (
          this.syntheticGap &&
          !this.gapEmitted &&
          event.type === "model_chunk" &&
          event.runId === this.id &&
          (this.syntheticGap === "tools"
            ? event.chunk.toolCalls?.length
            : event.chunk.content && ++this.textChunks === 3)
        ) {
          this.gapEmitted = true;
          this.stats.gaps++;
          // A real /runs host branches on RunEvent.type, not AgentEvent.type.
          for (const display of this.projector.gap()) this.publish(display);
          this.reconcile(this); // read after the retained prefix; running model has no complete text
          return; // deliberately omitted progress, never omitted execution
        }
        for (const display of this.projector.event(event)) this.publish(display);
      },
    };
  }

  start(): void {
    this.stats.runs++;
    this.done = this.settle(
      this.agent.run("Run the fixed offline example.", { ...this.options(), runId: this.id }),
    );
  }

  private async settle(promise: Promise<RunOutcome>): Promise<void> {
    try {
      this.outcome = await promise;
      this.saved = this.outcome.snapshot;
      this.reconcile(this);
      if (this.mode === "expire" && !this.expiryScheduled && this.outcome.status === "suspended") {
        this.expiryScheduled = true;
        const expiresAt = Math.min(
          ...this.outcome.requests.map((request) => request.scope.expiresAt),
        );
        void delay(Math.max(0, expiresAt - Date.now() + 30)).then(async () => {
          this.expiredOnce = true;
          if (this.waiting) await this.resume({}); // SDK closes old requests and journals replacements
        });
      }
    } catch {
      this.publish({
        v: 1,
        type: "run",
        run: {
          id: this.id,
          messageId: this.messageId,
          status: "failed",
          error: {
            code: "script_failed",
            message:
              "The local script could not finish. Review the saved reply before starting another.",
          },
        },
      });
    }
  }

  private resume(
    answers: Readonly<Record<string, unknown>>,
    claim = crypto.randomUUID(),
  ): Promise<void> {
    if (this.continuation || !this.saved)
      throw new Refusal(
        409,
        "continuing",
        "A response is already being applied. Check for updates.",
      );
    this.continuation = claim;
    this.stats.continuations++;
    this.done = this.settle(
      this.agent.resume(this.saved, { ...this.options(), host: this.host, answers }),
    ).finally(() => {
      this.continuation = undefined;
    });
    return this.done;
  }

  async respond(raw: unknown): Promise<void> {
    const answers = isRecord(raw) ? parseRequestAnswers(raw.answers) : null;
    if (!answers?.length)
      throw new Refusal(
        400,
        "answers",
        "Send one or more request answers. Stop must be sent alone.",
      );
    const prior = answers.every(
      (answer) => this.delivered.get(answer.requestId) === JSON.stringify(answer.response),
    );
    if (!prior) {
      if (this.continuation)
        throw new Refusal(
          409,
          "continuing",
          "A response is already being applied. Check for updates.",
        );
      const claim = crypto.randomUUID();
      const evidence: Record<string, unknown> = {};
      for (const answer of answers) {
        const request = this.pending(answer.requestId);
        const decision = this.decision(request, answer.response);
        const token = crypto.randomUUID();
        this.evidence.set(token, { request, decision, continuation: claim });
        evidence[request.id] = token; // Browser intention is NOT the resolver's trusted decision.
      }
      if (this.mode === "unknown") this.pause();
      const done = this.resume(evidence, claim); // reserve synchronously before awaiting any work
      await done;
      for (const answer of answers) {
        const record = this.records().find((record) => record.request.id === answer.requestId);
        if (record?.decision && !this.delivered.has(answer.requestId)) {
          this.delivered.set(answer.requestId, JSON.stringify(answer.response));
          this.stats.decisions++;
        }
      }
    }
    if (this.mode === "unknown")
      throw new Refusal(
        503,
        "lost_answer",
        "The response reply was lost. Check the saved conversation; do not resend it.",
      );
  }

  private decision(request: PendingRequest, response: RequestResponse): Decision {
    if (response.type === "stop" || response.type === "cancel") return { type: response.type };
    if (request.ask.type === "question" && response.type === "answer") {
      // SDK checks listed choices and answer fit. The host also validates its own text policy.
      if (
        response.answer.text !== undefined &&
        (response.answer.text.trim().length < 3 || response.answer.text.length > 80)
      )
        throw new Refusal(
          422,
          "answer_text",
          "Use 3 to 80 characters. Your answer is still here for correction.",
        );
      if (response.answer.data !== undefined)
        throw new Refusal(422, "answer_data", "This sample question does not accept form data.");
      return {
        type: "answer",
        answer: {
          ...(response.answer.text !== undefined && { text: response.answer.text }),
          ...(response.answer.choices !== undefined && { choices: [...response.answer.choices] }),
        },
      };
    }
    if (request.ask.type === "approval") {
      if (response.type === "deny") return { type: "deny" };
      if (response.type === "approve")
        return {
          type: "approve",
          arguments: cardInput(
            response.arguments ?? request.call?.arguments ?? request.step?.input,
          ),
        };
    }
    if (request.ask.type === "client" && response.type === "result") {
      const claim = this.claims.get(request.id);
      if (
        !claim?.value ||
        JSON.stringify(cardResult(response.value)) !== JSON.stringify(claim.value)
      )
        throw new Refusal(
          403,
          "result",
          "Only the saved result of the claimed action can continue this request.",
        );
      return { type: "result", value: claim.value };
    }
    throw new Refusal(
      422,
      "answer_type",
      "That response does not fit this request. Check its controls and try again.",
    );
  }

  claim(raw: unknown): unknown {
    if (!isRecord(raw) || raw.runId !== this.id || raw.name !== "make_sample_card")
      throw new Refusal(403, "claim_binding", "This action belongs to another request or reply.");
    const request = this.pending(raw.requestId);
    if (
      request.ask.type !== "client" ||
      !request.call ||
      JSON.stringify(cardInput(raw.input)) !== JSON.stringify(cardInput(request.call.arguments))
    )
      throw new Refusal(
        403,
        "claim_input",
        "The action input does not match the approved card label.",
      );
    const held = this.claims.get(request.id);
    if (held) {
      if (!held.value) return { status: "busy" };
      if (!held.completed) {
        held.completed = true;
        this.stats.clientCompletions++;
      }
      return { status: "completed", value: held.value };
    }
    const claim: Claim = {
      token: crypto.randomUUID(),
      request,
      input: cardInput(request.call.arguments),
      completed: false,
    };
    this.claims.set(request.id, claim);
    return { status: "granted", token: claim.token };
  }

  action(raw: unknown, complete: boolean, loseReply: boolean): Card {
    if (!isRecord(raw) || raw.runId !== this.id || typeof raw.requestId !== "string")
      throw new Refusal(403, "action_binding", "This action belongs to another conversation.");
    const claim = this.claims.get(raw.requestId);
    if (!claim || claim.token !== raw.token)
      throw new Refusal(403, "claim_token", "Claim this action before running it.");
    this.binding(claim.request);
    if (complete) {
      if (!claim.value || JSON.stringify(cardResult(raw.value)) !== JSON.stringify(claim.value))
        throw new Refusal(403, "completion", "This result does not match the saved card.");
      if (!claim.completed) {
        claim.completed = true;
        this.stats.clientCompletions++;
      }
    } else {
      if (JSON.stringify(cardInput(raw.input)) !== JSON.stringify(claim.input))
        throw new Refusal(
          403,
          "effective_input",
          "Use the label that was approved for this request.",
        );
      if (!claim.value) {
        this.pending(raw.requestId); // expiry/Stop forbids dispatch, but not saving a late result
        // The fictional effect and its result are recorded before a reply can be lost.
        // External effects need service reconciliation, not a lease timeout and rerun.
        claim.value = { id: crypto.randomUUID(), label: claim.input.label };
        this.stats.clientEffects++;
      }
    }
    if (!claim.value)
      throw new Refusal(409, "missing_result", "No saved action result is available yet.");
    if (loseReply)
      throw new Refusal(
        503,
        "lost_action",
        "The action reply was lost. Check action result; do not run it again.",
      );
    return claim.value;
  }

  async continueScheduled(): Promise<void> {
    const outcome = this.outcome;
    if (
      !this.waiting ||
      outcome?.status !== "suspended" ||
      outcome.requests.length ||
      outcome.wakeAt === undefined
    )
      throw new Refusal(
        409,
        "not_scheduled",
        "No scheduled pause is ready here. Check the conversation.",
      );
    if (outcome.wakeAt > Date.now())
      throw new Refusal(
        409,
        "too_early",
        "The five-second pause has not ended. Wait a moment, then check again.",
      );
    // This host claims the continuation synchronously. The browser's clock grants nothing.
    await this.resume({});
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.done;
    if (this.outcome?.status === "suspended") await this.resume({});
  }
}
