// Jev — TypeSafe's decision model, on any of the four hosts that serve it.
// `@providerkit/core/jev`.
//
// Jev does not write text. It reads a `state` and answers typed questions —
// pick one option (choice), is this true (noul), where on this scale (score) —
// each with the probabilities behind the answer, in well under a second, for
// $0.042 per million input tokens with output free (TypeSafe's list price,
// 2026-09-27). That is why it is not a `Provider`: there is no stream and no
// message, nothing the chat seam could carry without lying about it. It gets
// its own entry point and borrows the rest of the package — the error
// envelope, the classifier, retry — so a throttled Jev call behaves exactly
// like a throttled chat call.
//
// The four hosts serve one model and read the same questions. They differ
// only in the envelope: the URL, the auth headers, how the body is wrapped,
// and where the answers and the usage sit in the reply. One row per host.
//
// Prices stay with the caller, for the reason in usage.ts. OpenRouter reports
// what each call cost; the caller's `ModelRate` prices the other three.
import { attributionHeaders, type Attribution } from "./attribution.ts";
import { ProviderError, streamError } from "./errors.ts";
import { openRouterCostUsd } from "./providers/openai.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { postJson } from "./transport.ts";
import type { TokenUsage } from "./types.ts";

export type JevHost = "typesafe" | "openrouter" | "cloudflare" | "vercel";

/** What a question asks, beyond its options: a sentence, or any JSON the
 *  model should read alongside it (a goal, a list of rules). */
export type JevInstructions = string | Record<string, unknown> | readonly unknown[];

/** Pick one option. */
export interface ChoiceQuestion<Option extends string = string> {
  type: "choice";
  instructions?: JevInstructions;
  /** Each option, mapped to what it means — `null` when its name says it all.
   *  TypeSafe takes up to 255. */
  criteria: Record<Option, unknown>;
}

/** Is this statement true? */
export interface NoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  /** What yes and what no mean, when the statement alone leaves it open. */
  criteria?: { true?: string; false?: string };
}

/** Where on this ordered scale? */
export interface ScoreQuestion {
  type: "score";
  instructions?: JevInstructions;
  /** The levels, lowest first. TypeSafe takes 2 to 10. */
  criteria: readonly unknown[];
}

export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface ChoiceAnswer<Option extends string = string> {
  type: "choice";
  choice: Option;
  /** Every offered option's probability. The whole distribution is kept
   *  because a caller acting on it needs more than the pick: the runner-up,
   *  P(yes) when the pick was no, a joint probability across two questions. */
  probabilities: Record<Option, number>;
  /** How peaked `probabilities` is, 0 to 1 — NOT the probability of the pick.
   *  TypeSafe's own example spreads 0.57 / 0.43 and reports 0.35, so reading
   *  it as P(pick) would put the pick below the option it beat. Null when the
   *  host sent none. */
  confidence: number | null;
}

export interface NoulAnswer {
  type: "noul";
  /** The probability that the statement is true. */
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  /** The probability-weighted level, fractional: 1.43 sits between level 1
   *  and level 2, nearer 1. */
  score: number;
  /** Each level's probability, keyed by its index as the wire sends it:
   *  "0", "1", … */
  probabilities: Record<string, number>;
  confidence: number | null;
}

export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** The answer type a question gets back — a choice's options carry through. */
export type AnswerTo<Q> =
  Q extends ChoiceQuestion<infer Option extends string>
    ? ChoiceAnswer<Option>
    : Q extends NoulQuestion
      ? NoulAnswer
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : never;

export interface JevReply<Q extends Record<string, JevQuestion>> {
  /** One per question — `null` when that answer did not pass the checks in
   *  `readAnswer`. Each fails alone: in a fan-out, a malformed answer to a
   *  question the caller never acts on must not cost the one it does. */
  answers: { [Id in keyof Q]: AnswerTo<Q[Id]> | null };
  usage: TokenUsage;
  /** The model that answered, as the host names it — `jev-1.13.0` on
   *  TypeSafe, `typesafe/jev-1.13-20260917` on OpenRouter. */
  model: string;
}

export interface JevConfig {
  host: JevHost;
  apiKey: string;
  /** Cloudflare only: the account the Workers AI call runs on. */
  accountId?: string;
  /** Defaults to each host's always-current alias. */
  model?: string;
  /** OpenRouter only: names your app on its rankings. */
  attribution?: Attribution;
  /** One attempt's deadline, in ms. Default 15 s: Jev answers in under a
   *  second, so a call still open after this is not coming back. */
  timeoutMs?: number;
  /** Default: three attempts, transient failures only, Retry-After honoured. */
  retry?: Omit<RetryOptions, "signal">;
  /** Swapped in tests, or to route through a proxy. */
  fetchImpl?: typeof fetch;
}

export interface JevClient {
  readonly host: JevHost;
  readonly model: string;
  ask<Q extends Record<string, JevQuestion>>(
    state: unknown,
    questions: Q,
    opts?: { signal?: AbortSignal },
  ): Promise<JevReply<Q>>;
  /** Proves the key, the account and the model work, with one real question:
   *  about 40 input tokens, a few millionths of a dollar. A free read (a
   *  model list, a balance) proves only the key — not that this account can
   *  run this model — and Vercel has none. Throws the classified failure. */
  checkKey(opts?: { signal?: AbortSignal }): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// ── the four envelopes ────────────────────────────────────────────────────

interface HostRow {
  model: string;
  url(config: JevConfig): string;
  headers(config: JevConfig, model: string): Record<string, string>;
  body(model: string, state: unknown, questions: Record<string, JevQuestion>): unknown;
  /** The reply in TypeSafe's own shape — `{ model, answers, usage }` —
   *  whatever the host wrapped it in. */
  unwrap(json: unknown): Record<string, unknown> | undefined;
}

const HOSTS: Record<JevHost, HostRow> = {
  typesafe: {
    model: "jev-latest",
    url: () => "https://api.typesafe.ai/v1/systemone",
    headers: () => ({}),
    body: (model, state, questions) => ({ model, state, questions }),
    unwrap: record,
  },
  openrouter: {
    // Both this alias and the pinned `typesafe/jev-1.13` answered, live,
    // 2026-09-27. OpenRouter also serves `/api/alpha/decisions`; this is the
    // path its Jev guide documents next to it, and the one that answered.
    model: "~typesafe/jev-latest",
    url: () => "https://openrouter.ai/api/v1/systemone",
    headers: (config) => attributionHeaders(config.attribution ?? {}),
    body: (model, state, questions) => ({ model, state, questions }),
    unwrap: record,
  },
  cloudflare: {
    model: "typesafe/jev",
    url: (config) =>
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId ?? "")}/ai/run`,
    headers: () => ({}),
    body: (model, state, questions) => ({ model, input: { state, questions } }),
    // The v4 envelope puts the model's reply under `result`, and a task
    // record can wrap it once more. A task that has not finished carries no
    // answers, so it fails as an unreadable reply without a status check —
    // which is as well, since two sources disagree on that field's name.
    unwrap: (json) => {
      const result = record(record(json)?.result);
      return record(result?.result) ?? result;
    },
  },
  vercel: {
    model: "typesafe-ai/jev",
    url: () => "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    // Without these the gateway answers 400 "Unsupported gateway protocol
    // version" (checked, 2026-09-27). The model rides in a header, not the body.
    headers: (_config, model) => ({
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": model,
    }),
    // The gateway's own spelling of noul is `boolean`: its validator lists
    // exactly `choice | score | boolean` (checked, 2026-09-27).
    body: (_model, state, questions) => ({
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          q.type === "noul" ? { ...q, type: "boolean" } : q,
        ]),
      ),
    }),
    unwrap: fromVercel,
  },
};

/**
 * Vercel's reply, back in TypeSafe's shape: a `boolean` answer carries its
 * probability as `probability`, confidence moves out of the answer into
 * `providerMetadata.typesafe.confidence`, and usage is camelCase.
 *
 * ponytail: read from @jkudish/jev-agent-tools' adapter, not from a recorded
 * reply — no Vercel key has run it here. If a real reply disagrees, this
 * function is the whole fix.
 */
function fromVercel(json: unknown): Record<string, unknown> | undefined {
  const reply = record(json);
  const answers = record(reply?.answers);
  if (!reply || !answers) return reply;
  const confidence = record(record(record(reply.providerMetadata)?.typesafe)?.confidence) ?? {};
  const usage = record(reply.usage);
  return {
    model: reply.model,
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, raw]) => {
        const answer = record(raw);
        if (answer?.type === "boolean") return [id, { type: "noul", noul: answer.probability }];
        if (!answer || answer.confidence !== undefined) return [id, raw];
        return [id, { ...answer, confidence: confidence[id] }];
      }),
    ),
    usage: usage && { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
}

// ── reading an answer ─────────────────────────────────────────────────────

const unit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Exactly the offered keys, each a probability, summing to one.
 *
 * Jev rounds every probability to two decimals, so each option carrying
 * weight can drift the sum by 0.005: eight live options can honestly sum to
 * 0.98. The tolerance grows with that count, floored at 1% and capped at 5%
 * so garbage still fails.
 */
function distribution(value: unknown, keys: readonly string[]): Record<string, number> | null {
  const given = record(value);
  if (!given || keys.length === 0 || Object.keys(given).length !== keys.length) return null;
  const out: Record<string, number> = {};
  let sum = 0;
  let live = 0;
  for (const key of keys) {
    const p = given[key];
    if (!Object.hasOwn(given, key) || !unit(p)) return null;
    out[key] = p;
    sum += p;
    if (p > 0) live++;
  }
  const tolerance = Math.min(0.05, Math.max(0.01, 0.005 * live)) + 1e-9;
  return Math.abs(sum - 1) <= tolerance ? out : null;
}

/**
 * One answer, checked against the question that asked it — or null.
 *
 * A Jev answer usually becomes an action (a click, a label, a route), so it is
 * read fail-closed: the right type; for a choice, a pick among the offered
 * options that is also the most likely one in its own full distribution. A
 * distribution is never rebuilt from `confidence`, which measures spread, not
 * the pick.
 *
 * `ask` runs this on every answer. It is exported for the app that has to
 * keep its own request — its own error copy, its own auth refresh — and can
 * still take the checks.
 */
export function readAnswer<Q extends JevQuestion>(question: Q, raw: unknown): AnswerTo<Q> | null;
export function readAnswer(question: JevQuestion, raw: unknown): JevAnswer | null {
  const answer = record(raw);
  if (!answer || answer.type !== question.type) return null;
  if (question.type === "noul") {
    return unit(answer.noul) ? { type: "noul", noul: answer.noul } : null;
  }
  const confidence = answer.confidence ?? null;
  if (confidence !== null && !unit(confidence)) return null;
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const probabilities = distribution(answer.probabilities, options);
    const choice = answer.choice;
    if (!probabilities || typeof choice !== "string" || !options.includes(choice)) return null;
    // 0.001 admits a tie at two decimals; a different winner never passes.
    if ((probabilities[choice] ?? 0) + 0.001 < Math.max(...Object.values(probabilities))) {
      return null;
    }
    return { type: "choice", choice, probabilities, confidence };
  }
  const levels = question.criteria.map((_, index) => String(index));
  const probabilities = distribution(answer.probabilities, levels);
  const score = answer.score;
  if (!probabilities || typeof score !== "number" || !(score >= 0 && score <= levels.length - 1)) {
    return null;
  }
  return { type: "score", score, probabilities, confidence };
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function usageOf(host: JevHost, raw: unknown): TokenUsage {
  const usage = record(raw) ?? {};
  // Keyed on the host, as in the OpenAI adapter: OpenRouter is who sends the
  // bill, and `cost` is its field in its unit. Another host's `cost` has not
  // said what it means.
  const reportedCostUsd =
    host === "openrouter"
      ? openRouterCostUsd({
          cost: usage.cost,
          is_byok: usage.is_byok === true,
          cost_details: record(usage.cost_details) ?? null,
        })
      : undefined;
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: 0,
    outputTokens: count(usage.output_tokens),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

// ── the client ────────────────────────────────────────────────────────────

/** The question `checkKey` asks: the cheapest one whose answer can be checked. */
const KEY_CHECK = {
  ok: {
    type: "choice",
    instructions: "Does the text say hello?",
    criteria: { YES: null, NO: null },
  },
} satisfies Record<string, JevQuestion>;

export function createJevClient(config: JevConfig): JevClient {
  const row = HOSTS[config.host];
  if (config.host === "cloudflare" && !config.accountId) {
    // Sent anyway, the URL has an empty account and Cloudflare answers 404,
    // which reads as a missing model — the wrong thing to go and fix.
    throw new Error("providerkit: Jev on Cloudflare needs the accountId of the Workers AI account");
  }
  const model = config.model ?? row.model;
  const provider = `jev:${config.host}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await postJson({
        url: row.url(config),
        headers: { Authorization: `Bearer ${config.apiKey}`, ...row.headers(config, model) },
        body,
        provider,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        fetchImpl: config.fetchImpl,
      });
    } catch (err) {
      // Our deadline is a timeout, and retried; the caller's Stop leaves
      // exactly as it arrived and never is (invariant 2).
      if (deadline.aborted && !signal?.aborted) {
        throw new ProviderError(provider, "timeout", `${provider}: no answer in ${timeoutMs} ms`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  const client: JevClient = {
    host: config.host,
    model,
    ask(state, questions, opts = {}) {
      const { signal } = opts;
      return withRetry(
        async () => {
          const json = await post(row.body(model, state, questions), signal);
          const reply = row.unwrap(json);
          const raw = record(reply?.answers);
          if (!reply || !raw) {
            // A failure inside a 200 is still a failure (invariant 11): a
            // body that names one is classified like any other; a body that
            // names nothing is a contract we do not understand, and is not
            // retried into hiding it.
            const payload = record(json);
            const error = payload?.error ?? payload?.errors;
            if (error !== undefined) throw streamError(provider, error);
            throw new ProviderError(provider, "unknown", `${provider}: the reply has no answers`, {
              body: (JSON.stringify(json) ?? "").slice(0, 2_000),
            });
          }
          const answers: Record<string, JevAnswer | null> = {};
          for (const [id, question] of Object.entries(questions)) {
            answers[id] = readAnswer(question, raw[id]);
          }
          return {
            // Sound: `readAnswer` returns each answer in its own question's
            // type, with a choice limited to that question's options.
            answers: answers as JevReply<typeof questions>["answers"],
            usage: usageOf(config.host, reply.usage),
            model: typeof reply.model === "string" && reply.model ? reply.model : model,
          };
        },
        { ...config.retry, signal },
      );
    },
    async checkKey(opts) {
      const reply = await client.ask("hello", KEY_CHECK, opts);
      if (!reply.answers.ok) {
        throw new ProviderError(
          provider,
          "unknown",
          `${provider}: the key works, but the answer failed its checks`,
        );
      }
    },
  };
  return client;
}
