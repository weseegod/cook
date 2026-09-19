/**
 * Compact activity panel (map §10 TK-*): one row per task/subagent/schedule/workflow.
 */
import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  isLive,
  useActivityStore,
  type ActivityItem,
} from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { ActivityList } from "./activity-list";
import { useNowTick } from "./activity-row";
import { useActivityRows } from "./use-activity-rows";

export function ActivityPanel() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const rows = useActivityRows();
  const lastError = useActivityStore((state) => state.lastError);
  const refreshFromAgent = useActivityStore((state) => state.refreshFromAgent);
  const killActivity = useActivityStore((state) => state.killActivity);
  const setViewing = useActivityStore((state) => state.setViewing);
  const now = useNowTick();
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    void refreshFromAgent(sessionId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshFromAgent]);

  async function refresh() {
    if (!sessionId) return;
    setLoading(true);
    try {
      await refreshFromAgent(sessionId);
    } finally {
      setLoading(false);
    }
  }

  async function onKill(item: ActivityItem) {
    if (!sessionId || !isLive(item.status)) return;
    setBusyId(item.id);
    try {
      await killActivity(sessionId, item);
    } catch {
      // lastError is set on the store
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="activity-view" data-testid="activity-view">
      <div className="utility-view-actions">
        <span><Activity size={13} /> Background activity</span>
        <button
          type="button"
          className="text-button utility-refresh"
          onClick={() => void refresh()}
          disabled={loading || !sessionId}
          aria-label="Refresh activity"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {lastError && <div className="utility-state utility-state-error" role="alert">{lastError}</div>}
      {!sessionId && <div className="utility-state">Connect a session to list tasks.</div>}
      {sessionId && loading && rows.length === 0 && <div className="utility-state" role="status">Loading…</div>}
      {sessionId && !loading && rows.length === 0 && <div className="utility-state">No background tasks or subagents.</div>}
      {rows.length > 0 && (
        <ActivityList
          rows={rows}
          now={now}
          busyId={busyId}
          onKill={(item) => void onKill(item)}
          onOpen={setViewing}
          testIdPrefix="activity"
          label="Activity"
        />
      )}
    </section>
  );
}
