/**
 * ACP `Plan` entries as the TUI's todo pane shows them.
 *
 * The agent turns its todo list into `PlanEntry`s (`xai-grok-shell/src/tools/todo.rs`) and the
 * pager turns them back with `todo_item_from_plan_entry`. One asymmetry matters here: ACP has no
 * `cancelled` status, so a cancelled item travels as `completed` plus `_meta.cancelled`.
 */
export type PlanEntryStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Read the task checklist from an active plan or a saved passive working plan. */
export function extractPlanChecklist(body: string | null | undefined): Array<{ content: string; status: "pending" | "completed" }> {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const headings = lines.map((line) => line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/));
  const findSection = (name: string) => headings.findIndex((heading) => heading?.[2].toLowerCase() === name);
  const start = findSection("task checklist");
  const section = start >= 0 ? start : findSection("steps");
  if (section < 0) return [];
  const level = headings[section]![1].length;
  const entries: Array<{ content: string; status: "pending" | "completed" }> = [];
  for (let index = section + 1; index < lines.length; index += 1) {
    const heading = headings[index];
    if (heading && heading[1].length <= level) break;
    const item = lines[index].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (item) entries.push({ content: item[2], status: item[1] === " " ? "pending" : "completed" });
  }
  return entries;
}

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
