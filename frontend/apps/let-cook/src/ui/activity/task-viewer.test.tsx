import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({
  request: vi.fn(async (method: string) => {
    if (method === "x.ai/subagent/get") {
      return { snapshot: { subagent_id: "sa-1", description: "Explore the repository", status: "running", tools_used: ["read", "search"] } };
    }
    if (method === "x.ai/task/list") return { tasks: [] };
    if (method === "x.ai/subagent/list_running") return { subagents: [] };
    return {};
  }),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => method,
}));

import { emptyTranscriptCursor, reduceTranscript, useSessionStore } from "../../state/session";
import { useActivityStore, type ActivityItem } from "../../state/activity";
import { TaskViewer } from "./task-viewer";

const viewing = (item: ActivityItem) => useActivityStore.getState().setViewing(item);

const task = (patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "t-1",
  kind: "task",
  name: "Wait for server",
  status: "running",
  startedAt: Date.now() - 5_000,
  detail: "sleep 30",
  ...patch,
});

beforeEach(() => {
  useActivityStore.getState().reset();
  useSessionStore.getState().set({ sessionId: "s1" });
});

afterEach(() => cleanup());

describe("TaskViewer", () => {
  it("renders nothing until a row asks for it", () => {
    const { container } = render(<TaskViewer />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a background command's stdout and what it is running", () => {
    viewing(task({ output: "listening on :1420\n" }));
    render(<TaskViewer />);

    expect(screen.getByTestId("task-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("task-viewer-command")).toHaveTextContent("sleep 30");
    expect(screen.getByTestId("task-viewer-output")).toHaveTextContent("listening on :1420");
    expect(screen.getByTestId("task-viewer-meta")).toHaveTextContent("running");
  });

  it("follows the stdout the store learns while it is open", async () => {
    viewing(task({ output: "one\n" }));
    render(<TaskViewer />);
    expect(screen.getByTestId("task-viewer-output")).toHaveTextContent("one");

    useActivityStore.getState().upsertTask(task({ output: "one\ntwo\n" }));
    await waitFor(() => expect(screen.getByTestId("task-viewer-output")).toHaveTextContent("two"));
  });

  it("says a running task has produced nothing yet, and notes a truncated log", () => {
    viewing(task({ outputFile: "/tmp/out.log", truncated: true }));
    render(<TaskViewer />);
    expect(screen.getByText("No output yet.")).toBeInTheDocument();
    expect(screen.getByText(/full log is at \/tmp\/out\.log/)).toBeInTheDocument();
  });

  it("paints a subagent's own transcript, not the parent chat's", () => {
    const transcript = reduceTranscript(
      { blocks: [], cursor: emptyTranscriptCursor() },
      { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Execute", kind: "execute", status: "in_progress", rawInput: { command: "cargo build" } },
    );
    useActivityStore.getState().setChildTranscript("child-1", transcript);
    viewing({ id: "sa-1", kind: "subagent", name: "Explore the repository", status: "running", startedAt: Date.now(), detail: "explore", childSessionId: "child-1" });
    render(<TaskViewer />);

    expect(screen.getByTestId("task-viewer-transcript")).toHaveTextContent("cargo build");
  });

  it("says nothing has streamed yet when this window attached late", () => {
    viewing({ id: "sa-1", kind: "subagent", name: "Explore", status: "running", startedAt: Date.now(), childSessionId: "child-missing" });
    render(<TaskViewer />);
    expect(screen.getByText("Nothing streamed to this window yet.")).toBeInTheDocument();
  });
});
