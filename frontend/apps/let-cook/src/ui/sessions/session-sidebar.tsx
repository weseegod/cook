import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Clock3,
  CopyPlus,
  Download,
  Folder,
  FolderTree,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
  CircleHelp,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { basename } from "../../acp/attachments";
import type { SessionSummary } from "../../acp/xai";
import { DEFAULT_SESSION_TITLE, useSessionStore } from "../../state/session";
import { downloadMarkdown, exportFilename, exportTranscriptMarkdown } from "../chat/export-transcript";
import { ConfirmDialog, Dialog, DialogActions } from "../components/dialog";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  flattenGroupIds,
  groupConversations,
  loadPrefs,
  moveId,
  prunePrefs,
  savePrefs,
  togglePinned,
  type ConversationPrefs,
  type ConversationSort,
} from "./session-sidebar-utils";
import { SessionMetaLine } from "./session-meta-line";

/** Room a five-item conversation menu needs below its trigger before it flips upwards. */
const ROW_MENU_HEIGHT = 190;
/** Pixels the pointer travels before a press on a row becomes a reorder instead of a click. */
const DRAG_THRESHOLD = 4;
/** Arrow-key step, and its bigger step with Shift held. */
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 48;

interface RowMenu {
  id: string;
  top: number | null;
  bottom: number | null;
  right: number;
  trigger: HTMLElement;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  /** False until the pointer passes {@link DRAG_THRESHOLD}. */
  active: boolean;
}

interface DropTarget {
  id: string;
  position: "before" | "after";
}

export function SessionSidebar({ onOpenSettings, onOpenSearch }: { onOpenSettings: () => void; onOpenSearch: () => void }) {
  const activeId = useSessionStore((state) => state.sessionId);
  const activeTitle = useSessionStore((state) => state.sessionTitle);
  const workspace = useSessionStore((state) => state.cwd);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [target, setTarget] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ConversationPrefs>(loadPrefs);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  /** Set while a reorder is in flight, so releasing the pointer does not also open the row. */
  const suppressClickRef = useRef(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const liveWidthRef = useRef<number | null>(null);
  const prefsRef = useRef(prefs);

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => acpClient.xai.listSessions(),
    enabled: useSessionStore.getState().connection === "ready",
  });

  const list = sessions.data ?? [];
  /**
   * The agent lists a conversation only once it has saved one, so the conversation the window has
   * open is shown from the start. That is where a brand-new chat reports its running turn, and it
   * disappears from the list on its own once the agent reports the real row.
   */
  const rows = useMemo(() => {
    if (!activeId || list.some((session) => session.id === activeId)) return list;
    // An unnamed conversation keeps the list's own fallback title, which also stops the row from
    // reading exactly like the "New chat" button beside it.
    const title = activeTitle === DEFAULT_SESSION_TITLE ? "" : activeTitle;
    return [
      { id: activeId, title, cwd: workspace ?? undefined, updatedAt: Date.now() },
      ...list,
    ];
  }, [activeId, activeTitle, list, workspace]);
  const groups = useMemo(() => groupConversations(rows, prefs), [rows, prefs]);
  const groupKeyOf = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const group of groups) for (const session of group.sessions) lookup.set(session.id, group.key);
    return lookup;
  }, [groups]);
  const sidebarWidth = liveWidth ?? prefs.width;
  prefsRef.current = prefs;

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

  useEffect(() => {
    if (liveWidth === null) return undefined;
    function onPointerMove(event: PointerEvent) {
      const start = resizeRef.current;
      if (!start) return;
      event.preventDefault();
      setLive(clampSidebarWidth(start.startWidth + (event.clientX - start.startX)));
    }
    function onPointerUp() {
      const width = liveWidthRef.current ?? prefsRef.current.width;
      resizeRef.current = null;
      document.body.classList.remove("session-resizing");
      setLive(null);
      updatePrefs({ ...prefsRef.current, width });
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [liveWidth]);

  useEffect(() => {
    if (!rowMenu) return;
    const trigger = rowMenu.trigger;
    function onPointerDown(event: MouseEvent) {
      const node = event.target as Node;
      if (rowMenuRef.current?.contains(node) || trigger.contains(node)) return;
      setRowMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setRowMenu(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [rowMenu]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !sortMenuRef.current?.contains(event.target)) setSortMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [sortMenuOpen]);

  function updatePrefs(next: ConversationPrefs) {
    setPrefs(next);
    savePrefs(next);
  }

  async function newConversation() {
    await acpClient.newSession();
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  async function rename(session: SessionSummary) {
    setRowMenu(null);
    setTarget(session);
    setRenameValue(session.title ?? "");
    setError(null);
    setDialog("rename");
  }

  async function remove(session: SessionSummary) {
    setRowMenu(null);
    setTarget(session);
    setError(null);
    setDialog("delete");
  }

  /** Map id `C-sess-fork` / `/fork`: fork then load the child session. */
  async function fork(session: SessionSummary) {
    setRowMenu(null);
    const cwd = session.cwd ?? useSessionStore.getState().cwd;
    if (!cwd) {
      useSessionStore.getState().set({ error: "Session has no workspace to fork." });
      return;
    }
    try {
      await acpClient.forkSession({
        sourceSessionId: session.id,
        sourceCwd: cwd,
        newCwd: cwd,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (caught) {
      useSessionStore.getState().set({
        error: normalizeError(caught, "Could not fork the conversation"),
      });
    }
  }

  /** Map id `/export`: Markdown of the active transcript (user/assistant only). */
  function exportSession(session: SessionSummary) {
    setRowMenu(null);
    const store = useSessionStore.getState();
    if (store.sessionId !== session.id) {
      useSessionStore.getState().set({ notice: "Load this conversation before exporting." });
      return;
    }
    const markdown = exportTranscriptMarkdown(store.blocks);
    if (!markdown) {
      useSessionStore.getState().set({ notice: "Nothing to export yet." });
      return;
    }
    downloadMarkdown(exportFilename(session.title, session.id), markdown);
    useSessionStore.getState().set({ notice: "Exported conversation as Markdown." });
  }

  function togglePin(session: SessionSummary) {
    setRowMenu(null);
    updatePrefs({ ...prefs, pinned: togglePinned(prefs.pinned, session.id) });
  }

  function changeSort(sort: ConversationSort) {
    setSortMenuOpen(false);
    updatePrefs({ ...prefs, sort });
  }

  function openRowMenu(trigger: HTMLElement, session: SessionSummary) {
    if (rowMenu?.id === session.id) {
      setRowMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const openUp = rect.bottom + ROW_MENU_HEIGHT > window.innerHeight;
    setRowMenu({
      id: session.id,
      top: openUp ? null : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : null,
      right: Math.max(6, window.innerWidth - rect.right),
      trigger,
    });
  }

  /** Arm a reorder. Nothing moves until the pointer clears {@link DRAG_THRESHOLD}. */
  function beginRowDrag(event: React.PointerEvent<HTMLDivElement>, session: SessionSummary) {
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".session-menu-trigger")) return;
    dragRef.current = { id: session.id, startX: event.clientX, startY: event.clientY, active: false };
  }

  function setLive(width: number | null) {
    liveWidthRef.current = width;
    setLiveWidth(width);
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    const aside = asideRef.current;
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    const startWidth = aside.getBoundingClientRect().width;
    resizeRef.current = { startX: event.clientX, startWidth };
    document.body.classList.add("session-resizing");
    setLive(Math.round(startWidth));
  }

  function resizeByKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    const current = sidebarWidth ?? asideRef.current?.getBoundingClientRect().width;
    if (current === undefined) return;
    updatePrefs({ ...prefs, width: clampSidebarWidth(current + (event.key === "ArrowRight" ? step : -step)) });
  }

  async function confirmRename() {
    if (!target || !renameValue.trim()) {
      setError("Enter a conversation name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await acpClient.xai.renameSession(target.id, renameValue.trim());
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDialog(null);
    } catch (caught) {
      setError(normalizeError(caught, "Could not rename the conversation"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await acpClient.xai.deleteSession(target.id);
      if (activeId === target.id) useSessionStore.getState().resetConversation();
      updatePrefs(prunePrefs(prefs, target.id));
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDialog(null);
    } catch (caught) {
      setError(normalizeError(caught, "Could not remove the conversation"));
    } finally {
      setBusy(false);
    }
  }

  const pinnedIds = new Set(prefs.pinned);

  return (
    <>
      <aside
        className="sidebar"
        ref={asideRef}
        style={sidebarWidth === null ? undefined : { width: sidebarWidth, flexBasis: sidebarWidth }}
      >
        <header className="sidebar-header">
          <div className="sidebar-brand">
            <img className="brand-mark" src="/logo.svg" alt="" width={44} height={44} />
            <span>Let Cook</span>
          </div>
          <span className="sidebar-version">Desktop</span>
        </header>
        <button className="new-chat" onClick={newConversation}><MessageSquarePlus size={16} /> New chat</button>
        <button type="button" className="search-field" onClick={onOpenSearch} aria-label="Search everything">
          <Search size={14} aria-hidden="true" />
          <span className="search-field-label">Search everything</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="session-list">
          <div className="session-list-heading">
            <span className="session-list-title">Conversations</span>
            {rows.length > 0 && <small>{rows.length}</small>}
            <div className="session-sort" ref={sortMenuRef}>
              <button
                type="button"
                className="session-sort-trigger"
                data-testid="conversation-sort"
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
                aria-label={`Sort conversations: ${prefs.sort === "time" ? "By time" : "By workspace"}`}
                title="Sort conversations"
                onClick={() => setSortMenuOpen((open) => !open)}
              >
                {prefs.sort === "time" ? <Clock3 size={12} aria-hidden="true" /> : <FolderTree size={12} aria-hidden="true" />}
                <span>{prefs.sort === "time" ? "Time" : "Workspace"}</span>
                <ChevronDown size={11} aria-hidden="true" />
              </button>
              {sortMenuOpen && (
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
                      onClick={() => {
                        setSortMenuOpen(false);
                        updatePrefs({ ...prefs, order: [] });
                      }}
                    >
                      <Clock3 size={13} aria-hidden="true" />
                      <span>Reset manual order</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {sessions.isLoading && <div className="sidebar-hint">Loading sessions…</div>}
          {sessions.isError && (
            <div className="sidebar-error" role="alert">
              <span>Couldn’t load conversations.</span>
              <button type="button" onClick={() => void sessions.refetch()}>Retry</button>
            </div>
          )}
          {groups.map((group) => (
            <Fragment key={group.key}>
              {group.label && (
                <div className="session-group-heading" title={group.path}>
                  {group.pinned ? <Pin size={10} aria-hidden="true" /> : <Folder size={10} aria-hidden="true" />}
                  <span>{group.label}</span>
                  <small>{group.sessions.length}</small>
                </div>
              )}
              {group.sessions.map((session) => {
                const pinned = pinnedIds.has(session.id);
                const menuOpen = rowMenu?.id === session.id;
                const drop = dropAt?.id === session.id ? dropAt.position : null;
                return (
                  <div
                    key={session.id}
                    className={`session-row ${activeId === session.id ? "active" : ""} ${dragId === session.id ? "dragging" : ""} ${drop ? `drop-${drop}` : ""}`}
                    data-testid={`session-row-${session.id}`}
                    data-session-id={session.id}
                    data-pinned={pinned ? "true" : "false"}
                    onPointerDown={(event) => beginRowDrag(event, session)}
                  >
                    <button
                      className="session-open"
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        void acpClient.loadSession(session.id, session.cwd);
                      }}
                    >
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
                        <SessionMetaLine sessionId={session.id} active={activeId === session.id}>
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
                      onClick={(event) => openRowMenu(event.currentTarget, session)}
                    >
                      <MoreVertical size={14} />
                    </button>
                    {menuOpen && rowMenu && (
                      <div
                        className="session-menu"
                        role="menu"
                        ref={rowMenuRef}
                        style={{ top: rowMenu.top ?? undefined, bottom: rowMenu.bottom ?? undefined, right: rowMenu.right }}
                      >
                        <button type="button" role="menuitem" data-testid={`session-pin-${session.id}`} onClick={() => togglePin(session)}>
                          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                          <span>{pinned ? "Unpin" : "Pin to top"}</span>
                        </button>
                        <button type="button" role="menuitem" data-testid={`session-rename-${session.id}`} onClick={() => void rename(session)}>
                          <Pencil size={13} />
                          <span>Rename</span>
                        </button>
                        <button type="button" role="menuitem" data-testid={`session-fork-${session.id}`} onClick={() => void fork(session)}>
                          <CopyPlus size={13} />
                          <span>Fork</span>
                        </button>
                        <button type="button" role="menuitem" data-testid={`session-export-${session.id}`} onClick={() => exportSession(session)}>
                          <Download size={13} />
                          <span>Export</span>
                        </button>
                        <div className="session-menu-separator" role="separator" />
                        <button
                          type="button"
                          role="menuitem"
                          className="session-menu-danger"
                          data-testid={`session-delete-${session.id}`}
                          onClick={() => void remove(session)}
                        >
                          <Trash2 size={13} />
                          <span>Delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
          {rows.length === 0 && <div className="sidebar-hint">No conversations found.</div>}
        </div>
        <footer className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button type="button" className="sidebar-footer-button" onClick={onOpenSettings} aria-label="Settings" title="Settings"><Settings size={15} /></button>
            <button type="button" className="sidebar-footer-button" aria-label="Help" title="Help"><CircleHelp size={15} /></button>
          </div>
        </footer>
        <div
          className="sidebar-resizer"
          data-testid="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth ?? undefined}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeByKey}
          onDoubleClick={() => updatePrefs({ ...prefs, width: null })}
        />
      </aside>
      {dialog === "rename" && target && (
        <Dialog title="Rename conversation" onClose={() => setDialog(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void confirmRename(); }}>
            <label className="dialog-field">
              <span>Conversation name</span>
              <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="Conversation name" />
            </label>
            {error && <p className="field-error">{error}</p>}
            <DialogActions>
              <button type="button" className="ghost-button" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="primary-button" disabled={busy}><Pencil size={15} /> {busy ? "Saving…" : "Rename"}</button>
            </DialogActions>
          </form>
        </Dialog>
      )}
      {dialog === "delete" && target && (
        <ConfirmDialog
          title="Delete conversation?"
          description={`“${target.title ?? "Untitled conversation"}” will be permanently deleted.`}
          confirmLabel="Delete conversation"
          danger
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </>
  );
}

function formatDate(value?: string | number) {
  if (value === undefined) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
