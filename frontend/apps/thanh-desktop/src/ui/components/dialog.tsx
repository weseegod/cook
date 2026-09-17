import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export function Dialog({
  title,
  description,
  children,
  onClose,
  labelledBy,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? "dialog-title"}>
        <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={17} /></button>
        <div className="dialog-icon"><AlertTriangle size={18} /></div>
        <h2 id={labelledBy ?? "dialog-title"}>{title}</h2>
        {description && <p>{description}</p>}
        {children}
      </section>
    </div>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="modal-actions">{children}</div>;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={title} description={description} onClose={onCancel}>
      {error && <p className="field-error" role="alert">{error}</p>}
      <DialogActions>
        <button className="ghost-button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button className={danger ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : <><Check size={15} /> {confirmLabel}</>}
        </button>
      </DialogActions>
    </Dialog>
  );
}
