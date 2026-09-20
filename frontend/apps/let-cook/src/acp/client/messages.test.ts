import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityStore } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { PromptCorrelation, SessionEventDedupe } from "../session-events";
import type { InboundPipeline } from "./messages";
import { handleInboundMessages } from "./messages";

function pipeline(overrides: Partial<InboundPipeline> = {}): InboundPipeline {
  return {
    promptCorrelation: { accept: () => true } as unknown as InboundPipeline["promptCorrelation"],
    sessionEvents: { accept: () => true } as unknown as InboundPipeline["sessionEvents"],
    sessionUpdates: {
      enqueue: vi.fn(),
      flushNow: vi.fn(),
    } as unknown as InboundPipeline["sessionUpdates"],
    refreshPlanFiles: vi.fn(),
    refreshModels: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** A `session/update` for a subagent's own ACP session, carrying the child's turn ids. */
function childUpdate(update: Record<string, unknown>, eventSuffix: number) {
  return {
    method: "session/update",
    params: {
      sessionId: "child-s1",
      update,
      _meta: { promptId: "child-prompt", eventId: `child-s1-${eventSuffix}` },
    },
  } as const;
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

describe("a spawned agent's own session while this window's turn is open", () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    useSessionStore.getState().resetConversation("parent-s1");
  });

  function spawnChildRow() {
    useActivityStore.getState().upsertSubagent({
      id: "sa-1",
      kind: "subagent",
      name: "goal plan writer",
      status: "running",
      startedAt: Date.now(),
      childSessionId: "child-s1",
      sessionId: "parent-s1",
    });
  }

  it("reaches its row even when its updates carry the child's prompt id", async () => {
    // The window owns a prompt for the parent session only. The child's stream names the child's
    // own prompt, so the parent's correlation gate must not see it.
    const correlation = new PromptCorrelation();
    correlation.begin("parent-prompt");
    const inbound = pipeline({
      promptCorrelation: correlation,
      sessionEvents: new SessionEventDedupe(),
    });
    spawnChildRow();

    await handleInboundMessages(inbound, [
      childUpdate(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reading the goal" } },
        12,
      ),
      childUpdate(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "# Plan: ship it" } },
        14,
      ),
    ]);

    const child = useActivityStore.getState().childTranscripts["child-s1"];
    expect(child?.blocks).toHaveLength(2);
    expect(child?.blocks[1]).toMatchObject({ type: "message", role: "assistant", text: "# Plan: ship it" });
    expect(useSessionStore.getState().blocks).toHaveLength(0);
  });

  it("still enqueues the parent's own stream while the child is routed to its row", async () => {
    const correlation = new PromptCorrelation();
    correlation.begin("parent-prompt");
    const enqueue = vi.fn();
    const inbound = pipeline({
      promptCorrelation: correlation,
      sessionEvents: new SessionEventDedupe(),
      sessionUpdates: { enqueue, flushNow: vi.fn() } as unknown as InboundPipeline["sessionUpdates"],
    });
    spawnChildRow();

    await handleInboundMessages(inbound, [
      childUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child only" } }, 20),
      {
        method: "session/update",
        params: {
          sessionId: "parent-s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent text" } },
          _meta: { promptId: "parent-prompt" },
        },
      },
      childUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "more" } }, 22),
    ]);

    expect(useActivityStore.getState().childTranscripts["child-s1"]?.blocks).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ sessionId: "parent-s1" });
  });
});
