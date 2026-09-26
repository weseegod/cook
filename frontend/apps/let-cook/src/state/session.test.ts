import { describe, expect, it } from "vitest";
import { useActivityStore } from "./activity";
import {
  reduceTranscript,
  turnElapsedMs,
  turnMarkerText,
  useSessionStore,
  type MessageBlock,
  type TranscriptState,
} from "./session";

const empty = (): TranscriptState => ({
  blocks: [],
  cursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
});

describe("session defaults", () => {
  it("starts with Always approve enabled", () => {
    expect(useSessionStore.getState().alwaysApprove).toBe(true);
  });
});

describe("session conversation reset", () => {
  it("drops the previous session's plan files and its open plan view", () => {
    useSessionStore.setState({
      planFiles: [{
        name: "2026-09-19T14-30-22Z.md",
        title: "Plan",
        path: "/p/plans/2026-09-19T14-30-22Z.md",
        relativePath: "plans/2026-09-19T14-30-22Z.md",
        sizeBytes: 10,
        modifiedMs: 1,
        active: true,
        deletable: false,
        content: "# Plan",
      }],
      planFileView: null,
    });

    useSessionStore.getState().resetConversation("sess-2");

    expect(useSessionStore.getState().planFiles).toEqual([]);
    expect(useSessionStore.getState().planFileView).toBeNull();
  });

  it("clears plan mode so a new conversation does not inherit the previous session's mode chrome", () => {
    useSessionStore.setState({ planMode: true, sessionId: "sess-plan" });
    useSessionStore.getState().resetConversation("sess-new");
    expect(useSessionStore.getState()).toMatchObject({
      sessionId: "sess-new",
      planMode: false,
    });
  });

    it("clears the session id on a null reset so a workspace reconnect cannot prompt a dead id", () => {
      useSessionStore.setState({
        sessionId: "dead-session",
        turnRunning: true,
        workingSessions: { "dead-session": { startedAt: Date.now(), activity: null, promptIds: [] } },
        editingQueueEntry: { id: "q1", version: 0 },
      });
      useSessionStore.getState().resetConversation(null);
      expect(useSessionStore.getState().sessionId).toBeNull();
      expect(useSessionStore.getState().turnRunning).toBe(false);
      expect(useSessionStore.getState().planMode).toBe(false);
      expect(useSessionStore.getState().editingQueueEntry).toBeNull();
    });

  it("restores that session's queue on reset and leaves other sessions' queues alone", () => {
    useSessionStore.setState({
      sessionId: "sess-a",
      queuesBySession: {
        "sess-a": [{ id: "qa", version: 0, text: "queued on A", kind: "prompt", position: 0 }],
        "sess-b": [{ id: "qb", version: 1, text: "queued on B", kind: "prompt", position: 0 }],
      },
      queuedEntries: [{ id: "qa", version: 0, text: "queued on A", kind: "prompt", position: 0 }],
      queuedPromptCount: 1,
    });
    useSessionStore.getState().resetConversation("sess-b");
    expect(useSessionStore.getState().queuedEntries).toEqual([
      { id: "qb", version: 1, text: "queued on B", kind: "prompt", position: 0 },
    ]);
    expect(useSessionStore.getState().queuedPromptCount).toBe(1);
    expect(useSessionStore.getState().queuesBySession["sess-a"]).toHaveLength(1);
    useSessionStore.getState().resetConversation("sess-c");
    expect(useSessionStore.getState().queuedEntries).toEqual([]);
    expect(useSessionStore.getState().queuedPromptCount).toBe(0);
    expect(useSessionStore.getState().queuesBySession["sess-a"]).toHaveLength(1);
    expect(useSessionStore.getState().queuesBySession["sess-b"]).toHaveLength(1);
  });
});

describe("session transcript reducer", () => {
  it("tracks model and reasoning effort changes from the agent", () => {
    const state = useSessionStore.getState();
    const previousModelId = state.modelId;
    const previousReasoningEffort = state.reasoningEffort;
    state.set({ modelId: "gpt-4.1", reasoningEffort: "low" });
    state.applyNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "model_changed",
        model_id: "o4-mini",
        reasoning_effort: "high",
      },
    } as never);

    expect(useSessionStore.getState()).toMatchObject({ modelId: "o4-mini", reasoningEffort: "high" });
    useSessionStore.getState().set({ modelId: previousModelId, reasoningEffort: previousReasoningEffort });
  });

  it("coalesces streamed assistant chunks without a message id", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello " },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    expect(transcript.blocks).toMatchObject([
      { type: "message", role: "assistant", text: "hello world", streaming: true },
    ]);
  });

  it("starts a new assistant segment after a tool phase", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I will inspect it." },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read src/main.ts",
      kind: "read",
      status: "pending",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The issue is here." },
    });
    expect(transcript.blocks.map((block) => block.type)).toEqual(["message", "tool", "message"]);
    expect(transcript.blocks[0]).toMatchObject({ text: "I will inspect it.", streaming: false });
    expect(transcript.blocks[2]).toMatchObject({ text: "The issue is here.", streaming: true });
    expect(new Set(transcript.blocks.map((block) => block.turnId))).toEqual(new Set(["turn-1"]));
  });

  it("updates a tool card in place", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      status: "pending",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "pnpm test",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(transcript.blocks).toHaveLength(1);
    expect(transcript.blocks[0]).toMatchObject({ type: "tool", title: "pnpm test", status: "completed" });
  });

  it("keeps tool timing and extracts command/path metadata across updates", () => {
    const before = Date.now();
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "pnpm test", path: "frontend/apps/let-cook" },
      status: "pending",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      elapsedMs: 420,
    });
    expect(transcript.blocks[0]).toMatchObject({
      command: "pnpm test",
      paths: ["frontend/apps/let-cook"],
      elapsedMs: 420,
    });
    expect((transcript.blocks[0] as { startedAt: number }).startedAt).toBeGreaterThanOrEqual(before);
  });

  it("coalesces tool output deltas instead of spamming output rows", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run command",
      status: "pending",
    });
    transcript = reduceTranscript(transcript, { sessionUpdate: "tool_call_update", toolCallId: "t1", outputDelta: "one\n" });
    transcript = reduceTranscript(transcript, { sessionUpdate: "tool_call_update", toolCallId: "t1", outputDelta: "two\n" });
    expect(transcript.blocks[0]).toMatchObject({ content: [{ content: { text: "one\ntwo\n" } }] });
  });

  it("does not break a resumed assistant stream on a late tool update", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      status: "pending",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The answer " },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "continues." },
    });
    expect(transcript.blocks.filter((block) => block.type === "message")).toMatchObject([
      { text: "The answer continues.", streaming: true },
    ]);
  });

  it("adopts an optimistic user message instead of duplicating it", () => {
    const transcript: TranscriptState = {
      blocks: [{ type: "message", id: "local-1", turnId: "turn-1", role: "user", text: "hello", images: [], streaming: false }],
      cursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: "local-1" },
    };
    const next = reduceTranscript(transcript, {
      sessionUpdate: "user_message_chunk",
      messageId: "server-1",
      content: { type: "text", text: "hello" },
    });
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ id: "server-1", text: "hello" });
  });

  it("keeps echoed user content parts in one optimistic prompt", () => {
    const transcript: TranscriptState = {
      blocks: [{ type: "message", id: "local-1", turnId: "turn-1", role: "user", text: "look", images: [], streaming: false }],
      cursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: "local-1" },
    };
    let next = reduceTranscript(transcript, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "look" },
    });
    next = reduceTranscript(next, {
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "AAAA" },
    });
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ text: "look", images: ["data:image/png;base64,AAAA"] });
  });

  it("renders an image content part as a data URL", () => {
    const next = reduceTranscript(empty(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", mimeType: "image/webp", data: "AAAA" },
    });
    expect(next.blocks[0]).toMatchObject({
      type: "message",
      role: "assistant",
      text: "",
      images: ["data:image/webp;base64,AAAA"],
    });
  });

  it("appends an image to an existing streamed message", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "here" },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "QQ==" },
    });
    expect(transcript.blocks).toHaveLength(1);
    expect(transcript.blocks[0]).toMatchObject({ text: "here", images: ["data:image/png;base64,QQ=="] });
  });

  it("removes an active plan", () => {
    const transcript = reduceTranscript(empty(), { sessionUpdate: "plan", planId: "p1", entries: [] });
    expect(reduceTranscript(transcript, { sessionUpdate: "plan_removed", planId: "p1" }).blocks).toEqual([]);
  });
});

describe("thinking segments", () => {
  it("opens a thinking row, then freezes it when assistant prose starts", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Considering the boundary" },
    });
    expect(transcript.blocks[0]).toMatchObject({ role: "thought", streaming: true });
    expect((transcript.blocks[0] as MessageBlock).startedAt).toBeTypeOf("number");

    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The answer" },
    });
    expect(transcript.blocks.map((block) => block.type)).toEqual(["message", "message"]);
    expect(transcript.blocks[0]).toMatchObject({ role: "thought", streaming: false });
    expect((transcript.blocks[0] as MessageBlock).elapsedMs).not.toBeNull();
    expect(transcript.blocks[1]).toMatchObject({ role: "assistant", text: "The answer", streaming: true });
  });

  it("drops an empty thinking row instead of showing Thought for 0.0s", () => {
    const transcript: TranscriptState = {
      blocks: [{ type: "message", id: "thought-1", turnId: "turn-1", role: "thought", text: "   ", images: [], streaming: true }],
      cursor: { turnId: "turn-1", assistantId: null, thoughtId: "thought-1", optimisticUserId: null },
    };
    const next = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer" },
    });
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ role: "assistant" });
  });

  it("closes prose and thinking on a tool call without cancelling sibling tools", () => {
    let transcript = reduceTranscript(empty(), {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking about it" },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Reading now" },
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read a.ts",
      status: "pending",
    });
    transcript = reduceTranscript(transcript, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Read b.ts",
      status: "pending",
    });
    expect(transcript.blocks.map((block) => block.type)).toEqual(["message", "message", "tool", "tool"]);
    expect(transcript.blocks[0]).toMatchObject({ role: "thought", streaming: false });
    expect(transcript.blocks[1]).toMatchObject({ role: "assistant", streaming: false });
    // A parallel burst keeps both tools pending; only turn finalize cancels leftovers.
    expect(transcript.blocks[2]).toMatchObject({ status: "pending" });
    expect(transcript.blocks[3]).toMatchObject({ status: "pending" });
  });
});

describe("turn markers", () => {
  it("formats the TUI marker strings", () => {
    expect(turnMarkerText({ kind: "completed" }, 5_200)).toBe("Worked for 5.2s");
    expect(turnMarkerText({ kind: "completed" }, null)).toBe("Turn completed.");
    expect(turnMarkerText({ kind: "cancelled" }, 1_500)).toBe("Turn cancelled by user in 1.5s.");
    expect(turnMarkerText({ kind: "cancelled", phrase: "Turn cancelled because the session closed" }, null))
      .toBe("Turn cancelled because the session closed.");
    expect(turnMarkerText({ kind: "failed", error: "provider 500" }, 32_000)).toBe("Turn failed in 32s: provider 500");
    expect(turnMarkerText({ kind: "failed" }, null)).toBe("Turn failed: unknown error");
  });

  it("appends one marker per turn and never twice", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-1");
    useSessionStore.getState().appendOptimisticUser("hello");
    useSessionStore.getState().set({ turnStartedAt: Date.now() - 5_200 });

    useSessionStore.getState().finishTurn();
    let blocks = useSessionStore.getState().blocks;
    expect(blocks.at(-1)).toMatchObject({ type: "session-event", text: "Worked for 5.2s" });

    useSessionStore.getState().finishTurn();
    blocks = useSessionStore.getState().blocks;
    expect(blocks.filter((block) => block.type === "session-event")).toHaveLength(1);
  });

  it("writes a cancel marker when the user stops the turn", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-2");
    useSessionStore.getState().appendOptimisticUser("hello");
    useSessionStore.getState().set({ turnStartedAt: Date.now() - 1_500 });

    useSessionStore.getState().finishTurn({ kind: "cancelled" });
    expect(useSessionStore.getState().blocks.at(-1)).toMatchObject({
      type: "session-event",
      text: "Turn cancelled by user in 1.5s.",
    });
  });
});

describe("goal notifications", () => {
  /** The extension envelope the shell ships goal state in (`x.ai/session_notification`). */
  const goalNotification = (update: Record<string, unknown>) =>
    ({ sessionId: "session-4", update: { sessionUpdate: "goal_updated", goal_id: "g-1", objective: "Ship it", status: "active", phase: "executing", tokens_used: 0, elapsed_ms: 0, total_worker_rounds: 0, total_verify_rounds: 0, token_baseline: 0, finished_subagent_tokens: 0, ...update } }) as never;

  it("keeps the goal state out of the transcript and off the turn clock", () => {
    useSessionStore.getState().resetConversation("session-4");
    useSessionStore.getState().applyNotifications([goalNotification({ elapsed_ms: 3_000 })]);
    const state = useSessionStore.getState();
    expect(state.goal).toMatchObject({ goalId: "g-1", status: "active", elapsedMs: 3_000 });
    expect(state.blocks).toEqual([]);
    expect(state.turnStartedAt).toBeNull();
  });

  it("writes the end-to-end row once, then keeps the goal as the finished chip", () => {
    useSessionStore.getState().resetConversation("session-4");
    useSessionStore.getState().appendOptimisticUser("go");
    useSessionStore.getState().applyNotifications([goalNotification({ elapsed_ms: 1_000 })]);
    useSessionStore.getState().applyNotifications([goalNotification({ status: "complete", elapsed_ms: 619_000 })]);
    expect(useSessionStore.getState().blocks.at(-1)).toMatchObject({
      type: "session-event",
      kind: "goal",
      text: "Goal complete in 10m19s end-to-end.",
    });

    useSessionStore.getState().applyNotifications([goalNotification({ status: "complete", elapsed_ms: 620_000 })]);
    expect(useSessionStore.getState().blocks.filter((block) => block.type === "session-event")).toHaveLength(1);
    expect(useSessionStore.getState().goal?.status).toBe("complete");
  });

  it("closes the turn after a goal-complete row instead of suppressing the turn marker", () => {
    useSessionStore.getState().resetConversation("session-5");
    useSessionStore.getState().appendOptimisticUser("go");
    useSessionStore.getState().set({ turnStartedAt: Date.now() - 2_000 });
    useSessionStore.getState().applyNotifications([goalNotification({ status: "complete", elapsed_ms: 5_000 })]);
    useSessionStore.getState().finishTurn();
    expect(useSessionStore.getState().blocks.map((block) => block.type)).toEqual([
      "message",
      "session-event",
      "session-event",
    ]);
    expect(useSessionStore.getState().blocks.at(-1)).toMatchObject({ kind: "turn" });
  });

  it("drops a late update for a cleared goal", () => {
    useSessionStore.getState().resetConversation("session-6");
    useSessionStore.getState().applyNotifications([goalNotification({})]);
    useSessionStore.getState().applyNotifications([goalNotification({ status: "cleared", goal_id: "" })]);
    expect(useSessionStore.getState().goal).toBeNull();
    useSessionStore.getState().applyNotifications([goalNotification({ elapsed_ms: 9_000 })]);
    expect(useSessionStore.getState().goal).toBeNull();
  });
});

describe("turn clock", () => {
  it("nets question-card time out of the turn clock", () => {
    expect(turnElapsedMs({ turnStartedAt: 0, turnPausedMs: 5_000, questionOpenedAt: null }, 100_000)).toBe(95_000);
    expect(turnElapsedMs({ turnStartedAt: 0, turnPausedMs: 0, questionOpenedAt: 90_000 }, 100_000)).toBe(90_000);
    expect(turnElapsedMs({ turnStartedAt: null, turnPausedMs: 0, questionOpenedAt: null }, 100_000)).toBeNull();
  });

  it("pauses while a question card is open and resumes after it closes", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-3");
    useSessionStore.getState().appendOptimisticUser("hello");
    useSessionStore.getState().set({ pendingQuestion: { rpcId: 1, title: "Pick", kind: "question", questions: [], raw: {} } });
    expect(useSessionStore.getState().questionOpenedAt).not.toBeNull();

    useSessionStore.getState().set({ pendingQuestion: null });
    expect(useSessionStore.getState().questionOpenedAt).toBeNull();
    expect(useSessionStore.getState().turnPausedMs).toBeGreaterThanOrEqual(0);
    expect(turnElapsedMs(useSessionStore.getState())).not.toBeNull();
  });
});

describe("plan review", () => {
  it("stashes the request's plan body and starts the review with no comments", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-plan");
    useSessionStore.getState().savePlanComment(null, [1, 2], "leftover from the last review");
    expect(useSessionStore.getState().planComments).toHaveLength(1);

    useSessionStore.getState().beginPlanReview("# Plan\n\n1. Do it");

    expect(useSessionStore.getState().planReview).toEqual({ body: "# Plan\n\n1. Do it", pending: true });
    // A new review owns its comments (`acp_handler/interactions.rs` resets both on arrival).
    expect(useSessionStore.getState().planComments).toEqual([]);
    expect(useSessionStore.getState().planNextCommentId).toBe(0);
    expect(useSessionStore.getState().planDialogOpen).toBe(true);
    expect(useSessionStore.getState().planFocus).toBe("preview");
    expect(useSessionStore.getState().planCommentRange).toBeNull();
  });

  it("stashes the ordinary composer draft while saving a line comment, then restores it", () => {
    useSessionStore.getState().resetConversation("session-plan-comment");
    useSessionStore.getState().beginPlanReview("# Plan\n\n1. Do it");
    useSessionStore.getState().setComposerDraft("ordinary draft");

    useSessionStore.getState().beginPlanComment([2, 3]);
    expect(useSessionStore.getState()).toMatchObject({
      planFocus: "commenting",
      planCommentRange: [2, 3],
      planEditingCommentId: null,
      planStashedDraft: "ordinary draft",
      composerDraft: "",
    });

    useSessionStore.getState().savePlanComment("rewrite this");
    expect(useSessionStore.getState()).toMatchObject({
      planFocus: "preview",
      planCommentRange: null,
      planEditingCommentId: null,
      planStashedDraft: null,
      composerDraft: "ordinary draft",
    });
    expect(useSessionStore.getState().planComments).toEqual([{ id: 0, lineRange: [2, 3], text: "rewrite this" }]);
  });

  it("cancels line commenting without losing the ordinary composer draft", () => {
    useSessionStore.getState().resetConversation("session-plan-cancel-comment");
    useSessionStore.getState().beginPlanReview("# Plan");
    useSessionStore.getState().setComposerDraft("keep this");
    useSessionStore.getState().beginPlanComment([1, 2]);
    useSessionStore.getState().setComposerDraft("partial comment");

    useSessionStore.getState().cancelPlanComment();
    expect(useSessionStore.getState()).toMatchObject({
      planFocus: "preview",
      planCommentRange: null,
      planEditingCommentId: null,
      planStashedDraft: null,
      composerDraft: "keep this",
    });
    expect(useSessionStore.getState().planComments).toEqual([]);
  });

  it("keeps the body but stops blocking once the review is answered", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-plan-2");
    useSessionStore.getState().beginPlanReview("# Plan");
    useSessionStore.getState().setPlanDialogOpen(false);
    useSessionStore.getState().endPlanReview();

    expect(useSessionStore.getState().planReview).toEqual({ body: "# Plan", pending: false });
    expect(useSessionStore.getState().planDialogOpen).toBe(false);
  });

  it("numbers comments in order, edits them in place, and deletes them", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-plan-3");
    useSessionStore.getState().beginPlanReview("# Plan");

    useSessionStore.getState().savePlanComment(null, [2, 3], "  rewrite this  ");
    useSessionStore.getState().savePlanComment(null, [4, 5], "combine these");
    expect(useSessionStore.getState().planComments).toEqual([
      { id: 0, lineRange: [2, 3], text: "rewrite this" },
      { id: 1, lineRange: [4, 5], text: "combine these" },
    ]);

    useSessionStore.getState().savePlanComment(0, [2, 4], "wider");
    expect(useSessionStore.getState().planComments[0]).toEqual({ id: 0, lineRange: [2, 4], text: "wider" });
    // Editing does not consume an id, so the next new comment still lands after the last one.
    expect(useSessionStore.getState().planNextCommentId).toBe(2);

    useSessionStore.getState().removePlanComment(0);
    expect(useSessionStore.getState().planComments).toEqual([{ id: 1, lineRange: [4, 5], text: "combine these" }]);
  });

  it("ignores an empty comment, as `save_plan_comment` does", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-plan-4");
    useSessionStore.getState().beginPlanReview("# Plan");
    useSessionStore.getState().savePlanComment(null, [1, 2], "   ");
    expect(useSessionStore.getState().planComments).toEqual([]);
  });

  it("clears the whole surface when the session changes", () => {
    const store = useSessionStore.getState();
    store.resetConversation("session-plan-5");
    useSessionStore.getState().beginPlanReview("# Plan");
    useSessionStore.getState().savePlanComment(null, [1, 2], "a note");
    useSessionStore.getState().setPlanDialogOpen(true);

    useSessionStore.getState().resetConversation("session-plan-6");

    const state = useSessionStore.getState();
    expect(state.planReview).toBeNull();
    expect(state.planComments).toEqual([]);
    expect(state.planNextCommentId).toBe(0);
    expect(state.planDialogOpen).toBe(false);
  });

  it("stashes a pending plan review on switch and restores it without opening the pane", () => {
    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().beginPlanReview("# Plan A", "2026-09-19T14-30-22Z.md");
    useSessionStore.getState().savePlanComment(null, [1, 2], "tighten this");
    useSessionStore.getState().set({
      pendingQuestion: {
        rpcId: 42,
        kind: "plan",
        questions: [],
        raw: {},
      },
    });
    useSessionStore.getState().setPlanDialogOpen(false);

    useSessionStore.getState().resetConversation("sess-b");
    expect(useSessionStore.getState().planReview).toBeNull();
    expect(useSessionStore.getState().pendingQuestion).toBeNull();
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]?.pendingQuestion.rpcId).toBe(42);
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]?.planComments).toEqual([
      { id: 0, lineRange: [1, 2], text: "tighten this" },
    ]);

    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().restoreStashedPlanReview();
    expect(useSessionStore.getState()).toMatchObject({
      planReview: { body: "# Plan A", fileName: "2026-09-19T14-30-22Z.md", pending: true },
      planDialogOpen: false,
      planFileView: null,
      pendingQuestion: { rpcId: 42, kind: "plan" },
    });
    expect(useSessionStore.getState().planComments).toEqual([
      { id: 0, lineRange: [1, 2], text: "tighten this" },
    ]);
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]).toBeUndefined();
  });

  it("lets a fresh exit_plan_mode win over a stash for the same conversation", () => {
    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().beginPlanReview("# Old", "old.md");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 1, kind: "plan", questions: [], raw: {} },
    });
    useSessionStore.getState().resetConversation("sess-b");
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]?.pendingQuestion.rpcId).toBe(1);

    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().beginPlanReview("# New", "new.md");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 2, kind: "plan", questions: [], raw: {} },
    });
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]).toBeUndefined();
    expect(useSessionStore.getState().planReview).toEqual({ body: "# New", fileName: "new.md", pending: true });
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(2);
  });

  it("drops the stash once the review is answered so it cannot come back", () => {
    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().beginPlanReview("# Plan");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 7, kind: "plan", questions: [], raw: {} },
    });
    useSessionStore.getState().resetConversation("sess-b");
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]).toBeDefined();

    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().restoreStashedPlanReview();
    useSessionStore.getState().endPlanReview();
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]).toBeUndefined();
    expect(useSessionStore.getState().planReview).toEqual({ body: "# Plan", pending: false });

    useSessionStore.getState().resetConversation("sess-b");
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]).toBeUndefined();
    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().restoreStashedPlanReview();
    expect(useSessionStore.getState().planReview).toBeNull();
    expect(useSessionStore.getState().pendingQuestion).toBeNull();
  });

  it("does not restore a stash when a newer pending review already landed", () => {
    useSessionStore.getState().resetConversation("sess-a");
    useSessionStore.getState().stashPlanReview("sess-a", {
      planReview: { body: "# Stashed", fileName: "stashed.md", pending: true },
      planComments: [],
      planNextCommentId: 0,
      planFocus: "preview",
      planCommentRange: null,
      planEditingCommentId: null,
      planStashedDraft: null,
      pendingQuestion: { rpcId: 9, kind: "plan", questions: [], raw: {} },
    });
    // Simulate load replay installing a live waiter without clearing the older stash first.
    useSessionStore.setState({
      planReview: { body: "# Live", fileName: "live.md", pending: true },
      pendingQuestion: { rpcId: 10, kind: "plan", questions: [], raw: {} },
    });
    useSessionStore.getState().restoreStashedPlanReview();
    expect(useSessionStore.getState().planReview).toEqual({ body: "# Live", fileName: "live.md", pending: true });
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(10);
    expect(useSessionStore.getState().planReviewsBySession["sess-a"]?.pendingQuestion.rpcId).toBe(9);
  });

  it("honors turn_completed when the agent emits it (U-turn)", () => {
    useSessionStore.setState({
      turnRunning: true,
      turnStartedAt: Date.now() - 500,
      transcriptCursor: {
        turnId: "turn-1",
        assistantId: "a1",
        thoughtId: null,
        optimisticUserId: null,
      },
      blocks: [
        {
          type: "message",
          id: "a1",
          turnId: "turn-1",
          role: "assistant",
          text: "done",
          images: [],
          streaming: true,
        },
      ],
    });
    useSessionStore.getState().applyNotification({
      sessionId: "s1",
      update: { sessionUpdate: "turn_completed", stopReason: "end_turn" },
    } as never);
    const state = useSessionStore.getState();
    expect(state.turnRunning).toBe(false);
    expect(state.turnStartedAt).toBeNull();
    expect(state.blocks.at(-1)).toMatchObject({ type: "session-event", kind: "turn" });
  });

  it("keeps a promoted prompt active when the previous turn_completed arrives late", () => {
    const store = useSessionStore.getState();
    store.resetConversation("s1");
    useSessionStore.getState().appendOptimisticUser("first", [], "prompt-first");
    useSessionStore.getState().appendOptimisticUser("send now", [], "prompt-second");
    useSessionStore.getState().set({ turnRunning: true });
    const before = useSessionStore.getState();
    before.applyNotification({
      sessionId: "s1",
      update: { sessionUpdate: "turn_completed", promptId: "prompt-first", stopReason: "cancelled" },
    } as never);
    const after = useSessionStore.getState();
    expect(after.currentPromptId).toBe("prompt-second");
    expect(after.turnRunning).toBe(true);
    expect(after.transcriptCursor).toEqual(before.transcriptCursor);
    expect(after.blocks).toEqual(before.blocks);
  });
});

describe("activity session updates (P4)", () => {
  it("routes U-sub-* into the activity store without transcript spam", () => {
    useActivityStore.getState().reset();
    useSessionStore.getState().resetConversation("s1");
    useSessionStore.getState().applyNotification({
      sessionId: "s1",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        description: "scan src/",
        subagent_type: "explore",
      },
    } as never);
    expect(useSessionStore.getState().blocks).toEqual([]);
    expect(useActivityStore.getState().subagents["child-1"]?.status).toBe("running");
  });
});

describe("live context usage from _meta.totalTokens", () => {
  const stamped = (totalTokens: number, update: Record<string, unknown> = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "…" } }) =>
    ({ sessionId: "s-usage", update, _meta: { totalTokens } }) as never;

  it("feeds usage.used from every session/update so the chip moves mid-turn", () => {
    useSessionStore.getState().resetConversation("s-usage");
    useSessionStore.getState().set({ usage: { used: 0, size: 300_000 } });

    useSessionStore.getState().applyNotifications([stamped(42_000), stamped(85_500)]);

    expect(useSessionStore.getState().usage).toMatchObject({ used: 85_500, size: 300_000 });
  });

  it("writes a session-event for the clean-run marker instead of prose", () => {
    useSessionStore.getState().resetConversation("s-usage");
    useSessionStore.getState().set({ usage: { used: 420_000, size: 1_000_000 } });
    useSessionStore.getState().appendOptimisticUser("approve the plan");

    useSessionStore.getState().applyNotifications([
      stamped(2_100, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "context cleared — implementing plan" },
      }),
    ]);

    const events = useSessionStore.getState().blocks.filter((block) => block.type === "session-event");
    expect(events.at(-1)).toMatchObject({ kind: "context", text: "Context cleared — implementing plan." });
    expect(useSessionStore.getState().blocks.some((block) => block.type === "message" && block.text.includes("context cleared"))).toBe(false);
    expect(useSessionStore.getState().usage).toMatchObject({ used: 2_100, size: 1_000_000 });
  });

  it("drops the chip when the clear marker carries the reseeded totalTokens", () => {
    useSessionStore.getState().resetConversation("s-usage");
    useSessionStore.getState().set({ usage: { used: 420_000, size: 1_000_000 } });

    useSessionStore.getState().applyNotifications([
      stamped(2_100, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "context cleared — implementing plan" },
      }),
    ]);

    expect(useSessionStore.getState().usage).toMatchObject({ used: 2_100, size: 1_000_000 });
    expect(useSessionStore.getState().blocks.at(-1)).toMatchObject({ type: "session-event", kind: "context" });
  });

  it("still closes the turn after a context-cleared row", () => {
    useSessionStore.getState().resetConversation("s-usage");
    useSessionStore.getState().appendOptimisticUser("run clean");
    useSessionStore.getState().set({ turnStartedAt: Date.now() - 2_000 });
    useSessionStore.getState().applyNotifications([
      stamped(1_200, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "context cleared — implementing plan" },
      }),
    ]);
    useSessionStore.getState().finishTurn();

    const kinds = useSessionStore.getState().blocks.map((block) => (block.type === "session-event" ? block.kind : block.type));
    expect(kinds).toEqual(["message", "context", "turn"]);
  });
});
