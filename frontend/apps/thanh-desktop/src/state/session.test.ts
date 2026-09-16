import { describe, expect, it } from "vitest";
import { reduceBlocks, type TranscriptBlock } from "./session";

describe("session reducer", () => {
  it("coalesces streamed assistant chunks by message id", () => {
    let blocks: TranscriptBlock[] = [];
    blocks = reduceBlocks(blocks, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "hello " },
    });
    blocks = reduceBlocks(blocks, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "world" },
    });
    expect(blocks).toMatchObject([{ type: "message", role: "assistant", text: "hello world" }]);
  });

  it("updates a tool card in place", () => {
    let blocks: TranscriptBlock[] = reduceBlocks([], {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      status: "pending",
    });
    blocks = reduceBlocks(blocks, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "pnpm test",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "tool", title: "pnpm test", status: "completed" });
  });

  it("adopts an optimistic user message instead of duplicating it", () => {
    const blocks: TranscriptBlock[] = [{ type: "message", id: "local-1", role: "user", text: "hello", images: [] }];
    const next = reduceBlocks(blocks, {
      sessionUpdate: "user_message_chunk",
      messageId: "server-1",
      content: { type: "text", text: "hello" },
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "server-1", text: "hello" });
  });

  it("removes an active plan", () => {
    const plan = reduceBlocks([], { sessionUpdate: "plan", planId: "p1", entries: [] });
    expect(reduceBlocks(plan, { sessionUpdate: "plan_removed", planId: "p1" })).toEqual([]);
  });
});
