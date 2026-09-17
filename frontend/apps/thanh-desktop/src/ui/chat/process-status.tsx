import { useMemo } from "react";
import { useSessionStore } from "../../state/session";
import { activityParts, deriveActivity, type TurnActivity } from "./turn-activity";

/** Compact process state that occupies the app chrome instead of a chat title. */
export function ProcessStatus() {
  const blocks = useSessionStore((state) => state.blocks);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const planMode = useSessionStore((state) => state.planMode);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const activity = useMemo(() => deriveActivity(blocks), [blocks]);
  const current: TurnActivity | null = pendingQuestion?.kind === "question"
    ? { kind: "ask", detail: pendingQuestion.title }
    : activity ?? (turnRunning ? { kind: "waiting", reason: { kind: "model" } } : null);
  const waitingOnUser = Boolean(pendingQuestion || pendingPermission);
  const hasPlan = blocks.some((block) => block.type === "plan");
  const detail = current ? activityParts(current).text : null;
  const label = waitingOnUser ? "Waiting on you" : turnRunning ? "Processing" : planMode ? "Plan" : "Ready";

  return (
    <div className={`process-status process-status-${turnRunning ? "running" : "idle"}`} data-testid="process-status" role="status" aria-live="polite">
      <span className={`process-status-dot${waitingOnUser ? " waiting" : turnRunning ? " running" : ""}`} aria-hidden="true" />
      <strong>{label}</strong>
      {planMode && label !== "Plan" && <span className="process-status-chip">Plan</span>}
      {hasPlan && !planMode && <span className="process-status-chip">Plan ready</span>}
      {turnRunning && detail && detail !== "Waiting for response…" && <span className="process-status-detail" title={detail}>{detail}</span>}
    </div>
  );
}
