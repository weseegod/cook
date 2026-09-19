import { useEffect, useState, type RefObject } from "react";
import { activeRows, useActivityStore, type ActivityItem } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { ActivityList } from "./activity-list";
import { useNowTick } from "./activity-row";
import { useConversationRows } from "./use-activity-rows";

/**
 * The conversation's background work, as a popover under the header's `Tasks` chip — the same
 * shape as the plans list beside it (`views/tasks_pane.rs`, catalog §9.9).
 *
 * Rows are the conversation's background commands, subagents, loops and workflows: the same ones
 * the Tools panel's Activity tab lists, each with its live elapsed time and stop control. Only
 * running work is listed — a finished job drops off the list the moment it settles.
 */
export function TasksMenu({ menuRef }: { menuRef: RefObject<HTMLDivElement | null> }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const rows = useConversationRows();
  const lastError = useActivityStore((state) => state.lastError);
  const refreshFromAgent = useActivityStore((state) => state.refreshFromAgent);
  const killActivity = useActivityStore((state) => state.killActivity);
  const now = useNowTick();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Opening the list is the moment to reconcile with the agent: notifications that arrived while
  // the window was away (or reloaded) never reached the store.
  useEffect(() => {
    if (sessionId) void refreshFromAgent(sessionId);
  }, [sessionId, refreshFromAgent]);

  const visible = activeRows(rows);

  async function onKill(item: ActivityItem) {
    if (!sessionId) return;
    setBusyId(item.id);
    try {
      await killActivity(sessionId, item);
    } catch {
      // lastError is set on the store
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      ref={menuRef}
      className="tasks-menu"
      role="dialog"
      aria-label="Background tasks"
      data-testid="tasks-menu"
    >
      {lastError && <div className="utility-state utility-state-error" role="alert">{lastError}</div>}
      {rows.length === 0 && <div className="utility-state">No background tasks or subagents.</div>}
      {rows.length > 0 && visible.length === 0 && <div className="utility-state">No running tasks.</div>}
      {visible.length > 0 && (
        <ActivityList
          rows={visible}
          now={now}
          busyId={busyId}
          onKill={(item) => void onKill(item)}
          testIdPrefix="task"
          label="Background tasks"
        />
      )}
    </div>
  );
}
