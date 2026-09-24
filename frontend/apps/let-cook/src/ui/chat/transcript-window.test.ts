import { describe, expect, it } from "vitest";
import { windowRange } from "./transcript-window";

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
