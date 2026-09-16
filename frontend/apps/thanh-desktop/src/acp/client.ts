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
import { useSessionStore, type PendingQuestion } from "../state/session";
import {
  notify,
  onLog,
  onMessage,
  onStatus,
  request,
  respond,
  startProcess,
  stopProcess,
  type RpcMessage,
} from "./host";
import { setDefaultModel as setDefaultModelOnAgent } from "./providers";
import { XaiClient } from "./xai";

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
      await onMessage((message) => void this.handleMessage(message)),
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
    const modelId = (response as unknown as { models?: { currentModelId?: string } }).models?.currentModelId;
    if (modelId) useSessionStore.getState().set({ modelId });
    await this.refreshCommands();
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    const activeCwd = cwd ?? this.cwd;
    if (!activeCwd) throw new Error("Session has no workspace");
    const params: LoadSessionRequest = { sessionId, cwd: activeCwd, mcpServers: [] };
    useSessionStore.getState().resetConversation(sessionId);
    await request("session/load", params);
    this.cwd = activeCwd;
    useSessionStore.getState().set({ cwd: activeCwd, connection: "ready" });
    await this.refreshCommands();
  }

  async prompt(text: string, attachments: Attachment[] = []): Promise<PromptResponse> {
    let sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) sessionId = await this.newSession();
    useSessionStore.getState().appendOptimisticUser(text, optimisticImages(attachments));
    return this.dispatchPrompt(sessionId, this.buildParts(text, attachments));
  }

  queuePrompt(text: string, attachments: Attachment[] = []): void {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) throw new Error("Start a conversation before queueing a prompt");
    // A second session/prompt RPC is the agent's authoritative queue input.
    // Keep the promise live in the background; it resolves when that queued turn finishes.
    void this.dispatchPrompt(sessionId, this.buildParts(text, attachments)).catch(() => undefined);
  }

  /** Whether the active model accepts `image` prompt parts. */
  imageAttachEnabled(): boolean {
    const { modelId } = useSessionStore.getState();
    const models = useCatalogStore.getState().models;
    // Before the first session the active model is the catalog's default, so the gate still holds.
    const active = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? null;
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
    try {
      return await request<PromptResponse>("session/prompt", params);
    } catch (error) {
      useSessionStore.getState().set({ error: errorMessage(error) });
      throw error;
    } finally {
      this.pendingPromptRequests = Math.max(0, this.pendingPromptRequests - 1);
      useSessionStore.getState().set({ turnRunning: this.pendingPromptRequests > 0 });
      void this.refreshSessions();
    }
  }

  async cancel(): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) return;
    await notify("session/cancel", { sessionId });
    useSessionStore.getState().set({ turnRunning: false });
  }

  async setModel(modelId: string): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) throw new Error("Start a conversation before selecting a model");
    await request("session/set_model", { sessionId, modelId });
    useSessionStore.getState().set({ modelId });
  }

  /** Persist the default through the agent (`[models] default`), not just localStorage. */
  async setDefaultModel(modelId: string): Promise<void> {
    await setDefaultModelOnAgent(modelId);
    localStorage.setItem("thanh.defaultModel", modelId);
    if (useSessionStore.getState().sessionId) {
      await this.setModel(modelId);
    } else {
      useSessionStore.getState().set({ modelId });
    }
    await this.refreshModels();
  }

  async setYolo(enabled: boolean): Promise<void> {
    localStorage.setItem("thanh.alwaysApprove", String(enabled));
    await notify("x.ai/yolo_mode_changed", {
      yolo_mode: enabled,
      clientIdentifier: "grok-desktop",
    });
  }

  async togglePlan(enabled: boolean): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) throw new Error("Start a conversation before changing modes");
    await this.xai.togglePlanMode(sessionId, enabled);
    useSessionStore.getState().set({ planMode: enabled });
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
  }

  async refreshSessions(query = useCatalogStore.getState().sessionSearch): Promise<void> {
    useCatalogStore.getState().setSessions(await this.xai.listSessions(query));
  }

  async refreshModels(): Promise<void> {
    useCatalogStore.getState().setModels(await this.xai.listModels());
  }

  async refreshCommands(): Promise<void> {
    useCatalogStore.getState().setCommands(
      await this.xai.listCommands(useSessionStore.getState().sessionId ?? undefined),
    );
  }

  private async refreshCatalogs() {
    await Promise.allSettled([this.refreshSessions(), this.refreshModels(), this.refreshCommands()]);
  }

  private async handleMessage(message: RpcMessage) {
    const method = unwrapMethod(message);
    const params = unwrapParams(message);
    if (method === "session/update") {
      useSessionStore.getState().applyNotification(params as unknown as SessionNotification);
      return;
    }
    if (method === "session/request_permission" && message.id !== undefined) {
      useSessionStore.getState().set({
        pendingPermission: {
          rpcId: message.id,
          request: params as unknown as RequestPermissionRequest,
        },
      });
      return;
    }
    if ((method === "x.ai/models/update" || method === "x.ai/models/list_changed")) {
      await this.refreshModels();
      return;
    }
    if (method === "x.ai/yolo_mode_changed") return;
    if (method === "x.ai/ask_user_question" && message.id !== undefined) {
      useSessionStore.getState().set({ pendingQuestion: questionInteraction(message.id, params) });
      return;
    }
    if (method === "x.ai/exit_plan_mode" && message.id !== undefined) {
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
  return {
    rpcId,
    title: "Review the implementation plan",
    kind: "plan",
    raw,
    questions: [{
      question: typeof raw.planContent === "string" ? raw.planContent : "The agent is ready to leave plan mode.",
      options: [
        { id: "approved", label: "Approve", description: "Proceed with the plan" },
        { id: "cancelled", label: "Request changes", description: "Keep planning and send feedback" },
        { id: "abandoned", label: "Abandon", description: "Leave plan mode without executing" },
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
