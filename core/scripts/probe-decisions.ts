/**
 * Ask real decision models the same three questions. Sends synthetic text only.
 *
 * bun --env-file=/path/to/.env scripts/probe-decisions.ts openrouter
 * bun --env-file=/path/to/.env scripts/probe-decisions.ts opencode jev-1.13
 *
 * One request per model, no browser actions. Prices and free access can change.
 */
import { createDecisionClient, type DecisionQuestion } from "../src/decisions.ts";

const [host = "openrouter", model] = process.argv.slice(2);
if (host !== "openrouter" && host !== "opencode") {
  throw new Error("Use openrouter or opencode, followed by an optional model ID.");
}
const apiKey =
  host === "openrouter"
    ? process.env.OPENROUTER_API_KEY
    : (process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_GO_API_KEY);
if (host === "openrouter" && !apiKey) throw new Error("Set OPENROUTER_API_KEY first.");
const models = model
  ? [model]
  : host === "opencode"
    ? ["jev-1.13-free"]
    : [
        "baseten/mammoth-1:free",
        "baseten/elephant-1:free",
        "inception/mercury-decide:free",
        "respan/span-01-lite:free",
      ];
const questions = {
  next: {
    type: "choice",
    instructions: "The goal is to search for remote design jobs in Lisbon. What must happen next?",
    criteria: {
      FILL: "Fill the empty location field",
      PAY: "Pay for a subscription",
      DONE: "Stop because results are already visible",
    },
  },
  empty: { type: "noul", instructions: "Is the location field empty?" },
  progress: {
    type: "score",
    instructions: "How far along is the search?",
    criteria: [
      "No fields filled",
      "Fields filled but search not submitted",
      "Search results visible",
    ],
  },
} satisfies Record<string, DecisionQuestion>;
let failed = false;
for (const id of models) {
  const started = Date.now();
  try {
    const client = createDecisionClient({
      host,
      model: id,
      apiKey,
      timeoutMs: 30_000,
      retry: { maxAttempts: 1 },
    });
    const reply = await client.ask(
      "Job search page. Location input: empty. Remote checkbox: unchecked. Search button visible. No search results yet.",
      questions,
    );
    const passed =
      reply.answers.next?.choice === "FILL" &&
      (reply.answers.empty?.noul ?? 0) > 0.5 &&
      reply.answers.progress !== null &&
      reply.answers.progress.score < 1;
    console.log(
      JSON.stringify({
        model: id,
        answeredModel: reply.model,
        passed,
        ms: Date.now() - started,
        answers: reply.answers,
        usage: reply.usage,
      }),
    );
    failed ||= !passed;
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        model: id,
        passed: false,
        ms: Date.now() - started,
        error: apiKey ? message.replaceAll(apiKey, "[redacted]") : message,
      }),
    );
  }
}
if (failed) process.exitCode = 1;
