import { PROVIDER_PRESETS } from "../provider-presets";
import type { ProviderPreset } from "../providers";
import { state } from "./state";
import type { MockMcpServer, MockMcpTool, MockProvider } from "./types";

function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((entry) => entry.id === id);
}

function linkedModels(provider: MockProvider) {
  return provider.models.map((model) => ({ ...model }));
}

export function providerList() {
  return {
    providers: state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiBackend: provider.apiBackend,
      hasKey: Boolean(provider.apiKey) || Boolean(provider.apiKeyPresent) || Boolean(provider.envKey),
      inlineKey: Boolean(provider.apiKey) || Boolean(provider.apiKeyPresent),
      envKey: provider.envKey ?? null,
      envKeyPresent: false,
      extraHeaders: presetFor(provider.id)?.extraHeaders ?? {},
      oauth: provider.oauth === true,
      models: linkedModels(provider),
    })),
    models: [
      ...state.providers.flatMap((provider) => provider.models.map((model) => ({ ...model, provider: provider.id }))),
      ...state.xaiModels.map((model) => ({ ...model, provider: "xai" })),
    ],
    defaultModel: state.defaultModel,
  };
}

export function modelCatalog() {
  const models: Array<Record<string, unknown>> = [];
  if (state.authMethodId) {
    models.push({ id: "grok-4.5", name: "Grok 4.5", provider: "xai", inputModalities: ["text", "image"], _meta: { totalContextTokens: 500_000 } });
  }
  for (const model of state.xaiModels) {
    models.push({
      id: model.id,
      name: model.name ?? model.id,
      provider: "xai",
      inputModalities: model.input ?? ["text"],
      _meta: {
        totalContextTokens: model.contextWindow ?? 300_000,
        maxCompletionTokens: model.maxCompletionTokens ?? 64_000,
        apiModel: model.model ?? model.id,
        ...(model.supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
      },
    });
  }
  for (const provider of state.providers) {
    for (const model of provider.models) {
      models.push({
        id: model.id,
        name: model.name ?? model.id,
        provider: provider.id,
        inputModalities: model.input ?? ["text"],
        _meta: {
          totalContextTokens: model.contextWindow ?? 300_000,
          maxCompletionTokens: model.maxCompletionTokens ?? 64_000,
          apiModel: model.model ?? model.id,
          ...(model.supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
        },
      });
    }
  }
  return {
    currentModelId: state.defaultModel ?? models[0]?.id ?? "",
    availableModels: models,
  };
}

export function mcpToolsFor(server: MockMcpServer): MockMcpTool[] {
  if (server.tools) return server.tools;
  return Array.from({ length: server.toolCount }, (_, index) => ({
    name: `${server.name}_tool_${index}`,
    enabled: true,
  }));
}

export function mcpList() {
  return {
    servers: state.mcpServers.map((server) => ({
      name: server.name,
      ...(server.displayName ? { display_name: server.displayName } : {}),
      source: server.source ?? (server.transport === "managedGateway" ? "managed" : "local"),
      ...(server.sourceLabel ? { source_label: server.sourceLabel } : {}),
      type: server.transport,
      ...(server.transport === "stdio"
        ? { command: server.command ?? "npx", args: server.args ?? [] }
        : server.transport === "http"
          ? { url: server.url ?? "" }
          : {}),
      ...(server.setup ? { setup: server.setup } : {}),
      ...(server.setupValues ? { setupValues: server.setupValues } : {}),
      session: {
        enabled: server.enabled,
        status: server.setupRequired
          ? "setup_required"
          : server.authRequired
            ? "unavailable"
            : server.enabled
              ? "ready"
              : "unavailable",
        tools: mcpToolsFor(server).map((tool) => ({
          name: tool.name,
          enabled: tool.enabled,
          ...(tool.displayName ? { displayName: tool.displayName } : {}),
          ...(tool.description ? { description: tool.description } : {}),
        })),
        ...(server.authRequired ? { authRequired: true } : {}),
        ...(server.setupRequired ? { setupRequired: true } : {}),
      },
    })),
  };
}

export function fileRead(path: string): { result?: { content: string; size: number; type: string }; error?: string } {
  const content = state.files[path];
  if (content === undefined) return { error: `file not found: ${path}` };
  return { result: { content, size: content.length, type: "text" } };
}

/**
 * The slash commands a real agent build advertises: its own built-ins plus the skills it found.
 * As on the wire, the usage hint is nested under `input.hint`.
 */
export function commandList() {
  return {
    commands: [
      { name: "compact", description: "Compress conversation history to save context window", input: { hint: "optional context about what to preserve" } },
      { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", input: { hint: "on|off" } },
      { name: "context", description: "Show context window usage and session stats", input: null },
      { name: "session-info", description: "Show session details (model, turns, context usage)", input: null },
      { name: "deep-research", description: "Research with bounded parallel agents and write a cited report", input: { hint: "<query>" }, _meta: { workflowSource: "builtin" } },
      { name: "workflow", description: "Launch a saved workflow, list runs, or manage a run", input: { hint: "<name> | runs | pause|resume|stop|save" } },
      { name: "goal", description: "Set, manage, or check an autonomous goal", input: { hint: "<objective> | status | pause | resume | clear" } },
      { name: "code-review", description: "Review the current changes", input: null, _meta: { scope: "bundled" } },
    ],
  };
}

/** The `session/update` the agent sends when its command catalog changes. */
export function availableCommandsUpdate() {
  return {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: commandList().commands,
    },
  };
}
