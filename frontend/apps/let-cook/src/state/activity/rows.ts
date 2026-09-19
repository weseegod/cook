import { useActivityStore } from "./store";
import { TERMINAL_WORKFLOW_STATUSES, isLive } from "./status";
import type { ActivityItem, ActivityRowsSource } from "./types";

export function activityRows(state: ActivityRowsSource = useActivityStore.getState()): ActivityItem[] {
  const rows = [
    ...Object.values(state.tasks),
    ...Object.values(state.subagents),
    ...Object.values(state.schedules),
    ...Object.values(state.workflows),
  ];
  return rows.sort((a, b) => {
    const aLive = isLive(a.status) ? 0 : 1;
    const bLive = isLive(b.status) ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return b.startedAt - a.startedAt;
  });
}

/**
 * The rows one conversation owns: what the header chip and the tasks strip list. A row with no
 * owner (flat payload, no envelope session) belongs to whatever conversation is open.
 */
export function conversationRows(
  sessionId: string | null,
  state: ActivityRowsSource = useActivityStore.getState(),
): ActivityItem[] {
  if (!sessionId) return [];
  return activityRows(state).filter((row) => row.sessionId === undefined || row.sessionId === sessionId);
}

/** Rows still in flight — the count the header chip carries (`tasks_pane::status_counts`). */
export function runningCount(rows: readonly ActivityItem[]): number {
  return rows.filter((row) => isLive(row.status)).length;
}

/**
 * The subagent a session id belongs to. A child runs its own ACP session, so `session/update`
 * from that id is the only stream that says what the child is doing (`tasks_pane.rs` row `·`
 * suffix, `app/subagent.rs::format_activity_label`).
 */
export function rowForChildSession(
  childSessionId: string,
  state: ActivityRowsSource = useActivityStore.getState(),
): ActivityItem | null {
  return Object.values(state.subagents).find((row) => row.childSessionId === childSessionId) ?? null;
}

/** A workflow parked mid-run: not working now, but not finished either. */
export function isParked(row: ActivityItem): boolean {
  return row.kind === "workflow" && !isLive(row.status) && !TERMINAL_WORKFLOW_STATUSES.has(row.status.toLowerCase());
}

/** Workflows parked mid-run — the TUI chip's `P N` (`tasks_pane::status_counts`). */
export function pausedWorkflowCount(rows: readonly ActivityItem[]): number {
  return rows.filter(isParked).length;
}

/** What the tasks list shows: running work and parked workflows. Finished work is never listed. */
export function activeRows(rows: readonly ActivityItem[]): ActivityItem[] {
  return rows.filter((row) => isLive(row.status) || isParked(row));
}
