import type { McpServerView, McpToolSummary } from "../extensions";
import { modelCatalog } from "../xai";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore, type TurnOutcome } from "../../state/session";
import type { NotificationEntry } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize `servers` / `mcpServers` notif payloads into catalog rows. */
export function mcpServersFromParams(params: Record<string, unknown>): McpServerView[] | null {
  const raw = params.servers ?? params.mcpServers;
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRecord).map((server) => {
    const session = isRecord(server.session) ? server.session : undefined;
    const toolsRaw = session && Array.isArray(session.tools)
      ? session.tools
      : Array.isArray(server.tools)
        ? server.tools
        : [];
    const tools: McpToolSummary[] = toolsRaw.filter(isRecord).map((tool) => ({
      name: String(tool.name ?? "tool"),
    }));
    return {
      name: String(server.name ?? "server"),
      source: typeof server.source === "string" ? server.source : undefined,
      type: typeof server.type === "string" ? server.type : undefined,
      url: typeof server.url === "string" ? server.url : undefined,
      command: typeof server.command === "string" ? server.command : undefined,
      args: Array.isArray(server.args) ? server.args.map(String) : undefined,
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
  });
}

function outcomeFromPromptComplete(params: Record<string, unknown>): TurnOutcome {
  const stop = String(params.stopReason ?? params.stop_reason ?? params.agentResult ?? "");
  if (/cancel/i.test(stop)) return { kind: "cancelled" };
  if (/fail|error/i.test(stop) || params.error != null || params.errorKind != null) {
    return {
      kind: "failed",
      error: typeof params.error === "string"
        ? params.error
        : typeof params.errorKind === "string"
          ? params.errorKind
          : undefined,
    };
  }
  return { kind: "completed" };
}

function patchServerStatus(serverName: string, status: string): void {
  const { mcpServers, setMcpServers } = useCatalogStore.getState();
  if (mcpServers.length === 0) return;
  setMcpServers(
    mcpServers.map((server) =>
      server.name === serverName
        ? { ...server, session: { ...server.session, status } }
        : server,
    ),
  );
}

function patchServerTools(serverName: string, tools: McpToolSummary[]): void {
  const { mcpServers, setMcpServers } = useCatalogStore.getState();
  if (mcpServers.length === 0 || !serverName) return;
  setMcpServers(
    mcpServers.map((server) =>
      server.name === serverName
        ? { ...server, session: { ...server.session, tools } }
        : server,
    ),
  );
}

export const notificationEntries: NotificationEntry[] = [
  {
    mapId: "N-models",
    method: "x.ai/models/update",
    handle: async (ctx) => {
      const catalog = modelCatalog(ctx.params);
      if (catalog.models.length > 0) useCatalogStore.getState().setModelCatalog(catalog);
      else await ctx.refreshModels?.();
    },
  },
  {
    mapId: "N-yolo",
    method: "x.ai/yolo_mode_changed",
    handle: () => undefined,
  },
  {
    mapId: "N-pcomplete",
    method: "x.ai/session/prompt_complete",
    handle: (ctx) => {
      const store = useSessionStore.getState();
      if (!store.turnRunning && store.turnStartedAt === null) return;
      store.finishTurn(outcomeFromPromptComplete(ctx.params));
      store.set({ turnRunning: false });
    },
  },
  {
    mapId: "N-mcp-srv",
    method: "x.ai/mcp/servers_updated",
    handle: (ctx) => {
      const servers = mcpServersFromParams(ctx.params);
      if (servers) useCatalogStore.getState().setMcpServers(servers);
    },
  },
  {
    mapId: "N-mcp-tools",
    method: "x.ai/mcp/tools_changed",
    handle: (ctx) => {
      const serverName = String(ctx.params.serverName ?? ctx.params.server_name ?? "");
      const toolsRaw = Array.isArray(ctx.params.tools) ? ctx.params.tools.filter(isRecord) : [];
      if (serverName && toolsRaw.length > 0) {
        patchServerTools(serverName, toolsRaw.map((tool) => ({ name: String(tool.name ?? "tool") })));
      }
    },
  },
  {
    mapId: "N-mcp-init",
    method: "x.ai/mcp/init_progress",
    handle: (ctx) => {
      const serverName = String(ctx.params.serverName ?? ctx.params.server_name ?? ctx.params.server ?? "");
      const status = String(ctx.params.status ?? ctx.params.phase ?? "initializing");
      if (serverName) patchServerStatus(serverName, status);
    },
  },
  {
    mapId: "N-mcp-inited",
    method: "x.ai/mcp_initialized",
    handle: (ctx) => {
      const serverName = String(ctx.params.serverName ?? ctx.params.server_name ?? ctx.params.server ?? "");
      if (serverName) patchServerStatus(serverName, "ready");
    },
  },
  {
    mapId: "N-mcp-stat",
    method: "x.ai/mcp/server_status",
    handle: (ctx) => {
      const serverName = String(ctx.params.serverName ?? ctx.params.server_name ?? ctx.params.server ?? "");
      const status = String(ctx.params.status ?? "unknown");
      if (serverName) patchServerStatus(serverName, status);
    },
  },
  {
    mapId: "N-mcp-elic",
    method: "x.ai/mcp/elicit_complete",
    handle: () => {
      const pending = useSessionStore.getState().pendingQuestion;
      if (pending?.kind === "elicit") {
        useSessionStore.getState().set({ pendingQuestion: null });
      }
    },
  },
  {
    mapId: "N-queue",
    method: "x.ai/queue/changed",
    handle: (ctx) => {
      const entries = Array.isArray(ctx.params.entries) ? ctx.params.entries : null;
      if (entries) useSessionStore.getState().set({ queuedPromptCount: entries.length });
    },
  },
  {
    mapId: "N-tdone",
    method: "x.ai/task_completed",
    handle: (ctx) => {
      const name = String(ctx.params.taskName ?? ctx.params.task_name ?? ctx.params.name ?? "Task");
      useSessionStore.getState().set({ notice: `${name} completed` });
    },
  },
  {
    mapId: "N-tdone",
    method: "x.ai/task_backgrounded",
    handle: (ctx) => {
      const name = String(ctx.params.taskName ?? ctx.params.task_name ?? ctx.params.name ?? "Task");
      useSessionStore.getState().set({ notice: `${name} running in background` });
    },
  },
];
