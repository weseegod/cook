/**
 * Read-only viewer for a background command's row (`views/tasks_pane.rs` `[view]`, `show_bg_task_viewer`
 * → block viewer): its captured stdout, in follow mode while it runs.
 *
 * A subagent is not a command — its `[view]` opens the child's own session instead, which ChatView
 * swaps in (`subagent-takeover.tsx`). Keeping the two apart is what stops a child's transcript from
 * being re-painted here in a reduced form.
 */
import { useEffect, useRef } from "react";
import { useActivityStore, isLive, type ActivityItem } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { Dialog } from "../components/dialog";
import { formatDuration } from "../chat/format-duration";
import { useNowTick } from "./activity-row";
import { useViewingRow } from "./use-activity-rows";

/** How often an open viewer re-reads the agent, so a running task's stdout keeps growing. */
const POLL_MS = 1500;

export function TaskViewer() {
  const row = useViewingRow();
  if (!row || row.kind !== "task") return null;
  return <TaskViewerContent key={`${row.kind}:${row.id}`} row={row} />;
}

function TaskViewerContent({ row }: { row: ActivityItem }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const clearViewing = useActivityStore((state) => state.clearViewing);
  const refreshFromAgent = useActivityStore((state) => state.refreshFromAgent);
  const body = useRef<HTMLPreElement>(null);
  const now = useNowTick();
  const elapsed = Math.max(0, (row.endedAt ?? now) - row.startedAt);
  const live = isLive(row.status);

  // The snapshot is the only live stdout channel the wire offers for a background command, and the
  // shell fills it from its own terminal while the task runs (`adapter.rs::list_tasks`).
  useEffect(() => {
    if (!sessionId || !live) return;
    void refreshFromAgent(sessionId);
    const timer = window.setInterval(() => void refreshFromAgent(sessionId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, live, refreshFromAgent]);

  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [row.output]);

  return (
    <Dialog
      title={row.name}
      description={
        <span className="task-viewer-meta" data-testid="task-viewer-meta">
          <span className={`task-viewer-status task-viewer-status-${row.status.toLowerCase()}`}>{row.status}</span>
          {` · ${formatDuration(elapsed)}`}
          {row.activityLabel && live && ` · ${row.activityLabel}`}
        </span>
      }
      onClose={clearViewing}
      closeKind="hide"
      closeLabel="Hide task"
      size="wide"
    >
      <div className="task-viewer" data-testid="task-viewer">
        {row.detail && <p className="task-viewer-command" data-testid="task-viewer-command">{row.detail}</p>}
        <pre className="task-viewer-output" data-testid="task-viewer-output" ref={body}>{row.output ?? ""}</pre>
        {!row.output && <p className="task-viewer-empty">{live ? "No output yet." : "No output."}</p>}
        {row.truncated && (
          <p className="task-viewer-note">
            Output is truncated{row.outputFile ? `; the full log is at ${row.outputFile}` : ""}.
          </p>
        )}
      </div>
    </Dialog>
  );
}
