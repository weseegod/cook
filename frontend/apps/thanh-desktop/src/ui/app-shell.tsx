import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, PanelRight } from "lucide-react";
import { acpClient } from "../acp/client";
import { pickFolder, request } from "../acp/host";
import { shouldShowConnectProvider } from "../acp/provider-presets";
import { listProviders } from "../acp/providers";
import { useSessionStore } from "../state/session";
import { ChatView } from "./chat/chat-view";
import { ProcessStatus } from "./chat/process-status";
import { CommandPalette } from "./palette/command-palette";
import type { PaletteItem } from "./palette/palette-items";
import { SessionSidebar } from "./sessions/session-sidebar";
import { SettingsPanel } from "./settings/settings-panel";
import { UtilityPanel } from "./utility-panel";
import { ConnectProvider } from "./welcome/connect-provider";
import { Welcome } from "./welcome/welcome";

const DISMISSED_KEY = "thanh.connectProviderDismissed";
type SettingsTab = "general" | "providers" | "models" | "connectors" | "context" | "skills" | "about";

export function AppShell() {
  const { cwd, connection } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [utilityPanelOpen, setUtilityPanelOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [settingsCloseRequest, setSettingsCloseRequest] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");

  function openSettings(tab: SettingsTab) {
    setPaletteOpen(false);
    setSettingsTab(tab);
  }

  useEffect(() => {
    const lastWorkspace = localStorage.getItem("thanh.lastWorkspace");
    if (lastWorkspace) void acpClient.connect(lastWorkspace).catch(() => undefined);
    const onBeforeUnload = () => void acpClient.dispose();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (document.querySelector(".dialog, .modal")) return;
      if (commandKey && key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.metaKey && key === ",") {
        event.preventDefault();
        openSettings("general");
        return;
      }
      if (commandKey && key === "w") {
        event.preventDefault();
        if (paletteOpen) setPaletteOpen(false);
        else if (settingsTab) setSettingsCloseRequest((request) => request + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, settingsTab]);

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
    if (item.action === "settings") return openSettings("general");
    if (item.action === "connect-provider") return openSettings("providers");
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
      {sidebarOpen && cwd && <SessionSidebar onOpenSettings={() => openSettings("general")} onOpenSearch={() => setPaletteOpen(true)} />}
      <main className="main-column">
        <header className="processbar">
          <button className="icon-button" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle sessions">
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <ProcessStatus />
          <div className="processbar-actions">
            {cwd && !utilityPanelOpen && (
              <button
                className="icon-button"
                onClick={() => setUtilityPanelOpen((open) => !open)}
                aria-label="Open tools panel"
                title="Open tools panel"
              >
                <PanelRight size={17} />
              </button>
            )}
          </div>
        </header>
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
      {cwd && utilityPanelOpen && <UtilityPanel onClose={() => setUtilityPanelOpen(false)} />}
      {settingsTab && <SettingsPanel initialTab={settingsTab} closeRequest={settingsCloseRequest} onClose={() => setSettingsTab(null)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={runPaletteAction} />}
    </div>
  );
}
