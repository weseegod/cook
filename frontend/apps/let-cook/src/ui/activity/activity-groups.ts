/**
 * The tasks pane's sections (`views/tasks_pane.rs`: Workflows → Subagents → Tasks → Watchers).
 * A monitor task and a `/loop` schedule share the Watchers section, exactly as the TUI groups them.
 */
import type { ActivityItem } from "../../state/activity";

export type ActivityGroupKind = "workflows" | "subagents" | "tasks" | "watchers";

export interface ActivityGroup {
  kind: ActivityGroupKind;
  label: string;
  rows: ActivityItem[];
}

const GROUPS: Array<{ kind: ActivityGroupKind; label: string }> = [
  { kind: "workflows", label: "Workflows" },
  { kind: "subagents", label: "Subagents" },
  { kind: "tasks", label: "Tasks" },
  { kind: "watchers", label: "Watchers" },
];

/** Section a row belongs to (`TaskEntry::group`), keeping the pane's order. */
export function groupOf(item: ActivityItem): ActivityGroupKind {
  if (item.kind === "workflow") return "workflows";
  if (item.kind === "subagent") return "subagents";
  if (item.kind === "schedule" || item.isMonitor) return "watchers";
  return "tasks";
}

/** Rows bucketed into the pane's sections, in order, dropping the empty ones. */
export function groupActivityRows(rows: readonly ActivityItem[]): ActivityGroup[] {
  return GROUPS
    .map(({ kind, label }) => ({ kind, label, rows: rows.filter((row) => groupOf(row) === kind) }))
    .filter((group) => group.rows.length > 0);
}
