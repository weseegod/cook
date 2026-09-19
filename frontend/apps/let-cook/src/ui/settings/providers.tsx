import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PROVIDER_PRESETS } from "../../acp/provider-presets";
import { normalizeError } from "../../acp/errors";
import {
  deleteProvider,
  deleteModel,
  type ProviderPreset,
  type ProviderSummary,
} from "../../acp/providers";
import { acpClient } from "../../acp/client";
import type { ModelSummary } from "../../acp/xai";
import { PresetGrid, ProviderEditor } from "./provider-form";
import { ModelDialog } from "./model-dialog";
import { Dialog } from "../components/dialog";
import { LoadingState } from "../components/async-state";
import { ProviderCard } from "./providers/provider-card";
import { RemoveModelDialog, RemoveProviderDialog, ReplacementModelDialog } from "./providers/provider-dialogs";
import { modelFromLink, type ProviderRow } from "./providers/provider-rows";
import { useAuthInfo, useProviderPresets, useProviders } from "./providers/use-provider-queries";

export { useProviderPresets, useProviders };

export function ProvidersPanel({
  connected,
  models,
  selectedModel,
  onDirtyChange,
}: {
  connected: boolean;
  models: ModelSummary[];
  selectedModel: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { presets, isFetching: presetsFetching } = useProviderPresets();
  const providers = useProviders(connected);
  const auth = useAuthInfo(connected);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProviderPreset | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [modelTarget, setModelTarget] = useState<{ provider: ProviderSummary; model?: ModelSummary } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderRow | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelSummary | null>(null);
  const [replacement, setReplacement] = useState<{ provider: ProviderSummary; modelId: string } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Models arrive via a host call react-query does not track. Track that refresh so the panel
  // still shows a spinner when the providers query is already warm from the app shell.
  useEffect(() => {
    if (!connected) {
      setCatalogLoading(false);
      return;
    }
    let cancelled = false;
    setCatalogLoading(true);
    void acpClient.refreshModels()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    setCatalogLoading(true);
    void Promise.all([providers.refetch(), acpClient.refreshModels()])
      .catch(() => undefined)
      .finally(() => setCatalogLoading(false));
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
      const message = normalizeError(error, "Could not save the provider");
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
    onError: (error) => setNotice(normalizeError(error, "Could not load providers")),
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

  const modelsBusy = catalogLoading || presetsFetching || providers.isFetching;
  const hasAnyModels = rows.some((row) => row.models.length > 0);
  // Hide the preset shells while the first catalog load is in flight — otherwise the panel
  // looks empty/laggy with "none configured" on every card.
  const blockModels = modelsBusy && !hasAnyModels;

  return (
    <div className="providers-panel unified-provider-panel">
      <div className="provider-catalog-toolbar">
        <div className="settings-actions">
          <button className="primary-button" onClick={() => { setAdding(true); setNotice(null); }} data-testid="provider-add">
            <Plus size={15} /> Add provider
          </button>
          <button className="ghost-button" onClick={() => void refresh()} disabled={modelsBusy}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {notice && <div className="settings-note security-warning" data-testid="provider-notice" role="alert">{notice}</div>}
      {blockModels ? (
        <LoadingState label="Loading models and providers" />
      ) : (
        <>
          {modelsBusy && <LoadingState label={hasAnyModels ? "Refreshing models and providers" : "Loading models and providers"} />}
          <div className="provider-model-list">
            {rows.map((row) => (
              <ProviderCard
                key={row.preset.id}
                row={row}
                selectedModel={selectedModel}
                onAddModel={() => { setNotice(null); setModelTarget({ provider: row.provider! }); }}
                onEdit={() => openEditor(row.preset, row.provider)}
                onRemove={() => { setNotice(null); setDeletingProvider(row); }}
                onEditModel={(model) => { if (row.provider) setModelTarget({ provider: row.provider, model }); }}
                onRemoveModel={(model) => { setNotice(null); setDeletingModel(model); }}
              />
            ))}
          </div>
        </>
      )}

      {deletingProvider && (
        <RemoveProviderDialog
          row={deletingProvider}
          pending={removeProvider.isPending}
          onClose={() => setDeletingProvider(null)}
          onConfirm={() => removeProvider.mutate({ provider: deletingProvider.provider! })}
        />
      )}

      {deletingModel && (
        <RemoveModelDialog
          model={deletingModel}
          selected={deletingModel.id === selectedModel}
          pending={removeModel.isPending}
          onClose={() => setDeletingModel(null)}
          onConfirm={() => removeModel.mutate(deletingModel)}
        />
      )}

      {replacement && (
        <ReplacementModelDialog
          provider={replacement.provider}
          modelId={replacement.modelId}
          choices={replacementChoices}
          pending={removeProvider.isPending}
          onChange={(modelId) => setReplacement((current) => current && { ...current, modelId })}
          onClose={() => setReplacement(null)}
          onConfirm={() => removeProvider.mutate({ provider: replacement.provider, replacement: replacement.modelId })}
        />
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
