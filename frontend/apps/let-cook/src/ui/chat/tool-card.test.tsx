import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

/**
 * jsdom reports every box as 0×0, so the frame the row measures itself against is stubbed here:
 * `clientHeight` on the transcript ancestor, `offsetHeight` on the detail body it mounts.
 */
function stubLayout(heights: { detail: number; frame: number }) {
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("transcript") ? heights.frame : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("tool-detail") ? heights.detail : 24;
  });
}

describe("write rows", () => {
  const writeTool = (newText: string): ToolBlock => ({
    ...editTool,
    id: "write-1",
    kind: "write",
    title: "write",
    content: [{ type: "diff", path: "src/new.ts", oldText: "", newText }],
    paths: ["src/new.ts"],
  });

  const renderInTranscript = (tool: ToolBlock) => render(<div className="transcript"><ToolRow tool={tool} /></div>);

  afterEach(() => vi.restoreAllMocks());

  it("opens a write whose body fits the transcript frame", () => {
    stubLayout({ detail: 240, frame: 600 });
    const { container } = renderInTranscript(writeTool("one\ntwo\nthree"));
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.querySelector(".tool-detail-full")).not.toBeNull();
    // The diffstat is the collapsed row's cue; the open row shows the lines instead.
    expect(screen.queryByText("+3")).toBeNull();
  });

  it("folds a write back to its one-liner once the body outgrows the frame", () => {
    stubLayout({ detail: 620, frame: 600 });
    const { container } = renderInTranscript(writeTool("one\ntwo\nthree"));
    expect(container.querySelector("details")!.open).toBe(false);
    expect(container.querySelector(".tool-detail-full")).toBeNull();
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("keeps an auto-folded write open after the user opens it", () => {
    stubLayout({ detail: 620, frame: 600 });
    const { container } = renderInTranscript(writeTool("one\ntwo\nthree"));
    const details = container.querySelector("details")!;

    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(details.open).toBe(true);
  });

  it("leaves a write the Preview dock owns folded, even when the frame is roomy", () => {
    stubLayout({ detail: 240, frame: 600 });
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = renderInTranscript(writeTool(lines));
    expect(container.querySelector("details")!.open).toBe(false);
    expect(screen.getByText(/Diff is large/)).toBeInTheDocument();
  });
});
