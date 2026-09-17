import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Cpu, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, Star, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { isVisibleProviderPreset, mergedProviderStatus, PROVIDER_PRESETS } from "../../acp/provider-presets";
import { request } from "../../acp/host";
import {
  deleteProvider,
  deleteModel,
  listProviders,
  providerPresets,
  type ProviderPreset,
  type ProviderSummary,
  type ProviderModelLink,
} from "../../acp/providers";
import { acpClient } from "../../acp/client";
import { groupByProvider, type ModelSummary } from "../../acp/xai";
import { PresetGrid, ProviderEditor } from "./provider-form";
import { ModelDialog } from "./model-dialog";
import { Dialog, DialogActions } from "../components/dialog";
import { LoadingState } from "../components/async-state";

/** Agent presets win; the bundled mirror keeps the cards usable offline. */
export function useProviderPresets() {
  const query = useQuery({
    queryKey: ["provider-presets"],
    queryFn: providerPresets,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
  const bundled = PROVIDER_PRESETS.filter(isVisibleProviderPreset);
  const live = new Map((query.data?.presets ?? []).filter(isVisibleProviderPreset).map((preset) => [preset.id, preset]));
  const presets = bundled.map((preset) => live.get(preset.id) ?? preset);
  return { presets, isLoading: query.isLoading };
}

export function useProviders(connected: boolean) {
  return useQuery({
    queryKey: ["providers"],
    queryFn: listProviders,
    enabled: connected,
    retry: 0,
  });
}

interface ProviderRow {
  preset: ProviderPreset;
  /** The `[model_providers.<id>]` table, absent until the provider is connected. */
  provider?: ProviderSummary;
  models: ModelSummary[];
  oauthConnected: boolean;
  oauthEmail?: string | null;
}

export function ProvidersPanel({
  connected,
  models,
  selectedModel,
  modelKnown,
  onDirtyChange,
}: {
  connected: boolean;
  models: ModelSummary[];
  selectedModel: string;
  modelKnown: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { presets } = useProviderPresets();
  const providers = useProviders(connected);
  const auth = useQuery({
    queryKey: ["auth-info", "settings"],
    queryFn: () => request<{ methodId?: string | null; email?: string | null }>("x.ai/auth/info"),
    enabled: connected,
    retry: 0,
  });
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProviderPreset | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [modelTarget, setModelTarget] = useState<{ provider: ProviderSummary; model?: ModelSummary } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderRow | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelSummary | null>(null);
  const [replacement, setReplacement] = useState<{ provider: ProviderSummary; modelId: string } | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void acpClient.refreshModels();
  };

  /**
   * Removing a provider takes its whole `[model_providers.<id>]` table and every `[model.*]` row
   * that pointed at it. If one of those models is the current default the host refuses the write,
   * and the panel asks which model the default should become instead.
   */
  const removeProvider = useMutation({
    mutationFn: ({ provider, replacement: next }: { provider: ProviderSummary; replacement?: string }) =>
      deleteProvider(provider.id, next),
    onSuccess: () => {
      setNotice(null);
      setDeletingProvider(null);
      setReplacement(null);
      refresh();
    },
    onError: (error, request_) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("would dangle")) {
        setDeletingProvider(null);
        setNotice(null);
        setReplacement({ provider: request_.provider, modelId: "" });
      } else {
        setNotice(message);
      }
    },
  });

  const removeModel = useMutation({
    mutationFn: (model: ModelSummary) => deleteModel(model.id),
    onSuccess: () => {
      setDeletingModel(null);
      setNotice(null);
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const list = providers.data?.providers ?? [];
  const rows = useMemo<ProviderRow[]>(() => {
    const configured = new Map(list.map((provider) => [provider.id, provider]));
    const explicitModels = providers.data?.models ?? [];
    // Catalog entries only fill in metadata for a configured model; they never add one, or a
    // model the user just removed would come straight back from the agent's cached catalog.
    const catalog = new Map(models.map((model) => [model.id, model]));
    const makeRow = (preset: ProviderPreset, provider?: ProviderSummary): ProviderRow => {
      const merged = new Map<string, ModelSummary>();
      for (const model of provider?.models ?? []) merged.set(model.id, modelFromLink(model, preset.id, selectedModel));
      for (const model of explicitModels.filter((model) => model.provider === preset.id)) {
        merged.set(model.id, modelFromLink(model, preset.id, selectedModel));
      }
      for (const [id, model] of merged) {
        const known = catalog.get(id);
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
      return {
        preset,
        provider,
        models: [...merged.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
        oauthConnected: preset.id === "xai" && Boolean(auth.data?.methodId),
        oauthEmail: preset.id === "xai" ? auth.data?.email : null,
      };
    };
    const configuredRows = presets.flatMap((preset) => {
      const provider = configured.get(preset.id);
      return provider ? [makeRow(preset, provider)] : [];
    });
    const customPreset = PROVIDER_PRESETS.find((preset) => preset.id === "custom")!;
    const extraConfiguredRows = list.flatMap((provider) => configured.has(provider.id) && !presets.some((preset) => preset.id === provider.id)
      ? [makeRow({ ...customPreset, id: provider.id, label: provider.name ?? provider.id, baseUrl: provider.baseUrl ?? null, models: [] }, provider)]
      : []);
    const unconfiguredRows = presets.flatMap((preset) => configured.has(preset.id) ? [] : [makeRow(preset)]);
    const isConnected = (row: ProviderRow) => Boolean(row.oauthConnected || row.provider?.inlineKey || (row.provider?.hasKey && row.provider.envKeyPresent));
    return [...configuredRows, ...extraConfiguredRows, ...unconfiguredRows].sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)));
  }, [auth.data?.email, auth.data?.methodId, list, models, presets, providers.data?.models, selectedModel]);

  /**
   * Every model the window can offer: the agent's catalog plus whatever `config.toml` added that
   * the catalog has not caught up with yet.
   */
  const pickerModels = useMemo(() => {
    const byId = new Map<string, ModelSummary>();
    for (const model of models) byId.set(model.id, model);
    for (const row of rows) {
      for (const model of row.models) if (!byId.has(model.id)) byId.set(model.id, model);
    }
    return [...byId.values()];
  }, [models, rows]);
  const modelGroups = useMemo(() => groupByProvider(pickerModels), [pickerModels]);
  const pickerKnown = modelKnown || pickerModels.some((model) => model.id === selectedModel);

  /** Models the default could move to if the removed provider owned the current one. */
  const replacementChoices = useMemo(() => {
    if (!replacement) return [];
    const removed = new Set(rows.find((row) => row.provider?.id === replacement.provider.id)?.models.map((model) => model.id) ?? []);
    return pickerModels.filter((model) => !removed.has(model.id));
  }, [pickerModels, replacement, rows]);

  function closeProviderEditor() {
    setEditing(null);
    setEditingProvider(null);
    setAdding(false);
    onDirtyChange?.(false);
  }

  function openEditor(preset: ProviderPreset, provider?: ProviderSummary) {
    setAdding(false);
    setEditingProvider(provider ?? null);
    setEditing(preset);
    onDirtyChange?.(true);
  }

  return (
    <div className="providers-panel unified-provider-panel">
      <div className="provider-catalog-toolbar">
        <label className="field default-model-field">
          <span>Default model</span>
          <select
            value={selectedModel}
            aria-label="Default model"
            data-testid="settings-default-model"
            disabled={pickerModels.length === 0}
            onChange={(event) => void acpClient.setDefaultModel(event.target.value)}
          >
            {!pickerKnown && <option value={selectedModel} disabled>{pickerModels.length === 0 ? "Loading models…" : selectedModel || "Select model"}</option>}
            {modelGroups.map(([providerId, entries]) => (
              <optgroup key={providerId} label={providerId}>
                {entries.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="settings-actions">
          <button className="primary-button" onClick={() => { setAdding(true); setNotice(null); }} data-testid="provider-add">
            <Plus size={15} /> Add provider
          </button>
          <button className="ghost-button" onClick={() => void providers.refetch()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {notice && <div className="settings-note security-warning" data-testid="provider-notice" role="alert">{notice}</div>}
      {connected && providers.isLoading && <LoadingState label="Loading providers" />}

      <div className="provider-model-list">
        {rows.map((row) => {
          const status = mergedProviderStatus(row.provider, row.oauthConnected);
          const label = row.provider?.name ?? row.preset.label;
          const configure = () => openEditor(row.preset, row.provider);
          return (
            <article className="provider-model-card" key={row.preset.id} data-testid={`provider-row-${row.preset.id}`}>
              <header className="provider-model-heading">
                <div className="provider-row-main">
                  <div className="provider-title-line">
                    <strong>{label}</strong>
                    <span className={`badge badge-${status.tone}`}>
                      {status.tone === "ok" ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />} {status.label}
                      {row.provider?.keyHint ? ` · ${row.provider.keyHint}` : ""}
                    </span>
                  </div>
                  <small>{row.oauthConnected ? row.oauthEmail ?? "Thanh account" : row.provider?.baseUrl ?? row.preset.baseUrl ?? "Provider endpoint"}</small>
                </div>
                <div className="provider-header-actions">
                  {row.provider ? (
                    <>
                      <button
                        className="ghost-button provider-header-model-button"
                        aria-label={`Add model to ${row.preset.id}`}
                        data-testid={`provider-add-model-${row.preset.id}`}
                        onClick={() => { setNotice(null); setModelTarget({ provider: row.provider! }); }}
                      >
                        <Plus size={13} /> Add model
                      </button>
                      <button className="ghost-button provider-header-model-button" data-testid={`provider-edit-${row.preset.id}`} onClick={configure}>
                        <Pencil size={13} /> Edit
                      </button>
                      <button
                        className="ghost-button danger-ghost-button provider-header-model-button"
                        data-testid={`provider-remove-${row.preset.id}`}
                        onClick={() => { setNotice(null); setDeletingProvider(row); }}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary-button provider-connect-button"
                      data-testid={`provider-connect-${row.preset.id}`}
                      onClick={configure}
                    >
                      <LogIn size={14} /> Connect
                    </button>
                  )}
                </div>
              </header>

              <div className="provider-model-content">
                <div className="provider-models-summary">
                  <div className="provider-models-label">
                    <Cpu size={14} /><strong>Models</strong>
                    <small>{row.models.length === 0 ? "none configured" : `${row.models.length} configured`}</small>
                  </div>
                  {row.models.length > 0 ? (
                    <ul className="model-list">
                      {row.models.map((model) => (
                        <li key={model.id} data-testid={`model-row-${model.id}`}>
                          <div className="model-row-copy"><strong title={model.name ?? model.id}>{model.name ?? model.id}</strong><code title={model.id}>{model.id}</code></div>
                          <div className="model-row-meta">
                            <span title="Context window">Context {formatTokens(model.contextWindow)}</span>
                            <span title="Maximum output tokens">Output {formatTokens(model.maxCompletionTokens)}</span>
                            <span title="Accepted input">Input {model.inputModalities?.join(" + ") || "—"}</span>
                            {(model.isDefault || model.id === selectedModel) && <span className="model-default" title="Default model"><Star size={12} /> Default</span>}
                            {model.id === selectedModel && <Check className="model-selected-check" size={13} aria-label="Selected" />}
                            <button
                              className="icon-button model-edit-button"
                              aria-label={`Edit model ${model.id}`}
                              onClick={() => row.provider && setModelTarget({ provider: row.provider, model })}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="icon-button model-delete-button"
                              aria-label={`Remove model ${model.id}`}
                              data-testid={`model-remove-${model.id}`}
                              onClick={() => { setNotice(null); setDeletingModel(model); }}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="provider-no-models">
                      {row.provider
                        ? "No models yet. Add one to make it selectable in chat."
                        : "Connect this provider to choose models."}
                    </p>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {deletingProvider && (
        <Dialog
          title={`Remove ${deletingProvider.provider?.name ?? deletingProvider.preset.label}?`}
          tone="danger"
          size="sm"
          description="This deletes config, not just the saved key."
          onClose={() => setDeletingProvider(null)}
        >
          <p className="dialog-note">
            <code>[model_providers.{deletingProvider.preset.id}]</code> and every model below are
            removed from <code>~/.thanh/config.toml</code>. The credential goes with them, and chat
            can no longer use these models.
          </p>
          {deletingProvider.models.length > 0 && (
            <ul className="dialog-model-chips">
              {deletingProvider.models.map((model) => <li key={model.id}><code>{model.id}</code></li>)}
            </ul>
          )}
          <DialogActions>
            <button className="ghost-button" onClick={() => setDeletingProvider(null)} disabled={removeProvider.isPending}>Cancel</button>
            <button
              className="danger-button"
              data-testid="provider-remove-confirm"
              disabled={removeProvider.isPending}
              onClick={() => removeProvider.mutate({ provider: deletingProvider.provider! })}
            >
              {removeProvider.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove provider
            </button>
          </DialogActions>
        </Dialog>
      )}

      {deletingModel && (
        <Dialog
          title={`Remove ${deletingModel.name ?? deletingModel.id}?`}
          tone="danger"
          size="sm"
          description={`[model."${deletingModel.id}"] is deleted from ~/.thanh/config.toml.`}
          onClose={() => setDeletingModel(null)}
        >
          {deletingModel.id === selectedModel && (
            <p className="dialog-note">This is the current default model; pick another default first.</p>
          )}
          <DialogActions>
            <button className="ghost-button" onClick={() => setDeletingModel(null)} disabled={removeModel.isPending}>Cancel</button>
            <button
              className="danger-button"
              data-testid="model-remove-confirm"
              disabled={removeModel.isPending}
              onClick={() => removeModel.mutate(deletingModel)}
            >
              {removeModel.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove model
            </button>
          </DialogActions>
        </Dialog>
      )}

      {replacement && (
        <Dialog
          title="Choose the new default model"
          tone="warning"
          description={`${replacement.provider.name ?? replacement.provider.id} owns the current default model, so removing it needs a replacement.`}
          onClose={() => setReplacement(null)}
        >
          {replacementChoices.length > 0 ? (
            <label className="dialog-field">
              <span>New default model</span>
              <select
                autoFocus
                value={replacement.modelId}
                aria-label="Replacement model"
                data-testid="replacement-model"
                onChange={(event) => setReplacement((current) => current && { ...current, modelId: event.target.value })}
              >
                <option value="">Select a model…</option>
                {replacementChoices.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
              </select>
            </label>
          ) : (
            <p className="dialog-note">Add a model on another provider first, then remove this one.</p>
          )}
          <DialogActions>
            <button className="ghost-button" onClick={() => setReplacement(null)} disabled={removeProvider.isPending}>Cancel</button>
            <button
              className="danger-button"
              disabled={!replacement.modelId || removeProvider.isPending}
              onClick={() => removeProvider.mutate({ provider: replacement.provider, replacement: replacement.modelId })}
            >
              {removeProvider.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove provider
            </button>
          </DialogActions>
        </Dialog>
      )}

      {modelTarget && (
        <ModelDialog
          provider={modelTarget.provider}
          model={modelTarget.model}
          existingIds={rows.find((row) => row.provider?.id === modelTarget.provider.id)?.models.map((model) => model.id) ?? []}
          onSaved={() => { setModelTarget(null); refresh(); }}
          onClose={() => setModelTarget(null)}
        />
      )}

      {adding && !editing && (
        <Dialog
          title="Add provider"
          description="Connect a service to make its models available in chat."
          size="wide"
          onClose={() => setAdding(false)}
        >
          <PresetGrid presets={presets} onPick={(preset) => openEditor(preset)} />
        </Dialog>
      )}

      {editing && (
        <Dialog
          title={`${editingProvider ? "Edit" : "Connect"} ${editing.label}`}
          description={editingProvider
            ? "Endpoint and credential. Models are managed from the provider's own row."
            : `Endpoint and credential for ${editing.label}.`}
          size="wide"
          onClose={closeProviderEditor}
        >
          <ProviderEditor
            preset={editing}
            provider={editingProvider ?? undefined}
            variant="connection"
            onSaved={() => {
              closeProviderEditor();
              refresh();
            }}
            onCancel={closeProviderEditor}
          />
        </Dialog>
      )}
    </div>
  );
}

function modelFromLink(model: ProviderModelLink, provider: string, selectedModel: string): ModelSummary {
  return {
    id: model.id,
    apiModel: model.model,
    name: model.name ?? model.id,
    provider,
    inputModalities: model.input,
    contextWindow: model.contextWindow,
    maxCompletionTokens: model.maxCompletionTokens,
    supportsReasoningEffort: model.supportsReasoningEffort,
    configured: true,
    isDefault: model.id === selectedModel,
  };
}

function formatTokens(value?: number): string {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}
