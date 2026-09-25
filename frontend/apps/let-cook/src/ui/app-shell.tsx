import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { acpClient } from "../acp/client";
import { normalizeError } from "../acp/errors";
import { pickFolder, request } from "../acp/host";
import { shouldShowConnectProvider } from "../acp/provider-presets";
import { listProviders } from "../acp/providers";
import { useActivityStore } from "../state/activity";
import { useToolsPanelStore } from "../state/tools-panel";
import { useArtifactStore } from "../state/artifacts";
import { useCatalogStore } from "../state/catalog";
import { useSessionStore } from "../state/session";
import { AgentHeader } from "./chat/agent-header";
import { ChatView } from "./chat/chat-view";
import { downloadMarkdown, exportFilename, exportTranscriptMarkdown } from "./chat/export-transcript";
import { viewPlan } from "./chat/view-plan";
import { openRecap } from "./chat/view-recap";
import { openRewind } from "./chat/view-rewind";
import { CommandPalette } from "./palette/command-palette";
import type { PaletteItem } from "./palette/palette-items";
import { SessionSidebar } from "./sessions/session-sidebar";
import type { SettingsTab } from "./settings/settings-panel";
import { ShortcutsSheet } from "./shortcuts/shortcuts-sheet";
import { UtilityPanel } from "./utility-panel";
import { ConnectProvider } from "./welcome/connect-provider";
import { Welcome } from "./welcome/welcome";

const SettingsPanel = lazy(() => import("./settings/settings-panel").then(({ SettingsPanel }) => ({ default: SettingsPanel })));

const DISMISSED_KEY = "cook.connectProviderDismissed";
const NOTICE_TIMEOUT_MS = 3_000;
const MIN_CHAT_WIDTH_WITH_TOOLS = 600;
const SETTINGS_TABS = new Set<SettingsTab>(["general", "models", "connectors", "context", "skills", "hooks", "about"]);

function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.has(value as SettingsTab);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function exportActiveTranscript() {
  const store = useSessionStore.getState();
  if (!store.sessionId) {
    store.set({ notice: "No active session to export." });
    return;
  }
  const markdown = exportTranscriptMarkdown(store.blocks);
  if (!markdown) {
    store.set({ notice: "Nothing to export yet." });
    return;
  }
  downloadMarkdown(exportFilename(store.sessionTitle, store.sessionId), markdown);
  store.set({ notice: "Exported conversation as Markdown." });
}

export function AppShell() {
  const cwd = useSessionStore((state) => state.cwd);
  const connection = useSessionStore((state) => state.connection);
  const notice = useSessionStore((state) => state.notice);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsed] = useState(false);
  const [utilityPanelOpen, setUtilityPanelOpen] = useState(false);
  const sidebarWidth = useRef(272);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [settingsCloseRequest, setSettingsCloseRequest] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");
  const activityPanelNonce = useActivityStore((state) => state.panelNonce);
  const toolsPanelNonce = useToolsPanelStore((state) => state.nonce);
  const artifactEpoch = useArtifactStore((state) => state.openEpoch);

  // Keep the chat usable when the resizable sidebar and tools panel compete for a small window.
  // Remember the sidebar's measured width so hiding it cannot make this check oscillate.
  useLayoutEffect(() => {
    if (!cwd || !sidebarOpen || !utilityPanelOpen) {
      setSidebarAutoCollapsed(false);
      return;
    }
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const tools = document.querySelector<HTMLElement>(".utility-panel");
    if (!tools) return;
    const update = () => {
      if (sidebar) sidebarWidth.current = sidebar.getBoundingClientRect().width;
      setSidebarAutoCollapsed(
        window.innerWidth - sidebarWidth.current - tools.getBoundingClientRect().width < MIN_CHAT_WIDTH_WITH_TOOLS,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (sidebar) observer.observe(sidebar);
    observer.observe(tools);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [cwd, sidebarOpen, utilityPanelOpen, sidebarAutoCollapsed]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => {
      useSessionStore.getState().set({ notice: null });
    }, NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (activityPanelNonce > 0) setUtilityPanelOpen(true);
  }, [activityPanelNonce]);

  useEffect(() => {
    if (toolsPanelNonce > 0) setUtilityPanelOpen(true);
  }, [toolsPanelNonce]);

  useEffect(() => {
    if (artifactEpoch > 0) setUtilityPanelOpen(true);
  }, [artifactEpoch]);

  useEffect(() => {
    if (!utilityPanelOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const panel = document.querySelector<HTMLElement>(".utility-panel");
      if (!(event.target instanceof Element) || !panel || panel.contains(event.target)) return;
      if (event.target.closest(".git-chip")) return;
      setUtilityPanelOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [utilityPanelOpen]);

  const pendingSettingsTab = useCatalogStore((state) => state.pendingSettingsTab);

  function openSettings(tab: SettingsTab) {
    setPaletteOpen(false);
    setShortcutsOpen(false);
    setSettingsTab(tab);
  }

  useEffect(() => {
    if (!pendingSettingsTab || !isSettingsTab(pendingSettingsTab)) return;
    openSettings(pendingSettingsTab);
    useCatalogStore.getState().clearPendingSettingsTab();
  }, [pendingSettingsTab]);

  function openShortcuts() {
    setPaletteOpen(false);
    setSettingsTab(null);
    setShortcutsOpen(true);
  }

  useEffect(() => {
    const lastWorkspace = localStorage.getItem("cook.lastWorkspace");
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
        setShortcutsOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.metaKey && key === ",") {
        event.preventDefault();
        openSettings("general");
        return;
      }
      // TUI `ToggleTasks`: the tasks strip opens and closes on Ctrl-G (`ActionId::ToggleTasks`).
      if (event.ctrlKey && !event.shiftKey && key === "g") {
        event.preventDefault();
        useActivityStore.getState().toggleOverlay();
        return;
      }
      if (event.key === "?" && !commandKey && !event.altKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        setPaletteOpen(false);
        setShortcutsOpen((open) => !open);
        return;
      }
      if (commandKey && key === "w") {
        event.preventDefault();
        if (paletteOpen) setPaletteOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
        else if (settingsTab) setSettingsCloseRequest((request) => request + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, settingsTab, shortcutsOpen]);

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
    if (!selected) return;
    try {
      await acpClient.connect(selected);
    } catch {
      // The client has already placed the normalized message in the session store.
    }
  }

  function runPaletteAction(item: PaletteItem) {
    if (item.action === "open-folder") return void chooseWorkspace();
    if (item.action === "settings") return openSettings("general");
    if (item.action === "connect-provider") return openSettings("models");
    if (item.action === "new-session") return void acpClient.newSession();
    // Map ids `C-sess-fork` / `/fork` and `/export`.
    if (item.action === "fork-session") return void acpClient.forkSession().catch((error) => {
      useSessionStore.getState().set({
        error: normalizeError(error, "Could not fork the conversation"),
      });
    });
    if (item.action === "export-transcript") return exportActiveTranscript();
    if (item.action === "view-plan") return viewPlan();
    if (item.action === "open-activity") return useActivityStore.getState().requestOpenPanel();
    if (item.action === "rewind") return openRewind();
    if (item.action === "recap") return void openRecap();
    if (item.action === "shortcuts") return openShortcuts();
    if (item.action === "model" && item.value) return void acpClient.setDefaultModel(item.value);
    if (item.action === "session" && item.value) return void acpClient.loadSession(item.value);
    if (item.action === "command" && item.value) {
      useSessionStore.getState().set({ error: null, composerDraft: `/${item.value} ` });
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    }
  }

  return (
    <div className="app-frame">
      {sidebarOpen && !sidebarAutoCollapsed && cwd && <SessionSidebar onOpenSettings={() => openSettings("general")} onOpenSearch={() => setPaletteOpen(true)} />}
      <main className="main-column">
        <AgentHeader
          sidebarOpen={sidebarOpen && !sidebarAutoCollapsed}
          onToggleSidebar={() => {
            if (utilityPanelOpen && (!sidebarOpen || sidebarAutoCollapsed)) {
              setUtilityPanelOpen(false);
              setSidebarOpen(true);
            } else {
              setSidebarOpen((open) => !open);
            }
          }}
          utilityPanelOpen={utilityPanelOpen}
          onOpenTools={() => setUtilityPanelOpen(true)}
        />
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
      {settingsTab && (
        <Suspense fallback={<div className="settings-panel deferred-panel-loading" role="status">Opening settings…</div>}>
          <SettingsPanel initialTab={settingsTab} closeRequest={settingsCloseRequest} onClose={() => setSettingsTab(null)} />
        </Suspense>
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={runPaletteAction} />}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
