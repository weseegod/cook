import type {
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { optimisticImages, type Attachment } from "./attachments";
import { SessionNotificationCoalescer, type ScheduleFlush } from "./client-coalesce";
import { initializeHandshake } from "./client/initialize";
import { handleInboundMessages, type InboundPipeline } from "./client/messages";
import {
  activeModelAcceptsImages,
  answerPendingQuestion,
  answerPermissionRequest,
  composePromptParts,
  pullPlanFiles,
  pullUsage,
  pushDefaultModel,
  preferredReasoningEffort,
  readSessionInfo,
  resolveParkedPlan,
  sendModelChoice,
  sendYoloMode,
} from "./client/requests";
import { rememberWorkspace, trackWorking } from "./client/state";
import { normalizeError } from "./errors";
import { CAPABILITIES } from "./handshake";
import { elicitInteraction } from "./reverse";
import { PromptCorrelation, SessionEventDedupe } from "./session-events";
import { sendQueuedPromptNow } from "./turn-ops";
import { desktopTrace } from "./trace";
import { useCatalogStore } from "../state/catalog";
import { useSessionStore, type QueuedPromptEntry, type TurnOutcome } from "../state/session";
import {
  notify,
  onLog,
  onMessages,
  onStatus,
  request,
  startProcess,
  stopProcess,
  type RpcMessage,
} from "./host";
import { mergeConfiguredModels, modelCatalog, XaiClient, type ModelCatalog, type SessionInfo } from "./xai";
import { listProviders } from "./providers";
import { readLocal } from "../ui/storage";

/** Add Desktop/config provider metadata without making an optional provider extension fatal. */
async function hydrateModelCatalog(catalog: ModelCatalog): Promise<ModelCatalog> {
  const configured = await listProviders().catch(() => null);
  return mergeConfiguredModels(catalog, configured);
}

export { elicitInteraction };
export { CAPABILITIES } from "./handshake";

export class CookAcpClient {
  readonly xai = new XaiClient();
  private cwd: string | null = null;
  private unlisten: UnlistenFn[] = [];
  private stopping = false;
  private restartCount = 0;
  private restartInFlight: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private pendingPromptRequests = 0;
  private readonly pendingQueuedIds = new Map<string, string[]>();
  private readonly queuedImagesById = new Map<string, string[]>();
  private readonly paintedPromotions = new Set<string>();
  private sendNowAwaitingConfirmation: { sessionId: string; id: string } | null = null;
  private readonly sendNowInFlight = new Map<string, number>();
  private readonly sessionEvents = new SessionEventDedupe();
  private readonly promptCorrelation = new PromptCorrelation();
  private readonly sessionUpdates: SessionNotificationCoalescer;
  private readonly pipeline: InboundPipeline;
  private inboundMessages: Promise<void> = Promise.resolve();

  constructor(options: { scheduleFlush?: ScheduleFlush } = {}) {
    this.sessionUpdates = new SessionNotificationCoalescer(
      (notifications) => useSessionStore.getState().applyNotifications(notifications),
      options.scheduleFlush,
    );
    this.pipeline = {
      promptCorrelation: this.promptCorrelation,
      sessionEvents: this.sessionEvents,
      sessionUpdates: this.sessionUpdates,
      refreshPlanFiles: () => { void this.refreshPlanFiles(); },
      refreshModels: () => this.refreshModels(),
      onQueueChanged: (params, previousEntries) => this.onQueueChanged(params, previousEntries),
    };
  }

  async connect(cwd: string): Promise<void> {
    const connection = useSessionStore.getState().connection;
    if (this.cwd === cwd && (connection === "starting" || connection === "ready" || connection === "reconnecting")) {
      return;
    }
    if (this.startup) return this.startup;
    this.startup = this.connectInner(cwd).finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  private async connectInner(cwd: string): Promise<void> {
    this.stopping = false;
    this.cwd = cwd;
    this.pendingQueuedIds.clear();
    this.queuedImagesById.clear();
    this.paintedPromotions.clear();
    this.sendNowAwaitingConfirmation = null;
    this.sendNowInFlight.clear();
    const store = useSessionStore.getState();
    const hadWorking =
      store.turnRunning || Object.keys(store.workingSessions).length > 0;
    // Best-effort cancel of the active turn before the process is killed — background turns die with it.
    if (store.sessionId && hadWorking) {
      try {
        await notify("session/cancel", { sessionId: store.sessionId });
      } catch {
        // Process may already be gone.
      }
    }
    this.promptCorrelation.clear();
    store.resetConversation(null);
    store.set({
      connection: "starting",
      error: null,
      cwd,
      workingSessions: {},
      ...(hadWorking
        ? { notice: "Switching workspace stopped in-progress conversations." }
        : {}),
    });
    await this.installListeners();
    try {
      this.stopping = true;
      await stopProcess();
      this.stopping = false;
      const info = await startProcess(cwd);
      await initializeHandshake();
      this.restartCount = 0;
      store.set({ connection: "ready", binaryVersion: info.binaryVersion, cwd: info.cwd });
      rememberWorkspace(info.cwd);
      await this.refreshCatalogs();
    } catch (error) {
      const safeError = new Error(normalizeError(error, "Could not connect to Cook"));
      store.set({ connection: "error", error: safeError.message });
      throw safeError;
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
      await onLog((line) => desktopTrace("agent.stderr", normalizeError(line))),
    );
  }

  async newSession(): Promise<string> {
    if (!this.cwd) throw new Error("Choose a workspace first");
    this.sendNowAwaitingConfirmation = null;
    this.sendNowInFlight.clear();
    this.queuedImagesById.clear();
    this.paintedPromotions.clear();
    const defaultModel = readLocal("defaultModel");
    const yoloMode = readLocal("alwaysApprove") !== "false";
    const params: NewSessionRequest = {
      cwd: this.cwd,
      mcpServers: [],
      _meta: {
        clientIdentifier: CAPABILITIES.clientIdentifier,
        yoloMode,
        ...(defaultModel ? { modelId: defaultModel } : {}),
        ...(defaultModel && preferredReasoningEffort(defaultModel)
          ? { reasoningEffort: preferredReasoningEffort(defaultModel) }
          : {}),
      },
    };
    const response = await request<NewSessionResponse>("session/new", params);
    this.promptCorrelation.clear();
    useSessionStore.getState().resetConversation(response.sessionId);
    // `session/new` reports the catalog it spawned with, which is authoritative for this session.
    const catalog = await hydrateModelCatalog(modelCatalog((response as unknown as { models?: unknown }).models));
    if (catalog.models.length > 0) {
      useCatalogStore.getState().setModelCatalog(catalog);
      const activeModel = catalog.models.find((model) => model.id === catalog.currentModelId);
      useSessionStore.getState().set({
        modelId: catalog.currentModelId,
        reasoningEffort: catalog.currentModelId
          ? preferredReasoningEffort(catalog.currentModelId) ?? activeModel?.reasoningEffort ?? null
          : null,
      });
    }
    await this.refreshCommands();
    void pullUsage(this.xai);
    void pullPlanFiles(this.cwd);
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    const activeCwd = cwd ?? this.cwd;
    if (!activeCwd) throw new Error("Session has no workspace");
    this.sendNowAwaitingConfirmation = null;
    this.sendNowInFlight.clear();
    this.queuedImagesById.clear();
    this.paintedPromotions.clear();
    const defaultModel = readLocal("defaultModel");
    const yoloMode = readLocal("alwaysApprove") !== "false";
    const params: LoadSessionRequest = {
      sessionId,
      cwd: activeCwd,
      mcpServers: [],
      _meta: {
        clientIdentifier: CAPABILITIES.clientIdentifier,
        yoloMode,
        ...(defaultModel ? { modelId: defaultModel } : {}),
        ...(defaultModel && preferredReasoningEffort(defaultModel)
          ? { reasoningEffort: preferredReasoningEffort(defaultModel) }
          : {}),
      },
    };
    await this.inboundMessages;
    this.sessionUpdates.flushNow();
    useSessionStore.getState().resetConversation(sessionId);
    // Switching back into a conversation whose turn is still in flight keeps the window in turn
    // state, so the composer queues instead of sending and both status rows agree on the clock.
    const working = useSessionStore.getState().workingSessions[sessionId];
    if (working) useSessionStore.getState().set({ turnRunning: true, turnStartedAt: working.startedAt });
    this.promptCorrelation.clear();
    const response = await request<{ models?: unknown }>("session/load", params);
    await this.inboundMessages;
    this.sessionUpdates.flushNow();
    // The replay opens a turn of its own, which `finishTurn` closes. A prompt of ours is still in
    // flight for this conversation though, so the turn stays open and the clock and phase the
    // conversation list already shows are re-applied instead of being thrown away.
    if (working) {
      useSessionStore.getState().set({
        turnRunning: true,
        turnStartedAt: working.startedAt,
        ...(working.activity ? { activity: working.activity } : {}),
      });
    } else {
      useSessionStore.getState().finishTurn();
    }
    this.cwd = activeCwd;
    useSessionStore.getState().set({ cwd: activeCwd, connection: "ready" });
    const catalog = await hydrateModelCatalog(modelCatalog(response?.models));
    if (catalog.models.length > 0) {
      useCatalogStore.getState().setModelCatalog(catalog);
      const activeModel = catalog.models.find((model) => model.id === catalog.currentModelId);
      useSessionStore.getState().set({
        modelId: catalog.currentModelId,
        reasoningEffort: catalog.currentModelId
          ? preferredReasoningEffort(catalog.currentModelId) ?? activeModel?.reasoningEffort ?? null
          : null,
      });
    }
    await this.refreshCommands();
    void pullUsage(this.xai);
    void pullPlanFiles(this.cwd);
  }

  /**
   * Fork a saved session (`C-sess-fork` / `/fork`), then `session/load` the new id.
   * Same-cwd by default; optional overrides match `ForkSessionRequest`.
   */
  async forkSession(options?: {
    sourceSessionId?: string;
    sourceCwd?: string;
    newCwd?: string;
    newModelId?: string;
  }): Promise<string> {
    const store = useSessionStore.getState();
    const sourceSessionId = options?.sourceSessionId ?? store.sessionId;
    if (!sourceSessionId) throw new Error("No session to fork");
    const sourceCwd = options?.sourceCwd ?? store.cwd ?? this.cwd;
    if (!sourceCwd) throw new Error("Session has no workspace");
    const newCwd = options?.newCwd ?? sourceCwd;
    const result = await this.xai.forkSession({
      sourceSessionId,
      sourceCwd,
      newCwd,
      sessionKind: "fork",
      ...(options?.newModelId ? { newModelId: options.newModelId } : {}),
    });
    await this.loadSession(result.newSessionId, result.newCwd || newCwd);
    void this.refreshSessions();
    return result.newSessionId;
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
    const promptId = crypto.randomUUID();
    this.queuedImagesById.set(promptId, optimisticImages(attachments));
    const pending = this.pendingQueuedIds.get(store.sessionId) ?? [];
    this.pendingQueuedIds.set(store.sessionId, [...pending, promptId]);
    store.set({ queuedPromptCount: store.queuedPromptCount + 1 });
    // A second session/prompt RPC is the agent's authoritative queue input.
    // Keep the promise live in the background; it resolves when that queued turn finishes.
    void this.dispatchPrompt(store.sessionId, this.buildParts(text, attachments), promptId).catch(() => undefined);
  }

  /** Promote an authoritative row, or remember an immediate second Enter until its enqueue is confirmed. */
  async sendQueueEntryNow(sessionId: string, selected?: QueuedPromptEntry): Promise<void> {
    const store = useSessionStore.getState();
    if (store.sessionId !== sessionId) return;
    const entry = selected
      ? store.queuedEntries.find((row) => row.id === selected.id)
      : store.queuedEntries[0];
    if (selected && !entry) return;
    if (!entry) {
      const id = this.pendingQueuedIds.get(sessionId)?.[0];
      if (id && !this.sendNowAwaitingConfirmation) {
        this.sendNowAwaitingConfirmation = { sessionId, id };
      }
      return;
    }
    if (this.sendNowInFlight.has(entry.id)) return;
    this.sendNowAwaitingConfirmation = null;
    this.sendNowInFlight.set(entry.id, entry.version);
    try {
      await sendQueuedPromptNow(sessionId, entry.id, entry.version);
    } catch (error) {
      this.sendNowInFlight.delete(entry.id);
      throw error;
    }
  }

  private onQueueChanged(params: Record<string, unknown>, previousEntries: QueuedPromptEntry[]): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (!sessionId || useSessionStore.getState().sessionId !== sessionId) return;
    const entries = useSessionStore.getState().queuedEntries;
    const runningId = typeof params.runningPromptId === "string" ? params.runningPromptId : null;
    const pending = this.pendingQueuedIds.get(sessionId);
    const previousRow = previousEntries.find((entry) => entry.id === runningId);
    const promotionKey = `${sessionId}:${runningId}`;
    if (
      runningId
      && (previousRow || pending?.includes(runningId))
      && (params.runningKind ?? previousRow?.kind ?? "prompt") === "prompt"
      && !this.paintedPromotions.has(promotionKey)
    ) {
      const text = typeof params.runningText === "string" ? params.runningText : previousRow?.text ?? "";
      const images = this.queuedImagesById.get(runningId) ?? [];
      if (text.trim() || images.length > 0) {
        this.paintedPromotions.add(promotionKey);
        useSessionStore.getState().appendOptimisticUser(text, images);
      }
    }
    if (runningId) this.queuedImagesById.delete(runningId);
    if (pending) {
      const remaining = pending.filter((id) => id !== runningId && !entries.some((entry) => entry.id === id));
      if (remaining.length) this.pendingQueuedIds.set(sessionId, remaining);
      else this.pendingQueuedIds.delete(sessionId);
    }
    for (const [id, version] of this.sendNowInFlight) {
      const entry = entries.find((row) => row.id === id);
      if (id === runningId || !entry || entry.version !== version) this.sendNowInFlight.delete(id);
    }
    const awaiting = this.sendNowAwaitingConfirmation;
    if (!awaiting || awaiting.sessionId !== sessionId) return;
    if (awaiting.id === runningId) {
      this.sendNowAwaitingConfirmation = null;
      return;
    }
    const entry = entries.find((row) => row.id === awaiting.id);
    if (entry) {
      this.sendNowAwaitingConfirmation = null;
      void this.sendQueueEntryNow(sessionId, entry).catch((error) => {
        const store = useSessionStore.getState();
        if (store.sessionId === sessionId) {
          store.set({ error: normalizeError(error, "Could not send the queued prompt") });
        }
      });
    }
  }

  imageAttachEnabled(): boolean {
    return activeModelAcceptsImages();
  }

  buildParts(text: string, attachments: Attachment[]) {
    return composePromptParts(text, attachments);
  }

  private async dispatchPrompt(
    sessionId: string,
    parts: PromptRequest["prompt"],
    promptId = crypto.randomUUID(),
  ): Promise<PromptResponse> {
    this.promptCorrelation.begin(promptId);
    const params: PromptRequest = {
      sessionId,
      prompt: parts,
      _meta: { promptId, clientIdentifier: CAPABILITIES.clientIdentifier },
    };
    this.pendingPromptRequests += 1;
    trackWorking(sessionId, Date.now());
    useSessionStore.getState().set({ turnRunning: true, error: null });
    let outcome: TurnOutcome = { kind: "completed" };
    try {
      return await request<PromptResponse>("session/prompt", params);
    } catch (error) {
      const message = normalizeError(error, "The request failed");
      outcome = { kind: "failed", error: message };
      useSessionStore.getState().set({ error: message });
      throw new Error(message);
    } finally {
      await this.inboundMessages;
      const pending = this.pendingQueuedIds.get(sessionId);
      if (pending?.includes(promptId)) {
        const remaining = pending.filter((id) => id !== promptId);
        if (remaining.length) this.pendingQueuedIds.set(sessionId, remaining);
        else this.pendingQueuedIds.delete(sessionId);
      }
      if (this.sendNowAwaitingConfirmation?.id === promptId) this.sendNowAwaitingConfirmation = null;
      this.queuedImagesById.delete(promptId);
      this.sessionUpdates.flushNow();
      this.pendingPromptRequests = Math.max(0, this.pendingPromptRequests - 1);
      this.promptCorrelation.end(promptId);
      trackWorking(sessionId, null);
      const store = useSessionStore.getState();
      // A backgrounded conversation's prompt must not close (or reopen) the active turn.
      if (store.sessionId === sessionId) {
        if (store.turnStartedAt !== null) {
          store.finishTurn(outcome);
        }
        store.set({
          turnRunning: this.pendingPromptRequests > 0,
          queuedPromptCount: Math.max(0, store.queuedPromptCount - 1),
        });
      }
      void this.refreshSessions();
      void pullUsage(this.xai);
    }
  }

  async cancel(): Promise<void> {
    const sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) return;
    await notify("session/cancel", { sessionId });
    await this.inboundMessages;
    this.sessionUpdates.flushNow();
    useSessionStore.getState().finishTurn({ kind: "cancelled" });
    useSessionStore.getState().set({ turnRunning: false });
    trackWorking(sessionId, null);
  }

  async setModel(modelId: string, reasoningEffort?: string): Promise<void> {
    await sendModelChoice(modelId, reasoningEffort);
    await pullUsage(this.xai);
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await pushDefaultModel(modelId);
    await pullUsage(this.xai);
  }

  async setYolo(enabled: boolean): Promise<void> {
    await sendYoloMode(enabled);
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
    await answerPermissionRequest(optionId);
  }

  async answerQuestion(result: unknown): Promise<void> {
    await answerPendingQuestion(result);
  }

  async resolvePlan(outcome: string, feedback?: string | null): Promise<void> {
    await resolveParkedPlan(outcome, feedback);
  }

  async refreshSessions(query = useCatalogStore.getState().sessionSearch): Promise<void> {
    useCatalogStore.getState().setSessions(await this.xai.listSessions(query));
  }

  async refreshModels(): Promise<void> {
    useCatalogStore.getState().setModelCatalog(await hydrateModelCatalog(await this.xai.listModels()));
  }

  async refreshCommands(): Promise<void> {
    useCatalogStore.getState().setCommands(
      await this.xai.listCommands(useSessionStore.getState().sessionId ?? undefined),
    );
  }

  async sessionInfo(): Promise<SessionInfo | null> {
    return readSessionInfo(this.xai);
  }

  async refreshPlanFiles(): Promise<void> {
    await pullPlanFiles(this.cwd);
  }

  private async refreshCatalogs() {
    await Promise.allSettled([this.refreshSessions(), this.refreshModels(), this.refreshCommands()]);
  }

  private async handleMessages(messages: RpcMessage[]) {
    return handleInboundMessages(this.pipeline, messages);
  }

  private async restartAfterCrash(detail?: string) {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.restartAfterCrashInner(detail).finally(() => {
      this.restartInFlight = null;
    });
    return this.restartInFlight;
  }

  private async restartAfterCrashInner(detail?: string) {
    const safeDetail = detail ? normalizeError(detail, "Agent process exited") : null;
    if (!this.cwd || this.restartCount >= 3) {
      useSessionStore.getState().set({ connection: "error", error: safeDetail ?? "Agent process exited" });
      return;
    }
    this.restartCount += 1;
    const store = useSessionStore.getState();
    const sessionId = store.sessionId;
    store.set({ connection: "reconnecting", error: safeDetail });
    await new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** (this.restartCount - 1)));
    try {
      this.stopping = true;
      const info = await startProcess(this.cwd);
      this.stopping = false;
      await initializeHandshake();
      if (sessionId) {
        const defaultModel = readLocal("defaultModel");
        const yoloMode = readLocal("alwaysApprove") !== "false";
        await request("session/load", {
          sessionId,
          cwd: this.cwd,
          mcpServers: [],
          _meta: {
            clientIdentifier: CAPABILITIES.clientIdentifier,
            yoloMode,
            ...(defaultModel ? { modelId: defaultModel } : {}),
            ...(defaultModel && preferredReasoningEffort(defaultModel)
              ? { reasoningEffort: preferredReasoningEffort(defaultModel) }
              : {}),
          },
        } satisfies LoadSessionRequest);
      }
      this.restartCount = 0;
      store.set({ connection: "ready", binaryVersion: info.binaryVersion, error: null });
    } catch (error) {
      this.stopping = false;
      void this.restartAfterCrash(normalizeError(error, "The Cook agent could not restart"));
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (useSessionStore.getState().turnRunning) await this.cancel();
    await stopProcess();
    this.promptCorrelation.clear();
    this.pendingQueuedIds.clear();
    this.queuedImagesById.clear();
    this.paintedPromotions.clear();
    this.sendNowAwaitingConfirmation = null;
    this.sendNowInFlight.clear();
    for (const dispose of this.unlisten.splice(0)) dispose();
  }
}

export const acpClient = new CookAcpClient();
