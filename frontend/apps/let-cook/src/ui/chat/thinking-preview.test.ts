import { describe, expect, it } from "vitest";
import { thinkingPreview } from "./thinking-preview";

describe("thinkingPreview", () => {
  it("keeps a short block whole and shows no ellipsis", () => {
    expect(thinkingPreview("first\nsecond\nthird")).toEqual({ text: "first\nsecond\nthird", truncated: false });
  });

  it("keeps the last three lines of a longer block", () => {
    expect(thinkingPreview("one\ntwo\nthree\nfour\nfive")).toEqual({ text: "three\nfour\nfive", truncated: true });
  });

  it("drops trailing blank lines before deciding", () => {
    expect(thinkingPreview("one\ntwo\nthree\n\n")).toEqual({ text: "one\ntwo\nthree", truncated: false });
  });

  it("reports an empty block as empty, not as one blank line", () => {
    expect(thinkingPreview("  \n\n")).toEqual({ text: "", truncated: false });
  });
});
