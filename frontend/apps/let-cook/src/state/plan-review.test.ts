import { describe, expect, it } from "vitest";
import {
  EMPTY_PLAN_BODY,
  PLAN_OUTCOMES,
  commentLineLabel,
  inlinePlanSnippets,
  planBodyIsEmpty,
  planBodyLines,
  planCommentBadge,
  planDecisionBar,
  planDialogTitle,
  planFileName,
  planHeading,
  planFeedback,
  type PlanComment,
} from "./plan-review";

const comment = (id: number, start: number, endExclusive: number, text: string): PlanComment =>
  ({ id, lineRange: [start, endExclusive], text });

describe("planBodyIsEmpty", () => {
  it("treats a missing or whitespace-only body as empty, as the pager's `has_plan` does", () => {
    expect(planBodyIsEmpty(null)).toBe(true);
    expect(planBodyIsEmpty(undefined)).toBe(true);
    expect(planBodyIsEmpty("   \n\n  ")).toBe(true);
    expect(planBodyIsEmpty("# Plan")).toBe(false);
  });
});

describe("planDialogTitle", () => {
  it("names the file, flagging an empty review the way the line viewer does", () => {
    expect(planDialogTitle(null)).toBe("plan.md");
    expect(planDialogTitle({ body: null, pending: true })).toBe("plan.md (empty)");
    expect(planDialogTitle({ body: "  ", pending: false })).toBe("plan.md (empty)");
    expect(planDialogTitle({ body: "# Plan", pending: true })).toBe("Plan");
  });

  it("prefers the plan H1 over the episode filename", () => {
    const fileName = "2026-09-19T14-30-22Z.md";
    expect(planDialogTitle({ body: "# Plan: Clean all files", fileName, pending: true })).toBe("Clean all files");
    expect(planDialogTitle({ body: "no heading", fileName, pending: true })).toBe(fileName);
    expect(planDialogTitle({ body: " ", fileName, pending: true })).toBe(`${fileName} (empty)`);
  });
});

describe("planHeading", () => {
  it("takes the first H1 and strips a Plan: prefix", () => {
    expect(planHeading("# Plan: Ship it\n\nDo the thing")).toBe("Ship it");
    expect(planHeading("  # Clean all files")).toBe("Clean all files");
    expect(planHeading("## Not an h1")).toBeNull();
    expect(planHeading(null)).toBeNull();
  });
});

describe("planFileName", () => {
  it("takes the basename of the plan path and falls back to the legacy name", () => {
    expect(planFileName("/home/u/.cook/sessions/p/abc/plans/2026-09-19T14-30-22Z.md"))
      .toBe("2026-09-19T14-30-22Z.md");
    expect(planFileName("/home/u/.cook/sessions/p/abc/plan.md")).toBe("plan.md");
    expect(planFileName("C:\\sessions\\abc\\plans\\2026-09-19T14-30-22Z.md"))
      .toBe("2026-09-19T14-30-22Z.md");
    expect(planFileName(null)).toBe("plan.md");
    expect(planFileName(undefined)).toBe("plan.md");
    expect(planFileName("")).toBe("plan.md");
    expect(planFileName("/trailing/slash/")).toBe("plan.md");
  });
});

describe("planBodyLines", () => {
  it("matches Rust's `lines`: a trailing newline adds no line and `\\r\\n` keeps no carriage return", () => {
    expect(planBodyLines("alpha\nbravo\ncharlie\ndelta")).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(planBodyLines("alpha\nbravo\n")).toEqual(["alpha", "bravo"]);
    expect(planBodyLines("alpha\r\nbravo")).toEqual(["alpha", "bravo"]);
    expect(planBodyLines("alpha\n\nbravo")).toEqual(["alpha", "", "bravo"]);
    expect(planBodyLines(null)).toEqual([]);
  });
});

describe("inlinePlanSnippets", () => {
  it("quotes the selected source lines", () => {
    expect(inlinePlanSnippets("alpha\nbravo\ncharlie\ndelta", [2, 3])).toBe("> bravo");
    expect(inlinePlanSnippets("alpha\nbravo\ncharlie\ndelta", [3, 5])).toBe("> charlie\n> delta");
  });

  it("reports an unusable selection rather than a wrong quote", () => {
    expect(inlinePlanSnippets("alpha", [9, 10])).toBe("> [selected lines unavailable]");
    expect(inlinePlanSnippets("alpha", [0, 1])).toBe("> [selected lines unavailable]");
    expect(inlinePlanSnippets("alpha", [2, 2])).toBe("> [selected lines unavailable]");
    expect(inlinePlanSnippets(null, [1, 2])).toBe("> [plan content unavailable]");
  });
});

describe("planFeedback", () => {
  // The pager's own `inline_plan_feedback_quotes_selected_line_snippets` vector.
  it("formats line comments with their quoted lines and a trailing freeform note", () => {
    const body = "alpha\nbravo\ncharlie\ndelta";
    const feedback = planFeedback([comment(0, 2, 3, "rewrite this"), comment(1, 3, 5, "combine these")], "overall note", body);
    expect(feedback).toBe(
      "Proposed plan line 2:\n> bravo\n\nComment:\nrewrite this\n\n"
      + "Proposed plan lines 3-4:\n> charlie\n> delta\n\nComment:\ncombine these\n\n"
      + "Additional feedback:\noverall note",
    );
  });

  // The pager's `inline_plan_feedback_handles_out_of_range_lines` vector.
  it("keeps a comment on an unreachable line instead of dropping it", () => {
    expect(planFeedback([comment(0, 9, 10, "where is this")], null, "alpha")).toBe(
      "Proposed plan line 9:\n> [selected lines unavailable]\n\nComment:\nwhere is this",
    );
  });

  it("sends a lone freeform note verbatim and nothing at all when there is neither", () => {
    expect(planFeedback([], "  just this  ", "# Plan")).toBe("just this");
    expect(planFeedback([], "   ", "# Plan")).toBe("");
    expect(planFeedback([], "", null)).toBe("");
  });
});

describe("commentLineLabel", () => {
  it("labels one line or a range, 1-based as the wire feedback is", () => {
    expect(commentLineLabel([3, 4])).toBe("L3");
    expect(commentLineLabel([3, 5])).toBe("L3-4");
  });
});

describe("planCommentBadge", () => {
  it("stays empty until there is a comment to count", () => {
    expect(planCommentBadge(0)).toBe("");
    expect(planCommentBadge(2)).toBe(" 2 ●");
  });
});

describe("planDecisionBar", () => {
  const parked = { body: "# Plan", pending: true };
  const answered = { body: "# Plan", pending: false };

  it("offers the full decision set, in the TUI's order, while the review is parked", () => {
    expect(planDecisionBar(parked, 0).map((item) => [item.key, item.label])).toEqual([
      ["a", "approve"],
      ["g", "run as goal"],
      ["s", "request changes"],
      ["c", "comment"],
      ["y", "copy plan"],
      ["q", "quit plan"],
    ]);
  });

  it("relabels approve once comments exist", () => {
    expect(planDecisionBar(parked, 1)[0].label).toBe("approve w/ comments");
  });

  it("drops the verdicts after the decision, so no button is a dead end", () => {
    expect(planDecisionBar(answered, 0).map((item) => item.id)).toEqual(["comment", "copy"]);
    expect(planDecisionBar(answered, 2).map((item) => item.id)).toEqual(["comment", "copy", "send"]);
  });
});

describe("PLAN_OUTCOMES", () => {
  it("maps each verdict to the wire outcome the shell reads", () => {
    expect(PLAN_OUTCOMES).toEqual({
      approve: "approved",
      goal: "approved_as_goal",
      changes: "cancelled",
      quit: "abandoned",
    });
  });
});

describe("EMPTY_PLAN_BODY", () => {
  it("is the placeholder the pager shows, so the decision surface is never blank", () => {
    expect(EMPTY_PLAN_BODY).toContain("# No plan written yet");
    expect(EMPTY_PLAN_BODY.trim()).not.toBe("");
  });
});
