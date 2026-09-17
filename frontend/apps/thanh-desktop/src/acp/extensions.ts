/**
 * Thin wrappers over the agent extensions the Settings surfaces drive: MCP connectors,
 * project instruction files, memory, and skills/plugins. Every call is an ACP request —
 * the renderer never touches files or `config.toml` itself.
 */
import { request } from "./host";

export interface McpToolSummary {
  name: string;
}

export interface McpServerView {
  name: string;
  source?: string;
  type?: "http" | "stdio" | "managedGateway" | string;
  url?: string;
  command?: string;
  args?: string[];
  session?: {
    enabled?: boolean;
    status?: string;
    tools?: McpToolSummary[];
    authRequired?: boolean;
    setupRequired?: boolean;
    blockedReason?: string;
  };
}

export function listConnectors(sessionId?: string, cache = false) {
  return request<{ servers: McpServerView[] }>("x.ai/mcp/list", {
    ...(sessionId ? { sessionId } : {}),
    cache,
  });
}

export function toggleConnector(sessionId: string, serverName: string, enabled: boolean) {
  return request<{ ok: boolean }>("x.ai/mcp/toggle", { sessionId, serverName, enabled });
}

export function upsertConnector(
  sessionId: string,
  serverName: string,
  config: { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> } | { type: "http"; url: string },
) {
  return request<{ ok: boolean }>("x.ai/mcp/upsert", { sessionId, serverName, ...config });
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
  description?: string;
  enabled?: boolean;
  source?: string;
}

export function listSkills(cwd?: string) {
  return request<{ skills?: SkillView[]; items?: SkillView[] }>("x.ai/skills/list", cwd ? { cwd } : {});
}

export function toggleSkill(name: string, enabled: boolean, cwd?: string) {
  return request<{ ok?: boolean }>("x.ai/skills/toggle", { name, enabled, ...(cwd ? { cwd } : {}) });
}

export interface PluginView {
  name: string;
  version?: string;
  enabled?: boolean;
  description?: string;
}

export function listPlugins() {
  return request<{ plugins?: PluginView[]; items?: PluginView[] }>("x.ai/plugins/list", {});
}

export function flushMemory() {
  return request<Record<string, unknown>>("x.ai/memory/flush", {});
}

export function rewriteMemory() {
  return request<Record<string, unknown>>("x.ai/memory/rewrite", {});
}

export function forgetMemory() {
  return request<Record<string, unknown>>("x.ai/memory/forget", {});
}

/** The instruction files a workspace can carry, in the order the agent prefers them. */
export const PROJECT_FILES = [
  { path: "AGENTS.md", label: "AGENTS.md", description: "Project instructions the agent reads on every turn" },
  { path: ".thanh/rules.md", label: ".thanh/rules.md", description: "Fork-local rules for this workspace" },
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
