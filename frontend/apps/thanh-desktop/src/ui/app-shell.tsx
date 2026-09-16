import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { acpClient } from "../acp/client";
import { pickFolder, request } from "../acp/host";
import { shouldShowConnectProvider } from "../acp/provider-presets";
import { listProviders } from "../acp/providers";
import { useSessionStore } from "../state/session";
import { ChatView } from "./chat/chat-view";
import { CommandPalette } from "./palette/command-palette";
import type { PaletteItem } from "./palette/palette-items";
import { InteractionModal } from "./permissions/interaction-modal";
import { PermissionModal } from "./permissions/permission-modal";
import { SessionSidebar } from "./sessions/session-sidebar";
import { SettingsPanel } from "./settings/settings-panel";
import { ConnectProvider } from "./welcome/connect-provider";
import { Welcome } from "./welcome/welcome";

const DISMISSED_KEY = "thanh.connectProviderDismissed";

export function AppShell() {
  const { cwd, connection, error } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsTab, setSettingsTab] = useState<"providers" | "models" | "connectors" | "context" | "skills" | "about" | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");

  useEffect(() => {
    const lastWorkspace = localStorage.getItem("thanh.lastWorkspace");
    if (lastWorkspace) void acpClient.connect(lastWorkspace).catch(() => undefined);
    const onBeforeUnload = () => void acpClient.dispose();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Provider gate: only shown once the agent answers, so the wizard never flashes.
  const connected = connection === "ready";
  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders, enabled: connected, retry: 0 });
  const auth = useQuery({
    queryKey: ["auth-info"],
    queryFn: () => request<{ methodId?: string | null; email?: string | null }>("x.ai/auth/info"),
    enabled: connected,
    retry: 0,
  });
  const needsConnect =
    connected &&
    providers.isSuccess &&
    auth.isSuccess &&
    shouldShowConnectProvider({
      connected,
      providers: providers.data?.providers ?? [],
      authenticated: Boolean(auth.data?.methodId),
      dismissed,
    });

  async function chooseWorkspace() {
    const selected = await pickFolder();
    if (selected) await acpClient.connect(selected);
  }

  function runPaletteAction(item: PaletteItem) {
    if (item.action === "open-folder") return void chooseWorkspace();
    if (item.action === "settings") return setSettingsTab("providers");
    if (item.action === "connect-provider") return setSettingsTab("providers");
    if (item.action === "new-session") return void acpClient.newSession();
    if (item.action === "shortcuts") return setSettingsTab("about");
    if (item.action === "model" && item.value) return void acpClient.setDefaultModel(item.value);
    if (item.action === "session" && item.value) return void acpClient.loadSession(item.value);
    if (item.action === "command" && item.value) {
      useSessionStore.getState().set({ error: null, composerDraft: `/${item.value} ` });
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    }
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
            <button className="ghost-button" onClick={() => setPaletteOpen(true)} aria-label="Command palette">Ctrl K</button>
            <button className="icon-button" onClick={() => setSettingsTab("providers")} aria-label="Settings"><Settings size={18} /></button>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {!cwd ? (
          <Welcome onChooseWorkspace={chooseWorkspace} />
        ) : needsConnect ? (
          <ConnectProvider
            onDone={() => {
              localStorage.setItem(DISMISSED_KEY, "true");
              setDismissed(true);
              void providers.refetch();
              void auth.refetch();
            }}
            onSkip={() => {
              localStorage.setItem(DISMISSED_KEY, "true");
              setDismissed(true);
            }}
          />
        ) : (
          <ChatView />
        )}
      </main>
      {settingsTab && <SettingsPanel initialTab={settingsTab} onClose={() => setSettingsTab(null)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={runPaletteAction} />}
      <PermissionModal />
      <InteractionModal />
    </div>
  );
}

function basename(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
