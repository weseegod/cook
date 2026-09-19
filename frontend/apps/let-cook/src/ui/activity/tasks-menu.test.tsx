import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requests: Array<{ method: string; params: unknown }> = [];

vi.mock("../../acp/host", () => ({
  request: vi.fn(async (method: string, params: unknown) => {
    requests.push({ method, params });
    if (method === "x.ai/task/list") return { tasks: [] };
    if (method === "x.ai/subagent/list_running") return { subagents: [] };
    return {};
  }),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => method,
}));

import { applyTaskBackgrounded, applyTaskCompleted, useActivityStore } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { TasksMenu } from "./tasks-menu";

const backgrounded = (sessionId: string, taskId: string, description: string) =>
  applyTaskBackgrounded({ sessionId, update: { task_id: taskId, command: "sleep 30", description } });

beforeEach(() => {
  useActivityStore.getState().reset();
  requests.length = 0;
  useSessionStore.getState().set({ sessionId: "s1" });
});

afterEach(() => cleanup());

function renderMenu() {
  return render(<TasksMenu menuRef={{ current: null }} />);
}

describe("TasksMenu", () => {
  it("lists the running work and never the finished rows", async () => {
    backgrounded("s1", "t-1", "Wait for server");
    applyTaskCompleted({ sessionId: "s1", update: { task_snapshot: { task_id: "t-1", exit_code: 0 } } });
    backgrounded("s1", "t-2", "Still running");
    renderMenu();

    await expect(screen.getByTestId("task-row-t-2")).toHaveTextContent("Still running");
    expect(screen.queryByTestId("task-row-t-1")).toBeNull();

    // The menu reconciles with the agent when it opens.
    await waitFor(() => expect(requests.some((entry) => entry.method === "x.ai/task/list")).toBe(true));
  });

  it("keeps a parked workflow on the list, since it has not finished", () => {
    useActivityStore.getState().upsertWorkflow({
      id: "wf-1",
      kind: "workflow",
      name: "audit",
      status: "paused",
      startedAt: Date.now(),
      sessionId: "s1",
    });
    renderMenu();
    expect(screen.getByTestId("task-row-wf-1")).toHaveAttribute("data-status", "paused");
  });

  it("says nothing is running once every row has settled", () => {
    backgrounded("s1", "t-1", "Wait for server");
    applyTaskCompleted({ sessionId: "s1", update: { task_snapshot: { task_id: "t-1", exit_code: 0 } } });
    renderMenu();
    expect(screen.queryByTestId("task-row-t-1")).toBeNull();
    expect(screen.getByText("No running tasks.")).toBeInTheDocument();
  });

  it("shows how long each task has been running", () => {
    backgrounded("s1", "t-1", "Wait for server");
    const row = useActivityStore.getState().tasks["t-1"];
    useActivityStore.getState().upsertTask({ ...row, startedAt: Date.now() - 65_000 });
    renderMenu();
    expect(screen.getByTestId("task-row-t-1").querySelector(".activity-elapsed")).toHaveTextContent("1m5s");
  });

  it("groups the sections once more than one kind is on screen", () => {
    backgrounded("s1", "t-1", "Wait for server");
    useActivityStore.getState().upsertSubagent({
      id: "sa-1",
      kind: "subagent",
      name: "Explore the repository",
      status: "running",
      startedAt: Date.now(),
      sessionId: "s1",
    });
    renderMenu();
    expect(screen.getByTestId("task-group-subagents")).toHaveTextContent("Subagents");
    expect(screen.getByTestId("task-group-tasks")).toHaveTextContent("Tasks");
  });

  it("stops a live row through the store", async () => {
    backgrounded("s1", "t-1", "Wait for server");
    renderMenu();
    fireEvent.click(screen.getByTestId("task-kill-t-1"));
    await waitFor(() => expect(requests.some((entry) => entry.method === "x.ai/task/kill")).toBe(true));
    expect(useActivityStore.getState().tasks["t-1"].status).toBe("killed");
  });

  it("says so when the conversation has nothing to list", () => {
    renderMenu();
    expect(screen.getByText("No background tasks or subagents.")).toBeInTheDocument();
  });
});
