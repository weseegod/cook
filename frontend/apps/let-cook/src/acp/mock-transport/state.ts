import { resetMockOauth } from "./oauth-pending";
import type { MockState, RecordedRequest } from "./types";

function defaultState(): MockState {
  return {
    authMethodId: null,
    defaultModel: null,
    sessionMode: "default",
    // A fresh session already holds its system prompt and tool definitions, as the real one does.
    context: { used: 1474, turns: 0, messageCount: 1 },
    providers: [],
    xaiModels: [],
    xaiApiKeyPresent: false,
    discoverable: [{ id: "mock-discovered-model", name: "Mock Discovered" }],
    sessions: [
      { id: "session-login", title: "Fix login bug", cwd: "/tmp/cook-demo", updatedAt: "2026-09-15T10:00:00Z" },
      { id: "session-providers", title: "Provider settings", cwd: "/tmp/cook-demo", updatedAt: "2026-09-14T10:00:00Z" },
    ],
    planFiles: [],
    mcpServers: [
      {
        name: "managed_gateway:cursor",
        displayName: "Cursor",
        transport: "managedGateway",
        source: "managed",
        enabled: true,
        toolCount: 0,
        tools: [
          { name: "browser_navigate", enabled: true, displayName: "Navigate" },
          { name: "gmail__search", enabled: true, displayName: "Search Gmail" },
          { name: "mail", enabled: true, displayName: "Mail" },
        ],
      },
      {
        name: "managed_gateway:gmail",
        displayName: "Gmail",
        transport: "managedGateway",
        source: "managed",
        enabled: true,
        toolCount: 0,
        tools: [
          { name: "gmail__search", enabled: true, displayName: "Search Gmail" },
        ],
      },
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
      {
        name: "game-tilesets",
        display_name: "Game tilesets",
        description: "Generate game tilesets",
        scope: "bundled",
        path: "/home/demo/.cook/bundled/skills/game-tilesets/SKILL.md",
        enabled: true,
      },
      {
        name: "game-asset-core",
        display_name: "Game asset core",
        description: "Core game asset workflow",
        scope: "bundled",
        path: "/home/demo/.cook/bundled/skills/game-asset-core/SKILL.md",
        enabled: false,
      },
      {
        name: "pdf",
        display_name: "PDF",
        description: "Read and write PDFs",
        scope: "bundled",
        path: "/home/demo/.cook/bundled/skills/pdf/SKILL.md",
        enabled: true,
      },
      {
        name: "resume-claude",
        display_name: "Resume Claude",
        description: "Resume a Claude session",
        scope: "bundled",
        path: "/home/demo/.cook/bundled/skills/resume-claude/SKILL.md",
        enabled: true,
      },
      {
        name: "review",
        description: "Review my changes",
        scope: "user",
        path: "/home/demo/.cook/skills/review/SKILL.md",
        enabled: false,
      },
    ],
    plugins: [{ name: "cook-core", id: "user/abcd1234/cook-core", version: "1.0.0", enabled: true, scope: "user" }],
    hooks: [
      { name: "global/safety:pre_tool_use[0]", event: "pre_tool_use", disabled: false, matcher: "Bash" },
    ],
    hooksProjectTrusted: false,
    workflows: [{ name: "ship", description: "Ship a release", source: "project" }],
    skillPaths: [],
    testFails: false,
    probeFails: false,
    setDefaultUnsupported: false,
    planListUnsupported: false,
    deleteAllUnsupported: false,
    reply: "Mock assistant reply.",
    promptUpdates: [],
    historyUpdates: [],
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
        "README.md": { path: "README.md", content: "# Let Cook\n\nWorkspace preview.\n", size: 38, truncated: false, binary: false },
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
    queueEntries: [],
    ...seedFromWindow(),
    // Whatever the agent already wrote wins: the renderer's own memory is not the source of truth.
    ...persisted(),
  };
}

/** A browser test sets `window.__cookMockSeed` before load to start from a known state. */
function seedFromWindow(): Partial<MockState> {
  if (typeof window === "undefined") return {};
  return (window as unknown as { __cookMockSeed?: Partial<MockState> }).__cookMockSeed ?? {};
}

/**
 * State the agent would keep on disk. `sessionStorage` stands in for it so a reload inside one
 * browser context proves the renderer is not the one holding the provider configuration.
 */
const STORAGE_KEY = "cook.mock.acp.state";

function persisted(): Partial<MockState> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<MockState>) : {};
  } catch {
    return {};
  }
}

export function persist(): void {
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

export let state: MockState = defaultState();
let requests: RecordedRequest[] = [];
export let responses: Array<{ id: number | string; result: unknown; at: number }> = [];
let nextServerRequestId = 1;
const subscribers = new Set<(message: unknown) => void>();

export function record(method: string, params: unknown): void {
  requests.push({
    method,
    params: (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    at: Date.now(),
  });
}

function emit(message: unknown): void {
  for (const subscriber of subscribers) subscriber(message);
}

export function notify(method: string, params: unknown): void {
  emit({ jsonrpc: "2.0", method, params });
}

/** Session-update shaped notif (U-memf / U-plug / U-hook*). */
export function notifySessionUpdate(sessionUpdate: string, update: Record<string, unknown>): void {
  notify("session/update", {
    sessionId: "mock-session",
    update: { sessionUpdate, ...update },
  });
}

/** A reverse request (agent → client) that expects an answer; the id is what the client responds to. */
export function request(method: string, params: unknown, id: number): void {
  emit({ jsonrpc: "2.0", id, method, params });
}

export function subscribe(handler: (message: unknown) => void): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

export function nextRequestId(): number {
  return nextServerRequestId++;
}

export function mockReset(seed: Partial<MockState> = {}): void {
  state = { ...defaultState(), ...seed };
  requests = [];
  responses = [];
  nextServerRequestId = 1;
  resetMockOauth();
  persist();
}

export function mockRequests(): RecordedRequest[] {
  return [...requests];
}

export function mockState(): MockState {
  return structuredClone(state);
}
