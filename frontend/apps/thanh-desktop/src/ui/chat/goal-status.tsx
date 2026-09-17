import { useEffect, useState } from "react";
import { useSessionStore } from "../../state/session";
import { goalChipLabel, goalLiveElapsedMs, goalLiveTokensUsed, isPausedGoal } from "../../state/goal";
import { formatElapsedCoarse, formatTokensCompact } from "./format-duration";
import { GoalDetail } from "./goal-detail";

/** 30 fps tick, `SPINNER_DIVISOR` dwell of four — the TUI's `goal_status_line` spinner. */
const TICK_MS = 1000 / 30;
const SPINNER_DIVISOR = 4;
const DOT_FRAMES = ["⋅", ":", "⸬", "⁙", "⋅", ":", "⸬", "⁙"];

/**
 * The header goal chip (`views/agent_status.rs::goal_status_line`):
 * `[Goal: {label}]  {tokens} tokens  {elapsed}`, spinner while the goal runs, warning tone when
 * paused and error tone when failed. Clicking opens the detail surface the TUI binds to the chip.
 */
export function GoalStatus() {
  const goal = useSessionStore((state) => state.goal);
  const usage = useSessionStore((state) => state.usage);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const active = goal?.status === "active";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!goal) return null;

  const contextUsed = typeof usage?.used === "number" ? usage.used : null;
  const tokens = formatTokensCompact(goalLiveTokensUsed(goal, contextUsed));
  const budget = goal.tokenBudget !== null && goal.tokenBudget > 0
    ? `${tokens}/${formatTokensCompact(goal.tokenBudget)} tokens`
    : `${tokens} tokens`;
  const elapsed = formatElapsedCoarse(goalLiveElapsedMs(goal));
  const tone = isPausedGoal(goal.status)
    ? "paused"
    : goal.status === "failed" || goal.status === "interrupted"
      ? "failed"
      : goal.status === "complete"
        ? "complete"
        : "active";

  return (
    <>
      <button
        type="button"
        className={`goal-chip goal-chip-${tone}`}
        data-testid="goal-chip"
        title={`${goal.objective}\nOpen goal detail`}
        onClick={() => setOpen(true)}
      >
        <span className="goal-chip-label">
          {active && <span className="goal-chip-spinner" aria-hidden="true">{DOT_FRAMES[Math.floor(tick / SPINNER_DIVISOR) % DOT_FRAMES.length]}</span>}
          Goal: {goalChipLabel(goal)}
        </span>
        <span className="goal-chip-meta">{budget} · {elapsed}</span>
      </button>
      {open && <GoalDetail goal={goal} onClose={() => setOpen(false)} />}
    </>
  );
}
