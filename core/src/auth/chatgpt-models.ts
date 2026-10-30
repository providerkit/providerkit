import { classifyHttp, ProviderError } from "../errors.ts";
import { PROVIDER_PRESETS } from "../presets.ts";
import { isEffort, type Effort } from "../types.ts";
import { asRecord, authFetch, num, str, webUrl, type AuthHost, type Credential } from "./oauth.ts";

/** Models the signed-in ChatGPT account can choose in Codex. */
export interface ChatGPTModel {
  id: string;
  name?: string;
  contextLength?: number;
  /** Only levels this package can send, without guessing equivalent levels. */
  reasoningEfforts?: Effort[];
  priority?: number;
}

export interface ChatGPTModelsOptions extends Pick<AuthHost, "fetchImpl" | "timeoutMs"> {
  /** The Codex API root. Defaults to the ChatGPT preset's base URL. */
  baseUrl?: string;
  /** The caller's version. Defaults to Codex's development version, `0.0.0`. */
  clientVersion?: string;
  signal?: AbortSignal;
}

/** Fetch the account's live model list. Never probes completions or falls back to static ids. */
export async function listChatGPTModels(
  credential: Pick<Credential, "accessToken" | "chatgptAccountId">,
  options: ChatGPTModelsOptions = {},
): Promise<ChatGPTModel[]> {
  const base = webUrl(options.baseUrl ?? PROVIDER_PRESETS.chatgpt.baseUrl);
  if (!base) throw new TypeError("The ChatGPT model list needs an http(s) base URL.");
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.searchParams.set("client_version", options.clientVersion ?? "0.0.0");
  const response = await authFetch(options, url.href, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      ...(credential.chatgptAccountId ? { "ChatGPT-Account-Id": credential.chatgptAccountId } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      "chatgpt",
      classifyHttp(response.status, text),
      `ChatGPT refused the model list request (HTTP ${response.status}).`,
      { status: response.status, body: text.slice(0, 2_000) },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw invalidCatalog();
  }
  const rows = asRecord(payload).models;
  if (!Array.isArray(rows)) throw invalidCatalog();
  const slugs = new Set<string>();
  return rows
    .map((row: unknown) => parseModel(row, slugs))
    .filter((model) => model !== undefined)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function parseModel(value: unknown, slugs: Set<string>): ChatGPTModel | undefined {
  const row = asRecord(value);
  const id = str(row.slug);
  if (
    !id?.trim() ||
    (row.visibility !== "list" && row.visibility !== "hide" && row.visibility !== "none")
  ) {
    throw invalidCatalog();
  }
  if (slugs.has(id)) throw invalidCatalog();
  slugs.add(id);
  const name = str(row.display_name);
  const contextLength = num(row.context_window);
  const priority = num(row.priority);
  if (
    (row.display_name !== undefined && !name?.trim()) ||
    (row.context_window != null &&
      (contextLength === undefined ||
        !Number.isSafeInteger(contextLength) ||
        contextLength <= 0)) ||
    (row.priority !== undefined && (priority === undefined || !Number.isSafeInteger(priority)))
  ) {
    throw invalidCatalog();
  }
  let reasoningEfforts: Effort[] | undefined;
  if (row.supported_reasoning_levels !== undefined) {
    if (!Array.isArray(row.supported_reasoning_levels)) throw invalidCatalog();
    reasoningEfforts = row.supported_reasoning_levels.flatMap((level: unknown) => {
      const effort = str(asRecord(level).effort);
      if (!effort) throw invalidCatalog();
      return isEffort(effort) ? [effort] : [];
    });
  }
  // `supported_in_api` limits API keys, not ChatGPT subscription accounts.
  if (row.visibility !== "list") return undefined;
  return {
    id,
    ...(name ? { name } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

function invalidCatalog(): ProviderError {
  return new ProviderError(
    "chatgpt",
    "invalid",
    "ChatGPT returned an invalid model list. Fetch the list again.",
    { code: "models_response_invalid" },
  );
}
