/** A row still in flight: the statuses the TUI's task/subagent/workflow panes treat as active. */
export function isLive(status: string): boolean {
  const s = status.toLowerCase();
  return s === "running" || s === "active" || s === "scheduled" || s === "pending" || s === "fired";
}

/** Workflow statuses that will not move again (`views/workflows.rs::is_terminal`). */
export const TERMINAL_WORKFLOW_STATUSES = new Set(["interrupted", "complete", "completed", "failed", "cancelled", "canceled", "error", "killed"]);

/** A status update leaves a finished row's status alone: only a live row picks up `fallback`. */
export function terminalStatus(current: string, fallback: string): string {
  return isLive(current) ? fallback : current;
}
