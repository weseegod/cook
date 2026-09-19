import { rowForChildSession, useActivityStore } from "../../state/activity";
import { emptyTranscriptCursor, reduceTranscript, useSessionStore } from "../../state/session";
import { activityFromUpdate, phaseKey } from "../../ui/chat/turn-activity";
import { taskActivityLabel } from "../../ui/chat/task-activity";
import { readLocal, writeLocal } from "../../ui/storage";

/**
 * Record (or forget) a session's in-flight turn. The conversation list paints a live row from
 * this map, so a turn stays visible — with its last reported phase — after the user opens a
 * different conversation.
 */
export function trackWorking(sessionId: string, startedAt: number | null): void {
  const working = { ...useSessionStore.getState().workingSessions };
  if (startedAt === null) delete working[sessionId];
  else working[sessionId] = { startedAt, activity: working[sessionId]?.activity ?? null };
  useSessionStore.getState().set({ workingSessions: working });
}

/**
 * Keep a backgrounded conversation's turn phase moving. `shouldApplyToActiveSession` drops the
 * updates of every other session, so this folds them into the list's snapshot instead.
 */
export function noteBackgroundActivity(
  params: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
): void {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (!sessionId || !update) return;
  const working = useSessionStore.getState().workingSessions;
  const turn = working[sessionId];
  if (!turn) return;
  const activity = activityFromUpdate(update);
  if (!activity || phaseKey(activity) === phaseKey(turn.activity)) return;
  useSessionStore.getState().set({ workingSessions: { ...working, [sessionId]: { ...turn, activity } } });
}

/**
 * A subagent runs its own ACP session, so its `session/update` traffic arrives under the child's
 * session id and is dropped from the parent transcript. Route it to the row it belongs to: the
 * ` · {activity}` suffix the tasks list paints, and the transcript its viewer reads
 * (`views/tasks_pane.rs`, `app/subagent.rs::format_activity_label`).
 */
export function routeChildUpdate(
  params: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
): void {
  if (!update) return;
  const childSessionId = typeof (params.sessionId ?? params.session_id) === "string"
    ? String(params.sessionId ?? params.session_id)
    : null;
  if (!childSessionId) return;
  const row = rowForChildSession(childSessionId);
  if (!row) return;
  const label = taskActivityLabel(activityFromUpdate(update));
  if (label) useActivityStore.getState().setActivityLabel(row.id, label);
  const store = useActivityStore.getState();
  const prev = store.childTranscripts[childSessionId] ?? { blocks: [], cursor: emptyTranscriptCursor() };
  store.setChildTranscript(childSessionId, reduceTranscript(prev, update));
}

export function shouldApplyToActiveSession(
  params: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
): boolean {
  const sessionId = typeof (params.sessionId ?? params.session_id) === "string"
    ? String(params.sessionId ?? params.session_id)
    : null;
  const activeSessionId = useSessionStore.getState().sessionId;
  if (!sessionId || !activeSessionId || sessionId === activeSessionId) return true;
  const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
  return kind === "subagent_spawned"
    || kind === "subagent_progress"
    || kind === "subagent_finished"
    || kind === "workflow_updated";
}

export function rememberWorkspace(cwd: string) {
  const previous = JSON.parse(readLocal("recentWorkspaces") ?? "[]") as string[];
  writeLocal("recentWorkspaces", JSON.stringify([cwd, ...previous.filter((item) => item !== cwd)].slice(0, 8)));
  writeLocal("lastWorkspace", cwd);
}
