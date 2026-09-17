import { request } from "./host";

export interface SessionSummary {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string | number;
  model?: string;
}

export interface ModelSummary {
  id: string;
  /** Routing slug sent to the provider; may differ from the catalog id. */
  apiModel?: string;
  name?: string;
  provider?: string;
  inputModalities?: string[];
  /** Whether the agent's catalog marks this model as the configured default. */
  isDefault?: boolean;
  supportsReasoningEffort?: boolean;
  /** The model's context window in tokens, as `_meta.totalContextTokens` reports it. */
  contextWindow?: number;
  /** Maximum completion/output tokens configured for this model. */
  maxCompletionTokens?: number;
  /** True when this row is explicitly present in ~/.thanh/config.toml. */
  configured?: boolean;
}

/** `x.ai/models/list`: the catalog plus the model the agent would use right now. */
export interface ModelCatalog {
  currentModelId: string | null;
  models: ModelSummary[];
}

export interface CommandSummary {
  name: string;
  description?: string;
  inputHint?: string;
}

/** The context block of `x.ai/session/info`: what the agent is holding right now. */
export interface SessionContextInfo {
  used?: number;
  total?: number;
  usagePct?: number;
  messageCount?: number;
  turnCount?: number;
  compactionCount?: number;
  toolDefinitionsCount?: number;
  freeTokens?: number;
}

/** `x.ai/session/info`: the agent's own view of the session. */
export interface SessionInfo {
  sessionId?: string;
  cwd?: string;
  model?: string;
  modelDisplayName?: string;
  turns?: number;
  context?: SessionContextInfo;
}

export type UnknownRecord = Record<string, unknown>;

export class XaiClient {
  call<T = UnknownRecord>(method: `x.ai/${string}` | `_x.ai/${string}`, params: UnknownRecord = {}) {
    return request<T>(method, params);
  }

  async listSessions(query = ""): Promise<SessionSummary[]> {
    const value = await this.call<unknown>("x.ai/session/list", query ? { query } : {});
    return extractArray(value, ["sessions", "items"]).map(normalizeSession);
  }

  async loadHistory(sessionId: string): Promise<unknown> {
    return this.call("x.ai/session/load_history", { sessionId });
  }

  /**
   * `x.ai/session/info`: what the agent is holding right now.
   *
   * The agent emits no ACP `usage_update` for a real turn, so this is the only report of context
   * occupancy there is.
   */
  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.call<SessionInfo>("x.ai/session/info", { sessionId });
  }

  renameSession(sessionId: string, title: string) {
    return this.call("x.ai/session/rename", { sessionId, title });
  }

  deleteSession(sessionId: string) {
    return this.call("x.ai/session/delete", { sessionId });
  }

  forkSession(sessionId: string) {
    return this.call("x.ai/session/fork", { sessionId });
  }

  async listModels(): Promise<ModelCatalog> {
    return modelCatalog(await this.call<unknown>("x.ai/models/list"));
  }

  async listCommands(sessionId?: string): Promise<CommandSummary[]> {
    const value = await this.call<unknown>("x.ai/commands/list", sessionId ? { sessionId } : {});
    return extractArray(value, ["commands", "availableCommands", "items"]).map(normalizeCommand);
  }

  setApiKey(apiKey: string, provider?: string) {
    return this.call("x.ai/setApiKey", { apiKey, ...(provider ? { provider } : {}) });
  }

  resetPermissions(sessionId: string) {
    return this.call("x.ai/permissions/reset", { sessionId });
  }

  /** Plan mode is an ACP session mode: `plan` engages it, `default` leaves it. */
  setMode(sessionId: string, modeId: "plan" | "default") {
    return request("session/set_mode", { sessionId, modeId });
  }
}

function extractArray(value: unknown, keys: string[]): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function normalizeSession(item: UnknownRecord): SessionSummary {
  return {
    id: String(item.id ?? item.sessionId ?? ""),
    title: stringValue(item.title ?? item.name ?? item.firstPrompt),
    cwd: stringValue(item.cwd ?? item.workingDirectory),
    updatedAt: (item.updatedAt ?? item.updated_at ?? item.timestamp) as string | number | undefined,
    model: stringValue(item.model ?? item.modelId),
  };
}

function normalizeModel(item: UnknownRecord): ModelSummary {
  const meta = isRecord(item._meta) ? item._meta : {};
  const modalities = item.inputModalities ?? meta.inputModalities ?? item.input;
  const id = String(item.id ?? item.modelId ?? item.model ?? "");
  return {
    id,
    name: stringValue(item.name ?? item.displayName),
    // The agent reports no provider column, but a BYOK catalog key is namespaced by its provider
    // (`zai/glm-5.3-flash`), which is exactly the id the `[model_providers.*]` row uses.
    provider: stringValue(item.provider ?? item.modelProvider) ?? (id.includes("/") ? id.split("/", 1)[0] : "xai"),
    inputModalities: Array.isArray(modalities) ? modalities.map(String) : undefined,
    isDefault: item.isDefault === true || item.default === true,
    supportsReasoningEffort: meta.supportsReasoningEffort === true,
    contextWindow: numberValue(meta.totalContextTokens ?? meta.total_context_tokens),
    maxCompletionTokens: numberValue(meta.maxCompletionTokens ?? meta.max_completion_tokens),
    apiModel: stringValue(meta.apiModel ?? meta.api_model ?? item.model),
  };
}

/**
 * Normalize `x.ai/models/list` (an `ExtMethodResult` envelope) and the `x.ai/models/update`
 * notification, which carry the same `{ currentModelId, availableModels }` payload.
 */
export function modelCatalog(value: unknown): ModelCatalog {
  return {
    currentModelId: stringValue(isRecord(value) ? value.currentModelId : undefined) ?? null,
    models: extractArray(value, ["availableModels", "models", "items"]).map(normalizeModel),
  };
}

/** Map an ACP `available_commands_update` payload to the same shape `x.ai/commands/list` returns. */
export function commandsFromUpdate(availableCommands: unknown): CommandSummary[] {
  if (!Array.isArray(availableCommands)) return [];
  return availableCommands.filter(isRecord).map(normalizeCommand);
}

function normalizeCommand(item: UnknownRecord): CommandSummary {
  return {
    name: String(item.name ?? item.command ?? ""),
    description: stringValue(item.description),
    // The hint is nested under `input.hint` on both `commands/list` and ACU.
    inputHint: stringValue(item.inputHint) ?? stringValue(isRecord(item.input) ? item.input.hint : undefined),
  };
}

/** Group catalog models for a picker; the derived `xai` bucket closes an unnamespaced id. */
export function groupByProvider<T extends { provider?: string }>(models: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const key = model.provider ?? "xai";
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
