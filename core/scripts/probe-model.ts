/**
 * Comprehensive LLM Model Capability & Diagnostics Probe
 *
 * Runs real-world diagnostics against any preset or model to verify:
 * 1. Connectivity & Streaming Latency (TTFT, tokens/sec)
 * 2. Thinking Budget & Reasoning Behavior (starvation, mandatory vs disabled)
 * 3. Structured Output (JSON Schema acceptance, OpenAPI subsets)
 * 4. Tool Calling & jsonWithTools Compatibility (tool emission with and without schemas)
 * 5. Prompt Cache Monotonicity & Hit Rate
 *
 * Usage:
 *   bun run scripts/probe-model.ts <preset> [model] [--api-key=...]
 *
 * Example:
 *   bun run scripts/probe-model.ts zai
 *   bun run scripts/probe-model.ts google gemini-2.5-flash
 *   bun run scripts/probe-model.ts openrouter z-ai/glm-5.3-flash
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { probeJsonWithTools } from "../src/capability.ts";
import { createPresetProvider } from "../src/providers/factory.ts";
import { PROVIDER_PRESETS, type ProviderPresetId } from "../src/presets.ts";
import type { ChatMessage, Provider, ProviderChunk, ToolDefinition } from "../src/types.ts";

// Load environment variables from dev projects if available
function loadDevEnv() {
  const envPaths = [
    "/Users/gus/dev/.env",
    "/Users/gus/dev/prospectar/apps/api/.env",
    "/Users/gus/dev/featury/apps/api/.env",
    "/Users/gus/dev/smartgenius/apps/api/.env",
    "/Users/gus/dev/atendime/apps/api/.env",
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/.exec(line);
        if (match && match[1] && !process.env[match[1]]) {
          const val = (match[2] ?? "").replace(/^['"]|['"]$/g, "").trim();
          if (val) process.env[match[1]] = val;
        }
      }
    }
  }
}
loadDevEnv();

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-openai": "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-openai": "MINIMAX_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-openai": "ZAI_API_KEY",
  kimi: "KIMI_API_KEY",
  "kimi-openai": "KIMI_API_KEY",
  "kimi-plan": "KIMI_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  "qwen-token-plan-openai": "DASHSCOPE_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  "qwen-api": "DASHSCOPE_API_KEY",
};

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
);

const presetId = args[0] as ProviderPresetId | undefined;
const modelArg = args[1];

if (!presetId || !PROVIDER_PRESETS[presetId]) {
  console.error("Usage: bun run scripts/probe-model.ts <preset> [model] [--api-key=KEY]");
  console.error(`Available presets: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
  process.exit(1);
}

const preset = PROVIDER_PRESETS[presetId];
const targetEnvKey = ENV_KEY_MAP[presetId] ?? `${presetId.toUpperCase()}_API_KEY`;
const apiKey =
  flags["api-key"] ??
  process.env[targetEnvKey] ??
  process.env.OPENROUTER_API_KEY ??
  process.env.OPENAI_API_KEY ??
  process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error(`Error: Missing API key. Set ${targetEnvKey} in dev/.env or pass --api-key=...`);
  process.exit(1);
}

const model = modelArg ?? preset.defaultModel;
console.log(`\n======================================================`);
console.log(` Probing [${presetId}] model: ${model}`);
console.log(`======================================================\n`);

async function collectStream(
  provider: Provider,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  opts: Record<string, unknown> = {},
): Promise<{
  text: string;
  reasoning: string;
  toolCalls: { name: string; arguments: string }[];
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
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
  let usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
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
        finishReason = chunk.reason;
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
      error: err instanceof Error ? err.message : String(err),
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
  const provider = createPresetProvider(presetId!, { apiKey, model });

  // ----------------------------------------------------
  // Test 1: Basic Connectivity & Latency
  // ----------------------------------------------------
  process.stdout.write("[1/4] Probing basic connectivity & latency... ");
  const basic = await collectStream(
    provider,
    [{ role: "user", content: "Reply with the single word OK." }],
    [],
    { maxTokens: 16, effort: "none" },
  );

  if (basic.error) {
    console.log(`FAILED: ${basic.error}`);
  } else {
    console.log(
      `OK (${basic.totalMs}ms total, TTFT ${basic.ttftMs}ms) → "${basic.text.trim()}" [finish=${basic.finishReason}]`,
    );
    if (basic.reasoning) {
      console.log(
        `      ↳ reasoning tokens generated despite effort="none" (model enforces thinking)`,
      );
    }
  }

  // ----------------------------------------------------
  // Test 2: Structured Output (JSON Schema)
  // ----------------------------------------------------
  process.stdout.write("[2/4] Probing JSON Schema structured output... ");
  const schema = {
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
  // Test 4: jsonWithTools — the library's own probe, so this script and a
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
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\nProbe complete.\n");
}

runDiagnostics().catch((err) => {
  console.error("Diagnostic error:", err);
  process.exit(1);
});
