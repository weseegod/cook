import { LoaderCircle, Trash2 } from "lucide-react";
import type { ProviderSummary } from "../../../acp/providers";
import type { ModelSummary } from "../../../acp/xai";
import { Dialog, DialogActions } from "../../components/dialog";
import type { ProviderRow } from "./provider-rows";

interface RemoveProviderDialogProps {
  row: ProviderRow;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RemoveProviderDialog({ row, pending, onClose, onConfirm }: RemoveProviderDialogProps) {
  return (
    <Dialog
      title={`Remove ${row.provider?.name ?? row.preset.label}?`}
      tone="danger"
      size="sm"
      description="This deletes config, not just the saved key."
      onClose={onClose}
    >
      <p className="dialog-note">
        <code>[model_providers.{row.preset.id}]</code> and every model below are
        removed from <code>~/.cook/config.toml</code>. The credential goes with them, and chat
        can no longer use these models.
      </p>
      {row.models.length > 0 && (
        <ul className="dialog-model-chips">
          {row.models.map((model) => <li key={model.id}><code>{model.id}</code></li>)}
        </ul>
      )}
      <DialogActions>
        <button className="ghost-button" onClick={onClose} disabled={pending}>Cancel</button>
        <button
          className="danger-button"
          data-testid="provider-remove-confirm"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove provider
        </button>
      </DialogActions>
    </Dialog>
  );
}

interface RemoveModelDialogProps {
  model: ModelSummary;
  selected: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RemoveModelDialog({ model, selected, pending, onClose, onConfirm }: RemoveModelDialogProps) {
  return (
    <Dialog
      title={`Remove ${model.name ?? model.id}?`}
      tone="danger"
      size="sm"
      description={`[model."${model.id}"] is deleted from ~/.cook/config.toml.`}
      onClose={onClose}
    >
      {selected && (
        <p className="dialog-note">This model is currently selected; choose another model first.</p>
      )}
      <DialogActions>
        <button className="ghost-button" onClick={onClose} disabled={pending}>Cancel</button>
        <button
          className="danger-button"
          data-testid="model-remove-confirm"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove model
        </button>
      </DialogActions>
    </Dialog>
  );
}

interface ReplacementModelDialogProps {
  provider: ProviderSummary;
  modelId: string;
  choices: ModelSummary[];
  pending: boolean;
  onChange: (modelId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function ReplacementModelDialog({
  provider,
  modelId,
  choices,
  pending,
  onChange,
  onClose,
  onConfirm,
}: ReplacementModelDialogProps) {
  return (
    <Dialog
      title="Choose a replacement model"
      tone="warning"
      description={`${provider.name ?? provider.id} owns the currently selected model, so removing it needs a replacement.`}
      onClose={onClose}
    >
      {choices.length > 0 ? (
        <label className="dialog-field">
          <span>Replacement model</span>
          <select
            autoFocus
            value={modelId}
            aria-label="Replacement model"
            data-testid="replacement-model"
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Select a model…</option>
            {choices.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
          </select>
        </label>
      ) : (
        <p className="dialog-note">Add a model on another provider first, then remove this one.</p>
      )}
      <DialogActions>
        <button className="ghost-button" onClick={onClose} disabled={pending}>Cancel</button>
        <button
          className="danger-button"
          disabled={!modelId || pending}
          onClick={onConfirm}
        >
          {pending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Remove provider
        </button>
      </DialogActions>
    </Dialog>
  );
}
