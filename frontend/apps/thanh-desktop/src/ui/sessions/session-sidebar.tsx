import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Pencil, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { acpClient } from "../../acp/client";
import type { SessionSummary } from "../../acp/xai";
import { useSessionStore } from "../../state/session";

export function SessionSidebar() {
  const activeId = useSessionStore((state) => state.sessionId);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const queryClient = useQueryClient();
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
    const title = window.prompt("Rename conversation", session.title ?? "");
    if (!title?.trim()) return;
    await acpClient.xai.renameSession(session.id, title.trim());
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  async function remove(session: SessionSummary) {
    if (!window.confirm(`Delete “${session.title ?? "Untitled conversation"}”? This cannot be undone.`)) return;
    await acpClient.xai.deleteSession(session.id);
    if (activeId === session.id) useSessionStore.getState().resetConversation();
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">thanh</div>
      <button className="new-chat" onClick={newConversation}><MessageSquarePlus size={17} /> New conversation</button>
      <label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions" /></label>
      <div className="session-list">
        {sessions.isLoading && <div className="sidebar-hint">Loading sessions…</div>}
        {sessions.data?.map((session) => (
          <div key={session.id} className={`session-row ${activeId === session.id ? "active" : ""}`}>
            <button className="session-open" onClick={() => void acpClient.loadSession(session.id, session.cwd)}>
              <strong>{session.title || "Untitled conversation"}</strong>
              <span>{formatDate(session.updatedAt)}</span>
            </button>
            <div className="session-actions">
              <button onClick={() => void rename(session)} aria-label="Rename"><Pencil size={13} /></button>
              <button onClick={() => void remove(session)} aria-label="Delete"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {sessions.data?.length === 0 && <div className="sidebar-hint">No conversations found.</div>}
      </div>
    </aside>
  );
}

function formatDate(value?: string | number) {
  if (value === undefined) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
