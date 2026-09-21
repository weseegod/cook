import type { ProviderModelLink, ProviderPreset, ProviderSummary } from "../../../acp/providers";
import type { ModelSummary } from "../../../acp/xai";

export interface ProviderRow {
  preset: ProviderPreset;
  /** The `[model_providers.<id>]` table, absent until the provider is connected. */
  provider?: ProviderSummary;
  models: ModelSummary[];
  oauthConnected: boolean;
  oauthEmail?: string | null;
}

export function modelFromLink(model: ProviderModelLink, provider: string, selectedModel: string): ModelSummary {
  return {
    id: model.id,
    apiModel: model.model,
    name: model.name ?? model.id,
    provider,
    inputModalities: model.input,
    contextWindow: model.contextWindow,
    maxCompletionTokens: model.maxCompletionTokens,
    supportsReasoningEffort: model.supportsReasoningEffort,
    reasoningEffort: model.reasoningEffort,
    reasoningEfforts: model.reasoningEfforts,
    configured: true,
    isDefault: model.id === selectedModel,
  };
}

export function formatTokens(value?: number): string {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}
