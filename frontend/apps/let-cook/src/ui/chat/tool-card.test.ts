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

  it("builds the TUI one-liners for search, list, and fetch", () => {
    expect(toolHeader(tool("search", "Search chunk reducer"))).toEqual({ text: 'Search "chunk reducer"' });
    expect(toolHeader(tool("search", 'Search "already quoted"'))).toEqual({ text: 'Search "already quoted"' });
    expect(toolHeader(tool("list", "List `src/state`", ["src/state"]))).toEqual({ text: "List src/state" });
    expect(toolHeader(tool("fetch", "Fetch https://example.com"))).toEqual({ text: "Fetch https://example.com" });
  });

  it("never puts the model's description on a collapsed summary", () => {
    const described = {
      ...tool("read", "read_file", ["src/a.ts"]),
      description: "Check chunk reducer behavior with an empty cursor",
    };
    expect(toolHeader(described)).toEqual({ text: "Read src/a.ts" });
  });

  it("reads the target off a refined title when no path was recorded", () => {
    expect(toolHeader(tool("read", "Read `src/b.ts`"))).toEqual({ text: "Read src/b.ts" });
  });

  it("keeps an execute description, which the TUI does show", () => {
    const execute = { ...tool("execute", "execute"), description: "Run the unit suite" };
    expect(toolHeader(execute)).toEqual({ text: "Run the unit suite" });
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
