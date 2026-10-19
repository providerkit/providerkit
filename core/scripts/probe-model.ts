/**
 * Probe one model on one preset against the live API, before code relies on it.
 *
 * Four checks:
 * 1. Connectivity, latency (time to first token) and effort: was the level
 *    accepted, and how many reasoning tokens did the model spend?
 * 2. Structured output: does a JSON Schema come back as parseable JSON?
 * 3. Tool calling: does the model call a described tool, or narrate it?
 * 4. jsonWithTools: tools and a schema in one call (OpenAI and Gemini shapes).
 *
 * Usage:
 *   bun run scripts/probe-model.ts <preset> [model] [--api-key=KEY] [--effort=LEVEL]
 *     [--header=Name:Value]...
 *
 * The key comes from --api-key or the preset's env var: its id in capitals with
 * hyphens as underscores (opencode-go reads OPENCODE_GO_API_KEY), unless
 * ENV_KEY_MAP names another. An OAuth preset (chatgpt, grok) takes the access
 * token as the key. Bun reads `.env` from the working directory; for a file
 * elsewhere, add --env-file=<path> after `bun`.
 *
 * --effort sets the effort of check 1: none (the default), low, medium, high or
 * max. The adapter spells it for the model exactly as it would in production,
 * so the probe checks what providerkit sends, not a vendor spelling the adapter
 * has yet to learn. To check one, map it in the adapter and probe from that
 * branch: the spelling ships only if the probe passes.
 *
 * --header adds a request header and can repeat. The chatgpt preset needs
 * ChatGPT-Account-Id.
 *
 * Examples:
 *   bun run scripts/probe-model.ts zai
 *   bun run scripts/probe-model.ts google gemini-2.5-flash
 *   bun run scripts/probe-model.ts openrouter z-ai/glm-5.3-flash
 *   bun run scripts/probe-model.ts chatgpt gpt-6-sol --api-key=$TOKEN --effort=max \
 *     --header=ChatGPT-Account-Id:$ACCOUNT_ID
 */
import { probeJsonWithTools } from "../src/capability.ts";
import { ProviderError } from "../src/errors.ts";
import { createPresetProvider } from "../src/providers/factory.ts";
import { PROVIDER_PRESETS, type ProviderPreset, type ProviderPresetId } from "../src/presets.ts";
import {
  EFFORTS,
  isEffort,
  type ChatMessage,
  type JsonObjectSchema,
  type Provider,
  type StreamOptions,
  type TokenUsage,
  type ToolDefinition,
} from "../src/types.ts";

// Only the presets whose key lives under another name than the derived one
// (see the header): the OpenAI-wire twins share their vendor's key.
const ENV_KEY_MAP: Record<string, string> = {
  google: "GEMINI_API_KEY",
  "google-openai": "GEMINI_API_KEY",
  "minimax-openai": "MINIMAX_API_KEY",
  "zai-openai": "ZAI_API_KEY",
  "kimi-openai": "KIMI_API_KEY",
  "kimi-plan": "KIMI_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  "qwen-token-plan-openai": "DASHSCOPE_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  "qwen-api": "DASHSCOPE_API_KEY",
};

const USAGE =
  "Usage: bun run scripts/probe-model.ts <preset> [model] [--api-key=KEY] [--effort=LEVEL] [--header=Name:Value]...";

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("--"));
// Split on the first "=" only: a key or a header value can hold one (base64
// pads with "=").
const flagPairs = argv
  .filter((a) => a.startsWith("--"))
  .map((a): [string, string] => {
    const eq = a.indexOf("=");
    return eq === -1 ? [a.slice(2), "true"] : [a.slice(2, eq), a.slice(eq + 1)];
  });
const flags = Object.fromEntries(flagPairs);

function fail(message: string): never {
  console.error(`Error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const presetId = args[0] as ProviderPresetId | undefined;
const modelArg = args[1];

if (!presetId || !PROVIDER_PRESETS[presetId]) {
  console.error(USAGE);
  console.error(`Available presets: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
  process.exit(1);
}

const effortFlag = flags.effort ?? "none";
if (!isEffort(effortFlag)) {
  fail(`--effort=${effortFlag} is not a level. Use one of: ${EFFORTS.join(", ")}.`);
}
const effort = effortFlag;

const headers: Record<string, string> = {};
for (const [key, value] of flagPairs) {
  if (key !== "header") continue;
  const colon = value.indexOf(":");
  const name = colon === -1 ? "" : value.slice(0, colon).trim();
  if (!name) fail(`--header=${value} has no name. Write it as Name:Value.`);
  headers[name] = value.slice(colon + 1).trim();
}

const preset: ProviderPreset = PROVIDER_PRESETS[presetId];
const targetEnvKey =
  ENV_KEY_MAP[presetId] ?? `${presetId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
// No fallback to another vendor's key: it would be sent to this preset's host.
const apiKey =
  flags["api-key"] ??
  process.env[targetEnvKey] ??
  fail(`Missing API key. Set ${targetEnvKey} in dev/.env or pass --api-key=...`);

const model = modelArg ?? preset.defaultModel;
console.log(`\n======================================================`);
console.log(` Probing [${presetId}] model: ${model}`);
console.log(`======================================================\n`);

// Status and kind lead: a refused effort spelling reads as a 400 `invalid`, a
// spent subscription window as a 429 `quota`. A failure inside a 200 stream
// has no status.
function describeError(err: unknown): string {
  if (err instanceof ProviderError) {
    return `[${err.status ?? "no status"} ${err.kind}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function collectStream(
  provider: Provider,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  opts: StreamOptions = {},
): Promise<{
  text: string;
  reasoning: string;
  toolCalls: { name: string; arguments: string }[];
  usage?: TokenUsage;
  ttftMs: number;
  totalMs: number;
  finishReason?: string;
  error?: string;
}> {
  const started = Date.now();
  let ttftMs = 0;
  let text = "";
  let reasoning = "";
  const toolCalls: { name: string; arguments: string }[] = [];
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;

  try {
    const stream = provider.createStream(messages, tools, opts);
    for await (const chunk of stream) {
      if (!ttftMs) ttftMs = Date.now() - started;
      if (chunk.type === "delta") {
        if (chunk.content) text += chunk.content;
        if (chunk.reasoning) reasoning += chunk.reasoning;
        if (chunk.toolCalls) {
          for (const call of chunk.toolCalls) {
            if (call.name) {
              toolCalls.push({ name: call.name, arguments: call.arguments ?? "" });
            } else if (toolCalls.length > 0 && call.arguments) {
              toolCalls[toolCalls.length - 1]!.arguments += call.arguments;
            }
          }
        }
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
      } else if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
      }
    }
  } catch (err: unknown) {
    return {
      text,
      reasoning,
      toolCalls,
      usage,
      ttftMs,
      totalMs: Date.now() - started,
      finishReason,
      error: describeError(err),
    };
  }

  return {
    text,
    reasoning,
    toolCalls,
    usage,
    ttftMs: ttftMs || Date.now() - started,
    totalMs: Date.now() - started,
    finishReason,
  };
}

async function runDiagnostics() {
  const provider = createPresetProvider(presetId!, { apiKey, model, headers });

  // ----------------------------------------------------
  // Test 1: Connectivity, latency and effort
  // ----------------------------------------------------
  process.stdout.write(`[1/4] Probing connectivity, latency and effort="${effort}"... `);
  const basic = await collectStream(
    provider,
    [{ role: "user", content: "Reply with the single word OK." }],
    [],
    // A graded level thinks before it answers. At 16 tokens the thinking eats
    // the cap and the turn ends on length with no text, and Claude's budget
    // dialect needs a budget of at least 1,024 below the cap.
    { maxTokens: effort === "none" ? 16 : 4096, effort },
  );

  if (basic.error) {
    console.log(`FAILED: ${basic.error}`);
  } else {
    const reasoningTokens = basic.usage?.reasoningTokens;
    console.log(
      `OK (${basic.totalMs}ms total, TTFT ${basic.ttftMs}ms) → "${basic.text.trim()}" [finish=${basic.finishReason}, reasoning tokens=${reasoningTokens ?? "not reported"}]`,
    );
    // Responses streams reasoning text only for a graded level, so on `none`
    // the token count is the only sign the model thought anyway.
    if (effort === "none" && (basic.reasoning || reasoningTokens)) {
      console.log(
        `      ↳ reasoning tokens generated despite effort="none" (model enforces thinking)`,
      );
    }
  }

  // ----------------------------------------------------
  // Test 2: Structured Output (JSON Schema)
  // ----------------------------------------------------
  process.stdout.write("[2/4] Probing JSON Schema structured output... ");
  const schema: JsonObjectSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "pending"] },
      score: { type: "number" },
    },
    required: ["status", "score"],
    additionalProperties: false,
  };

  const jsonProbe = await collectStream(
    provider,
    [{ role: "user", content: "Generate a status result with status success and score 95." }],
    [],
    { json: { name: "result", schema }, maxTokens: 150 },
  );

  if (jsonProbe.error) {
    console.log(`FAILED: ${jsonProbe.error}`);
  } else {
    try {
      const parsed = JSON.parse(jsonProbe.text.trim());
      console.log(`OK → ${JSON.stringify(parsed)}`);
    } catch {
      console.log(`UNPARSED JSON: "${jsonProbe.text.slice(0, 80)}..."`);
    }
  }

  // ----------------------------------------------------
  // Test 3: Tool Calling In Isolation
  // ----------------------------------------------------
  process.stdout.write("[3/4] Probing native tool calling... ");
  const testTool: ToolDefinition = {
    name: "lookupCustomer",
    description: "Look up customer account details by ID",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "The customer ID to look up" },
      },
      required: ["customerId"],
    },
  };

  const toolProbe = await collectStream(
    provider,
    [{ role: "user", content: "Look up details for customer CUST-4421." }],
    [testTool],
    { toolChoice: "auto" },
  );

  if (toolProbe.error) {
    console.log(`FAILED: ${toolProbe.error}`);
  } else if (toolProbe.toolCalls.length > 0) {
    const call = toolProbe.toolCalls[0]!;
    console.log(`OK → called ${call.name}(${call.arguments.replace(/\s+/g, " ")})`);
  } else {
    console.log(`NARRATED IN PROSE (no tool call emitted) → "${toolProbe.text.slice(0, 100)}..."`);
  }

  // ----------------------------------------------------
  // Test 4: jsonWithTools, run by the library's own probe, so this script and a
  // boot-time probe can never disagree about a model.
  // ----------------------------------------------------
  process.stdout.write("[4/4] Probing jsonWithTools (tools + structured output coexistence)... ");
  if (preset.shape === "anthropic" || preset.shape === "responses") {
    console.log(
      `SKIPPED: the ${preset.shape} wire sends the schema the same way whatever jsonWithTools says, so there is nothing to choose.`,
    );
  } else {
    try {
      const probe = await probeJsonWithTools(provider);
      console.log(
        `\n      - with response_format:    ${probe.calls.response_format}/${probe.samples} called the tool`,
      );
      console.log(
        `      - with prompt injection:   ${probe.calls.prompt}/${probe.samples} called the tool`,
      );
      console.log(
        probe.use
          ? `      ↳ Recommendation for ${model}: jsonWithTools="${probe.use}"`
          : `      ↳ Warning: neither shape called the tool on every sample. Use another model for tools with a schema.`,
      );
    } catch (err: unknown) {
      console.log(`FAILED: ${describeError(err)}`);
    }
  }

  console.log("\nProbe complete.\n");
}

runDiagnostics().catch((err) => {
  console.error("Diagnostic error:", err);
  process.exit(1);
});
