/**
 * MCP catalog rows as the Settings → Connectors surface needs them.
 *
 * Kept free of store and Tauri imports so both `acp/extensions.ts` (the request path) and the
 * notification handlers can normalize the same payload into the same shape.
 */
import type { McpServerView, McpToolSummary } from "./extensions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSetup(raw: Record<string, unknown>) {
  if (!isRecord(raw.setup)) return undefined;
  return {
    fields: Array.isArray(raw.setup.fields)
      ? raw.setup.fields.filter(isRecord).map((field) => ({
          id: String(field.id ?? ""),
          label: String(field.label ?? field.id ?? ""),
          type: typeof field.type === "string" ? field.type : undefined,
          required: field.required === true,
          default: typeof field.default === "string" ? field.default : undefined,
          options: Array.isArray(field.options)
            ? field.options.filter(isRecord).map((option) => ({
                label: String(option.label ?? option.value ?? ""),
                value: String(option.value ?? ""),
              }))
            : undefined,
        }))
      : [],
  };
}

/**
 * One wire server row. `source_label` is what tells a plugin-owned server apart from a local one,
 * and the TUI's MCP sections key off it, so it has to survive normalization.
 */
export function normalizeMcpServer(server: Record<string, unknown>): McpServerView {
  const session = isRecord(server.session) ? server.session : undefined;
  const toolsRaw = session && Array.isArray(session.tools)
    ? session.tools
    : Array.isArray(server.tools)
      ? server.tools
      : [];
  const tools: McpToolSummary[] = toolsRaw.filter(isRecord).map((tool) => ({
    name: String(tool.name ?? "tool"),
    enabled: tool.enabled !== false,
    displayName: typeof tool.displayName === "string"
      ? tool.displayName
      : typeof tool.display_name === "string"
        ? tool.display_name
        : undefined,
    description: typeof tool.description === "string" ? tool.description : undefined,
  }));
  const setupValues = isRecord(server.setupValues)
    ? Object.fromEntries(Object.entries(server.setupValues).map(([key, value]) => [key, String(value)]))
    : undefined;

  return {
    name: String(server.name ?? "server"),
    displayName: typeof server.displayName === "string"
      ? server.displayName
      : typeof server.display_name === "string"
        ? server.display_name
        : undefined,
    source: typeof server.source === "string" ? server.source : undefined,
    sourceLabel: typeof server.sourceLabel === "string"
      ? server.sourceLabel
      : typeof server.source_label === "string"
        ? server.source_label
        : undefined,
    type: typeof server.type === "string" ? server.type : undefined,
    url: typeof server.url === "string" ? server.url : undefined,
    command: typeof server.command === "string" ? server.command : undefined,
    args: Array.isArray(server.args) ? server.args.map(String) : undefined,
    setup: readSetup(server),
    setupValues,
    session: {
      enabled: session?.enabled !== false && server.enabled !== false,
      status: typeof session?.status === "string"
        ? session.status
        : typeof server.status === "string"
          ? server.status
          : undefined,
      tools,
      authRequired: session?.authRequired === true,
      setupRequired: session?.setupRequired === true,
      blockedReason: typeof session?.blockedReason === "string" ? session.blockedReason : undefined,
    },
  } satisfies McpServerView;
}

/** Normalize `servers` / `mcpServers` payloads into catalog rows. `null` when neither is a list. */
export function mcpServersFromParams(params: Record<string, unknown>): McpServerView[] | null {
  const raw = params.servers ?? params.mcpServers;
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRecord).map(normalizeMcpServer);
}

/**
 * Fold a freshly listed catalog into the one already on screen.
 *
 * `x.ai/mcp/list` answers from the agent-level catalog before the session's MCP pool has been
 * annotated, and those rows carry `session.status: undefined` with an empty tool list. Replacing
 * a list the user is looking at with that would blank every tool row mid-toggle, so an
 * unannotated incoming row keeps the tools already known.
 */
export function mergeMcpCatalog(current: McpServerView[], incoming: McpServerView[]): McpServerView[] {
  const previousByName = new Map(current.map((server) => [server.name, server]));
  return incoming.map((server) => {
    const previous = previousByName.get(server.name);
    if (!previous) return server;
    const previousTools = previous.session?.tools ?? [];
    const incomingTools = server.session?.tools ?? [];
    const unannotated = server.session?.status === undefined && incomingTools.length < previousTools.length;
    return {
      ...server,
      session: { ...server.session, tools: unannotated ? previousTools : incomingTools },
    };
  });
}
