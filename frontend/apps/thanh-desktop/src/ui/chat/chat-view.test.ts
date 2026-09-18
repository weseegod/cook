import { describe, expect, it } from "vitest";
import type { MessageBlock } from "../../state/session";
import { messagePropsEqual } from "./chat-view";

const finished = (patch: Partial<MessageBlock> = {}): MessageBlock => ({
  type: "message",
  id: "assistant-1",
  turnId: "turn-1",
  role: "assistant",
  text: "Finished response",
  images: [],
  streaming: false,
  ...patch,
});

describe("memoized transcript rows", () => {
  it("skips an equal finished message", () => {
    expect(messagePropsEqual({ block: finished() }, { block: finished() })).toBe(true);
    expect(messagePropsEqual({ block: finished() }, { block: finished({ text: "Changed" }) })).toBe(false);
  });
});
