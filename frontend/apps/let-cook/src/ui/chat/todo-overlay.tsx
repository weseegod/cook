import { useSessionStore } from "../../state/session";
import { PlanChecklist } from "./plan-list";

/**
 * Todo pane (catalog §9.8): user-toggled checklist of the latest ACP `Plan`.
 * Not auto-shown on Plan updates; closed by default after every session load.
 */
export function TodoOverlay() {
  const open = useSessionStore((state) => state.todoOverlayOpen);
  const entries = useSessionStore((state) => state.planEntries);
  if (!open || entries.length === 0) return null;
  return (
    <div className="todo-overlay" data-testid="todo-overlay">
      <PlanChecklist entries={entries} />
    </div>
  );
}
