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
  name?: string;
  provider?: string;
  inputModalities?: string[];
  isDefault?: boolean;
}

export interface CommandSummary {
  name: string;
  description?: string;
  inputHint?: string;
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

  renameSession(sessionId: string, title: string) {
    return this.call("x.ai/session/rename", { sessionId, title });
  }

  deleteSession(sessionId: string) {
    return this.call("x.ai/session/delete", { sessionId });
  }

  forkSession(sessionId: string) {
    return this.call("x.ai/session/fork", { sessionId });
  }

  async listModels(): Promise<ModelSummary[]> {
    const value = await this.call<unknown>("x.ai/models/list");
    return extractArray(value, ["availableModels", "models", "items"]).map(normalizeModel);
  }

  async listCommands(sessionId?: string): Promise<CommandSummary[]> {
    const value = await this.call<unknown>("x.ai/commands/list", sessionId ? { sessionId } : {});
    return extractArray(value, ["commands", "availableCommands", "items"]).map((item) => ({
      name: String(item.name ?? item.command ?? ""),
      description: stringValue(item.description),
      inputHint: stringValue(item.inputHint),
    }));
  }

  setApiKey(apiKey: string, provider?: string) {
    return this.call("x.ai/setApiKey", { apiKey, ...(provider ? { provider } : {}) });
  }

  resetPermissions(sessionId: string) {
    return this.call("x.ai/permissions/reset", { sessionId });
  }

  togglePlanMode(sessionId: string, enabled: boolean) {
    return this.call("x.ai/toggle_plan_mode", { sessionId, enabled });
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
  return {
    id: String(item.id ?? item.modelId ?? item.model ?? ""),
    name: stringValue(item.name ?? item.displayName),
    provider: stringValue(item.provider ?? item.modelProvider),
    inputModalities: Array.isArray(modalities) ? modalities.map(String) : undefined,
    isDefault: item.isDefault === true || item.default === true,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
