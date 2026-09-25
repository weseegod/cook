import { describe, expect, it } from "vitest";
import type { ToolBlock } from "../../state/session";
import { isWriteTool, toolHeader } from "./tool-card";

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

describe("edit headers", () => {
  it("names edited and created files without a summary in the default TUI appearance", () => {
    expect(toolHeader(tool("edit", "edit", ["src/a.ts"]))).toEqual({ text: "Edit src/a.ts" });
    expect(toolHeader(tool("write", "write", ["src/new.ts"]))).toEqual({ text: "Creating src/new.ts" });
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
});
