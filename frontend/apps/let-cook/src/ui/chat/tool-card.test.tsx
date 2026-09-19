import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({ openPath: vi.fn(async () => undefined) }));

import type { MessageBlock, ToolBlock } from "../../state/session";
import { ThinkingRow, ToolRow } from "./tool-card";

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

describe("ToolRow", () => {
  it("paints the edit diffstat on the collapsed one-liner and drops it when expanded", () => {
    const { container } = render(<ToolRow tool={editTool} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    details!.open = true;
    fireEvent(details!, new Event("toggle"));
    expect(screen.queryByText("+3")).toBeNull();
  });
});
