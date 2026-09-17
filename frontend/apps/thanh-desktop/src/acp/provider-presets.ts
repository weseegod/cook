/**
 * Renderer-side mirror of the agent's `x.ai/providers/presets` catalog, plus the pure
 * form→request mapping and validation used by the Providers settings panel and the
 * first-run connect flow.
 *
 * The mirror keeps the cards working offline and under the browser test transport; when the
 * agent answers `x.ai/providers/presets`, that response wins (see `useProviderPresets`).
 */
import type { ProviderPreset, ProviderUpsertRequest } from "./providers";

const text = ["text"];
const textImage = ["text", "image"];

function preset(
  id: string,
  label: string,
  baseUrl: string | null,
  apiBackend: ProviderPreset["apiBackend"],
  envKey: string | null,
  help: string,
  models: ProviderPreset["models"],
  extraHeaders: Record<string, string> = {},
): ProviderPreset {
  return { id, label, baseUrl, apiBackend, envKey, help, discover: true, extraHeaders, models };
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  preset("openai", "OpenAI", "https://api.openai.com/v1", "chat_completions", "OPENAI_API_KEY", "Create a key at platform.openai.com/api-keys", [
    { id: "gpt-5", model: "gpt-5", name: "GPT-5", input: textImage },
    { id: "gpt-4.1", model: "gpt-4.1", name: "GPT-4.1", input: textImage },
    { id: "o4-mini", model: "o4-mini", name: "o4-mini", input: text },
  ]),
  preset("anthropic", "Anthropic", "https://api.anthropic.com/v1", "messages", "ANTHROPIC_API_KEY", "Create a key at console.anthropic.com", [
    { id: "claude-opus-4-6", model: "claude-opus-4-6", name: "Claude Opus", input: textImage },
    { id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", name: "Claude Sonnet", input: textImage },
    { id: "claude-haiku-4-5", model: "claude-haiku-4-5", name: "Claude Haiku", input: textImage },
  ], { "anthropic-version": "2023-06-01" }),
  preset("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "chat_completions", "OPENROUTER_API_KEY", "Create a key at openrouter.ai/keys", [
    { id: "anthropic/claude-sonnet-4.6", model: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", input: textImage },
    { id: "deepseek/deepseek-chat", model: "deepseek/deepseek-chat", name: "DeepSeek Chat", input: text },
  ]),
  preset("deepseek", "DeepSeek", "https://api.deepseek.com", "chat_completions", "DEEPSEEK_API_KEY", "Create a key at platform.deepseek.com", [
    { id: "deepseek-chat", model: "deepseek-chat", name: "DeepSeek Chat", input: text },
    { id: "deepseek-reasoner", model: "deepseek-reasoner", name: "DeepSeek Reasoner", input: text },
  ]),
  preset("zai", "Z.ai", "https://api.z.ai/api/paas/v4/", "chat_completions", "ZAI_API_KEY", "Create a key at z.ai", [
    { id: "glm-5.1", model: "glm-5.1", name: "GLM-5.1", input: text },
    { id: "glm-5", model: "glm-5", name: "GLM-5", input: text },
    { id: "glm-4.7", model: "glm-4.7", name: "GLM-4.7", input: text },
  ]),
  preset("xai", "xAI", "https://api.x.ai/v1", "chat_completions", "XAI_API_KEY", "Create a key at console.x.ai, or run `thanh login` for session auth", [
    { id: "grok-4.5", model: "grok-4.5", name: "Grok 4.5", input: textImage },
    { id: "grok-4.5-mini", model: "grok-4.5-mini", name: "Grok 4.5 Mini", input: textImage },
  ]),
  preset("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "chat_completions", "GEMINI_API_KEY", "Create a key at aistudio.google.com/apikey", [
    { id: "gemini-2.5-pro", model: "gemini-2.5-pro", name: "Gemini 2.5 Pro", input: textImage },
    { id: "gemini-2.5-flash", model: "gemini-2.5-flash", name: "Gemini 2.5 Flash", input: textImage },
  ]),
  preset("groq", "Groq", "https://api.groq.com/openai/v1", "chat_completions", "GROQ_API_KEY", "Create a key at console.groq.com/keys", []),
  preset("mistral", "Mistral", "https://api.mistral.ai/v1", "chat_completions", "MISTRAL_API_KEY", "Create a key at console.mistral.ai", []),
  preset("moonshot", "Moonshot / Kimi", "https://api.moonshot.ai/v1", "chat_completions", "MOONSHOT_API_KEY", "Create a key at platform.moonshot.ai", [
    { id: "kimi-k2.6", model: "kimi-k2.6", name: "Kimi K2.6", input: text },
    { id: "kimi-k3", model: "kimi-k3", name: "Kimi K3", input: text },
  ]),
  preset("together", "Together", "https://api.together.xyz/v1", "chat_completions", "TOGETHER_API_KEY", "Create a key at api.together.ai/settings/api-keys", []),
  preset("fireworks", "Fireworks", "https://api.fireworks.ai/inference/v1", "chat_completions", "FIREWORKS_API_KEY", "Create a key at fireworks.ai/account/api-keys", []),
  preset("ollama", "Ollama (local)", "http://127.0.0.1:11434/v1", "chat_completions", null, "Runs locally; no API key required", []),
  preset("custom", "OpenAI-compatible", null, "chat_completions", null, "Any OpenAI-compatible endpoint: paste its base URL and a model id", []),
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((entry) => entry.id === id);
}

export interface ProviderFormState {
  /** Preset id, or `custom` for a user URL. */
  presetId: string;
  baseUrl: string;
  apiBackend: string;
  /** `env` uses `envKey`; `inline` requires the user to type a key. */
  credential: "inline" | "env";
  apiKey: string;
  envKey: string;
  /** Catalog ids the user selected from the preset seeds. */
  selectedModels: string[];
  /** Extra catalog ids typed in by hand (custom endpoints). */
  customModelIds: string[];
  /** Keep the existing secret when editing a provider that already has one. */
  keepExistingKey: boolean;
  setAsDefault: boolean;
}

export function formFromPreset(preset: ProviderPreset): ProviderFormState {
  return {
    presetId: preset.id,
    baseUrl: preset.baseUrl ?? "",
    apiBackend: preset.apiBackend,
    credential: "inline",
    apiKey: "",
    envKey: preset.envKey ?? "",
    selectedModels: preset.models.map((model) => model.id),
    customModelIds: [],
    keepExistingKey: false,
    setAsDefault: false,
  };
}

export function formFromProvider(
  provider: { id: string; baseUrl?: string | null; apiBackend?: string | null; envKey?: string | null; inlineKey: boolean },
): ProviderFormState {
  const base = findPreset(provider.id);
  return {
    presetId: base ? provider.id : "custom",
    baseUrl: provider.baseUrl ?? base?.baseUrl ?? "",
    apiBackend: provider.apiBackend ?? base?.apiBackend ?? "chat_completions",
    credential: provider.inlineKey ? "inline" : "env",
    apiKey: "",
    envKey: provider.envKey ?? base?.envKey ?? "",
    selectedModels: [],
    customModelIds: [],
    keepExistingKey: provider.inlineKey,
    setAsDefault: false,
  };
}

export interface FormValidation {
  ok: boolean;
  errors: Record<string, string>;
}

const MODEL_ID = /^[A-Za-z0-9._:/@+-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Pure validation shared by the settings panel and the onboarding wizard. */
export function validateProviderForm(form: ProviderFormState, options: { requireKey: boolean }): FormValidation {
  const errors: Record<string, string> = {};
  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = "Base URL is required";
  } else if (!/^https?:\/\//.test(baseUrl)) {
    errors.baseUrl = "Base URL must start with http:// or https://";
  }
  if (form.credential === "inline") {
    if (options.requireKey && !form.apiKey.trim()) errors.apiKey = "Paste the provider's API key";
  } else if (!form.envKey.trim()) {
    errors.envKey = "Name the environment variable holding the key";
  } else if (!ENV_NAME.test(form.envKey.trim())) {
    errors.envKey = "Use a variable name: letters, digits and underscores";
  }
  for (const id of [...form.selectedModels, ...form.customModelIds.map((value) => value.trim()).filter(Boolean)]) {
    if (!MODEL_ID.test(id)) errors.models = `“${id}” is not a usable model id`;
  }
  if (form.selectedModels.length === 0 && form.customModelIds.every((value) => !value.trim())) {
    errors.models = "Pick at least one model, or discover them from the provider";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Map the form onto the exact `x.ai/providers/upsert` params (pure; directly unit-tested). */
export function formToUpsertRequest(form: ProviderFormState, preset?: ProviderPreset): ProviderUpsertRequest {
  const seeds = (preset?.models ?? []).filter((model) => form.selectedModels.includes(model.id));
  const extraIds = form.customModelIds
    .map((value) => value.trim())
    .filter((value, index, all) => value && all.indexOf(value) === index && !seeds.some((seed) => seed.id === value));
  const models = [
    ...seeds.map((seed) => ({ id: seed.id, model: seed.model, name: seed.name, input: [...seed.input] })),
    ...extraIds.map((id) => ({ id, model: id, name: id, input: ["text"] })),
  ];
  const typedKey = form.apiKey.trim();
  const envName = form.envKey.trim();
  // An edit that leaves the key field blank sends no credential at all, so the stored secret
  // stays untouched instead of silently switching the provider to an env var.
  const credential: { apiKey?: string; envKey?: string } =
    form.credential === "env"
      ? envName
        ? { envKey: envName }
        : {}
      : typedKey
        ? { apiKey: typedKey }
        : form.keepExistingKey
          ? {}
          : envName
            ? { envKey: envName }
            : {};
  return {
    id: form.presetId,
    baseUrl: form.baseUrl.trim(),
    apiBackend: form.apiBackend,
    ...credential,
    ...(Object.keys(preset?.extraHeaders ?? {}).length > 0 ? { extraHeaders: { ...preset!.extraHeaders } } : {}),
    models,
    ...(form.setAsDefault ? { setAsDefault: true } : {}),
  };
}

/**
 * First-run gate: show the connect flow only when nothing usable is configured.
 *
 * Usable means either a provider with a credential, or an xAI credential of the user's own
 * (session login / `XAI_API_KEY`) that makes the built-in catalog callable. A CLI user whose
 * `config.toml` already works, and anyone logged in, never sees the wizard.
 */
export function shouldShowConnectProvider(input: {
  connected: boolean;
  providers: Array<{ hasKey: boolean }>;
  authenticated: boolean;
  dismissed?: boolean;
}): boolean {
  if (!input.connected || input.dismissed) return false;
  if (input.providers.some((provider) => provider.hasKey)) return false;
  return !input.authenticated;
}

export function providerStatus(provider: {
  hasKey: boolean;
  inlineKey: boolean;
  envKeyPresent: boolean;
  envKey?: string | null;
}): { label: string; tone: "ok" | "warn" } {
  if (provider.inlineKey) return { label: "API key saved", tone: "ok" };
  if (provider.hasKey && provider.envKeyPresent) return { label: `Env var ${provider.envKey}`, tone: "ok" };
  if (provider.hasKey) return { label: `Env var ${provider.envKey} (not set)`, tone: "warn" };
  return { label: "No credential", tone: "warn" };
}
