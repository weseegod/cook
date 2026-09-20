import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { SessionSummary } from "../../../acp/xai";
import {
  flattenGroupIds,
  moveId,
  type ConversationGroup,
  type ConversationPrefs,
} from "../session-sidebar-utils";

/** Pixels the pointer travels before a press on a row becomes a reorder instead of a click. */
const DRAG_THRESHOLD = 4;

interface DragState {
  id: string;
  startX: number;
  startY: number;
  /** False until the pointer passes {@link DRAG_THRESHOLD}. */
  active: boolean;
}

export interface DropTarget {
  id: string;
  position: "before" | "after";
}

/** Row reordering plus the pointer bookkeeping that keeps a reorder from also opening the row. */
export function useSidebarDrag({
  groups,
  groupKeyOf,
  prefsRef,
  updatePrefs,
}: {
  groups: ConversationGroup[];
  groupKeyOf: Map<string, string>;
  prefsRef: RefObject<ConversationPrefs>;
  updatePrefs: (next: ConversationPrefs) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  /** Set while a reorder is in flight, so releasing the pointer does not also open the row. */
  const suppressClickRef = useRef(false);

  /**
   * Pointer-driven reordering. Reorders run on pointer events rather than HTML5 drag-and-drop: the
   * desktop shell takes over native drags for its own file-drop handler (`onFileDrop` in
   * `acp/host.ts`), which leaves HTML5 drags unusable inside the app's webview.
   */
  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.active = true;
        suppressClickRef.current = true;
        document.body.classList.add("session-dragging");
        window.getSelection()?.removeAllRanges();
        setDragId(drag.id);
      }
      event.preventDefault();
      const row = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-session-id]");
      const targetId = row?.dataset.sessionId;
      // A drop across blocks would silently re-pin the conversation, so only same-block drops land.
      if (!row || !targetId || targetId === drag.id || groupKeyOf.get(targetId) !== groupKeyOf.get(drag.id)) {
        dropRef.current = null;
        setDropAt(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      dropRef.current = {
        id: targetId,
        position: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
      };
      setDropAt(dropRef.current);
    }

    function onPointerUp() {
      const drag = dragRef.current;
      const drop = dropRef.current;
      dragRef.current = null;
      dropRef.current = null;
      if (drag) {
        document.body.classList.remove("session-dragging");
        if (drag.active && drop) {
          updatePrefs({ ...prefsRef.current, order: moveId(flattenGroupIds(groups), drag.id, drop.id, drop.position) });
        }
      }
      setDragId(null);
      setDropAt(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [groups, groupKeyOf]);

  /** Arm a reorder. Nothing moves until the pointer clears {@link DRAG_THRESHOLD}. */
  function beginRowDrag(event: ReactPointerEvent<HTMLDivElement>, session: SessionSummary) {
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".session-menu-trigger")) return;
    dragRef.current = { id: session.id, startX: event.clientX, startY: event.clientY, active: false };
  }

  return { dragId, dropAt, suppressClickRef, beginRowDrag };
}
