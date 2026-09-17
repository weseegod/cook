import { useSessionStore, type PlanBlock, type TranscriptBlock } from "../../state/session";
import { PlanChecklist } from "./plan-list";

const EMPTY_ENTRIES: unknown[] = [];

/**
 * Todo pane (catalog §9.8): user-toggled checklist of the latest ACP `Plan`.
 * Not auto-shown on Plan updates; closed by default after every session load.
 */
export function TodoOverlay() {
  const open = useSessionStore((state) => state.todoOverlayOpen);
  const entries = useSessionStore((state) => latestPlanEntries(state.blocks));
  if (!open || entries.length === 0) return null;
  return (
    <div className="todo-overlay" data-testid="todo-overlay">
      <PlanChecklist entries={entries} />
    </div>
  );
}

function latestPlanEntries(blocks: readonly TranscriptBlock[]): unknown[] {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === "plan") return (block as PlanBlock).entries;
  }
  // Stable empty reference — a fresh `[]` each snapshot would infinite-loop zustand.
  return EMPTY_ENTRIES;
}
