import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../../state/session";
import {
  activePhaseLabel,
  classifierAttemptsLabel,
  classifierVerdictLabel,
  goalDetailStatusLabel,
  goalLiveElapsedMs,
  goalLiveTokensUsed,
  goalRounds,
  hasClassifierActivity,
  humanizeGoalEvent,
  humanizeGoalTimestamp,
  isPausedGoal,
  type GoalState,
} from "../../state/goal";
import { Dialog } from "../components/dialog";
import { formatElapsedSeconds, formatTokensCompact } from "./format-duration";
import { PlanChecklist } from "./plan-list";

/** `goal_detail.rs` caps: todo rows and per-model token rows. */
const MAX_TODO_DISPLAY = 15;
const MAX_MODEL_DISPLAY = 6;

/**
 * Go a goal's detail surface (`views/goal_detail.rs`): status, token budget, the plan's progress,
 * the active subagent, the completion reviewer's verdict, and the last event.
 */
export function GoalDetail({ goal, onClose }: { goal: GoalState; onClose: () => void }) {
  const blocks = useSessionStore((state) => state.blocks);
  const usage = useSessionStore((state) => state.usage);
  const [now, setNow] = useState(() => Date.now());

  const active = goal.status === "active";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  // The TUI reads its todo pane here; both come from the same ACP Plan updates.
  const entries = useMemo(() => {
    const plan = [...blocks].reverse().find((block) => block.type === "plan");
    return plan?.type === "plan" ? plan.entries : [];
  }, [blocks]);

  const contextUsed = typeof usage?.used === "number" ? usage.used : null;
  const tokens = goalLiveTokensUsed(goal, contextUsed);
  const elapsed = formatElapsedSeconds(goalLiveElapsedMs(goal, now));
  const budget = goal.tokenBudget !== null && goal.tokenBudget > 0 ? goal.tokenBudget : null;
  const pct = budget === null ? 0 : Math.min(1, tokens / budget);
  const statusLabel = goalDetailStatusLabel(goal);
  const paused = isPausedGoal(goal.status);
  const failed = goal.status === "failed" || goal.status === "interrupted";
  const rounds = goalRounds(goal);
  const modelRows = goal.liveTokensByModel.slice(0, MAX_MODEL_DISPLAY);
  const verdict = classifierVerdictLabel(goal.lastClassifierVerdict);

  return (
    <Dialog
      title={goal.objective.trim() || "Active Goal"}
      size="wide"
      onClose={onClose}
      description={
        <span className="goal-detail-status" data-testid="goal-detail-status">
          <span className={`goal-detail-status-label goal-tone-${tone(goal)}`}>{statusLabel}</span>
          {active && ` · ${activePhaseLabel(goal)}`}
        </span>
      }
    >
      <div className="goal-detail" data-testid="goal-detail">
        {(paused || failed) && (
          <p className="goal-detail-hint">
            {paused
              ? `Status: ${statusLabel}. Type /goal resume to continue`
              : `Status: ${statusLabel}. Type /goal clear, then start a new goal`}
          </p>
        )}
        {(paused || failed) && goal.pauseMessage && (
          <p className="goal-detail-reason">Reason: {goal.pauseMessage}</p>
        )}

        <div className="goal-detail-metrics">
          {budget === null
            ? <span>Tokens: {formatTokensCompact(tokens)} tokens</span>
            : <span>Budget: {formatTokensCompact(tokens)} / {formatTokensCompact(budget)} tokens{` (${Math.round(pct * 100)}%)`}</span>}
          <span>Elapsed: {elapsed}</span>
        </div>
        {budget !== null && (
          <div className="goal-budget" role="img" aria-label={`${Math.round(pct * 100)}% of the token budget`}>
            <span className="goal-budget-fill" data-level={pct > 0.8 ? "high" : pct >= 0.5 ? "medium" : "low"} style={{ width: `${pct * 100}%` }} />
          </div>
        )}

        {entries.length === 0 ? (
          <p className="goal-detail-empty">No progress items yet</p>
        ) : (
          <>
            <h3>Progress:</h3>
            <PlanChecklist entries={entries.slice(0, MAX_TODO_DISPLAY)} className="goal-detail-progress" />
          </>
        )}

        {goal.currentSubagentRole && (
          <section className="goal-detail-subagent">
            <h3>Active Subagent: <strong>{goal.currentSubagentRole}</strong>{rounds > 0 && <span className="goal-detail-muted"> (round {rounds})</span>}</h3>
            <SubagentMetrics goal={goal} />
            {modelRows.length > 1 && (
              <ul className="goal-detail-models">
                {modelRows.map(([model, tokens]) => <li key={model}><span>{model}</span><span>{formatTokensCompact(tokens)}</span></li>)}
                {goal.liveTokensByModel.length > MAX_MODEL_DISPLAY && <li className="goal-detail-muted">+{goal.liveTokensByModel.length - MAX_MODEL_DISPLAY} more</li>}
              </ul>
            )}
          </section>
        )}

        {hasClassifierActivity(goal) && (
          <section className="goal-detail-review">
            <h3>Completion review:</h3>
            <p><span className="goal-detail-muted">Last verdict: </span>{verdict}</p>
            <p><span className="goal-detail-muted">Attempts: </span>{classifierAttemptsLabel(goal) || "-"}</p>
            {/* The TUI marks a path "(unavailable)" after stat-ing it; the renderer cannot reach the agent's filesystem. */}
            <p><span className="goal-detail-muted">Details: </span>{goal.lastClassifierDetailsPath ?? "-"}</p>
          </section>
        )}

        {goal.lastEvent && (
          <section className="goal-detail-history">
            <h3>Recent History:</h3>
            <p>
              <span className="goal-detail-muted">{humanizeGoalTimestamp(goal.lastEventTimestamp ?? "", now)}</span>
              {"  "}
              {humanizeGoalEvent(goal.lastEvent, goal.lastEventDetail)}
            </p>
          </section>
        )}
      </div>
      <p className="goal-detail-footer">
        {failed ? "Esc: close  /goal clear, then start a new goal" : "Esc: close  /goal resume | pause | status | clear"}
      </p>
    </Dialog>
  );
}

function SubagentMetrics({ goal }: { goal: GoalState }) {
  const parts: string[] = [];
  if (goal.liveSubagentTokens !== null) parts.push(`Tokens: ${formatTokensCompact(goal.liveSubagentTokens)}`);
  if (goal.liveContextPct !== null) parts.push(`Context: ${goal.liveContextPct}%`);
  if (goal.liveTurnCount !== null) parts.push(`Turns: ${goal.liveTurnCount}`);
  if (goal.liveToolCallCount !== null) parts.push(`Tools: ${goal.liveToolCallCount}`);
  return parts.length === 0 ? null : <p className="goal-detail-muted">{parts.join("  ")}</p>;
}

function tone(goal: GoalState): string {
  if (isPausedGoal(goal.status)) return "paused";
  if (goal.status === "failed" || goal.status === "interrupted") return "failed";
  if (goal.status === "complete") return "complete";
  return "active";
}
