import { describe, expect, it } from "vitest";
import fixture from "./provider-presets.fixture.json";
import {
  PROVIDER_PRESETS,
  findPreset,
  isOauthProvider,
  oauthProviderName,
  formFromPreset,
  formFromProvider,
  formToUpsertRequest,
  mergedProviderStatus,
  providerStatus,
  shouldShowConnectProvider,
  validateProviderForm,
} from "./provider-presets";
import type { ProviderPreset } from "./providers";

const PRESET_IDS = PROVIDER_PRESETS.map((preset) => preset.id);

describe("preset catalog", () => {
  it("carries every documented provider and keeps secrets out of the cards", () => {
    for (const id of [
      "openai",
      "anthropic",
      "openrouter",
      "deepseek",
      "zai",
      "xai",
      "google",
      "groq",
      "mistral",
      "moonshot",
      "xiaomi",
      "together",
      "fireworks",
      "ollama",
      "custom",
    ]) {
      expect(PRESET_IDS).toContain(id);
    }
    expect(JSON.stringify(PROVIDER_PRESETS)).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(findPreset("anthropic")?.apiBackend).toBe("messages");
    expect(findPreset("anthropic")?.extraHeaders).toEqual({ "anthropic-version": "2023-06-01" });
    expect(findPreset("zai")).toMatchObject({
      baseUrl: "https://api.z.ai/api/paas/v4/",
      apiBackend: "chat_completions",
      envKey: "ZAI_API_KEY",
    });
    expect(findPreset("zai")?.models.map((model) => model.id)).toEqual(["glm-5.1", "glm-5", "glm-4.7"]);
    expect(findPreset("ollama")?.envKey).toBeNull();
    expect(findPreset("xiaomi")).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiBackend: "chat_completions",
      envKey: "MIMO_API_KEY",
    });
    expect(findPreset("xiaomi")?.models.map((model) => model.id)).toEqual([
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro-ultraspeed",
    ]);
    expect(findPreset("custom")?.baseUrl).toBeNull();
    expect(isOauthProvider("openai")).toBe(true);
    expect(isOauthProvider("anthropic")).toBe(true);
    expect(isOauthProvider("xai")).toBe(true);
    expect(isOauthProvider("deepseek")).toBe(false);
    expect(oauthProviderName("openai")).toBe("ChatGPT");
  });

  it("mirrors the agent catalog exactly (ids, urls, env vars, seeds)", () => {
    // `provider-presets.fixture.json` is the shared contract: the agent asserts its own
    // `PRESETS` against the same file, so either side drifting fails a test.
    const snapshot = PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      apiBackend: preset.apiBackend,
      envKey: preset.envKey,
      help: preset.help,
      discover: preset.discover,
      extraHeaders: preset.extraHeaders,
      models: preset.models.map((model) => ({ id: model.id, model: model.model, name: model.name, input: model.input })),
    }));
    expect(snapshot).toEqual(fixture);
  });
});

describe("form → x.ai/providers/upsert params", () => {
  it("maps an inline-key preset onto base URL, backend, headers and seed models", () => {
    const preset = findPreset("anthropic")!;
    const form = { ...formFromPreset(preset), apiKey: "sk-live-abc123" };
    expect(formToUpsertRequest(form, preset)).toEqual({
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiBackend: "messages",
      apiKey: "sk-live-abc123",
      extraHeaders: { "anthropic-version": "2023-06-01" },
      models: preset.models.map((model) => ({ id: model.id, model: model.model, name: model.name, input: [...model.input] })),
    });
  });

  it("sends envKey (never a key) when the credential is an environment variable", () => {
    const preset = findPreset("deepseek")!;
    const form = { ...formFromPreset(preset), credential: "env" as const, apiKey: "should-not-travel" };
    const request = formToUpsertRequest(form, preset);
    expect(request.envKey).toBe("DEEPSEEK_API_KEY");
    expect(request.apiKey).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("should-not-travel");
  });

  it("keeps the stored secret when editing and the user typed no new key", () => {
    const preset = findPreset("openai")!;
    const form = formFromProvider({ id: "openai", baseUrl: preset.baseUrl, apiBackend: "chat_completions", envKey: null, inlineKey: true });
    expect(form.keepExistingKey).toBe(true);
    const request = formToUpsertRequest(form, preset);
    expect(request.apiKey).toBeUndefined();
    expect(request.envKey).toBeUndefined();
  });

  it("appends hand-typed model ids as text-only seeds and drops duplicates", () => {
    const form = {
      ...formFromPreset(findPreset("groq")!),
      apiKey: "gsk-1",
      customModelIds: ["llama-3.3-70b", "llama-3.3-70b", " "],
    };
    const request = formToUpsertRequest(form, findPreset("groq"));
    expect(request.models).toEqual([{ id: "llama-3.3-70b", model: "llama-3.3-70b", name: "llama-3.3-70b", input: ["text"] }]);
    expect(request.setAsDefault).toBeUndefined();
  });

  it("carries setAsDefault through", () => {
    const preset = findPreset("xai")!;
    const request = formToUpsertRequest({ ...formFromPreset(preset), apiKey: "xai-1", setAsDefault: true }, preset);
    expect(request.setAsDefault).toBe(true);
  });

  it("keeps the custom card's own URL and id", () => {
    const form = { ...formFromPreset(findPreset("custom")!), apiKey: "k-123", baseUrl: "http://192.168.1.9:8000/v1", customModelIds: ["local-model"] };
    const request = formToUpsertRequest(form, findPreset("custom"));
    expect(request.id).toBe("custom");
    expect(request.baseUrl).toBe("http://192.168.1.9:8000/v1");
    expect(request.extraHeaders).toBeUndefined();
  });

  it("omits model seeds for a connection-only edit so configured rows survive", () => {
    const preset = findPreset("openrouter")!;
    const form = formFromProvider({
      id: "openrouter",
      baseUrl: preset.baseUrl,
      apiBackend: "chat_completions",
      inlineKey: true,
      models: [{ id: "openrouter/stealth-union-alpha" }],
    });
    const request = formToUpsertRequest(form, preset, { includeModels: false });
    expect(request.models).toEqual([]);
    expect(request.id).toBe("openrouter");
  });

  it("turns every preset into a request the agent accepts", () => {
    for (const preset of PROVIDER_PRESETS) {
      const form = preset.baseUrl
        ? { ...formFromPreset(preset), apiKey: "k-123", customModelIds: preset.models.length ? [] : ["seed-me"] }
        : { ...formFromPreset(preset), apiKey: "k-123", baseUrl: "https://example.test/v1", customModelIds: ["seed-me"] };
      const validation = validateProviderForm(form, { requireKey: true });
      expect(validation.errors, `${preset.id}: ${JSON.stringify(validation.errors)}`).toEqual({});
      const request = formToUpsertRequest(form, preset);
      expect(request.id).toBe(preset.id);
      expect(request.baseUrl).toMatch(/^https?:\/\//);
      expect(request.models.length).toBeGreaterThan(0);
    }
  });
});

describe("form validation", () => {
  const base = () => ({ ...formFromPreset(findPreset("deepseek")!), apiKey: "sk-1" });

  it("requires an http(s) base URL", () => {
    expect(validateProviderForm({ ...base(), baseUrl: " " }, { requireKey: true }).errors.baseUrl).toBe("Base URL is required");
    expect(validateProviderForm({ ...base(), baseUrl: "api.deepseek.com" }, { requireKey: true }).errors.baseUrl).toContain("http://");
    expect(validateProviderForm(base(), { requireKey: true }).ok).toBe(true);
  });

  it("requires a key on a new provider but not while editing", () => {
    const form = { ...base(), apiKey: "" };
    expect(validateProviderForm(form, { requireKey: true }).errors.apiKey).toBeTruthy();
    expect(validateProviderForm(form, { requireKey: false }).ok).toBe(true);
  });

  it("requires a usable env-var name for the env credential", () => {
    expect(validateProviderForm({ ...base(), credential: "env", envKey: "" }, { requireKey: false }).errors.envKey).toBeTruthy();
    expect(validateProviderForm({ ...base(), credential: "env", envKey: "2BAD NAME" }, { requireKey: false }).errors.envKey).toContain("variable name");
    expect(validateProviderForm({ ...base(), credential: "env", envKey: "GOOD_KEY" }, { requireKey: false }).ok).toBe(true);
  });

  it("requires at least one model and rejects unusable ids", () => {
    expect(validateProviderForm({ ...base(), selectedModels: [], customModelIds: [] }, { requireKey: true }).errors.models).toBeTruthy();
    expect(
      validateProviderForm({ ...base(), selectedModels: [], customModelIds: ["has space"] }, { requireKey: true }).errors.models,
    ).toContain("has space");
  });

  it("skips the model requirement when the dialog does not show model fields", () => {
    const form = { ...base(), selectedModels: [], customModelIds: [] };
    expect(validateProviderForm(form, { requireKey: true, requireModels: false }).ok).toBe(true);
  });
});

describe("first-run gate", () => {
  it("shows the connect flow only when nothing usable is configured", () => {
    const show = shouldShowConnectProvider;
    expect(show({ connected: false, providers: [], authenticated: false })).toBe(false);
    expect(show({ connected: true, providers: [], authenticated: false })).toBe(true);
    expect(show({ connected: true, providers: [{ hasKey: true }], authenticated: false })).toBe(false);
    expect(show({ connected: true, providers: [], authenticated: true })).toBe(false);
    expect(show({ connected: true, providers: [{ hasKey: false }], authenticated: false, dismissed: true })).toBe(false);
  });
});

describe("provider status badge", () => {
  it("distinguishes a saved key, a live env var, an unset env var and nothing", () => {
    expect(providerStatus({ hasKey: true, inlineKey: true, envKeyPresent: false })).toEqual({ label: "Connected · API key saved", tone: "ok" });
    expect(providerStatus({ hasKey: true, inlineKey: false, envKey: "K", envKeyPresent: true }).tone).toBe("ok");
    const unset = providerStatus({ hasKey: true, inlineKey: false, envKey: "K", envKeyPresent: false });
    expect(unset.tone).toBe("warn");
    expect(unset.label).toContain("not set");
    expect(providerStatus({ hasKey: false, inlineKey: false, envKeyPresent: false }).tone).toBe("warn");
  });

  it("merges OAuth and API-key connection methods", () => {
    expect(mergedProviderStatus({ hasKey: true, inlineKey: true, envKeyPresent: false }, true)).toEqual({
      label: "Connected · OAuth + API key",
      tone: "ok",
    });
    expect(mergedProviderStatus(undefined, true)).toEqual({ label: "Connected · OAuth", tone: "ok" });
    expect(mergedProviderStatus(undefined, false)).toEqual({ label: "Not connected", tone: "warn" });
    expect(mergedProviderStatus({ hasKey: true, inlineKey: false, envKey: "OPENAI_API_KEY", envKeyPresent: false }, false).label).toContain("not set");
  });
});

describe("editing an existing provider", () => {
  it("prefills from the preset the provider was created from", () => {
    const preset: ProviderPreset = findPreset("moonshot")!;
    const form = formFromProvider({
      id: "moonshot",
      baseUrl: null,
      apiBackend: null,
      envKey: null,
      inlineKey: false,
    });
    expect(form.presetId).toBe("moonshot");
    expect(form.baseUrl).toBe(preset.baseUrl);
    expect(form.apiBackend).toBe(preset.apiBackend);
    expect(form.envKey).toBe(preset.envKey);
    expect(form.credential).toBe("env");
    expect(form.keepExistingKey).toBe(false);
  });

  it("prefills configured models so editing cannot drop config entries", () => {
    const form = formFromProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiBackend: "chat_completions",
      envKey: null,
      inlineKey: true,
      models: [{ id: "gpt-5" }, { id: "team-model" }],
    });
    expect(form.selectedModels).toEqual(["gpt-5"]);
    expect(form.customModelIds).toEqual(["team-model"]);
  });

  it("falls back to the custom card for a hand-written provider", () => {
    const form = formFromProvider({ id: "my-gateway", baseUrl: "https://gw.test/v1", apiBackend: "responses", envKey: null, inlineKey: true });
    expect(form.presetId).toBe("my-gateway");
    expect(form.providerName).toBe("my-gateway");
    expect(form.baseUrl).toBe("https://gw.test/v1");
    expect(form.apiBackend).toBe("responses");
    expect(form.keepExistingKey).toBe(true);
  });
});
