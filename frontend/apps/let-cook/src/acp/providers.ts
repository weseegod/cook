/**
 * Desktop provider/model config service plus the renderer-side preset mirror.
 *
 * Tauri owns `~/.cook/config.toml`; the renderer receives redacted DTOs. Browser tests fall back
 * to the mock ACP contract, while network probes and preset discovery remain agent operations.
 */
import { PROVIDER_PRESETS } from "./provider-presets";
import { desktopCommand, isTauriRuntime, request } from "./host";
import { modelCatalog, type ReasoningEffortOption } from "./xai";
import { useCatalogStore } from "../state/catalog";

export interface ProviderModelLink {
  id: string;
  model?: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
  supportsReasoningEffort?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: ReasoningEffortOption[];
}

export interface ProviderSummary {
  id: string;
  name?: string | null;
  baseUrl?: string | null;
  apiBackend?: string | null;
  hasKey: boolean;
  inlineKey: boolean;
  envKey?: string | null;
  envKeyPresent: boolean;
  extraHeaders: Record<string, string>;
  /** True when Connect stored an OAuth session rather than an API key. */
  oauth?: boolean;
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
  oauth?: boolean;
}

export interface ProviderUpsertResponse {
  ok: boolean;
  id: string;
  models: string[];
  defaultModel?: string | null;
}

export function listProviders() {
  return desktopCommand("desktop_provider_list", {}, () => request<ProviderList>("x.ai/providers/list", {})).then(async (response) => {
    // The native list call also repairs legacy ChatGPT OAuth routes. Make the running agent
    // consume that migration before the picker exposes the provider's models.
    await reloadDesktopModels();
    return response;
  });
}

/**
 * Desktop writes config.toml outside the agent process. Ask the running agent to consume that
 * write before the settings flow exposes newly-added model ids to the picker. Older agents keep
 * their config watcher as a fallback, so a missing internal method must not make a successful
 * config write look like a failed save.
 */
async function reloadDesktopModels(): Promise<void> {
  if (!isTauriRuntime()) return;
  await request("x.ai/internal/reload_models").catch(() => undefined);
}

export function providerPresets() {
  // The current agent may not implement x.ai/providers/presets. Tauri already ships the same
  // renderer-side catalog, so settings must not turn an optional catalog call into a -32601.
  if (isTauriRuntime()) return Promise.resolve({ presets: PROVIDER_PRESETS });
  return request<{ presets: ProviderPreset[] }>("x.ai/providers/presets", {});
}

export function upsertProvider(params: ProviderUpsertRequest) {
  return desktopCommand<ProviderUpsertResponse>("desktop_provider_upsert", { request: params }, async () =>
    request<ProviderUpsertResponse>("x.ai/providers/upsert", { ...params }),
  ).then(async (response) => {
    await reloadDesktopModels();
    return response;
  });
}

export function deleteProvider(id: string, replacement?: string) {
  return desktopCommand<{ ok: boolean; id: string; removedModels: string[]; defaultModel?: string | null }>(
    "desktop_provider_delete",
    { id, replacement },
    () => request("x.ai/providers/delete", { id, ...(replacement ? { replacement } : {}) }),
  ).then(async (response) => {
    await reloadDesktopModels();
    return response;
  });
}

export interface ModelUpsertRequest {
  id: string;
  model?: string;
  providerId?: string;
  name?: string;
  input: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
  supportsReasoningEffort?: boolean;
}

export function upsertModel(params: ModelUpsertRequest) {
  return desktopCommand<{ ok: boolean; modelId: string }>("desktop_model_upsert", { request: params }, () =>
    request("x.ai/models/upsert", { ...params }),
  ).then(async (response) => {
    await reloadDesktopModels();
    const catalog = useCatalogStore.getState();
    const previous = catalog.models.find((model) => model.id === params.id);
    const saved = {
      ...previous,
      id: params.id,
      apiModel: params.model ?? previous?.apiModel ?? params.id,
      provider: params.providerId ?? previous?.provider ?? "xai",
      name: params.name ?? previous?.name ?? params.id,
      inputModalities: params.input,
      contextWindow: params.contextWindow ?? previous?.contextWindow,
      maxCompletionTokens: params.maxCompletionTokens ?? previous?.maxCompletionTokens,
      supportsReasoningEffort: params.supportsReasoningEffort ?? previous?.supportsReasoningEffort,
      configured: true,
    };
    catalog.setModelCatalog({
      currentModelId: catalog.currentModelId,
      models: [...catalog.models.filter((model) => model.id !== params.id), saved],
    });
    return response;
  });
}

export function deleteModel(modelId: string) {
  return desktopCommand<{ ok: boolean; modelId: string }>("desktop_model_delete", { modelId }, () =>
    request("x.ai/models/delete", { modelId }),
  ).then(async (response) => {
    await reloadDesktopModels();
    return response;
  });
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
 * Grok OAuth uses the agent's session-authenticated model catalog. Other connections use the
 * native read-only provider probe; neither path writes models until the user selects one.
 */
export async function probeProviderModels(id: string, grokOauth = false): Promise<ProviderProbeResult> {
  if (id === "xai" && grokOauth) {
    const catalog = modelCatalog(await request<unknown>("x.ai/models/list", {}));
    const models = catalog.models.filter((model) => model.provider === "xai" && model.id).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxCompletionTokens: model.maxCompletionTokens,
    }));
    return models.length
      ? { ok: true, id, models }
      : { ok: false, id, models: [], error: "Grok did not list any models for this account" };
  }
  return desktopCommand<ProviderProbeResult>("desktop_provider_models", { id }, () =>
    request<ProviderProbeResult>("x.ai/providers/probe_models", { id }),
  );
}

export function setDefaultModel(modelId: string) {
  return desktopCommand<{ ok: boolean; defaultModel: string }>("desktop_model_set_default", { modelId }, () =>
    request("x.ai/models/set_default", { modelId }),
  ).then(async (response) => {
    await reloadDesktopModels();
    return response;
  });
}
