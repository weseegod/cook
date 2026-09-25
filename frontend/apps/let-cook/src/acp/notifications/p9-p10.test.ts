import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { dispatchNotification } from "./index";

describe("P9/P10 notification handlers", () => {
  beforeEach(() => {
    useCatalogStore.getState().setSessions([]);
    useSessionStore.getState().resetConversation("s1");
  });

  it("N-follow stores suggestion chips", async () => {
    await dispatchNotification(
      { method: "x.ai/follow_ups", params: {} },
      "x.ai/follow_ups",
      {
        response_id: "resp-1",
        suggestions: [{ label: "Summarize next steps" }, { label: "  " }, { label: "Open tests" }],
      },
    );
    expect(useSessionStore.getState().followUps).toEqual({
      responseId: "resp-1",
      suggestions: ["Summarize next steps", "Open tests"],
    });
  });

  it("N-queue stores entry list and count", async () => {
    await dispatchNotification(
      { method: "x.ai/queue/changed", params: {} },
      "x.ai/queue/changed",
      {
        sessionId: "s1",
        entries: [
          { id: "p1", version: 2, text: "fix the flake", kind: "prompt", position: 0 },
          { id: "p2", version: 0, text: "run tests", kind: "prompt", position: 1 },
        ],
      },
    );
    const state = useSessionStore.getState();
    expect(state.queuedPromptCount).toBe(2);
    expect(state.queuedEntries).toEqual([
      { id: "p1", version: 2, text: "fix the flake", kind: "prompt", position: 0 },
      { id: "p2", version: 0, text: "run tests", kind: "prompt", position: 1 },
    ]);
  });

  it("ignores queue snapshots from another session", async () => {
    await dispatchNotification(
      { method: "x.ai/queue/changed", params: {} },
      "x.ai/queue/changed",
      { sessionId: "other-session", entries: [{ id: "foreign", version: 0, text: "other" }] },
    );
    expect(useSessionStore.getState().queuedEntries).toEqual([]);
  });

  it("N-interject appends a user row for foreign broadcasts", async () => {
    useSessionStore.setState({
      transcriptCursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
      blocks: [],
    });
    await dispatchNotification(
      { method: "x.ai/session/interjection", params: {} },
      "x.ai/session/interjection",
      { sessionId: "s1", text: "steer left", interjectionId: "other-pane" },
    );
    expect(useSessionStore.getState().blocks.at(-1)).toMatchObject({
      type: "message",
      role: "user",
      text: "steer left",
      turnId: "turn-1",
    });
  });

  it("ignores a late prompt_complete for the turn replaced by Send now", async () => {
    useSessionStore.getState().appendOptimisticUser("first", [], "prompt-first");
    useSessionStore.getState().appendOptimisticUser("send now", [], "prompt-second");
    useSessionStore.getState().set({ turnRunning: true });
    const before = useSessionStore.getState();
    await dispatchNotification(
      { method: "x.ai/session/prompt_complete", params: {} },
      "x.ai/session/prompt_complete",
      { sessionId: "s1", promptId: "prompt-first", stopReason: "cancelled" },
    );
    const after = useSessionStore.getState();
    expect(after.turnRunning).toBe(true);
    expect(after.currentPromptId).toBe("prompt-second");
    expect(after.transcriptCursor).toEqual(before.transcriptCursor);
  });

  it("N-settings invalidates providers and skills queries", async () => {
    const { queryClient } = await import("../../state/query-client");
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await dispatchNotification(
      { method: "x.ai/settings/update", params: {} },
      "x.ai/settings/update",
      {},
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["providers"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["skills"] });
    spy.mockRestore();
  });

  it("N-sessions invalidates sessions query", async () => {
    const { queryClient } = await import("../../state/query-client");
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await dispatchNotification(
      { method: "x.ai/sessions/changed", params: {} },
      "x.ai/sessions/changed",
      { upserted: [], removed: [] },
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    spy.mockRestore();
  });
});
