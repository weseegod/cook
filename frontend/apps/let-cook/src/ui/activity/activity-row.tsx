/**
 * One task / subagent / loop / workflow row (`views/tasks_pane.rs`), shared by the Tools panel's
 * Activity tab and the header's tasks list so the two surfaces cannot drift. A live row carries
 * the ✕ that closes it; a settled row leaves the slot empty but keeps the column.
 */
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isLive, type ActivityItem } from "../../state/activity";
import { formatDuration } from "../chat/format-duration";

/** Elapsed clocks stay live while a row is on screen. */
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function ActivityRowView({
  item,
  now,
  busy,
  onKill,
  testIdPrefix,
}: {
  item: ActivityItem;
  now: number;
  busy: boolean;
  onKill: () => void;
  /** Distinguishes this surface's test ids, e.g. `activity` in the tab and `task` in the strip. */
  testIdPrefix: string;
}) {
  const elapsed = Math.max(0, (item.endedAt ?? now) - item.startedAt);
  const live = isLive(item.status);
  return (
    <div className="activity-row" role="listitem" data-testid={`${testIdPrefix}-row-${item.id}`} data-kind={item.kind} data-status={item.status}>
      <div className="activity-row-main">
        <span className="activity-kind">{kindLabel(item)}</span>
        <strong className="activity-name" title={item.name}>{item.name}</strong>
        <span className={`activity-status activity-status-${item.status.toLowerCase()}`}>{item.status}</span>
        <span className="activity-elapsed">{formatDuration(elapsed)}</span>
        {live && (
          <button
            type="button"
            className="icon-button activity-kill"
            onClick={onKill}
            disabled={busy}
            aria-label={`Close ${item.name}`}
            title="Close"
            data-testid={`${testIdPrefix}-kill-${item.id}`}
          >
            {busy ? <LoaderCircle size={12} className="spin" /> : <X size={12} />}
          </button>
        )}
        {!live && <span className="activity-kill-spacer" aria-hidden><X size={12} /></span>}
      </div>
      {(item.detail || item.humanSchedule) && (
        <div className="activity-row-detail">{item.humanSchedule ?? item.detail}</div>
      )}
    </div>
  );
}

export function kindLabel(item: ActivityItem): string {
  if (item.isMonitor) return "Monitor";
  switch (item.kind) {
    case "task":
      return "Task";
    case "subagent":
      return "Agent";
    case "schedule":
      return "Loop";
    case "workflow":
      return "Flow";
    default:
      return "Item";
  }
}
