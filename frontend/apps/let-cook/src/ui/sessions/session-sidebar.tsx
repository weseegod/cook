import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, Folder, MessageSquarePlus, Pin, Search, Settings } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import type { SessionListView, SessionSummary } from "../../acp/xai";
import { DEFAULT_SESSION_TITLE, useSessionStore } from "../../state/session";
import { downloadMarkdown, exportFilename, exportTranscriptMarkdown } from "../chat/export-transcript";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  groupConversations,
  loadPrefs,
  prunePrefs,
  savePrefs,
  togglePinned,
  type ConversationPrefs,
} from "./session-sidebar-utils";
import { ConversationRow } from "./session-sidebar/conversation-row";
import { useRowMenuDismiss, rowMenuPosition, type RowMenu } from "./session-sidebar/row-menu";
import { DeleteConversationDialog, RenameConversationDialog } from "./session-sidebar/session-dialogs";
import { SessionSortMenu } from "./session-sidebar/session-sort-menu";
import { SessionViewMenu } from "./session-sidebar/session-view-menu";
import { useSidebarDrag } from "./session-sidebar/use-sidebar-drag";
import { useSidebarResize } from "./session-sidebar/use-sidebar-resize";

export function SessionSidebar({ onOpenSettings, onOpenSearch }: { onOpenSettings: () => void; onOpenSearch: () => void }) {
  const activeId = useSessionStore((state) => state.sessionId);
  const activeTitle = useSessionStore((state) => state.sessionTitle);
  const workspace = useSessionStore((state) => state.cwd);
  const notice = useSessionStore((state) => state.notice);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [target, setTarget] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ConversationPrefs>(loadPrefs);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [view, setView] = useState<SessionListView>("conversations");
  /** Tracks archive state for the open session when it is missing from the current list page. */
  const [activeArchived, setActiveArchived] = useState(false);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef(prefs);

  const sessions = useQuery({
    queryKey: ["sessions", view],
    queryFn: () => acpClient.xai.listSessions("", view),
    enabled: useSessionStore.getState().connection === "ready",
  });

  const list = sessions.data ?? [];
  const listedActive = useMemo(
    () => list.find((session) => session.id === activeId),
    [activeId, list],
  );

  useEffect(() => {
    setActiveArchived(false);
  }, [activeId]);

  useEffect(() => {
    if (listedActive) setActiveArchived(listedActive.archived === true);
  }, [listedActive]);

  /**
   * The agent lists a conversation only once it has saved one, so the conversation the window has
   * open is shown from the start. That is where a brand-new chat reports its running turn, and it
   * disappears from the list on its own once the agent reports the real row.
   */
  const rows = useMemo(() => {
    if (!activeId || listedActive) return list;
    // Keep the open row on the matching view only — never re-inject an archived chat into Conversations.
    if (view === "archives" ? !activeArchived : activeArchived) return list;
    // An unnamed conversation keeps the list's own fallback title, which also stops the row from
    // reading exactly like the "New chat" button beside it.
    const title = activeTitle === DEFAULT_SESSION_TITLE ? "" : activeTitle;
    return [
      { id: activeId, title, cwd: workspace ?? undefined, updatedAt: Date.now(), archived: activeArchived, kind: "build" as const },
      ...list,
    ];
  }, [activeArchived, activeId, activeTitle, list, listedActive, view, workspace]);
  const groups = useMemo(() => groupConversations(rows, prefs), [rows, prefs]);
  const groupKeyOf = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const group of groups) for (const session of group.sessions) lookup.set(session.id, group.key);
    return lookup;
  }, [groups]);
  prefsRef.current = prefs;

  const { dragId, dropAt, suppressClickRef, beginRowDrag } = useSidebarDrag({ groups, groupKeyOf, prefsRef, updatePrefs });
  const { sidebarWidth, asideRef, beginResize, resizeByKey } = useSidebarResize({ prefs, prefsRef, updatePrefs });
  useRowMenuDismiss(rowMenu, rowMenuRef, setRowMenu);

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

  async function archive(session: SessionSummary) {
    setRowMenu(null);
    const nextArchived = !session.archived;
    try {
      if (nextArchived) {
        await acpClient.xai.archiveSession(session.id, session.kind);
        useSessionStore.getState().set({ notice: "Conversation archived." });
      } else {
        await acpClient.xai.unarchiveSession(session.id, session.kind);
        useSessionStore.getState().set({ notice: "Conversation unarchived." });
      }
      if (session.id === activeId) setActiveArchived(nextArchived);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (caught) {
      useSessionStore.getState().set({
        error: normalizeError(caught, nextArchived ? "Could not archive the conversation" : "Could not unarchive the conversation"),
      });
    }
  }

  function togglePin(session: SessionSummary) {
    setRowMenu(null);
    updatePrefs({ ...prefs, pinned: togglePinned(prefs.pinned, session.id) });
  }

  function openSession(session: SessionSummary) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    void acpClient.loadSession(session.id, session.cwd);
  }

  function openRowMenu(trigger: HTMLElement, session: SessionSummary) {
    if (rowMenu?.id === session.id) {
      setRowMenu(null);
      return;
    }
    setRowMenu({ id: session.id, ...rowMenuPosition(trigger), trigger });
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
            <SessionViewMenu view={view} onChange={(next) => { setRowMenu(null); setView(next); }} />
            {rows.length > 0 && <small>{rows.length}</small>}
            <SessionSortMenu
              prefs={prefs}
              onChangeSort={(sort) => updatePrefs({ ...prefs, sort })}
              onResetOrder={() => updatePrefs({ ...prefs, order: [] })}
            />
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
                  <ConversationRow
                    key={session.id}
                    session={session}
                    active={activeId === session.id}
                    pinned={pinned}
                    dragging={dragId === session.id}
                    drop={drop}
                    menuOpen={menuOpen}
                    menu={menuOpen ? rowMenu : null}
                    menuRef={rowMenuRef}
                    onBeginDrag={(event) => beginRowDrag(event, session)}
                    onOpen={() => openSession(session)}
                    onOpenMenu={(trigger) => openRowMenu(trigger, session)}
                    onTogglePin={() => togglePin(session)}
                    onRename={() => void rename(session)}
                    onFork={() => void fork(session)}
                    onExport={() => exportSession(session)}
                    onArchive={() => void archive(session)}
                    onRemove={() => void remove(session)}
                  />
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
        {notice && <div className="sidebar-notice" data-testid="notice-banner" role="status" aria-live="polite">{notice}</div>}
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
        <RenameConversationDialog
          target={target}
          value={renameValue}
          error={error}
          busy={busy}
          onChange={setRenameValue}
          onClose={() => setDialog(null)}
          onConfirm={() => void confirmRename()}
        />
      )}
      {dialog === "delete" && target && (
        <DeleteConversationDialog
          target={target}
          error={error}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </>
  );
}
