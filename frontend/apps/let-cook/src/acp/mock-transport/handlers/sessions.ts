import { availableCommandsUpdate, commandList, modelCatalog } from "../catalog";
import { openWorkspaceAt, splitReply } from "../events";
import { notify, state } from "../state";
import type { MethodHandler } from "./registry";

export const sessionHandlers: Record<string, MethodHandler> = {
  "initialize": ({ respond }) => {
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
  },
  "session/new": ({ p, sessionId, respond }) => {
    // The agent spawns the session on `_meta.modelId`, which is how a choice made before the
    // first prompt reaches it.
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    if (typeof meta.modelId === "string" && modelCatalog().availableModels.some((model) => model.id === meta.modelId)) {
      state.defaultModel = meta.modelId;
    }
    openWorkspaceAt(p.cwd);
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
  },
  "session/load": ({ p, sessionId, respond }) => {
    // Opening a conversation is what moves the workspace the host answers for: the list can point
    // at another project than the one the window connected to.
    openWorkspaceAt(p.cwd);
    notify("session/update", { ...availableCommandsUpdate(), sessionId: String(p.sessionId ?? sessionId) });
    for (const update of state.historyUpdates) {
      notify("session/update", { sessionId: String(p.sessionId ?? sessionId), update });
    }
    return respond({ modes: null, models: modelCatalog() });
  },
  "session/prompt": async ({ p, sessionId, respond }) => {
    // A real turn reports its context through `x.ai/session/info`, never an ACP `usage_update`.
    state.context = {
      used: state.context.used + 1234,
      turns: state.context.turns + 1,
      messageCount: state.context.messageCount + 2,
    };
    const promptSessionId = String(p.sessionId ?? sessionId);
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
        notify(`_${envelope.notify}`, { sessionId: promptSessionId, update: envelope.update });
        continue;
      }
      notify("session/update", { sessionId: promptSessionId, update });
    }
    if (state.promptDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, state.promptDelayMs));
    return respond({ stopReason: "end_turn" });
  },
  "x.ai/session/info": ({ sessionId, respond }) => {
    const total = 300_000;
    return respond({
      sessionId,
      cwd: "/tmp/cook-demo",
      agentName: "cook",
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
  },
  "session/set_model": ({ p, respond }) => {
    const modelId = String(p.modelId ?? "");
    const model = modelCatalog().availableModels.find((entry) => entry.id === modelId);
    if (!model) {
      return respond({ error: `unknown model \`${modelId}\`` });
    }
    state.defaultModel = modelId;
    notify("x.ai/models/update", modelCatalog());
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    notify("_x.ai/session_notification", {
      sessionId: "mock-session",
      update: {
        sessionUpdate: "model_changed",
        model_id: modelId,
        ...(typeof meta.reasoningEffort === "string" ? { reasoning_effort: meta.reasoningEffort } : {}),
      },
    });
    return respond({ _meta: { model: modelId } });
  },
  "session/set_mode": ({ p, sessionId, respond }) => {
    // Plan mode is an ACP session mode: the agent answers `{}` and reports the new mode.
    const modeId = String(p.modeId ?? "");
    if (modeId !== "plan" && modeId !== "default") {
      return respond({ error: `unknown mode \`${modeId}\`` });
    }
    state.sessionMode = modeId;
    notify("session/update", { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
    return respond({});
  },
  "x.ai/session/list": ({ respond }) => {
    return respond({ sessions: state.sessions });
  },
  "x.ai/session/fork": ({ p, respond }) => {
    // Map id `C-sess-fork`: camelCase ForkSessionRequest → new peer session.
    const sourceSessionId = String(p.sourceSessionId ?? "");
    const sourceCwd = String(p.sourceCwd ?? "/tmp/cook-demo");
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
  },
  "x.ai/session/rename": ({ p, respond }) => {
    const id = String(p.sessionId ?? "");
    const title = String(p.title ?? "");
    state.sessions = state.sessions.map((session) => (session.id === id ? { ...session, title } : session));
    return respond({ ok: true });
  },
  "x.ai/session/delete": ({ p, respond }) => {
    const id = String(p.sessionId ?? "");
    state.sessions = state.sessions.filter((session) => session.id !== id);
    return respond({ ok: true });
  },
  "x.ai/sessions/delete_all": ({ respond }) => {
    if (state.deleteAllUnsupported) {
      return respond({
        error: { code: -32601, message: "Method not found", data: "unknown ACP extension method: x.ai/sessions/delete_all" },
      });
    }
    // The real handler walks every session on disk and reports what it removed, so the counts are
    // read before the state is emptied.
    const result = { deleted: state.sessions.length, plansDeleted: state.planFiles.length, failed: 0 };
    state.sessions = [];
    state.planFiles = [];
    return respond(result);
  },
  "x.ai/commands/list": ({ respond }) => {
    return respond(commandList());
  },
};
