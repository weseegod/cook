/**
 * ACP `Plan` entries as the TUI's todo pane shows them.
 *
 * The agent turns its todo list into `PlanEntry`s (`xai-grok-shell/src/tools/todo.rs`) and the
 * pager turns them back with `todo_item_from_plan_entry`. One asymmetry matters here: ACP has no
 * `cancelled` status, so a cancelled item travels as `completed` plus `_meta.cancelled`.
 */
export type PlanEntryStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Entry text: `content`, falling back to the shapes a non-ACP plan body can carry. */
export function planEntryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    return String(record.content ?? record.title ?? record.description ?? JSON.stringify(entry));
  }
  return entry == null ? "" : String(entry);
}

/** `todo_item_from_plan_entry`: an uninterpretable status reads as pending. */
export function planEntryStatus(entry: unknown): PlanEntryStatus {
  const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (status === "in_progress" || status === "in-progress" || status === "inprogress") return "in_progress";
  if (status === "completed" || status === "complete") {
    const meta = record._meta ?? record.meta;
    const cancelled = meta && typeof meta === "object" && (meta as Record<string, unknown>).cancelled === true;
    return cancelled ? "cancelled" : "completed";
  }
  return "pending";
}
