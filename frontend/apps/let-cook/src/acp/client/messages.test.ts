import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../state/session";
import type { InboundPipeline } from "./messages";
import { handleInboundMessages } from "./messages";

function pipeline(): InboundPipeline {
  return {
    promptCorrelation: { accept: () => true } as InboundPipeline["promptCorrelation"],
    sessionEvents: { accept: () => true } as InboundPipeline["sessionEvents"],
    sessionUpdates: {
      enqueue: vi.fn(),
      flushNow: vi.fn(),
    } as unknown as InboundPipeline["sessionUpdates"],
    refreshPlanFiles: vi.fn(),
    refreshModels: vi.fn(async () => undefined),
  };
}

function goalUpdate(planning: boolean, lastEvent = "planning_started") {
  return {
    method: "x.ai/session_notification",
    params: {
      sessionId: "session-goal-plan",
      update: {
        sessionUpdate: "goal_updated",
        goal_id: "goal-1",
        status: "active",
        planning,
        last_event: lastEvent,
      },
    },
  } as const;
}

describe("goal plan-file refresh", () => {
  beforeEach(() => {
    useSessionStore.getState().resetConversation("session-goal-plan");
  });

  it("refreshes when the planner planning latch clears", async () => {
    const inbound = pipeline();

    await handleInboundMessages(inbound, [goalUpdate(true)]);
    expect(inbound.refreshPlanFiles).not.toHaveBeenCalled();

    await handleInboundMessages(inbound, [goalUpdate(false, "planning_completed")]);
    expect(inbound.refreshPlanFiles).toHaveBeenCalledTimes(1);
  });

  it("refreshes goal creation so a seeded episode appears without opening the menu", async () => {
    const inbound = pipeline();

    await handleInboundMessages(inbound, [goalUpdate(false, "goal_created")]);

    expect(inbound.refreshPlanFiles).toHaveBeenCalledTimes(1);
  });
});
