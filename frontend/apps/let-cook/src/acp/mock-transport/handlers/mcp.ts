import { mcpList, mcpToolsFor } from "../catalog";
import { notify, state } from "../state";
import type { MethodHandler } from "./registry";

export const mcpHandlers: Record<string, MethodHandler> = {
  "x.ai/mcp/list": ({ respond }) => {
    return respond({ result: mcpList() });
  },
  // The mutating MCP methods decode snake_case only (no `rename_all` on the shell request
  // structs), so reading `serverName` here would hide a camelCase-only client.
  "x.ai/mcp/toggle": ({ p, respond }) => {
    const server = state.mcpServers.find((entry) => entry.name === p.server_name);
    if (!server) return respond({ error: `unknown MCP server: ${String(p.server_name)}` });
    server.enabled = p.enabled !== false;
    notify("_x.ai/mcp/servers_updated", mcpList());
    return respond({ result: { ok: true } });
  },
  "x.ai/mcp/toggle_tool": ({ p, respond }) => {
    const server = state.mcpServers.find((entry) => entry.name === p.server_name);
    if (!server) return respond({ error: `unknown MCP server: ${String(p.server_name)}` });
    const toolName = String(p.tool_name ?? "");
    const tools = mcpToolsFor(server);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) return respond({ error: `unknown MCP tool: ${toolName}` });
    tool.enabled = p.enabled !== false;
    server.tools = tools;
    server.toolCount = tools.length;
    notify("_x.ai/mcp/tools_changed", { serverName: server.name, tools: tools.map((entry) => ({ name: entry.name, enabled: entry.enabled })) });
    notify("_x.ai/mcp/servers_updated", mcpList());
    return respond({ result: { ok: true } });
  },
  "x.ai/mcp/delete": ({ p, respond }) => {
    const name = String(p.server_name ?? "");
    if (!state.mcpServers.some((entry) => entry.name === name)) {
      return respond({ error: `server '${name}' not found in config.toml (only locally-configured servers can be deleted)` });
    }
    state.mcpServers = state.mcpServers.filter((entry) => entry.name !== name);
    notify("_x.ai/mcp/servers_updated", mcpList());
    return respond({ result: { ok: true } });
  },
  "x.ai/mcp/auth_status": ({ p, respond }) => {
    const filter = typeof p.server_name === "string" ? p.server_name : null;
    const servers = state.mcpServers
      .filter((entry) => !filter || entry.name === filter)
      .map((entry) => ({
        serverName: entry.name,
        status: entry.authRequired ? "auth_required" : entry.setupRequired ? "setup_required" : "authenticated",
      }));
    return respond({ result: { servers } });
  },
  "x.ai/mcp/auth_trigger": ({ p, respond }) => {
    const server = state.mcpServers.find((entry) => entry.name === p.server_name);
    if (!server) return respond({ error: `unknown MCP server: ${String(p.server_name)}` });
    if (server.setupRequired) {
      return respond({ result: { status: "setup_required", setup: server.setup ?? { fields: [] } } });
    }
    server.authRequired = false;
    notify("_x.ai/mcp/servers_updated", mcpList());
    return respond({ result: { status: "authenticated" } });
  },
  "x.ai/mcp/setup": ({ p, respond }) => {
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
  },
  "x.ai/mcp/upsert": ({ p, respond }) => {
    const name = String(p.server_name ?? "");
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
  },
};
