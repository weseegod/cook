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
import type { FilePreview, ReviewSnapshot, WorkspaceEntry } from "./workspace";

export interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface MockSeedModel {
  id: string;
  model?: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
}

export interface MockProvider {
  id: string;
  name?: string;
  baseUrl: string;
  apiBackend: string;
  apiKey?: string;
  /** Persisted mock state keeps only presence, never the credential itself. */
  apiKeyPresent?: boolean;
  envKey?: string;
  models: MockSeedModel[];
}

export interface MockMcpTool {
  name: string;
  enabled: boolean;
}

export interface MockMcpSetupField {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface MockMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** Prefer `tools`; `toolCount` seeds anonymous tools when `tools` is omitted. */
  toolCount: number;
  tools?: MockMcpTool[];
  authRequired?: boolean;
  setupRequired?: boolean;
  setup?: { fields: MockMcpSetupField[] };
  setupValues?: Record<string, string>;
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
  id?: string;
  version?: string;
  enabled: boolean;
  description?: string;
  scope?: string;
}

export interface MockHook {
  name: string;
  event: string;
  disabled?: boolean;
  pinned?: boolean;
  matcher?: string;
}

export interface MockWorkflow {
  name: string;
  description?: string;
  source?: string;
}

export interface MockWorkspaceState {
  entries: Record<string, WorkspaceEntry[]>;
  files: Record<string, FilePreview>;
  review: ReviewSnapshot;
}

/**
 * One scripted prompt update: either an ACP `session/update` payload, or an extension envelope
 * (`{ notify, update }`) for the notifications the shell ships outside ACP, such as goal updates.
 */
export type MockPromptUpdate = Record<string, unknown>;

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
  hooks: MockHook[];
  hooksProjectTrusted: boolean;
  workflows: MockWorkflow[];
  skillPaths: string[];
  /** Force the next `providers/test` to fail, for the error-state path. */
  testFails: boolean;
  /** Force the next read-only `/models` probe to fail, for the error-state path. */
  probeFails: boolean;
  /** Model a build that predates `x.ai/models/set_default`, which answers -32601. */
  setDefaultUnsupported: boolean;
  /** Assistant text streamed back for each prompt. */
  reply: string;
  /** Optional exact ACP update sequence for transcript and visual tests. */
  promptUpdates: MockPromptUpdate[];
  /** Hold the prompt response open so visual tests can inspect live activity. */
  promptDelayMs: number;
  /** Agent-side project instruction files keyed by path. */
  files: Record<string, string>;
  /** Paths the native attachment picker returns; empty means "no native picker here". */
  pickedFiles: string[];
  /** Base64 payloads keyed by path, as `read_file_base64` would return them. */
  filePayloads: Record<string, { data: string; mediaType: string; size: number }>;
  workspace: MockWorkspaceState;
  /** Feature gates from initialize meta (`cancelRewind` / `sessionRecap`). */
  cancelRewind: boolean;
  sessionRecap: boolean;
  /** Checkpoints returned by `x.ai/rewind/points`. */
  rewindPoints: Array<{
    promptIndex: number;
    createdAt: string;
    numFileSnapshots: number;
    hasFileChanges?: boolean;
    promptPreview?: string;
  }>;
  /** Summary emitted after `x.ai/recap` (null → `session_recap_unavailable`). */
  recapSummary: string | null;
  /** Background tasks for `x.ai/task/list` (snake_case snapshots). */
  tasks: Array<Record<string, unknown>>;
  /** Running subagents for `x.ai/subagent/list_running`. */
  subagents: Array<Record<string, unknown>>;
  /** Scheduled `/loop` tasks for scheduler delete tests. */
  schedules: Array<Record<string, unknown>>;
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
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        enabled: true,
        toolCount: 3,
        tools: [
          { name: "read_file", enabled: true },
          { name: "write_file", enabled: true },
          { name: "list_dir", enabled: false },
        ],
      },
      { name: "linear", transport: "http", url: "https://mcp.linear.app/sse", enabled: false, toolCount: 0, tools: [] },
    ],
    skills: [
      { name: "help", description: "Documentation help", enabled: true },
      { name: "review", description: "Review my changes", enabled: false },
    ],
    plugins: [{ name: "thanh-core", id: "user/abcd1234/thanh-core", version: "1.0.0", enabled: true, scope: "user" }],
    hooks: [
      { name: "global/safety:pre_tool_use[0]", event: "pre_tool_use", disabled: false, matcher: "Bash" },
    ],
    hooksProjectTrusted: false,
    workflows: [{ name: "ship", description: "Ship a release", source: "project" }],
    skillPaths: [],
    testFails: false,
    probeFails: false,
    setDefaultUnsupported: false,
    reply: "Mock assistant reply.",
    promptUpdates: [],
    promptDelayMs: 0,
    files: {},
    pickedFiles: [],
    filePayloads: {},
    workspace: {
      entries: {
        "": [
          { name: "src", path: "src", kind: "directory", size: null },
          { name: "README.md", path: "README.md", kind: "file", size: 420 },
        ],
        src: [
          { name: "main.tsx", path: "src/main.tsx", kind: "file", size: 960 },
          { name: "theme", path: "src/theme", kind: "directory", size: null },
        ],
        "src/theme": [{ name: "app.css", path: "src/theme/app.css", kind: "file", size: 1400 }],
      },
      files: {
        "README.md": { path: "README.md", content: "# Thanh Desktop\n\nWorkspace preview.\n", size: 38, truncated: false, binary: false },
        "src/main.tsx": { path: "src/main.tsx", content: "import { AppShell } from \"./ui/app-shell\";\n\nexport default AppShell;\n", size: 72, truncated: false, binary: false },
        "src/theme/app.css": { path: "src/theme/app.css", content: ".app-frame { display: flex; }\n", size: 32, truncated: false, binary: false },
      },
      review: {
        base: "HEAD",
        isGitRepo: true,
        branch: "main",
        additions: 3,
        deletions: 1,
        files: [{ path: "src/main.tsx", status: "modified", additions: 3, deletions: 1, diff: "diff --git a/src/main.tsx b/src/main.tsx\n@@ -1,2 +1,4 @@\n import { AppShell } from \"./ui/app-shell\";\n+\n+export const ready = true;\n" }],
      },
    },
    cancelRewind: true,
    sessionRecap: true,
    rewindPoints: [
      {
        promptIndex: 0,
        createdAt: "2026-09-18T08:00:00Z",
        numFileSnapshots: 0,
        hasFileChanges: false,
        promptPreview: "Explain the architecture",
      },
      {
        promptIndex: 1,
        createdAt: "2026-09-18T08:05:00Z",
        numFileSnapshots: 2,
        hasFileChanges: true,
        promptPreview: "Refactor the auth module",
      },
    ],
    recapSummary: "We reviewed the architecture and started refactoring auth.",
    tasks: [],
    subagents: [],
    schedules: [],
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
    // The browser mock models the agent's durable config, but must not turn sessionStorage into
    // another secret store when a developer exercises the provider form with a real key.
    const safeProviders = state.providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      ...(apiKey ? { apiKeyPresent: true } : {}),
    }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, providers: safeProviders }));
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

/** Session-update shaped notif (U-memf / U-plug / U-hook*). */
function notifySessionUpdate(sessionUpdate: string, update: Record<string, unknown>): void {
  notify("session/update", {
    sessionId: "mock-session",
    update: { sessionUpdate, ...update },
  });
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
  return provider.models.map((model) => ({ ...model }));
}

function providerList() {
  return {
    providers: state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiBackend: provider.apiBackend,
      hasKey: Boolean(provider.apiKey) || Boolean(provider.apiKeyPresent) || Boolean(provider.envKey),
      inlineKey: Boolean(provider.apiKey) || Boolean(provider.apiKeyPresent),
      keyHint: provider.apiKey && provider.apiKey.length >= 12
        ? `${provider.apiKey.slice(0, 4)}…${provider.apiKey.slice(-4)}`
        : null,
      envKey: provider.envKey ?? null,
      envKeyPresent: false,
      extraHeaders: presetFor(provider.id)?.extraHeaders ?? {},
      models: linkedModels(provider),
    })),
    models: state.providers.flatMap((provider) => provider.models.map((model) => ({ ...model, provider: provider.id }))),
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
        _meta: { totalContextTokens: model.contextWindow ?? 300_000, maxCompletionTokens: model.maxCompletionTokens ?? 64_000, apiModel: model.model ?? model.id },
      });
    }
  }
  return {
    currentModelId: state.defaultModel ?? models[0]?.id ?? "",
    availableModels: models,
  };
}

function mcpToolsFor(server: MockMcpServer): MockMcpTool[] {
  if (server.tools) return server.tools;
  return Array.from({ length: server.toolCount }, (_, index) => ({
    name: `${server.name}_tool_${index}`,
    enabled: true,
  }));
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
        tools: mcpToolsFor(server).map((tool) => ({ name: tool.name, enabled: tool.enabled })),
        ...(server.authRequired ? { authRequired: true } : {}),
        ...(server.setupRequired ? { setupRequired: true } : {}),
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
      return respond({
        protocolVersion: 1,
        agentCapabilities: {},
        // ACP InitializeResponse carries agent meta as `_meta` on the wire for Desktop.
        _meta: {
          cancelRewind: state.cancelRewind,
          sessionRecap: state.sessionRecap,
          availableCommands: commandList().commands,
        },
      });
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
      for (const update of updates) {
        // A scripted entry can name an extension envelope (`x.ai/session_notification`), which is
        // how the shell ships goal updates; everything else is a plain `session/update`.
        const envelope = update as { notify?: string; update?: Record<string, unknown> };
        if (typeof envelope.notify === "string" && envelope.update) {
          notify(`_${envelope.notify}`, { sessionId, update: envelope.update });
          continue;
        }
        notify("session/update", { sessionId, update });
      }
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
    case "x.ai/session/fork": {
      // Map id `C-sess-fork`: camelCase ForkSessionRequest → new peer session.
      const sourceSessionId = String(p.sourceSessionId ?? "");
      const sourceCwd = String(p.sourceCwd ?? "/tmp/thanh-demo");
      const newCwd = String(p.newCwd ?? sourceCwd);
      if (!sourceSessionId) return respond({ error: "sourceSessionId is required" });
      const newSessionId = typeof p.newSessionId === "string" && p.newSessionId
        ? p.newSessionId
        : `fork-${sourceSessionId}`;
      const parent = state.sessions.find((session) => session.id === sourceSessionId);
      state.sessions = [
        {
          id: newSessionId,
          title: parent ? `${parent.title} (fork)` : "Forked conversation",
          cwd: newCwd,
          updatedAt: new Date().toISOString(),
        },
        ...state.sessions,
      ];
      return respond({
        newSessionId,
        newCwd,
        parentSessionId: sourceSessionId,
        chatMessagesCopied: 2,
        updatesCopied: 4,
        planStateCopied: false,
      });
    }
    case "x.ai/session/rename": {
      const id = String(p.sessionId ?? "");
      const title = String(p.title ?? "");
      state.sessions = state.sessions.map((session) => (session.id === id ? { ...session, title } : session));
      return respond({ ok: true });
    }
    case "x.ai/session/delete": {
      const id = String(p.sessionId ?? "");
      state.sessions = state.sessions.filter((session) => session.id !== id);
      return respond({ ok: true });
    }
    case "x.ai/commands/list":
      return respond(commandList());
    case "x.ai/auth/info":
      return respond({ result: { methodId: state.authMethodId, email: null } });
    case "x.ai/auth/logout":
      state.authMethodId = null;
      return respond({ result: { ok: true } });
    case "x.ai/setApiKey": {
      // Upstream keys on `key` and stores the xAI session key only, so the desktop's legacy shape
      // (`apiKey`, optional `provider`) is a no-op there. Provider credentials never travel this
      // way: the provider form hands them to the Tauri host, which writes config.toml.
      return respond({ result: { ok: true } });
    }
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
        models: [...(existing?.models ?? []).filter((model) => !seeded.has(model.id)), ...seeds],
      };
      const providerIndex = state.providers.findIndex((provider) => provider.id === id);
      state.providers = providerIndex < 0
        ? [...state.providers, next]
        : state.providers.map((provider, index) => index === providerIndex ? next : provider);
      if (p.setAsDefault && seeds[0]) state.defaultModel = seeds[0].id;
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
    case "x.ai/models/delete": {
      const modelId = String(p.modelId ?? "");
      if (!modelId) return respond({ error: "modelId must not be empty" });
      if (state.defaultModel === modelId) return respond({ error: `refusing to delete \`${modelId}\`: it is the default model; select another default first` });
      const provider = state.providers.find((entry) => entry.models.some((model) => model.id === modelId));
      if (!provider) return respond({ error: `no model \`${modelId}\` is configured` });
      provider.models = provider.models.filter((model) => model.id !== modelId);
      notify("x.ai/models/update", modelCatalog());
      return respond({ ok: true, modelId });
    }
    case "x.ai/models/upsert": {
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
    case "x.ai/providers/probe_models": {
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
      notify("_x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/mcp/toggle_tool": {
      const server = state.mcpServers.find((entry) => entry.name === p.serverName);
      if (!server) return respond({ error: `unknown MCP server: ${String(p.serverName)}` });
      const toolName = String(p.toolName ?? "");
      const tools = mcpToolsFor(server);
      const tool = tools.find((entry) => entry.name === toolName);
      if (!tool) return respond({ error: `unknown MCP tool: ${toolName}` });
      tool.enabled = p.enabled !== false;
      server.tools = tools;
      server.toolCount = tools.length;
      notify("_x.ai/mcp/tools_changed", { serverName: server.name, tools: tools.map((entry) => ({ name: entry.name, enabled: entry.enabled })) });
      notify("_x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/mcp/delete": {
      const name = String(p.serverName ?? "");
      if (!state.mcpServers.some((entry) => entry.name === name)) {
        return respond({ error: `server '${name}' not found in config.toml (only locally-configured servers can be deleted)` });
      }
      state.mcpServers = state.mcpServers.filter((entry) => entry.name !== name);
      notify("_x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/mcp/auth_status": {
      const filter = typeof p.serverName === "string" ? p.serverName : null;
      const servers = state.mcpServers
        .filter((entry) => !filter || entry.name === filter)
        .map((entry) => ({
          serverName: entry.name,
          status: entry.authRequired ? "auth_required" : entry.setupRequired ? "setup_required" : "authenticated",
        }));
      return respond({ result: { servers } });
    }
    case "x.ai/mcp/auth_trigger": {
      const server = state.mcpServers.find((entry) => entry.name === p.serverName);
      if (!server) return respond({ error: `unknown MCP server: ${String(p.serverName)}` });
      if (server.setupRequired) {
        return respond({ result: { status: "setup_required", setup: server.setup ?? { fields: [] } } });
      }
      server.authRequired = false;
      notify("_x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { status: "authenticated" } });
    }
    case "x.ai/mcp/setup": {
      const server = state.mcpServers.find((entry) => entry.name === p.serverName);
      if (!server) return respond({ error: `unknown MCP server: ${String(p.serverName)}` });
      const values = (p.values && typeof p.values === "object" && !Array.isArray(p.values))
        ? Object.fromEntries(Object.entries(p.values as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {};
      server.setupValues = values;
      server.setupRequired = false;
      server.authRequired = false;
      server.enabled = true;
      notify("_x.ai/mcp/servers_updated", mcpList());
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
          tools: [],
        },
      ];
      notify("_x.ai/mcp/servers_updated", mcpList());
      return respond({ result: { ok: true } });
    }
    case "x.ai/skills/list":
      return respond({ result: { skills: state.skills } });
    case "x.ai/skills/toggle": {
      const name = String(p.name ?? "");
      state.skills = state.skills.map((skill) =>
        skill.name === name ? { ...skill, enabled: p.enabled !== false } : skill,
      );
      return respond({ result: { ok: true } });
    }
    case "x.ai/skills/add":
    case "x.ai/skills/remove":
    case "x.ai/skills/reset":
    case "x.ai/skills/config":
      return respond({ result: { ok: true, skills: state.skills, message: "ok" } });
    case "x.ai/plugins/list":
      return respond({ result: { plugins: state.plugins } });
    case "x.ai/plugins/action": {
      const action = isRecord(p.action) ? p.action : {};
      const type = String(action.type ?? "");
      if (type === "enable" || type === "disable") {
        const id = String(action.plugin_id ?? "");
        state.plugins = state.plugins.map((plugin) =>
          plugin.id === id || plugin.name === id ? { ...plugin, enabled: type === "enable" } : plugin,
        );
      }
      return respond({ result: { status: "ok", message: type || "action" } });
    }
    case "x.ai/plugins/reload":
      return respond({ result: { status: "ok", message: "reloaded" } });
    case "x.ai/workflows/list":
      return respond({ result: { workflows: state.workflows ?? [] } });
    case "x.ai/hooks/list":
      return respond({
        result: {
          hooks: state.hooks ?? [],
          projectTrusted: state.hooksProjectTrusted === true,
        },
      });
    case "x.ai/hooks/action": {
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
    }
    case "x.ai/memory/flush":
      return respond({ result: { ok: true } });
    case "x.ai/memory/rewrite":
      return respond({ result: { ok: true } });
    case "x.ai/memory/forget":
      return respond({ result: { ok: true } });
    case "x.ai/fs/read_file":
      return respond(fileRead(String(p.path ?? "")));
    case "x.ai/fs/exists":
      return respond({ result: { exists: state.files[String(p.path ?? "")] !== undefined } });
    case "x.ai/fs/write_file": {
      state.files[String(p.path ?? "")] = String(p.content ?? "");
      return respond({ result: {} });
    }
    case "x.ai/task/list":
      return respond({
        result: {
          tasks: (state.tasks ?? []).filter((task) => !p.sessionId || task.owner_session_id === p.sessionId || !task.owner_session_id),
        },
      });
    case "x.ai/task/kill": {
      const taskId = String(p.taskId ?? "");
      state.tasks = (state.tasks ?? []).map((task) =>
        task.task_id === taskId ? { ...task, completed: true, explicitly_killed: true, exit_code: null } : task,
      );
      return respond({ result: { taskId, outcome: { kind: "killed" } } });
    }
    case "x.ai/subagent/list_running":
      return respond({ result: { subagents: state.subagents ?? [] } });
    case "x.ai/subagent/get": {
      const id = String(p.subagentId ?? "");
      const snap = (state.subagents ?? []).find((row) => row.subagent_id === id) ?? null;
      return respond({ result: { snapshot: snap } });
    }
    case "x.ai/subagent/cancel":
      return respond({ result: { subagentId: p.subagentId, cancelled: true, outcome: { kind: "cancelled" } } });
    case "x.ai/subagent/message":
      return respond({ result: { ok: true } });
    case "x.ai/scheduler/delete": {
      const taskId = String(p.taskId ?? "");
      state.schedules = (state.schedules ?? []).filter((row) => row.task_id !== taskId);
      return respond({ result: { taskId, deleted: true } });
    }
    case "x.ai/rewind/points": {
      return respond({
        result: {
          rewindPoints: state.rewindPoints.map((point) => ({
            promptIndex: point.promptIndex,
            createdAt: point.createdAt,
            numFileSnapshots: point.numFileSnapshots,
            hasFileChanges: point.hasFileChanges === true,
            promptPreview: point.promptPreview ?? null,
          })),
        },
      });
    }
    case "x.ai/rewind/execute": {
      const target = Number(p.targetPromptIndex ?? p.target_prompt_index);
      if (!Number.isFinite(target)) {
        return respond({ result: { success: false, target_prompt_index: 0, error: "targetPromptIndex required" } });
      }
      return respond({
        result: {
          success: true,
          target_prompt_index: target,
          mode: "all",
          reverted_files: [],
          clean_files: [],
          conflicts: [],
        },
      });
    }
    case "x.ai/recap": {
      if (!state.sessionRecap) return respond({ result: { ok: true, disabled: true } });
      // Fire-and-forget: the summary (or unavailable) arrives as a session_notification.
      queueMicrotask(() => {
        if (state.recapSummary) {
          notify("_x.ai/session_notification", {
            sessionId,
            update: { sessionUpdate: "session_recap", summary: state.recapSummary, auto: p.auto === true },
          });
        } else {
          notify("_x.ai/session_notification", {
            sessionId,
            update: { sessionUpdate: "session_recap_unavailable" },
          });
        }
      });
      return respond({ result: { ok: true } });
    }
    // P9 mid-turn / queue
    case "x.ai/btw":
      return respond({ result: { answer: `Side answer: ${String(p.question ?? "")}` } });
    case "x.ai/interject": {
      const text = String(p.text ?? "");
      const interjectionId = typeof p.interjectionId === "string" ? p.interjectionId : undefined;
      queueMicrotask(() => {
        notify("x.ai/session/interjection", {
          sessionId: String(p.sessionId ?? sessionId),
          text,
          ...(interjectionId ? { interjectionId } : {}),
        });
      });
      return respond({ result: { status: "queued" } });
    }
    case "x.ai/queue/remove":
    case "x.ai/queue/clear":
    case "x.ai/permissions/reset":
      return respond({});
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

export function mockWorkspaceList(relativePath = ""): WorkspaceEntry[] {
  const entries = state.workspace.entries[relativePath];
  if (!entries) throw new Error(`directory not found: ${relativePath || "."}`);
  return structuredClone(entries);
}

export function mockWorkspaceReadFile(relativePath: string): FilePreview {
  const preview = state.workspace.files[relativePath];
  if (!preview) throw new Error(`file not found: ${relativePath}`);
  return structuredClone(preview);
}

export function mockWorkspaceReview(): ReviewSnapshot {
  return structuredClone(state.workspace.review);
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

/**
 * Ship one `x.ai/session_notification` update the way the shell does (goal updates, relay status):
 * an extension method carrying `{ sessionId, update }`.
 */
export function mockSessionNotification(update: Record<string, unknown>): void {
  notify("_x.ai/session_notification", { sessionId: "mock-session", update });
}

/** Ext notif helpers for activity panel tests (SessionNotification envelope). */
export function mockTaskBackgrounded(overrides: Record<string, unknown> = {}): void {
  notify("_x.ai/task_backgrounded", {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "task_backgrounded",
      tool_call_id: "tc-1",
      task_id: "task-1",
      command: "sleep 30",
      cwd: "/tmp",
      output_file: "/tmp/out.log",
      description: "Wait for server",
      ...overrides,
    },
  });
}

export function mockTaskCompleted(overrides: Record<string, unknown> = {}): void {
  notify("_x.ai/task_completed", {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "task_completed",
      will_wake: false,
      task_snapshot: {
        task_id: "task-1",
        command: "sleep 30",
        cwd: "/tmp",
        output: "",
        output_file: "/tmp/out.log",
        truncated: false,
        completed: true,
        exit_code: 0,
        description: "Wait for server",
        is_backgrounded: true,
        ...(isRecord(overrides.task_snapshot) ? overrides.task_snapshot : {}),
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "task_snapshot")),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A goal snapshot with the wire's required fields; callers override what they exercise. */
export function goalUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "goal_updated",
    goal_id: "goal-1",
    objective: "Ship the desktop goal surface",
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_deliverables: 0,
    completed_deliverables: 0,
    total_worker_rounds: 0,
    total_verify_rounds: 0,
    token_baseline: 0,
    finished_subagent_tokens: 0,
    ...overrides,
  };
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
  sessionNotification(update: Record<string, unknown>): void;
  taskBackgrounded(overrides?: Record<string, unknown>): void;
  taskCompleted(overrides?: Record<string, unknown>): void;
  goalUpdate(overrides?: Record<string, unknown>): Record<string, unknown>;
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
    sessionNotification: mockSessionNotification,
    taskBackgrounded: mockTaskBackgrounded,
    taskCompleted: mockTaskCompleted,
    goalUpdate,
    modelsUpdate: mockModelsUpdate,
  };
}
