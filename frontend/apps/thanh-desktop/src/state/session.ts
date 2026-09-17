import type { RequestPermissionRequest, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { create } from "zustand";

export interface MessageBlock {
  type: "message";
  id: string;
  turnId: string;
  role: "user" | "assistant" | "thought";
  text: string;
  images: string[];
  streaming: boolean;
}

export interface ToolBlock {
  type: "tool";
  id: string;
  turnId: string;
  title: string;
  kind?: string;
  status: string;
  content: unknown[];
  locations: unknown[];
  startedAt: number;
  elapsedMs: number | null;
  command?: string;
  description?: string;
  paths: string[];
}

export interface PlanBlock {
  type: "plan";
  id: string;
  turnId: string;
  entries: unknown[];
  content?: unknown;
}

export type TranscriptBlock = MessageBlock | ToolBlock | PlanBlock;

export interface TranscriptCursor {
  turnId: string | null;
  assistantId: string | null;
  thoughtId: string | null;
  optimisticUserId: string | null;
}

export interface TranscriptState {
  blocks: TranscriptBlock[];
  cursor: TranscriptCursor;
}

export interface PendingPermission {
  rpcId: number | string;
  request: RequestPermissionRequest;
}

export interface PendingQuestion {
  rpcId: number | string;
  title: string;
  kind: "question" | "plan" | "trust" | "elicit";
  questions: Array<{
    question: string;
    multiSelect?: boolean;
    options: Array<{ id: string; label: string; description?: string }>;
  }>;
  raw: Record<string, unknown>;
}

interface SessionState {
  connection: "idle" | "starting" | "ready" | "reconnecting" | "error";
  cwd: string | null;
  binaryVersion: string | null;
  sessionId: string | null;
  sessionTitle: string;
  blocks: TranscriptBlock[];
  transcriptCursor: TranscriptCursor;
  turnRunning: boolean;
  turnStartedAt: number | null;
  modelId: string | null;
  planMode: boolean;
  usage: Record<string, unknown> | null;
  alwaysApprove: boolean;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  composerDraft: string;
  notice: string | null;
  error: string | null;
  set: (patch: Partial<SessionState>) => void;
  setComposerDraft: (draft: string) => void;
  resetConversation: (sessionId?: string | null) => void;
  appendOptimisticUser: (text: string, images?: string[]) => void;
  applyNotification: (notification: SessionNotification) => void;
  applyNotifications: (notifications: SessionNotification[]) => void;
  finishTurn: () => void;
}

const emptyCursor = (): TranscriptCursor => ({
  turnId: null,
  assistantId: null,
  thoughtId: null,
  optimisticUserId: null,
});

export const useSessionStore = create<SessionState>((set) => ({
  connection: "idle",
  cwd: null,
  binaryVersion: null,
  sessionId: null,
  sessionTitle: "New conversation",
  blocks: [],
  transcriptCursor: emptyCursor(),
  turnRunning: false,
  turnStartedAt: null,
  modelId: localStorage.getItem("thanh.defaultModel"),
  planMode: false,
  usage: null,
  alwaysApprove: localStorage.getItem("thanh.alwaysApprove") === "true",
  pendingPermission: null,
  pendingQuestion: null,
  composerDraft: "",
  notice: null,
  error: null,
  set: (patch) => set(patch),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  resetConversation: (sessionId = null) =>
    set({
      sessionId,
      blocks: [],
      transcriptCursor: emptyCursor(),
      sessionTitle: "New conversation",
      turnRunning: false,
      turnStartedAt: null,
      usage: null,
      pendingPermission: null,
      pendingQuestion: null,
      composerDraft: "",
      notice: null,
      error: null,
    }),
  appendOptimisticUser: (text, images = []) =>
    set((state) => {
      const localId = `local-${crypto.randomUUID()}`;
      const turnId = `turn-${crypto.randomUUID()}`;
      return {
        blocks: [
          ...finishStreamingBlocks(state.blocks),
          { type: "message", id: localId, turnId, role: "user", text, images: [...images], streaming: false },
        ],
        transcriptCursor: { turnId, assistantId: null, thoughtId: null, optimisticUserId: localId },
        turnStartedAt: Date.now(),
      };
    }),
  applyNotification: (notification) =>
    set((state) => reduceNotifications(state, [notification])),
  applyNotifications: (notifications) =>
    set((state) => reduceNotifications(state, notifications)),
  finishTurn: () =>
    set((state) => ({
      blocks: finishStreamingBlocks(state.blocks),
      transcriptCursor: emptyCursor(),
      turnStartedAt: null,
    })),
}));

export function reduceTranscript(
  transcript: TranscriptState,
  update: SessionUpdate | Record<string, unknown>,
): TranscriptState {
  const raw = update as Record<string, unknown>;
  const kind = String(raw.sessionUpdate ?? "");

  if (kind === "user_message_chunk") return reduceUserChunk(transcript, raw);
  if (kind === "agent_message_chunk") return reduceMessageChunk(transcript, raw, "assistant");
  if (kind === "agent_thought_chunk") return reduceMessageChunk(transcript, raw, "thought");
  if (kind === "tool_call" || kind === "tool_call_update") return reduceTool(transcript, raw);
  if (kind === "plan" || kind === "plan_update") return reducePlan(transcript, raw);
  if (kind === "plan_removed") {
    return { ...transcript, blocks: transcript.blocks.filter((block) => block.type !== "plan") };
  }
  return transcript;
}

function reduceNotifications(state: SessionState, notifications: SessionNotification[]): Partial<SessionState> {
  let blocks = state.blocks;
  let cursor = state.transcriptCursor;
  let usage = state.usage;
  let planMode = state.planMode;
  let sessionTitle = state.sessionTitle;
  let modelId = state.modelId;
  let turnStartedAt = state.turnStartedAt;

  for (const notification of notifications) {
    const raw = notification.update as SessionUpdate & Record<string, unknown>;
    const kind = String(raw.sessionUpdate ?? "");
    if (isTurnActivity(kind) && turnStartedAt === null) turnStartedAt = Date.now();
    if (kind === "usage_update") {
      usage = asRecord(raw.usage) ?? asRecord(raw);
      continue;
    }
    if (kind === "current_mode_update") {
      const mode = String(raw.currentModeId ?? raw.modeId ?? "");
      planMode = mode.toLowerCase().includes("plan");
      continue;
    }
    if (kind === "session_info_update") {
      sessionTitle = stringOr(raw.title, sessionTitle) ?? sessionTitle;
      modelId = stringOr(raw.modelId, modelId ?? undefined) ?? null;
      continue;
    }
    const next = reduceTranscript({ blocks, cursor }, raw);
    blocks = next.blocks;
    cursor = next.cursor;
  }

  return { blocks, transcriptCursor: cursor, usage, planMode, sessionTitle, modelId, turnStartedAt };
}

function reduceUserChunk(transcript: TranscriptState, raw: Record<string, unknown>): TranscriptState {
  const content = asRecord(raw.content);
  const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
  const image = contentImage(content);
  const serverId = stringOr(raw.messageId) ?? `user-${transcript.blocks.length}`;
  const optimisticId = transcript.cursor.optimisticUserId;
  const optimisticIndex = optimisticId
    ? transcript.blocks.findIndex((block) => block.type === "message" && block.id === optimisticId)
    : -1;

  if (optimisticIndex >= 0) {
    const blocks = transcript.blocks.map((block, index) => {
      if (index !== optimisticIndex || block.type !== "message") return block;
      return {
        ...block,
        id: serverId,
        images: image && !block.images.includes(image) ? [...block.images, image] : block.images,
      };
    });
    return {
      blocks,
      cursor: { ...transcript.cursor, optimisticUserId: null, assistantId: null, thoughtId: null },
    };
  }

  const last = transcript.blocks.at(-1);
  if (last?.type === "message" && last.role === "user" && transcript.cursor.turnId === last.turnId) {
    return {
      blocks: transcript.blocks.map((block) =>
        block.id === last.id && block.type === "message"
          ? { ...block, text: block.text + text, images: image ? [...block.images, image] : block.images }
          : block,
      ),
      cursor: { ...transcript.cursor, turnId: last.turnId },
    };
  }

  const turnId = `turn-${serverId}`;
  return {
    blocks: [
      ...finishStreamingBlocks(transcript.blocks),
      { type: "message", id: serverId, turnId, role: "user", text, images: image ? [image] : [], streaming: true },
    ],
    cursor: { turnId, assistantId: null, thoughtId: null, optimisticUserId: null },
  };
}

function reduceMessageChunk(
  transcript: TranscriptState,
  raw: Record<string, unknown>,
  role: "assistant" | "thought",
): TranscriptState {
  const content = asRecord(raw.content);
  const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
  const image = contentImage(content);
  if (!text && !image) return transcript;

  const activeId = role === "assistant" ? transcript.cursor.assistantId : transcript.cursor.thoughtId;
  const activeIndex = activeId
    ? transcript.blocks.findIndex((block) => block.type === "message" && block.id === activeId)
    : -1;
  if (activeIndex >= 0) {
    return {
      blocks: transcript.blocks.map((block, index) =>
        index === activeIndex && block.type === "message"
          ? { ...block, text: block.text + text, images: image ? [...block.images, image] : block.images }
          : block,
      ),
      cursor: transcript.cursor,
    };
  }

  if (!text.trim() && !image) return transcript;
  const turnId = transcript.cursor.turnId ?? `turn-orphan-${transcript.blocks.length}`;
  const id = `${role}-${turnId}-${transcript.blocks.length}`;
  const block: MessageBlock = { type: "message", id, turnId, role, text, images: image ? [image] : [], streaming: true };
  return {
    blocks: [...transcript.blocks, block],
    cursor: {
      ...transcript.cursor,
      turnId,
      assistantId: role === "assistant" ? id : transcript.cursor.assistantId,
      thoughtId: role === "thought" ? id : null,
    },
  };
}

function reduceTool(transcript: TranscriptState, raw: Record<string, unknown>): TranscriptState {
  const isStart = raw.sessionUpdate === "tool_call";
  const id = String(raw.toolCallId ?? `tool-${transcript.blocks.length}`);
  const index = transcript.blocks.findIndex((block) => block.type === "tool" && block.id === id);
  const previous = index >= 0 ? (transcript.blocks[index] as ToolBlock) : null;
  const turnId = previous?.turnId ?? transcript.cursor.turnId ?? `turn-orphan-${transcript.blocks.length}`;
  const startedAt = previous?.startedAt ?? numberOr(raw.startedAt, null) ?? Date.now();
  const status = stringOr(raw.status, previous?.status ?? "pending") ?? "pending";
  const elapsedMs = numberOr(raw.elapsedMs, previous?.elapsedMs ?? null)
    ?? (isTerminalToolStatus(status) ? Math.max(0, Date.now() - startedAt) : null);
  const metadata = toolMetadata(raw, previous);
  const next: ToolBlock = {
    type: "tool",
    id,
    turnId,
    title: stringOr(raw.title, previous?.title ?? "Tool") ?? "Tool",
    kind: stringOr(raw.kind, previous?.kind),
    status,
    content: toolContent(raw, previous),
    locations: Array.isArray(raw.locations) ? raw.locations : previous?.locations ?? [],
    startedAt,
    elapsedMs,
    ...metadata,
  };
  const sourceBlocks = isStart ? finishStreamingBlocks(transcript.blocks) : transcript.blocks;
  const blocks = sourceBlocks.map((block, blockIndex) =>
    blockIndex === index ? next : block,
  );
  return {
    blocks: index >= 0 ? blocks : [...blocks, next],
    cursor: isStart
      ? { ...transcript.cursor, turnId, assistantId: null, thoughtId: null }
      : transcript.cursor,
  };
}

function reducePlan(transcript: TranscriptState, raw: Record<string, unknown>): TranscriptState {
  const id = String(raw.planId ?? "active-plan");
  const previous = transcript.blocks.find((block) => block.type === "plan" && block.id === id) as PlanBlock | undefined;
  const next: PlanBlock = {
    type: "plan",
    id,
    turnId: previous?.turnId ?? transcript.cursor.turnId ?? `turn-orphan-${transcript.blocks.length}`,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    content: raw.content,
  };
  const index = transcript.blocks.findIndex((block) => block.type === "plan" && block.id === id);
  return {
    blocks: index >= 0
      ? transcript.blocks.map((block, blockIndex) => (blockIndex === index ? next : block))
      : [...transcript.blocks, next],
    cursor: transcript.cursor,
  };
}

function finishStreamingBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.type === "message" && block.streaming) {
      changed = true;
      return { ...block, streaming: false };
    }
    if (block.type === "tool" && !isTerminalToolStatus(block.status)) {
      changed = true;
      return {
        ...block,
        status: "cancelled",
        elapsedMs: block.elapsedMs ?? Math.max(0, Date.now() - block.startedAt),
      };
    }
    return block;
  });
  return changed ? next : blocks;
}

function isTurnActivity(kind: string): boolean {
  return [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update",
  ].includes(kind);
}

function isTerminalToolStatus(status: string): boolean {
  return ["completed", "complete", "failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

function toolMetadata(raw: Record<string, unknown>, previous: ToolBlock | null) {
  const input = asRecord(raw.rawInput) ?? asRecord(raw.input) ?? asRecord(raw.arguments) ?? {};
  const command = firstString(
    raw.command,
    input.command,
    previous?.command,
  );
  const description = firstString(raw.description, input.description, previous?.description);
  const paths = uniqueStrings([
    ...stringArray(raw.paths),
    ...stringArray(raw.locations),
    ...stringArray(input.paths),
    ...stringArray(input.path),
    ...stringArray(input.filePath),
    ...(previous?.paths ?? []),
  ]);
  return { command, description, paths };
}

function toolContent(raw: Record<string, unknown>, previous: ToolBlock | null): unknown[] {
  if (Array.isArray(raw.content)) return raw.content;
  const delta = firstString(raw.outputDelta, raw.contentDelta, raw.delta);
  if (!delta) return previous?.content ?? [];
  const content = [...(previous?.content ?? [])];
  const last = asRecord(content.at(-1));
  const lastValue = last ? asRecord(last.content) : null;
  if (last?.type === "content" && lastValue?.type === "text" && typeof lastValue.text === "string") {
    content[content.length - 1] = { ...last, content: { ...lastValue, text: `${lastValue.text}${delta}` } };
    return content;
  }
  return [...content, { type: "content", content: { type: "text", text: delta } }];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = asRecord(item);
    return record ? [firstString(record.path, record.filePath, record.uri)].filter((item): item is string => Boolean(item)) : [];
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function contentImage(content: Record<string, unknown> | null): string | null {
  return content?.type === "image" && typeof content.data === "string"
    ? `data:${String(content.mimeType ?? "image/png")};base64,${content.data}`
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
