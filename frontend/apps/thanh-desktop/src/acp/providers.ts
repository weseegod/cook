/**
 * Desktop provider/model config service plus the renderer-side preset mirror.
 *
 * Tauri owns `~/.thanh/config.toml`; the renderer receives redacted DTOs. Browser tests fall back
 * to the mock ACP contract, while network probes and preset discovery remain agent operations.
 */
import { desktopCommand, request } from "./host";

export interface ProviderModelLink {
  id: string;
  model?: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
  supportsReasoningEffort?: boolean;
}

export interface ProviderSummary {
  id: string;
  name?: string | null;
  baseUrl?: string | null;
  apiBackend?: string | null;
  hasKey: boolean;
  inlineKey: boolean;
  keyHint?: string | null;
  envKey?: string | null;
  envKeyPresent: boolean;
  extraHeaders: Record<string, string>;
  models: ProviderModelLink[];
}

export interface ProviderList {
  providers: ProviderSummary[];
  /** Every explicit `[model.*]` row from config.toml, including xAI overrides. */
  models?: Array<ProviderModelLink & { provider: string }>;
  defaultModel?: string | null;
}

export interface PresetModel {
  id: string;
  model: string;
  name: string;
  input: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string | null;
  apiBackend: "chat_completions" | "responses" | "messages";
  envKey: string | null;
  help: string;
  discover: boolean;
  extraHeaders: Record<string, string>;
  models: PresetModel[];
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number | null;
  error?: string;
  url: string;
  model?: string | null;
  latencyMs: number;
}

export interface DiscoveredModel {
  id: string;
  name?: string | null;
}

/**
 * One entry of a provider's own `/models` listing.
 *
 * `contextWindow`/`maxCompletionTokens` are present only when the endpoint reports them
 * (OpenRouter fills both), and are what the add-model form seeds its limits from.
 */
export interface ProviderProbeModel {
  id: string;
  name?: string | null;
  contextWindow?: number;
  maxCompletionTokens?: number;
}

export interface ProviderProbeResult {
  ok: boolean;
  id: string;
  models: ProviderProbeModel[];
  error?: string;
}

export interface DiscoverResult {
  ok: boolean;
  id: string;
  discovered: DiscoveredModel[];
  added: string[];
  skipped: string[];
  error?: string;
}

export interface ProviderUpsertRequest {
  id: string;
  name?: string;
  baseUrl: string;
  apiBackend: string;
  apiKey?: string;
  envKey?: string;
  extraHeaders?: Record<string, string>;
  models: PresetModel[];
  setAsDefault?: boolean;
}

export interface ProviderUpsertResponse {
  ok: boolean;
  id: string;
  models: string[];
  defaultModel?: string | null;
}

export function listProviders() {
  return desktopCommand("desktop_provider_list", {}, () => request<ProviderList>("x.ai/providers/list", {}));
}

export function providerPresets() {
  return request<{ presets: ProviderPreset[] }>("x.ai/providers/presets", {});
}

export function upsertProvider(params: ProviderUpsertRequest) {
  return desktopCommand<ProviderUpsertResponse>("desktop_provider_upsert", { request: params }, async () =>
    request<ProviderUpsertResponse>("x.ai/providers/upsert", { ...params }),
  );
}

export function deleteProvider(id: string, replacement?: string) {
  return desktopCommand<{ ok: boolean; id: string; removedModels: string[]; defaultModel?: string | null }>(
    "desktop_provider_delete",
    { id, replacement },
    () => request("x.ai/providers/delete", { id, ...(replacement ? { replacement } : {}) }),
  );
}

export interface ModelUpsertRequest {
  id: string;
  model?: string;
  providerId?: string;
  name?: string;
  input: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
}

export function upsertModel(params: ModelUpsertRequest) {
  return desktopCommand<{ ok: boolean; modelId: string }>("desktop_model_upsert", { request: params }, () =>
    request("x.ai/models/upsert", { ...params }),
  );
}

export function deleteModel(modelId: string) {
  return desktopCommand<{ ok: boolean; modelId: string }>("desktop_model_delete", { modelId }, () =>
    request("x.ai/models/delete", { modelId }),
  );
}

export function testProvider(params: {
  id: string;
  baseUrl?: string;
  apiBackend?: string;
  apiKey?: string;
  envKey?: string;
  model?: string;
}) {
  return request<ProviderTestResult>("x.ai/providers/test", { ...params });
}

export function discoverProviderModels(params: {
  id: string;
  baseUrl?: string;
  apiBackend?: string;
  apiKey?: string;
  envKey?: string;
}) {
  return request<DiscoverResult>("x.ai/providers/discover_models", { ...params });
}

/**
 * Read what a provider's `/models` offers without writing `config.toml`.
 *
 * The agent's `discover_models` merges every id it finds as a `[model.*]` row, which is the wrong
 * shape for a picker: the native host probes instead, so a listing stays a listing.
 */
export function probeProviderModels(id: string) {
  return desktopCommand<ProviderProbeResult>("desktop_provider_models", { id }, () =>
    request<ProviderProbeResult>("x.ai/providers/probe_models", { id }),
  );
}

export function setDefaultModel(modelId: string) {
  return desktopCommand<{ ok: boolean; defaultModel: string }>("desktop_model_set_default", { modelId }, () =>
    request("x.ai/models/set_default", { modelId }),
  );
}
