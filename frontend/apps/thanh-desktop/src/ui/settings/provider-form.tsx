import { CheckCircle2, Download, KeyRound, LoaderCircle, Plug, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  formFromPreset,
  formFromProvider,
  formToUpsertRequest,
  validateProviderForm,
  type ProviderFormState,
} from "../../acp/provider-presets";
import {
  discoverProviderModels,
  testProvider,
  upsertProvider,
  type ProviderPreset,
  type ProviderSummary,
  type ProviderTestResult,
} from "../../acp/providers";
import { InfoTip } from "../components/info-tip";
import { ToggleSwitch } from "../components/toggle-switch";

interface EditorProps {
  preset: ProviderPreset;
  provider?: ProviderSummary;
  showDefaultModel?: boolean;
  /** Called with the saved provider id. */
  onSaved: (id: string) => void;
  onCancel?: () => void;
}

/**
 * One provider's form: URL, credential (inline key or env var name), Test, models, save.
 * Shared by Settings → Providers and the first-run connect flow.
 */
export function ProviderEditor({ preset, provider, showDefaultModel = true, onSaved, onCancel }: EditorProps) {
  const [form, setForm] = useState<ProviderFormState>(() =>
    provider ? formFromProvider(provider) : formFromPreset(preset),
  );
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [busy, setBusy] = useState<"test" | "discover" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const preset_ = preset;
  const validation = useMemo(
    () => validateProviderForm(form, { requireKey: !form.keepExistingKey }),
    [form],
  );
  const patch = (next: Partial<ProviderFormState>) => setForm((current) => ({ ...current, ...next }));

  async function runTest() {
    setBusy("test");
    setError(null);
    try {
      const result = await testProvider({
        id: form.presetId,
        baseUrl: form.baseUrl,
        apiBackend: form.apiBackend,
        ...(form.credential === "inline" && form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.credential === "env" && form.envKey.trim() ? { envKey: form.envKey.trim() } : {}),
      });
      setTest(result);
    } catch (caught) {
      setTest(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runDiscover() {
    setBusy("discover");
    setError(null);
    try {
      const result = await discoverProviderModels({
        id: form.presetId,
        baseUrl: form.baseUrl,
        apiBackend: form.apiBackend,
        ...(form.credential === "inline" && form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.credential === "env" && form.envKey.trim() ? { envKey: form.envKey.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? "model discovery failed");
      } else {
        setDiscovered(result.discovered.map((model) => model.id));
        patch({ customModelIds: [...new Set([...form.customModelIds, ...result.discovered.map((model) => model.id)])] });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await upsertProvider(formToUpsertRequest(form, preset_));
      onSaved(form.presetId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="provider-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.ok) void save();
      }}
    >
      <header>
        <h3>{preset_.label} <InfoTip label={preset_.label}>{preset_.help}</InfoTip></h3>
        {provider && <span className="provider-existing">Saved</span>}
      </header>

      <label className="field">
        <span>Base URL</span>
        <input
          value={form.baseUrl}
          aria-label="Base URL"
          placeholder="https://api.example.com/v1"
          onChange={(event) => patch({ baseUrl: event.target.value })}
        />
        {validation.errors.baseUrl && <small className="field-error">{validation.errors.baseUrl}</small>}
      </label>

      <div className="field">
        <span>API backend</span>
        <select value={form.apiBackend} aria-label="API backend" onChange={(event) => patch({ apiBackend: event.target.value })}>
          <option value="chat_completions">chat_completions (OpenAI-compatible)</option>
          <option value="messages">messages (Anthropic)</option>
          <option value="responses">responses (OpenAI Responses)</option>
        </select>
      </div>

      <div className="field">
        <span>Credential</span>
        <div className="segmented">
          <button type="button" className={form.credential === "inline" ? "active" : ""} onClick={() => patch({ credential: "inline" })}>
            Paste API key
          </button>
          <button type="button" className={form.credential === "env" ? "active" : ""} onClick={() => patch({ credential: "env" })}>
            Use environment variable
          </button>
        </div>
        {form.credential === "inline" ? (
          <>
            <input
              type="password"
              value={form.apiKey}
              aria-label="API key"
              autoComplete="off"
              placeholder={form.keepExistingKey ? "Leave blank to keep the saved key" : "sk-…"}
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
            {validation.errors.apiKey && <small className="field-error">{validation.errors.apiKey}</small>}
          </>
        ) : (
          <>
            <input
              value={form.envKey}
              aria-label="Environment variable"
              placeholder={preset_.envKey ?? "MY_PROVIDER_API_KEY"}
              onChange={(event) => patch({ envKey: event.target.value })}
            />
            {validation.errors.envKey && <small className="field-error">{validation.errors.envKey}</small>}
          </>
        )}
      </div>

      {preset_.models.length > 0 && (
        <div className="field">
          <span>Models</span>
          <div className="model-checklist">
            {preset_.models.map((model) => (
              <label key={model.id}>
                <ToggleSwitch
                  checked={form.selectedModels.includes(model.id)}
                  ariaLabel={`Toggle model ${model.name}`}
                  onChange={(checked) =>
                    patch({
                      selectedModels: checked
                        ? [...form.selectedModels, model.id]
                        : form.selectedModels.filter((id) => id !== model.id),
                    })
                  }
                />
                <span>{model.name}</span>
                <small>{model.id}</small>
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="field">
        <span>Extra model IDs</span>
        <textarea
          rows={2}
          value={form.customModelIds.join("\n")}
          aria-label="Additional model ids"
          placeholder="my-model-id"
          onChange={(event) => patch({ customModelIds: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })}
        />
        {validation.errors.models && <small className="field-error">{validation.errors.models}</small>}
      </label>

      {showDefaultModel && (
        <label className="toggle-row">
          <span><strong>Set as default model</strong></span>
          <ToggleSwitch checked={form.setAsDefault} ariaLabel="Set as default model" onChange={(checked) => patch({ setAsDefault: checked })} />
        </label>
      )}

      <div className="provider-actions">
        <button type="button" className="ghost-button" disabled={busy !== null} onClick={() => void runTest()} data-testid="provider-test">
          {busy === "test" ? <LoaderCircle className="spin" size={15} /> : <Plug size={15} />} Test
        </button>
        <button type="button" className="ghost-button" disabled={busy !== null} onClick={() => void runDiscover()} data-testid="provider-discover">
          {busy === "discover" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} Discover models
        </button>
        <button type="submit" className="primary-button" disabled={!validation.ok || busy !== null} data-testid="provider-save">
          {busy === "save" ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />} Save provider
        </button>
        {onCancel && <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>}
      </div>

      {test && (
        <div className={`provider-test-result ${test.ok ? "ok" : "fail"}`} data-testid="provider-test-result" role="status">
          {test.ok ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
          <div>
            <strong>{test.ok ? `Connected (HTTP ${test.status})` : `Failed${test.status ? ` (HTTP ${test.status})` : ""}`}</strong>
            <small>{test.ok ? `${test.url} · ${test.latencyMs} ms` : test.error}</small>
          </div>
        </div>
      )}
      {discovered.length > 0 && (
        <p className="provider-help" data-testid="provider-discovered">{discovered.length} models found: {discovered.join(", ")}</p>
      )}
      {error && <div className="settings-note security-warning" data-testid="provider-error">{error}</div>}
      {!validation.ok && Object.keys(validation.errors).length > 0 && (
        <p className="field-error">Check the highlighted fields.</p>
      )}
    </form>
  );
}

export function PresetGrid({ presets, onPick }: { presets: ProviderPreset[]; onPick: (preset: ProviderPreset) => void }) {
  return (
    <div className="preset-grid">
      {presets.map((preset) => (
        <button type="button" key={preset.id} className="preset-card" onClick={() => onPick(preset)} data-testid={`preset-${preset.id}`}>
          <span className="preset-mark">{preset.label.slice(0, 2).toUpperCase()}</span>
          <span className="preset-card-copy">
            <strong>{preset.label}</strong>
            <small title={preset.baseUrl ?? "your own endpoint"}>{preset.baseUrl ?? "your own endpoint"}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
