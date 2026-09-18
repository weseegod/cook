import { describe, expect, it } from "vitest";
import type { SkillView } from "../../acp/extensions";
import { groupSkills } from "./skills-groups";

const skill = (over: Partial<SkillView> & { name: string }): SkillView => ({
  enabled: true,
  ...over,
});

const SKILLS: SkillView[] = [
  skill({ name: "review", displayName: "Review", scope: "user" }),
  skill({ name: "pdf", displayName: "PDF", scope: "bundled" }),
  skill({ name: "deploy", displayName: "Deploy", scope: "repo" }),
  skill({ name: "commit", displayName: "Commit", scope: "plugin", pluginName: "cook-core" }),
  skill({ name: "unknown-scope", scope: "mystery" }),
];

describe("groupSkills", () => {
  it("orders groups Project, User, Plugin, Bundled, then Config", () => {
    expect(groupSkills(SKILLS, "").map((group) => group.label)).toEqual([
      "Project",
      "User",
      "Plugin: cook-core",
      "Bundled",
      "Config",
    ]);
  });

  it("sorts rows by label inside a group", () => {
    const bundled = groupSkills(
      [skill({ name: "zzz", displayName: "Alpha", scope: "bundled" }), skill({ name: "aaa", displayName: "Zulu", scope: "bundled" })],
      "",
    );
    expect(bundled[0].skills.map((entry) => entry.displayName)).toEqual(["Alpha", "Zulu"]);
  });

  it("matches the search term against name, label, description, trigger and source", () => {
    const rows = [
      skill({ name: "commit", scope: "user" }),
      skill({ name: "other", displayName: "Other", description: "writes commits", scope: "user" }),
      skill({ name: "third", displayName: "Third", whenToUse: "when committing", scope: "user" }),
      skill({ name: "fourth", path: "/home/demo/skills/commit/SKILL.md", scope: "user" }),
      skill({ name: "fifth", scope: "user" }),
    ];
    const matched = groupSkills(rows, "commit").flatMap((group) => group.skills.map((entry) => entry.name));
    // Rows are label-sorted inside a group, so insertion order is not preserved.
    expect(matched).toEqual(["commit", "fourth", "other", "third"]);
  });

  it("drops groups that have no match instead of rendering a bare header", () => {
    const groups = groupSkills(SKILLS, "pdf");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Bundled");
  });
});
