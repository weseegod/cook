import { ArrowLeft, CheckCircle2, MessageSquareCode, Sparkles } from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProviders, setDefaultModel, type ProviderPreset } from "../../acp/providers";
import { PresetGrid, ProviderEditor } from "../settings/provider-form";
import { useProviderPresets } from "../settings/providers";

/**
 * First-run connect flow, shown instead of the chat when no usable provider is configured.
 * Steps: pick a provider card → key or env var → Test → pick the default model → empty chat.
 */
export function ConnectProvider({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const { presets } = useProviderPresets();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [defaultModel, setDefaultModelId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const providers = useQuery({
    queryKey: ["providers", "onboarding"],
    queryFn: listProviders,
    enabled: savedId !== null,
  });
  const saved = providers.data?.providers.find((provider) => provider.id === savedId) ?? null;

  async function finish() {
    if (!defaultModel) {
      onDone();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setDefaultModel(defaultModel);
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="connect-provider" data-testid="connect-provider">
      <header className="connect-header">
        <div className="welcome-mark"><Sparkles size={26} /></div>
        <h1>Connect a provider</h1>
        <p>
          Thanh Desktop talks to the same agent as the CLI. Bring a key for DeepSeek, OpenRouter,
          OpenAI, Anthropic, Google, Groq, Mistral, Moonshot, Together, Fireworks, or a local model —
          no <code>config.toml</code> editing.
        </p>
      </header>

      {!preset && (
        <>
          <PresetGrid presets={presets} onPick={(picked) => { setPreset(picked); setSavedId(null); setDefaultModelId(""); }} />
          <button className="ghost-button connect-skip" onClick={onSkip} data-testid="connect-skip">
            <MessageSquareCode size={15} /> Skip for now — I already have a working config
          </button>
        </>
      )}

      {preset && !savedId && (
        <>
          <button className="ghost-button connect-back" onClick={() => setPreset(null)}><ArrowLeft size={15} /> All providers</button>
          <ProviderEditor
            preset={preset}
            onSaved={(id) => setSavedId(id)}
            onCancel={() => setPreset(null)}
          />
        </>
      )}

      {preset && savedId && saved && (
        <div className="connect-step" data-testid="connect-default-step">
          <h2><CheckCircle2 size={17} /> {preset.label} is connected</h2>
          <p>Pick the model new conversations should start with.</p>
          <select
            value={defaultModel || saved.models[0]?.id || ""}
            aria-label="Default model"
            onChange={(event) => setDefaultModelId(event.target.value)}
            data-testid="connect-default-model"
          >
            {saved.models.map((model) => (
              <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
            ))}
          </select>
          <div className="settings-actions">
            <button className="primary-button" disabled={saving} onClick={() => void finish()} data-testid="connect-finish">
              Start chatting
            </button>
          </div>
          {error && <p className="settings-note security-warning">{error}</p>}
        </div>
      )}
    </section>
  );
}
