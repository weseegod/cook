import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "../../state/session";
import { noteBackgroundActivity, trackWorking } from "./state";

describe("trackWorking", () => {
  beforeEach(() => {
    useSessionStore.setState({ workingSessions: {} });
  });

  it("keeps the row and startedAt when an earlier prompt ends while another is still in flight", () => {
    const startedAt = 1_000;
    trackWorking("s1", startedAt, "p1");
    trackWorking("s1", 5_000, "p2");
    expect(useSessionStore.getState().workingSessions.s1).toEqual({
      startedAt,
      activity: null,
      promptIds: ["p1", "p2"],
    });

    trackWorking("s1", null, "p1");
    expect(useSessionStore.getState().workingSessions.s1).toEqual({
      startedAt,
      activity: null,
      promptIds: ["p2"],
    });

    trackWorking("s1", null, "p2");
    expect(useSessionStore.getState().workingSessions.s1).toBeUndefined();
  });

  it("does not let a second prompt overwrite startedAt", () => {
    trackWorking("s1", 100, "first");
    trackWorking("s1", 999, "second");
    expect(useSessionStore.getState().workingSessions.s1?.startedAt).toBe(100);
  });

  it("clears the whole entry when releasing without a prompt id", () => {
    trackWorking("s1", 100, "p1");
    trackWorking("s1", 100, "p2");
    trackWorking("s1", null);
    expect(useSessionStore.getState().workingSessions.s1).toBeUndefined();
  });

  it("is a no-op when releasing a prompt id that is already gone", () => {
    trackWorking("s1", 100, "p1");
    trackWorking("s1", null, "p1");
    trackWorking("s1", null, "p1");
    expect(useSessionStore.getState().workingSessions.s1).toBeUndefined();
  });
});

describe("noteBackgroundActivity", () => {
  beforeEach(() => {
    useSessionStore.setState({ workingSessions: {} });
  });

  it("does not recreate a cleared working row", () => {
    trackWorking("s1", 100, "p1");
    trackWorking("s1", null, "p1");
    noteBackgroundActivity(
      { sessionId: "s1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
    );
    expect(useSessionStore.getState().workingSessions.s1).toBeUndefined();
  });

  it("updates activity on an existing row with a functional set", () => {
    trackWorking("s1", 100, "p1");
    noteBackgroundActivity(
      { sessionId: "s1" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "execute",
        status: "pending",
        rawInput: { command: "pnpm test" },
      },
    );
    const turn = useSessionStore.getState().workingSessions.s1;
    expect(turn?.startedAt).toBe(100);
    expect(turn?.promptIds).toEqual(["p1"]);
    expect(turn?.activity).toMatchObject({ kind: "tool" });
  });
});
