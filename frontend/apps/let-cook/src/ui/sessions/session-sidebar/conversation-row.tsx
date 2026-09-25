import { Archive, ArchiveRestore, CopyPlus, Download, Folder, MoreVertical, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { basename } from "../../../acp/attachments";
import type { SessionSummary } from "../../../acp/xai";
import { SessionMetaLine } from "../session-meta-line";
import type { RowMenu } from "./row-menu";

interface ConversationRowProps {
  session: SessionSummary;
  active: boolean;
  pinned: boolean;
  dragging: boolean;
  drop: "before" | "after" | null;
  menuOpen: boolean;
  menu: RowMenu | null;
  menuRef: RefObject<HTMLDivElement | null>;
  onBeginDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onOpenMenu: (trigger: HTMLElement) => void;
  onTogglePin: () => void;
  onRename: () => void;
  onFork: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRemove: () => void;
}

/** One conversation: the row itself plus its actions menu. */
export function ConversationRow({
  session,
  active,
  pinned,
  dragging,
  drop,
  menuOpen,
  menu,
  menuRef,
  onBeginDrag,
  onOpen,
  onOpenMenu,
  onTogglePin,
  onRename,
  onFork,
  onExport,
  onArchive,
  onRemove,
}: ConversationRowProps) {
  return (
    <div
      className={`session-row ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${drop ? `drop-${drop}` : ""}`}
      data-testid={`session-row-${session.id}`}
      data-session-id={session.id}
      data-pinned={pinned ? "true" : "false"}
      onPointerDown={onBeginDrag}
    >
      <button className="session-open" onClick={onOpen}>
        <span className="session-title">
          {pinned && <Pin className="session-pin-mark" size={11} aria-label="Pinned" />}
          <strong>{session.title || "Untitled conversation"}</strong>
        </span>
        <span className="session-meta">
          <span className="session-path" title={session.cwd ?? "Workspace unavailable"}>
            <Folder size={11} aria-hidden="true" />
            <span className="session-workspace-name">{session.cwd ? basename(session.cwd) : "Workspace unavailable"}</span>
            {session.cwd && <span className="sr-only">{session.cwd}</span>}
          </span>
          <SessionMetaLine sessionId={session.id} active={active} live={session.live}>
            <span className="session-meta-separator" aria-hidden="true">·</span>
            <span className="session-date">{formatDate(session.updatedAt)}</span>
          </SessionMetaLine>
        </span>
      </button>
      <button
        type="button"
        className="session-menu-trigger"
        data-testid={`session-menu-${session.id}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Conversation actions"
        title={`Conversation actions for ${session.title || "Untitled conversation"}`}
        onClick={(event) => onOpenMenu(event.currentTarget)}
      >
        <MoreVertical size={14} />
      </button>
      {menu && (
        <div
          className="session-menu"
          role="menu"
          ref={menuRef}
          style={{ top: menu.top ?? undefined, bottom: menu.bottom ?? undefined, right: menu.right }}
        >
          <button type="button" role="menuitem" data-testid={`session-pin-${session.id}`} onClick={onTogglePin}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            <span>{pinned ? "Unpin" : "Pin to top"}</span>
          </button>
          <button type="button" role="menuitem" data-testid={`session-rename-${session.id}`} onClick={onRename}>
            <Pencil size={13} />
            <span>Rename</span>
          </button>
          <button type="button" role="menuitem" data-testid={`session-fork-${session.id}`} onClick={onFork}>
            <CopyPlus size={13} />
            <span>Fork</span>
          </button>
          <button type="button" role="menuitem" data-testid={`session-export-${session.id}`} onClick={onExport}>
            <Download size={13} />
            <span>Export</span>
          </button>
          <button type="button" role="menuitem" data-testid={`session-archive-${session.id}`} onClick={onArchive}>
            {session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            <span>{session.archived ? "Unarchive" : "Archive"}</span>
          </button>
          <div className="session-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="session-menu-danger"
            data-testid={`session-delete-${session.id}`}
            onClick={onRemove}
          >
            <Trash2 size={13} />
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

function formatDate(value?: string | number) {
  if (value === undefined) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
