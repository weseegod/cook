import { useQuery } from "@tanstack/react-query";
import { Cable, Cpu, Eye, EyeOff, Info, KeyRound, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { acpClient } from "../../acp/client";
import { getConfigSecurity } from "../../acp/host";
import { useSessionStore } from "../../state/session";
import { ConnectorsPanel } from "./connectors";
import { MemoryPanel, ProjectInstructionsPanel, SkillsPanel } from "./context-panels";
import { ProvidersPanel, useProviders } from "./providers";

type Tab = "providers" | "models" | "connectors" | "context" | "skills" | "about";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "connectors", label: "Connectors" },
  { id: "context", label: "Memory & project" },
  { id: "skills", label: "Skills" },
  { id: "about", label: "About" },
];

export function SettingsPanel({ onClose, initialTab = "providers" }: { onClose: () => void; initialTab?: Tab }) {
  const { sessionId, modelId, planMode, connection } = useSessionStore();
  const connected = connection === "ready";
  const [tab, setTab] = useState<Tab>(initialTab);
  const models = useQuery({ queryKey: ["models"], queryFn: () => acpClient.xai.listModels(), enabled: connected });
  const configSecurity = useQuery({ queryKey: ["config-security"], queryFn: getConfigSecurity });
  const providers = useProviders(connected);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [yolo, setYolo] = useState(() => localStorage.getItem("thanh.alwaysApprove") === "true");
  const selectedModel = modelId ?? models.data?.find((model) => model.isDefault)?.id ?? "";

  async function saveApiKey() {
    await acpClient.xai.setApiKey(apiKey, provider || undefined);
    setApiKey("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-panel" role="dialog" aria-label="Settings">
        <div className="settings-heading">
          <div><span className="eyebrow">Thanh Desktop</span><h2>Settings</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </div>
        <nav className="settings-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "active" : ""}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === "providers" && (
            <>
              <Section title="Provider connections" icon={<Sparkles size={15} />}>
                <p className="settings-note">
                  Keys are written to <code>config.toml</code> by the agent — never by this window.
                  {(providers.data?.providers.length ?? 0) > 0 ? ` ${providers.data?.providers.length} configured.` : ""}
                </p>
                <ProvidersPanel connected={connected} />
              </Section>
              <Section title="Advanced / legacy key" icon={<KeyRound size={15} />}>
                <p className="settings-note">
                  <code>x.ai/setApiKey</code> with a provider name writes that provider's key row; without one it sets the xAI session key.
                </p>
                <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Provider id (optional)" aria-label="Provider id" />
                <label className="secret-field">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
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
            <Section title="Default model" icon={<Cpu size={15} />}>
              <p className="settings-note">
                Models come from the agent's catalog, grouped by provider. The default is persisted in
                <code> config.toml</code> so it survives a reload.
              </p>
              <select
                value={selectedModel}
                aria-label="Default model"
                data-testid="settings-default-model"
                disabled={models.isLoading || models.isError}
                onChange={(event) => void acpClient.setDefaultModel(event.target.value)}
              >
                <option value="" disabled>{models.isLoading ? "Loading models…" : "Select model"}</option>
                {groupByProvider(models.data ?? []).map(([providerId, entries]) => (
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
            <Section title="MCP connectors" icon={<Cable size={15} />}>
              <ConnectorsPanel connected={connected} />
            </Section>
          )}

          {tab === "context" && (
            <>
              <Section title="Project instructions" icon={<Sparkles size={15} />}>
                <ProjectInstructionsPanel connected={connected} />
              </Section>
              <Section title="Memory" icon={<Sparkles size={15} />}>
                <MemoryPanel connected={connected} />
              </Section>
            </>
          )}

          {tab === "skills" && (
            <Section title="Skills and plugins" icon={<Sparkles size={15} />}>
              <SkillsPanel connected={connected} />
            </Section>
          )}

          {tab === "about" && (
            <Section title="Agent behavior" icon={<Info size={15} />}>
              <label className="toggle-row">
                <span><strong>Always approve</strong><small>Allow tools without showing permission prompts.</small></span>
                <input type="checkbox" checked={yolo} onChange={(event) => { setYolo(event.target.checked); void acpClient.setYolo(event.target.checked); }} />
              </label>
              <label className="toggle-row">
                <span><strong>Plan mode</strong><small>Inspect and propose before implementation.</small></span>
                <input type="checkbox" checked={planMode} disabled={!sessionId} onChange={(event) => void acpClient.togglePlan(event.target.checked)} />
              </label>
              <button className="ghost-button" disabled={!sessionId} onClick={() => sessionId && void acpClient.xai.resetPermissions(sessionId)}>
                <ShieldCheck size={15} /> Reset saved permissions
              </button>
              {configSecurity.data?.worldReadable && (
                <div className="settings-note security-warning">
                  Your config is readable by other local users. Run <code>chmod 600 {configSecurity.data.path}</code>.
                </div>
              )}
              {!configSecurity.data?.exists && <p className="settings-note">No <code>config.toml</code> yet; connecting a provider creates one.</p>}
            </Section>
          )}
        </div>
      </aside>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{icon} {title}</h3>
      {children}
    </section>
  );
}

/** Group catalog models by provider for the picker (`undefined` becomes `xai`). */
export function groupByProvider<T extends { provider?: string }>(models: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const key = model.provider ?? "xai";
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
