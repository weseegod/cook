import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({ openPath: vi.fn(async () => undefined) }));

import type { MessageBlock, ToolBlock } from "../../state/session";
import { ThinkingGroupRow, ThinkingRow, ToolRow } from "./tool-card";

const thought = (patch: Partial<MessageBlock> = {}): MessageBlock => ({
  type: "message",
  id: "thought-1",
  turnId: "turn-1",
  role: "thought",
  text: "one\ntwo\nthree\nfour\nfive",
  images: [],
  streaming: true,
  ...patch,
});

const editTool: ToolBlock = {
  type: "tool",
  id: "edit-1",
  turnId: "turn-1",
  title: "edit",
  kind: "edit",
  status: "completed",
  content: [{ type: "diff", path: "src/a.ts", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }],
  locations: [],
  startedAt: 0,
  elapsedMs: 100,
  paths: ["src/a.ts"],
};

describe("ThinkingGroupRow", () => {
  it("shows the combined duration and expands thoughts in order", () => {
    const thoughts = [
      thought({ id: "thought-1", text: "I considered index.js", streaming: false, elapsedMs: 1000 }),
      thought({ id: "thought-2", text: "I considered app.js", streaming: false, elapsedMs: 1000 }),
      thought({ id: "thought-3", text: "I considered component.js", streaming: false, elapsedMs: 3000 }),
    ];
    render(<ThinkingGroupRow id="thought-thought-1" thoughts={thoughts} />);

    const toggle = screen.getByRole("button", { name: "Thought for 5.0s" });
    expect(screen.queryByText("I considered index.js")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("I considered index.js")).toBeInTheDocument();
    expect(screen.getByText("I considered app.js")).toBeInTheDocument();
    expect(screen.getByText("I considered component.js")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(screen.queryByText("I considered index.js")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("uses a plural label if one thought has no recorded duration", () => {
    render(<ThinkingGroupRow id="thoughts" thoughts={[thought({ streaming: false }), thought({ id: "thought-2", streaming: false, elapsedMs: 1000 })]} />);
    expect(screen.getByRole("button", { name: "Thoughts" })).toBeInTheDocument();
  });
});

describe("ThinkingRow", () => {
  it("truncates a running block to its last lines", () => {
    render(<ThinkingRow block={thought()} />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText(/three\s+four\s+five/)).toBeInTheDocument();
    expect(screen.queryByText(/^one/)).toBeNull();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("opens the whole body on click and hides the preview", () => {
    render(<ThinkingRow block={thought()} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("…")).toBeNull();
    expect(screen.getByText(/one\s+two\s+three\s+four\s+five/)).toBeInTheDocument();
  });

  it("shows only the header once the block is frozen", () => {
    render(<ThinkingRow block={thought({ streaming: false, elapsedMs: 1234 })} />);
    expect(screen.getByText("Thought for 1.2s")).toBeInTheDocument();
    expect(screen.queryByText(/three/)).toBeNull();
  });

  it("collapses a frozen block the user had opened", () => {
    const { rerender } = render(<ThinkingRow block={thought()} />);
    fireEvent.click(screen.getByRole("button"));
    rerender(<ThinkingRow block={thought({ streaming: false, elapsedMs: 1234 })} />);
    expect(screen.getByText("Thought for 1.2s")).toBeInTheDocument();
    expect(screen.queryByText(/five/)).toBeNull();
  });
});

describe("edit and write rows", () => {
  const writeTool = (newText: string): ToolBlock => ({
    ...editTool,
    id: "write-1",
    kind: "write",
    title: "write",
    content: [{ type: "diff", path: "src/new.ts", oldText: "", newText }],
    paths: ["src/new.ts"],
  });

  it("opens a completed Edit on its diff and preserves manual collapse across updates", () => {
    const { container, rerender } = render(<ToolRow tool={editTool} />);
    const row = container.querySelector("details")!;
    expect(row.open).toBe(true);
    expect(row.querySelector(".diff-context")?.textContent).toContain("a");
    expect(row.querySelector(".diff-remove")?.textContent).toContain("-b");
    expect(row.querySelector(".diff-add")?.textContent).toContain("+X");
    expect(row.querySelector(".tool-locations")).toBeNull();
    expect(row.querySelector(".row-diffstat")?.textContent).toBe("+3/-1");
    row.open = false;
    fireEvent(row, new Event("toggle"));
    expect(row.open).toBe(false);
    expect(row.querySelector(".row-diffstat")?.textContent).toBe("+3/-1");
    rerender(<ToolRow tool={{ ...editTool, content: [...editTool.content] }} />);
    expect(row.open).toBe(false);
  });

  it("opens when a pending Edit receives content but leaves an empty call folded", () => {
    const { container, rerender } = render(<ToolRow tool={{ ...editTool, content: [], status: "pending" }} />);
    expect(container.querySelector("details")!.open).toBe(false);
    rerender(<ToolRow tool={editTool} />);
    expect(container.querySelector("details")!.open).toBe(true);
  });

  it("folds a failed Edit even when an earlier update carried a diff", () => {
    const { container, rerender } = render(<ToolRow tool={{ ...editTool, status: "pending" }} />);
    expect(container.querySelector("details")!.open).toBe(true);
    rerender(<ToolRow tool={{ ...editTool, status: "failed" }} />);
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("keeps Execute and Read folded by default", () => {
    const execute = { ...editTool, kind: "execute", title: "Execute", command: "pnpm test" };
    const { container, rerender } = render(<ToolRow tool={execute} />);
    expect(container.querySelector("details")!.open).toBe(false);
    rerender(<ToolRow tool={{ ...editTool, kind: "read", title: "Read src/a.ts" }} />);
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("shows the entire Write and its line counts by default", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(<ToolRow tool={writeTool(lines)} />);
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.querySelector("pre")?.textContent).toContain("line 60");
    expect(container.querySelector(".row-diffstat")?.textContent).toBe("+60/-0");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    expect(screen.queryByText(/Diff is large/)).toBeNull();
  });

  it("folds a long Edit inline with Show more and Show less", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(<ToolRow tool={{ ...editTool, content: [{ type: "diff", path: "src/a.ts", oldText: "", newText: lines }] }} />);
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.querySelector("pre")?.textContent).not.toContain("line 60");
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(container.querySelector("pre")?.textContent).toContain("line 60");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.querySelector("pre")?.textContent).not.toContain("line 60");
  });

  it("keeps file headers neutral and shows multi-file paths", () => {
    const { container } = render(<ToolRow tool={{ ...editTool, paths: ["src/a.ts", "src/b.ts"], content: [
      { type: "text", text: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new" },
    ] }} />);
    expect(container.querySelectorAll(".diff-meta")).toHaveLength(3);
    expect(container.querySelector(".tool-locations")?.textContent).toContain("src/b.ts");
  });
});
