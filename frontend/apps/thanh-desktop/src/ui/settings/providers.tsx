import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { PROVIDER_PRESETS, providerStatus } from "../../acp/provider-presets";
import {
  deleteProvider,
  listProviders,
  providerPresets,
  type ProviderPreset,
  type ProviderSummary,
} from "../../acp/providers";
import { ProviderEditor, PresetGrid } from "./provider-form";
import { Dialog, DialogActions } from "../components/dialog";
import { EmptyState, ErrorState, LoadingState } from "../components/async-state";

/** Agent presets win; the bundled mirror keeps the cards usable offline. */
export function useProviderPresets() {
  const query = useQuery({
    queryKey: ["provider-presets"],
    queryFn: providerPresets,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
  const presets = query.data?.presets?.length ? query.data.presets : PROVIDER_PRESETS;
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

export function ProvidersPanel({ connected, onDirtyChange }: { connected: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const { presets } = useProviderPresets();
  const providers = useProviders(connected);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProviderPreset | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacementProvider, setReplacementProvider] = useState<ProviderSummary | null>(null);
  const [replacement, setReplacement] = useState("");
  const [replacementBusy, setReplacementBusy] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
  };
  const remove = useMutation({
    mutationFn: (provider: ProviderSummary) => deleteProvider(provider.id),
    onSuccess: () => {
      setNotice(null);
      refresh();
    },
    onError: (error, provider) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("would dangle")) {
        setReplacementProvider(provider);
        setReplacement("");
        setNotice(null);
      } else {
        setNotice(message);
      }
    },
  });

  async function confirmReplacement() {
    if (!replacementProvider || !replacement.trim()) return;
    setReplacementBusy(true);
    setNotice(null);
    try {
      await deleteProvider(replacementProvider.id, replacement.trim());
      setReplacementProvider(null);
      setReplacement("");
      refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacementBusy(false);
    }
  }

  const list = providers.data?.providers ?? [];
  const editingPreset = useMemo(
    () => (editing ? presets.find((preset) => preset.id === editing.id) ?? editing : null),
    [editing, presets],
  );

  return (
    <div className="providers-panel">
      {providers.isLoading && <LoadingState label="Loading providers" />}
      {providers.isError && <ErrorState label="Could not read providers from the agent." />}
      {list.length === 0 && !providers.isLoading && !providers.isError && !adding && !editingPreset && (
        <EmptyState label="No providers yet" detail="Add a provider to start a conversation." />
      )}
      <ul className="provider-list">
        {list.map((provider) => {
          const status = providerStatus(provider);
          return (
            <li key={provider.id} data-testid={`provider-row-${provider.id}`}>
              <div className="provider-row-main">
                <strong>{presets.find((preset) => preset.id === provider.id)?.label ?? provider.id}</strong>
                <small>{provider.baseUrl}</small>
                <span className={`badge ${status.tone}`}>
                  {status.tone === "ok" ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />} {status.label}
                  {provider.keyHint ? ` · ${provider.keyHint}` : ""}
                </span>
                {provider.models.length > 0 && <small>{provider.models.length} model(s): {provider.models.map((model) => model.id).join(", ")}</small>}
              </div>
              <div className="provider-row-actions">
                <button
                  className="ghost-button"
                  data-testid={`provider-edit-${provider.id}`}
                  onClick={() => {
                    setAdding(false);
                    setEditingProvider(provider);
                    onDirtyChange?.(true);
                    setEditing(presets.find((preset) => preset.id === provider.id) ?? { ...presets[presets.length - 1], id: provider.id });
                  }}
                >
                  Edit
                </button>
                <button className="ghost-button" data-testid={`provider-delete-${provider.id}`} onClick={() => remove.mutate(provider)}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {notice && <p className="settings-note security-warning">{notice}</p>}

      {(editingPreset || adding) && (
        <ProviderEditor
          preset={editingPreset ?? presets[presets.length - 1]}
          provider={editingProvider ?? undefined}
          onSaved={() => {
            setEditing(null);
            setEditingProvider(null);
            setAdding(false);
            onDirtyChange?.(false);
            refresh();
          }}
          onCancel={() => {
            setEditing(null);
            setEditingProvider(null);
            setAdding(false);
            onDirtyChange?.(false);
          }}
        />
      )}

      {!editingPreset && !adding && (
        <>
          <div className="settings-actions">
            <button className="primary-button" onClick={() => setAdding(true)} data-testid="provider-add">
              <Plus size={15} /> Add provider
            </button>
            <button className="ghost-button" onClick={() => void providers.refetch()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <PresetGrid
            presets={presets}
            onPick={(preset) => {
              setEditingProvider(null);
              setEditing(preset);
              onDirtyChange?.(true);
            }}
          />
        </>
      )}
      {replacementProvider && (
        <Dialog
          title="Choose a replacement model"
          description={`Removing ${replacementProvider.id} would remove its default model. Enter the model id to keep as the new default.`}
          onClose={() => setReplacementProvider(null)}
        >
          <label className="dialog-field">
            <span>Replacement model id</span>
            <input autoFocus value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="provider/model" />
          </label>
          {notice && <p className="field-error">{notice}</p>}
          <DialogActions>
            <button className="ghost-button" onClick={() => setReplacementProvider(null)} disabled={replacementBusy}>Cancel</button>
            <button className="primary-button" onClick={() => void confirmReplacement()} disabled={replacementBusy || !replacement.trim()}>{replacementBusy ? "Removing…" : "Remove provider"}</button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
