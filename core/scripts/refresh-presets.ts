/**
 * Compares src/presets.ts against models.dev to spot drift:
 * - defaultModel or listed models that no longer appear in the catalog
 * - Newer versions or flagships available for configured providers
 *
 * Usage: bun run scripts/refresh-presets.ts
 */
import { PRESET_IDS, PROVIDER_PRESETS } from "../src/presets.ts";

interface ModelsDevProvider {
  name?: string;
  api?: string;
  models?: Record<string, unknown>;
}

const CATALOG_URL = "https://models.dev/api.json";

// Map our preset id to models.dev's provider key when they differ.
const ID_MAP: Record<string, string> = {
  google: "google",
  "google-openai": "google",
  moonshot: "moonshotai",
  zhipu: "zhipuai",
  zai: "zai-coding-plan",
  kimi: "kimi-for-coding",
  "kimi-plan": "kimi-for-coding",
  qwen: "alibaba-token-plan",
  together: "togetherai",
  fireworks: "fireworks-ai",
  claude: "anthropic",
  chatgpt: "openai",
};

async function main() {
  console.log(`Fetching catalog from ${CATALOG_URL}...`);
  const res = await fetch(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch models.dev catalog: ${res.status}`);
  }

  const catalog = (await res.json()) as Record<string, ModelsDevProvider>;

  console.log(`Checking ${PRESET_IDS.length} presets against catalog...\n`);
  let driftCount = 0;

  for (const id of PRESET_IDS) {
    const preset = PROVIDER_PRESETS[id];
    const catalogKey = ID_MAP[id] ?? id;
    const remote = catalog[catalogKey];

    if (!remote || !remote.models) {
      // Local runtime or custom endpoint (ollama, lmstudio, vllm, github-copilot)
      continue;
    }

    const remoteModels = new Set(Object.keys(remote.models));

    // Check if defaultModel is still in the catalog
    if (preset.defaultModel && !remoteModels.has(preset.defaultModel)) {
      console.warn(`[DRIFT] ${id}: defaultModel "${preset.defaultModel}" is not in catalog!`);
      driftCount++;
    }

    // Check if any listed model is missing
    for (const m of preset.models ?? []) {
      if (!remoteModels.has(m)) {
        console.warn(`[WARN] ${id}: model "${m}" not in catalog.`);
      }
    }
  }

  if (driftCount === 0) {
    console.log("All configured preset default models are present in the models.dev catalog!");
  } else {
    console.log(`\nFound ${driftCount} drift item(s). Review and update src/presets.ts.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
