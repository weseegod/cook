/**
 * Compact activity dock state (map §10 TK-*): background tasks, subagents, schedules, workflows.
 * Fed by N-tbg, N-tdone, N-sched-*, N-mon and U-sub-*, U-wf — not transcript rows.
 */
import { create } from "zustand";
import {
  activityPayload,
  cancelSubagent,
  deleteScheduledTask,
  killTask,
  listRunningSubagents,
  listTasks,
  type SubagentListItem,
  type TaskListItem,
} from "../acp/activity";

export type ActivityKind = "task" | "subagent" | "schedule" | "workflow";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  name: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  detail?: string;
  humanSchedule?: string;
  nextFireAt?: string | null;
  isMonitor?: boolean;
}

interface ActivityState {
  tasks: Record<string, ActivityItem>;
  subagents: Record<string, ActivityItem>;
  schedules: Record<string, ActivityItem>;
  workflows: Record<string, ActivityItem>;
  /** Incremented when `/tasks` or `/dashboard` asks the shell to open the Activity tab. */
  panelNonce: number;
  panelTarget: "activity" | null;
  lastError: string | null;
  requestOpenPanel: () => void;
  clearPanelTarget: () => void;
  reset: () => void;
  upsertTask: (item: ActivityItem) => void;
  completeTask: (taskId: string, patch?: Partial<ActivityItem>) => void;
  upsertSubagent: (item: ActivityItem) => void;
  upsertSchedule: (item: ActivityItem) => void;
  removeSchedule: (taskId: string) => void;
  upsertWorkflow: (item: ActivityItem) => void;
  refreshFromAgent: (sessionId: string) => Promise<void>;
  killActivity: (sessionId: string, item: ActivityItem) => Promise<void>;
}

const empty = () => ({
  tasks: {} as Record<string, ActivityItem>,
  subagents: {} as Record<string, ActivityItem>,
  schedules: {} as Record<string, ActivityItem>,
  workflows: {} as Record<string, ActivityItem>,
});

export const useActivityStore = create<ActivityState>((set, get) => ({
  ...empty(),
  panelNonce: 0,
  panelTarget: null,
  lastError: null,
  requestOpenPanel: () => set((state) => ({ panelNonce: state.panelNonce + 1, panelTarget: "activity" })),
  clearPanelTarget: () => set({ panelTarget: null }),
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
  refreshFromAgent: async (sessionId) => {
    try {
      const [tasks, subagents] = await Promise.all([listTasks(sessionId), listRunningSubagents(sessionId)]);
      set((state) => ({
        tasks: { ...state.tasks, ...Object.fromEntries(tasks.filter((t) => t.taskId).map((t) => [t.taskId, fromTaskList(t)])) },
        subagents: {
          ...state.subagents,
          ...Object.fromEntries(subagents.filter((s) => s.subagentId).map((s) => [s.subagentId, fromSubagentList(s)])),
        },
        lastError: null,
      }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) });
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
      set({ lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
}));

export function activityRows(state: ActivityState = useActivityStore.getState()): ActivityItem[] {
  const rows = [
    ...Object.values(state.tasks),
    ...Object.values(state.subagents),
    ...Object.values(state.schedules),
    ...Object.values(state.workflows),
  ];
  return rows.sort((a, b) => {
    const aLive = isLive(a.status) ? 0 : 1;
    const bLive = isLive(b.status) ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return b.startedAt - a.startedAt;
  });
}

export function isLive(status: string): boolean {
  const s = status.toLowerCase();
  return s === "running" || s === "active" || s === "scheduled" || s === "pending" || s === "fired";
}

/** N-tbg: `x.ai/task_backgrounded` (mapId N-tbg). */
export function applyTaskBackgrounded(params: Record<string, unknown>): void {
  const update = activityPayload(params);
  const taskId = String(update.task_id ?? update.taskId ?? "");
  if (!taskId) return;
  const monitor = typeof update.monitor_description === "string" || typeof update.monitorDescription === "string";
  const name =
    stringOr(update.description)
    ?? stringOr(update.monitor_description ?? update.monitorDescription)
    ?? stringOr(update.command)
    ?? stringOr(update.taskName ?? update.task_name ?? update.name)
    ?? taskId;
  useActivityStore.getState().upsertTask({
    id: taskId,
    kind: "task",
    name,
    status: "running",
    startedAt: Date.now(),
    detail: stringOr(update.command) ?? undefined,
    isMonitor: monitor,
  });
}

/** N-tdone: `x.ai/task_completed`. */
export function applyTaskCompleted(params: Record<string, unknown>): void {
  const update = activityPayload(params);
  const snap = isRecord(update.task_snapshot)
    ? update.task_snapshot
    : isRecord(update.taskSnapshot)
      ? update.taskSnapshot
      : update;
  const taskId = String(snap.task_id ?? snap.taskId ?? update.task_id ?? update.taskId ?? "");
  if (!taskId) return;
  const exitCode = typeof snap.exit_code === "number" ? snap.exit_code : typeof snap.exitCode === "number" ? snap.exitCode : null;
  const signal = typeof snap.signal === "string" ? snap.signal : null;
  const success = exitCode === 0 || (exitCode === null && !signal);
  const killed = snap.explicitly_killed === true || snap.explicitlyKilled === true;
  const name =
    stringOr(snap.description)
    ?? stringOr(snap.display_command ?? snap.displayCommand)
    ?? stringOr(snap.command)
    ?? stringOr(update.taskName ?? update.task_name ?? update.name)
    ?? taskId;
  useActivityStore.getState().completeTask(taskId, {
    name,
    status: killed ? "killed" : success ? "completed" : "failed",
    detail: stringOr(snap.command) ?? undefined,
    endedAt: Date.now(),
  });
}

/** N-sched-c / N-sched-f. */
export function applyScheduledTask(params: Record<string, unknown>, status: "scheduled" | "fired"): void {
  const update = activityPayload(params);
  const taskId = String(update.task_id ?? update.taskId ?? "");
  if (!taskId) return;
  const prev = useActivityStore.getState().schedules[taskId];
  useActivityStore.getState().upsertSchedule({
    id: taskId,
    kind: "schedule",
    name: stringOr(update.prompt) ?? prev?.name ?? taskId,
    status,
    startedAt: prev?.startedAt ?? Date.now(),
    humanSchedule: stringOr(update.human_schedule ?? update.humanSchedule) ?? prev?.humanSchedule,
    nextFireAt: (stringOr(update.next_fire_at ?? update.nextFireAt) ?? prev?.nextFireAt) as string | null | undefined,
    detail: stringOr(update.human_schedule ?? update.humanSchedule) ?? undefined,
  });
}

/** N-sched-d. */
export function applyScheduledTaskDeleted(params: Record<string, unknown>): void {
  const update = activityPayload(params);
  const taskId = String(update.task_id ?? update.taskId ?? "");
  if (taskId) useActivityStore.getState().removeSchedule(taskId);
}

/** N-mon: attach last monitor line to the task row. */
export function applyMonitorEvent(params: Record<string, unknown>): void {
  const update = activityPayload(params);
  const taskId = String(update.task_id ?? update.taskId ?? "");
  if (!taskId) return;
  const prev = useActivityStore.getState().tasks[taskId];
  const description = stringOr(update.description);
  const eventText = stringOr(update.event_text ?? update.eventText);
  useActivityStore.getState().upsertTask({
    id: taskId,
    kind: "task",
    name: description ?? prev?.name ?? taskId,
    status: prev?.status ?? "running",
    startedAt: prev?.startedAt ?? Date.now(),
    detail: eventText ?? prev?.detail,
    isMonitor: true,
  });
}

/** U-sub-s / U-sub-p / U-sub-f — sessionUpdate tags; no transcript spam. */
export function applySubagentSessionUpdate(raw: Record<string, unknown>): void {
  const kind = String(raw.sessionUpdate ?? "");
  const id = String(raw.subagent_id ?? raw.subagentId ?? "");
  if (!id) return;
  const prev = useActivityStore.getState().subagents[id];
  if (kind === "subagent_spawned") {
    useActivityStore.getState().upsertSubagent({
      id,
      kind: "subagent",
      name: stringOr(raw.description) ?? stringOr(raw.subagent_type ?? raw.subagentType) ?? id,
      status: "running",
      startedAt: Date.now(),
      detail: stringOr(raw.subagent_type ?? raw.subagentType) ?? undefined,
    });
    return;
  }
  if (kind === "subagent_progress") {
    useActivityStore.getState().upsertSubagent({
      id,
      kind: "subagent",
      name: prev?.name ?? id,
      status: "running",
      startedAt: prev?.startedAt ?? Date.now() - (numberOr(raw.duration_ms ?? raw.durationMs) ?? 0),
      detail: progressDetail(raw) ?? prev?.detail,
    });
    return;
  }
  if (kind === "subagent_finished") {
    useActivityStore.getState().upsertSubagent({
      id,
      kind: "subagent",
      name: prev?.name ?? id,
      status: stringOr(raw.status) ?? "completed",
      startedAt: prev?.startedAt ?? Date.now() - (numberOr(raw.duration_ms ?? raw.durationMs) ?? 0),
      endedAt: Date.now(),
      detail: stringOr(raw.error) ?? prev?.detail,
    });
  }
}

/** U-wf: `workflow_updated`. */
export function applyWorkflowUpdated(raw: Record<string, unknown>): void {
  const id = String(raw.run_id ?? raw.runId ?? "");
  if (!id) return;
  const prev = useActivityStore.getState().workflows[id];
  useActivityStore.getState().upsertWorkflow({
    id,
    kind: "workflow",
    name: stringOr(raw.name) ?? prev?.name ?? id,
    status: stringOr(raw.status) ?? "active",
    startedAt: prev?.startedAt ?? Date.now() - (numberOr(raw.elapsed_ms ?? raw.elapsedMs) ?? 0),
    detail: stringOr(raw.current_phase ?? raw.currentPhase ?? raw.objective) ?? prev?.detail,
    endedAt: isLive(stringOr(raw.status) ?? "active") ? undefined : Date.now(),
  });
}

function fromTaskList(task: TaskListItem): ActivityItem {
  return {
    id: task.taskId,
    kind: "task",
    name: task.description ?? task.displayCommand ?? task.command ?? task.taskId,
    status: task.completed ? "completed" : "running",
    startedAt: task.startedAt ?? Date.now(),
    endedAt: task.completed ? Date.now() : undefined,
    detail: task.command,
    isMonitor: task.kind === "monitor",
  };
}

function fromSubagentList(sub: SubagentListItem): ActivityItem {
  return {
    id: sub.subagentId,
    kind: "subagent",
    name: sub.description || sub.subagentType || sub.subagentId,
    status: sub.status ?? "running",
    startedAt: sub.startedAtEpochMs ?? Date.now() - (sub.durationMs ?? 0),
    detail: sub.subagentType,
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
  };
}

function terminalStatus(current: string, fallback: string): string {
  return isLive(current) ? fallback : current;
}

function progressDetail(raw: Record<string, unknown>): string | undefined {
  const turns = numberOr(raw.turn_count ?? raw.turnCount);
  const tools = numberOr(raw.tool_call_count ?? raw.toolCallCount);
  const parts = [
    turns !== null ? `${turns} turn${turns === 1 ? "" : "s"}` : null,
    tools !== null ? `${tools} tool${tools === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
