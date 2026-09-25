import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { PlanFileSummary } from "../../acp/plan-files";
import type { TurnActivity } from "../../ui/chat/turn-activity";
import type { GoalState } from "../goal";
import type { PlanComment, PlanFocus, PlanSlice } from "../plan-review";

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
    /** Full question text — wire answers are keyed by this string. */
    question: string;
    /** First paragraph of `question` (TUI label). */
    label: string;
    /** Remainder after a blank line, if any (TUI description). */
    description?: string;
    /** 0-based position in the ask payload (index-keyed selection state). */
    index: number;
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

export interface SessionState {
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
  /** Prompt whose user bubble currently owns the live transcript cursor. */
  currentPromptId: string | null;
  /** The active request is between retry attempts; a previous decode rate is no longer live. */
  retrying: boolean;
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
  /** Effective reasoning effort for the active session, when the selected model supports it. */
  reasoningEffort: string | null;
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
  /**
   * Queue row currently loaded into the composer for edit (`hold_edit` active).
   * Null when the composer is composing a normal / queued send.
   */
  editingQueueEntry: { id: string; version: number } | null;
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
  appendOptimisticUser: (text: string, images?: string[], promptId?: string) => void;
  applyNotification: (notification: SessionNotification) => void;
  applyNotifications: (notifications: SessionNotification[]) => void;
  finishTurn: (outcome?: TurnOutcome) => void;
}

/** Title a conversation carries until the agent names it. */
export const DEFAULT_SESSION_TITLE = "New chat";

/** One in-flight turn, as the conversation list reports it. */
export interface SessionTurn {
  /** When the session first went busy, epoch ms. Survives later prompts in the same busy stretch. */
  startedAt: number;
  /** Last phase the window learned for this turn; `null` until the agent reports one. */
  activity: TurnActivity | null;
  /** In-flight prompt ids for this session; the row clears only when this list is empty. */
  promptIds: string[];
}
