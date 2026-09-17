import { describe, expect, it } from "vitest";
import { reduceTranscript, type TranscriptState } from "./session";

const empty = (): TranscriptState => ({
  blocks: [],
  cursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
});

describe("session transcript reducer", () => {
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
