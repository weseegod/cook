/**
 * Compact activity panel (map §10 TK-*): one row per task/subagent/schedule/workflow.
 */
import { Activity, LoaderCircle, RefreshCw, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  activityRows,
  isLive,
  useActivityStore,
  type ActivityItem,
} from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { formatDuration } from "../chat/format-duration";

export function ActivityPanel() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const tasks = useActivityStore((state) => state.tasks);
  const subagents = useActivityStore((state) => state.subagents);
  const schedules = useActivityStore((state) => state.schedules);
  const workflows = useActivityStore((state) => state.workflows);
  const rows = useMemo(
    () => activityRows({ tasks, subagents, schedules, workflows } as Parameters<typeof activityRows>[0]),
    [tasks, subagents, schedules, workflows],
  );
  const lastError = useActivityStore((state) => state.lastError);
  const refreshFromAgent = useActivityStore((state) => state.refreshFromAgent);
  const killActivity = useActivityStore((state) => state.killActivity);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

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
        <div className="activity-list" role="list" aria-label="Activity">
          {rows.map((item) => (
            <ActivityRow
              key={`${item.kind}:${item.id}`}
              item={item}
              now={now}
              busy={busyId === item.id}
              onKill={() => void onKill(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityRow({
  item,
  now,
  busy,
  onKill,
}: {
  item: ActivityItem;
  now: number;
  busy: boolean;
  onKill: () => void;
}) {
  const elapsed = Math.max(0, (item.endedAt ?? now) - item.startedAt);
  const live = isLive(item.status);
  return (
    <div className="activity-row" role="listitem" data-testid={`activity-row-${item.id}`} data-kind={item.kind} data-status={item.status}>
      <div className="activity-row-main">
        <span className="activity-kind">{kindLabel(item)}</span>
        <strong className="activity-name" title={item.name}>{item.name}</strong>
        <span className={`activity-status activity-status-${item.status.toLowerCase()}`}>{item.status}</span>
        <span className="activity-elapsed">{formatDuration(elapsed)}</span>
        {live && (
          <button
            type="button"
            className="icon-button activity-kill"
            onClick={onKill}
            disabled={busy}
            aria-label={`Stop ${item.name}`}
            title="Stop"
            data-testid={`activity-kill-${item.id}`}
          >
            {busy ? <LoaderCircle size={12} className="spin" /> : <Square size={11} />}
          </button>
        )}
        {!live && <span className="activity-kill-spacer" aria-hidden><X size={11} /></span>}
      </div>
      {(item.detail || item.humanSchedule) && (
        <div className="activity-row-detail">{item.humanSchedule ?? item.detail}</div>
      )}
    </div>
  );
}

function kindLabel(item: ActivityItem): string {
  if (item.isMonitor) return "Monitor";
  switch (item.kind) {
    case "task":
      return "Task";
    case "subagent":
      return "Agent";
    case "schedule":
      return "Loop";
    case "workflow":
      return "Flow";
    default:
      return "Item";
  }
}
