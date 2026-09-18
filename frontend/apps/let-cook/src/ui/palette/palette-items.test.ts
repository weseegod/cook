import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIONS, buildPaletteItems, paletteActions, rankPaletteItems, scoreItem } from "./palette-items";

const source = {
  sessions: [
    { id: "s1", title: "Fix login bug", cwd: "/home/demo/app" },
    { id: "s2", title: "Refactor provider settings", cwd: "/home/demo/app" },
  ],
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
    { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
  ],
  commands: [
    { name: "model", description: "Switch model" },
    { name: "memory", description: "Edit memory" },
  ],
};

describe("palette items", () => {
  it("covers sessions, models, slash commands and the built-in actions", () => {
    const items = buildPaletteItems(source);
    expect(items.filter((item) => item.kind === "session").map((item) => item.id)).toEqual(["session:s1", "session:s2"]);
    expect(items.filter((item) => item.kind === "model").map((item) => item.value)).toEqual(["deepseek-chat", "grok-4.5"]);
    expect(items.filter((item) => item.kind === "command").map((item) => item.label)).toEqual(["/model", "/memory"]);
    const actions = items.filter((item) => item.kind === "action").map((item) => item.action);
    for (const expected of ["new-session", "open-folder", "settings", "connect-provider", "fork-session", "export-transcript", "rewind", "recap"]) {
      expect(actions).toContain(expected);
    }
    expect(DEFAULT_ACTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("gates rewind and recap actions on initialize feature flags", () => {
    expect(paletteActions({ cancelRewindEnabled: false, sessionRecapEnabled: true }).map((a) => a.action))
      .not.toContain("rewind");
    expect(paletteActions({ cancelRewindEnabled: true, sessionRecapEnabled: false }).map((a) => a.action))
      .not.toContain("recap");
    expect(paletteActions({ cancelRewindEnabled: true, sessionRecapEnabled: true }).map((a) => a.action))
      .toEqual(expect.arrayContaining(["rewind", "recap"]));
  });

  it("carries the payload each action needs to run", () => {
    const items = buildPaletteItems(source);
    expect(items.find((item) => item.id === "session:s2")?.value).toBe("s2");
    expect(items.find((item) => item.id === "command:memory")?.value).toBe("memory");
    expect(items.find((item) => item.id === "model:grok-4.5")?.action).toBe("model");
    expect(items.find((item) => item.id === "model:grok-4.5")?.detail).toContain("xai");
  });
});

describe("palette ranking", () => {
  const items = buildPaletteItems(source);

  it("lists actions first when the query is empty, then commands, models, sessions", () => {
    const ranked = rankPaletteItems(items, "", 24);
    const kinds = ranked.map((item) => item.kind);
    expect(kinds[0]).toBe("action");
    expect(kinds.indexOf("command")).toBeLessThan(kinds.indexOf("model"));
    expect(kinds.indexOf("model")).toBeLessThan(kinds.indexOf("session"));
  });

  it("ranks an exact label match above a prefix match", () => {
    const exact = scoreItem({ id: "x", kind: "model", label: "memory", action: "model" }, "memory");
    const prefix = scoreItem({ id: "y", kind: "session", label: "memory notes", action: "session" }, "memory");
    expect(exact).toBeGreaterThan(prefix);
  });

  it("filters out everything that does not match", () => {
    expect(rankPaletteItems(items, "zzzz").map((item) => item.id)).toEqual([]);
    expect(rankPaletteItems(items, "settings").map((item) => item.action)).toContain("settings");
  });

  it("finds a session by title and a model by its provider", () => {
    expect(rankPaletteItems(items, "login")[0].value).toBe("s1");
    expect(rankPaletteItems(items, "deepseek")[0].value).toBe("deepseek-chat");
  });

  it("matches inside words, so `/model` is reachable from `del`", () => {
    expect(rankPaletteItems(items, "del").some((item) => item.value === "model")).toBe(true);
  });

  it("honours the result limit", () => {
    expect(rankPaletteItems(items, "", 3)).toHaveLength(3);
  });
});
