import { History, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { acpClient } from "../../acp/client";
import { executeRewind, listRewindPoints, type RewindPoint } from "../../acp/session-ops";
import { useSessionStore } from "../../state/session";
import { Dialog, DialogActions } from "../components/dialog";

/**
 * `/rewind` picker: list `x.ai/rewind/points`, execute, then `session/load` to replay the live timeline.
 */
export function RewindDialog() {
  const open = useSessionStore((state) => state.rewindDialogOpen);
  const sessionId = useSessionStore((state) => state.sessionId);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const setOpen = useSessionStore((state) => state.setRewindDialogOpen);

  const [points, setPoints] = useState<RewindPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!open) return;
    if (!sessionId) {
      setError("Start a conversation before rewinding.");
      setPoints([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(0);
    void listRewindPoints(sessionId)
      .then((next) => {
        if (cancelled) return;
        setPoints(next);
        if (next.length === 0) setError("No rewind points yet. Send a prompt first.");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  if (!open) return null;

  async function rewindTo(point: RewindPoint) {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (turnRunning) await acpClient.cancel();
      const result = await executeRewind({
        sessionId,
        targetPromptIndex: point.promptIndex,
        force: turnRunning,
      });
      if (!result.success) {
        setError(result.error ?? "Rewind failed.");
        return;
      }
      await acpClient.loadSession(sessionId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Rewind"
      description="Pick a turn to restore. Later prompts are discarded from the live timeline."
      onClose={() => !busy && setOpen(false)}
      size="wide"
      labelledBy="rewind-dialog-title"
    >
      {loading ? (
        <p className="dialog-note" data-testid="rewind-loading">
          <LoaderCircle size={14} className="spin" /> Loading rewind points…
        </p>
      ) : error && points.length === 0 ? (
        <p className="field-error" role="alert">{error}</p>
      ) : (
        <>
          {error && <p className="field-error" role="alert">{error}</p>}
          <ul className="rewind-point-list" role="listbox" data-testid="rewind-point-list">
            {points.map((point, index) => (
              <li key={point.promptIndex}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={index === selected ? "active" : ""}
                  disabled={busy}
                  data-testid={`rewind-point-${point.promptIndex}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => void rewindTo(point)}
                >
                  <History size={14} aria-hidden="true" />
                  <span className="rewind-point-body">
                    <strong>Turn {point.promptIndex + 1}</strong>
                    <em>{point.promptPreview?.trim() || "Untitled prompt"}</em>
                    {point.hasFileChanges && <span className="rewind-point-meta">has file snapshots</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <DialogActions>
        <button type="button" className="ghost-button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </DialogActions>
    </Dialog>
  );
}
