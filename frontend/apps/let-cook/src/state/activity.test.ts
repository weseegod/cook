import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchNotification, lookupNotification } from "../acp/notifications";
import { killTask } from "../acp/activity";
import {
  activityRows,
  applySubagentSessionUpdate,
  applyTaskBackgrounded,
  applyTaskCompleted,
  conversationRows,
  pausedWorkflowCount,
  runningCount,
  useActivityStore,
} from "./activity";
import { useSessionStore } from "./session";

vi.mock("../acp/host", () => ({
  request: vi.fn(async (method: string, params: unknown) => {
    (globalThis as { __activityRequests?: Array<{ method: string; params: unknown }> }).__activityRequests ??= [];
    (globalThis as { __activityRequests?: Array<{ method: string; params: unknown }> }).__activityRequests!.push({
      method,
      params,
    });
    if (method === "x.ai/task/kill") return { taskId: (params as { taskId: string }).taskId, outcome: { kind: "killed" } };
    if (method === "x.ai/task/list") return { tasks: [] };
    if (method === "x.ai/subagent/list_running") return { subagents: [] };
    return {};
  }),
  unwrapExtResult: <T,>(value: T) => value,
  wireMethod: (method: string) => (method.startsWith("x.ai/") ? `_${method}` : method),
}));

describe("activity store (P4)", () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    (globalThis as { __activityRequests?: unknown }).__activityRequests = [];
  });

  it("registers N-tbg for task_backgrounded (not N-tdone)", () => {
    expect(lookupNotification("x.ai/task_backgrounded")?.mapId).toBe("N-tbg");
    expect(lookupNotification("x.ai/task_completed")?.mapId).toBe("N-tdone");
    expect(lookupNotification("x.ai/scheduled_task_created")?.mapId).toBe("N-sched-c");
    expect(lookupNotification("x.ai/monitor_event")?.mapId).toBe("N-mon");
  });

  it("injects a row from task_backgrounded and completes on task_completed", async () => {
    await dispatchNotification(
      { method: "x.ai/task_backgrounded", params: {} },
      "x.ai/task_backgrounded",
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "task_backgrounded",
          task_id: "task-bg-1",
          command: "pnpm test",
          description: "Run tests",
          cwd: "/tmp",
          output_file: "/tmp/out.log",
          tool_call_id: "tc-1",
        },
      },
    );
    expect(useActivityStore.getState().tasks["task-bg-1"]).toMatchObject({
      name: "Run tests",
      status: "running",
      kind: "task",
    });
    expect(activityRows().some((row) => row.id === "task-bg-1" && row.status === "running")).toBe(true);

    await dispatchNotification(
      { method: "x.ai/task_completed", params: {} },
      "x.ai/task_completed",
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "task_completed",
          task_snapshot: {
            task_id: "task-bg-1",
            command: "pnpm test",
            description: "Run tests",
            completed: true,
            exit_code: 0,
          },
        },
      },
    );
    expect(useActivityStore.getState().tasks["task-bg-1"].status).toBe("completed");
  });

  it("kill calls x.ai/task/kill", async () => {
    applyTaskBackgrounded({
      update: {
        task_id: "kill-me",
        command: "sleep 99",
        description: "Long sleep",
      },
    });
    const row = useActivityStore.getState().tasks["kill-me"];
    await useActivityStore.getState().killActivity("session-1", row);
    const requests = (globalThis as { __activityRequests?: Array<{ method: string; params: unknown }> }).__activityRequests ?? [];
    expect(requests).toContainEqual({
      method: "x.ai/task/kill",
      params: { sessionId: "session-1", taskId: "kill-me" },
    });
    expect(useActivityStore.getState().tasks["kill-me"].status).toBe("killed");
  });

  it("exposes killTask wrapper with camelCase params", async () => {
    await killTask("s1", "t1", "clientUi");
    const requests = (globalThis as { __activityRequests?: Array<{ method: string; params: unknown }> }).__activityRequests ?? [];
    expect(requests.at(-1)).toEqual({
      method: "x.ai/task/kill",
      params: { sessionId: "s1", taskId: "t1", source: "clientUi" },
    });
  });

  it("applies flat completed payloads without nested update", () => {
    applyTaskBackgrounded({ task_id: "flat-1", command: "echo hi", description: "Echo" });
    applyTaskCompleted({
      task_snapshot: { task_id: "flat-1", exit_code: 1, command: "echo hi" },
    });
    expect(useActivityStore.getState().tasks["flat-1"].status).toBe("failed");
  });
});

describe("activity rows belong to a conversation", () => {
  const backgrounded = (sessionId: string, taskId: string, description: string) =>
    applyTaskBackgrounded({ sessionId, update: { task_id: taskId, command: "sleep 30", description } });

  beforeEach(() => {
    useActivityStore.getState().reset();
  });

  it("stamps the envelope's session and keeps other conversations out of the list", () => {
    backgrounded("s1", "t-1", "Mine");
    backgrounded("s2", "t-2", "Theirs");
    expect(useActivityStore.getState().tasks["t-1"].sessionId).toBe("s1");
    expect(conversationRows("s1").map((row) => row.id)).toEqual(["t-1"]);
    expect(conversationRows("s2").map((row) => row.id)).toEqual(["t-2"]);
  });

  it("survives a completion that carries no session of its own", () => {
    backgrounded("s1", "t-1", "Mine");
    applyTaskCompleted({ update: { task_snapshot: { task_id: "t-1", exit_code: 0 } } });
    expect(useActivityStore.getState().tasks["t-1"]).toMatchObject({ sessionId: "s1", status: "completed" });
  });

  it("stamps subagent updates from the session envelope", () => {
    applySubagentSessionUpdate(
      { sessionUpdate: "subagent_spawned", subagent_id: "sa-1", description: "scan src/" },
      "s1",
    );
    expect(conversationRows("s1").map((row) => row.id)).toEqual(["sa-1"]);
    expect(conversationRows("s2")).toEqual([]);
  });

  it("keeps a legacy row with no owner visible, and lists nothing without a conversation", () => {
    applyTaskBackgrounded({ task_id: "flat-1", command: "echo hi", description: "Echo" });
    expect(conversationRows("s1").map((row) => row.id)).toEqual(["flat-1"]);
    expect(conversationRows(null)).toEqual([]);
  });

  it("counts only the rows still in flight", () => {
    backgrounded("s1", "t-1", "Mine");
    backgrounded("s1", "t-2", "Also mine");
    expect(runningCount(conversationRows("s1"))).toBe(2);
    applyTaskCompleted({ sessionId: "s1", update: { task_snapshot: { task_id: "t-1", exit_code: 0 } } });
    expect(runningCount(conversationRows("s1"))).toBe(1);
  });

  it("counts workflows parked mid-run, not the active or terminal ones", () => {
    const workflow = (id: string, status: string) =>
      useActivityStore.getState().upsertWorkflow({ id, kind: "workflow", name: id, status, startedAt: 0, sessionId: "s1" });
    workflow("wf-active", "active");
    workflow("wf-paused", "paused");
    workflow("wf-parked", "budget");
    workflow("wf-done", "complete");
    expect(pausedWorkflowCount(conversationRows("s1"))).toBe(2);
  });

  it("reset drops the rows and closes the strip", () => {
    backgrounded("s1", "t-1", "Mine");
    useActivityStore.getState().setOverlayOpen(true);
    useActivityStore.getState().reset();
    expect(activityRows()).toEqual([]);
    expect(useActivityStore.getState().overlayOpen).toBe(false);
  });

  it("hides a previous conversation's rows without dropping them", () => {
    backgrounded("s1", "t-1", "Mine");
    useSessionStore.getState().resetConversation("s2");
    expect(conversationRows("s2")).toEqual([]);
    // Switching back still finds the work the first conversation left behind.
    useSessionStore.getState().resetConversation("s1");
    expect(conversationRows("s1").map((row) => row.id)).toEqual(["t-1"]);
  });
});
