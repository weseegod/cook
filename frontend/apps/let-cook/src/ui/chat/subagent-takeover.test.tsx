import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({
  request: vi.fn(async (method: string) => {
    if (method === "x.ai/task/list") return { tasks: [] };
    return {};
  }),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => method,
}));

import { request } from "../../acp/host";
import { emptyTranscriptCursor, reduceTranscript, useSessionStore } from "../../state/session";
import { useActivityStore, type ActivityItem } from "../../state/activity";
import { SubagentTakeover, subagentTitle } from "./subagent-takeover";

/** Push child updates through the same reducer the wire feeds, under the child session id. */
const pushChild = (childSessionId: string, updates: Array<Record<string, unknown>>) => {
  const previous = useActivityStore.getState().childTranscripts[childSessionId]
    ?? { blocks: [], cursor: emptyTranscriptCursor() };
  useActivityStore.getState().setChildTranscript(
    childSessionId,
    updates.reduce((transcript, update) => reduceTranscript(transcript, update), previous),
  );
};

const row = (patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "sa-1",
  kind: "subagent",
  name: "Explore the repository",
  status: "running",
  startedAt: Date.now() - 5_000,
  detail: "explore",
  childSessionId: "child-1",
  ...patch,
});

const view = (item: ActivityItem) => useActivityStore.getState().setViewing(item);
const transcript = () => document.querySelector(".transcript")!;

beforeEach(() => {
  useActivityStore.getState().reset();
  useSessionStore.getState().set({ sessionId: "s1" });
  vi.mocked(request).mockClear();
});

afterEach(() => cleanup());

describe("SubagentTakeover", () => {
  it("renders nothing until a subagent row asks for it", () => {
    const { container } = render(<SubagentTakeover />);
    expect(container).toBeEmptyDOMElement();
  });

  it("paints the child's own transcript with the chat's rows, not a reduced copy", () => {
    pushChild("child-1", [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Looking around" } },
      { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read src/a.ts", kind: "read", status: "completed", rawInput: {} },
      { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Execute", kind: "execute", status: "completed", rawInput: { command: "cargo build" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The plan is **short**." } },
    ]);
    view(row());
    render(<SubagentTakeover />);

    expect(screen.getByTestId("subagent-takeover")).toBeInTheDocument();
    // The parent chat's own rows: foldable reads collapse, an Execute keeps its own row, and
    // assistant prose goes through the markdown renderer.
    expect(transcript().querySelector(".verb-group")).not.toBeNull();
    expect(transcript().querySelector(".tool-row")).not.toBeNull();
    expect(transcript().querySelector(".message-assistant .markdown")).not.toBeNull();
    expect(transcript().textContent).toContain("Read 1 file");
    expect(transcript().textContent).toContain("cargo build");
    expect(transcript().querySelector(".message-assistant .markdown")!.textContent).toContain("The plan is");
  });

  it("keeps a still-streaming thinking row, the way the parent transcript does", () => {
    pushChild("child-1", [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Weighing options" } },
    ]);
    view(row());
    render(<SubagentTakeover />);
    expect(transcript().querySelector(".thinking-row")).not.toBeNull();
  });

  it("follows the child stream while the agent is still generating", async () => {
    pushChild("child-1", [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Step one." } }]);
    view(row());
    render(<SubagentTakeover />);
    expect(transcript()).toHaveTextContent("Step one.");

    pushChild("child-1", [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Step two." } }]);
    await waitFor(() => expect(transcript()).toHaveTextContent("Step two."));
  });

  it("shows the child's phase on the chat's own status row", () => {
    pushChild("child-1", [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Writing it up" } }]);
    view(row());
    render(<SubagentTakeover />);
    expect(screen.getByTestId("turn-status")).toHaveTextContent("Responding");
  });

  it("labels the frame the way the TUI does and strips a bracketed tag", () => {
    view(row({ name: "[goal] Draft the implementation plan", detail: "plan" }));
    render(<SubagentTakeover />);

    const frame = screen.getByTestId("subagent-frame");
    expect(frame).toHaveTextContent("Plan");
    expect(frame).toHaveTextContent("Draft the implementation plan");
  });

  it("capitalizes a general-purpose child under the TUI's `general` label", () => {
    expect(subagentTitle(row({ detail: "general-purpose", name: "Write the report" })))
      .toEqual({ label: "General", description: "Write the report" });
    expect(subagentTitle(row({ detail: undefined, name: "[research] Dig into it" })))
      .toEqual({ label: "Research", description: "Dig into it" });
  });

  it("leaves the child no prompt of its own, the way the TUI's takeover has none", () => {
    view(row());
    render(<SubagentTakeover />);
    expect(screen.queryByLabelText("Message this agent")).toBeNull();
    expect(vi.mocked(request)).not.toHaveBeenCalledWith("x.ai/subagent/message", expect.anything());
  });

  it("parks a settled child: no streaming tail and no live status row", () => {
    pushChild("child-1", [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } }]);
    view(row({ status: "completed", endedAt: Date.now(), activityLabel: "Responding" }));
    render(<SubagentTakeover />);

    expect(transcript()).toHaveTextContent("All done.");
    // The wire never closed the child's turn, so the view must not keep painting it as live.
    expect(transcript().querySelector(".streaming-tail")).toBeNull();
    expect(screen.queryByTestId("turn-status")).toBeNull();
  });

  it("closes on Escape", async () => {
    view(row());
    render(<SubagentTakeover />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useActivityStore.getState().viewing).toBeNull());
  });
});
