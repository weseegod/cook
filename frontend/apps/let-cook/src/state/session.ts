import type { RequestPermissionRequest, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { create } from "zustand";
import { normalizeError } from "../acp/errors";
import type { PlanFileSummary } from "../acp/plan-files";
import { formatDuration } from "../ui/chat/format-duration";
import { applySubagentSessionUpdate, applyWorkflowUpdated } from "./activity";
import { reduceGoalUpdate, type GoalState } from "./goal";
import { emptyPlanSlice, type PlanComment, type PlanFocus, type PlanSlice } from "./plan-review";
import { deriveActivity, type TurnActivity } from "../ui/chat/turn-activity";
import { readLocal } from "../ui/storage";

export interface MessageBlock {
  type: "message";
  id: string;
  turnId: string;
  role: "user" | "assistant" | "thought";
  text: string;
  images: string[];
  streaming: boolean;
  /** Thinking rows only: local clock frozen on finish; drives `Thought for 1.2s`. */
  startedAt?: number;
  elapsedMs?: number | null;
}

/** Turn marker row (`Worked for 1.2s`, cancel/fail variants) — `blocks/session_event.rs`. */
export interface SessionEventBlock {
  type: "session-event";
  id: string;
  turnId: string;
  text: string;
  /** `goal` rows never close a turn: the goal completes while its own turn is still open. */
  kind?: "turn" | "goal";
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

export type TranscriptBlock = MessageBlock | ToolBlock | PlanBlock | SessionEventBlock;
export const EMPTY_PLAN_ENTRIES: unknown[] = [];

/** Terminal outcome of a turn, as the visible marker presents it (`turn_completion.rs`). */
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "cancelled"; phrase?: string }
  | { kind: "failed"; error?: string };

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
  /** Card heading. Absent for a plan review, which keeps the composer instead of a title line. */
  title?: string;
  kind: "question" | "plan" | "trust" | "elicit";
  questions: Array<{
    question: string;
    multiSelect?: boolean;
    options: Array<{ id: string; label: string; description?: string }>;
  }>;
  raw: Record<string, unknown>;
}

/** One row from `x.ai/queue/changed` (`QueueEntryWire`). */
export interface QueuedPromptEntry {
  id: string;
  version: number;
  text: string;
  kind?: string;
  position?: number;
}

/** Streaming follow-up chips for the latest assistant response. */
export interface FollowUpsState {
  responseId: string;
  suggestions: string[];
}

interface SessionState {
  connection: "idle" | "starting" | "ready" | "reconnecting" | "error";
  cwd: string | null;
  binaryVersion: string | null;
  sessionId: string | null;
  sessionTitle: string;
  blocks: TranscriptBlock[];
  /** Narrow activity snapshot so the status row does not subscribe to the whole transcript. */
  activity: TurnActivity | null;
  /** Stable latest-plan reference for the optional checklist/pane. */
  planEntries: unknown[];
  transcriptCursor: TranscriptCursor;
  turnRunning: boolean;
  turnStartedAt: number | null;
  /**
   * Every session with a prompt in flight, keyed by session id. `turnRunning` covers only the
   * session the window is showing; the conversation list reads this map so a turn stays visible —
   * with its last reported phase — after the user opens another conversation. The agent streams a
   * phase only for the session the window has loaded, so `activity` is what that turn last said.
   */
  workingSessions: Record<string, SessionTurn>;
  /** Time inside this turn that a question card held the clock still (`QuestionViewState.opened_at`). */
  turnPausedMs: number;
  questionOpenedAt: number | null;
  modelId: string | null;
  planMode: boolean;
  usage: Record<string, unknown> | null;
  /** Goal orchestration state from `x.ai/session_notification`; `null` before a goal exists. */
  goal: GoalState | null;
  /** Goal id of the last cleared goal, so a late update for it cannot resurrect the chip. */
  goalClearedId: string | null;
  /** Plan review state (`x.ai/exit_plan_mode`): the plan body, its comments, and popup visibility. */
  planReview: PlanSlice["planReview"];
  planComments: PlanComment[];
  planNextCommentId: number;
  planDialogOpen: boolean;
  planFocus: PlanSlice["planFocus"];
  planCommentRange: PlanSlice["planCommentRange"];
  planEditingCommentId: PlanSlice["planEditingCommentId"];
  planStashedDraft: PlanSlice["planStashedDraft"];
  /** User-toggled ACP Plan checklist under the header; closed by default. */
  todoOverlayOpen: boolean;
  /** The session's plan files, newest first, from `x.ai/session/plans`; empty before the first fetch. */
  planFiles: PlanFileSummary[];
  /** The file a read-only plan viewer is showing; the review pane owns the current episode. */
  planFileView: PlanFileSummary | null;
  /** `/rewind` picker dialog. */
  rewindDialogOpen: boolean;
  /** `/recap` result dialog. */
  recapDialogOpen: boolean;
  /** In-flight `/recap` waiting for `session_recap` / `session_recap_unavailable`. */
  recapPending: boolean;
  recapStatus: "idle" | "loading" | "ready" | "unavailable" | "error";
  recapSummary: string | null;
  recapError: string | null;
  alwaysApprove: boolean;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  /** Prompts the user sent while a turn was already running (drained one per finishing turn). */
  queuedPromptCount: number;
  /** Full queue rows from `x.ai/queue/changed` (N-queue) for the queue bar. */
  queuedEntries: QueuedPromptEntry[];
  /** Follow-up chips from `x.ai/follow_ups` (N-follow). */
  followUps: FollowUpsState | null;
  composerDraft: string;
  notice: string | null;
  error: string | null;
  set: (patch: Partial<SessionState>) => void;
  setComposerDraft: (draft: string) => void;
  /** Stash the plan body an `exit_plan_mode` request carried; comments are per-review, so they reset. */
  beginPlanReview: (body: string | null, fileName?: string) => void;
  /** The review was answered: it stops blocking, but the body stays viewable for the session. */
  endPlanReview: () => void;
  setPlanDialogOpen: (open: boolean) => void;
  setPlanFocus: (focus: PlanFocus) => void;
  setPlanCommentRange: (range: [number, number] | null) => void;
  beginPlanComment: (lineRange: [number, number], id?: number | null) => void;
  cancelPlanComment: () => void;
  setTodoOverlayOpen: (open: boolean) => void;
  setPlanFileView: (file: PlanFileSummary | null) => void;
  setRewindDialogOpen: (open: boolean) => void;
  beginRecap: () => void;
  failRecap: (error: string) => void;
  closeRecapDialog: () => void;
  /** One-argument form commits the shared composer; the three-argument form remains useful for reducers/tests. */
  savePlanComment: (...args: [text: string] | [id: number | null, lineRange: [number, number], text: string]) => void;
  removePlanComment: (id: number) => void;
  resetConversation: (sessionId?: string | null) => void;
  appendOptimisticUser: (text: string, images?: string[]) => void;
  applyNotification: (notification: SessionNotification) => void;
  applyNotifications: (notifications: SessionNotification[]) => void;
  finishTurn: (outcome?: TurnOutcome) => void;
}

/** Title a conversation carries until the agent names it. */
export const DEFAULT_SESSION_TITLE = "New chat";

/** One in-flight turn, as the conversation list reports it. */
export interface SessionTurn {
  /** When the prompt went out, epoch ms. */
  startedAt: number;
  /** Last phase the window learned for this turn; `null` until the agent reports one. */
  activity: TurnActivity | null;
}

/** Turn clock with question-card pauses netted out, in the shared `formatDuration` unit. */
export function turnElapsedMs(
  state: Pick<SessionState, "turnStartedAt" | "turnPausedMs" | "questionOpenedAt">,
  now = Date.now(),
): number | null {
  if (state.turnStartedAt === null) return null;
  const openPause = state.questionOpenedAt === null ? 0 : Math.max(0, now - state.questionOpenedAt);
  return Math.max(0, now - state.turnStartedAt - state.turnPausedMs - openPause);
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
  sessionTitle: DEFAULT_SESSION_TITLE,
  blocks: [],
  activity: null,
  planEntries: EMPTY_PLAN_ENTRIES,
  transcriptCursor: emptyCursor(),
  turnRunning: false,
  turnStartedAt: null,
  workingSessions: {},
  turnPausedMs: 0,
  questionOpenedAt: null,
  modelId: localStorage.getItem("cook.defaultModel"),
  planMode: false,
  usage: null,
  goal: null,
  goalClearedId: null,
  ...emptyPlanSlice,
  todoOverlayOpen: false,
  planFiles: [],
  planFileView: null,
  rewindDialogOpen: false,
  recapDialogOpen: false,
  recapPending: false,
  recapStatus: "idle",
  recapSummary: null,
  recapError: null,
  alwaysApprove: readLocal("alwaysApprove") !== "false",
  pendingPermission: null,
  pendingQuestion: null,
  queuedPromptCount: 0,
  queuedEntries: [],
  followUps: null,
  composerDraft: "",
  notice: null,
  error: null,
  set: (patch) =>
    set((state) => {
      const next: Partial<SessionState> = { ...patch };
      // A question card holds the turn clock still while it is open, so answering a prompt
      // does not inflate the marker or the turn-status timer.
      if ("pendingQuestion" in patch) {
        if (state.questionOpenedAt === null && patch.pendingQuestion) {
          next.questionOpenedAt = Date.now();
        } else if (state.questionOpenedAt !== null && !patch.pendingQuestion) {
          next.turnPausedMs = state.turnPausedMs + Math.max(0, Date.now() - state.questionOpenedAt);
          next.questionOpenedAt = null;
        }
      }
      return next;
    }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  beginPlanReview: (body, fileName) =>
    set({
      planReview: { body, fileName, pending: true },
      // A new review owns its own comments: `acp_handler/interactions.rs` resets both on arrival.
      planComments: [],
      planNextCommentId: 0,
      // TUI shows the line viewer immediately on `exit_plan_mode`.
      planDialogOpen: true,
      planFocus: "preview",
      planCommentRange: null,
      planEditingCommentId: null,
      planStashedDraft: null,
    }),
  endPlanReview: () =>
    set((state) => (state.planReview
      ? {
          planReview: { ...state.planReview, pending: false },
          planFocus: "preview" as const,
          planCommentRange: null,
          planEditingCommentId: null,
          planStashedDraft: null,
        }
      : {})),
  setPlanDialogOpen: (planDialogOpen) => set({ planDialogOpen }),
  setPlanFocus: (planFocus) => set({ planFocus }),
  setPlanCommentRange: (planCommentRange) => set({ planCommentRange }),
  beginPlanComment: (planCommentRange, planEditingCommentId = null) =>
    set((state) => ({
      planFocus: "commenting",
      planCommentRange,
      planEditingCommentId,
      planStashedDraft: state.composerDraft,
      composerDraft: "",
    })),
  cancelPlanComment: () =>
    set((state) => ({
      planFocus: "preview",
      planCommentRange: null,
      planEditingCommentId: null,
      composerDraft: state.planStashedDraft ?? state.composerDraft,
      planStashedDraft: null,
    })),
  setTodoOverlayOpen: (todoOverlayOpen) => set({ todoOverlayOpen }),
  setPlanFileView: (planFileView) => set({ planFileView }),
  setRewindDialogOpen: (rewindDialogOpen) => set({ rewindDialogOpen }),
  beginRecap: () =>
    set({
      recapDialogOpen: true,
      recapPending: true,
      recapStatus: "loading",
      recapSummary: null,
      recapError: null,
    }),
  failRecap: (error) =>
    set({
      recapDialogOpen: true,
      recapPending: false,
      recapStatus: "error",
      recapError: error,
    }),
  closeRecapDialog: () =>
    set({
      recapDialogOpen: false,
      recapPending: false,
      recapStatus: "idle",
      recapSummary: null,
      recapError: null,
    }),
  savePlanComment: (...args) =>
    set((state) => {
      const sharedComposer = args.length === 1;
      const id = sharedComposer ? state.planEditingCommentId : args[0];
      const lineRange = sharedComposer ? state.planCommentRange : args[1];
      const text = sharedComposer ? args[0] : args[2];
      const trimmed = text.trim();
      if (trimmed === "" || lineRange === null || lineRange === undefined) return {};
      if (id !== null) {
        const next = {
          planComments: state.planComments.map((comment) =>
            comment.id === id ? { ...comment, lineRange, text: trimmed } : comment),
        };
        return sharedComposer
          ? {
              ...next,
              planFocus: "preview" as const,
              planCommentRange: null,
              planEditingCommentId: null,
              composerDraft: state.planStashedDraft ?? state.composerDraft,
              planStashedDraft: null,
            }
          : next;
      }
      const next = {
        planComments: [...state.planComments, { id: state.planNextCommentId, lineRange, text: trimmed }],
        planNextCommentId: state.planNextCommentId + 1,
      };
      return sharedComposer
        ? {
            ...next,
            planFocus: "preview" as const,
            planCommentRange: null,
            planEditingCommentId: null,
            composerDraft: state.planStashedDraft ?? state.composerDraft,
            planStashedDraft: null,
          }
        : next;
    }),
  removePlanComment: (id) =>
    set((state) => ({ planComments: state.planComments.filter((comment) => comment.id !== id) })),
  resetConversation: (sessionId = null) =>
    set({
      sessionId,
      blocks: [],
      activity: null,
      planEntries: EMPTY_PLAN_ENTRIES,
      transcriptCursor: emptyCursor(),
      sessionTitle: DEFAULT_SESSION_TITLE,
      turnRunning: false,
      turnStartedAt: null,
      turnPausedMs: 0,
      questionOpenedAt: null,
      usage: null,
      goal: null,
      goalClearedId: null,
      ...emptyPlanSlice,
      todoOverlayOpen: false,
      planFiles: [],
      planFileView: null,
      rewindDialogOpen: false,
      recapDialogOpen: false,
      recapPending: false,
      recapStatus: "idle",
      recapSummary: null,
      recapError: null,
      pendingPermission: null,
      pendingQuestion: null,
      queuedPromptCount: 0,
      queuedEntries: [],
      followUps: null,
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
        activity: null,
        turnStartedAt: Date.now(),
        turnPausedMs: 0,
        followUps: null,
      };
    }),
  applyNotification: (notification) =>
    set((state) => reduceNotifications(state, [notification])),
  applyNotifications: (notifications) =>
    set((state) => reduceNotifications(state, notifications)),
  finishTurn: (outcome = { kind: "completed" }) =>
    set((state) => {
      const finished = finishStreamingBlocks(state.blocks);
      return {
        blocks: appendTurnMarker(finished, state, outcome),
        activity: null,
        transcriptCursor: emptyCursor(),
        turnStartedAt: null,
        turnPausedMs: 0,
        questionOpenedAt: null,
        pendingPermission: null,
        pendingQuestion: null,
      };
    }),
}));

/**
 * The TUI writes one marker row per turn (`blocks/session_event.rs`): `Worked for {duration}` on
 * success, cancel/fail variants otherwise. Returns the transcript untouched when no turn was open
 * or when the agent already closed it.
 */
function appendTurnMarker(
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

export function turnMarkerText(outcome: TurnOutcome, elapsedMs: number | null): string {
  const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
  if (outcome.kind === "cancelled") {
    const phrase = outcome.phrase ?? "Turn cancelled by user";
    return duration ? `${phrase} in ${duration}.` : `${phrase}.`;
  }
  if (outcome.kind === "failed") {
    const detail = outcome.error?.trim();
    if (duration) return `Turn failed in ${duration}: ${detail ?? "unknown error"}`;
    return `Turn failed: ${detail ?? "unknown error"}`;
  }
  return duration ? `Worked for ${duration}` : "Turn completed.";
}

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

function reduceNotifications(state: SessionState, notifications: SessionNotification[]): Partial<SessionState> {
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

function finishStreamingBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
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
