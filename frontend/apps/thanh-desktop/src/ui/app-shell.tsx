import { useEffect, useState } from "react";
import { FolderOpen, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { acpClient } from "../acp/client";
import { pickFolder } from "../acp/host";
import { useSessionStore } from "../state/session";
import { ChatView } from "./chat/chat-view";
import { InteractionModal } from "./permissions/interaction-modal";
import { PermissionModal } from "./permissions/permission-modal";
import { SessionSidebar } from "./sessions/session-sidebar";
import { SettingsPanel } from "./settings/settings-panel";
import { Welcome } from "./welcome/welcome";

export function AppShell() {
  const { cwd, connection, error } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const lastWorkspace = localStorage.getItem("thanh.lastWorkspace");
    if (lastWorkspace) void acpClient.connect(lastWorkspace).catch(() => undefined);
    const onBeforeUnload = () => void acpClient.dispose();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  async function chooseWorkspace() {
    const selected = await pickFolder();
    if (selected) await acpClient.connect(selected);
  }

  return (
    <div className="app-frame">
      {sidebarOpen && cwd && <SessionSidebar />}
      <main className="main-column">
        <header className="titlebar">
          <button className="icon-button" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle sessions">
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div className="titlebar-workspace">
            <span className={`status-dot status-${connection}`} />
            <span title={cwd ?? undefined}>{cwd ? basename(cwd) : "Thanh Desktop"}</span>
          </div>
          <div className="titlebar-actions">
            <button className="ghost-button" onClick={chooseWorkspace}><FolderOpen size={16} /> Open folder</button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Settings size={18} /></button>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {cwd ? <ChatView /> : <Welcome onChooseWorkspace={chooseWorkspace} />}
      </main>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <PermissionModal />
      <InteractionModal />
    </div>
  );
}

function basename(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
