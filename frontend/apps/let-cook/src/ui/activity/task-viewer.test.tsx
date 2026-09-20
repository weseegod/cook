import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({
  request: vi.fn(async (method: string) => {
    if (method === "x.ai/task/list") return { tasks: [] };
    return {};
  }),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => method,
}));

import { emptyTranscriptCursor, useSessionStore } from "../../state/session";
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
  it("renders nothing until a background task asks for it", () => {
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
    expect(screen.getByTestId("dialog-hide")).toHaveAccessibleName("Hide task");
    expect(screen.queryByTestId("dialog-close")).toBeNull();
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

  it("leaves a subagent to its own session view instead of painting a reduced transcript", () => {
    // The child's own view is ChatView's `SubagentTakeover`; this viewer is stdout only.
    useActivityStore.getState().setChildTranscript("child-1", { blocks: [], cursor: emptyTranscriptCursor() });
    viewing({ id: "sa-1", kind: "subagent", name: "Explore", status: "running", startedAt: Date.now(), childSessionId: "child-1" });
    const { container } = render(<TaskViewer />);
    expect(container).toBeEmptyDOMElement();
  });
});
