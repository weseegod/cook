import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { acpClient } from "../../acp/client";
import { getConfigSecurity } from "../../acp/host";
import { useSessionStore } from "../../state/session";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { sessionId, modelId, planMode } = useSessionStore();
  const models = useQuery({ queryKey: ["models"], queryFn: () => acpClient.xai.listModels() });
  const configSecurity = useQuery({ queryKey: ["config-security"], queryFn: getConfigSecurity });
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [yolo, setYolo] = useState(() => localStorage.getItem("thanh.alwaysApprove") === "true");
  const selectedModel = modelId ?? localStorage.getItem("thanh.defaultModel") ?? "";

  async function saveApiKey() {
    await acpClient.xai.setApiKey(apiKey, provider || undefined);
    setApiKey("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-panel">
        <div className="settings-heading"><div><span className="eyebrow">Thanh Desktop</span><h2>Settings</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
        <section>
          <h3>Default model</h3>
          <p>Models come from the shared <code>~/.thanh/config.toml</code> catalog.</p>
          <select value={selectedModel} disabled={models.isLoading || models.isError} onChange={(event) => void acpClient.setDefaultModel(event.target.value)}>
            <option value="" disabled>{models.isLoading ? "Loading models…" : "Select model"}</option>
            {models.data?.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}{model.provider ? ` · ${model.provider}` : ""}</option>)}
          </select>
        </section>
        <section>
          <h3>Bring your own key</h3>
          <p>The key is sent to the agent through <code>x.ai/setApiKey</code>; the renderer never edits config files.</p>
          <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Provider (optional)" />
          <label className="secret-field">
            <input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API key" autoComplete="off" />
            <button onClick={() => setShowKey((show) => !show)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </label>
          <button className="primary-button" disabled={!apiKey.trim()} onClick={() => void saveApiKey()}><KeyRound size={15} /> {saved ? "Saved" : "Save key"}</button>
        </section>
        <section>
          <h3>Agent behavior</h3>
          <label className="toggle-row">
            <span><strong>Always approve</strong><small>Allow tools without showing permission prompts.</small></span>
            <input type="checkbox" checked={yolo} onChange={(event) => { setYolo(event.target.checked); void acpClient.setYolo(event.target.checked); }} />
          </label>
          <label className="toggle-row">
            <span><strong>Plan mode</strong><small>Inspect and propose before implementation.</small></span>
            <input type="checkbox" checked={planMode} disabled={!sessionId} onChange={(event) => void acpClient.togglePlan(event.target.checked)} />
          </label>
          <button className="ghost-button" disabled={!sessionId} onClick={() => sessionId && void acpClient.xai.resetPermissions(sessionId)}><ShieldCheck size={15} /> Reset saved permissions</button>
        </section>
        {configSecurity.data?.worldReadable && (
          <div className="settings-note security-warning">Your config is readable by other local users. Run <code>chmod 600 {configSecurity.data.path}</code>.</div>
        )}
        <div className="settings-note">For advanced model/provider configuration, edit <code>~/.thanh/config.toml</code> or use the CLI. Keep it mode 600 if it contains keys.</div>
      </aside>
    </div>
  );
}
