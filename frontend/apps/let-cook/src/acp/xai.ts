import { notify, request } from "./host";
import { PROVIDER_PRESETS } from "./provider-presets";
import type { ProviderList } from "./providers";

export interface SessionSummary {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string | number;
  model?: string;
}

export interface ReasoningEffortOption {
  /** Presentation/input id; the backend accepts the canonical `value` on the wire. */
  id: string;
  value: string;
  label: string;
  description?: string;
  default?: boolean;
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
  /** The effort currently advertised by the model catalog (usually its default). */
  reasoningEffort?: string;
  /** Per-model selectable effort menu, when the agent advertises one. */
  reasoningEfforts?: ReasoningEffortOption[];
  /** The model's context window in tokens, as `_meta.totalContextTokens` reports it. */
  contextWindow?: number;
  /** Maximum completion/output tokens configured for this model. */
  maxCompletionTokens?: number;
  /** True when this row is explicitly present in ~/.cook/config.toml. */
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

/** `x.ai/sessions/delete_all`: what a wipe removed, and what it could not. */
export interface DeletedSessions {
  deleted: number;
  plansDeleted: number;
  failed: number;
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

/** Params for `x.ai/session/fork` — matches agent `ForkSessionRequest` (camelCase). */
export interface ForkSessionParams {
  sourceSessionId: string;
  sourceCwd: string;
  newCwd: string;
  newSessionId?: string;
  newModelId?: string;
  targetPromptIndex?: number;
  sessionKind?: string;
  sourceWorkspaceDir?: string;
}

/** Result of `x.ai/session/fork` — matches agent `ForkSessionResponse` (camelCase). */
export interface ForkSessionResult {
  newSessionId: string;
  newCwd: string;
  parentSessionId: string;
  chatMessagesCopied?: number;
  updatesCopied?: number;
  planStateCopied?: boolean;
  newModelId?: string;
}

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

  /**
   * `x.ai/sessions/delete_all`: erase every conversation this machine holds, with their plan files.
   *
   * The counts come back from the agent, which knows what it removed; `failed` is the number of
   * conversations it could not delete, so a partial wipe is reported rather than rounded to success.
   */
  async deleteAllSessions(): Promise<DeletedSessions> {
    const value = await this.call<UnknownRecord>("x.ai/sessions/delete_all");
    return {
      deleted: numberValue(value.deleted) ?? 0,
      plansDeleted: numberValue(value.plansDeleted ?? value.plans_deleted) ?? 0,
      failed: numberValue(value.failed) ?? 0,
    };
  }

  /**
   * `x.ai/session/fork` (map id `C-sess-fork`): camelCase `ForkSessionRequest`.
   * Creates peer session files; the caller still has to `session/load` the new id.
   */
  forkSession(params: ForkSessionParams) {
    return this.call<ForkSessionResult>("x.ai/session/fork", {
      sourceSessionId: params.sourceSessionId,
      sourceCwd: params.sourceCwd,
      newCwd: params.newCwd,
      ...(params.newSessionId ? { newSessionId: params.newSessionId } : {}),
      ...(params.newModelId ? { newModelId: params.newModelId } : {}),
      ...(params.targetPromptIndex !== undefined ? { targetPromptIndex: params.targetPromptIndex } : {}),
      ...(params.sessionKind ? { sessionKind: params.sessionKind } : {}),
      ...(params.sourceWorkspaceDir ? { sourceWorkspaceDir: params.sourceWorkspaceDir } : {}),
    });
  }

  async listModels(): Promise<ModelCatalog> {
    return modelCatalog(await this.call<unknown>("x.ai/models/list"));
  }

  async listCommands(sessionId?: string): Promise<CommandSummary[]> {
    const value = await this.call<unknown>("x.ai/commands/list", sessionId ? { sessionId } : {});
    return extractArray(value, ["commands", "availableCommands", "items"]).map(normalizeCommand);
  }

  /** C-perm: agent handles `x.ai/permissions/reset` as an ext_notification, not a request. */
  resetPermissions(sessionId: string) {
    return notify("x.ai/permissions/reset", { sessionId });
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
  const reasoningEfforts = normalizeReasoningEfforts(item.reasoningEfforts ?? meta.reasoningEfforts);
  const id = String(item.id ?? item.modelId ?? item.model ?? "");
  return {
    id,
    name: stringValue(item.name ?? item.displayName),
    // The agent reports no provider column, but a BYOK catalog key is namespaced by its provider
    // (`zai/glm-5.3-flash`), which is exactly the id the `[model_providers.*]` row uses.
    provider: stringValue(item.provider ?? item.modelProvider) ?? (id.includes("/") ? id.split("/", 1)[0] : "xai"),
    inputModalities: Array.isArray(modalities) ? modalities.map(String) : undefined,
    isDefault: item.isDefault === true || item.default === true,
    supportsReasoningEffort: meta.supportsReasoningEffort === true || item.supportsReasoningEffort === true,
    reasoningEffort: stringValue(meta.reasoningEffort ?? item.reasoningEffort),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    contextWindow: numberValue(meta.totalContextTokens ?? meta.total_context_tokens),
    maxCompletionTokens: numberValue(meta.maxCompletionTokens ?? meta.max_completion_tokens),
    apiModel: stringValue(meta.apiModel ?? meta.api_model ?? item.model),
  };
}

const FALLBACK_REASONING_EFFORTS: ReasoningEffortOption[] = [
  { id: "xhigh", value: "xhigh", label: "Xhigh", description: "Extended reasoning" },
  { id: "high", value: "high", label: "High", description: "Heavy reasoning" },
  { id: "medium", value: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "low", value: "low", label: "Low", description: "Faster, lighter reasoning" },
];

function humanizeReasoningId(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function normalizeReasoningEfforts(value: unknown): ReasoningEffortOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry): ReasoningEffortOption[] => {
    if (typeof entry === "string" && entry.trim()) {
      const normalized = entry.trim();
      return [{ id: normalized, value: normalized, label: humanizeReasoningId(normalized) }];
    }
    if (!isRecord(entry) || typeof entry.value !== "string" || !entry.value.trim()) return [];
    const canonical = entry.value.trim();
    const optionId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : canonical;
    return [{
      id: optionId,
      value: canonical,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : humanizeReasoningId(optionId),
      ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}),
      ...(entry.default === true ? { default: true } : {}),
    }];
  });
  return options.length > 0 ? options : undefined;
}

/** The menu exposed by the agent, or its documented fallback for older catalogs. */
export function reasoningEffortOptions(model: ModelSummary | null | undefined): ReasoningEffortOption[] {
  if (!model?.supportsReasoningEffort) return [];
  return model.reasoningEfforts?.length ? model.reasoningEfforts : FALLBACK_REASONING_EFFORTS;
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

/**
 * Restore provider/config metadata that the agent's model catalog can omit.
 *
 * The ACP catalog is intentionally provider-agnostic for many ids, so an unnamespaced `gpt-*`
 * entry otherwise falls through to the historical `xai` default in `normalizeModel`. Explicit
 * `[model.*]` rows are the source of truth for Desktop and are also available from the browser
 * mock, which makes this merge useful to both transports.
 */
export function mergeConfiguredModels(catalog: ModelCatalog, configured?: ProviderList | null): ModelCatalog {
  if (!configured) return catalog;

  const configuredModels = new Map<string, ModelSummary>();
  const explicit = configured.models?.length ? configured.models : configured.providers.flatMap((provider) =>
    provider.models.map((model) => ({ ...model, provider: provider.id })),
  );
  for (const model of explicit) {
    if (!model.id) continue;
    configuredModels.set(model.id, {
      id: model.id,
      apiModel: model.model,
      name: model.name,
      provider: model.provider,
      inputModalities: model.input,
      contextWindow: model.contextWindow,
      maxCompletionTokens: model.maxCompletionTokens,
      supportsReasoningEffort: model.supportsReasoningEffort,
      reasoningEffort: model.reasoningEffort,
      reasoningEfforts: model.reasoningEfforts,
      configured: true,
    });
  }

  const models = new Map(catalog.models.map((model) => [model.id, model]));
  for (const [id, configuredModel] of configuredModels) {
    const existing = models.get(id);
    models.set(id, {
      ...existing,
      ...configuredModel,
      // The ACP catalog may know richer runtime metadata than config.toml. Keep it when the
      // configured row does not specify a value, while always trusting its provider ownership.
      name: configuredModel.name ?? existing?.name,
      apiModel: configuredModel.apiModel ?? existing?.apiModel,
      inputModalities: configuredModel.inputModalities ?? existing?.inputModalities,
      contextWindow: configuredModel.contextWindow ?? existing?.contextWindow,
      maxCompletionTokens: configuredModel.maxCompletionTokens ?? existing?.maxCompletionTokens,
      supportsReasoningEffort: configuredModel.supportsReasoningEffort ?? existing?.supportsReasoningEffort,
      reasoningEffort: existing?.reasoningEffort ?? configuredModel.reasoningEffort,
      reasoningEfforts: existing?.reasoningEfforts ?? configuredModel.reasoningEfforts,
    });
  }

  const currentModelId = catalog.currentModelId || configured.defaultModel || null;
  return {
    currentModelId,
    models: [...models.values()].map((model) => ({
      ...model,
      isDefault: model.id === currentModelId || model.isDefault,
    })),
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

export function providerDisplayName(provider: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === provider)?.label ?? provider;
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
