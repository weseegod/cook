import { rowForChildSession, useActivityStore } from "../../state/activity";
import { emptyTranscriptCursor, reduceTranscript, useSessionStore } from "../../state/session";
import { activityFromUpdate, phaseKey } from "../../ui/chat/turn-activity";
import { taskActivityLabel } from "../../ui/chat/task-activity";
import { readLocal, writeLocal } from "../../ui/storage";

/**
 * Record (or forget) a session's in-flight turn. The conversation list paints a live row from
 * this map, so a turn stays visible — with its last reported phase — after the user opens a
 * different conversation.
 *
 * A session stays busy while at least one `promptId` is registered. `startedAt` is the moment the
 * session went from idle to busy and is not overwritten by later prompts. Passing `startedAt: null`
 * without a `promptId` clears the whole entry (workspace switch, or a bare `prompt_complete`).
 */
export function trackWorking(sessionId: string, startedAt: number | null, promptId?: string): void {
  useSessionStore.setState((state) => {
    const working = state.workingSessions;
    const existing = working[sessionId];

    if (startedAt === null) {
      if (promptId === undefined) {
        if (!existing) return state;
        const next = { ...working };
        delete next[sessionId];
        return { workingSessions: next };
      }
      if (!existing) return state;
      if (!existing.promptIds.includes(promptId)) return state;
      const promptIds = existing.promptIds.filter((id) => id !== promptId);
      if (promptIds.length === 0) {
        const next = { ...working };
        delete next[sessionId];
        return { workingSessions: next };
      }
      return { workingSessions: { ...working, [sessionId]: { ...existing, promptIds } } };
    }

    if (existing) {
      if (promptId === undefined || existing.promptIds.includes(promptId)) return state;
      return {
        workingSessions: {
          ...working,
          [sessionId]: { ...existing, promptIds: [...existing.promptIds, promptId] },
        },
      };
    }

    return {
      workingSessions: {
        ...working,
        [sessionId]: {
          startedAt,
          activity: null,
          promptIds: promptId === undefined ? [] : [promptId],
        },
      },
    };
  });
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
  const activity = activityFromUpdate(update);
  if (!activity) return;
  useSessionStore.setState((state) => {
    const turn = state.workingSessions[sessionId];
    // Do not recreate a row that was already cleared — a late update after the last prompt ends.
    if (!turn) return state;
    if (phaseKey(activity) === phaseKey(turn.activity)) return state;
    return {
      workingSessions: {
        ...state.workingSessions,
        [sessionId]: { ...turn, activity },
      },
    };
  });
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
