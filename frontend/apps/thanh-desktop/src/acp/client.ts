import {
  PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { buildPromptParts, imageAttachEnabled, optimisticImages, type Attachment } from "./attachments";
import { useCatalogStore } from "../state/catalog";
import { useSessionStore, type PendingQuestion, type TurnOutcome } from "../state/session";
import {
  notify,
  onLog,
  onMessages,
  onStatus,
  request,
  respond,
  startProcess,
  stopProcess,
  type RpcMessage,
} from "./host";
import { setDefaultModel as setDefaultModelOnAgent } from "./providers";
import { commandsFromUpdate, modelCatalog, XaiClient, type SessionInfo } from "./xai";

const CLIENT_META = {
  clientIdentifier: "grok-desktop",
  clientType: "grok_desktop",
  mcpApps: true,
  bufferingSettings: { minDelayMs: 16, maxDelayMs: 64, maxBytes: 65536 },
};

export class ThanhAcpClient {
  readonly xai = new XaiClient();
  private cwd: string | null = null;
  private unlisten: UnlistenFn[] = [];
  private stopping = false;
  private restartCount = 0;
  private startup: Promise<void> | null = null;
  private pendingPromptRequests = 0;
  private inboundMessages: Promise<void> = Promise.resolve();

  async connect(cwd: string): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = this.connectInner(cwd).finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  private async connectInner(cwd: string): Promise<void> {
    this.stopping = false;
    this.cwd = cwd;
    const store = useSessionStore.getState();
    store.set({ connection: "starting", error: null, cwd });
    await this.installListeners();
    try {
      this.stopping = true;
      await stopProcess();
      this.stopping = false;
      const info = await startProcess(cwd);
      await this.initialize();
      this.restartCount = 0;
      store.set({ connection: "ready", binaryVersion: info.binaryVersion, cwd: info.cwd });
      rememberWorkspace(info.cwd);
      await this.refreshCatalogs();
    } catch (error) {
      store.set({ connection: "error", error: errorMessage(error) });
      throw error;
    }
  }

  private async installListeners() {
    for (const dispose of this.unlisten.splice(0)) dispose();
    this.unlisten.push(
      await onMessages((messages) => {
        this.inboundMessages = this.inboundMessages.then(() => this.handleMessages(messages));
      }),
      await onStatus((status) => {
        if (status.state === "exited" && !this.stopping) void this.restartAfterCrash(status.detail);
      }),
      await onLog((line) => console.debug(`[thanh agent] ${line}`)),
    );
  }

  private async initialize() {
    const params: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        plan: {},
        _meta: { "x.ai/folderTrust": { interactive: true } },
      },
      clientInfo: { name: "Thanh Desktop", title: "Thanh Desktop", version: __APP_VERSION__ },
      _meta: CLIENT_META,
    };
    await request<InitializeResponse>("initialize", params);
  }

  async newSession(): Promise<string> {
    if (!this.cwd) throw new Error("Choose a workspace first");
    const defaultModel = localStorage.getItem("thanh.defaultModel");
    const yoloMode = localStorage.getItem("thanh.alwaysApprove") === "true";
    const params: NewSessionRequest = {
      cwd: this.cwd,
      mcpServers: [],
      _meta: {
        clientIdentifier: "grok-desktop",
        ...(defaultModel ? { modelId: defaultModel } : {}),
        ...(yoloMode ? { yoloMode: true } : {}),
      },
    };
    const response = await request<NewSessionResponse>("session/new", params);
    useSessionStore.getState().resetConversation(response.sessionId);
    // `session/new` reports the catalog it spawned with, which is authoritative for this session.
    const catalog = modelCatalog((response as unknown as { models?: unknown }).models);
    if (catalog.models.length > 0) {
      useCatalogStore.getState().setModelCatalog(catalog);
      useSessionStore.getState().set({ modelId: catalog.currentModelId });
    }
    await this.refreshCommands();
    void this.refreshUsage();
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    const activeCwd = cwd ?? this.cwd;
    if (!activeCwd) throw new Error("Session has no workspace");
    const params: LoadSessionRequest = { sessionId, cwd: activeCwd, mcpServers: [] };
    useSessionStore.getState().resetConversation(sessionId);
    const response = await request<{ models?: unknown }>("session/load", params);
    await this.inboundMessages;
    useSessionStore.getState().finishTurn();
    this.cwd = activeCwd;
    useSessionStore.getState().set({ cwd: activeCwd, connection: "ready" });
    const catalog = modelCatalog(response?.models);
    if (catalog.models.length > 0) {
      useCatalogStore.getState().setModelCatalog(catalog);
      useSessionStore.getState().set({ modelId: catalog.currentModelId });
    }
    await this.refreshCommands();
    void this.refreshUsage();
  }

  async prompt(text: string, attachments: Attachment[] = []): Promise<PromptResponse> {
    let sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) sessionId = await this.newSession();
    useSessionStore.getState().appendOptimisticUser(text, optimisticImages(attachments));
    return this.dispatchPrompt(sessionId, this.buildParts(text, attachments));
  }

  queuePrompt(text: string, attachments: Attachment[] = []): void {
    const store = useSessionStore.getState();
    if (!store.sessionId) throw new Error("Start a conversation before queueing a prompt");
    store.set({ queuedPromptCount: store.queuedPromptCount + 1 });
    // A second session/prompt RPC is the agent's authoritative queue input.
    // Keep the promise live in the background; it resolves when that queued turn finishes.
    void this.dispatchPrompt(store.sessionId, this.buildParts(text, attachments)).catch(() => undefined);
  }

  /** Whether the active model accepts `image` prompt parts. */
  imageAttachEnabled(): boolean {
    const { modelId } = useSessionStore.getState();
    const { models, currentModelId } = useCatalogStore.getState();
    // Before the first session the active model is the one the agent reports, so the gate still holds.
    const activeId = modelId ?? currentModelId;
    const active = models.find((model) => model.id === activeId) ?? models.find((model) => model.isDefault) ?? null;
    return imageAttachEnabled(active);
  }

  /** Turn the composer's text + attachments into ACP content parts, surfacing rejections. */
  buildParts(text: string, attachments: Attachment[]) {
    const { parts, rejected } = buildPromptParts(text, attachments, { supportsImages: this.imageAttachEnabled() });
    if (rejected.length > 0) {
      useSessionStore.getState().set({
        error: rejected.map((item) => `${item.name} was not attached: ${item.reason}`).join("; "),
      });
    }
    return parts;
  }

  private async dispatchPrompt(sessionId: string, parts: PromptRequest["prompt"]): Promise<PromptResponse> {
    const params: PromptRequest = { sessionId, prompt: parts };
    this.pendingPromptRequests += 1;
    useSessionStore.getState().set({ turnRunning: true, error: null });
    let outcome: TurnOutcome = { kind: "completed" };
    try {
      return await request<PromptResponse>("session/prompt", params);
    } catch (error) {
      const message = errorMessage(error);
      outcome = { kind: "failed", error: message };
      useSessionStore.getState().set({ error: message });
      throw error;
    } finally {
      await this.inboundMessages;
      useSessionStore.getState().finishTurn(outcome);
      this.pendingPromptRequests = Math.max(0, this.pendingPromptRequests - 1);
      const store = useSessionStore.getState();
      store.set({
        turnRunning: this.pendingPromptRequests > 0,
        queuedPromptCount: Math.max(0, store.queuedPromptCount - 1),
      });
      void this.refreshSessions();
      void this.refreshUsage();
    }
  }

  async cancel(): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) return;
    await notify("session/cancel", { sessionId });
    await this.inboundMessages;
    useSessionStore.getState().finishTurn({ kind: "cancelled" });
    useSessionStore.getState().set({ turnRunning: false });
  }

  async setModel(modelId: string): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    // Before the first prompt there is no session to switch, and there does not need to be: the
    // choice rides `session/new`'s `_meta.modelId` and is applied by the agent when it spawns.
    if (sessionId) await request("session/set_model", { sessionId, modelId });
    localStorage.setItem("thanh.defaultModel", modelId);
    useSessionStore.getState().set({ modelId });
    useCatalogStore.getState().setModelCatalog({
      currentModelId: modelId,
      models: useCatalogStore.getState().models,
    });
  }

  /**
   * Persist the default through the desktop config service when available.
   *
   * Browser/legacy clients fall back to `x.ai/models/set_default`; if that is unavailable, the
   * choice still reaches the next session through `_meta.modelId`.
   */
  async setDefaultModel(modelId: string): Promise<void> {
    try {
      await setDefaultModelOnAgent(modelId);
    } catch (error) {
      const detail = errorMessage(error);
      useSessionStore.getState().set({
        notice: /-32601|method not found/i.test(detail)
          ? "This agent build cannot write [models] default, so the choice applies to this window only."
          : `${detail} — the default applies to this window only.`,
      });
    }
    await this.setModel(modelId);
  }

  async setYolo(enabled: boolean): Promise<void> {
    localStorage.setItem("thanh.alwaysApprove", String(enabled));
    useSessionStore.getState().set({ alwaysApprove: enabled });
    await notify("x.ai/yolo_mode_changed", {
      yolo_mode: enabled,
      clientIdentifier: "grok-desktop",
    });
  }

  /**
   * Plan mode is a session mode, so the window creates its session here if the user reaches for the
   * mode before the first prompt. The agent confirms with `current_mode_update`.
   */
  async setPlanMode(enabled: boolean): Promise<void> {
    const sessionId = await this.ensureSession();
    useSessionStore.getState().set({ planMode: enabled });
    await this.xai.setMode(sessionId, enabled ? "plan" : "default");
  }

  /** The session id, creating a session when the window has none yet. */
  async ensureSession(): Promise<string> {
    const sessionId = useSessionStore.getState().sessionId;
    return sessionId ?? this.newSession();
  }

  async answerPermission(optionId?: string): Promise<void> {
    const pending = useSessionStore.getState().pendingPermission;
    if (!pending) return;
    await respond(
      pending.rpcId,
      optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
    );
    useSessionStore.getState().set({ pendingPermission: null });
  }

  async answerQuestion(result: unknown): Promise<void> {
    const pending = useSessionStore.getState().pendingQuestion;
    if (!pending) return;
    await respond(pending.rpcId, result);
    useSessionStore.getState().set({ pendingQuestion: null });
    if (pending.kind === "plan") useSessionStore.getState().endPlanReview();
  }

  /**
   * Answer a parked `x.ai/exit_plan_mode`. One path for the popup, the inline card and every key
   * binding so the payload cannot drift: only `cancelled` carries feedback
   * (`ExitPlanModeExtResponse`), and an empty one is sent as absent.
   */
  async resolvePlan(outcome: string, feedback?: string | null): Promise<void> {
    const trimmed = feedback?.trim();
    await this.answerQuestion({
      outcome,
      ...(outcome === "cancelled" && trimmed ? { feedback: trimmed } : {}),
    });
  }

  async refreshSessions(query = useCatalogStore.getState().sessionSearch): Promise<void> {
    useCatalogStore.getState().setSessions(await this.xai.listSessions(query));
  }

  async refreshModels(): Promise<void> {
    useCatalogStore.getState().setModelCatalog(await this.xai.listModels());
  }

  async refreshCommands(): Promise<void> {
    useCatalogStore.getState().setCommands(
      await this.xai.listCommands(useSessionStore.getState().sessionId ?? undefined),
    );
  }

  /**
   * The agent's own view of the session, or `null` when there is no session yet or the agent
   * build has no such extension.
   */
  async sessionInfo(): Promise<SessionInfo | null> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) return null;
    try {
      return await this.xai.sessionInfo(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * Feed the status bar and `/context` from `x.ai/session/info`.
   *
   * A real turn emits no ACP `usage_update`, so without this the token chip never moves. A failed
   * or silent call leaves the last known numbers in place rather than blanking them.
   */
  private async refreshUsage(): Promise<void> {
    const context = (await this.sessionInfo())?.context;
    if (typeof context?.used !== "number") return;
    useSessionStore.getState().set({
      usage: { used: context.used, ...(typeof context.total === "number" ? { size: context.total } : {}) },
    });
  }

  private async refreshCatalogs() {
    await Promise.allSettled([this.refreshSessions(), this.refreshModels(), this.refreshCommands()]);
  }

  private async handleMessages(messages: RpcMessage[]) {
    let updates: SessionNotification[] = [];
    const flushUpdates = () => {
      if (updates.length === 0) return;
      useSessionStore.getState().applyNotifications(updates);
      updates = [];
    };

    for (const message of messages) {
      const method = unwrapMethod(message);
      const params = unwrapParams(message);
      // Both envelopes carry `{ sessionId, update }`. The extension one (`x.ai/session_notification`)
      // is how the shell ships what ACP has no slot for — goal orchestration state above all.
      if (method === "session/update" || method === "x.ai/session_notification") {
        const update = params.update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate === "available_commands_update") {
          useCatalogStore.getState().setCommands(commandsFromUpdate(update.availableCommands));
        }
        updates.push(params as unknown as SessionNotification);
        continue;
      }
      flushUpdates();
      await this.handleMessage(message);
    }
    flushUpdates();
  }

  private async handleMessage(message: RpcMessage) {
    const method = unwrapMethod(message);
    const params = unwrapParams(message);
    if (method === "session/request_permission" && message.id !== undefined) {
      useSessionStore.getState().set({
        pendingPermission: {
          rpcId: message.id,
          request: params as unknown as RequestPermissionRequest,
        },
      });
      return;
    }
    if (method === "x.ai/models/update") {
      // The notification carries the catalog, so the picker updates without a round trip. The
      // machine-wide broadcast form carries no payload at all, which only means the catalog moved
      // on disk: applying it as a catalog would empty the picker, so it re-lists instead.
      const catalog = modelCatalog(params);
      if (catalog.models.length > 0) useCatalogStore.getState().setModelCatalog(catalog);
      else await this.refreshModels();
      return;
    }
    if (method === "x.ai/yolo_mode_changed") return;
    if (method === "x.ai/ask_user_question" && message.id !== undefined) {
      useSessionStore.getState().set({ pendingQuestion: questionInteraction(message.id, params) });
      return;
    }
    if (method === "x.ai/exit_plan_mode" && message.id !== undefined) {
      // The request carries the whole `plan.md`; ACP `Plan` updates carry entries only, so this is
      // the one place the full body reaches the renderer. Stash it before parking the decision.
      const body = typeof params.planContent === "string" && params.planContent.trim() !== ""
        ? params.planContent
        : null;
      useSessionStore.getState().beginPlanReview(body);
      useSessionStore.getState().set({ pendingQuestion: planInteraction(message.id, params) });
      return;
    }
    if (method === "x.ai/folder_trust/request" && message.id !== undefined) {
      useSessionStore.getState().set({ pendingQuestion: trustInteraction(message.id, params) });
      return;
    }
    if (method === "x.ai/mcp/elicit" && message.id !== undefined) {
      useSessionStore.getState().set({ pendingQuestion: elicitInteraction(message.id, params) });
      return;
    }
    if (message.id !== undefined && message.method) {
      console.warn(`Unsupported agent request: ${message.method}`);
      await respond(message.id, undefined, { code: -32601, message: `Unsupported method: ${message.method}` });
      return;
    }
    if (message.method) console.debug(`Ignored ACP notification: ${message.method}`);
  }

  private async restartAfterCrash(detail?: string) {
    if (!this.cwd || this.restartCount >= 3) {
      useSessionStore.getState().set({ connection: "error", error: detail ?? "Agent process exited" });
      return;
    }
    this.restartCount += 1;
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;
    store.set({ connection: "reconnecting", error: detail ?? null });
    await new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** (this.restartCount - 1)));
    try {
      const info = await startProcess(this.cwd);
      await this.initialize();
      if (sessionId) {
        await request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] } satisfies LoadSessionRequest);
      }
      this.restartCount = 0;
      store.set({ connection: "ready", binaryVersion: info.binaryVersion, error: null });
    } catch (error) {
      void this.restartAfterCrash(errorMessage(error));
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (useSessionStore.getState().turnRunning) await this.cancel();
    await stopProcess();
    for (const dispose of this.unlisten.splice(0)) dispose();
  }
}

function unwrapMethod(message: RpcMessage): string | undefined {
  if (message.method?.startsWith("_x.ai/") && typeof message.params?.method === "string") {
    return message.params.method;
  }
  return message.method?.startsWith("_x.ai/") ? message.method.slice(1) : message.method;
}

function unwrapParams(message: RpcMessage): Record<string, unknown> {
  if (message.method?.startsWith("_x.ai/") && isRecord(message.params?.params)) return message.params.params;
  return message.params ?? {};
}

function questionInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const questions = Array.isArray(raw.questions) ? raw.questions.filter(isRecord) : [];
  return {
    rpcId,
    title: raw.mode === "plan" ? "Plan needs your input" : "Thanh has a question",
    kind: "question",
    raw,
    questions: questions.map((question, questionIndex) => ({
      question: String(question.question ?? `Question ${questionIndex + 1}`),
      multiSelect: question.multiSelect === true,
      options: (Array.isArray(question.options) ? question.options.filter(isRecord) : []).map((option, optionIndex) => ({
        id: String(option.id ?? option.label ?? optionIndex),
        label: String(option.label ?? option.id ?? `Option ${optionIndex + 1}`),
        description: typeof option.description === "string" ? option.description : undefined,
      })),
    })),
  };
}

function planInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const hasPlan = typeof raw.planContent === "string" && raw.planContent.trim() !== "";
  return {
    rpcId,
    // No card title: the review keeps the composer, so the decision status is the card's only header.
    kind: "plan",
    raw,
    questions: [{
      // `plan_approval_view::plan_approval_status_label`: the plan body itself lives in the popup,
      // so the card carries the decision status instead of dumping the whole file inline.
      question: hasPlan
        ? "Waiting on plan approval"
        : "No plan written: approve or request changes",
      options: [
        { id: "approved", label: "Approve", description: "Proceed with the plan" },
        // The TUI's `g` decision. Its button reads `run as goal`; `approved_as_goal` is the wire value.
        { id: "approved_as_goal", label: "Run as goal", description: "Run the approved plan as an autonomous goal" },
        { id: "cancelled", label: "Request changes", description: "Keep planning and send feedback" },
        { id: "abandoned", label: "Quit plan", description: "Leave plan mode without executing" },
      ],
    }],
  };
}

function trustInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const kinds = Array.isArray(raw.configKinds) ? raw.configKinds.join(", ") : "project configuration";
  return {
    rpcId,
    title: "Trust this workspace?",
    kind: "trust",
    raw,
    questions: [{
      question: `${String(raw.workspace ?? raw.cwd ?? "This folder")} contains ${kinds}. Trusting it may run local hooks or MCP servers.`,
      options: [
        { id: "trust", label: "Trust workspace" },
        { id: "reject", label: "Keep restricted" },
      ],
    }],
  };
}

/** `x.ai/mcp/elicit`: the agent asks the user for MCP-server input or a URL visit. */
export function elicitInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const server = String(raw.serverName ?? raw.server_name ?? "an MCP server");
  const message = String(raw.message ?? "This connector needs your input.");
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const mode = String(raw.mode ?? "form");
  return {
    rpcId,
    title: `${server} needs your input`,
    kind: "elicit",
    raw,
    questions: [{
      question: url ? `${message}\n\n${url}` : message,
      options: [
        { id: "accept", label: url ? "Open and continue" : "Accept", description: mode === "url" ? "Open the link, then continue the tool call" : "Send this input to the connector" },
        { id: "decline", label: "Decline", description: "The connector continues without this input" },
      ],
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rememberWorkspace(cwd: string) {
  const previous = JSON.parse(localStorage.getItem("thanh.recentWorkspaces") ?? "[]") as string[];
  localStorage.setItem("thanh.recentWorkspaces", JSON.stringify([cwd, ...previous.filter((item) => item !== cwd)].slice(0, 8)));
  localStorage.setItem("thanh.lastWorkspace", cwd);
}

export const acpClient = new ThanhAcpClient();
