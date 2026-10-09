import { findPreset } from "../../../acp/provider-presets";
import type { ProviderModelLink, ProviderPreset, ProviderSummary } from "../../../acp/providers";
import type { ModelSummary } from "../../../acp/xai";

const XAI_OAUTH_SESSION_METHODS = new Set(["cached_token", "grok.com", "oidc"]);

/** Cook OAuth Sign out — not API key and not a stale session method with no email. */
export function isXaiOauthSignedIn(methodId?: string | null, email?: string | null): boolean {
  return Boolean(methodId && XAI_OAUTH_SESSION_METHODS.has(methodId) && email);
}

export interface ProviderRow {
  preset: ProviderPreset;
  /** The `[model_providers.<id>]` table, absent until the provider is connected. */
  provider?: ProviderSummary;
  models: ModelSummary[];
  /** Removed built-in. Stays on screen, after every active row, until Connect. */
  inactive?: boolean;
  oauthConnected: boolean;
  oauthEmail?: string | null;
}

export function buildProviderRows({
  presets,
  providers,
  explicitModels,
  catalog,
  selectedModel,
  hiddenIds,
  xaiAuthenticated,
  xaiEmail,
}: {
  presets: ProviderPreset[];
  providers: ProviderSummary[];
  explicitModels: Array<ProviderModelLink & { provider: string }>;
  catalog: ModelSummary[];
  selectedModel: string;
  hiddenIds: readonly string[];
  xaiAuthenticated: boolean;
  xaiEmail?: string | null;
}): ProviderRow[] {
  const hidden = new Set(hiddenIds);
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const customPreset = findPreset("custom");
  const makeRow = (preset: ProviderPreset, provider: ProviderSummary | undefined, inactive: boolean): ProviderRow => {
    const merged = new Map<string, ModelSummary>();
    if (!inactive) {
      for (const model of provider?.models ?? []) merged.set(model.id, modelFromLink(model, preset.id, selectedModel));
      for (const model of explicitModels.filter((model) => model.provider === preset.id)) {
        merged.set(model.id, modelFromLink(model, preset.id, selectedModel));
      }
      for (const [id, model] of merged) {
        const known = catalogById.get(id);
        if (!known) continue;
        merged.set(id, {
          ...model,
          apiModel: model.apiModel ?? known.apiModel,
          contextWindow: model.contextWindow ?? known.contextWindow,
          maxCompletionTokens: model.maxCompletionTokens ?? known.maxCompletionTokens,
          inputModalities: model.inputModalities ?? known.inputModalities,
          isDefault: model.isDefault || known.isDefault,
        });
      }
    }
    return {
      preset,
      provider: inactive ? undefined : provider,
      models: [...merged.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
      inactive,
      oauthConnected: !inactive && ((preset.id === "xai" && xaiAuthenticated) || Boolean(provider?.oauth)),
      oauthEmail: preset.id === "xai" ? xaiEmail : null,
    };
  };
  const configuredRows = presets.flatMap((preset) => {
    if (hidden.has(preset.id)) return [];
    const provider = configured.get(preset.id);
    return provider ? [makeRow(preset, provider, false)] : [];
  });
  const extraConfiguredRows = customPreset
    ? providers.flatMap((provider) => {
        if (presets.some((preset) => preset.id === provider.id) || hidden.has(provider.id)) return [];
        return [makeRow(
          { ...customPreset, id: provider.id, label: provider.name ?? provider.id, baseUrl: provider.baseUrl ?? null, models: [] },
          provider,
          false,
        )];
      })
    : [];
  const unconfiguredRows = presets.flatMap((preset) => (
    hidden.has(preset.id) || configured.has(preset.id) ? [] : [makeRow(preset, undefined, false)]
  ));
  const inactiveRows = presets.flatMap((preset) => (
    hidden.has(preset.id) ? [makeRow(preset, configured.get(preset.id), true)] : []
  ));
  const isConnected = (row: ProviderRow) => Boolean(
    row.oauthConnected || row.provider?.inlineKey || (row.provider?.hasKey && row.provider.envKeyPresent),
  );
  const active = [...configuredRows, ...extraConfiguredRows, ...unconfiguredRows]
    .sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)));
  return [...active, ...inactiveRows];
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
