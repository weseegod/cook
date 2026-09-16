/**
 * Fork-owned provider (`x.ai/providers/*`) ACP wrappers plus the renderer-side preset mirror.
 *
 * The agent owns `config.toml`; the renderer only ever sends these requests, and the preset
 * catalog here is the offline/mock mirror of `x.ai/providers/presets`.
 */
import { request } from "./host";

export interface ProviderModelLink {
  id: string;
  name?: string;
  input?: string[];
}

export interface ProviderSummary {
  id: string;
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
  defaultModel?: string | null;
}

export interface PresetModel {
  id: string;
  model: string;
  name: string;
  input: string[];
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
  return request<ProviderList>("x.ai/providers/list", {});
}

export function providerPresets() {
  return request<{ presets: ProviderPreset[] }>("x.ai/providers/presets", {});
}

export function upsertProvider(params: ProviderUpsertRequest) {
  return request<ProviderUpsertResponse>("x.ai/providers/upsert", { ...params });
}

export function deleteProvider(id: string, replacement?: string) {
  return request<{ ok: boolean; id: string; removedModels: string[]; defaultModel?: string | null }>(
    "x.ai/providers/delete",
    { id, ...(replacement ? { replacement } : {}) },
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

export function setDefaultModel(modelId: string) {
  return request<{ ok: boolean; defaultModel: string }>("x.ai/models/set_default", { modelId });
}
