import { create } from "zustand";
import { readLocal } from "../../ui/storage";
import { emptyPlanSlice } from "../plan-review";
import { emptyCursor } from "./cursor";
import { appendTurnMarker, finishStreamingBlocks, reduceNotifications } from "./transcript";
import { DEFAULT_SESSION_TITLE, EMPTY_PLAN_ENTRIES, type SessionState } from "./types";

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
  currentPromptId: null,
  retrying: false,
  turnStartedAt: null,
  workingSessions: {},
  turnPausedMs: 0,
  questionOpenedAt: null,
  modelId: localStorage.getItem("cook.defaultModel"),
  reasoningEffort: null,
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
  editingQueueEntry: null,
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
      currentPromptId: null,
      retrying: false,
      turnStartedAt: null,
      turnPausedMs: 0,
      questionOpenedAt: null,
      reasoningEffort: null,
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
      pendingPermission: null,
      pendingQuestion: null,
      queuedPromptCount: 0,
      queuedEntries: [],
      editingQueueEntry: null,
      followUps: null,
      composerDraft: "",
      notice: null,
      error: null,
    }),
  appendOptimisticUser: (text, images = [], promptId) =>
    set((state) => {
      const localId = `local-${crypto.randomUUID()}`;
      const turnId = `turn-${crypto.randomUUID()}`;
      return {
        blocks: [
          ...finishStreamingBlocks(state.blocks),
          { type: "message", id: localId, turnId, role: "user", text, images: [...images], streaming: false },
        ],
        transcriptCursor: { turnId, assistantId: null, thoughtId: null, optimisticUserId: localId },
        currentPromptId: promptId ?? null,
        activity: null,
        retrying: false,
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
        currentPromptId: null,
        turnStartedAt: null,
        turnPausedMs: 0,
        questionOpenedAt: null,
        pendingPermission: null,
        pendingQuestion: null,
      };
    }),
}));
