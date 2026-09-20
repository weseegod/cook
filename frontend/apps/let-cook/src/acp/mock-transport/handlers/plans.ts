import { state } from "../state";
import type { MethodHandler } from "./registry";

export const planHandlers: Record<string, MethodHandler> = {
  "x.ai/session/plans": ({ respond }) => {
    if (state.planListUnsupported) {
      return respond({ error: { code: -32601, message: "Method not found", data: "unknown ACP extension method: x.ai/session/plans" } });
    }
    return respond({ plans: state.planFiles });
  },
  "x.ai/session/plans/delete": ({ p, respond }) => {
    const path = String(p.path ?? "");
    const file = state.planFiles.find((plan) => plan.path === path);
    // The agent refuses the file its running episode is holding; mirror that refusal here.
    if (!file) return respond({ error: `${path} no longer exists` });
    if (!file.deletable) {
      return respond({ error: `${file.name} is the current plan and cannot be deleted while plan mode is on` });
    }
    state.planFiles = state.planFiles.filter((plan) => plan.path !== path);
    return respond({ deleted: true });
  },
};
