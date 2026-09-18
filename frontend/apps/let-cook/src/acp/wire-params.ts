/**
 * Params for the agent's MCP extension methods.
 *
 * The shell's request structs for the mutating `x.ai/mcp/*` methods (`toggle`, `toggle_tool`,
 * `delete`, `upsert`, `auth_status`, `auth_trigger`) are plain snake_case with no
 * `rename_all = "camelCase"` — that is what the TUI sends. `x.ai/mcp/list` and `x.ai/mcp/setup`
 * are the camelCase exceptions. Sending only camelCase to a live agent answers `invalid_params`,
 * so both casings travel together and either decoder is satisfied.
 */

/** `{ sessionId, session_id }` — the pair every session-scoped MCP method accepts. */
export function mcpSessionParams(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, session_id: sessionId, ...extra };
}

/** Adds `{ serverName, server_name }`. */
export function mcpServerParams(
  sessionId: string,
  serverName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return mcpSessionParams(sessionId, { serverName, server_name: serverName, ...extra });
}

/** Adds `{ toolName, tool_name }`. */
export function mcpToolParams(
  sessionId: string,
  serverName: string,
  toolName: string,
  enabled: boolean,
): Record<string, unknown> {
  return mcpServerParams(sessionId, serverName, { toolName, tool_name: toolName, enabled });
}
