import { useQuery } from "@tanstack/react-query";
import { Cable, Cpu, Info, Monitor, Moon, Palette, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Webhook, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { getConfigSecurity } from "../../acp/host";
import { useModelSelection } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { checkForAppUpdates, UPDATER_CONFIGURED, type UpdateCheckResult } from "../../updater";
import { ConnectorsPanel } from "./connectors";
import { MemoryPanel, ProjectInstructionsPanel, SkillsPanel } from "./context-panels";
import { HooksPanel } from "./hooks-panel";
import { ProvidersPanel } from "./providers";
import { useTheme, type ThemePreference } from "../theme/theme";
import { ConfirmDialog } from "../components/dialog";
import { ToggleSwitch } from "../components/toggle-switch";

export type SettingsTab = "general" | "models" | "connectors" | "context" | "skills" | "hooks" | "about";
type Tab = SettingsTab;

const TABS: Array<{ id: Tab; label: string; description: string; icon: React.ReactNode }> = [
  { id: "general", label: "General", description: "Appearance and behavior", icon: <SlidersHorizontal size={16} /> },
  { id: "models", label: "Models", description: "Providers, connections and model catalog", icon: <Cpu size={16} /> },
  { id: "connectors", label: "Connectors", description: "MCP servers and their tools", icon: <Cable size={16} /> },
  { id: "context", label: "Memory & project", description: "Instructions and memory", icon: <Palette size={16} /> },
  { id: "skills", label: "Skills", description: "Enable or disable discovered skills", icon: <Sparkles size={16} /> },
  { id: "hooks", label: "Hooks", description: "Lifecycle hooks and event log", icon: <Webhook size={16} /> },
  { id: "about", label: "About", description: "Let Cook details", icon: <Info size={16} /> },
];

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; icon: React.ReactNode }> = [
  { id: "system", label: "System", icon: <Monitor size={16} /> },
  { id: "light", label: "Light", icon: <Sun size={16} /> },
  { id: "dark", label: "Dark", icon: <Moon size={16} /> },
];

export function SettingsPanel({ onClose, initialTab = "general", closeRequest = 0 }: { onClose: () => void; initialTab?: Tab; closeRequest?: number }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const planMode = useSessionStore((state) => state.planMode);
  const connection = useSessionStore((state) => state.connection);
  const alwaysApprove = useSessionStore((state) => state.alwaysApprove);
  const connected = connection === "ready";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const { preference, setPreference } = useTheme();
  const { id: selectedModel, known: modelKnown, models } = useModelSelection();
  const configSecurity = useQuery({ queryKey: ["config-security"], queryFn: getConfigSecurity });

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  function closeOrConfirm() {
    if (dirty) setConfirmClose(true);
    else onClose();
  }

  const handledCloseRequest = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest <= handledCloseRequest.current) return;
    handledCloseRequest.current = closeRequest;
    closeOrConfirm();
  }, [closeRequest]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".dialog, .modal")) return;
      event.preventDefault();
      closeOrConfirm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dirty, onClose]);

  function selectTab(next: Tab) {
    if (next === tab) return;
    if (dirty) setPendingTab(next);
    else setTab(next);
  }

  function discardChanges() {
    setDirty(false);
    setConfirmClose(false);
    if (pendingTab) {
      setTab(pendingTab);
      setPendingTab(null);
    } else {
      onClose();
    }
  }

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeOrConfirm()}>
      <aside className="settings-panel" role="dialog" aria-label="Settings">
        <header className="settings-heading">
          <div><h2>Settings</h2></div>
          <button className="icon-button" onClick={closeOrConfirm} aria-label="Close settings"><X size={18} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((entry) => (
              <div className="settings-tab-entry" key={entry.id}>
                <button
                  role="tab"
                  aria-selected={tab === entry.id}
                  title={entry.description}
                  className={tab === entry.id ? "active" : ""}
                  onClick={() => selectTab(entry.id)}
                >
                  <span className="settings-tab-icon">{entry.icon}</span>
                  <span><strong>{entry.label}</strong></span>
                </button>
              </div>
            ))}
          </nav>

          <div className="settings-body">
          {tab === "general" && (
            <>
              <Section title="Appearance" description="Choose between system, light, or dark appearance." icon={<Palette size={15} />}>
                <div className="theme-options" role="radiogroup" aria-label="Theme preference">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={preference === option.id}
                      data-testid={`theme-option-${option.id}`}
                      className={preference === option.id ? "selected" : ""}
                      onClick={() => setPreference(option.id)}
                    >
                      {option.icon}<strong>{option.label}</strong>
                    </button>
                  ))}
                </div>
              </Section>
              <Section title="Behavior" description="Control how Cook handles permissions and planning." icon={<SlidersHorizontal size={15} />}>
                <BehaviorOptions sessionId={sessionId} planMode={planMode} alwaysApprove={alwaysApprove} />
              </Section>
            </>
          )}
          {tab === "models" && (
            <Section title="Models" description="Connect providers and manage the models available in chat." icon={<Cpu size={15} />}>
              <ProvidersPanel connected={connected} models={models} selectedModel={selectedModel} modelKnown={modelKnown} onDirtyChange={setDirty} />
            </Section>
          )}

          {tab === "connectors" && (
            <Section title="MCP connectors" description="Manage tools provided by MCP servers." icon={<Cable size={15} />}>
              <ConnectorsPanel connected={connected} onDirtyChange={setDirty} />
            </Section>
          )}

          {tab === "context" && (
            <>
              <Section title="Project instructions" description="Edit instruction files loaded for this workspace." icon={<Sparkles size={15} />}>
                <ProjectInstructionsPanel connected={connected} onDirtyChange={setDirty} />
              </Section>
              <Section title="Memory" description="Manage Cook's saved workspace memory." icon={<Sparkles size={15} />}>
                <MemoryPanel connected={connected} />
              </Section>
            </>
          )}

          {tab === "skills" && (
            <Section title="Skills and plugins" description="Enable skills discovered in this workspace." icon={<Sparkles size={15} />}>
              <SkillsPanel connected={connected} />
            </Section>
          )}

          {tab === "hooks" && (
            <Section title="Hooks" description="Trust, enable, and inspect lifecycle hooks." icon={<Webhook size={15} />}>
              <HooksPanel connected={connected} />
            </Section>
          )}

          {tab === "about" && (
            <Section title="About" description="Let Cook version and keyboard shortcuts." icon={<Info size={15} />}>
              <div className="about-summary">
                <img src="/logo.svg" alt="" width={36} height={36} />
                <strong>Let Cook</strong>
                <span>Version {__APP_VERSION__}</span>
              </div>
              <AboutUpdates />
              <div className="shortcut-list" aria-label="Keyboard shortcuts">
                <span><kbd>⌘K</kbd> Search everything</span>
                <span><kbd>⌘,</kbd> Settings</span>
                <span><kbd>⌘W</kbd> Close current panel</span>
                <span><kbd>Esc</kbd> Cancel</span>
              </div>
              <div className="settings-note">
                macOS builds for this fork ship unsigned (same as the CLI). The app updater
                refreshes the desktop shell only and never writes <code>~/.cook/bin/cook</code>.
                An optional bundled <code>cook</code> sidecar may appear in stable packages;
                otherwise install the CLI or set <code>COOK_BIN</code>.
                Site: <a href="https://letcook.dev" target="_blank" rel="noreferrer">letcook.dev</a>.
              </div>
              {configSecurity.data?.worldReadable && (
                <div className="settings-note security-warning">
                  Config permissions need attention: <code>chmod 600 {configSecurity.data.path}</code>
                </div>
              )}
              {!configSecurity.data?.exists && <p className="settings-note">No config file yet.</p>}
            </Section>
          )}
        </div>
        </div>
      </aside>
      {(confirmClose || pendingTab) && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          description="Your edits have not been saved. Leave this section and discard them?"
          confirmLabel="Discard changes"
          cancelLabel="Stay"
          danger
          onCancel={() => { setConfirmClose(false); setPendingTab(null); }}
          onConfirm={discardChanges}
        />
      )}
    </div>
  );
}

function Section({ title, description, icon, children }: { title: string; description?: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3 title={description}>{icon} {title}</h3>
      {description && <p className="settings-section-description">{description}</p>}
      {children}
    </section>
  );
}

function AboutUpdates() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  async function onCheck() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await checkForAppUpdates());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="about-updates">
      <button
        type="button"
        className="ghost-button"
        disabled={!UPDATER_CONFIGURED || busy}
        title={
          UPDATER_CONFIGURED
            ? "Check for Let Cook shell updates"
            : "Updater endpoints are not configured for this build"
        }
        onClick={() => void onCheck()}
      >
        <RefreshCw size={15} /> {busy ? "Checking…" : "Check for updates"}
      </button>
      {!UPDATER_CONFIGURED && (
        <p className="settings-note">
          Auto-update is wired but inactive until a release pubkey and endpoint are set
          in <code>tauri.conf.json</code> (and <code>UPDATER_CONFIGURED</code> in{" "}
          <code>src/updater.ts</code>).
        </p>
      )}
      {result?.status === "up-to-date" && <p className="settings-note">You are on the latest desktop build.</p>}
      {result?.status === "available" && (
        <p className="settings-note">
          Update available: <strong>{result.version}</strong>
          {result.notes ? ` — ${result.notes}` : ""}. Download from the release page; the
          updater never touches the CLI binary.
        </p>
      )}
      {result?.status === "error" && <p className="settings-note">{result.message}</p>}
    </div>
  );
}

function BehaviorOptions({ sessionId, planMode, alwaysApprove }: { sessionId: string | null; planMode: boolean; alwaysApprove: boolean }) {
  return (
    <>
      <div className="toggle-row">
        <span title="Run tools without permission prompts."><strong>Always approve</strong></span>
        <ToggleSwitch checked={alwaysApprove} ariaLabel="Always approve" onChange={(checked) => void acpClient.setYolo(checked)} />
      </div>
      <div className="toggle-row">
        <span title="Inspect and propose before changing files."><strong>Plan mode</strong></span>
        <ToggleSwitch checked={planMode} ariaLabel="Plan mode" onChange={(checked) => void acpClient.setPlanMode(checked)} />
      </div>
      <button className="ghost-button" disabled={!sessionId} onClick={() => sessionId && void acpClient.xai.resetPermissions(sessionId)}>
        <ShieldCheck size={15} /> Reset permissions
      </button>
    </>
  );
}
