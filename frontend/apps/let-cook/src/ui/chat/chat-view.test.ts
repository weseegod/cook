import { describe, expect, it } from "vitest";
import type { MessageBlock } from "../../state/session";
import { messagePropsEqual } from "./transcript-row";
import { hasContentBelow, hasResponseTopAbove, resolveFollow, stickyPromptIndex } from "./transcript-nav";

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

describe("transcript navigation", () => {
  const rows = [
    { type: "message", role: "user", turnId: "turn-1" },
    { type: "message", role: "assistant", turnId: "turn-1" },
    { type: "message", role: "user", turnId: "turn-2" },
    { type: "message", role: "assistant", turnId: "turn-2" },
  ];

  it("pins the last user row that has scrolled past", () => {
    expect(stickyPromptIndex(rows, 51, [50, 100, 50, 100])).toBe(0);
    expect(stickyPromptIndex(rows, 151, [50, 100, 50, 100])).toBe(2);
    expect(stickyPromptIndex(rows, 0, [50, 100, 50, 100])).toBeNull();
  });

  it("detects when the active response start is above the viewport", () => {
    expect(hasResponseTopAbove(rows, 0, 60, [50, 100, 50, 100])).toBe(true);
    expect(hasResponseTopAbove(rows, 0, 40, [50, 100, 50, 100])).toBe(false);
  });

  it("uses the tail itself as the bottom test, with only rounding slack", () => {
    expect(hasContentBelow(1_000, 700, 200)).toBe(true);
    expect(hasContentBelow(1_000, 797, 200)).toBe(true);
    expect(hasContentBelow(1_000, 798, 200)).toBe(false);
  });

  it("drops follow on any scroll back and resumes it on a tail overscroll", () => {
    const away = { programmatic: false, overscroll: false, atTail: false };
    const tail = { programmatic: false, overscroll: false, atTail: true };
    expect(resolveFollow(true, away)).toBe(false);
    expect(resolveFollow(false, away)).toBe(false);
    // The pane's own writes (pin, anchor restore, jump) never change the mode.
    expect(resolveFollow(true, { ...away, programmatic: true })).toBe(true);
    expect(resolveFollow(false, { ...tail, programmatic: true })).toBe(false);
    // Landing on the tail stays manual; scrolling down again there resumes.
    expect(resolveFollow(false, tail)).toBe(false);
    expect(resolveFollow(true, tail)).toBe(true);
    expect(resolveFollow(false, { ...tail, overscroll: true })).toBe(true);
  });
});
