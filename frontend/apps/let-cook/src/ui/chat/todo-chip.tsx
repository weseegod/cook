import { ListTodo } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSessionStore } from "../../state/session";
import { clampMenuToViewport } from "../components/anchored-menu";
import { PlanChecklist } from "./plan-list";

/** Header checklist chip: the latest plan's todo pane in the same anchored-menu family as Plans. */
export function TodoChip() {
  const entries = useSessionStore((state) => state.planEntries);
  const open = useSessionStore((state) => state.todoOverlayOpen);
  const setOpen = useSessionStore((state) => state.setTodoOverlayOpen);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const node = menu.current;
    const parent = root.current;
    if (node && parent) clampMenuToViewport(node, parent);
  }, [open, entries]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, setOpen]);

  if (entries.length === 0) return null;

  return (
    <div className="todo-chip-root" ref={root}>
      <button
        type="button"
        className={`todo-toggle${open ? " active" : ""}`}
        data-testid="todo-toggle"
        title={open ? "Hide plan checklist" : "Show plan checklist"}
        aria-label={open ? "Hide plan checklist" : "Show plan checklist"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        <ListTodo size={14} />
      </button>
      {open && (
        <div ref={menu} className="todo-menu" role="menu" data-testid="todo-overlay">
          <PlanChecklist entries={entries} />
        </div>
      )}
    </div>
  );
}
