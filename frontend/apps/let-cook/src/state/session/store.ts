import { create } from "zustand";
import { readLocal } from "../../ui/storage";
import { emptyPlanSlice } from "../plan-review";
import { emptyCursor } from "./cursor";
import { appendTurnMarker, finishStreamingBlocks, reduceNotifications } from "./transcript";
import {
  DEFAULT_SESSION_TITLE,
  EMPTY_PLAN_ENTRIES,
  type SessionState,
  type StashedInteraction,
  type StashedInteractions,
  type StashedPlanReview,
} from "./types";

/** How many toasts the right-side stack keeps before dropping the oldest. */
export const MAX_TOASTS = 3;

function dropPlanReviewStash(
  planReviewsBySession: Record<string, StashedPlanReview>,
  sessionId: string | null,
): Record<string, StashedPlanReview> {
  if (!sessionId || !(sessionId in planReviewsBySession)) return planReviewsBySession;
  const next = { ...planReviewsBySession };
  delete next[sessionId];
  return next;
}

function dropInteractionStash(
  interactionsBySession: Record<string, StashedInteractions>,
  sessionId: string | null,
): Record<string, StashedInteractions> {
  if (!sessionId || !(sessionId in interactionsBySession)) return interactionsBySession;
  const next = { ...interactionsBySession };
  delete next[sessionId];
  return next;
}

function withoutInteraction(
  stash: StashedInteractions | undefined,
  kind: StashedInteraction["kind"],
): StashedInteractions | undefined {
  if (!stash || !(kind in stash)) return stash;
  const next = { ...stash };
  delete next[kind];
  return next.permission || next.question ? next : undefined;
}

function removeFromStash(
  interactionsBySession: Record<string, StashedInteractions>,
  sessionId: string,
  kind: StashedInteraction["kind"],
): Record<string, StashedInteractions> {
  const next = withoutInteraction(interactionsBySession[sessionId], kind);
  return next
    ? { ...interactionsBySession, [sessionId]: next }
    : dropInteractionStash(interactionsBySession, sessionId);
}

export const useSessionStore = create<SessionState>((set, get) => ({
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
  queuesBySession: {},
  planReviewsBySession: {},
  interactionsBySession: {},
  sessionAlerts: {},
  toasts: [],
  editingQueueEntry: null,
  followUps: null,
  composerDraft: "",
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
  pushToast: (toast) =>
    set((state) => {
      const sameMessage = (item: SessionState["toasts"][number]) =>
        item.tone === toast.tone
        && item.title === toast.title
        && item.body === toast.body
        && item.sessionId === toast.sessionId;
      // The agent can report one failure twice (the refused RPC and the turn's own completion),
      // so a repeat of the message on screen replaces it instead of stacking a twin.
      const rest = state.toasts.filter((item) => !sameMessage(item));
      return { toasts: [{ id: crypto.randomUUID(), ...toast }, ...rest].slice(0, MAX_TOASTS) };
    }),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  stashInteraction: (sessionId, interaction) =>
    set((state) => {
      const stash = state.interactionsBySession[sessionId];
      return {
        interactionsBySession: {
          ...state.interactionsBySession,
          [sessionId]: interaction.kind === "permission"
            ? { ...stash, permission: interaction.value }
            : { ...stash, question: interaction.value },
        },
      };
    }),
  dropStashedInteraction: (sessionId, kind) =>
    set((state) => {
      const next = removeFromStash(state.interactionsBySession, sessionId, kind);
      return next === state.interactionsBySession ? {} : { interactionsBySession: next };
    }),
  restoreStashedInteractions: () => {
    const state = get();
    const id = state.sessionId;
    if (!id) return;
    const stash = state.interactionsBySession[id];
    if (!stash) return;
    // A card this load's replay already installed is newer than the parked copy, so the parked
    // one goes. A folder-trust card is not this conversation's: it keeps the slot and the parked
    // card waits for a later load instead of being dropped.
    const liveQuestion = state.pendingQuestion?.kind === "trust" ? null : state.pendingQuestion;
    const liveTrust = state.pendingQuestion?.kind === "trust";
    let interactionsBySession = state.interactionsBySession;
    const patch: Partial<SessionState> = {};
    if (state.pendingPermission) {
      interactionsBySession = removeFromStash(interactionsBySession, id, "permission");
    } else if (stash.permission) {
      patch.pendingPermission = stash.permission;
      interactionsBySession = removeFromStash(interactionsBySession, id, "permission");
    }
    if (liveQuestion) {
      interactionsBySession = removeFromStash(interactionsBySession, id, "question");
    } else if (stash.question && !liveTrust) {
      patch.pendingQuestion = stash.question;
      interactionsBySession = removeFromStash(interactionsBySession, id, "question");
    }
    if (interactionsBySession === state.interactionsBySession) return;
    patch.interactionsBySession = interactionsBySession;
    get().set(patch);
  },
  setSessionAlert: (sessionId, message) =>
    set((state) => {
      if (message === null) {
        if (!(sessionId in state.sessionAlerts)) return {};
        const next = { ...state.sessionAlerts };
        delete next[sessionId];
        return { sessionAlerts: next };
      }
      return { sessionAlerts: { ...state.sessionAlerts, [sessionId]: message } };
    }),
  beginPlanReview: (body, fileName) =>
    set((state) => ({
      // A fresh request replaces any unanswered stash for this conversation.
      planReviewsBySession: dropPlanReviewStash(state.planReviewsBySession, state.sessionId),
      planReview: { body, fileName, pending: true },
      // A new review owns its own comments: `acp_handler/interactions.rs` resets both on arrival.
      planComments: [],
      planNextCommentId: 0,
      // TUI shows the line viewer immediately on `exit_plan_mode`.
      planDialogOpen: true,
      planFocus: "preview" as const,
      planCommentRange: null,
      planEditingCommentId: null,
      planStashedDraft: null,
    })),
  endPlanReview: () =>
    set((state) => (state.planReview
      ? {
          // An answered request must not come back when switching conversations.
          planReviewsBySession: dropPlanReviewStash(state.planReviewsBySession, state.sessionId),
          planReview: { ...state.planReview, pending: false },
          planFocus: "preview" as const,
          planCommentRange: null,
          planEditingCommentId: null,
          planStashedDraft: null,
        }
      : {})),
  stashPlanReview: (sessionId, stash) =>
    set((state) => ({
      planReviewsBySession: { ...state.planReviewsBySession, [sessionId]: stash },
    })),
  restoreStashedPlanReview: () =>
    set((state) => {
      const id = state.sessionId;
      if (!id) return {};
      // Replay already installed a live waiter; that request wins over any older stash.
      if (state.planReview?.pending) return {};
      const stash = state.planReviewsBySession[id];
      if (!stash) return {};
      return {
        planReviewsBySession: dropPlanReviewStash(state.planReviewsBySession, id),
        planReview: stash.planReview,
        planComments: stash.planComments,
        planNextCommentId: stash.planNextCommentId,
        planFocus: stash.planFocus,
        planCommentRange: stash.planCommentRange,
        planEditingCommentId: stash.planEditingCommentId,
        planStashedDraft: stash.planStashedDraft,
        pendingQuestion: stash.pendingQuestion,
        // Pane stays closed until the user opens that plan from the header chip.
        planDialogOpen: false,
        planFileView: null,
        questionOpenedAt: Date.now(),
      };
    }),
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
    set((state) => {
      let planReviewsBySession = state.planReviewsBySession;
      let interactionsBySession = state.interactionsBySession;
      let sessionAlerts = state.sessionAlerts;
      const outgoing = state.sessionId;
      // Park the unanswered review with the conversation that owned it — same idea as queues.
      if (
        outgoing
        && state.planReview?.pending
        && state.pendingQuestion?.kind === "plan"
      ) {
        planReviewsBySession = {
          ...planReviewsBySession,
          [outgoing]: {
            planReview: state.planReview,
            planComments: state.planComments,
            planNextCommentId: state.planNextCommentId,
            planFocus: state.planFocus,
            planCommentRange: state.planCommentRange,
            planEditingCommentId: state.planEditingCommentId,
            planStashedDraft: state.planStashedDraft,
            pendingQuestion: state.pendingQuestion,
          },
        };
      }
      // Park the outgoing conversation's blocking card and its error banner. The agent is still
      // parked on the request, and the failure still belongs to that transcript.
      if (outgoing && outgoing !== sessionId) {
        const question = state.pendingQuestion?.kind === "plan" || state.pendingQuestion?.kind === "trust"
          ? undefined
          : state.pendingQuestion ?? undefined;
        if (state.pendingPermission || question) {
          interactionsBySession = {
            ...interactionsBySession,
            [outgoing]: {
              ...interactionsBySession[outgoing],
              ...(state.pendingPermission ? { permission: state.pendingPermission } : {}),
              ...(question ? { question } : {}),
            },
          };
        }
        if (state.error) sessionAlerts = { ...sessionAlerts, [outgoing]: state.error };
      }
      // The conversation being opened gets its own failure back. A folder-trust card is about the
      // workspace, not the conversation, so it stays on screen across the switch.
      let incomingAlert: string | undefined;
      if (sessionId && sessionAlerts[sessionId] !== undefined) {
        incomingAlert = sessionAlerts[sessionId];
        sessionAlerts = { ...sessionAlerts };
        delete sessionAlerts[sessionId];
      }
      const trust = state.pendingQuestion?.kind === "trust" ? state.pendingQuestion : null;
      return {
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
        pendingQuestion: trust,
        interactionsBySession,
        sessionAlerts,
        queuedPromptCount: (sessionId && state.queuesBySession[sessionId]?.length) || 0,
        queuedEntries: (sessionId && state.queuesBySession[sessionId]) || [],
        planReviewsBySession,
        editingQueueEntry: null,
        followUps: null,
        composerDraft: "",
        error: incomingAlert ?? null,
      };
    }),
  clearTranscript: () =>
    set((state) => ({
      blocks: [],
      activity: null,
      // The turn keeps its identity so a running turn's next chunk paints under the real turn id
      // and `finishTurn` still writes its marker; only the prose/thinking segments restart.
      transcriptCursor: { ...state.transcriptCursor, assistantId: null, thoughtId: null },
    })),
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
