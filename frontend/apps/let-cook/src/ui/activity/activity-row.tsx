/**
 * One task / subagent / loop / workflow row (`views/tasks_pane.rs`), shared by the Tools panel's
 * Activity tab and the header's tasks list so the two surfaces cannot drift.
 *
 * The row reads like the TUI's: the label, what the job is doing right now (` · {activity}`), the
 * live elapsed clock, then the pane's `[view]` (open the job's own output) and `[✕]` (stop it).
 * Clicking the row opens too — the TUI opens on a double-click because it only has a mouse, while
 * the desktop row is a single click.
 */
import { LoaderCircle, Maximize2, X } from "lucide-react";
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

/**
 * Whether the row has a `[view]` to open, the way the pane decides it: background tasks and
 * subagents always (`show_bg_task_viewer` / `open_subagent_fullscreen`); a workflow has none.
 */
export function canOpenTask(item: ActivityItem): boolean {
  return item.kind === "task" || item.kind === "subagent";
}

export function ActivityRowView({
  item,
  now,
  busy,
  onKill,
  onOpen,
  testIdPrefix,
}: {
  item: ActivityItem;
  now: number;
  busy: boolean;
  onKill: () => void;
  /** Omitted by a surface that does not host the viewer. */
  onOpen?: (item: ActivityItem) => void;
  /** Distinguishes this surface's test ids, e.g. `activity` in the tab and `task` in the strip. */
  testIdPrefix: string;
}) {
  const elapsed = Math.max(0, (item.endedAt ?? now) - item.startedAt);
  const live = isLive(item.status);
  // What the job is doing is a live statement: a settled row keeps its label in the store, so the
  // suffix is gated on the status. A workflow's phase is state, not churn, and reads on either.
  const suffix = (live ? item.activityLabel : undefined) ?? (item.kind === "workflow" ? item.detail : undefined);
  const detail = item.humanSchedule ?? (suffix === item.detail ? undefined : item.detail);
  const openable = Boolean(onOpen) && canOpenTask(item);

  return (
    <div
      className={`activity-row${openable ? " activity-row-openable" : ""}`}
      role="listitem"
      data-testid={`${testIdPrefix}-row-${item.id}`}
      data-kind={item.kind}
      data-status={item.status}
      onClick={openable ? () => onOpen?.(item) : undefined}
    >
      <div className="activity-row-main">
        {/* The label region shrinks and ellipsizes; the two controls beside it never do, so a
            narrow panel (the minimum window, the tasks popover) can never push them out of reach. */}
        <span className="activity-row-text">
          <span className="activity-kind">{kindLabel(item)}</span>
          <strong className="activity-name" title={item.name}>{item.name}</strong>
          {suffix && <span className="activity-doing" title={suffix}>· {suffix}</span>}
          <span className={`activity-status activity-status-${item.status.toLowerCase()}`}>{item.status}</span>
          <span className="activity-elapsed">{formatDuration(elapsed)}</span>
        </span>
        {openable && (
          <button
            type="button"
            className="icon-button activity-open"
            onClick={(event) => {
              event.stopPropagation();
              onOpen?.(item);
            }}
            aria-label={`Open ${item.name}`}
            title="Open"
            data-testid={`${testIdPrefix}-open-${item.id}`}
          >
            <Maximize2 size={12} />
          </button>
        )}
        {live ? (
          <button
            type="button"
            className="icon-button activity-kill"
            onClick={(event) => {
              event.stopPropagation();
              onKill();
            }}
            disabled={busy}
            aria-label={`Close ${item.name}`}
            title="Close"
            data-testid={`${testIdPrefix}-kill-${item.id}`}
          >
            {busy ? <LoaderCircle size={12} className="spin" /> : <X size={12} />}
          </button>
        ) : (
          <span className="activity-kill-spacer" aria-hidden><X size={12} /></span>
        )}
      </div>
      {detail && <div className="activity-row-detail">{detail}</div>}
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
