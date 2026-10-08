/**
 * Thin wrappers over the agent extensions the Settings surfaces drive: MCP connectors,
 * project instruction files, memory, and skills/plugins. Every call is an ACP request —
 * the renderer never touches files or `config.toml` itself.
 */
import { request } from "./host";
import { normalizeMcpServer } from "./mcp-servers";
import { mcpServerParams, mcpSessionParams, mcpToolParams } from "./wire-params";

export interface McpToolSummary {
  name: string;
  enabled?: boolean;
  displayName?: string;
  description?: string;
}

export interface McpSetupOption {
  label: string;
  value: string;
}

export interface McpSetupField {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  default?: string;
  options?: McpSetupOption[];
}

export interface McpSetupConfig {
  fields?: McpSetupField[];
}

export interface McpServerView {
  name: string;
  /** Human title from the agent (`display_name` / `displayName`); wire id stays in `name`. */
  displayName?: string;
  source?: string;
  /** Wire `source_label`; `"plugin: <name>"` marks a server a plugin owns. */
  sourceLabel?: string;
  type?: "http" | "stdio" | "managedGateway" | string;
  url?: string;
  command?: string;
  args?: string[];
  setup?: McpSetupConfig;
  setupValues?: Record<string, string>;
  session?: {
    enabled?: boolean;
    status?: string;
    tools?: McpToolSummary[];
    authRequired?: boolean;
    setupRequired?: boolean;
    blockedReason?: string;
  };
}

/**
 * List the session's MCP servers. Rows go through the same normalizer the `mcp/servers_updated`
 * notification uses, so section grouping sees `sourceLabel` on both paths.
 */
export async function listConnectors(sessionId?: string, cache = false) {
  const result = await request<{ servers?: Record<string, unknown>[] }>("x.ai/mcp/list", {
    ...(sessionId ? { sessionId } : {}),
    cache,
  });
  return { servers: (result?.servers ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object").map(normalizeMcpServer) };
}

export function toggleConnector(sessionId: string, serverName: string, enabled: boolean) {
  return request<{ ok: boolean }>("x.ai/mcp/toggle", mcpServerParams(sessionId, serverName, { enabled }));
}

export function deleteConnector(sessionId: string, serverName: string) {
  return request<{ ok: boolean }>("x.ai/mcp/delete", mcpServerParams(sessionId, serverName));
}

export function toggleConnectorTool(sessionId: string, serverName: string, toolName: string, enabled: boolean) {
  return request<{ ok: boolean }>(
    "x.ai/mcp/toggle_tool",
    mcpToolParams(sessionId, serverName, toolName, enabled),
  );
}

export function mcpAuthStatus(sessionId: string, serverName?: string) {
  return request<{ servers: Array<{ serverName: string; status: string }> }>(
    "x.ai/mcp/auth_status",
    mcpSessionParams(sessionId, serverName ? { serverName, server_name: serverName } : {}),
  );
}

export function mcpAuthTrigger(sessionId: string, serverName: string) {
  return request<{ status: string; setup?: McpSetupConfig; error?: string }>(
    "x.ai/mcp/auth_trigger",
    mcpServerParams(sessionId, serverName),
  );
}

export function mcpSetup(sessionId: string, serverName: string, values: Record<string, string> = {}) {
  return request<{ ok: boolean }>("x.ai/mcp/setup", { sessionId, serverName, values });
}

export function upsertConnector(
  sessionId: string,
  serverName: string,
  config: { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> } | { type: "http"; url: string },
) {
  return request<{ ok: boolean }>("x.ai/mcp/upsert", mcpServerParams(sessionId, serverName, config));
}

export function readProjectFile(sessionId: string | undefined, path: string) {
  return request<{ content: string; size: number }>("x.ai/fs/read_file", {
    ...(sessionId ? { sessionId } : {}),
    path,
  });
}

export function writeProjectFile(sessionId: string | undefined, path: string, content: string) {
  return request<Record<string, never>>("x.ai/fs/write_file", {
    ...(sessionId ? { sessionId } : {}),
    path,
    content,
  });
}

export function fileExists(sessionId: string | undefined, path: string) {
  return request<{ exists: boolean }>("x.ai/fs/exists", {
    ...(sessionId ? { sessionId } : {}),
    path,
  });
}

export interface SkillView {
  name: string;
  /** Frontmatter label; falls back to `name`. `display_name` on the wire. */
  displayName?: string;
  description?: string;
  enabled?: boolean;
  /** `local` | `repo` | `user` | `bundled` | `plugin` | `server`. */
  scope?: string;
  /** `SKILL.md` path; the stable key for a row. */
  path?: string;
  pluginName?: string;
  source?: string;
  whenToUse?: string;
}

/**
 * `SkillInfo` has no `rename_all`, so `display_name` / `plugin_name` / `when_to_use` arrive
 * snake_case while the pager's own DTOs use camelCase. Read both.
 */
export function normalizeSkill(raw: Record<string, unknown>): SkillView {
  return {
    name: String(raw.name ?? "skill"),
    displayName: typeof raw.displayName === "string"
      ? raw.displayName
      : typeof raw.display_name === "string"
        ? raw.display_name
        : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    enabled: raw.enabled !== false,
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    path: typeof raw.path === "string" ? raw.path : undefined,
    pluginName: typeof raw.pluginName === "string"
      ? raw.pluginName
      : typeof raw.plugin_name === "string"
        ? raw.plugin_name
        : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
    whenToUse: typeof raw.whenToUse === "string"
      ? raw.whenToUse
      : typeof raw.when_to_use === "string"
        ? raw.when_to_use
        : undefined,
  };
}

/**
 * The agent's `SkillsListRequest.cwd` is a required string, and discovery keys off it: project
 * skills come from this directory, user/bundled skills from `~/.cook`. A missing cwd must never
 * drop the request, so fall back to `.` — the agent process runs in the workspace root.
 */
export function skillCwd(cwd?: string): string {
  return cwd && cwd.trim() ? cwd : ".";
}

export async function listSkills(cwd?: string) {
  const result = await request<{ skills?: Record<string, unknown>[]; items?: Record<string, unknown>[] }>(
    "x.ai/skills/list",
    { cwd: skillCwd(cwd) },
  );
  const raw = result?.skills ?? result?.items ?? [];
  return { skills: raw.map(normalizeSkill) };
}

export interface SkillsToggleResult {
  ok?: boolean;
  skills?: Record<string, unknown>[];
}

/** Flip one skill, the way a row switch does. */
export function toggleSkill(name: string, enabled: boolean, cwd?: string) {
  return request<SkillsToggleResult>("x.ai/skills/toggle", {
    name,
    enabled,
    cwd: skillCwd(cwd),
  });
}

/**
 * Flip a whole group by fanning out the single-name call the installed CLI accepts.
 * Each `skills/toggle` is a read-modify-write of `[skills].disabled`, so calls run sequentially
 * to avoid tearing that list. Stops at the first rejection; earlier writes stay applied.
 */
export async function toggleSkills(names: string[], enabled: boolean, cwd?: string) {
  let last: SkillsToggleResult | undefined;
  for (const name of names) {
    last = await toggleSkill(name, enabled, cwd);
  }
  return last ?? { ok: true };
}

export interface PluginView {
  name: string;
  /** Stable id (`<scope>/<hex8>/<name>`); required for enable/disable. */
  id?: string;
  version?: string;
  enabled?: boolean;
  description?: string;
  scope?: string;
}

export function listPlugins(sessionId?: string) {
  return request<{ plugins?: PluginView[]; items?: PluginView[] }>(
    "x.ai/plugins/list",
    sessionId ? { sessionId } : {},
  );
}

/** `x.ai/prompts/*`: the user-editable copies of the shell's model-facing prompt templates. */
export type PromptState = "absent" | "unmodified" | "modified";

export interface PromptEntryView {
  /** Path relative to the prompts root, e.g. `plan/full.md`. */
  relative: string;
  /** Absolute path of the user's copy, whether or not it exists yet. */
  path: string;
  state: PromptState;
}

export interface PromptList {
  /** The prompts root these paths live under (`<cook home>/prompts`). */
  root: string;
  prompts: PromptEntryView[];
}

export interface PromptContent {
  relative: string;
  path: string;
  state: PromptState;
  /** The user's copy; `null` when none exists yet. */
  content: string | null;
  /** The compiled default, for showing and seeding a first edit. */
  default: string;
}

export interface PromptWriteResult {
  relative: string;
  state: PromptState;
}

export function listPrompts() {
  return request<PromptList>("x.ai/prompts/list");
}

export function readPrompt(relative: string) {
  return request<PromptContent>("x.ai/prompts/read", { relative });
}

export function writePrompt(relative: string, content: string) {
  return request<PromptWriteResult>("x.ai/prompts/write", { relative, content });
}

export function restorePrompt(relative: string) {
  return request<PromptWriteResult>("x.ai/prompts/restore", { relative });
}

/** `x.ai/skills/default` and `x.ai/skills/restore`: the shipped `SKILL.md` behind a skill row. */
export type SkillState = "absent" | "unmodified" | "modified";

export interface SkillDefaultView {
  name: string;
  /** The user's copy, `<cook home>/skills/<name>/SKILL.md`; empty when Cook ships no default. */
  path: string;
  /** Whether Cook ships this skill, and so whether Settings can offer Reset at all. */
  hasDefault: boolean;
  state: SkillState;
  /** The user's copy; `null` when none exists yet. */
  content: string | null;
  /** The shipped body, empty when the skill ships no default. */
  default: string;
}

export interface SkillRestoreResult {
  name: string;
  /** `unmodified` once the shipped body is back in place. */
  state: SkillState;
}

/** The shipped body and the user's copy of one skill. */
export function readSkillDefault(name: string, cwd?: string) {
  return request<SkillDefaultView>("x.ai/skills/default", { name, cwd: skillCwd(cwd) });
}

/** Write the shipped body back over the user's copy of one skill. */
export function restoreSkillDefault(name: string, cwd?: string) {
  return request<SkillRestoreResult>("x.ai/skills/restore", { name, cwd: skillCwd(cwd) });
}

export function flushMemory(sessionId: string) {
  return request<Record<string, unknown>>("x.ai/memory/flush", { session_id: sessionId });
}

/** The instruction files a workspace can carry, in the order the agent prefers them. */
export const PROJECT_FILES = [
  { path: "AGENTS.md", label: "AGENTS.md", description: "Project instructions the agent reads on every turn" },
  { path: ".cook/rules.md", label: ".cook/rules.md", description: "Fork-local rules for this workspace" },
  { path: "CLAUDE.md", label: "CLAUDE.md", description: "Imported Claude project instructions" },
];

export function serverTransportLabel(server: McpServerView): string {
  const type = server.type ?? (server.url ? "http" : "stdio");
  if (type === "http") return server.url ?? "http";
  if (type === "managedGateway") return "managed connector";
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "stdio";
}

export function serverEnabled(server: McpServerView): boolean {
  return server.session?.enabled !== false;
}
