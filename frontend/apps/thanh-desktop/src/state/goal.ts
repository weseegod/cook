/**
 * Goal orchestration state, copied from the TUI's goal surfaces.
 *
 * The shell ships goal state as an `x.ai/session_notification` extension update
 * (`sessionUpdate: "goal_updated"`), not as an ACP `session/update`:
 * `xai-grok-shell/src/extensions/notification.rs::SessionUpdate::GoalUpdated`. The pager's half of
 * that contract — status/phase parsing, chip labels, live elapsed and token accounting, the
 * cleared-id guard, and the one-shot completion marker — lives in
 * `xai-grok-pager/src/app/agent.rs::GoalDisplayState` and
 * `xai-grok-pager/src/app/acp_handler/session_notification.rs`.
 */
import { formatTimeAgo } from "../ui/chat/format-duration";

/** `GoalDisplayStatus`; the six paused variants encode the cause of the pause directly. */
export type GoalStatus =
  | "active"
  | "user_paused"
  | "back_off_paused"
  | "no_progress_paused"
  | "infra_paused"
  | "failed"
  | "interrupted"
  | "blocked"
  | "budget_limited"
  | "complete";

export type GoalPhase = "idle" | "planning" | "executing";

export interface GoalState {
  goalId: string;
  objective: string;
  status: GoalStatus;
  phase: GoalPhase;
  tokenBudget: number | null;
  tokensUsed: number;
  elapsedMs: number;
  /** Local clock when this snapshot landed, so the elapsed timer ticks between notifications. */
  receivedAt: number;
  /** Monotonic floor: a later notification whose base is below what we already extrapolated must not tick the timer backward. */
  elapsedFloorMs: number;
  tokenBaseline: number;
  finishedSubagentTokens: number;
  liveSubagentTokens: number | null;
  liveTokensByModel: Array<[string, number]>;
  liveContextPct: number | null;
  liveTurnCount: number | null;
  liveToolCallCount: number | null;
  currentSubagentRole: string | null;
  totalWorkerRounds: number;
  totalVerifyRounds: number;
  verifyingCompletion: boolean;
  planning: boolean;
  classifierRunsAttempted: number | null;
  classifierMaxRuns: number | null;
  lastClassifierVerdict: string | null;
  lastClassifierDetailsPath: string | null;
  lastEvent: string | null;
  lastEventDetail: string | null;
  lastEventTimestamp: string | null;
  pauseMessage: string | null;
}

const PAUSED_STATUSES: readonly GoalStatus[] = [
  "user_paused",
  "back_off_paused",
  "no_progress_paused",
  "infra_paused",
  "blocked",
];

/**
 * `GoalDisplayStatus::parse`. An uninterpretable status reads as a resumable pause (no spinner, no
 * live timer) rather than a self-driving `active` goal, and legacy `"paused"` maps to user-paused.
 */
export function parseGoalStatus(raw: string): GoalStatus {
  switch (raw) {
    case "active":
      return "active";
    case "user_paused":
    case "paused":
      return "user_paused";
    case "back_off_paused":
      return "back_off_paused";
    case "no_progress_paused":
      return "no_progress_paused";
    case "infra_paused":
      return "infra_paused";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "blocked":
      return "blocked";
    case "budget_limited":
      return "budget_limited";
    case "complete":
      return "complete";
    default:
      return "user_paused";
  }
}

/** `GoalDisplayPhase::parse`. */
export function parseGoalPhase(raw: string): GoalPhase {
  if (raw === "planning") return "planning";
  if (raw === "executing") return "executing";
  return "idle";
}

/** `GoalDisplayStatus::pause_label`; empty for the variants that render through their own label. */
export function goalPauseLabel(status: GoalStatus): string {
  switch (status) {
    case "user_paused":
      return "Paused";
    case "back_off_paused":
      return "Paused (back-off)";
    case "no_progress_paused":
      return "Paused (no progress)";
    case "infra_paused":
      return "Paused (error)";
    case "blocked":
      return "Paused (verification blocked)";
    default:
      return "";
  }
}

/** `GoalDisplayStatus::is_paused`: the cause-agnostic check behind the `/goal resume` hint. */
export function isPausedGoal(status: GoalStatus): boolean {
  return PAUSED_STATUSES.includes(status);
}

/** `agent_status::classifier_attempts_label`; empty until a run is reserved, so the chip reads `Verifying`, not `Verifying (0/0)`. */
export function classifierAttemptsLabel(goal: GoalState): string {
  const attempt = goal.classifierRunsAttempted ?? 0;
  const max = goal.classifierMaxRuns ?? 0;
  return attempt === 0 && max === 0 ? "" : `${attempt}/${max}`;
}

/** `agent_status::active_phase_label`: the transient verifying overlay wins, then planning, then the steady-state phase. */
export function activePhaseLabel(goal: GoalState): string {
  if (goal.verifyingCompletion) {
    const attempts = classifierAttemptsLabel(goal);
    return attempts ? `Verifying (${attempts})` : "Verifying";
  }
  if (goal.planning) return "Planning";
  if (goal.phase === "planning") return "Planning";
  if (goal.phase === "executing") return "Executing";
  return "Idle";
}

/** `agent_status::goal_phase_label` — the chip label. */
export function goalChipLabel(goal: GoalState): string {
  if (isPausedGoal(goal.status)) return goalPauseLabel(goal.status);
  switch (goal.status) {
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "budget_limited":
      return "Budget";
    case "complete":
      return "Done";
    default:
      return activePhaseLabel(goal);
  }
}

/** `views/goal_detail.rs::status_label` — the detail surface's status row. */
export function goalDetailStatusLabel(goal: GoalState): string {
  if (isPausedGoal(goal.status)) return goalPauseLabel(goal.status);
  switch (goal.status) {
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "budget_limited":
      return "Budget Limited";
    case "complete":
      return "Complete";
    default:
      return "Active";
  }
}

/**
 * `GoalDisplayState::live_elapsed_ms`: an active goal's timer keeps ticking between notifications;
 * every other status shows only what the shell last reported, and the floor keeps it monotonic.
 */
export function goalLiveElapsedMs(goal: GoalState, now = Date.now()): number {
  const live = goal.status === "active" ? goal.elapsedMs + Math.max(0, now - goal.receivedAt) : goal.elapsedMs;
  return Math.max(live, goal.elapsedFloorMs);
}

/**
 * `GoalDisplayState::live_tokens_used`. `activeSubagentTokens` stands in for the pager's tracker of
 * standalone subagents; the wire's own live window is the closest thing this client has.
 */
export function goalLiveTokensUsed(
  goal: GoalState,
  contextUsed: number | null,
  activeSubagentTokens = goal.liveSubagentTokens ?? 0,
): number {
  if (goal.status !== "active") return goal.tokensUsed;
  const parentDelta = contextUsed === null
    ? goal.tokensUsed
    : Math.max(0, contextUsed - goal.tokenBaseline);
  const candidate = parentDelta + goal.finishedSubagentTokens + activeSubagentTokens;
  return Math.max(candidate, goal.tokensUsed);
}

export interface GoalSlice {
  goal: GoalState | null;
  /** Goal id of the last cleared goal: a late in-flight update for it must not resurrect the chip. */
  clearedGoalId: string | null;
}

export const emptyGoalSlice: GoalSlice = { goal: null, clearedGoalId: null };

export interface GoalReduction {
  slice: GoalSlice;
  /** Set once, on the transition into `complete`: the elapsed time for the `Goal complete in …` row. */
  completedElapsedMs: number | null;
}

/**
 * `session_notification.rs::GoalUpdated`. Stores the snapshot, drops updates for a cleared goal, and
 * reports the one transition that writes a transcript row.
 */
export function reduceGoalUpdate(
  slice: GoalSlice,
  raw: Record<string, unknown>,
  now = Date.now(),
): GoalReduction {
  const goalId = stringOr(raw.goal_id) ?? "";
  const status = stringOr(raw.status) ?? "";

  if (status === "cleared") {
    // The cleared event itself carries an empty id, so the id to guard comes from the state it drops.
    return {
      slice: { goal: null, clearedGoalId: slice.goal?.goalId ?? slice.clearedGoalId },
      completedElapsedMs: null,
    };
  }
  if (slice.clearedGoalId !== null && slice.clearedGoalId === goalId) {
    return { slice, completedElapsedMs: null };
  }

  const nextStatus = parseGoalStatus(status);
  const previous = slice.goal?.goalId === goalId ? slice.goal : null;
  const elapsedFloorMs = Math.max(previous ? goalLiveElapsedMs(previous, now) : 0, numberOr(raw.elapsed_ms) ?? 0);
  const completedElapsedMs =
    nextStatus === "complete" && previous?.status !== "complete" ? elapsedFloorMs : null;

  return {
    slice: {
      clearedGoalId: slice.clearedGoalId,
      goal: {
        goalId,
        objective: stringOr(raw.objective) ?? "",
        status: nextStatus,
        phase: parseGoalPhase(stringOr(raw.phase) ?? ""),
        tokenBudget: numberOr(raw.token_budget),
        tokensUsed: numberOr(raw.tokens_used) ?? 0,
        elapsedMs: numberOr(raw.elapsed_ms) ?? 0,
        receivedAt: now,
        elapsedFloorMs,
        tokenBaseline: numberOr(raw.token_baseline) ?? 0,
        finishedSubagentTokens: numberOr(raw.finished_subagent_tokens) ?? 0,
        liveSubagentTokens: numberOr(raw.live_subagent_tokens),
        liveTokensByModel: tokenBreakdown(raw.live_tokens_by_model),
        liveContextPct: numberOr(raw.live_context_pct),
        liveTurnCount: numberOr(raw.live_turn_count),
        liveToolCallCount: numberOr(raw.live_tool_call_count),
        currentSubagentRole: stringOr(raw.current_subagent_role),
        totalWorkerRounds: numberOr(raw.total_worker_rounds) ?? 0,
        totalVerifyRounds: numberOr(raw.total_verify_rounds) ?? 0,
        verifyingCompletion: raw.verifying_completion === true,
        planning: raw.planning === true,
        classifierRunsAttempted: numberOr(raw.classifier_runs_attempted),
        classifierMaxRuns: numberOr(raw.classifier_max_runs),
        lastClassifierVerdict: stringOr(raw.last_classifier_verdict),
        lastClassifierDetailsPath: stringOr(raw.last_classifier_details_path),
        lastEvent: stringOr(raw.last_event),
        lastEventDetail: stringOr(raw.last_event_detail),
        lastEventTimestamp: stringOr(raw.last_event_timestamp),
        pauseMessage: stringOr(raw.pause_message),
      },
    },
    completedElapsedMs,
  };
}

/** `views/goal_detail.rs::humanize_goal_event`, including its `{n}m`/`{n}h` coarse timestamps. */
export function humanizeGoalEvent(event: string, detail: string | null): string {
  const phrase = detail === null ? null : detail.replace(/_/g, " ");
  switch (event) {
    case "goal_created":
      return "Goal created";
    case "planning_started":
      return "Planning started";
    case "planning_completed":
      return "Planning completed";
    case "planning_failed":
      return "Planning failed";
    case "worker_started":
      return "Worker started";
    case "worker_completed":
      return "Worker completed";
    case "worker_failed":
      return "Worker failed";
    case "context_rotated":
      return "Context rotated";
    case "goal_paused":
      // A plain user pause has no extra cause worth showing.
      return phrase && phrase !== "user" ? `Paused: ${phrase}` : "Paused";
    case "goal_resumed":
      return "Resumed";
    case "goal_completed":
      return "Completed";
    case "goal_cleared":
      return "Cleared";
    case "budget_exceeded":
      return "Budget exceeded";
    case "premature_stop_detected":
      return phrase ? `Stopped early: ${phrase}` : "Stopped early";
    default: {
      const words = event.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/** `views/goal_detail.rs::classifier_verdict_label`. */
export function classifierVerdictLabel(verdict: string | null): string {
  if (verdict === "achieved") return "Achieved";
  if (verdict === "not_achieved") return "Not Achieved";
  return "Not yet evaluated";
}

/** True when the goal carries at least one completion-classifier signal (`has_classifier_activity`). */
export function hasClassifierActivity(goal: GoalState): boolean {
  return (
    goal.classifierRunsAttempted !== null ||
    goal.classifierMaxRuns !== null ||
    goal.lastClassifierVerdict !== null ||
    goal.lastClassifierDetailsPath !== null
  );
}

export function goalRounds(goal: GoalState): number {
  return goal.totalWorkerRounds + goal.totalVerifyRounds;
}

/**
 * `views/goal_detail.rs::humanize_event_timestamp`: a wire RFC3339 stamp as `2m ago`. An empty
 * stamp stays empty, and an unparseable one (legacy or non-RFC3339) passes through verbatim.
 */
export function humanizeGoalTimestamp(timestamp: string, now = Date.now()): string {
  if (!timestamp) return "";
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  const ago = formatTimeAgo(now - parsed);
  return ago === "just now" ? ago : `${ago} ago`;
}

function tokenBreakdown(value: unknown): Array<[string, number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const [model, tokens] = entry as [unknown, unknown];
    return typeof model === "string" && typeof tokens === "number" ? [[model, tokens] as [string, number]] : [];
  });
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
