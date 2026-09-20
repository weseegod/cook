import { state } from "../state";
import type { MethodHandler } from "./registry";

export const taskHandlers: Record<string, MethodHandler> = {
  "x.ai/task/list": ({ p, respond }) => {
    return respond({
      result: {
        tasks: (state.tasks ?? []).filter((task) => !p.sessionId || task.owner_session_id === p.sessionId || !task.owner_session_id),
      },
    });
  },
  "x.ai/task/kill": ({ p, respond }) => {
    const taskId = String(p.taskId ?? "");
    state.tasks = (state.tasks ?? []).map((task) =>
      task.task_id === taskId ? { ...task, completed: true, explicitly_killed: true, exit_code: null } : task,
    );
    return respond({ result: { taskId, outcome: { kind: "killed" } } });
  },
  "x.ai/subagent/list_running": ({ respond }) => {
    return respond({ result: { subagents: state.subagents ?? [] } });
  },
  "x.ai/subagent/get": ({ p, respond }) => {
    const id = String(p.subagentId ?? "");
    const snap = (state.subagents ?? []).find((row) => row.subagent_id === id) ?? null;
    return respond({ result: { snapshot: snap } });
  },
  "x.ai/subagent/cancel": ({ p, respond }) => {
    return respond({ result: { subagentId: p.subagentId, cancelled: true, outcome: { kind: "cancelled" } } });
  },
  "x.ai/subagent/message": ({ respond }) => {
    return respond({ result: { ok: true } });
  },
  "x.ai/scheduler/delete": ({ p, respond }) => {
    const taskId = String(p.taskId ?? "");
    state.schedules = (state.schedules ?? []).filter((row) => row.task_id !== taskId);
    return respond({ result: { taskId, deleted: true } });
  },
};
