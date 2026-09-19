/**
 * What a task row says it is doing, the way the TUI's tasks pane paints it
 * (`views/tasks_pane.rs` row suffix → `app/subagent.rs::format_activity_label`).
 *
 * This is deliberately not the turn-status wording. The turn-status row says `Thinking…` and
 * prefixes a tool with `Run `; a task row says `Thinking` and `Running: {title}`. Both read the
 * same `TurnActivity`, so only the phrasings the pane overrides live here.
 */
import {
  activityParts,
  formatWaitingForSubject,
  MAX_ACTIVITY_SUBJECT_CHARS,
  type TurnActivity,
} from "./turn-activity";

/** The ` · {label}` suffix for a task row, or `undefined` when the update says nothing. */
export function taskActivityLabel(activity: TurnActivity | null): string | undefined {
  if (!activity) return undefined;
  switch (activity.kind) {
    case "thinking":
      return "Thinking";
    case "responding":
      return "Responding";
    case "compacting":
      return "Compacting";
    case "tool":
      return toolLabel(activity);
    default:
      return activityParts(activity).text;
  }
}

function toolLabel(activity: Extract<TurnActivity, { kind: "tool" }>): string {
  const description = activity.description?.trim();
  if (description) return formatWaitingForSubject(description);
  const title = activity.title.trim();
  if (!title) return "Running tool";
  const firstLine = title.split(/\r?\n/, 1)[0];
  const chars = Array.from(firstLine);
  if (chars.length <= MAX_ACTIVITY_SUBJECT_CHARS) return `Running: ${firstLine}`;
  return `Running: ${chars.slice(0, MAX_ACTIVITY_SUBJECT_CHARS).join("")}\u2026`;
}
