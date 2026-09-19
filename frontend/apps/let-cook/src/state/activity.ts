/**
 * Compact activity dock state (map §10 TK-*): background tasks, subagents, schedules, workflows.
 * Fed by N-tbg, N-tdone, N-sched-*, N-mon and U-sub-*, U-wf — not transcript rows.
 */
export {
  applyMonitorEvent,
  applyScheduledTask,
  applyScheduledTaskDeleted,
  applySubagentSessionUpdate,
  applyTaskBackgrounded,
  applyTaskCompleted,
  applyWorkflowUpdated,
} from "./activity/appliers";
export {
  activeRows,
  activityRows,
  conversationRows,
  isParked,
  pausedWorkflowCount,
  rowForChildSession,
  runningCount,
} from "./activity/rows";
export { isLive } from "./activity/status";
export { useActivityStore } from "./activity/store";
export type { ActivityItem, ActivityKind, ActivityRowsSource } from "./activity/types";
