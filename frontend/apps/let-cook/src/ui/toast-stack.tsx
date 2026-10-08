import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";
import { useSessionStore, type Toast } from "../state/session";

/** How long a message that needs no answer stays on screen. */
export const TOAST_DISMISS_MS = 5_000;

const TONE_ICON = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

/**
 * The window's right-side message stack. A message that names a conversation offers to open it,
 * which is how a turn that finished elsewhere reaches the user without painting that turn's
 * transcript over the conversation they are reading.
 */
export function ToastStack({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const toasts = useSessionStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" data-testid="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onOpenSession={onOpenSession} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onOpenSession }: { toast: Toast; onOpenSession: (sessionId: string) => void }) {
  const activeSessionId = useSessionStore((state) => state.sessionId);
  const Icon = TONE_ICON[toast.tone];
  const openable = Boolean(toast.sessionId) && toast.sessionId !== activeSessionId;

  useEffect(() => {
    if (toast.sticky) return;
    const timer = window.setTimeout(() => useSessionStore.getState().dismissToast(toast.id), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.sticky]);

  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : undefined}>
      <Icon size={14} aria-hidden="true" />
      <div className="toast-copy">
        <strong>{toast.title}</strong>
        {toast.body && <span>{toast.body}</span>}
      </div>
      {openable && (
        <button
          type="button"
          className="toast-open"
          onClick={() => {
            const sessionId = toast.sessionId;
            if (!sessionId) return;
            useSessionStore.getState().dismissToast(toast.id);
            onOpenSession(sessionId);
          }}
        >
          Open
        </button>
      )}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss message"
        onClick={() => useSessionStore.getState().dismissToast(toast.id)}
      >
        <X size={13} />
      </button>
    </div>
  );
}
