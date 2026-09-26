import { describe, expect, it } from "vitest";
import {
  captureContentAnchor,
  contentAnchorScrollTop,
  estimateRowHeight,
  windowRange,
} from "./transcript-window";

describe("estimateRowHeight", () => {
  it("prefers per-kind defaults over the flat 72px fallback", () => {
    expect(estimateRowHeight({ type: "session-event" })).toBe(28);
    expect(estimateRowHeight({ type: "message", role: "thought" })).toBe(48);
    expect(estimateRowHeight({ type: "tool" })).toBe(52);
    expect(estimateRowHeight({ type: "verb-group" })).toBe(52);
    expect(estimateRowHeight({ type: "message", role: "assistant" })).toBe(72);
    expect(estimateRowHeight({ type: "message", role: "user" })).toBe(72);
  });
});

describe("content anchor", () => {
  const rows = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
  ];

  it("captures the row under scrollTop and restores it after heights above grow", () => {
    const heights = [40, 40, 40, 40];
    const anchor = captureContentAnchor(rows, 50, heights);
    expect(anchor).toEqual({ rowId: "b", delta: 10 });

    // Row `a` grows by 30: the same content must sit at 80, not stay at 50.
    const grown = [70, 40, 40, 40];
    expect(contentAnchorScrollTop(rows, anchor!, grown)).toBe(80);
  });

  it("keeps a negative delta when the anchor row started above scrollTop", () => {
    const heights = [80, 40, 40, 40];
    const anchor = captureContentAnchor(rows, 20, heights);
    expect(anchor).toEqual({ rowId: "a", delta: 20 });
    expect(contentAnchorScrollTop(rows, anchor!, heights)).toBe(20);
  });

  it("returns null when the anchored row is gone", () => {
    const anchor = { rowId: "gone", delta: 4 };
    expect(contentAnchorScrollTop(rows, anchor, [40, 40, 40, 40])).toBeNull();
  });

  it("falls back to the estimate for unmeasured rows", () => {
    const anchor = captureContentAnchor(rows, 80, [0, 0, 0, 0], 50);
    expect(anchor).toEqual({ rowId: "b", delta: 30 });
    expect(contentAnchorScrollTop(rows, anchor!, [0, 0, 0, 0], 50)).toBe(80);
  });
});

describe("windowRange", () => {
  it("does not window short conversations", () => {
    expect(windowRange(20, {
      follow: true,
      scrollTop: 0,
      viewportHeight: 600,
      heights: [],
    })).toEqual({ start: 0, end: 20, tailStart: null, padTop: 0, padBottom: 0 });
  });

  it("keeps the live tail mounted while following", () => {
    const result = windowRange(200, {
      follow: true,
      scrollTop: 0,
      viewportHeight: 600,
      heights: [],
      overscan: 8,
    });
    expect(result.start).toBe(160);
    expect(result.end).toBe(200);
    expect(result.tailStart).toBeNull();
    expect(result.padTop).toBe(160 * 72);
    expect(result.padBottom).toBe(0);
  });

  it("finds a measured mid-scroll window and keeps honest spacers", () => {
    const heights = Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? 50 : 100));
    const result = windowRange(200, {
      follow: false,
      scrollTop: 3_000,
      viewportHeight: 600,
      heights,
      overscan: 8,
    });
    expect(result.start).toBeLessThan(40);
    expect(result.end).toBeGreaterThan(result.start);
    expect(result.padTop).toBe(result.start * 75);
    expect(result.padBottom).toBe((200 - result.end) * 75);
  });

  it("keeps the live final row separate from the bounded history window", () => {
    const result = windowRange(200, {
      follow: false,
      scrollTop: 0,
      viewportHeight: 600,
      heights: [],
      turnRunning: true,
    });
    expect(result.start).toBe(0);
    expect(result.end).toBeLessThan(30);
    expect(result.tailStart).toBe(199);
    expect(result.padBottom).toBe((199 - result.end) * 72);
  });
});
