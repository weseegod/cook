import { Activity } from "lucide-react";
import { useEffect, useRef } from "react";
import { pausedWorkflowCount, runningCount, useActivityStore } from "../../state/activity";
import { placeMenuOverChat } from "../components/anchored-menu";
import { TasksMenu } from "./tasks-menu";
import { useConversationRows } from "./use-activity-rows";

/**
 * Header chip for the conversation's background work, beside the `Plans` chip.
 *
 * It reads like the `Plans` chip beside it — an icon, the name and the count of what is running —
 * with `P N` for parked workflows (`views/agent_status.rs::task_status_line`). It opens the same
 * way the plans chip does: a popover under the chip, over the transcript. Ctrl-G toggles it too
 * (`ActionId::ToggleTasks`).
 */
export function TasksChip() {
  const rows = useConversationRows();
  const open = useActivityStore((state) => state.overlayOpen);
  const setOverlayOpen = useActivityStore((state) => state.setOverlayOpen);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The list is sized against the chat, so it follows the window while it is open.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const node = menu.current;
      const parent = root.current;
      if (node && parent) placeMenuOverChat(node, parent);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOverlayOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOverlayOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, setOverlayOpen]);

  // No background work in this conversation means no chip: the header stays clean until there is.
  if (rows.length === 0) return null;

  const running = runningCount(rows);
  const paused = pausedWorkflowCount(rows);
  const label = `${running === 1 ? "1 running" : `${running} running`}`
    + `${paused > 0 ? `, ${paused} paused` : ""}`;

  return (
    <div className="tasks-chip-root" ref={root}>
      <button
        type="button"
        className={`tasks-chip${open ? " active" : ""}`}
        data-testid="tasks-chip"
        title={`${open ? "Hide" : "Show"} background tasks (${label})`}
        aria-label={`${open ? "Hide" : "Show"} background tasks: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOverlayOpen(!open)}
      >
        <Activity size={12} aria-hidden="true" />
        <span className="tasks-chip-name">Tasks</span>
        <span className="tasks-chip-count" data-testid="tasks-chip-count" aria-hidden="true">{running}</span>
        {paused > 0 && (
          <span className="tasks-chip-paused" data-testid="tasks-chip-paused" aria-hidden="true">
            P {paused}
          </span>
        )}
      </button>
      {open && <TasksMenu menuRef={menu} />}
    </div>
  );
}
