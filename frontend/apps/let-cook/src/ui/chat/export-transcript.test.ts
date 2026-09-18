import { describe, expect, it } from "vitest";
import type { TranscriptBlock } from "../../state/session";
import { exportFilename, exportTranscriptMarkdown } from "./export-transcript";

function user(text: string, id = "u1"): TranscriptBlock {
  return { type: "message", id, turnId: "t1", role: "user", text, images: [], streaming: false };
}

function assistant(text: string, id = "a1"): TranscriptBlock {
  return { type: "message", id, turnId: "t1", role: "assistant", text, images: [], streaming: false };
}

function thought(text: string): TranscriptBlock {
  return { type: "message", id: "th1", turnId: "t1", role: "thought", text, images: [], streaming: false };
}

function tool(title = "Read README"): TranscriptBlock {
  return {
    type: "tool",
    id: "tool-1",
    turnId: "t1",
    title,
    status: "completed",
    content: [{ type: "text", text: "FILE CONTENTS DUMP — should not appear" }],
    locations: [],
    startedAt: 0,
    elapsedMs: 10,
    paths: ["README.md"],
  };
}

describe("exportTranscriptMarkdown", () => {
  it("returns empty string for no blocks", () => {
    expect(exportTranscriptMarkdown([])).toBe("");
  });

  it("exports user and assistant text with section headers", () => {
    const md = exportTranscriptMarkdown([user("Hello"), assistant("Hi there")]);
    expect(md).toBe("## User\n\nHello\n\n## Assistant\n\nHi there");
  });

  it("omits tool dumps by default", () => {
    const md = exportTranscriptMarkdown([
      user("Fix the bug"),
      tool(),
      assistant("Done."),
    ]);
    expect(md).toContain("## User");
    expect(md).toContain("Fix the bug");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Done.");
    expect(md).not.toContain("## Tools");
    expect(md).not.toContain("FILE CONTENTS DUMP");
    expect(md).not.toContain("README.md");
  });

  it("skips thoughts and session chrome", () => {
    const md = exportTranscriptMarkdown([
      user("Q"),
      thought("reasoning…"),
      { type: "session-event", id: "e1", turnId: "t1", text: "Worked for 1s" },
      assistant("A"),
    ]);
    expect(md).not.toContain("reasoning");
    expect(md).not.toContain("Worked for");
    expect(md).toContain("## User\n\nQ");
    expect(md).toContain("## Assistant\n\nA");
  });

  it("coalesces consecutive assistant messages under one header", () => {
    const md = exportTranscriptMarkdown([
      assistant("Part one."),
      assistant("Part two."),
    ]);
    expect(md).toBe("## Assistant\n\nPart one.\n\nPart two.");
    expect(md.match(/## Assistant/g)).toHaveLength(1);
  });

  it("can include compact tool summaries when opted in", () => {
    const md = exportTranscriptMarkdown([user("Go"), tool("Read")], { includeTools: true });
    expect(md).toContain("## Tools");
    expect(md).toContain("- Read: README.md");
    expect(md).not.toContain("FILE CONTENTS DUMP");
  });
});

describe("exportFilename", () => {
  it("sanitizes a title into a .md name", () => {
    expect(exportFilename("Fix login bug!")).toBe("Fix-login-bug.md");
  });

  it("falls back to session id or conversation", () => {
    expect(exportFilename(null, "sess-1")).toBe("sess-1.md");
    expect(exportFilename("", null)).toBe("conversation.md");
  });
});
