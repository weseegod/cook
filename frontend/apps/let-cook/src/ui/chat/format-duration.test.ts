import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatElapsedCoarse,
  formatElapsedSeconds,
  formatThinkingDuration,
  formatTimeAgo,
  formatTokensCompact,
  formatTokensShort,
} from "./format-duration";

describe("formatDuration (TUI format_duration)", () => {
  it("keeps one decimal under ten seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(5_200)).toBe("5.2s");
    expect(formatDuration(9_900)).toBe("9.9s");
  });

  it("drops the decimal from ten seconds up", () => {
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(32_400)).toBe("32s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("uses minutes and seconds under an hour with no spaces", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(80_000)).toBe("1m20s");
    expect(formatDuration(3_599_000)).toBe("59m59s");
  });

  it("uses hours and minutes past an hour", () => {
    expect(formatDuration(3_600_000)).toBe("1h0m");
    expect(formatDuration(3_720_000)).toBe("1h2m");
  });
});

describe("formatThinkingDuration", () => {
  it("matches the thinking header formatter", () => {
    expect(formatThinkingDuration(1_200)).toBe("1.2s");
    expect(formatThinkingDuration(59_900)).toBe("59.9s");
    expect(formatThinkingDuration(65_000)).toBe("1m5s");
    expect(formatThinkingDuration(60_000)).toBe("1m0s");
  });
});

describe("formatTokensShort", () => {
  it("compacts token counts", () => {
    expect(formatTokensShort(0)).toBe("0");
    expect(formatTokensShort(999)).toBe("999");
    expect(formatTokensShort(1_230)).toBe("1.23k");
    expect(formatTokensShort(12_000)).toBe("12.0k");
    expect(formatTokensShort(120_000)).toBe("120k");
    expect(formatTokensShort(1_230_000)).toBe("1.23m");
    expect(formatTokensShort(12_300_000)).toBe("12.3m");
  });
});

describe("formatElapsedCoarse (goal chip)", () => {
  it("stops at whole seconds, minutes and hours", () => {
    expect(formatElapsedCoarse(0)).toBe("0s");
    expect(formatElapsedCoarse(5_400)).toBe("5s");
    expect(formatElapsedCoarse(59_999)).toBe("59s");
    expect(formatElapsedCoarse(65_000)).toBe("1m");
    expect(formatElapsedCoarse(3_600_000)).toBe("1h");
    expect(formatElapsedCoarse(7_300_000)).toBe("2h");
  });
});

describe("formatElapsedSeconds (goal detail)", () => {
  it("keeps seconds once minutes have started", () => {
    expect(formatElapsedSeconds(5_400)).toBe("5s");
    expect(formatElapsedSeconds(65_000)).toBe("1m05s");
    expect(formatElapsedSeconds(619_000)).toBe("10m19s");
    expect(formatElapsedSeconds(7_380_000)).toBe("2h03m");
  });
});

describe("formatTokensCompact (goal surfaces)", () => {
  it("keeps one decimal and drops a trailing zero", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(1_230)).toBe("1.2k");
    expect(formatTokensCompact(250_000)).toBe("250k");
    expect(formatTokensCompact(1_500_000)).toBe("1.5M");
    expect(formatTokensCompact(2_000_000)).toBe("2M");
  });
});

describe("formatTimeAgo", () => {
  it("coarsens from just now to years", () => {
    expect(formatTimeAgo(0)).toBe("just now");
    expect(formatTimeAgo(59_000)).toBe("just now");
    expect(formatTimeAgo(300_000)).toBe("5m");
    expect(formatTimeAgo(3 * 3_600_000)).toBe("3h");
    expect(formatTimeAgo(4 * 86_400_000)).toBe("4d");
    expect(formatTimeAgo(60 * 86_400_000)).toBe("2mo");
    expect(formatTimeAgo(400 * 86_400_000)).toBe("1y");
  });
});
