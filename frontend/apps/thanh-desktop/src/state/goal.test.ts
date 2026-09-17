import { describe, expect, it } from "vitest";
import {
  activePhaseLabel,
  classifierAttemptsLabel,
  classifierVerdictLabel,
  goalChipLabel,
  goalDetailStatusLabel,
  goalLiveElapsedMs,
  goalLiveTokensUsed,
  humanizeGoalEvent,
  humanizeGoalTimestamp,
  parseGoalPhase,
  parseGoalStatus,
  reduceGoalUpdate,
  emptyGoalSlice,
  type GoalSlice,
} from "./goal";

/** A `goal_updated` payload with the wire's required fields; callers override what they exercise. */
function update(overrides: Record<string, unknown> = {}) {
  return {
    sessionUpdate: "goal_updated",
    goal_id: "g-1",
    objective: "Ship the goal surface",
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_worker_rounds: 0,
    total_verify_rounds: 0,
    token_baseline: 0,
    finished_subagent_tokens: 0,
    ...overrides,
  };
}

function store(slice: GoalSlice, overrides: Record<string, unknown> = {}, now = 1_000) {
  return reduceGoalUpdate(slice, update(overrides), now);
}

describe("goal status parsing", () => {
  it("maps every wire status and fails safe to a resumable pause", () => {
    expect(parseGoalStatus("active")).toBe("active");
    expect(parseGoalStatus("user_paused")).toBe("user_paused");
    expect(parseGoalStatus("paused")).toBe("user_paused");
    expect(parseGoalStatus("back_off_paused")).toBe("back_off_paused");
    expect(parseGoalStatus("no_progress_paused")).toBe("no_progress_paused");
    expect(parseGoalStatus("infra_paused")).toBe("infra_paused");
    expect(parseGoalStatus("blocked")).toBe("blocked");
    expect(parseGoalStatus("failed")).toBe("failed");
    expect(parseGoalStatus("interrupted")).toBe("interrupted");
    expect(parseGoalStatus("budget_limited")).toBe("budget_limited");
    expect(parseGoalStatus("complete")).toBe("complete");
    expect(parseGoalStatus("doom_loop_paused")).toBe("user_paused");
  });

  it("parses phases and treats anything else as idle", () => {
    expect(parseGoalPhase("planning")).toBe("planning");
    expect(parseGoalPhase("executing")).toBe("executing");
    expect(parseGoalPhase("")).toBe("idle");
  });
});

describe("goal labels", () => {
  it("puts the verifying overlay above the phase and keeps the attempts suffix", () => {
    const verifying = store(emptyGoalSlice, { verifying_completion: true, classifier_runs_attempted: 1, classifier_max_runs: 3 }).slice.goal!;
    expect(activePhaseLabel(verifying)).toBe("Verifying (1/3)");
    expect(goalChipLabel(verifying)).toBe("Verifying (1/3)");
    // No run reserved yet: the chip must read `Verifying`, not `Verifying (0/0)`.
    const bare = store(emptyGoalSlice, { verifying_completion: true }).slice.goal!;
    expect(activePhaseLabel(bare)).toBe("Verifying");
    expect(classifierAttemptsLabel(bare)).toBe("");
  });

  it("labels the chip and the detail surface per status", () => {
    const paused = store(emptyGoalSlice, { status: "blocked" }).slice.goal!;
    expect(goalChipLabel(paused)).toBe("Paused (verification blocked)");
    expect(goalDetailStatusLabel(paused)).toBe("Paused (verification blocked)");
    const budget = store(emptyGoalSlice, { status: "budget_limited" }).slice.goal!;
    expect(goalChipLabel(budget)).toBe("Budget");
    expect(goalDetailStatusLabel(budget)).toBe("Budget Limited");
    const done = store(emptyGoalSlice, { status: "complete" }).slice.goal!;
    expect(goalChipLabel(done)).toBe("Done");
    expect(goalDetailStatusLabel(done)).toBe("Complete");
    expect(goalDetailStatusLabel(store(emptyGoalSlice).slice.goal!)).toBe("Active");
  });

  it("never shows raw wire vocabulary in the history row", () => {
    expect(humanizeGoalEvent("goal_paused", "doom_loop")).toBe("Paused: doom loop");
    expect(humanizeGoalEvent("goal_paused", "user")).toBe("Paused");
    expect(humanizeGoalEvent("premature_stop_detected", null)).toBe("Stopped early");
    expect(humanizeGoalEvent("worker_started", null)).toBe("Worker started");
    expect(humanizeGoalEvent("something_new", null)).toBe("Something new");
    expect(classifierVerdictLabel("achieved")).toBe("Achieved");
    expect(classifierVerdictLabel("not_achieved")).toBe("Not Achieved");
    expect(classifierVerdictLabel(null)).toBe("Not yet evaluated");
  });

  it("renders coarse relative timestamps and passes unparseable ones through", () => {
    const now = Date.parse("2026-09-17T12:00:00Z");
    expect(humanizeGoalTimestamp("", now)).toBe("");
    expect(humanizeGoalTimestamp("2026-09-17T11:59:30Z", now)).toBe("just now");
    expect(humanizeGoalTimestamp("2026-09-17T11:55:00Z", now)).toBe("5m ago");
    expect(humanizeGoalTimestamp("2026-09-17T09:00:00Z", now)).toBe("3h ago");
    expect(humanizeGoalTimestamp("later", now)).toBe("later");
  });
});

describe("goal live values", () => {
  it("ticks the elapsed timer only while the goal is active", () => {
    const active = store(emptyGoalSlice, { elapsed_ms: 5_000 }, 1_000).slice.goal!;
    expect(goalLiveElapsedMs(active, 4_000)).toBe(8_000);
    const paused = store(emptyGoalSlice, { status: "user_paused", elapsed_ms: 5_000 }, 1_000).slice.goal!;
    expect(goalLiveElapsedMs(paused, 4_000)).toBe(5_000);
  });

  it("keeps the elapsed timer monotonic when a notification's base lags behind", () => {
    const first = store(emptyGoalSlice, { elapsed_ms: 1_000 }, 1_000);
    const second = store(first.slice, { elapsed_ms: 1_200 }, 5_000);
    // The local clock already extrapolated to 5s; a wire base of 1.2s must not tick backward.
    expect(goalLiveElapsedMs(second.slice.goal!, 5_000)).toBe(5_000);
  });

  it("sums parent context, finished and live subagent tokens for an active goal", () => {
    const goal = store(emptyGoalSlice, {
      tokens_used: 1_000,
      token_baseline: 500,
      finished_subagent_tokens: 2_000,
      live_subagent_tokens: 300,
    }).slice.goal!;
    expect(goalLiveTokensUsed(goal, 1_500)).toBe(3_300);
    // Without a context reading the wire's own total stands, and the answer never undershoots it.
    expect(goalLiveTokensUsed(goal, null)).toBe(3_300);
    // A context reading below the goal's baseline contributes nothing, so the subagent work alone shows.
    expect(goalLiveTokensUsed(goal, 100)).toBe(2_300);
  });

  it("reports the shell's total unchanged for a finished goal", () => {
    const done = store(emptyGoalSlice, { status: "complete", tokens_used: 4_242 }).slice.goal!;
    expect(goalLiveTokensUsed(done, 90_000)).toBe(4_242);
  });
});

describe("reduceGoalUpdate", () => {
  it("stores the snapshot with parsed fields", () => {
    const { slice, completedElapsedMs } = store(emptyGoalSlice, {
      token_budget: 100_000,
      tokens_used: 25_000,
      elapsed_ms: 65_000,
      current_subagent_role: "worker",
      total_worker_rounds: 4,
      total_verify_rounds: 2,
      live_tokens_by_model: [["grok-4", 6_000], ["grok-3", 4_000], ["broken"]],
      live_context_pct: 35,
      last_event: "worker_completed",
      last_event_detail: "Core logic",
      last_event_timestamp: "2026-01-01T00:05:00Z",
      classifier_runs_attempted: 2,
      classifier_max_runs: 3,
      last_classifier_verdict: "not_achieved",
      last_classifier_details_path: "/tmp/details.md",
      planning: true,
    });
    expect(completedElapsedMs).toBeNull();
    expect(slice.goal).toMatchObject({
      goalId: "g-1",
      status: "active",
      phase: "executing",
      tokenBudget: 100_000,
      currentSubagentRole: "worker",
      totalWorkerRounds: 4,
      liveTokensByModel: [["grok-4", 6_000], ["grok-3", 4_000]],
      liveContextPct: 35,
      lastEvent: "worker_completed",
      classifierRunsAttempted: 2,
      lastClassifierVerdict: "not_achieved",
      planning: true,
      verifyingCompletion: false,
    });
  });

  it("drops optional fields that the wire omitted", () => {
    const goal = store(emptyGoalSlice).slice.goal!;
    expect(goal.tokenBudget).toBeNull();
    expect(goal.liveSubagentTokens).toBeNull();
    expect(goal.currentSubagentRole).toBeNull();
    expect(goal.lastEvent).toBeNull();
    expect(goal.classifierRunsAttempted).toBeNull();
  });

  it("clears the goal and guards against a late update for it", () => {
    const first = store(emptyGoalSlice, { elapsed_ms: 1_000 });
    expect(first.slice.goal).not.toBeNull();
    const cleared = reduceGoalUpdate(first.slice, update({ status: "cleared", goal_id: "" }), 2_000);
    expect(cleared.slice.goal).toBeNull();
    expect(cleared.slice.clearedGoalId).toBe("g-1");
    const late = store(cleared.slice, { elapsed_ms: 9_000 }, 3_000);
    expect(late.slice.goal).toBeNull();
    // A different goal is untouched by the guard.
    const next = store(cleared.slice, { goal_id: "g-2" }, 3_000);
    expect(next.slice.goal?.goalId).toBe("g-2");
  });

  it("reports the end-to-end marker once, on the transition into complete", () => {
    const first = store(emptyGoalSlice, { elapsed_ms: 1_000 }, 1_000);
    const done = store(first.slice, { status: "complete", elapsed_ms: 6_000 }, 20_000);
    // The marker is timed from the goal's own clock, floored at what the client already showed.
    expect(done.completedElapsedMs).toBe(20_000);
    const repeat = store(done.slice, { status: "complete", elapsed_ms: 21_000 }, 21_000);
    expect(repeat.completedElapsedMs).toBeNull();
  });

  it("reports a marker the first time a complete goal is seen, like the TUI's is_none_or check", () => {
    // The TUI treats "no prior state" as not-yet-complete, so a goal that finished while the client
    // was away still gets its end-to-end row.
    const { completedElapsedMs } = store(emptyGoalSlice, { status: "complete", elapsed_ms: 5_000 });
    expect(completedElapsedMs).toBe(5_000);
  });
});
