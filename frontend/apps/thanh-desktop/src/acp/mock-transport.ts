/**
 * Browser-transport stand-in for the real agent.
 *
 * Only active when `VITE_MOCK_ACP=1` (dev server / Playwright). It exists so the shipped
 * renderer can be driven end to end outside Tauri: it records the RPC params the real client
 * sends, keeps provider/connector state the way the agent would, and can stream assistant
 * updates back so the transcript is exercised for real.
 */
import { PROVIDER_PRESETS } from "./provider-presets";
import type { ProviderPreset } from "./providers";

export interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface MockSeedModel {
  id: string;
  name?: string;
  input?: string[];
}

export interface MockProvider {
  id: string;
  baseUrl: string;
  apiBackend: string;
  apiKey?: string;
  envKey?: string;
  models: MockSeedModel[];
}

export interface MockMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  toolCount: number;
}

export interface MockSkill {
  name: string;
  description?: string;
  enabled: boolean;
}

/** One saved conversation as `x.ai/session/list` reports it. */
export interface MockSession {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
}

export interface MockPlugin {
  name: string;
  version?: string;
  enabled: boolean;
}

export interface MockState {
  /** Non-null when the agent holds an xAI credential of its own. */
  authMethodId: string | null;
  defaultModel: string | null;
  /** The session mode the agent would report; `/plan` flips it. */
  sessionMode: "default" | "plan";
  /** What the agent is holding, as `x.ai/session/info` reports it. */
  context: { used: number; turns: number; messageCount: number };
  providers: MockProvider[];
  discoverable: MockSeedModel[];
  sessions: MockSession[];
  mcpServers: MockMcpServer[];
  skills: MockSkill[];
  plugins: MockPlugin[];
  /** Force the next `providers/test` to fail, for the error-state path. */
  testFails: boolean;
  /** Model a build that predates `x.ai/models/set_default`, which answers -32601. */
  setDefaultUnsupported: boolean;
  /** Assistant text streamed back for each prompt. */
  reply: string;
  /** Optional exact ACP update sequence for transcript and visual tests. */
  promptUpdates: Array<Record<string, unknown>>;
  /** Hold the prompt response open so visual tests can inspect live activity. */
  promptDelayMs: number;
  /** Agent-side project instruction files keyed by path. */
  files: Record<string, string>;
  /** Paths the native attachment picker returns; empty means "no native picker here". */
  pickedFiles: string[];
  /** Base64 payloads keyed by path, as `read_file_base64` would return them. */
  filePayloads: Record<string, { data: string; mediaType: string; size: number }>;
}

function defaultState(): MockState {
  return {
    authMethodId: null,
    defaultModel: null,
    sessionMode: "default",
    // A fresh session already holds its system prompt and tool definitions, as the real one does.
    context: { used: 1474, turns: 0, messageCount: 1 },
    providers: [],
    discoverable: [{ id: "mock-discovered-model", name: "Mock Discovered" }],
    sessions: [
      { id: "session-login", title: "Fix login bug", cwd: "/tmp/thanh-demo", updatedAt: "2026-09-15T10:00:00Z" },
      { id: "session-providers", title: "Provider settings", cwd: "/tmp/thanh-demo", updatedAt: "2026-09-14T10:00:00Z" },
    ],
    mcpServers: [
      { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], enabled: true, toolCount: 3 },
      { name: "linear", transport: "http", url: "https://mcp.linear.app/sse", enabled: false, toolCount: 0 },
    ],
    skills: [
      { name: "help", description: "Documentation help", enabled: true },
      { name: "review", description: "Review my changes", enabled: false },
    ],
    plugins: [{ name: "thanh-core", version: "1.0.0", enabled: true }],
    testFails: false,
    setDefaultUnsupported: false,
    reply: "Mock assistant reply.",
    promptUpdates: [],
    promptDelayMs: 0,
    files: {},
    pickedFiles: [],
    filePayloads: {},
    ...seedFromWindow(),
    // Whatever the agent already wrote wins: the renderer's own memory is not the source of truth.
    ...persisted(),
  };
}

/** A browser test sets `window.__thanhMockSeed` before load to start from a known state. */
function seedFromWindow(): Partial<MockState> {
  if (typeof window === "undefined") return {};
  return (window as unknown as { __thanhMockSeed?: Partial<MockState> }).__thanhMockSeed ?? {};
}

/**
 * State the agent would keep on disk. `sessionStorage` stands in for it so a reload inside one
 * browser context proves the renderer is not the one holding the provider configuration.
 */
const STORAGE_KEY = "thanh.mock.acp.state";

function persisted(): Partial<MockState> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<MockState>) : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked storage must not break the transport.
  }
}

let state: MockState = defaultState();
let requests: RecordedRequest[] = [];
let responses: Array<{ id: number | string; result: unknown; at: number }> = [];
let nextServerRequestId = 1;
const subscribers = new Set<(message: unknown) => void>();

function record(method: string, params: unknown): void {
  requests.push({
    method,
    params: (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    at: Date.now(),
  });
}

function emit(message: unknown): void {
  for (const subscriber of subscribers) subscriber(message);
}

function notify(method: string, params: unknown): void {
  emit({ jsonrpc: "2.0", method, params });
}

/** A reverse request (agent → client) that expects an answer; the id is what the client responds to. */
function request(method: string, params: unknown, id: number): void {
  emit({ jsonrpc: "2.0", id, method, params });
}

export function subscribe(handler: (message: unknown) => void): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((entry) => entry.id === id);
}

function linkedModels(provider: MockProvider) {
  return provider.models.map((model) => ({ id: model.id, name: model.name, input: model.input }));
}

function providerList() {
  return {
    providers: state.providers.map((provider) => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiBackend: provider.apiBackend,
      hasKey: Boolean(provider.apiKey) || Boolean(provider.envKey),
      inlineKey: Boolean(provider.apiKey),
      keyHint: provider.apiKey && provider.apiKey.length >= 12
        ? `${provider.apiKey.slice(0, 2)}…${provider.apiKey.slice(-4)}`
        : null,
      envKey: provider.envKey ?? null,
      envKeyPresent: false,
      extraHeaders: presetFor(provider.id)?.extraHeaders ?? {},
      models: linkedModels(provider),
    })),
    defaultModel: state.defaultModel,
  };
}

function modelCatalog() {
  const models: Array<Record<string, unknown>> = [];
  if (state.authMethodId) {
    models.push({ id: "grok-4.5", name: "Grok 4.5", provider: "xai", inputModalities: ["text", "image"], _meta: { totalContextTokens: 500_000 } });
  }
  for (const provider of state.providers) {
    for (const model of provider.models) {
      models.push({
        id: model.id,
        name: model.name ?? model.id,
        provider: provider.id,
        inputModalities: model.input ?? ["text"],
        _meta: { totalContextTokens: 300_000 },
      });
    }
  }
  return {
    currentModelId: state.defaultModel ?? models[0]?.id ?? "",
    availableModels: models,
  };
}

function mcpList() {
  return {
    servers: state.mcpServers.map((server) => ({
      name: server.name,
      source: "local",
      type: server.transport,
      ...(server.transport === "stdio"
        ? { command: server.command ?? "npx", args: server.args ?? [] }
        : { url: server.url ?? "" }),
      session: {
        enabled: server.enabled,
        status: server.enabled ? "ready" : "unavailable",
        tools: Array.from({ length: server.toolCount }, (_, index) => ({ name: `${server.name}_tool_${index}` })),
      },
    })),
  };
}

function fileRead(path: string): { result?: { content: string; size: number; type: string }; error?: string } {
  const content = state.files[path];
  if (content === undefined) return { error: `file not found: ${path}` };
  return { result: { content, size: content.length, type: "text" } };
}

/**
 * Mirrors the agent's routing: extension calls arrive as `_x.ai/...` and are dispatched by the
 * bare name, so what the tests read back is the logical method the app asked for. A bare
 * `x.ai/...` request is rejected exactly as the agent rejects it, so a call site that skips the
 * wire prefix fails here instead of only against a real agent.
 */
const METHOD_NOT_FOUND = '{"code":-32601,"message":"Method not found"}';

/** Runs one mocked call and persists the result, the way the agent's config.toml would. */
export async function mockRequest<T>(rawMethod: string, params: unknown): Promise<T> {
  if (rawMethod.startsWith("x.ai/")) throw new Error(METHOD_NOT_FOUND);
  const method = rawMethod.startsWith("_x.ai/") ? rawMethod.slice(1) : rawMethod;
  record(method, params);
  const value = await dispatch(method, params);
  persist();
  return value as T;
}

/**
 * The slash commands a real agent build advertises: its own built-ins plus the skills it found.
 * As on the wire, the usage hint is nested under `input.hint`.
 */
function commandList() {
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
function availableCommandsUpdate() {
  return {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: commandList().commands,
    },
  };
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  const sessionId = "mock-session";
  const respond = (value: unknown) => value;

  switch (method) {
    case "initialize":
      return respond({ protocolVersion: 1, agentCapabilities: {} });
    case "session/new": {
      // The agent spawns the session on `_meta.modelId`, which is how a choice made before the
      // first prompt reaches it.
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      if (typeof meta.modelId === "string" && modelCatalog().availableModels.some((model) => model.id === meta.modelId)) {
        state.defaultModel = meta.modelId;
      }
      notify("session/update", availableCommandsUpdate());
      return respond({
        sessionId,
        modes: null,
        models: modelCatalog(),
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: modelCatalog().currentModelId,
            options: modelCatalog().availableModels.map((model) => ({ value: model.id, name: model.name })),
          },
        ],
      });
    }
    case "session/load":
      notify("session/update", availableCommandsUpdate());
      return respond({ modes: null, models: modelCatalog() });
    case "session/prompt": {
      // A real turn reports its context through `x.ai/session/info`, never an ACP `usage_update`.
      state.context = {
        used: state.context.used + 1234,
        turns: state.context.turns + 1,
        messageCount: state.context.messageCount + 2,
      };
      const updates = state.promptUpdates.length > 0
        ? state.promptUpdates
        : splitReply(state.reply).map((text) => ({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          }));
      for (const update of updates) notify("session/update", { sessionId, update });
      if (state.promptDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, state.promptDelayMs));
      return respond({ stopReason: "end_turn" });
    }
    case "x.ai/session/info": {
      const total = 300_000;
      return respond({
        sessionId,
        cwd: "/tmp/thanh-demo",
        agentName: "thanh",
        model: modelCatalog().currentModelId,
        turns: state.context.turns,
        turnIndex: state.context.turns,
        context: {
          used: state.context.used,
          total,
          usagePct: Math.round((state.context.used / total) * 100),
          messageCount: state.context.messageCount,
          turnCount: state.context.turns,
          compactionCount: 0,
          toolDefinitionsCount: 12,
          freeTokens: total - state.context.used,
        },
      });
    }
    case "session/set_model": {
      const modelId = String(p.modelId ?? "");
      if (!modelCatalog().availableModels.some((model) => model.id === modelId)) {
        return respond({ error: `unknown model \`${modelId}\`` });
      }
      state.defaultModel = modelId;
      notify("x.ai/models/update", modelCatalog());
      return respond({ _meta: { model: modelId } });
    }
    case "session/set_mode": {
      // Plan mode is an ACP session mode: the agent answers `{}` and reports the new mode.
      const modeId = String(p.modeId ?? "");
      if (modeId !== "plan" && modeId !== "default") {
        return respond({ error: `unknown mode \`${modeId}\`` });
      }
      state.sessionMode = modeId;
      notify("session/update", { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
      return respond({});
    }
    case "x.ai/session/list":
      return respond({ sessions: state.sessions });
    case "x.ai/commands/list":
      return respond(commandList());
    case "x.ai/auth/info":
      return respond({ result: { methodId: state.authMethodId, email: null } });
    case "x.ai/models/list":
      return respond({ result: modelCatalog() });
    case "x.ai/models/set_default": {
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
    }
    case "x.ai/providers/presets":
      return respond({ presets: PROVIDER_PRESETS });
    case "x.ai/providers/list":
      return respond(providerList());
    case "x.ai/providers/upsert": {
      const id = String(p.id ?? "");
      if (!id) return respond({ error: "provider id must not be empty" });
      const models = Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>) : [];
      const apiKey = typeof p.apiKey === "string" ? p.apiKey : undefined;
      const envKey = typeof p.envKey === "string" ? p.envKey : undefined;
      const existing = state.providers.find((provider) => provider.id === id);
      if (!existing && !apiKey && !envKey) return respond({ error: "a new provider needs apiKey or envKey" });
      const next: MockProvider = {
        id,
        baseUrl: String(p.baseUrl ?? ""),
        apiBackend: String(p.apiBackend ?? "chat_completions"),
        apiKey: apiKey ?? (envKey ? undefined : existing?.apiKey),
        envKey: envKey ?? (apiKey ? undefined : existing?.envKey),
        models: models.map((model) => ({
          id: String(model.id ?? model.model ?? ""),
          name: typeof model.name === "string" ? model.name : undefined,
          input: Array.isArray(model.input) ? model.input.map(String) : undefined,
        })),
      };
      state.providers = [...state.providers.filter((provider) => provider.id !== id), next];
      if (p.setAsDefault && next.models[0]) state.defaultModel = next.models[0].id;
      notify("x.ai/models/update", modelCatalog());
      return respond({ ok: true, id, models: next.models.map((model) => model.id), defaultModel: state.defaultModel });
    }
    case "x.ai/providers/delete": {
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
    }
    case "x.ai/providers/test": {
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
    }
    case "x.ai/providers/discover_models": {
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
    }
    case "x.ai/mcp/list":
      return respond({ result: mcpList() });
    case "x.ai/mcp/toggle": {
      const server = state.mcpServers.find((entry) => entry.name === p.serverName);
      if (!server) return respond({ error: `unknown MCP server: ${String(p.serverName)}` });
      server.enabled = p.enabled !== false;
      notify("x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/mcp/upsert": {
      const name = String(p.serverName ?? "");
      if (!name) return respond({ error: "serverName is required" });
      const transport = p.type === "http" ? "http" : "stdio";
      state.mcpServers = [
        ...state.mcpServers.filter((entry) => entry.name !== name),
        {
          name,
          transport,
          ...(transport === "http"
            ? { url: String(p.url ?? "") }
            : { command: String(p.command ?? ""), args: Array.isArray(p.args) ? p.args.map(String) : [] }),
          enabled: true,
          toolCount: 0,
        },
      ];
      notify("x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/skills/list":
      return respond({ result: { skills: state.skills } });
    case "x.ai/plugins/list":
      return respond({ result: { plugins: state.plugins } });
    case "x.ai/memory/flush":
      return respond({ result: { ok: true } });
    case "x.ai/memory/rewrite":
      return respond({ result: { ok: true } });
    case "x.ai/fs/read_file":
      return respond(fileRead(String(p.path ?? "")));
    case "x.ai/fs/exists":
      return respond({ result: { exists: state.files[String(p.path ?? "")] !== undefined } });
    case "x.ai/fs/write_file": {
      state.files[String(p.path ?? "")] = String(p.content ?? "");
      return respond({ result: {} });
    }
    default:
      return respond({});
  }
}

function splitReply(reply: string): string[] {
  const midpoint = Math.max(1, Math.floor(reply.length / 2));
  return [reply.slice(0, midpoint), reply.slice(midpoint)].filter(Boolean);
}

export function mockReset(seed: Partial<MockState> = {}): void {
  state = { ...defaultState(), ...seed };
  requests = [];
  responses = [];
  nextServerRequestId = 1;
  persist();
}

export function mockRequests(): RecordedRequest[] {
  return [...requests];
}

export function mockState(): MockState {
  return structuredClone(state);
}

/** Native attachment picker stand-in: whatever the seed declared, or `null` for "not available". */
export function mockPickFiles(): string[] | null {
  return state.pickedFiles.length > 0 ? [...state.pickedFiles] : null;
}

/** `read_file_base64` stand-in for a path the seed declared. */
export function mockReadFilePayload(path: string): { data: string; mediaType: string; size: number } {
  const payload = state.filePayloads[path];
  if (!payload) throw new Error(`${path}: no such file`);
  return { ...payload };
}

/** Records what the renderer answered to a reverse request (permission / question / elicit). */
export function mockRespond(id: number | string, result: unknown): void {
  responses.push({ id, result, at: Date.now() });
}

/**
 * The machine-wide form of `x.ai/models/update`: the catalog moved on disk, so the payload is
 * empty and the client is expected to re-list rather than adopt an empty catalog.
 */
export function mockModelsUpdate(params: Record<string, unknown> = {}): void {
  notify("_x.ai/models/update", params);
}

/**
 * Ask the renderer for input the way an MCP server would, returning the request id so a test can
 * match the answer.
 */
export function mockElicit(overrides: Record<string, unknown> = {}): number {
  const id = nextServerRequestId++;
  request("x.ai/mcp/elicit", {
    sessionId: "mock-session",
    toolCallId: `mock-tool-${id}`,
    serverName: "filesystem",
    message: "Which directory should I expose?",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        path: { type: "string", title: "Directory", description: "Absolute path to expose" },
        depth: { type: "integer", title: "Depth" },
      },
      required: ["path"],
    },
    ...overrides,
  }, id);
  return id;
}

export function mockPermission(overrides: Record<string, unknown> = {}): number {
  const id = nextServerRequestId++;
  request("session/request_permission", {
    sessionId: "mock-session",
    toolCall: { title: "Run pnpm test", kind: "execute", content: [{ type: "text", text: "pnpm test" }] },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  }, id);
  return id;
}

export function mockQuestion(overrides: Record<string, unknown> = {}): number {
  const id = nextServerRequestId++;
  request("x.ai/ask_user_question", {
    sessionId: "mock-session",
    questions: [{ question: "Which approach should I use?", options: [{ id: "safe", label: "Safe change" }, { id: "fast", label: "Fast change" }] }],
    ...overrides,
  }, id);
  return id;
}

export function mockPlan(overrides: Record<string, unknown> = {}): number {
  const id = nextServerRequestId++;
  request("x.ai/exit_plan_mode", {
    sessionId: "mock-session",
    planContent: "# Implementation plan\n\n1. Update the transcript renderer\n2. Verify the desktop flow",
    ...overrides,
  }, id);
  return id;
}

export interface MockControl {
  reset(seed?: Partial<MockState>): void;
  requests(): RecordedRequest[];
  state(): MockState;
  responses(): Array<{ id: number | string; result: unknown; at: number }>;
  elicit(overrides?: Record<string, unknown>): number;
  permission(overrides?: Record<string, unknown>): number;
  question(overrides?: Record<string, unknown>): number;
  plan(overrides?: Record<string, unknown>): number;
  modelsUpdate(params?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __thanhMock?: MockControl;
  }
}

if (typeof window !== "undefined") {
  window.__thanhMock = {
    reset: mockReset,
    requests: mockRequests,
    state: mockState,
    responses: () => [...responses],
    elicit: mockElicit,
    permission: mockPermission,
    question: mockQuestion,
    plan: mockPlan,
    modelsUpdate: mockModelsUpdate,
  };
}
