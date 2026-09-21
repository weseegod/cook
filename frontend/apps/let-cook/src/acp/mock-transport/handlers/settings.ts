import { PROVIDER_PRESETS } from "../../provider-presets";
import { modelCatalog, providerList } from "../catalog";
import { isRecord } from "../events";
import {
  approvedOauth,
  grokAuthResolve,
  pendingOauth,
  setGrokAuthResolve,
  setPendingOauth,
} from "../oauth-pending";
import { notify, persist, state } from "../state";
import type { MockProvider, MockSeedModel } from "../types";
import type { MethodHandler } from "./registry";

function seedOauthProvider(id: string) {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) return;
  const existing = state.providers.find((provider) => provider.id === id);
  const next: MockProvider = {
    id,
    name: preset.label,
    baseUrl: preset.baseUrl ?? "",
    apiBackend: preset.apiBackend,
    apiKeyPresent: true,
    oauth: true,
    models: existing?.models?.length
      ? existing.models
      : preset.models.map((model) => ({ id: model.id, model: model.model, name: model.name, input: [...model.input] })),
  };
  const index = state.providers.findIndex((provider) => provider.id === id);
  state.providers = index < 0
    ? [...state.providers, next]
    : state.providers.map((provider, at) => at === index ? { ...provider, ...next, models: next.models } : provider);
  notify("x.ai/models/update", modelCatalog());
}

export function completeMockOauth(id: string): void {
  approvedOauth.add(id);
  if (id === "xai") {
    state.authMethodId = "grok.com";
    grokAuthResolve?.();
    setGrokAuthResolve(null);
    notify("x.ai/models/update", modelCatalog());
    persist();
    return;
  }
  seedOauthProvider(id);
  persist();
}

const skillsMutation: MethodHandler = ({ respond }) => {
    return respond({ result: { ok: true, skills: state.skills, message: "ok" } });
};

export const settingsHandlers: Record<string, MethodHandler> = {
  "x.ai/auth/info": ({ respond }) => {
    return respond({ result: { methodId: state.authMethodId, email: state.authMethodId ? "cook@example.com" : null } });
  },
  "x.ai/auth/logout": ({ respond }) => {
    state.authMethodId = null;
    approvedOauth.delete("xai");
    return respond({ result: { ok: true } });
  },
  "x.ai/auth/get_url": ({ respond }) => {
    return respond({
      result: {
        auth_url: "https://auth.x.ai/oauth2/device?user_code=GROK-1234",
        mode: "device",
      },
    });
  },
  "x.ai/auth/submit_code": ({ respond }) => respond({ result: { submitted: true } }),
  "x.ai/auth/cancel": ({ respond }) => {
    setGrokAuthResolve(null);
    return respond({ result: { cancelled: true } });
  },
  authenticate: ({ p, respond }) => {
    if (approvedOauth.has("xai") || state.authMethodId) {
      state.authMethodId = String(p.methodId ?? "grok.com");
      return respond({});
    }
    return new Promise((resolve) => {
      setGrokAuthResolve(() => {
        state.authMethodId = String(p.methodId ?? "grok.com");
        resolve(respond({}));
      });
    });
  },
  "x.ai/providers/oauth/start": ({ p, respond }) => {
    const id = String(p.id ?? "");
    const paste = id === "anthropic";
    const next = {
      id,
      mode: paste ? "paste" as const : "device" as const,
      authorizeUrl: paste
        ? "https://claude.ai/oauth/authorize"
        : "https://auth.openai.com/codex/device?user_code=WXYZ-1234",
      userCode: paste ? null : "WXYZ-1234",
    };
    setPendingOauth(next);
    return respond({
      id,
      mode: next.mode,
      authorizeUrl: next.authorizeUrl,
      userCode: next.userCode,
      needsCode: paste,
    });
  },
  "x.ai/providers/oauth/poll": ({ p, respond }) => {
    const id = String(p.id ?? pendingOauth?.id ?? "");
    if (approvedOauth.has(id)) {
      seedOauthProvider(id);
      return respond({ status: "connected" });
    }
    return respond({ status: "pending" });
  },
  "x.ai/providers/oauth/submit_code": ({ p, respond }) => {
    const id = String(p.id ?? pendingOauth?.id ?? "");
    if (!String(p.code ?? "").trim()) return respond({ status: "error", error: "paste the authorization code" });
    completeMockOauth(id);
    return respond({ status: "connected" });
  },
  "x.ai/providers/oauth/cancel": ({ p, respond }) => {
    const id = String(p.id ?? "");
    if (pendingOauth?.id === id) setPendingOauth(null);
    return respond({ ok: true });
  },
  "x.ai/providers/oauth/logout": ({ p, respond }) => {
    const id = String(p.id ?? "");
    approvedOauth.delete(id);
    state.providers = state.providers.map((provider) =>
      provider.id === id
        ? { ...provider, oauth: false, apiKey: undefined, apiKeyPresent: false }
        : provider,
    );
    return respond({ ok: true });
  },
  "x.ai/setApiKey": ({ respond }) => {
    // Upstream keys on `key` and stores the xAI session key only, so the desktop's legacy shape
    // (`apiKey`, optional `provider`) is a no-op there. Provider credentials never travel this
    // way: the provider form hands them to the Tauri host, which writes config.toml.
    return respond({ result: { ok: true } });
  },
  "x.ai/models/list": ({ respond }) => {
    return respond({ result: modelCatalog() });
  },
  "x.ai/models/set_default": ({ p, respond }) => {
    const modelId = String(p.modelId ?? "");
    // An agent build without the extension, as the shipped CLI still is.
    if (state.setDefaultUnsupported) {
      return respond({
        error: { code: -32601, message: "Method not found", data: "unknown ACP extension method: x.ai/models/set_default" },
      });
    }
    if (!modelCatalog().availableModels.some((model) => model.id === modelId)) {
      return respond({ error: `unknown model \`${modelId}\`` });
    }
    state.defaultModel = modelId;
    notify("x.ai/models/update", modelCatalog());
    return respond({ result: { ok: true, defaultModel: modelId } });
  },
  "x.ai/providers/presets": ({ respond }) => {
    return respond({ presets: PROVIDER_PRESETS });
  },
  "x.ai/providers/list": ({ respond }) => {
    return respond(providerList());
  },
  "x.ai/providers/upsert": ({ p, respond }) => {
    const id = String(p.id ?? "");
    if (!id) return respond({ error: "provider id must not be empty" });
    const models = Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>) : [];
    const apiKey = typeof p.apiKey === "string" ? p.apiKey : undefined;
    const envKey = typeof p.envKey === "string" ? p.envKey : undefined;
    const existing = state.providers.find((provider) => provider.id === id);
    if (!existing && !apiKey && !envKey) return respond({ error: "a new provider needs apiKey or envKey" });
    const seeds: MockSeedModel[] = models.map((model) => ({
      id: String(model.id ?? model.model ?? ""),
      model: typeof model.model === "string" ? model.model : undefined,
      name: typeof model.name === "string" ? model.name : undefined,
      input: Array.isArray(model.input) ? model.input.map(String) : undefined,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
      maxCompletionTokens: typeof model.maxCompletionTokens === "number" ? model.maxCompletionTokens : undefined,
    }));
    // The host writes only the seeds it is given and leaves other `[model.*]` rows alone, so an
    // upsert that omits models (a connection-only edit) must not drop the configured ones.
    const seeded = new Set(seeds.map((model) => model.id));
    const next: MockProvider = {
      id,
      name: typeof p.name === "string" ? p.name : existing?.name,
      baseUrl: String(p.baseUrl ?? ""),
      apiBackend: String(p.apiBackend ?? "chat_completions"),
      apiKey: apiKey ?? (envKey ? undefined : existing?.apiKey),
      apiKeyPresent: Boolean(apiKey || (!envKey && (existing?.apiKey || existing?.apiKeyPresent))),
      envKey: envKey ?? (apiKey ? undefined : existing?.envKey),
      oauth: p.oauth === true,
      models: [...(existing?.models ?? []).filter((model) => !seeded.has(model.id)), ...seeds],
    };
    const providerIndex = state.providers.findIndex((provider) => provider.id === id);
    state.providers = providerIndex < 0
      ? [...state.providers, next]
      : state.providers.map((provider, index) => index === providerIndex ? next : provider);
    if (p.setAsDefault && seeds[0]) state.defaultModel = seeds[0].id;
    notify("x.ai/models/update", modelCatalog());
    return respond({ ok: true, id, models: next.models.map((model) => model.id), defaultModel: state.defaultModel });
  },
  "x.ai/providers/delete": ({ p, respond }) => {
    const id = String(p.id ?? "");
    const provider = state.providers.find((entry) => entry.id === id);
    if (!provider) return respond({ error: `no provider \`${id}\` is configured` });
    const removed = provider.models.map((model) => model.id);
    if (state.defaultModel && removed.includes(state.defaultModel) && !p.replacement) {
      return respond({
        error: `refusing to delete \`${id}\`: [models] default = \`${state.defaultModel}\` would dangle; pass a replacement model id`,
      });
    }
    state.providers = state.providers.filter((entry) => entry.id !== id);
    if (typeof p.replacement === "string" && p.replacement) state.defaultModel = p.replacement;
    notify("x.ai/models/update", modelCatalog());
    return respond({ ok: true, id, removedModels: removed, defaultModel: state.defaultModel });
  },
  "x.ai/models/delete": ({ p, respond }) => {
    const modelId = String(p.modelId ?? "");
    if (!modelId) return respond({ error: "modelId must not be empty" });
    if (state.defaultModel === modelId) return respond({ error: `refusing to delete \`${modelId}\`: it is the default model; select another default first` });
    const provider = state.providers.find((entry) => entry.models.some((model) => model.id === modelId));
    if (!provider) return respond({ error: `no model \`${modelId}\` is configured` });
    provider.models = provider.models.filter((model) => model.id !== modelId);
    notify("x.ai/models/update", modelCatalog());
    return respond({ ok: true, modelId });
  },
  "x.ai/models/upsert": ({ p, respond }) => {
    const modelId = String(p.id ?? "");
    const providerId = String(p.providerId ?? "xai");
    const provider = state.providers.find((entry) => entry.id === providerId);
    if (!provider) return respond({ error: `no provider \`${providerId}\` is configured` });
    const next: MockSeedModel = {
      id: modelId,
      model: typeof p.model === "string" ? p.model : modelId,
      name: typeof p.name === "string" ? p.name : modelId,
      input: Array.isArray(p.input) ? p.input.map(String) : ["text"],
      contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : undefined,
      maxCompletionTokens: typeof p.maxCompletionTokens === "number" ? p.maxCompletionTokens : undefined,
    };
    provider.models = [...provider.models.filter((model) => model.id !== modelId), next];
    notify("x.ai/models/update", modelCatalog());
    return respond({ ok: true, modelId });
  },
  "x.ai/providers/test": ({ p, respond }) => {
    const id = String(p.id ?? "");
    const provider = state.providers.find((entry) => entry.id === id);
    const baseUrl = String(p.baseUrl ?? provider?.baseUrl ?? "");
    const key = typeof p.apiKey === "string" && p.apiKey ? p.apiKey : provider?.apiKey;
    const fails = state.testFails || !baseUrl || String(key ?? "").startsWith("bad");
    return respond({
      ok: !fails,
      status: fails ? 401 : 200,
      ...(fails ? { error: fails && !baseUrl ? "baseUrl is required" : "401 unauthorized: invalid api key" } : {}),
      url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      model: provider?.models[0]?.id ?? null,
      latencyMs: 12,
    });
  },
  "x.ai/providers/probe_models": ({ p, respond }) => {
    // Read-only listing: unlike `discover_models` this must not merge anything into the catalog.
    const id = String(p.id ?? "");
    const provider = state.providers.find((entry) => entry.id === id);
    if (!provider) return respond({ error: `no provider \`${id}\` is configured` });
    if (!provider.apiKey && !provider.apiKeyPresent && !provider.envKey) {
      return respond({ ok: false, id, models: [], error: "this provider has no credential" });
    }
    if (state.probeFails) return respond({ ok: false, id, models: [], error: "401 unauthorized: invalid api key" });
    return respond({
      ok: true,
      id,
      models: state.discoverable.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxCompletionTokens: model.maxCompletionTokens,
      })),
    });
  },
  "x.ai/providers/discover_models": ({ p, respond }) => {
    const id = String(p.id ?? "");
    const provider = state.providers.find((entry) => entry.id === id);
    const known = new Set(state.providers.flatMap((entry) => entry.models.map((model) => model.id)));
    const added = state.discoverable.filter((model) => !known.has(model.id)).map((model) => model.id);
    if (provider) {
      provider.models = [
        ...provider.models,
        ...state.discoverable.filter((model) => added.includes(model.id)).map((model) => ({ ...model, input: ["text"] })),
      ];
    }
    notify("x.ai/models/update", modelCatalog());
    return respond({ ok: true, id, discovered: state.discoverable, added, skipped: [] });
  },
  "x.ai/skills/list": ({ respond }) => {
    return respond({ result: { skills: state.skills } });
  },
  "x.ai/skills/toggle": ({ p, respond }) => {
    // Installed CLI requires `name`; desktop fans out one call per skill.
    const name = String(p.name ?? "");
    if (!name) return respond({ error: { code: -32602, message: "missing field `name`" } });
    state.skills = state.skills.map((skill) =>
      skill.name === name ? { ...skill, enabled: p.enabled !== false } : skill,
    );
    return respond({ result: { ok: true, skills: state.skills } });
  },
  "x.ai/skills/add": skillsMutation,
  "x.ai/skills/remove": skillsMutation,
  "x.ai/skills/reset": skillsMutation,
  "x.ai/skills/config": skillsMutation,
  "x.ai/plugins/list": ({ respond }) => {
    return respond({ result: { plugins: state.plugins } });
  },
  "x.ai/plugins/action": ({ p, respond }) => {
    const action = isRecord(p.action) ? p.action : {};
    const type = String(action.type ?? "");
    if (type === "enable" || type === "disable") {
      const id = String(action.plugin_id ?? "");
      state.plugins = state.plugins.map((plugin) =>
        plugin.id === id || plugin.name === id ? { ...plugin, enabled: type === "enable" } : plugin,
      );
    }
    return respond({ result: { status: "ok", message: type || "action" } });
  },
  "x.ai/plugins/reload": ({ respond }) => {
    return respond({ result: { status: "ok", message: "reloaded" } });
  },
  "x.ai/workflows/list": ({ respond }) => {
    return respond({ result: { workflows: state.workflows ?? [] } });
  },
  "x.ai/hooks/list": ({ respond }) => {
    return respond({
      result: {
        hooks: state.hooks ?? [],
        projectTrusted: state.hooksProjectTrusted === true,
      },
    });
  },
  "x.ai/hooks/action": ({ p, respond }) => {
    const action = isRecord(p.action) ? p.action : {};
    const type = String(action.type ?? "");
    if (type === "trust") state.hooksProjectTrusted = true;
    if (type === "enable" || type === "disable") {
      const name = String(action.hook_name ?? "");
      state.hooks = (state.hooks ?? []).map((hook) =>
        hook.name === name ? { ...hook, disabled: type === "disable" } : hook,
      );
    }
    return respond({ result: { status: "ok", message: type || "action" } });
  },
  "x.ai/memory/flush": ({ respond }) => {
    return respond({ result: { ok: true } });
  },
  "x.ai/memory/rewrite": ({ respond }) => {
    return respond({ result: { ok: true } });
  },
  "x.ai/memory/forget": ({ respond }) => {
    return respond({ result: { ok: true } });
  },
};
