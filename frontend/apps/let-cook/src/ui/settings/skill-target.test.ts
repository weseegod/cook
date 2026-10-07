import { describe, expect, it } from "vitest";
import { cookHomeFromConfigPath, skillFileTarget } from "./skill-target";

const HOME = "/home/u";
const COOK_HOME = "/home/u/.cook";

describe("cookHomeFromConfigPath", () => {
  it("takes the directory holding config.toml", () => {
    expect(cookHomeFromConfigPath("/home/u/.cook/config.toml")).toBe("/home/u/.cook");
    expect(cookHomeFromConfigPath("/Users/u/.cook/config.toml/")).toBe("/Users/u/.cook");
  });

  it("answers undefined when there is no directory to take", () => {
    expect(cookHomeFromConfigPath(undefined)).toBeUndefined();
    expect(cookHomeFromConfigPath("")).toBeUndefined();
    expect(cookHomeFromConfigPath("config.toml")).toBeUndefined();
  });
});

describe("skillFileTarget", () => {
  it("saves a user skill in place", () => {
    expect(skillFileTarget(
      { name: "review", scope: "user", path: `${COOK_HOME}/skills/review/SKILL.md` },
      COOK_HOME,
    )).toEqual({ path: `${COOK_HOME}/skills/review/SKILL.md`, fork: false });
  });

  it("saves a project skill in place, where a user copy would be shadowed", () => {
    expect(skillFileTarget(
      { name: "ship", scope: "repo", path: "/work/app/.cook/skills/ship/SKILL.md" },
      COOK_HOME,
    )).toEqual({ path: "/work/app/.cook/skills/ship/SKILL.md", fork: false });
    expect(skillFileTarget(
      { name: "ship", scope: "local", path: "/work/app/.cook/skills/ship/SKILL.md" },
      COOK_HOME,
    )).toEqual({ path: "/work/app/.cook/skills/ship/SKILL.md", fork: false });
  });

  it("forks a bundled skill into the user skills directory", () => {
    expect(skillFileTarget(
      { name: "pdf", scope: "bundled", path: `${COOK_HOME}/bundled/skills/pdf/SKILL.md` },
      COOK_HOME,
    )).toEqual({ path: `${COOK_HOME}/skills/pdf/SKILL.md`, fork: true });
  });

  it("forks a plugin skill into the user skills directory", () => {
    expect(skillFileTarget(
      { name: "login", scope: "plugin", path: "/plugins/acme/skills/login/SKILL.md" },
      COOK_HOME,
    )).toEqual({ path: `${COOK_HOME}/skills/login/SKILL.md`, fork: true });
  });

  it("forks a user skill that came from a configured path", () => {
    expect(skillFileTarget(
      { name: "mine", scope: "user", path: `/home/u/my-skills/mine/SKILL.md` },
      COOK_HOME,
    )).toEqual({ path: `${COOK_HOME}/skills/mine/SKILL.md`, fork: true });
  });

  it("has nowhere to save without a path or a cook home", () => {
    expect(skillFileTarget({ name: "pdf", scope: "bundled" }, COOK_HOME)).toBeUndefined();
    expect(skillFileTarget({ name: "pdf", scope: "bundled", path: `${COOK_HOME}/bundled/skills/pdf/SKILL.md` }, undefined))
      .toBeUndefined();
    expect(skillFileTarget({ name: "pdf", scope: "bundled", path: "  " }, COOK_HOME)).toBeUndefined();
  });

  it("keeps the home directory's own trailing slash out of the fork path", () => {
    expect(skillFileTarget(
      { name: "pdf", scope: "bundled", path: "/home/u/.cook/bundled/skills/pdf/SKILL.md" },
      `${HOME}/.cook/`,
    )).toEqual({ path: "/home/u/.cook/skills/pdf/SKILL.md", fork: true });
  });
});
