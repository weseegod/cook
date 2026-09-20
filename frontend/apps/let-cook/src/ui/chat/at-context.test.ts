import { describe, expect, it } from "vitest";
import {
  detect,
  detectWithDrill,
  isDirMode,
  isHiddenMode,
  matcherQuery,
  normalizeDisplayPath,
  pathRange,
} from "./at-context";

describe("at-context", () => {
  it("detects a basic @ token", () => {
    const ctx = detect("@foo", 4)!;
    expect(ctx.range).toEqual({ start: 0, end: 4 });
    expect(ctx.query).toBe("foo");
    expect(isDirMode(ctx)).toBe(false);
    expect(isHiddenMode(ctx)).toBe(false);
  });

  it("detects @ with leading text", () => {
    const ctx = detect("hello @bar/baz", 14)!;
    expect(ctx.range).toEqual({ start: 6, end: 14 });
    expect(ctx.query).toBe("bar/baz");
  });

  it("supports a mid-token cursor and dir mode", () => {
    const ctx = detect("@foo/bar", 5)!;
    expect(ctx.range).toEqual({ start: 0, end: 8 });
    expect(ctx.query).toBe("foo/");
    expect(isDirMode(ctx)).toBe(true);
  });

  it("detects a bare @", () => {
    const ctx = detect("@", 1)!;
    expect(ctx.range).toEqual({ start: 0, end: 1 });
    expect(ctx.query).toBe("");
  });

  it("rejects email-like tokens", () => {
    expect(detect("user@example", 12)).toBeNull();
    expect(detect("test_@foo", 9)).toBeNull();
  });

  it("rejects a cursor past the token", () => {
    expect(detect("@foo bar", 5)).toBeNull();
    expect(detect("@foo bar", 8)).toBeNull();
  });

  it("supports hidden and hidden-dir modes", () => {
    const hidden = detect("@!foo", 5)!;
    expect(isHiddenMode(hidden)).toBe(true);
    expect(matcherQuery(hidden)).toBe("foo");

    const both = detect("@!.config/", 10)!;
    expect(isHiddenMode(both)).toBe(true);
    expect(isDirMode(both)).toBe(true);
    expect(matcherQuery(both)).toBe(".config/");
  });

  it("picks the rightmost @", () => {
    const ctx = detect("@first @second", 14)!;
    expect(ctx.query).toBe("second");
    expect(ctx.range).toEqual({ start: 7, end: 14 });
  });

  it("triggers after non-identifier characters", () => {
    expect(detect("(@foo", 5)).not.toBeNull();
    expect(detect(" @foo", 5)).not.toBeNull();
    expect(detect(",@foo", 5)).not.toBeNull();
  });

  it("handles empty text and cursor at zero", () => {
    expect(detect("", 0)).toBeNull();
    expect(detect("@foo", 0)).toBeNull();
  });

  it("normalizes display paths", () => {
    expect(normalizeDisplayPath("./foo/bar")).toBe("foo/bar");
    expect(normalizeDisplayPath("foo/bar")).toBe("foo/bar");
    expect(normalizeDisplayPath("./")).toBe("");
  });

  it("delimits tokens on comma and semicolon", () => {
    expect(detect("@foo,@bar", 4)!.range).toEqual({ start: 0, end: 4 });
    expect(detect("@foo;rest", 4)!.query).toBe("foo");
  });

  it("computes path ranges for plain and hidden tokens", () => {
    expect(pathRange(detect("@src/foo", 8)!)).toEqual({ start: 1, end: 8 });
    expect(pathRange(detect("@!src/foo", 9)!)).toEqual({ start: 2, end: 9 });
    expect(pathRange(detect("hello @bar", 10)!)).toEqual({ start: 7, end: 10 });
  });

  it("keeps whitespace inside a drill prefix", () => {
    const ctx = detectWithDrill("@my dir", 7, "my dir")!;
    expect(ctx.range).toEqual({ start: 0, end: 7 });
    expect(ctx.query).toBe("my dir");
  });

  it("enters dir mode under a drill prefix", () => {
    const ctx = detectWithDrill("@my dir/", 8, "my dir")!;
    expect(ctx.query).toBe("my dir/");
    expect(isDirMode(ctx)).toBe(true);
  });

  it("falls back when the drill prefix no longer matches", () => {
    expect(detectWithDrill("@foo bar", 8, "my dir")).toBeNull();
    expect(detectWithDrill("@my dir extra", 13, "my dir")).toBeNull();
    expect(detectWithDrill("@my dir", 7, null)).toBeNull();
    expect(detectWithDrill("@my di", 6, "my dir")).toBeNull();
    expect(detectWithDrill("@my dir", 7, "")).toBeNull();
  });

  it("allows multibyte and nested space segments in a drill prefix", () => {
    const cafe = "@café dir";
    expect(detectWithDrill(cafe, cafe.length, "café dir")!.query).toBe("café dir");
    expect(detectWithDrill("@a b/c d", 8, "a b/c d")!.query).toBe("a b/c d");
  });
});
