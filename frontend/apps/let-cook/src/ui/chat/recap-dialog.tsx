import { BookOpen, LoaderCircle } from "lucide-react";
import { useSessionStore } from "../../state/session";
import { Dialog, DialogActions } from "../components/dialog";

/**
 * `/recap` result surface. Generation is fire-and-forget over `x.ai/recap`; the summary
 * arrives as `session_recap` (or `session_recap_unavailable`) on the session store.
 */
export function RecapDialog() {
  const open = useSessionStore((state) => state.recapDialogOpen);
  const status = useSessionStore((state) => state.recapStatus);
  const summary = useSessionStore((state) => state.recapSummary);
  const error = useSessionStore((state) => state.recapError);
  const close = useSessionStore((state) => state.closeRecapDialog);

  if (!open) return null;

  return (
    <Dialog
      title="Recap"
      description="Where was I — a short summary of this session so far."
      onClose={close}
      size="wide"
      labelledBy="recap-dialog-title"
    >
      {status === "loading" && (
        <p className="dialog-note" data-testid="recap-loading">
          <LoaderCircle size={14} className="spin" /> Generating recap…
        </p>
      )}
      {status === "ready" && (
        <div className="recap-body" data-testid="recap-summary">
          <BookOpen size={15} aria-hidden="true" />
          <p>{summary?.trim() || "Empty recap."}</p>
        </div>
      )}
      {status === "unavailable" && (
        <p className="dialog-note" data-testid="recap-unavailable">
          Nothing to recap yet. Send a few turns, then try again.
        </p>
      )}
      {status === "error" && (
        <p className="field-error" role="alert" data-testid="recap-error">{error ?? "Recap failed."}</p>
      )}
      <DialogActions>
        <button type="button" className="primary-button" onClick={close}>
          Close
        </button>
      </DialogActions>
    </Dialog>
  );
}
