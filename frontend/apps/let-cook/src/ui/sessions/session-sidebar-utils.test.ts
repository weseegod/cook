import { describe, expect, test } from "vitest";
import type { SessionSummary } from "../../acp/xai";
import {
  DEFAULT_PREFS,
  arrangeSessions,
  flattenGroupIds,
  groupConversations,
  moveId,
  parsePrefs,
  prunePrefs,
  sortByRecency,
  togglePinned,
} from "./session-sidebar-utils";

function session(id: string, cwd: string | undefined, updatedAt: string | undefined, title = id): SessionSummary {
  return { id, title, cwd, updatedAt };
}

const alpha = session("alpha", "/work/alpha", "2026-09-15T10:00:00Z", "Alpha task");
const alphaOlder = session("alpha-old", "/work/alpha", "2026-09-10T10:00:00Z", "Alpha older");
const beta = session("beta", "/work/beta", "2026-09-14T10:00:00Z", "Beta task");
const orphan = session("orphan", undefined, "2026-09-13T10:00:00Z", "Orphan task");

describe("parsePrefs", () => {
  test("falls back to the defaults for missing or malformed storage", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("{")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"time"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"sort":"random"}')).toEqual({ ...DEFAULT_PREFS, sort: "time" });
  });

  test("keeps the stored sort, pins, and order, dropping junk entries", () => {
    expect(
      parsePrefs('{"sort":"workspace","pinned":["a","a",7,null],"order":["b","","c"]}'),
    ).toEqual({ sort: "workspace", pinned: ["a"], order: ["b", "c"] });
  });
});

describe("togglePinned", () => {
  test("adds to the end and removes in place", () => {
    expect(togglePinned([], "a")).toEqual(["a"]);
    expect(togglePinned(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(togglePinned(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("prunePrefs", () => {
  test("forgets a deleted conversation", () => {
    expect(prunePrefs({ sort: "time", pinned: ["a", "b"], order: ["b", "a"] }, "b")).toEqual({
      sort: "time",
      pinned: ["a"],
      order: ["a"],
    });
  });
});

describe("moveId", () => {
  test("inserts before and after the target", () => {
    expect(moveId(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveId(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  test("ignores no-op moves and unknown targets", () => {
    expect(moveId(["a", "b"], "a", "a", "before")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "a", "missing", "before")).toEqual(["a", "b"]);
  });
});

describe("sortByRecency", () => {
  test("orders newest first and pushes unusable timestamps to the end", () => {
    const undated = session("undated", "/work/alpha", undefined);
    expect(sortByRecency([undated, beta, alpha, orphan]).map((entry) => entry.id)).toEqual([
      "alpha",
      "beta",
      "orphan",
      "undated",
    ]);
  });

  test("does not mutate the input", () => {
    const input = [beta, alpha];
    sortByRecency(input);
    expect(input.map((entry) => entry.id)).toEqual(["beta", "alpha"]);
  });
});

describe("arrangeSessions", () => {
  test("uses recency when nothing was arranged by hand", () => {
    expect(arrangeSessions([beta, alpha], []).map((entry) => entry.id)).toEqual(["alpha", "beta"]);
  });

  test("follows the stored order and keeps newer, unarranged conversations on top", () => {
    const fresh = session("fresh", "/work/alpha", "2026-09-16T10:00:00Z");
    expect(arrangeSessions([alpha, beta, fresh], ["beta", "alpha"]).map((entry) => entry.id)).toEqual([
      "fresh",
      "beta",
      "alpha",
    ]);
  });

  test("ignores stored ids that are no longer present", () => {
    expect(arrangeSessions([alpha, beta], ["gone", "beta", "alpha"]).map((entry) => entry.id)).toEqual(["beta", "alpha"]);
  });
});

describe("groupConversations", () => {
  const all = [alpha, alphaOlder, beta, orphan];

  test("time sort renders one headerless block, newest first", () => {
    const groups = groupConversations(all, DEFAULT_PREFS);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBeUndefined();
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["alpha", "beta", "orphan", "alpha-old"]);
  });

  test("workspace sort groups by cwd, most recently used workspace first", () => {
    const groups = groupConversations(all, { ...DEFAULT_PREFS, sort: "workspace" });
    expect(groups.map((group) => [group.label, group.key, group.path])).toEqual([
      ["alpha", "/work/alpha", "/work/alpha"],
      ["beta", "/work/beta", "/work/beta"],
      ["No workspace", "__no_workspace__", undefined],
    ]);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["alpha", "alpha-old"]);
  });

  test("pinned conversations lead both sort modes, in their own block", () => {
    const prefs = { sort: "workspace" as const, pinned: ["beta", "orphan"], order: [] };
    const groups = groupConversations(all, prefs);
    expect(groups[0].pinned).toBe(true);
    expect(groups[0].label).toBe("Pinned");
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["beta", "orphan"]);
    expect(flattenGroupIds(groups)).toEqual(["beta", "orphan", "alpha", "alpha-old"]);
    // A pinned conversation is not repeated in its workspace block.
    expect(groups.flatMap((group) => group.sessions).map((entry) => entry.id)).toHaveLength(all.length);
  });
});
