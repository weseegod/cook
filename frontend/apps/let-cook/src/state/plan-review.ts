/**
 * The plan review surface: the plan body, its line-anchored comments, and the popup's state.
 *
 * The shell raises `x.ai/exit_plan_mode` with the whole plan body in `planContent` and the
 * episode's plan file in `planFilePath`. The pager's half of that contract — the
 * `<filename>` / `<filename> (empty)` title, the line comments, and the review footer's decision
 * bar — lives in `views/plan_approval_view.rs` and `views/file_search/line_viewer.rs`. ACP `Plan`
 * updates carry the todo entries only, never the body, so the request is the one source of the
 * prose.
 */

/** One review comment, anchored to 1-based plan lines as the TUI's `PlanComment.line_range` is. */
export interface PlanComment {
  id: number;
  /** `[lo, hiExclusive)` in 1-based source lines, exactly as the pager stores it. */
  lineRange: [number, number];
  text: string;
}

/** The shared focus state for the plan viewer and the live prompt widget. */
export type PlanFocus = "preview" | "prompt" | "commenting";

export interface PlanReview {
  /** The `planContent` the shell sent; `null` when it parked with no body. */
  body: string | null;
  /**
   * Basename of the episode's plan file (`2026-09-19T14-30-22Z.md`) from `planFilePath`.
   * Absent on payloads from agents that predate per-episode plan files → `plan.md`.
   */
  fileName?: string;
  /** True while the `exit_plan_mode` request is unanswered — the review is a blocking decision. */
  pending: boolean;
}

export interface PlanSlice {
  planReview: PlanReview | null;
  planComments: PlanComment[];
  planNextCommentId: number;
  /** Popup visibility. Hiding is never a verdict: the parked review stays parked. */
  planDialogOpen: boolean;
  /** Which side of the shared TUI-style prompt currently owns keyboard input. */
  planFocus: PlanFocus;
  /** The selected 1-based source-line range while a comment is being composed. */
  planCommentRange: [number, number] | null;
  /** Existing comment being edited, or `null` when composing a new comment. */
  planEditingCommentId: number | null;
  /** The ordinary composer draft saved while the shared prompt is composing a comment. */
  planStashedDraft: string | null;
}

export const emptyPlanSlice: PlanSlice = {
  planReview: null,
  planComments: [],
  planNextCommentId: 0,
  planDialogOpen: false,
  planFocus: "preview",
  planCommentRange: null,
  planEditingCommentId: null,
  planStashedDraft: null,
};

/** `LineViewerState::open_markdown_content` renders nothing for a whitespace-only body. */
export function planBodyIsEmpty(body: string | null | undefined): boolean {
  return body === null || body === undefined || body.trim() === "";
}

/** Basename of an episode's plan file, mirroring the pager's `plan_file_name`.
 *  `plan.md` when the payload carries no path — the filename agents used before plan files were
 *  allocated per episode. */
export function planFileName(path: string | null | undefined): string {
  if (typeof path !== "string") return "plan.md";
  const name = path.split(/[/\\]/).pop();
  return name !== undefined && name.length > 0 ? name : "plan.md";
}

/** The line viewer's title: the episode's plan filename, or `<name> (empty)` when the review carries no body. */
export function planDialogTitle(review: PlanReview | null): string {
  if (!review) return "plan.md";
  const name = review.fileName ?? "plan.md";
  return planBodyIsEmpty(review.body) ? `${name} (empty)` : name;
}

/** `EMPTY_PLAN_PLACEHOLDER`: the body the viewer shows when the review parked with no plan. */
export const EMPTY_PLAN_BODY = `# No plan written yet

The agent exited plan mode without writing a plan.

- **Approve**: leave plan mode and start implementing
- **Request changes**: send the agent back to planning
- **Quit**: abandon and turn plan mode off
`;

/**
 * Rust's `str::lines`: splits on `\n`, strips one trailing `\r`, and drops the final empty line a
 * trailing newline would otherwise produce. Comment ranges are indexed against this.
 */
export function planBodyLines(body: string | null | undefined): string[] {
  if (body === null || body === undefined || body === "") return [];
  const lines = body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * `views/plan_approval_view.rs::inline_plan_snippets`, including its quirks: a range starting at 0,
 * an inverted range, or a start past the end all report the selection as unavailable, and the
 * end bound is compared against the 1-based start rather than the slice index.
 */
export function inlinePlanSnippets(body: string | null | undefined, range: [number, number]): string {
  if (planBodyIsEmpty(body)) return "> [plan content unavailable]";
  const lines = planBodyLines(body);
  const [start, endExclusive] = range;
  if (start === 0 || start >= endExclusive || start > lines.length) return "> [selected lines unavailable]";
  const sliceStart = start - 1;
  const sliceEnd = Math.min(endExclusive - 1, lines.length);
  if (sliceEnd < start) return "> [selected lines unavailable]";
  const snippet = lines.slice(sliceStart, sliceEnd);
  if (snippet.length === 0) return "> [selected lines unavailable]";
  return snippet.map((line) => `> ${line}`).join("\n");
}

/** The comment row's gutter label: `L3` for one line, `L3-4` for a range. */
export function commentLineLabel(range: [number, number]): string {
  const [start, endExclusive] = range;
  return endExclusive - start === 1 ? `L${start}` : `L${start}-${endExclusive - 1}`;
}

/** The comment-count badge the footer paints after the `comment` button. */
export function planCommentBadge(count: number): string {
  return count > 0 ? ` ${count} ●` : "";
}

/**
 * `PlanApprovalViewState::format_feedback` for the `Inline` source, which is what a content-carrying
 * `exit_plan_mode` request uses. Each comment becomes its line label, the quoted plan lines, and the
 * text; a freeform note rides along as `Additional feedback:` whenever comments exist.
 */
export function planFeedback(comments: readonly PlanComment[], freeform: string | null, body: string | null): string {
  const parts = comments.map((comment) => {
    const [start, endExclusive] = comment.lineRange;
    const label = endExclusive - start === 1
      ? `Proposed plan line ${start}:`
      : `Proposed plan lines ${start}-${endExclusive - 1}:`;
    return `${label}\n${inlinePlanSnippets(body, comment.lineRange)}\n\nComment:\n${comment.text}`;
  });
  const text = freeform?.trim() ?? "";
  if (text !== "") {
    parts.push(comments.length > 0 ? `Additional feedback:\n${text}` : text);
  }
  return parts.join("\n\n");
}

export type PlanDecisionId = "approve" | "goal" | "changes" | "comment" | "copy" | "quit" | "send";

export interface PlanDecision {
  id: PlanDecisionId;
  /** The TUI's key for this button, shown in the `<kbd>` chip. */
  key: string;
  label: string;
}

/**
 * The footer's decision bar (`file_search/line_viewer.rs`) in render order. Approve, run as goal,
 * request changes and quit plan exist only while the review is parked — after the decision the bar
 * drops to the casual set, so no button is a dead end.
 */
export function planDecisionBar(review: PlanReview | null, commentCount: number): PlanDecision[] {
  const bar: PlanDecision[] = [];
  if (review?.pending) {
    bar.push({ id: "approve", key: "a", label: commentCount > 0 ? "approve w/ comments" : "approve" });
    bar.push({ id: "goal", key: "g", label: "run as goal" });
    bar.push({ id: "changes", key: "s", label: "request changes" });
  }
  bar.push({ id: "comment", key: "c", label: "comment" });
  bar.push({ id: "copy", key: "y", label: "copy plan" });
  if (!review?.pending && commentCount > 0) {
    bar.push({ id: "send", key: "s", label: "send" });
  }
  if (review?.pending) {
    bar.push({ id: "quit", key: "q", label: "quit plan" });
  }
  return bar;
}

/** The wire outcome each decision sends (`ExitPlanModeExtResponse.outcome`). */
export const PLAN_OUTCOMES: Record<string, string> = {
  approve: "approved",
  goal: "approved_as_goal",
  changes: "cancelled",
  quit: "abandoned",
};
