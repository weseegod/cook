import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./host", () => ({
  osBadge: vi.fn(async () => undefined),
}));

import { osBadge } from "./host";
import {
  attentionCount,
  clearAllAttention,
  clearAttention,
  markAttention,
  resetAttentionBadgeForTests,
  startAttentionBadge,
} from "./attention-badge";

/** Focus state the module reads: `document.hidden` and `document.hasFocus()`. */
function setFocused(focused: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  Object.defineProperty(document, "hidden", { configurable: true, value: !focused });
}

const badge = vi.mocked(osBadge);

beforeEach(() => {
  vi.useFakeTimers();
  resetAttentionBadgeForTests();
  badge.mockClear();
  setFocused(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attention badge", () => {
  it("counts one entry per conversation and mirrors the count", async () => {
    markAttention("session-a");
    markAttention("session-a");
    markAttention("session-b");
    await vi.runAllTimersAsync();

    expect(attentionCount()).toBe(2);
    expect(badge.mock.calls.map((call) => call[0])).toEqual([1, 2]);
  });

  it("sends nothing while the window is focused", async () => {
    setFocused(true);
    markAttention("session-a");
    await vi.runAllTimersAsync();

    expect(attentionCount()).toBe(0);
    expect(badge).not.toHaveBeenCalled();
  });

  it("clears the whole badge when focus comes back", async () => {
    const stop = startAttentionBadge();
    markAttention("session-a");
    await vi.runAllTimersAsync();
    expect(badge).toHaveBeenLastCalledWith(1);

    setFocused(true);
    window.dispatchEvent(new Event("focus"));
    await vi.runAllTimersAsync();

    expect(attentionCount()).toBe(0);
    expect(badge).toHaveBeenLastCalledWith(0);
    stop();
  });

  it("clears a single conversation without touching the rest", async () => {
    markAttention("session-a");
    markAttention("session-b");
    await vi.runAllTimersAsync();
    clearAttention("session-a");
    await vi.runAllTimersAsync();

    expect(attentionCount()).toBe(1);
    expect(badge).toHaveBeenLastCalledWith(1);
  });

  it("writes the count again only when it changes", async () => {
    markAttention("session-a");
    await vi.runAllTimersAsync();
    clearAllAttention();
    clearAllAttention();
    await vi.runAllTimersAsync();

    expect(badge.mock.calls.map((call) => call[0])).toEqual([1, 0]);
  });
});
