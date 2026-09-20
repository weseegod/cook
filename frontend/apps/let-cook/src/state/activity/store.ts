import { create } from "zustand";
import {
  cancelSubagent,
  deleteScheduledTask,
  killTask,
  listRunningSubagents,
  listTasks,
  type SubagentListItem,
  type TaskListItem,
} from "../../acp/activity";
import { normalizeError } from "../../acp/errors";
import type { TranscriptState } from "../session";
import { terminalStatus } from "./status";
import type { ActivityItem, ActivityState } from "./types";

const empty = () => ({
  tasks: {} as Record<string, ActivityItem>,
  subagents: {} as Record<string, ActivityItem>,
  schedules: {} as Record<string, ActivityItem>,
  workflows: {} as Record<string, ActivityItem>,
  childTranscripts: {} as Record<string, TranscriptState>,
  overlayOpen: false,
  viewing: null as ActivityItem | null,
});

export const useActivityStore = create<ActivityState>((set, get) => ({
  ...empty(),
  panelNonce: 0,
  panelTarget: null,
  lastError: null,
  requestOpenPanel: () => set((state) => ({ panelNonce: state.panelNonce + 1, panelTarget: "activity" })),
  clearPanelTarget: () => set({ panelTarget: null }),
  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
  toggleOverlay: () => set((state) => ({ overlayOpen: !state.overlayOpen })),
  setViewing: (viewing) => set({ viewing }),
  clearViewing: () => set({ viewing: null }),
  reset: () => set({ ...empty(), lastError: null }),
  upsertTask: (item) => set((state) => ({ tasks: { ...state.tasks, [item.id]: mergeItem(state.tasks[item.id], item) } })),
  completeTask: (taskId, patch) =>
    set((state) => {
      const prev = state.tasks[taskId];
      if (!prev) {
        if (!patch) return state;
        const next: ActivityItem = {
          id: taskId,
          kind: "task",
          name: patch.name ?? taskId,
          status: patch.status ?? "completed",
          startedAt: patch.startedAt ?? Date.now(),
          endedAt: patch.endedAt ?? Date.now(),
          ...patch,
        };
        return { tasks: { ...state.tasks, [taskId]: next } };
      }
      return {
        tasks: {
          ...state.tasks,
          [taskId]: {
            ...prev,
            ...patch,
            sessionId: patch?.sessionId ?? prev.sessionId,
            status: patch?.status ?? terminalStatus(prev.status, "completed"),
            endedAt: patch?.endedAt ?? Date.now(),
          },
        },
      };
    }),
  upsertSubagent: (item) =>
    set((state) => ({ subagents: { ...state.subagents, [item.id]: mergeItem(state.subagents[item.id], item) } })),
  upsertSchedule: (item) =>
    set((state) => ({ schedules: { ...state.schedules, [item.id]: mergeItem(state.schedules[item.id], item) } })),
  removeSchedule: (taskId) =>
    set((state) => {
      const { [taskId]: _, ...rest } = state.schedules;
      return { schedules: rest };
    }),
  upsertWorkflow: (item) =>
    set((state) => ({ workflows: { ...state.workflows, [item.id]: mergeItem(state.workflows[item.id], item) } })),
  setActivityLabel: (id, label) =>
    set((state) => {
      const row = state.subagents[id] ?? state.workflows[id] ?? state.tasks[id] ?? state.schedules[id];
      if (!row || row.activityLabel === label) return state;
      const updated = { ...row, activityLabel: label };
      if (row.kind === "subagent") return { subagents: { ...state.subagents, [id]: updated } };
      if (row.kind === "workflow") return { workflows: { ...state.workflows, [id]: updated } };
      if (row.kind === "schedule") return { schedules: { ...state.schedules, [id]: updated } };
      return { tasks: { ...state.tasks, [id]: updated } };
    }),
  setChildTranscript: (childSessionId, transcript) =>
    set((state) => ({ childTranscripts: { ...state.childTranscripts, [childSessionId]: transcript } })),
  refreshFromAgent: async (sessionId) => {
    try {
      const [tasks, subagents] = await Promise.all([listTasks(sessionId), listRunningSubagents(sessionId)]);
      set((state) => ({
        tasks: { ...state.tasks, ...Object.fromEntries(tasks.filter((t) => t.taskId).map((t) => [t.taskId, fromTaskList(t, sessionId)])) },
        subagents: {
          ...state.subagents,
          ...Object.fromEntries(subagents.filter((s) => s.subagentId).map((s) => [s.subagentId, fromSubagentList(s, sessionId)])),
        },
        lastError: null,
      }));
    } catch (error) {
      set({ lastError: normalizeError(error, "Could not load activity") });
    }
  },
  killActivity: async (sessionId, item) => {
    try {
      if (item.kind === "task") {
        await killTask(sessionId, item.id);
        get().completeTask(item.id, { status: "killed" });
      } else if (item.kind === "subagent") {
        await cancelSubagent(item.id);
        get().upsertSubagent({ ...item, status: "cancelled", endedAt: Date.now() });
      } else if (item.kind === "schedule") {
        await deleteScheduledTask(sessionId, item.id);
        get().removeSchedule(item.id);
      }
      set({ lastError: null });
    } catch (error) {
      set({ lastError: normalizeError(error, "Could not load activity") });
      throw error;
    }
  },
}));

function fromTaskList(task: TaskListItem, sessionId: string): ActivityItem {
  return {
    id: task.taskId,
    kind: "task",
    name: task.description ?? task.displayCommand ?? task.command ?? task.taskId,
    status: task.completed ? "completed" : "running",
    startedAt: task.startedAt ?? Date.now(),
    endedAt: task.completed ? Date.now() : undefined,
    detail: task.command,
    isMonitor: task.kind === "monitor",
    output: task.output,
    outputFile: task.outputFile,
    truncated: task.truncated,
    sessionId,
  };
}

function fromSubagentList(sub: SubagentListItem, sessionId: string): ActivityItem {
  return {
    id: sub.subagentId,
    kind: "subagent",
    name: sub.description || sub.subagentType || sub.subagentId,
    status: sub.status ?? "running",
    startedAt: sub.startedAtEpochMs ?? Date.now() - (sub.durationMs ?? 0),
    detail: sub.subagentType,
    childSessionId: sub.childSessionId,
    sessionId,
  };
}

function mergeItem(prev: ActivityItem | undefined, next: ActivityItem): ActivityItem {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    name: next.name || prev.name,
    startedAt: Math.min(prev.startedAt, next.startedAt),
    detail: next.detail ?? prev.detail,
    humanSchedule: next.humanSchedule ?? prev.humanSchedule,
    nextFireAt: next.nextFireAt !== undefined ? next.nextFireAt : prev.nextFireAt,
    isMonitor: next.isMonitor ?? prev.isMonitor,
    sessionId: next.sessionId ?? prev.sessionId,
    activityLabel: next.activityLabel ?? prev.activityLabel,
    childSessionId: next.childSessionId ?? prev.childSessionId,
    output: next.output ?? prev.output,
    outputFile: next.outputFile ?? prev.outputFile,
    truncated: next.truncated ?? prev.truncated,
  };
}

