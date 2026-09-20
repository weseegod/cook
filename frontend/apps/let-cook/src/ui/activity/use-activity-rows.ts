/**
 * Row selectors as hooks. The store keeps four maps, so a component that needs the sorted list
 * subscribes to them and re-derives with `useMemo` — selecting a freshly built array from the
 * store would re-render forever (zustand compares snapshots by identity).
 */
import { useMemo } from "react";
import {
  activityRows,
  conversationRows,
  useActivityStore,
  type ActivityItem,
  type ActivityRowsSource,
} from "../../state/activity";
import { useSessionStore, type TranscriptState } from "../../state/session";

function useRowMaps(): ActivityRowsSource {
  const tasks = useActivityStore((state) => state.tasks);
  const subagents = useActivityStore((state) => state.subagents);
  const schedules = useActivityStore((state) => state.schedules);
  const workflows = useActivityStore((state) => state.workflows);
  return useMemo(() => ({ tasks, subagents, schedules, workflows }), [tasks, subagents, schedules, workflows]);
}

/** Every row in the workspace — the Tools panel's Activity tab. */
export function useActivityRows(): ActivityItem[] {
  const maps = useRowMaps();
  return useMemo(() => activityRows(maps), [maps]);
}

/** Only the rows the conversation on screen owns — the header chip and the tasks strip. */
export function useConversationRows(): ActivityItem[] {
  const sessionId = useSessionStore((state) => state.sessionId);
  const maps = useRowMaps();
  return useMemo(() => conversationRows(sessionId, maps), [sessionId, maps]);
}

/**
 * The row whose viewer is open, read back from the store so the dialog follows the job it is
 * showing (new stdout, a new ` · activity`, a terminal status) instead of freezing the snapshot
 * that was taken when it opened.
 */
export function useViewingRow(): ActivityItem | null {
  const viewing = useActivityStore((state) => state.viewing);
  const maps = useRowMaps();
  return useMemo(() => {
    if (!viewing) return null;
    const live = activityRows(maps).find((row) => row.kind === viewing.kind && row.id === viewing.id);
    return live ?? viewing;
  }, [viewing, maps]);
}

/** A subagent's own transcript, streamed under its child session id. */
export function useChildTranscript(childSessionId: string | undefined): TranscriptState | null {
  return useActivityStore((state) => (childSessionId ? state.childTranscripts[childSessionId] ?? null : null));
}
