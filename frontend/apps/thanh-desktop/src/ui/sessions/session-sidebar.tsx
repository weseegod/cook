import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, MessageSquarePlus, Pencil, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { acpClient } from "../../acp/client";
import type { SessionSummary } from "../../acp/xai";
import { useSessionStore } from "../../state/session";
import { ConfirmDialog, Dialog, DialogActions } from "../components/dialog";

export function SessionSidebar() {
  const activeId = useSessionStore((state) => state.sessionId);
  const cwd = useSessionStore((state) => state.cwd);
  const connection = useSessionStore((state) => state.connection);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [target, setTarget] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: ["sessions", deferredSearch],
    queryFn: () => acpClient.xai.listSessions(deferredSearch),
    enabled: useSessionStore.getState().connection === "ready",
  });

  async function newConversation() {
    await acpClient.newSession();
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  async function rename(session: SessionSummary) {
    setTarget(session);
    setRenameValue(session.title ?? "");
    setError(null);
    setDialog("rename");
  }

  async function remove(session: SessionSummary) {
    setTarget(session);
    setError(null);
    setDialog("delete");
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
      setError(caught instanceof Error ? caught.message : String(caught));
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
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setDialog(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="sidebar-brand">
            <span className="brand-mark">t</span>
            <span>Thanh</span>
          </div>
          <span className="sidebar-version">Desktop</span>
        </header>
        <div className="sidebar-workspace" title={cwd ?? undefined}>
          <Folder size={14} />
          <span>{cwd ? cwd.split(/[\\/]/).pop() : "Workspace"}</span>
        </div>
        <button className="new-chat" onClick={newConversation}><MessageSquarePlus size={16} /> New conversation</button>
        <label className="search-field"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions" /></label>
        <div className="session-list">
          <div className="session-list-heading"><span>Conversations</span>{sessions.data && <small>{sessions.data.length}</small>}</div>
          {sessions.isLoading && <div className="sidebar-hint">Loading sessions…</div>}
          {sessions.data?.map((session) => (
            <div key={session.id} className={`session-row ${activeId === session.id ? "active" : ""}`}>
              <button className="session-open" onClick={() => void acpClient.loadSession(session.id, session.cwd)}>
                <strong>{session.title || "Untitled conversation"}</strong>
                <span>{formatDate(session.updatedAt)}</span>
              </button>
              <div className="session-actions">
                <button type="button" onClick={() => void rename(session)} aria-label="Rename"><Pencil size={13} /></button>
                <button type="button" onClick={() => void remove(session)} aria-label="Delete"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {sessions.data?.length === 0 && <div className="sidebar-hint">No conversations found.</div>}
        </div>
        <footer className="sidebar-footer">
          <span><span className={`status-dot status-${connection}`} /> {connection === "ready" ? "Connected" : "Reconnecting"}</span>
          <small title={cwd ?? undefined}>Ready to work</small>
        </footer>
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
