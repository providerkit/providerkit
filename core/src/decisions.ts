// Typed decisions, separate from chat: a state and choice, yes/no or score
// questions go in; checked probabilities come back. Jev is one model, not
// the interface. Host envelopes differ; answer checks and retries do not.
// Prices stay with the caller. OpenRouter reports its bill, and OpenCode
// Zen's free model explicitly reports $0.
import { attributionHeaders, type Attribution } from "./attribution.ts";
import { ProviderError, streamError } from "./errors.ts";
import { openRouterCostUsd } from "./providers/openai.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { getJson, postJson } from "./transport.ts";
import type { TokenUsage } from "./types.ts";
import type { ModelRate } from "./usage.ts";

export type DecisionHost = "opencode" | "typesafe" | "openrouter" | "cloudflare" | "vercel";

/** What a question asks, beyond its options: a sentence, or any JSON the
 *  model should read alongside it (a goal, a list of rules). */
export type DecisionInstructions = string | Record<string, unknown> | readonly unknown[];

/** Pick one option. */
export interface ChoiceQuestion<Option extends string = string> {
  type: "choice";
  instructions?: DecisionInstructions;
  /** Each option, mapped to what it means. Use `null` when its name says it all.
   *  TypeSafe takes up to 255. */
  criteria: Record<Option, unknown>;
}

/** Is this statement true? */
export interface NoulQuestion {
  type: "noul";
  instructions: DecisionInstructions;
  /** What yes and what no mean, when the statement alone leaves it open. */
  criteria?: { true?: string; false?: string };
}

/** Where on this ordered scale? */
export interface ScoreQuestion {
  type: "score";
  instructions?: DecisionInstructions;
  /** The levels, lowest first. TypeSafe takes 2 to 10. */
  criteria: readonly unknown[];
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface ChoiceAnswer<Option extends string = string> {
  type: "choice";
  choice: Option;
  /** Every offered option's probability. The whole distribution is kept
   *  because a caller acting on it needs more than the pick: the runner-up,
   *  P(yes) when the pick was no, a joint probability across two questions. */
  probabilities: Record<Option, number>;
  /** How peaked `probabilities` is, from 0 to 1. Not the probability of the pick.
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

export type DecisionAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** The answer type a question gets back. A choice's options carry through. */
export type AnswerTo<Q> =
  Q extends ChoiceQuestion<infer Option extends string>
    ? ChoiceAnswer<Option>
    : Q extends NoulQuestion
      ? NoulAnswer
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : never;

export interface DecisionReply<Q extends Record<string, DecisionQuestion>> {
  /** One per question. `null` when that answer did not pass the checks in
   *  `readAnswer`. Each fails alone: in a fan-out, a malformed answer to a
   *  question the caller never acts on must not cost the one it does. */
  answers: { [Id in keyof Q]: AnswerTo<Q[Id]> | null };
  usage: TokenUsage;
  /** The model that answered, as the host names it: `jev-1.13.0` on
   *  TypeSafe, `typesafe/jev-1.13-20260917` on OpenRouter. */
  model: string;
}

export interface DecisionConfig {
  host: DecisionHost;
  /** Optional on `opencode` when running `jev-1.13-free`, which answers
   *  without a credential. Required on `jev-1.13` and on every other host. */
  apiKey?: string;
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

export interface DecisionClient {
  readonly host: DecisionHost;
  readonly model: string;
  ask<Q extends Record<string, DecisionQuestion>>(
    state: unknown,
    questions: Q,
    opts?: { signal?: AbortSignal },
  ): Promise<DecisionReply<Q>>;
  /** Proves the key, the account and the model work, with one real question:
   *  about 40 input tokens, a few millionths of a dollar. A free read (a
   *  model list, a balance) proves only the key, not that this account can
   *  run this model. Vercel has no such free read. Throws the classified failure. */
  checkConnection(opts?: { signal?: AbortSignal }): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Live catalog metadata, not a promise that the model suits a particular task. */
export interface DecisionModel {
  id: string;
  name: string;
  inputModalities: string[];
  /** Missing when the host does not report a usable limit. Never means unlimited. */
  contextLength?: number;
  /** USD per million tokens, read from the current catalog. */
  rate?: ModelRate;
  /** Present only for known restrictions; absence does not promise every question type. */
  questionTypes?: readonly DecisionQuestion["type"][];
}

function noulOnly(model: string): boolean {
  // ponytail: OpenRouter reports modality, not per-model question types.
  // Span-01 rejected choice/score live on 2026-10-22. Use catalog metadata
  // instead when OpenRouter starts publishing this restriction.
  return /^respan\/span-01(?:-lite)?(?::free)?$/.test(model);
}

function catalogPrice(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price * 1_000_000 : undefined;
}

function catalogModel(value: unknown): DecisionModel | null {
  const row = record(value);
  const architecture = record(row?.architecture);
  if (
    typeof row?.id !== "string" ||
    !row.id.trim() ||
    !Array.isArray(architecture?.output_modalities) ||
    !architecture.output_modalities.includes("decisions")
  )
    return null;
  const pricing = record(row.pricing);
  const input = catalogPrice(pricing?.prompt);
  const output = catalogPrice(pricing?.completion);
  const contextLength = row.context_length;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
    ...(noulOnly(row.id) ? { questionTypes: ["noul"] as const } : {}),
    inputModalities: Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities.filter((v): v is string => typeof v === "string")
      : [],
    ...(typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0
      ? { contextLength }
      : {}),
    ...(input !== undefined && output !== undefined
      ? { rate: { input, output, cacheRead: catalogPrice(pricing?.input_cache_read) ?? input } }
      : {}),
  };
}

/** OpenRouter's separate decision catalog. Chat `/models` defaults to text models. */
export async function listOpenRouterDecisionModels(
  opts: Pick<DecisionConfig, "apiKey" | "fetchImpl" | "timeoutMs" | "retry"> & {
    signal?: AbortSignal;
  } = {},
): Promise<DecisionModel[]> {
  return withRetry(
    async () => {
      const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
      let json: unknown;
      try {
        json = await getJson({
          url: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
          provider: "decisions:openrouter",
          headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
          signal,
          fetchImpl: opts.fetchImpl,
        });
      } catch (err) {
        if (deadline.aborted && !opts.signal?.aborted) {
          throw new ProviderError(
            "decisions:openrouter",
            "timeout",
            "The decision model list timed out. Try again.",
            { cause: err },
          );
        }
        throw err;
      }
      const data = record(json)?.data;
      if (!Array.isArray(data)) {
        throw new ProviderError(
          "decisions:openrouter",
          "unknown",
          "The decision model catalog has no model list. Try again.",
        );
      }
      return data.map(catalogModel).filter((model): model is DecisionModel => model !== null);
    },
    { ...opts.retry, signal: opts.signal },
  );
}

// ── the five envelopes ────────────────────────────────────────────────────

interface HostRow {
  model: string;
  url(config: DecisionConfig): string;
  headers(config: DecisionConfig, model: string): Record<string, string>;
  body(model: string, state: unknown, questions: Record<string, DecisionQuestion>): unknown;
  /** The reply in TypeSafe's own shape (`{ model, answers, usage }`),
   *  whatever the host wrapped it in. */
  unwrap(json: unknown): Record<string, unknown> | undefined;
}

const HOSTS: Record<DecisionHost, HostRow> = {
  opencode: {
    // OpenCode Zen serves `jev-1.13-free` and `jev-1.13` on its System One
    // route (checked live, 2026-10-22). `jev-1.13-free` is $0 and answers
    // both with an OpenCode key/token and with no credential at all; `jev-1.13`
    // bills the account and requires the credential.
    model: "jev-1.13-free",
    url: () => "https://opencode.ai/zen/v1/systemone",
    headers: () => ({}),
    body: (model, state, questions) => ({ model, state, questions }),
    unwrap: record,
  },
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

/** The host's default decision model, also used when migrating a saved connection. */
export function defaultDecisionModel(host: DecisionHost): string {
  return HOSTS[host].model;
}

/**
 * Vercel's reply, back in TypeSafe's shape: a `boolean` answer carries its
 * probability as `probability`, confidence moves out of the answer into
 * `providerMetadata.typesafe.confidence`, and usage is camelCase.
 *
 * ponytail: read from @jkudish/jev-agent-tools' adapter, not from a recorded
 * reply. No Vercel key has run it here. If a real reply disagrees, this
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
 * One answer, checked against the question that asked it, or null.
 *
 * A Jev answer usually becomes an action (a click, a label, a route), so it is
 * read fail-closed: the right type; for a choice, a pick among the offered
 * options that is also the most likely one in its own full distribution. A
 * distribution is never rebuilt from `confidence`, which measures spread, not
 * the pick.
 *
 * `ask` runs this on every answer. It is exported for the app that has to
 * keep its own request (its own error copy, its own auth refresh) and can
 * still take the checks.
 */
export function readAnswer<Q extends DecisionQuestion>(
  question: Q,
  raw: unknown,
): AnswerTo<Q> | null;
export function readAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
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

function isFreeDecisionModel(host: DecisionHost, model: string): boolean {
  return host === "opencode" && model.endsWith("-free");
}

function usageOf(host: DecisionHost, model: string, raw: unknown): TokenUsage {
  const usage = record(raw) ?? {};
  // Keyed on the host, as in the OpenAI adapter: OpenRouter is who sends the
  // bill, and `cost` is its field in its unit. OpenCode Zen's `-free` model is
  // $0, so reporting 0 stops `costUsd` from pricing it at TypeSafe's list rate.
  // Another host's `cost` has not said what it means.
  const reportedCostUsd =
    host === "openrouter"
      ? openRouterCostUsd({
          cost: usage.cost,
          is_byok: usage.is_byok === true,
          cost_details: record(usage.cost_details) ?? null,
        })
      : isFreeDecisionModel(host, model)
        ? 0
        : undefined;
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: 0,
    outputTokens: count(usage.output_tokens),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

// ── the client ────────────────────────────────────────────────────────────

/** The question `checkConnection` asks: the cheapest one whose answer can be checked. */
const KEY_CHECK = {
  ok: {
    type: "choice",
    instructions: "Does the text say hello?",
    criteria: { YES: null, NO: null },
  },
} satisfies Record<string, DecisionQuestion>;

export function createDecisionClient(config: DecisionConfig): DecisionClient {
  const row = HOSTS[config.host];
  if (config.host === "cloudflare" && !config.accountId) {
    // Sent anyway, the URL has an empty account and Cloudflare answers 404,
    // which reads as a missing model — the wrong thing to go and fix.
    throw new Error("providerkit: Jev on Cloudflare needs the accountId of the Workers AI account");
  }
  const model = config.model ?? row.model;
  const free = isFreeDecisionModel(config.host, model);
  const apiKey = config.apiKey?.trim() ?? "";
  const provider = `decisions:${config.host}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function postOnce(
    body: unknown,
    signal: AbortSignal | undefined,
    anonymous: boolean,
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await postJson({
        url: row.url(config),
        headers: {
          ...(!anonymous && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...row.headers(config, model),
        },
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

  async function post(body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const startAnonymous = free && !apiKey;
    try {
      return await postOnce(body, signal, startAnonymous);
    } catch (err) {
      // Zen's free Jev model accepts a valid key and answers 401 for a stale
      // one; retry anonymously once, matching the `opencode-zen` chat adapter.
      if (free && !startAnonymous && err instanceof ProviderError && err.status === 401) {
        return postOnce(body, signal, true);
      }
      throw err;
    }
  }

  const client: DecisionClient = {
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
            if (error !== undefined)
              throw streamError(provider, payload?.error !== undefined ? payload : error);
            throw new ProviderError(provider, "unknown", `${provider}: the reply has no answers`, {
              body: (JSON.stringify(json) ?? "").slice(0, 2_000),
            });
          }
          const answers: Record<string, DecisionAnswer | null> = {};
          for (const [id, question] of Object.entries(questions)) {
            answers[id] = readAnswer(question, raw[id]);
          }
          const answeredModel =
            typeof reply.model === "string" && reply.model ? reply.model : model;
          return {
            // Sound: `readAnswer` returns each answer in its own question's
            // type, with a choice limited to that question's options.
            answers: answers as DecisionReply<typeof questions>["answers"],
            usage: usageOf(config.host, answeredModel, reply.usage),
            model: answeredModel,
          };
        },
        { ...config.retry, signal },
      );
    },
    async checkConnection(opts) {
      const questions: Record<string, DecisionQuestion> =
        config.host === "openrouter" && noulOnly(model)
          ? { ok: { type: "noul", instructions: "Does the text say hello?" } }
          : KEY_CHECK;
      const reply = await client.ask("hello", questions, opts);
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
