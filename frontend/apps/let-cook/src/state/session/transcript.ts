import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { normalizeError } from "../../acp/errors";
import { formatDuration } from "../../ui/chat/format-duration";
import { deriveActivity, type TurnActivity } from "../../ui/chat/turn-activity";
import { applySubagentSessionUpdate, applyWorkflowUpdated } from "../activity";
import { reduceGoalUpdate } from "../goal";
import { emptyCursor, emptyTranscriptCursor, turnElapsedMs, turnMarkerText } from "./cursor";
import {
  EMPTY_PLAN_ENTRIES,
  type MessageBlock,
  type PlanBlock,
  type SessionState,
  type SessionTurn,
  type ToolBlock,
  type TranscriptBlock,
  type TranscriptState,
  type TurnOutcome,
} from "./types";
import {
  asRecord,
  contentImage,
  isTerminalToolStatus,
  isTurnActivity,
  numberOr,
  stringOr,
  toolContent,
  toolMetadata,
} from "./values";

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

function latestPlanEntries(blocks: readonly TranscriptBlock[]): unknown[] {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === "plan") return block.entries;
  }
  return EMPTY_PLAN_ENTRIES;
}

export function reduceNotifications(state: SessionState, notifications: SessionNotification[]): Partial<SessionState> {
  let blocks = state.blocks;
  let cursor = state.transcriptCursor;
  let usage = state.usage;
  let planMode = state.planMode;
  let sessionTitle = state.sessionTitle;
  let modelId = state.modelId;
  let turnStartedAt = state.turnStartedAt;
  let turnPausedMs = state.turnPausedMs;
  let questionOpenedAt = state.questionOpenedAt;
  let turnRunning = state.turnRunning;
  let pendingPermission = state.pendingPermission;
  let pendingQuestion = state.pendingQuestion;
  let goalSlice = { goal: state.goal, clearedGoalId: state.goalClearedId };
  let recapPending = state.recapPending;
  let recapStatus = state.recapStatus;
  let recapSummary = state.recapSummary;
  let recapError = state.recapError;
  let recapDialogOpen = state.recapDialogOpen;

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
    if (kind === "goal_updated") {
      const reduced = reduceGoalUpdate(goalSlice, raw);
      goalSlice = reduced.slice;
      // The TUI writes one `Goal complete in {duration} end-to-end.` row on the transition into
      // `complete` (`session_notification.rs`), timed from the goal's own clock, not the turn's.
      if (reduced.completedElapsedMs !== null) {
        const turnId = cursor.turnId ?? `goal-${goalSlice.goal?.goalId ?? "run"}`;
        blocks = [...blocks, {
          type: "session-event",
          id: `goal-complete-${goalSlice.goal?.goalId ?? "run"}`,
          turnId,
          kind: "goal",
          text: `Goal complete in ${formatDuration(reduced.completedElapsedMs)} end-to-end.`,
        }];
      }
      continue;
    }
    // Manual `/recap` lands here as `session_recap` / `session_recap_unavailable` (U-recap).
    if (kind === "session_recap") {
      if (recapPending || recapDialogOpen) {
        recapPending = false;
        recapStatus = "ready";
        recapSummary = typeof raw.summary === "string" ? raw.summary : "";
        recapError = null;
        recapDialogOpen = true;
      }
      continue;
    }
    if (kind === "session_recap_unavailable") {
      if (recapPending || recapDialogOpen) {
        recapPending = false;
        recapStatus = "unavailable";
        recapSummary = null;
        recapError = null;
        recapDialogOpen = true;
      }
      continue;
    }
    // U-turn: honor `turn_completed` when the agent emits it (alongside prompt RPC completion).
    if (kind === "turn_completed") {
      if (turnStartedAt !== null || cursor.turnId) {
        const stop = String(raw.stopReason ?? raw.stop_reason ?? "");
        const outcome: TurnOutcome = /cancel/i.test(stop)
          ? { kind: "cancelled" }
          : /fail|error/i.test(stop) || raw.error != null
            ? { kind: "failed", error: typeof raw.error === "string" ? normalizeError(raw.error) : undefined }
            : { kind: "completed" };
        const finished = finishStreamingBlocks(blocks);
        blocks = appendTurnMarker(
          finished,
          {
            turnStartedAt,
            turnPausedMs,
            questionOpenedAt,
            transcriptCursor: cursor,
          },
          outcome,
        );
        cursor = emptyCursor();
        turnStartedAt = null;
        turnPausedMs = 0;
        questionOpenedAt = null;
        turnRunning = false;
        pendingPermission = null;
        pendingQuestion = null;
      }
      continue;
    }
    // U-sub-* / U-wf: activity dock only — do not spam the transcript.
    if (kind === "subagent_spawned" || kind === "subagent_progress" || kind === "subagent_finished") {
      applySubagentSessionUpdate(raw, notification.sessionId);
      continue;
    }
    if (kind === "workflow_updated") {
      applyWorkflowUpdated(raw, notification.sessionId);
      continue;
    }
    const next = reduceTranscript({ blocks, cursor }, raw);
    blocks = next.blocks;
    cursor = next.cursor;
  }

  const transcriptChanged = blocks !== state.blocks;
  const activity = transcriptChanged ? deriveActivity(blocks) : state.activity;
  return {
    blocks,
    ...(transcriptChanged ? { activity, planEntries: latestPlanEntries(blocks) } : {}),
    transcriptCursor: cursor,
    usage,
    planMode,
    sessionTitle,
    modelId,
    turnStartedAt,
    turnPausedMs,
    questionOpenedAt,
    turnRunning,
    pendingPermission,
    pendingQuestion,
    goal: goalSlice.goal,
    goalClearedId: goalSlice.clearedGoalId,
    recapPending,
    recapStatus,
    recapSummary,
    recapError,
    recapDialogOpen,
    workingSessions: recordTurnActivity(state, activity),
  };
}

/** Remember the visible conversation's phase on its in-flight turn, for the list to keep showing. */
function recordTurnActivity(state: SessionState, activity: TurnActivity | null): Record<string, SessionTurn> {
  const { sessionId, workingSessions } = state;
  const turn = sessionId === null ? undefined : workingSessions[sessionId];
  if (!turn || turn.activity === activity) return workingSessions;
  return { ...workingSessions, [sessionId!]: { ...turn, activity } };
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
  // First agent text closes the thinking segment, exactly like the tracker's `current_thinking`.
  const source = role === "assistant" ? finishOpenThoughts(transcript.blocks) : transcript.blocks;

  const activeId = role === "assistant" ? transcript.cursor.assistantId : transcript.cursor.thoughtId;
  const activeIndex = activeId
    ? source.findIndex((block) => block.type === "message" && block.id === activeId)
    : -1;
  if (activeIndex >= 0) {
    return {
      blocks: source.map((block, index) =>
        index === activeIndex && block.type === "message"
          ? { ...block, text: block.text + text, images: image ? [...block.images, image] : block.images }
          : block,
      ),
      cursor: transcript.cursor,
    };
  }

  if (!text.trim() && !image) return transcript;
  const turnId = transcript.cursor.turnId ?? `turn-orphan-${source.length}`;
  const id = `${role}-${turnId}-${source.length}`;
  const block: MessageBlock = {
    type: "message",
    id,
    turnId,
    role,
    text,
    images: image ? [image] : [],
    streaming: true,
    ...(role === "thought" ? { startedAt: Date.now(), elapsedMs: null } : {}),
  };
  return {
    blocks: [...source, block],
    cursor: {
      ...transcript.cursor,
      turnId,
      assistantId: role === "assistant" ? id : transcript.cursor.assistantId,
      thoughtId: role === "thought" ? id : null,
    },
  };
}

/** Freeze every streaming thinking row (and drop empty ones) before assistant prose opens. */
function finishOpenThoughts(blocks: TranscriptBlock[]): TranscriptBlock[] {
  let changed = false;
  const next: TranscriptBlock[] = [];
  for (const block of blocks) {
    if (block.type === "message" && block.role === "thought") {
      if (!block.text.trim()) {
        changed = true;
        continue;
      }
      const finished = finishThought(block);
      if (finished !== block) changed = true;
      next.push(finished);
      continue;
    }
    next.push(block);
  }
  return changed ? next : blocks;
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
  const sourceBlocks = isStart ? finishMessageSegments(transcript.blocks) : transcript.blocks;
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

/**
 * The TUI writes one marker row per turn (`blocks/session_event.rs`): `Worked for {duration}` on
 * success, cancel/fail variants otherwise. Returns the transcript untouched when no turn was open
 * or when the agent already closed it.
 */
export function appendTurnMarker(
  blocks: TranscriptBlock[],
  state: Pick<SessionState, "turnStartedAt" | "turnPausedMs" | "questionOpenedAt" | "transcriptCursor">,
  outcome: TurnOutcome,
): TranscriptBlock[] {
  const turnId = state.transcriptCursor.turnId;
  if (!turnId) return blocks;
  const last = blocks.at(-1);
  if (!last || last.turnId !== turnId) return blocks;
  // Idempotent when the agent already closed the turn. A goal-complete row is not a turn marker:
  // the goal finishes while its own turn is still running, so the turn marker still belongs there.
  if (last.type === "session-event" && last.kind !== "goal") return blocks;
  const text = turnMarkerText(outcome, turnElapsedMs(state));
  return [...blocks, { type: "session-event", id: `event-${turnId}`, turnId, kind: "turn", text }];
}

export function finishStreamingBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const next: TranscriptBlock[] = [];
  for (const block of finishMessageSegments(blocks)) {
    if (block.type === "tool" && !isTerminalToolStatus(block.status)) {
      next.push({
        ...block,
        status: "cancelled",
        elapsedMs: block.elapsedMs ?? Math.max(0, Date.now() - block.startedAt),
      });
      continue;
    }
    next.push(block);
  }
  return next;
}

/**
 * Close the streaming prose/thinking segments without touching tool rows: a tool call ends the
 * assistant segment (and the tracker's `current_thinking`), but sibling tools keep running.
 */
function finishMessageSegments(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const next: TranscriptBlock[] = [];
  for (const block of blocks) {
    if (block.type === "message" && block.role === "thought") {
      // Pre-created/empty thinking is removed rather than rendered as "Thought for 0.0s".
      if (!block.text.trim()) continue;
      next.push(finishThought(block));
      continue;
    }
    if (block.type === "message" && block.streaming) {
      next.push({ ...block, streaming: false });
      continue;
    }
    next.push(block);
  }
  const changed = next.length !== blocks.length || next.some((block, index) => block !== blocks[index]);
  return changed ? next : blocks;
}

/** Freeze a thinking row's clock; the local timer wins while live (`thinking.rs::finish`). */
function finishThought(block: MessageBlock): MessageBlock {
  if (!block.streaming) return block;
  return {
    ...block,
    streaming: false,
    elapsedMs: block.elapsedMs ?? (block.startedAt === undefined ? null : Math.max(0, Date.now() - block.startedAt)),
  };
}
