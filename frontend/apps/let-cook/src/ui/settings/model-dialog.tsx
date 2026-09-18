import { Check, Download, LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ModelSummary } from "../../acp/xai";
import { normalizeError } from "../../acp/errors";
import { probeProviderModels, upsertModel, type ProviderSummary } from "../../acp/providers";
import { Dialog, DialogActions } from "../components/dialog";
import { ToggleSwitch } from "../components/toggle-switch";

/** The panel's baseline for a hand-added model: generous context, a conservative output. */
export const SUGGESTED_CONTEXT = 300_000;
export const SUGGESTED_OUTPUT = 64_000;
/** How many unconfigured models the provider's own `/models` offers as quick picks. */
const CANDIDATE_LIMIT = 5;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]+$/;

/**
 * Limits to start from: the baseline above, never above what the endpoint said the model takes.
 * A model that declares a smaller context window than the baseline gets its own value.
 */
export function suggestedLimits(model?: { contextWindow?: number | null; maxCompletionTokens?: number | null }) {
  return {
    contextWindow: model?.contextWindow ? Math.min(SUGGESTED_CONTEXT, model.contextWindow) : SUGGESTED_CONTEXT,
    maxCompletionTokens: model?.maxCompletionTokens ?? SUGGESTED_OUTPUT,
  };
}

interface Candidate {
  id: string;
  name?: string | null;
  contextWindow?: number;
  maxCompletionTokens?: number;
}

/**
 * Add or edit one model of a provider.
 *
 * The id is the `[model.<id>]` key in `config.toml`, so editing keeps it fixed; changing it would
 * add a second row rather than rename the first.
 */
export function ModelDialog({
  provider,
  existingIds,
  model,
  onSaved,
  onClose,
}: {
  provider: ProviderSummary;
  /** Every id already configured for this provider, so a quick pick is never a duplicate. */
  existingIds: string[];
  /** Present when editing an already-configured model. */
  model?: ModelSummary;
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = Boolean(model);
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [limits, setLimits] = useState(() =>
    suggestedLimits({
      contextWindow: model?.contextWindow,
      maxCompletionTokens: model?.maxCompletionTokens,
    }),
  );
  const [text, setText] = useState(model?.inputModalities?.includes("text") ?? true);
  const [image, setImage] = useState(model?.inputModalities?.includes("image") ?? false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanId = id.trim();
  const duplicate = !editing && existingIds.includes(cleanId);
  const canSave = cleanId.length > 0 && MODEL_ID.test(cleanId) && !duplicate && (text || image) && limits.contextWindow > 0 && limits.maxCompletionTokens > 0;

  async function loadCandidates() {
    setProbing(true);
    setError(null);
    try {
      const result = await probeProviderModels(provider.id);
      if (!result.ok) {
        setCandidates([]);
        setError(normalizeError(result.error, `${provider.name ?? provider.id} did not list any models`));
        return;
      }
      const known = new Set(existingIds);
      setCandidates(result.models.filter((entry) => !known.has(entry.id)).slice(0, CANDIDATE_LIMIT));
    } catch (caught) {
      setCandidates([]);
      setError(normalizeError(caught, "Could not load provider models"));
    } finally {
      setProbing(false);
    }
  }

  function pick(candidate: Candidate) {
    setId(candidate.id);
    setName(candidate.name ?? candidate.id);
    setLimits(suggestedLimits(candidate));
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const input = [...(text ? ["text"] : []), ...(image ? ["image"] : [])];
      await upsertModel({
        id: cleanId,
        model: model?.apiModel ?? cleanId,
        providerId: provider.id,
        name: name.trim() || cleanId,
        input,
        contextWindow: limits.contextWindow,
        maxCompletionTokens: limits.maxCompletionTokens,
      });
      onSaved();
    } catch (caught) {
      setError(normalizeError(caught, "Could not save the model"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing ? `Edit ${model?.name ?? model?.id}` : `Add model to ${provider.name ?? provider.id}`}
      description={editing
        ? "Saved to ~/.cook/config.toml and used by the agent after its config refresh."
        : `Pick an id from ${provider.name ?? provider.id}, or type one. Saved to ~/.cook/config.toml.`}
      size="wide"
      onClose={onClose}
    >
      <form
        className="model-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave && !busy) void save();
        }}
      >
        {editing ? (
          <div className="field model-dialog-fixed-id">
            <span>Model ID</span>
            <code>{model?.id}</code>
          </div>
        ) : (
          <div className="model-dialog-id">
            <label className="field">
              <span>Model ID</span>
              <input
                autoFocus
                value={id}
                aria-label={`Model ID for ${provider.id}`}
                placeholder="provider-model"
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <button type="button" className="ghost-button" disabled={probing} onClick={() => void loadCandidates()} data-testid="model-get-models">
              {probing ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} Get models
            </button>
          </div>
        )}

        {!editing && candidates !== null && (
          <div className="model-candidates" data-testid="model-candidates">
            {candidates.length > 0 ? (
              <>
                <span className="model-candidates-label"><Sparkles size={13} /> {provider.name ?? provider.id} offers {candidates.length} model{candidates.length === 1 ? "" : "s"} you have not added</span>
                <div className="model-candidate-list">
                  {candidates.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      className={candidate.id === cleanId ? "selected" : ""}
                      onClick={() => pick(candidate)}
                    >
                      <strong>{candidate.name ?? candidate.id}</strong>
                      <code>{candidate.id}</code>
                      <small>{candidate.contextWindow ? `Context ${candidate.contextWindow.toLocaleString()}` : "Context unknown"}</small>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="model-candidates-empty" data-testid="model-candidates-empty">
                Every model this provider lists is already configured. Type an id instead.
              </p>
            )}
          </div>
        )}

        <label className="field">
          <span>Display name</span>
          <input value={name} aria-label="Model display name" placeholder={cleanId || "Friendly model name"} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="model-dialog-limits">
          <label className="field">
            <span>Context window</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label="Model context window"
              value={limits.contextWindow}
              onChange={(event) => setLimits((current) => ({ ...current, contextWindow: Number(event.target.value) }))}
            />
          </label>
          <label className="field">
            <span>Max output tokens</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label="Model output limit"
              value={limits.maxCompletionTokens}
              onChange={(event) => setLimits((current) => ({ ...current, maxCompletionTokens: Number(event.target.value) }))}
            />
          </label>
        </div>
        <div className="model-dialog-input">
          <div className="toggle-row">
            <span><strong>Text input</strong></span>
            <ToggleSwitch checked={text} ariaLabel="Text" onChange={setText} />
          </div>
          <div className="toggle-row">
            <span><strong>Image input</strong></span>
            <ToggleSwitch checked={image} ariaLabel="Image" onChange={setImage} />
          </div>
        </div>

        {duplicate && <p className="field-error">{cleanId} is already configured for this provider.</p>}
        {error && <div className="settings-note security-warning" data-testid="model-error">{error}</div>}

        <DialogActions>
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!canSave || busy} data-testid="model-save">
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {editing ? "Save model" : "Add model"}
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
