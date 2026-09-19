import { Pencil } from "lucide-react";
import type { SessionSummary } from "../../../acp/xai";
import { ConfirmDialog, Dialog, DialogActions } from "../../components/dialog";

interface RenameDialogProps {
  target: SessionSummary;
  value: string;
  error: string | null;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function RenameConversationDialog({ target, value, error, busy, onChange, onClose, onConfirm }: RenameDialogProps) {
  return (
    <Dialog title="Rename conversation" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <label className="dialog-field">
          <span>Conversation name</span>
          <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} aria-label="Conversation name" />
        </label>
        {error && <p className="field-error">{error}</p>}
        <DialogActions>
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}><Pencil size={15} /> {busy ? "Saving…" : "Rename"}</button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

interface DeleteDialogProps {
  target: SessionSummary;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteConversationDialog({ target, error, busy, onClose, onConfirm }: DeleteDialogProps) {
  return (
    <ConfirmDialog
      title="Delete conversation?"
      description={`“${target.title ?? "Untitled conversation"}” will be permanently deleted.`}
      confirmLabel="Delete conversation"
      danger
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
