import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { findPreset, isOauthProvider } from "../../acp/provider-presets";
import { logoutProviderOauth } from "../../acp/provider-oauth";
import { normalizeError } from "../../acp/errors";
import {
  deleteProvider,
  deleteModel,
  type ProviderPreset,
  type ProviderSummary,
} from "../../acp/providers";
import { acpClient } from "../../acp/client";
import type { ModelSummary } from "../../acp/xai";
import { ProviderEditor } from "./provider-form";
import { ModelDialog } from "./model-dialog";
import { Dialog } from "../components/dialog";
import { LoadingState } from "../components/async-state";
import { OauthDialog } from "./providers/oauth-dialog";
import { ProviderCard } from "./providers/provider-card";
import { RemoveModelDialog, RemoveProviderDialog, ReplacementModelDialog } from "./providers/provider-dialogs";
import { buildProviderRows, isXaiOauthSignedIn, type ProviderRow } from "./providers/provider-rows";
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
  const [modelTarget, setModelTarget] = useState<{
    provider: { id: string; name?: string | null };
    canDiscoverModels: boolean;
    grokOauth: boolean;
    model?: ModelSummary;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderRow | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelSummary | null>(null);
  const [replacement, setReplacement] = useState<{ provider: ProviderSummary; modelId: string } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [oauthPreset, setOauthPreset] = useState<ProviderPreset | null>(null);

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
  const rows = useMemo<ProviderRow[]>(() => buildProviderRows({
    presets,
    providers: list,
    explicitModels: providers.data?.models ?? [],
    catalog: models,
    selectedModel,
    hiddenIds: providers.data?.hiddenProviders ?? [],
    xaiAuthenticated: isXaiOauthSignedIn(auth.data?.methodId, auth.data?.email),
    xaiEmail: auth.data?.email,
  }), [auth.data?.email, auth.data?.methodId, list, models, presets, providers.data?.hiddenProviders, providers.data?.models, selectedModel]);

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
    setOauthPreset(null);
    setEditingProvider(provider ?? null);
    setEditing(preset);
    onDirtyChange?.(true);
  }

  function openConnect(preset: ProviderPreset, provider?: ProviderSummary) {
    setNotice(null);
    const keyed = Boolean(
      provider?.oauth || provider?.inlineKey || (provider?.hasKey && provider.envKeyPresent),
    );
    if (isOauthProvider(preset.id) && !keyed) {
      setOauthPreset(preset);
      return;
    }
    openEditor(preset, provider);
  }

  async function signOut(preset: ProviderPreset) {
    setNotice(null);
    try {
      await logoutProviderOauth(preset.id);
      void queryClient.invalidateQueries({ queryKey: ["auth-info"] });
      refresh();
    } catch (error) {
      setNotice(normalizeError(error, "Could not sign out"));
    }
  }

  function openModelTarget(row: ProviderRow, model?: ModelSummary) {
    const provider = row.provider ?? (row.preset.id === "xai" ? { id: "xai", name: row.preset.label } : null);
    if (!provider) return;
    setNotice(null);
    setModelTarget({
      provider,
      canDiscoverModels: Boolean(row.provider) || row.preset.id === "xai",
      grokOauth: row.preset.id === "xai" && row.oauthConnected,
      ...(model ? { model } : {}),
    });
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
                canAddModel={Boolean(row.provider || (row.preset.id === "xai" && row.oauthConnected))}
                onAddModel={() => openModelTarget(row)}
                onEdit={() => openEditor(row.preset, row.provider)}
                onConnect={() => openConnect(row.preset, row.provider)}
                onSignOut={row.oauthConnected ? () => void signOut(row.preset) : undefined}
                onRemove={() => { setNotice(null); setDeletingProvider(row); }}
                onEditModel={(model) => openModelTarget(row, model)}
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
          onConfirm={() => removeProvider.mutate({
            provider: deletingProvider.provider ?? {
              id: deletingProvider.preset.id,
              name: deletingProvider.preset.label,
              hasKey: false,
              inlineKey: false,
              envKeyPresent: false,
              extraHeaders: {},
              models: [],
            },
          })}
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
          canDiscoverModels={modelTarget.canDiscoverModels}
          grokOauth={modelTarget.grokOauth}
          model={modelTarget.model}
          existingIds={rows.find((row) => row.preset.id === modelTarget.provider.id)?.models.map((model) => model.id) ?? []}
          onSaved={() => { setModelTarget(null); refresh(); }}
          onClose={() => setModelTarget(null)}
        />
      )}

      {oauthPreset && (
        <OauthDialog
          preset={oauthPreset}
          onClose={() => setOauthPreset(null)}
          onConnected={() => {
            setOauthPreset(null);
            void queryClient.invalidateQueries({ queryKey: ["auth-info"] });
            refresh();
          }}
          onUseApiKey={() => openEditor(oauthPreset)}
        />
      )}

      {adding && !editing && findPreset("custom") && (
        <Dialog
          title="Add provider"
          description="Name a custom endpoint and point Cook at its API."
          size="wide"
          onClose={() => setAdding(false)}
        >
          <ProviderEditor
            preset={findPreset("custom")!}
            variant="connection"
            createCustom
            existingIds={list.map((provider) => provider.id)}
            onSaved={() => {
              setAdding(false);
              refresh();
            }}
            onCancel={() => setAdding(false)}
          />
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
