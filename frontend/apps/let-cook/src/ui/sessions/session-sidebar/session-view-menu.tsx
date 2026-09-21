import { ChevronDown, Inbox, Archive } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionListView } from "../../../acp/xai";

interface SessionViewMenuProps {
  view: SessionListView;
  onChange: (view: SessionListView) => void;
}

/** Switches the sidebar between active conversations and archived conversations. */
export function SessionViewMenu({ view, onChange }: SessionViewMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = view === "archives" ? "ARCHIVES" : "CONVERSATIONS";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
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
  }, [open]);

  function select(next: SessionListView) {
    setOpen(false);
    onChange(next);
  }

  return (
    <div className="session-view" ref={menuRef}>
      <button
        type="button"
        className="session-view-trigger"
        data-testid="conversation-view"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Conversation view: ${label}`}
        onClick={() => setOpen((current) => !current)}
      >
        {view === "archives" ? <Archive size={12} aria-hidden="true" /> : <Inbox size={12} aria-hidden="true" />}
        <span>{label}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <div className="session-view-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={view === "conversations"}
            data-testid="conversation-view-conversations"
            onClick={() => select("conversations")}
          >
            <Inbox size={13} aria-hidden="true" />
            <span>CONVERSATIONS</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={view === "archives"}
            data-testid="conversation-view-archives"
            onClick={() => select("archives")}
          >
            <Archive size={13} aria-hidden="true" />
            <span>ARCHIVES</span>
          </button>
        </div>
      )}
    </div>
  );
}
