import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

type DialogTone = "neutral" | "danger" | "warning";

/**
 * The one in-app dialog shell: a heading row, a scrollable body, and the caller's actions.
 *
 * `tone` only adds a coloured marker for the cases that need one (deleting, warnings). Plain
 * forms stay quiet instead of every dialog announcing itself with the same warning triangle.
 */
export function Dialog({
  title,
  description,
  children,
  onClose,
  labelledBy,
  tone = "neutral",
  size = "sm",
  icon,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
  tone?: DialogTone;
  /** `wide` gives long forms room; the default fits a confirm. */
  size?: "sm" | "wide";
  icon?: ReactNode;
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

  const titleId = labelledBy ?? "dialog-title";
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className={`dialog dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          {tone !== "neutral" && (
            <div className={`dialog-tone ${tone}`}>
              {icon ?? <AlertTriangle size={15} />}
            </div>
          )}
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button dialog-close" onClick={onClose} aria-label="Close dialog"><X size={16} /></button>
        </header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="dialog-actions">{children}</div>;
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
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={title}
      description={description}
      tone={danger ? "danger" : "neutral"}
      onClose={onCancel}
    >
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
