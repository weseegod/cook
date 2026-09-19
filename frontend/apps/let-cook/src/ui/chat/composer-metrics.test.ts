import { describe, expect, it } from "vitest";
import type { MessageBlock, TranscriptBlock } from "../../state/session";
import {
  assistantTextForTurn,
  computeTps,
  DecodeWindowTracker,
  decodeTextForTurn,
  estimateTokens,
  formatTps,
  resolveMetricsTurnId,
} from "./composer-metrics";

function message(
  role: MessageBlock["role"],
  text: string,
  turnId = "turn-1",
): MessageBlock {
  return {
    type: "message",
    id: `${role}-${text.slice(0, 8)}`,
    turnId,
    role,
    text,
    images: [],
    streaming: false,
  };
}

describe("estimateTokens", () => {
  it("uses the 4-char heuristic", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("computeTps / formatTps", () => {
  it("returns null for short decode windows or zero tokens", () => {
    expect(computeTps(10, 199)).toBeNull();
    expect(computeTps(0, 1_000)).toBeNull();
  });

  it("keeps one decimal below 100 and rounds 100+ to an integer display", () => {
    expect(computeTps(85, 2_000)).toBe(42.5);
    expect(formatTps(42.5)).toBe("42.5");
    expect(formatTps(100)).toBe("100");
    expect(formatTps(142.6)).toBe("143");
  });
});

describe("assistantTextForTurn", () => {
  it("counts only assistant message text for the turn", () => {
    const blocks: TranscriptBlock[] = [
      message("user", "hello"),
      message("thought", "planning…"),
      message("assistant", "abcd"),
      message("assistant", "efgh", "turn-2"),
    ];
    expect(assistantTextForTurn(blocks, "turn-1")).toBe("abcd");
    expect(assistantTextForTurn(blocks, null)).toBe("");
  });
});

describe("decodeTextForTurn", () => {
  it("counts thinking alongside the prose, and nothing else", () => {
    const blocks: TranscriptBlock[] = [
      message("user", "hello"),
      message("thought", "planning…"),
      message("assistant", "abcd"),
      message("thought", "more", "turn-2"),
    ];
    expect(decodeTextForTurn(blocks, "turn-1")).toBe("planning…abcd");
    expect(decodeTextForTurn(blocks, null)).toBe("");
  });
});

describe("resolveMetricsTurnId", () => {
  it("falls back to the latest assistant turn when the captured id has no text", () => {
    const blocks: TranscriptBlock[] = [
      message("user", "hello", "turn-old"),
      message("assistant", "reply", "turn-new"),
    ];
    expect(resolveMetricsTurnId(blocks, "turn-old")).toBe("turn-new");
    expect(resolveMetricsTurnId(blocks, "turn-new")).toBe("turn-new");
  });
});

describe("DecodeWindowTracker", () => {
  it("accumulates thinking and responding, not tool time", () => {
    const tracker = new DecodeWindowTracker();
    tracker.sync("thinking", true, 1_000);
    tracker.sync("responding", true, 1_100);
    tracker.sync("tool", true, 1_600);
    tracker.sync("responding", true, 2_000);
    // thinking 100 + responding 500 + responding 300 = 900
    expect(tracker.finish(2_300)).toBe(900);
    expect(tracker.finish(3_000)).toBe(0);
  });
});
