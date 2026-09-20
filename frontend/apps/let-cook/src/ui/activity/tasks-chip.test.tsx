import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({
  request: vi.fn(async () => ({ tasks: [], subagents: [] })),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => method,
}));

import { applyTaskBackgrounded, applyTaskCompleted, useActivityStore } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { TasksChip } from "./tasks-chip";

const backgrounded = (sessionId: string, taskId: string, description: string) =>
  applyTaskBackgrounded({ sessionId, update: { task_id: taskId, command: "sleep 30", description } });

beforeEach(() => {
  useActivityStore.getState().reset();
  useSessionStore.getState().set({ sessionId: "s1" });
});

afterEach(() => cleanup());

describe("TasksChip", () => {
  it("renders nothing while the conversation has no tasks", () => {
    const { container } = render(<TasksChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the running work beside the label", () => {
    backgrounded("s1", "t-1", "Wait for server");
    backgrounded("s1", "t-2", "Second");
    render(<TasksChip />);
    expect(screen.getByTestId("tasks-chip")).toHaveTextContent("Tasks");
    expect(screen.getByTestId("tasks-chip-count")).toHaveTextContent("2");
  });

  it("counts nothing once the work is finished", () => {
    backgrounded("s1", "t-1", "Wait for server");
    applyTaskCompleted({ sessionId: "s1", update: { task_snapshot: { task_id: "t-1", exit_code: 0 } } });
    render(<TasksChip />);
    expect(screen.getByTestId("tasks-chip")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-chip-count")).toHaveTextContent("0");
  });

  it("stays hidden for another conversation's tasks", () => {
    backgrounded("s2", "t-9", "Theirs");
    const { container } = render(<TasksChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("adds the parked-workflow count beside the running one", () => {
    backgrounded("s1", "t-1", "Wait for server");
    useActivityStore.getState().upsertWorkflow({
      id: "wf-1",
      kind: "workflow",
      name: "audit",
      status: "paused",
      startedAt: Date.now(),
      sessionId: "s1",
    });
    render(<TasksChip />);
    expect(screen.getByTestId("tasks-chip-count")).toHaveTextContent("1");
    expect(screen.getByTestId("tasks-chip-paused")).toHaveTextContent("P 1");
  });

  it("opens the list under the chip and closes it again", () => {
    backgrounded("s1", "t-1", "Wait for server");
    render(<TasksChip />);
    const chip = screen.getByTestId("tasks-chip");
    expect(screen.queryByTestId("tasks-menu")).toBeNull();

    fireEvent.click(chip);
    expect(useActivityStore.getState().overlayOpen).toBe(true);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tasks-menu")).toBeInTheDocument();
    expect(screen.getByTestId("task-row-t-1")).toHaveTextContent("Wait for server");

    fireEvent.click(chip);
    expect(useActivityStore.getState().overlayOpen).toBe(false);
    expect(screen.queryByTestId("tasks-menu")).toBeNull();
  });

  it("carries nothing but the label and the count", () => {
    backgrounded("s1", "t-1", "Wait for server");
    const { container } = render(<TasksChip />);
    const chip = screen.getByTestId("tasks-chip");
    // The icon and the counts, and no open/close glyph of its own.
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
    expect(chip.textContent).toBe("Tasks1");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("closes when the click lands outside the chip and the list", () => {
    backgrounded("s1", "t-1", "Wait for server");
    render(<TasksChip />);
    fireEvent.click(screen.getByTestId("tasks-chip"));
    fireEvent.mouseDown(document.body);
    expect(useActivityStore.getState().overlayOpen).toBe(false);
  });
});
