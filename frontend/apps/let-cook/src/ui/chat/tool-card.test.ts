import { describe, expect, it } from "vitest";
import type { ToolBlock } from "../../state/session";
import { toolHeader } from "./tool-card";

const tool = (kind: string, title: string, paths: string[] = []): ToolBlock => ({
  type: "tool",
  id: "tool-1",
  turnId: "turn-1",
  title,
  kind,
  status: "completed",
  content: [],
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
