import { describe, expect, it } from "vitest";
import type { ToolBlock } from "../../state/session";
import { editLineCounts, hunkLineCounts, toolLineCounts } from "./edit-lines";

function tool(turnId: string, content: unknown[]): ToolBlock {
  return {
    type: "tool",
    id: `tool-${turnId}-${content.length}`,
    turnId,
    title: "Edit",
    status: "completed",
    content,
    locations: [],
    startedAt: 0,
    elapsedMs: null,
    paths: [],
  };
}

describe("hunkLineCounts", () => {
  it("counts a replacement around the shared head and tail", () => {
    expect(hunkLineCounts("a\nb\nc", "a\nX\nY\nZ\nc")).toEqual({ added: 3, removed: 1 });
  });

  it("counts pure additions and pure deletions", () => {
    expect(hunkLineCounts("a", "a\nb\nc")).toEqual({ added: 2, removed: 0 });
    expect(hunkLineCounts("a\nb\nc", "a")).toEqual({ added: 0, removed: 2 });
    expect(hunkLineCounts("", "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(hunkLineCounts("a\nb", "")).toEqual({ added: 0, removed: 2 });
  });

  it("keeps the trailing newline from reading as an extra line", () => {
    expect(hunkLineCounts("a\nb\n", "a\nb\nc\n")).toEqual({ added: 1, removed: 0 });
  });

  it("counts reordered middles exactly", () => {
    expect(hunkLineCounts("a\nb\nc\nd", "a\nd\nc\nb")).toEqual({ added: 2, removed: 2 });
  });

  it("reports an unchanged hunk as empty", () => {
    expect(hunkLineCounts("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});

describe("editLineCounts", () => {
  it("sums the diff content of one turn's tool calls", () => {
    const blocks = [
      tool("turn-1", [{ type: "diff", path: "a.ts", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }]),
      tool("turn-1", [{ type: "content", content: { type: "diff", path: "b.ts", oldText: "one", newText: "one\ntwo" } }]),
      tool("turn-2", [{ type: "diff", path: "c.ts", oldText: "old", newText: "new" }]),
    ];
    expect(editLineCounts(blocks, "turn-1")).toEqual({ additions: 4, deletions: 1 });
  });

  it("counts unified-diff text a tool printed, ignoring its file headers", () => {
    const diff = "--- a/one.ts\n+++ b/one.ts\n@@ -1,2 +1,2 @@\n-removed\n+added\n+another";
    expect(editLineCounts([tool("turn-1", [{ type: "text", text: diff }])], "turn-1")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("ignores output that is not a diff, and turns it has no record of", () => {
    expect(editLineCounts([tool("turn-1", ["$ pnpm test\n100 passing"])], "turn-1")).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(editLineCounts([tool("turn-1", [{ type: "diff", path: "a", oldText: "a", newText: "b" }])], null)).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe("toolLineCounts", () => {
  it("counts one ACP diff record as one hunk", () => {
    expect(toolLineCounts([{ type: "diff", path: "a.ts", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }]))
      .toEqual({ added: 3, removed: 1, hunks: 1 });
  });

  it("sums several records and hunks for one call", () => {
    expect(toolLineCounts([
      { type: "diff", path: "a.ts", oldText: "one", newText: "one\ntwo" },
      { content: { type: "diff", path: "b.ts", oldText: "old", newText: "new" } },
    ])).toEqual({ added: 2, removed: 1, hunks: 2 });
  });

  it("counts hunks in printed unified-diff text", () => {
    const diff = "--- a/one.ts\n+++ b/one.ts\n@@ -1,2 +1,2 @@\n-removed\n+added\n@@ -9,1 +9,2 @@\n+another";
    expect(toolLineCounts([{ type: "text", text: diff }])).toEqual({ added: 2, removed: 1, hunks: 2 });
  });

  it("reports nothing for content that is not a diff", () => {
    expect(toolLineCounts(["$ pnpm test\n100 passing"])).toEqual({ added: 0, removed: 0, hunks: 0 });
  });
});
