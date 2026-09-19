import { describe, expect, it } from "vitest";
import type { ToolBlock } from "../../state/session";
import { editHeaderSuffix, isWriteTool, toolHeader, writeBodyFitsFrame } from "./tool-card";

const diff = (oldText: string, newText: string, path = "src/a.ts") => ({ type: "diff", path, oldText, newText });

const tool = (kind: string, title: string, paths: string[] = [], content: unknown[] = []): ToolBlock => ({
  type: "tool",
  id: "tool-1",
  turnId: "turn-1",
  title,
  kind,
  status: "completed",
  content,
  locations: [],
  startedAt: 0,
  elapsedMs: 100,
  paths,
});

describe("tool row headers", () => {
  it("recovers a useful Read label when ACP only supplies a generic title", () => {
    expect(toolHeader(tool("read", "read", ["src/state/session.ts"]))).toEqual({ text: "Read src/state/session.ts" });
  });

  it("keeps command rows shell-like and does not expose a rerun affordance", () => {
    expect(toolHeader({ ...tool("execute", "execute"), command: "pnpm test" })).toEqual({ prefix: "$ ", text: "pnpm test" });
  });
});

describe("edit row suffix", () => {
  it("appends the diffstat to a collapsed Edit header", () => {
    expect(toolHeader(tool("edit", "edit", ["src/a.ts"], [diff("a\nb\nc", "a\nX\nY\nZ\nc")]))).toEqual({
      text: "Edit src/a.ts",
      suffix: { kind: "diff", added: 3, removed: 1 },
    });
  });

  it("uses the same suffix for Creating rows", () => {
    expect(toolHeader(tool("write", "write", ["src/new.ts"], [diff("", "one\ntwo")]))).toEqual({
      text: "Creating src/new.ts",
      suffix: { kind: "diff", added: 2, removed: 0 },
    });
  });

  it("falls back to the edit count when a call carries several hunks and no line delta", () => {
    expect(editHeaderSuffix(tool("edit", "edit", ["src/a.ts"], [diff("same", "same"), diff("same", "same")])))
      .toEqual({ kind: "edits", count: 2 });
  });

  it("counts edits for a multi-file call it will not diffstat", () => {
    expect(editHeaderSuffix(tool("edit", "edit", ["src/a.ts", "src/b.ts"], [
      diff("a", "a\nb", "src/a.ts"),
      diff("c", "c\nd", "src/b.ts"),
    ]))).toEqual({ kind: "edits", count: 2 });
  });

  it("hides counts for a multi-file call, whose diffs describe only part of the work", () => {
    expect(editHeaderSuffix(tool("edit", "edit", ["src/a.ts", "src/b.ts"], [diff("a", "a\nb", "src/a.ts")]))).toBeNull();
  });

  it("hides a zero-change diffstat", () => {
    expect(editHeaderSuffix(tool("edit", "edit", ["src/a.ts"], [diff("same", "same")]))).toBeNull();
  });

  it("does not count non-edit rows", () => {
    expect(editHeaderSuffix(tool("read", "read", ["src/a.ts"], [diff("a", "a\nb")]))).toBeNull();
  });
});

describe("write row fold", () => {
  it("recognizes the file-creating tool kinds", () => {
    expect(isWriteTool("write")).toBe(true);
    expect(isWriteTool("Write")).toBe(true);
    expect(isWriteTool("write_file")).toBe(true);
    expect(isWriteTool("edit")).toBe(false);
    expect(isWriteTool(null)).toBe(false);
  });

  it("opens a row while its body fits the frame it is read in, edges included", () => {
    expect(writeBodyFitsFrame(240, 600)).toBe(true);
    expect(writeBodyFitsFrame(600, 600)).toBe(true);
    expect(writeBodyFitsFrame(601, 600)).toBe(false);
  });

  it("keeps a row folded when there is no body or no measured frame", () => {
    expect(writeBodyFitsFrame(0, 600)).toBe(false);
    expect(writeBodyFitsFrame(240, 0)).toBe(false);
  });
});
