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
import { useSessionStore } from "../../state/session";

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
