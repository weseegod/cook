import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchNotification, lookupNotification } from "../acp/notifications";
import { killTask } from "../acp/activity";
import {
  activityRows,
  applyTaskBackgrounded,
  applyTaskCompleted,
  useActivityStore,
} from "./activity";

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
