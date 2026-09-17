import { useQuery } from "@tanstack/react-query";
import { Cable, Cpu, Eye, EyeOff, Info, KeyRound, Monitor, Moon, Palette, ShieldCheck, SlidersHorizontal, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { getConfigSecurity } from "../../acp/host";
import { groupByProvider } from "../../acp/xai";
import { useModelSelection } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { ConnectorsPanel } from "./connectors";
import { MemoryPanel, ProjectInstructionsPanel, SkillsPanel } from "./context-panels";
import { ProvidersPanel } from "./providers";
import { useTheme, type ThemePreference } from "../theme/theme";
import { ConfirmDialog } from "../components/dialog";
import { ToggleSwitch } from "../components/toggle-switch";

type Tab = "general" | "providers" | "models" | "connectors" | "context" | "skills" | "about";

const TABS: Array<{ id: Tab; label: string; description: string; icon: React.ReactNode }> = [
  { id: "general", label: "General", description: "Appearance and behavior", icon: <SlidersHorizontal size={16} /> },
  { id: "providers", label: "Providers", description: "Connections and API keys", icon: <Sparkles size={16} /> },
  { id: "models", label: "Models", description: "Defaults and catalog", icon: <Cpu size={16} /> },
  { id: "connectors", label: "Connectors", description: "MCP servers and tools", icon: <Cable size={16} /> },
  { id: "context", label: "Memory & project", description: "Instructions and memory", icon: <Palette size={16} /> },
  { id: "skills", label: "Skills", description: "Skills and plugins", icon: <Sparkles size={16} /> },
  { id: "about", label: "About", description: "Thanh Desktop details", icon: <Info size={16} /> },
];

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; icon: React.ReactNode }> = [
  { id: "system", label: "System", icon: <Monitor size={16} /> },
  { id: "light", label: "Light", icon: <Sun size={16} /> },
  { id: "dark", label: "Dark", icon: <Moon size={16} /> },
];

export function SettingsPanel({ onClose, initialTab = "general", closeRequest = 0 }: { onClose: () => void; initialTab?: Tab; closeRequest?: number }) {
  const { sessionId, planMode, connection, alwaysApprove } = useSessionStore();
  const connected = connection === "ready";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const { preference, setPreference } = useTheme();
  const { id: selectedModel, known: modelKnown, models } = useModelSelection();
  const configSecurity = useQuery({ queryKey: ["config-security"], queryFn: getConfigSecurity });
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  async function saveApiKey() {
    await acpClient.xai.setApiKey(apiKey, provider || undefined);
    setApiKey("");
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

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
          <div><span className="eyebrow">Thanh Desktop</span><h2>Settings</h2></div>
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
            <div className="settings-detail-heading">
              <span className="settings-detail-icon">{TABS.find((entry) => entry.id === tab)?.icon}</span>
              <h3 title={TABS.find((entry) => entry.id === tab)?.description}>
                {TABS.find((entry) => entry.id === tab)?.label}
              </h3>
            </div>
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
              <Section title="Behavior" description="Control how Thanh handles permissions and planning." icon={<SlidersHorizontal size={15} />}>
                <BehaviorOptions sessionId={sessionId} planMode={planMode} alwaysApprove={alwaysApprove} />
              </Section>
            </>
          )}
          {tab === "providers" && (
            <>
              <Section title="Providers" description="Configure model providers and credentials." icon={<Sparkles size={15} />}>
                <ProvidersPanel connected={connected} onDirtyChange={setDirty} />
              </Section>
              <Section title="Session key" description="Set a temporary xAI session key." icon={<KeyRound size={15} />}>
                <input value={provider} onChange={(event) => { setProvider(event.target.value); setDirty(true); }} placeholder="Provider id (optional)" aria-label="Provider id" />
                <label className="secret-field">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => { setApiKey(event.target.value); setDirty(true); }}
                    placeholder="xAI API key"
                    aria-label="xAI API key"
                    autoComplete="off"
                  />
                  <button onClick={() => setShowKey((show) => !show)} aria-label="Toggle key visibility">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </label>
                <button className="primary-button" disabled={!apiKey.trim()} onClick={() => void saveApiKey()}>
                  <KeyRound size={15} /> {saved ? "Saved" : "Save key"}
                </button>
              </Section>
            </>
          )}

          {tab === "models" && (
            <Section title="Default model" description="Choose the model used for new conversations." icon={<Cpu size={15} />}>
              <select
                value={selectedModel}
                aria-label="Default model"
                data-testid="settings-default-model"
                disabled={models.length === 0}
                onChange={(event) => void acpClient.setDefaultModel(event.target.value)}
              >
                {!modelKnown && (
                  <option value={selectedModel} disabled>
                    {models.length === 0 ? "Loading models…" : selectedModel || "Select model"}
                  </option>
                )}
                {groupByProvider(models).map(([providerId, entries]) => (
                  <optgroup key={providerId} label={providerId}>
                    {entries.map((model) => (
                      <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
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
              <Section title="Memory" description="Manage Thanh's saved workspace memory." icon={<Sparkles size={15} />}>
                <MemoryPanel connected={connected} />
              </Section>
            </>
          )}

          {tab === "skills" && (
            <Section title="Skills and plugins" description="Enable skills discovered in this workspace." icon={<Sparkles size={15} />}>
              <SkillsPanel connected={connected} />
            </Section>
          )}

          {tab === "about" && (
            <Section title="About" description="Thanh Desktop version and keyboard shortcuts." icon={<Info size={15} />}>
              <div className="about-summary">
                <strong>Thanh Desktop</strong>
                <span>Version {__APP_VERSION__}</span>
              </div>
              <div className="shortcut-list" aria-label="Keyboard shortcuts">
                <span><kbd>⌘K</kbd> Search everything</span>
                <span><kbd>⌘,</kbd> Settings</span>
                <span><kbd>⌘W</kbd> Close current panel</span>
                <span><kbd>Esc</kbd> Cancel</span>
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
      {children}
    </section>
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
