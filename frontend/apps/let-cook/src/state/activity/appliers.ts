import { activityPayload } from "../../acp/activity";
import { isLive } from "./status";
import { useActivityStore } from "./store";

/** Conversation an ext-notification envelope names, when it carries one. */
function envelopeSession(params: Record<string, unknown>): string | undefined {
  return stringOr(params.sessionId) ?? stringOr(params.session_id) ?? undefined;
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
    outputFile: stringOr(update.output_file ?? update.outputFile) ?? undefined,
    isMonitor: monitor,
    sessionId: envelopeSession(params),
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
    output: stringOr(snap.output) ?? undefined,
    outputFile: stringOr(snap.output_file ?? snap.outputFile) ?? undefined,
    truncated: snap.truncated === true,
    endedAt: Date.now(),
    sessionId: envelopeSession(params),
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
    sessionId: envelopeSession(params),
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
    sessionId: envelopeSession(params),
  });
}

/** U-sub-s / U-sub-p / U-sub-f — sessionUpdate tags; no transcript spam. */
export function applySubagentSessionUpdate(raw: Record<string, unknown>, sessionId?: string): void {
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
      // The child's own updates stream under its session id; without it the viewer has no feed.
      childSessionId: stringOr(raw.child_session_id ?? raw.childSessionId) ?? id,
      sessionId,
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
      sessionId,
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
      sessionId,
    });
  }
}

/** U-wf: `workflow_updated`. */
export function applyWorkflowUpdated(raw: Record<string, unknown>, sessionId?: string): void {
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
    sessionId,
  });
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
