import { describe, expect, it } from "vitest";
import type { MessageBlock, ToolBlock, TranscriptBlock } from "../../state/session";
import { projectTranscript, type DisplayBlock } from "./transcript-projection";
import { verbGroupLabel, verbKind } from "./verb-group";

const tool = (id: string, title: string, status = "completed", extra: Partial<ToolBlock> = {}): ToolBlock => ({
  type: "tool",
  id,
  turnId: "turn-1",
  title,
  kind: title.split(" ")[0].toLowerCase(),
  status,
  content: [],
  locations: [],
  startedAt: Date.now(),
  elapsedMs: status === "completed" || status === "failed" ? 120 : null,
  paths: [],
  ...extra,
});

const thought = (id: string, streaming = false): MessageBlock => ({
  type: "message",
  id,
  turnId: "turn-1",
  role: "thought",
  text: "Inspecting the repository",
  images: [],
  streaming,
});

const rows = (blocks: TranscriptBlock[]): string[] => projectTranscript(blocks).map((row) => row.type);

describe("verb runs", () => {
  it("folds consecutive foldable tools under one aggregated header", () => {
    const projected = projectTranscript([tool("read-1", "Read src/a.ts"), tool("read-2", "Read src/b.ts")]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: "verb-group" });
    if (projected[0].type === "verb-group") {
      expect(projected[0].tools.map((entry) => entry.id)).toEqual(["read-1", "read-2"]);
      expect(verbGroupLabel(projected[0].tools)).toBe("Read 2 files");
    }
  });

  it("folds a single foldable member too (TUI `folds()` is members >= 1)", () => {
    const projected = projectTranscript([tool("read-1", "Read src/a.ts")]);
    expect(rows([tool("read-1", "Read src/a.ts")])).toEqual(["verb-group"]);
    if (projected[0].type === "verb-group") expect(verbGroupLabel(projected[0].tools)).toBe("Read 1 file");
  });

  it("keeps execute and edit as their own rows, breaking the run", () => {
    const projected = projectTranscript([
      tool("read-1", "Read src/a.ts"),
      tool("run-1", "Run tests", "completed", { kind: "execute", command: "pnpm test" }),
      tool("read-2", "Read src/b.ts"),
    ]);
    expect(projected.map((row) => row.type)).toEqual(["verb-group", "tool", "verb-group"]);
  });

  it("breaks runs on assistant prose", () => {
    const answer: MessageBlock = { ...thought("answer"), role: "assistant", streaming: false };
    expect(rows([tool("read", "Read a.ts"), answer, tool("search", "Search pattern")]))
      .toEqual(["verb-group", "message", "verb-group"]);
  });

  it("claims finished thoughts into an open run but lets a streaming thought keep its row", () => {
    expect(rows([thought("t1"), tool("read-1", "Read a.ts"), tool("read-2", "Read b.ts")])).toEqual(["verb-group"]);
    expect(rows([thought("t1", true), tool("read-1", "Read a.ts")])).toEqual(["message", "verb-group"]);
  });

  it("renders a thought-only run as a normal row", () => {
    expect(rows([thought("t1")])).toEqual(["message"]);
  });
});

describe("verb-group labels", () => {
  it("orders buckets by first appearance and tenses per bucket", () => {
    expect(verbGroupLabel([
      tool("read-1", "Read a.ts"),
      tool("read-2", "Read b.ts"),
      tool("search-1", "Search pattern"),
    ])).toBe("Read 2 files, Searched 1 pattern");

    expect(verbGroupLabel([
      tool("read-1", "Read a.ts", "pending"),
      tool("search-1", "Search pattern", "pending"),
    ])).toBe("Reading 1 file, Searching 1 pattern");
  });

  it("appends the failure count", () => {
    // Failures still count toward the bucket total, matching `Read 3 files · 2 failed`.
    expect(verbGroupLabel([
      tool("read-1", "Read a.ts"),
      tool("read-2", "Read b.ts", "failed"),
      tool("read-3", "Read c.ts", "failed"),
    ])).toBe("Read 3 files · 2 failed");
  });

  it("names dir, fetch, web search, memory and MCP buckets", () => {
    expect(verbGroupLabel([tool("list", "List src")])).toBe("Listed 1 dir");
    expect(verbGroupLabel([tool("fetch", "Fetch https://example.com")])).toBe("Fetched 1 website");
    expect(verbGroupLabel([tool("ws", "Web Search tauri")])).toBe("Searched 1 website");
    expect(verbGroupLabel([tool("mem", "Memory Search auth")])).toBe("Searched 1 memory");
    expect(verbGroupLabel([tool("st", "Search Tools filesystem")])).toBe("Searched 1 MCP tool");
  });
});

describe("verb kinds", () => {
  it("classifies titles the way the TUI tool blocks do", () => {
    expect(verbKind(tool("a", "Read src/a.ts"))).toBe("file");
    expect(verbKind(tool("b", "Skill deploy"))).toBe("skill");
    expect(verbKind(tool("c", "Search pattern"))).toBe("search");
    expect(verbKind(tool("d", "List src"))).toBe("dir");
    expect(verbKind(tool("e", "Fetch https://x"))).toBe("fetch");
    expect(verbKind(tool("f", "Web Search q"))).toBe("websearch");
    expect(verbKind(tool("g", "Memory Search q"))).toBe("memory");
    expect(verbKind(tool("h", "Search Tools q"))).toBe("mcpsearch");
    expect(verbKind(tool("i", "Subagent explore"))).toBe("subagent");
    expect(verbKind(tool("j", "Run tests", "completed", { kind: "execute" }))).toBeNull();
    expect(verbKind(tool("k", "Edit src/a.ts"))).toBeNull();
    expect(verbKind(tool("l", "Web Fetch https://x"))).toBe("fetch");
  });
});

describe("display rows", () => {
  it("keeps plans and turn markers in order", () => {
    const rows: DisplayBlock[] = projectTranscript([
      { type: "plan", id: "p1", turnId: "turn-1", entries: [] },
      { type: "session-event", id: "e1", turnId: "turn-1", text: "Worked for 2.0s" },
    ]);
    expect(rows.map((row) => row.type)).toEqual(["plan", "session-event"]);
  });
});
