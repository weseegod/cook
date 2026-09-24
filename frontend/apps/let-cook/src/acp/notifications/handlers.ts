import type { McpToolSummary, PluginView } from "../extensions";
import { mergeMcpCatalog, mcpServersFromParams } from "../mcp-servers";
import type { HookView, MemoryFileView } from "../settings-ext";
import { activityPayload } from "../activity";
import { notifyTurnComplete, shouldNotifyTurnComplete, turnCompleteNotifyCopy } from "../os-notify";
import { modelCatalog } from "../xai";
import { normalizeError } from "../errors";
import {
  applyMonitorEvent,
  applyScheduledTask,
  applyScheduledTaskDeleted,
  applyTaskBackgrounded,
  applyTaskCompleted,
} from "../../state/activity";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore, type TurnOutcome } from "../../state/session";
import { trackWorking } from "../client/state";
import type { NotificationEntry } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function memoryFilesFromParams(params: Record<string, unknown>): MemoryFileView[] {
  const raw = Array.isArray(params.files) ? params.files : [];
  return raw.filter(isRecord).map((file) => ({
    path: String(file.path ?? ""),
    source: String(file.source ?? "workspace"),
    sizeBytes: typeof file.sizeBytes === "number" ? file.sizeBytes : undefined,
    size_bytes: typeof file.size_bytes === "number" ? file.size_bytes : undefined,
    modifiedEpochSecs: typeof file.modifiedEpochSecs === "number" ? file.modifiedEpochSecs : undefined,
    modified_epoch_secs: typeof file.modified_epoch_secs === "number" ? file.modified_epoch_secs : undefined,
    generated: file.generated === true,
  })).filter((file) => file.path.length > 0);
}

function pluginsFromParams(params: Record<string, unknown>): PluginView[] {
  const raw = Array.isArray(params.plugins) ? params.plugins : [];
  return raw.filter(isRecord).map((plugin) => ({
    name: String(plugin.name ?? "plugin"),
    id: typeof plugin.id === "string" ? plugin.id : undefined,
    version: typeof plugin.version === "string" ? plugin.version : undefined,
    enabled: plugin.enabled !== false,
    description: typeof plugin.description === "string" ? plugin.description : undefined,
    scope: typeof plugin.scope === "string" ? plugin.scope : undefined,
  }));
}

function hooksFromParams(params: Record<string, unknown>): HookView[] {
  const raw = Array.isArray(params.hooks) ? params.hooks : [];
  return raw.filter(isRecord).map((hook) => ({
    name: String(hook.name ?? "hook"),
    event: String(hook.event ?? "unknown"),
    handlerType: typeof hook.handlerType === "string" ? hook.handlerType : undefined,
    handler_type: typeof hook.handler_type === "string" ? hook.handler_type : undefined,
    matcher: typeof hook.matcher === "string" ? hook.matcher : null,
    command: typeof hook.command === "string" ? hook.command : null,
    url: typeof hook.url === "string" ? hook.url : null,
    timeoutMs: typeof hook.timeoutMs === "number" ? hook.timeoutMs : undefined,
    timeout_ms: typeof hook.timeout_ms === "number" ? hook.timeout_ms : undefined,
    sourceDir: typeof hook.sourceDir === "string" ? hook.sourceDir : undefined,
    source_dir: typeof hook.source_dir === "string" ? hook.source_dir : undefined,
    disabled: hook.disabled === true,
    pinned: hook.pinned === true,
    removable: hook.removable === true,
  }));
}

function hookEventSummary(params: Record<string, unknown>): { event: string; summary: string } {
  const event = String(
    params.hookEventName ?? params.hook_event_name ?? params.event ?? params.sessionUpdate ?? "hook",
  );
  const tool = params.toolName ?? params.tool_name;
  const message = params.message;
  const parts = [
    event,
    typeof tool === "string" && tool ? `tool ${tool}` : null,
    typeof message === "string" && message ? message : null,
  ].filter(Boolean);
  return { event, summary: parts.join(" · ") };
}

function outcomeFromPromptComplete(params: Record<string, unknown>): TurnOutcome {
  const stop = String(params.stopReason ?? params.stop_reason ?? params.agentResult ?? "");
  if (/cancel/i.test(stop)) return { kind: "cancelled" };
  if (/fail|error/i.test(stop) || params.error != null || params.errorKind != null) {
    return {
      kind: "failed",
      error: typeof params.error === "string"
        ? normalizeError(params.error)
        : typeof params.errorKind === "string"
          ? normalizeError(params.errorKind)
          : undefined,
    };
  }
  return { kind: "completed" };
}

function patchServerStatus(serverName: string, status: string): void {
  const { mcpServers, setMcpServers } = useCatalogStore.getState();
  if (mcpServers.length === 0) {
    void refreshConnectorCatalog();
    return;
  }
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
  if (mcpServers.length === 0) {
    void refreshConnectorCatalog();
    return;
  }
  if (!serverName) return;
  setMcpServers(
    mcpServers.map((server) =>
      server.name === serverName
        ? { ...server, session: { ...server.session, tools } }
        : server,
    ),
  );
}

/** A `tools_changed` before the list query seeded the catalog must still reach the screen. */
async function refreshConnectorCatalog(): Promise<void> {
  const { queryClient } = await import("../../state/query-client");
  void queryClient.invalidateQueries({ queryKey: ["connectors"] });
}

function taskNoticeName(params: Record<string, unknown>): string {
  const update = activityPayload(params);
  const snap = isRecord(update.task_snapshot)
    ? update.task_snapshot
    : isRecord(update.taskSnapshot)
      ? update.taskSnapshot
      : null;
  return String(
    (snap && (snap.description ?? snap.display_command ?? snap.displayCommand ?? snap.command))
      ?? update.description
      ?? update.monitor_description
      ?? update.monitorDescription
      ?? update.command
      ?? params.taskName
      ?? params.task_name
      ?? params.name
      ?? "Task",
  );
}

export const notificationEntries: NotificationEntry[] = [
  {
    mapId: "N-models",
    method: "x.ai/models/update",
    handle: async (ctx) => {
      const catalog = modelCatalog(ctx.params);
      // A storm of identical `x.ai/models/update` notifications must not thrash React or
      // re-list on the prompt hot path. Skip when the payload is what we already show.
      const current = useCatalogStore.getState();
      const identical =
        current.currentModelId === catalog.currentModelId &&
        current.models.length === catalog.models.length &&
        current.models.every((m, i) => m.id === catalog.models[i]?.id);
      if (identical) return;
      // Re-list through the client so Desktop/config provider metadata is merged back in. The
      // notification payload often omits provider names, which would otherwise put OpenAI's
      // unnamespaced models back under the xAI fallback bucket. Skip while a turn is streaming —
      // the extra `x.ai/models/list` round-trip adds latency on the hot path.
      const turnRunning = useSessionStore.getState().turnRunning;
      if (ctx.refreshModels && !turnRunning) {
        try {
          await ctx.refreshModels();
        } catch {
          // A notification must not turn into a stale/empty picker just because the optional
          // re-list failed; the payload is still a useful fallback.
          if (catalog.models.length > 0) useCatalogStore.getState().setModelCatalog(catalog);
        }
      } else if (catalog.models.length > 0) useCatalogStore.getState().setModelCatalog(catalog);
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
      const sessionId = typeof ctx.params.sessionId === "string" ? ctx.params.sessionId : null;
      // Background turn finished while another conversation is open — clear its list activity only.
      if (sessionId && store.sessionId && sessionId !== store.sessionId) {
        trackWorking(sessionId, null);
        return;
      }
      if (!store.turnRunning && store.turnStartedAt === null) return;
      const outcome = outcomeFromPromptComplete(ctx.params);
      store.finishTurn(outcome);
      store.set({ turnRunning: false });
      if (shouldNotifyTurnComplete()) {
        const { title, body } = turnCompleteNotifyCopy(outcome);
        void notifyTurnComplete(title, body);
      }
    },
  },
  {
    mapId: "N-mcp-srv",
    method: "x.ai/mcp/servers_updated",
    handle: (ctx) => {
      const servers = mcpServersFromParams(ctx.params);
      if (servers) {
        const store = useCatalogStore.getState();
        store.setMcpServers(mergeMcpCatalog(store.mcpServers, servers));
      }
    },
  },
  {
    mapId: "N-mcp-tools",
    method: "x.ai/mcp/tools_changed",
    handle: (ctx) => {
      const serverName = String(ctx.params.serverName ?? ctx.params.server_name ?? "");
      const toolsRaw = Array.isArray(ctx.params.tools) ? ctx.params.tools.filter(isRecord) : [];
      if (serverName && toolsRaw.length > 0) {
        patchServerTools(
          serverName,
          toolsRaw.map((tool) => ({
            name: String(tool.name ?? "tool"),
            enabled: tool.enabled !== false,
            displayName: typeof tool.displayName === "string" ? tool.displayName : undefined,
            description: typeof tool.description === "string" ? tool.description : undefined,
          })),
        );
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
      if (ctx.params.sessionId !== useSessionStore.getState().sessionId) return;
      const entries = Array.isArray(ctx.params.entries) ? ctx.params.entries : null;
      if (!entries) return;
      const queuedEntries = entries.filter(isRecord).map((entry) => ({
        id: String(entry.id ?? ""),
        version: typeof entry.version === "number" ? entry.version : 0,
        text: String(entry.text ?? ""),
        kind: typeof entry.kind === "string" ? entry.kind : undefined,
        position: typeof entry.position === "number" ? entry.position : undefined,
      })).filter((entry) => entry.id);
      useSessionStore.getState().set({
        queuedPromptCount: queuedEntries.length,
        queuedEntries,
      });
    },
  },
  {
    mapId: "N-tdone",
    method: "x.ai/task_completed",
    handle: (ctx) => {
      applyTaskCompleted(ctx.params);
      useSessionStore.getState().set({ notice: `${taskNoticeName(ctx.params)} completed` });
    },
  },
  {
    mapId: "N-tbg",
    method: "x.ai/task_backgrounded",
    handle: (ctx) => {
      applyTaskBackgrounded(ctx.params);
      useSessionStore.getState().set({ notice: `${taskNoticeName(ctx.params)} running in background` });
    },
  },
  {
    mapId: "N-sched-c",
    method: "x.ai/scheduled_task_created",
    handle: (ctx) => {
      applyScheduledTask(ctx.params, "scheduled");
    },
  },
  {
    mapId: "N-sched-f",
    method: "x.ai/scheduled_task_fired",
    handle: (ctx) => {
      applyScheduledTask(ctx.params, "fired");
    },
  },
  {
    mapId: "N-sched-d",
    method: "x.ai/scheduled_task_deleted",
    handle: (ctx) => {
      applyScheduledTaskDeleted(ctx.params);
    },
  },
  {
    mapId: "N-mon",
    method: "x.ai/monitor_event",
    handle: (ctx) => {
      applyMonitorEvent(ctx.params);
    },
  },
  // --- P6 / P7 / P8 ---
  {
    mapId: "U-memf",
    method: "memory_files",
    handle: (ctx) => {
      useCatalogStore.getState().setMemoryFiles(memoryFilesFromParams(ctx.params), ctx.params.enabled !== false);
    },
  },
  {
    mapId: "U-plug",
    method: "plugins_changed",
    handle: (ctx) => {
      useCatalogStore.getState().setPlugins(pluginsFromParams(ctx.params));
    },
  },
  {
    mapId: "U-hook*",
    method: "hooks_changed",
    handle: (ctx) => {
      const trusted = ctx.params.projectTrusted === true || ctx.params.project_trusted === true;
      useCatalogStore.getState().setHooks(hooksFromParams(ctx.params), trusted);
    },
  },
  {
    mapId: "U-hook*",
    method: "hook_annotation",
    handle: (ctx) => {
      const { event, summary } = hookEventSummary(ctx.params);
      useCatalogStore.getState().appendHookEvent({ event, summary });
    },
  },
  {
    mapId: "U-hook*",
    method: "hook_run_started",
    handle: (ctx) => {
      const { event, summary } = hookEventSummary(ctx.params);
      useCatalogStore.getState().appendHookEvent({ event, summary: `started · ${summary}` });
    },
  },
  {
    mapId: "U-hook*",
    method: "hook_execution",
    handle: (ctx) => {
      const { event, summary } = hookEventSummary(ctx.params);
      useCatalogStore.getState().appendHookEvent({ event, summary: `execution · ${summary}` });
    },
  },
  {
    mapId: "N-hookev",
    method: "x.ai/hooks/event",
    handle: (ctx) => {
      const { event, summary } = hookEventSummary(ctx.params);
      useCatalogStore.getState().appendHookEvent({ event, summary });
    },
  },
  // --- P9 / P10 ---
  {
    mapId: "N-follow",
    method: "x.ai/follow_ups",
    handle: (ctx) => {
      if (ctx.params._meta && isRecord(ctx.params._meta) && ctx.params._meta["x.ai/replayed"] === true) {
        return;
      }
      const responseId = String(ctx.params.response_id ?? ctx.params.responseId ?? "");
      if (!responseId || responseId.length > 128) return;
      const raw = Array.isArray(ctx.params.suggestions) ? ctx.params.suggestions : [];
      const suggestions = raw
        .filter(isRecord)
        .map((item) => String(item.label ?? "").trim())
        .filter(Boolean)
        .slice(0, 6);
      useSessionStore.getState().set({
        followUps: suggestions.length > 0 ? { responseId, suggestions } : null,
      });
    },
  },
  {
    mapId: "N-interject",
    method: "x.ai/session/interjection",
    handle: async (ctx) => {
      const { claimSelfInterjection } = await import("../turn-ops");
      const interjectionId = typeof ctx.params.interjectionId === "string" ? ctx.params.interjectionId : null;
      if (interjectionId && claimSelfInterjection(interjectionId)) return;
      const text = typeof ctx.params.text === "string" ? ctx.params.text : "";
      if (!text.trim()) return;
      const sessionId = typeof ctx.params.sessionId === "string" ? ctx.params.sessionId : null;
      const store = useSessionStore.getState();
      if (sessionId && store.sessionId && sessionId !== store.sessionId) return;
      const turnId = store.transcriptCursor.turnId ?? `turn-inj-${crypto.randomUUID()}`;
      store.set({
        blocks: [
          ...store.blocks,
          {
            type: "message",
            id: `inj-${crypto.randomUUID()}`,
            turnId,
            role: "user",
            text,
            images: [],
            streaming: false,
          },
        ],
      });
    },
  },
  {
    mapId: "N-sessions",
    method: "x.ai/sessions/changed",
    handle: async () => {
      const { queryClient } = await import("../../state/query-client");
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  },
  {
    mapId: "N-git",
    method: "x.ai/git_head_changed",
    handle: async () => {
      const { emitGitHeadChanged } = await import("../../state/artifacts");
      emitGitHeadChanged();
    },
  },
  {
    mapId: "N-settings",
    method: "x.ai/settings/update",
    handle: async () => {
      const { queryClient } = await import("../../state/query-client");
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  },
  {
    mapId: "N-su",
    method: "x.ai/session/update",
    handle: (ctx) => {
      if (!isRecord(ctx.params.update)) return;
      useSessionStore.getState().applyNotification(ctx.params as never);
    },
  },
];
