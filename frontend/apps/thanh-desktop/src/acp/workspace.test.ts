import { describe, expect, it } from "vitest";
import { fileExtension, formatBytes } from "./workspace";

describe("workspace presentation helpers", () => {
  it("extracts a file extension without treating dotfiles as a language", () => {
    expect(fileExtension("src/App.tsx")).toBe("tsx");
    expect(fileExtension(".env")).toBe("text");
    expect(fileExtension("README")).toBe("text");
  });

  it("formats native file sizes compactly", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(null)).toBe("");
  });
});
