import { ListTodo } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "../../state/session";
import { clampMenuToViewport } from "../components/anchored-menu";
import { extractPlanChecklist, planEntryStatus } from "./plan-entries";
import { PlanChecklist } from "./plan-list";

export function usePlanChecklistEntries() {
  const review = useSessionStore((state) => state.planReview);
  const files = useSessionStore((state) => state.planFiles);
  const planMode = useSessionStore((state) => state.planMode);
  return useMemo(() => {
    // The tracker can still mark an older episode active after plan mode ends.
    const current = (planMode ? files.find((file) => file.active) : null) ?? files[0];
    const reviewMatchesCurrent = review?.pending || !current || current.name === review?.fileName
      || (review?.fileName && current.name.endsWith(`-${review.fileName}`));
    return extractPlanChecklist(review?.body?.trim() && reviewMatchesCurrent ? review.body : current?.content);
  }, [review, files, planMode]);
}

/** Header checklist chip: task rows from the current plan Markdown. */
export function TodoChip({ entries }: { entries: ReturnType<typeof extractPlanChecklist> }) {
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

  const completed = entries.reduce<number>(
    (count, entry) => count + (planEntryStatus(entry) === "completed" ? 1 : 0),
    0,
  );
  const progress = `${completed}/${entries.length}`;

  return (
    <div className="todo-chip-root" ref={root}>
      <button
        type="button"
        className={`plan-chip checklist-chip${open ? " active" : ""}`}
        data-testid="todo-toggle"
        title={`${open ? "Hide" : "Show"} plan checklist (${progress} completed)`}
        aria-label={`${open ? "Hide" : "Show"} plan checklist: ${progress} completed`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        <ListTodo size={12} aria-hidden="true" />
        <span className="checklist-chip-name">Checklist</span>
        <span className="checklist-chip-count" data-testid="todo-chip-count" aria-hidden="true">{progress}</span>
      </button>
      {open && (
        <div ref={menu} className="todo-menu" role="menu" data-testid="todo-overlay">
          <PlanChecklist entries={entries} expandable />
        </div>
      )}
    </div>
  );
}
