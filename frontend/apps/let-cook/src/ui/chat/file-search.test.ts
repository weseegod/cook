import { describe, expect, it } from "vitest";
import type { WorkspaceIndexEntry } from "../../acp/workspace";
import { detect } from "./at-context";
import { acceptReplacement, applyReplacement, fuzzyScore, rankFileSearch } from "./file-search";

const INDEX: WorkspaceIndexEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
  { path: "src/main.tsx", kind: "file" },
  { path: "src/theme", kind: "directory" },
  { path: "src/theme/app.css", kind: "file" },
];

describe("file-search", () => {
  it("lists depth-1 entries for an empty query, directories first", () => {
    const ranked = rankFileSearch(INDEX, "");
    expect(ranked.map((row) => row.path)).toEqual(["src", "README.md"]);
  });

  it("ranks mai toward src/main.tsx", () => {
    const ranked = rankFileSearch(INDEX, "mai");
    expect(ranked[0]?.path).toBe("src/main.tsx");
    expect(fuzzyScore("src/main.tsx", "mai")).not.toBeNull();
    expect(fuzzyScore("README.md", "mai")).toBeNull();
  });

  it("accepts a file as @path with trailing space and dismiss", () => {
    const text = "@mai";
    const ctx = detect(text, text.length)!;
    const replacement = acceptReplacement(text, ctx, {
      path: "src/main.tsx",
      kind: "file",
      score: 1,
      indices: [],
    });
    expect(replacement.dismiss).toBe(true);
    expect(replacement.text).toBe("src/main.tsx ");
    expect(applyReplacement(text, replacement).text).toBe("@src/main.tsx ");
  });

  it("accepts a directory in dir-mode by appending / and staying open", () => {
    const text = "@src/";
    const ctx = detect(text, text.length)!;
    const replacement = acceptReplacement(text, ctx, {
      path: "src",
      kind: "directory",
      score: 1,
      indices: [],
    });
    expect(replacement.dismiss).toBe(false);
    expect(replacement.text).toBe("src/");
    expect(replacement.drillPrefix).toBe("src");
  });

  it("does not open on email-like text", () => {
    expect(detect("user@ex", 7)).toBeNull();
  });
});
