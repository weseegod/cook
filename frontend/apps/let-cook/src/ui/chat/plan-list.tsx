import { Check, Play, Square, X } from "lucide-react";
import { planEntryStatus, planEntryText } from "./plan-entries";

/** `views/todo_pane.rs::TodoListEntry::icon`: pending `□`, in-progress `▶`, completed `✓`, cancelled `✗`. */
const ICONS = { pending: Square, in_progress: Play, completed: Check, cancelled: X } as const;

/**
 * A plan as the TUI's todo pane paints it: one status glyph plus the item text per row
 * (`views/todo_pane.rs`). ACP Plan updates replace the entries in place, so this stays a pure
 * projection of the current list.
 */
export function PlanChecklist({ entries, className }: { entries: readonly unknown[]; className?: string }) {
  return (
    <ol className={className ? `plan-checklist ${className}` : "plan-checklist"}>
      {entries.map((entry, index) => {
        const status = planEntryStatus(entry);
        const Icon = ICONS[status];
        return (
          <li key={index} className={`plan-entry plan-entry-${status}`} data-testid={`plan-entry-${status}`}>
            <Icon className="plan-entry-icon" size={13} aria-hidden="true" />
            <span>{planEntryText(entry)}</span>
          </li>
        );
      })}
    </ol>
  );
}
