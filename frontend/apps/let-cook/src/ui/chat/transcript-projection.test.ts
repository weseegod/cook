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

  it("keeps edit as its own row, breaking the run, while agent shell folds in", () => {
    const projected = projectTranscript([
      tool("read-1", "Read src/a.ts"),
      tool("run-1", "Run tests", "completed", { kind: "execute", command: "pnpm test" }),
      tool("read-2", "Read src/b.ts"),
    ]);
    expect(projected.map((row) => row.type)).toEqual(["verb-group"]);
    if (projected[0].type === "verb-group") {
      expect(verbGroupLabel(projected[0].tools)).toBe("Read 2 files, Ran 1 command");
    }
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

  it("folds a grep+read cluster, interleaved with finished thoughts, into one header", () => {
    const projected = projectTranscript([
      thought("t1"),
      tool("grep-1", "Search pattern", "completed", { kind: "search" }),
      thought("t2"),
      tool("read-1", "read_file", "completed", { kind: "read", paths: ["src/a.ts"] }),
      tool("read-2", "Read `src/b.ts`", "completed", { kind: "read", paths: ["src/b.ts"] }),
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: "verb-group" });
    if (projected[0].type === "verb-group") {
      expect(projected[0].tools.map((entry) => entry.id)).toEqual(["grep-1", "read-1", "read-2"]);
      expect(verbGroupLabel(projected[0].tools)).toBe("Searched 1 pattern, Read 2 files");
    }
    // The finished thoughts were claimed into the run, so no stray `Thought` rows.
    expect(projected.some((row) => row.type === "message")).toBe(false);
  });

  it("keeps a streaming thought between two reads from splitting the run", () => {
    const projected = projectTranscript([
      tool("read-1", "read_file", "completed", { kind: "read", paths: ["src/a.ts"] }),
      thought("t1", true),
      tool("read-2", "read_file", "completed", { kind: "read", paths: ["src/b.ts"] }),
    ]);
    expect(projected.map((row) => row.type)).toEqual(["message", "verb-group"]);
    if (projected[1].type === "verb-group") {
      expect(projected[1].tools.map((entry) => entry.id)).toEqual(["read-1", "read-2"]);
    }
  });

  it("keeps edit as its own row inside a read cluster while shell joins", () => {
    expect(rows([
      tool("read-1", "read_file", "completed", { kind: "read", paths: ["src/a.ts"] }),
      tool("edit-1", "Edit `src/b.ts`", "completed", { kind: "edit", paths: ["src/b.ts"] }),
      tool("read-2", "read_file", "completed", { kind: "read", paths: ["src/c.ts"] }),
    ])).toEqual(["verb-group", "tool", "verb-group"]);
  });

  it("renders one finished thought as its existing message row", () => {
    expect(rows([thought("t1")])).toEqual(["message"]);
  });

  it("groups consecutive finished thoughts and keeps their source blocks in order", () => {
    const thoughts = [
      { ...thought("t1"), text: "Inspect index.js", elapsedMs: 1000 },
      { ...thought("t2"), text: "Inspect app.js", elapsedMs: 1000 },
      { ...thought("t3"), text: "Inspect component.js", elapsedMs: 3000 },
    ];
    const projected = projectTranscript(thoughts);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      type: "thought-group",
      id: "thought-t1",
      thoughts: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
    });
  });

  it("keeps prose as a boundary between thought groups", () => {
    const answer: MessageBlock = { ...thought("answer"), role: "assistant", text: "Done." };
    expect(rows([thought("t1"), thought("t2"), answer, thought("t3"), thought("t4")]))
      .toEqual(["thought-group", "message", "thought-group"]);
  });

  it("keeps a streaming thought on its live row", () => {
    const projected = projectTranscript([thought("t1"), thought("t2", true)]);
    expect(projected.map((row) => row.type)).toEqual(["message", "message"]);
  });

  it("folds a shell burst into one row and leaves a lone command on its `$` row", () => {
    const cmd = (id: string) => tool(id, "Run command", "completed", { kind: "execute", command: `cmd ${id}` });
    const burst = projectTranscript([
      cmd("c1"),
      thought("t1"),
      tool("r1", "Read a.ts"),
      cmd("c2"),
      tool("s1", "Search pattern"),
      thought("t2"),
      tool("r2", "Read b.ts"),
      cmd("c3"),
      tool("l1", "List src"),
      cmd("c4"),
      tool("s2", "Search other"),
      thought("t3"),
      tool("r3", "Read c.ts"),
      cmd("c5"),
      tool("r4", "Read d.ts"),
      cmd("c6"),
      tool("s3", "Search third"),
      thought("t4"),
      tool("r5", "Read e.ts"),
      cmd("c7"),
      tool("r6", "Read f.ts"),
      cmd("c8"),
      cmd("c9"),
      cmd("c10"),
      cmd("c11"),
    ]);
    expect(burst.map((row) => row.type)).toEqual(["verb-group"]);
    const group = burst[0];
    if (group.type !== "verb-group") throw new Error("expected a verb group");
    expect(verbGroupLabel(group.tools)).toBe("Ran 11 commands, Read 6 files, Searched 3 patterns, Listed 1 dir");

    // One command with no sibling tool keeps the `$ <command>` row, not `Ran 1 command`.
    expect(rows([cmd("solo")])).toEqual(["tool"]);

    // A user `!` command (bashMode) is not a member: it breaks the run.
    const userBash = tool("bash-1", "Run command", "completed", { kind: "execute", command: "echo hi", bashMode: true });
    expect(rows([tool("read-1", "Read a.ts"), userBash, tool("read-2", "Read b.ts")]))
      .toEqual(["verb-group", "tool", "verb-group"]);
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
    expect(verbKind(tool("j", "Run tests", "completed", { kind: "execute" }))).toBe("command");
    expect(verbKind(tool("j2", "Run command", "completed", { kind: "execute", bashMode: true }))).toBeNull();
    expect(verbKind(tool("k", "Edit src/a.ts"))).toBeNull();
    expect(verbKind(tool("l", "Web Fetch https://x"))).toBe("fetch");
  });
});

describe("display rows", () => {
  it("skips ACP Plan blocks and keeps turn markers in order", () => {
    const rows: DisplayBlock[] = projectTranscript([
      { type: "plan", id: "p1", turnId: "turn-1", entries: [] },
      { type: "session-event", id: "e1", turnId: "turn-1", text: "Worked for 2.0s" },
    ]);
    expect(rows.map((row) => row.type)).toEqual(["session-event"]);
  });
});
