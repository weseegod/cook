import { ChevronDown, Clock3, FolderTree } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConversationPrefs, ConversationSort } from "../session-sidebar-utils";

interface SessionSortMenuProps {
  prefs: ConversationPrefs;
  onChangeSort: (sort: ConversationSort) => void;
  onResetOrder: () => void;
}

/** The conversation-list sort control: trigger plus its menu. */
export function SessionSortMenu({ prefs, onChangeSort, onResetOrder }: SessionSortMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function changeSort(sort: ConversationSort) {
    setOpen(false);
    onChangeSort(sort);
  }

  function resetOrder() {
    setOpen(false);
    onResetOrder();
  }

  return (
    <div className="session-sort" ref={menuRef}>
      <button
        type="button"
        className="session-sort-trigger"
        data-testid="conversation-sort"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort conversations: ${prefs.sort === "time" ? "By time" : "By workspace"}`}
        title="Sort conversations"
        onClick={() => setOpen((current) => !current)}
      >
        {prefs.sort === "time" ? <Clock3 size={12} aria-hidden="true" /> : <FolderTree size={12} aria-hidden="true" />}
        <span>{prefs.sort === "time" ? "Time" : "Workspace"}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <div className="session-sort-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={prefs.sort === "time"}
            data-testid="sort-time"
            onClick={() => changeSort("time")}
          >
            <Clock3 size={13} aria-hidden="true" />
            <span>By time</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={prefs.sort === "workspace"}
            data-testid="sort-workspace"
            title="Group conversations by workspace; rows reorder inside their own workspace."
            onClick={() => changeSort("workspace")}
          >
            <FolderTree size={13} aria-hidden="true" />
            <span>By workspace</span>
          </button>
          {prefs.order.length > 0 && (
            <button
              type="button"
              role="menuitem"
              data-testid="sort-reset-order"
              onClick={resetOrder}
            >
              <Clock3 size={13} aria-hidden="true" />
              <span>Reset manual order</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
