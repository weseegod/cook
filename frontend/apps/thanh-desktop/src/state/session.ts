import type { RequestPermissionRequest, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { create } from "zustand";

export interface MessageBlock {
  type: "message";
  id: string;
  role: "user" | "assistant" | "thought";
  text: string;
  images: string[];
}

export interface ToolBlock {
  type: "tool";
  id: string;
  title: string;
  kind?: string;
  status: string;
  content: unknown[];
  locations: unknown[];
}

export interface PlanBlock {
  type: "plan";
  id: string;
  entries: unknown[];
  content?: unknown;
}

export type TranscriptBlock = MessageBlock | ToolBlock | PlanBlock;

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
  turnRunning: boolean;
  modelId: string | null;
  planMode: boolean;
  usage: Record<string, unknown> | null;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  /** The composer's text, owned here so the palette can drop a slash command into it. */
  composerDraft: string;
  error: string | null;
  set: (patch: Partial<SessionState>) => void;
  setComposerDraft: (draft: string) => void;
  resetConversation: (sessionId?: string | null) => void;
  appendOptimisticUser: (text: string, images?: string[]) => void;
  applyNotification: (notification: SessionNotification) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  connection: "idle",
  cwd: null,
  binaryVersion: null,
  sessionId: null,
  sessionTitle: "New conversation",
  blocks: [],
  turnRunning: false,
  modelId: null,
  planMode: false,
  usage: null,
  pendingPermission: null,
  pendingQuestion: null,
  composerDraft: "",
  error: null,
  set: (patch) => set(patch),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  resetConversation: (sessionId = null) =>
    set({
      sessionId,
      blocks: [],
      sessionTitle: "New conversation",
      turnRunning: false,
      usage: null,
      pendingPermission: null,
      pendingQuestion: null,
      composerDraft: "",
      error: null,
    }),
  appendOptimisticUser: (text, images = []) =>
    set((state) => ({
      blocks: [
        ...state.blocks,
        { type: "message", id: `local-${crypto.randomUUID()}`, role: "user", text, images: [...images] },
      ],
    })),
  applyNotification: (notification) =>
    set((state) => reduceSessionUpdate(state, notification.update)),
}));

export function reduceBlocks(blocks: TranscriptBlock[], update: SessionUpdate | Record<string, unknown>): TranscriptBlock[] {
  const raw = update as Record<string, unknown>;
  const kind = String(raw.sessionUpdate ?? "");
  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const role = kind === "user_message_chunk" ? "user" : kind === "agent_thought_chunk" ? "thought" : "assistant";
    const content = asRecord(raw.content);
    const id = String(raw.messageId ?? `${role}-${blocks.length}`);
    const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
    const image = content?.type === "image" && typeof content.data === "string"
      ? `data:${String(content.mimeType ?? "image/png")};base64,${content.data}`
      : null;
    const index = blocks.findIndex((block) => block.type === "message" && block.id === id && block.role === role);
    if (index >= 0) {
      return blocks.map((block, blockIndex) =>
        blockIndex === index && block.type === "message"
          ? { ...block, text: block.text + text, images: image ? [...block.images, image] : block.images }
          : block,
      );
    }
    const last = blocks.at(-1);
    if (role === "user" && last?.type === "message" && last.role === "user" && last.id.startsWith("local-")) {
      return blocks.map((block, blockIndex) => blockIndex === blocks.length - 1 ? { ...last, id } : block);
    }
    return [...blocks, { type: "message", id, role, text, images: image ? [image] : [] }];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const id = String(raw.toolCallId ?? `tool-${blocks.length}`);
    const index = blocks.findIndex((block) => block.type === "tool" && block.id === id);
    const previous = index >= 0 ? (blocks[index] as ToolBlock) : null;
    const next: ToolBlock = {
      type: "tool",
      id,
      title: stringOr(raw.title, previous?.title ?? "Tool") ?? "Tool",
      kind: stringOr(raw.kind, previous?.kind),
      status: stringOr(raw.status, previous?.status ?? "pending") ?? "pending",
      content: Array.isArray(raw.content) ? raw.content : previous?.content ?? [],
      locations: Array.isArray(raw.locations) ? raw.locations : previous?.locations ?? [],
    };
    return index >= 0 ? blocks.map((block, blockIndex) => (blockIndex === index ? next : block)) : [...blocks, next];
  }
  if (kind === "plan" || kind === "plan_update") {
    const id = String(raw.planId ?? "active-plan");
    const next: PlanBlock = {
      type: "plan",
      id,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      content: raw.content,
    };
    const index = blocks.findIndex((block) => block.type === "plan" && block.id === id);
    return index >= 0 ? blocks.map((block, blockIndex) => (blockIndex === index ? next : block)) : [...blocks, next];
  }
  if (kind === "plan_removed") return blocks.filter((block) => block.type !== "plan");
  return blocks;
}

function reduceSessionUpdate(state: SessionState, update: SessionUpdate): Partial<SessionState> {
  const raw = update as SessionUpdate & Record<string, unknown>;
  const kind = String(raw.sessionUpdate ?? "");
  if (kind === "usage_update") return { usage: asRecord(raw.usage) ?? asRecord(raw) };
  if (kind === "current_mode_update") {
    const mode = String(raw.currentModeId ?? raw.modeId ?? "");
    return { planMode: mode.toLowerCase().includes("plan") };
  }
  if (kind === "session_info_update") {
    return {
      sessionTitle: stringOr(raw.title, state.sessionTitle),
      modelId: stringOr(raw.modelId, state.modelId ?? undefined) ?? null,
    };
  }
  return { blocks: reduceBlocks(state.blocks, raw) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" ? value : fallback;
}
