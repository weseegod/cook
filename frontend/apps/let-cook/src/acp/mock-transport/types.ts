import type { FilePreview, ReviewSnapshot, WorkspaceEntry } from "../workspace";

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
  supportsReasoningEffort?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: Array<string | { id?: string; value: string; label?: string; description?: string; default?: boolean }>;
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
  oauth?: boolean;
  models: MockSeedModel[];
}

export interface MockMcpTool {
  name: string;
  enabled: boolean;
  displayName?: string;
  description?: string;
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
  transport: "stdio" | "http" | "managedGateway";
  /** Human title (`display_name` on the wire). */
  displayName?: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** Wire `source`: `"local"` or `"managed"`. Drives the Settings section grouping. */
  source?: "local" | "managed";
  /** Wire `source_label`; `"plugin: <name>"` puts the server in that plugin's section. */
  sourceLabel?: string;
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
  /** Frontmatter label, serialized on the wire as `display_name` (SkillInfo has no rename_all). */
  display_name?: string;
  description?: string;
  /** `local` | `repo` | `user` | `bundled` | `plugin` | `server`. */
  scope?: string;
  path?: string;
  enabled: boolean;
}

/** One saved conversation as `x.ai/session/list` reports it. */
export interface MockSession {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
}

/** One plan file as `x.ai/session/plans` reports it, in the agent's camelCase wire shape. */
export interface MockPlanFile {
  name: string;
  /** H1 shown in the chip. Derived from `content` on the client when omitted. */
  title?: string;
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
  active: boolean;
  deletable: boolean;
  content: string | null;
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
  /**
   * Folder the workspace commands answer for, as the agent's host tracks it: `session/new` and
   * `session/load` set it, because a conversation can live in another project than the one the
   * window connected to. `null` (or unset) means "no conversation opened yet".
   */
  cwd?: string | null;
  /**
   * Working trees that differ from {@link review}, keyed by that folder, for the tests that drive a
   * window across two projects — a repository here, a folder with no git there.
   */
  byCwd?: Record<string, ReviewSnapshot>;
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
  /** Plan files of the loaded session, newest first, as `x.ai/session/plans` reports them. */
  planFiles: MockPlanFile[];
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
  /** Model a build that predates the plan list, which answers -32601 to `x.ai/session/plans`. */
  planListUnsupported: boolean;
  /** Model a build that predates the data-controls wipe, which answers -32601 to `x.ai/sessions/delete_all`. */
  deleteAllUnsupported: boolean;
  /** Assistant text streamed back for each prompt. */
  reply: string;
  /** Optional exact ACP update sequence for transcript and visual tests. */
  promptUpdates: MockPromptUpdate[];
  /** Optional replayed session/update sequence emitted by `session/load` for long-session tests. */
  historyUpdates: MockPromptUpdate[];
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

export interface MockControl {
  reset(seed?: Partial<MockState>): void;
  requests(): RecordedRequest[];
  state(): MockState;
  responses(): Array<{ id: number | string; result: unknown; at: number }>;
  elicit(overrides?: Record<string, unknown>): number;
  permission(overrides?: Record<string, unknown>): number;
  question(overrides?: Record<string, unknown>): number;
  plan(overrides?: Record<string, unknown>): number;
  sessionNotification(update: Record<string, unknown>, sessionId?: string): void;
  /** A plain `session/update` under any session, with `_meta` — how a child session streams. */
  sessionUpdate(sessionId: string, update: Record<string, unknown>, meta?: Record<string, unknown>): void;
  /** Patch the mocked working tree so a running turn's diffstat can be seen to move. */
  workspaceReview(overrides: Partial<ReviewSnapshot>): void;
  taskBackgrounded(overrides?: Record<string, unknown>): void;
  taskCompleted(overrides?: Record<string, unknown>): void;
  /** Grow a mocked background task's stdout, so an open viewer can be seen to follow it. */
  taskOutput(taskId: string, output: string): void;
  goalUpdate(overrides?: Record<string, unknown>): Record<string, unknown>;
  modelsUpdate(params?: Record<string, unknown>): void;
  /** Approve an in-flight ChatGPT / Claude / Grok OAuth Connect from a Playwright test. */
  completeOAuth(id: string): void;
}
