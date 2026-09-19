import { describe, expect, it } from "vitest";
import type { SkillView } from "../../acp/extensions";
import { groupEnabledCount, groupSkills, groupToggleTargets } from "./skills-groups";

const skill = (over: Partial<SkillView> & { name: string }): SkillView => ({
  enabled: true,
  scope: "bundled",
  ...over,
});

/** The 25 bundled names `~/.cook/bundled/skills/` actually has. */
const BUNDLED_25: SkillView[] = [
  "game-animation-frames",
  "game-asset-core",
  "game-character-consistency",
  "game-tilesets",
  "game-ui-icons",
  "resume-claude",
  "resume-codex",
  "resume-cursor",
  "pdf",
  "docx",
  "pptx",
  "review",
  "code-review",
  "design",
  "execute-plan",
  "implement",
  "pr-babysit",
  "create-skill",
  "create-workflow",
  "skill-design-principles",
  "learn",
  "long-running-background-tasks",
  "statusline",
  "build-with-ai",
  "imagine",
].map((name) => skill({ name }));

describe("groupSkills", () => {
  it("splits 25 bundled names into topic groups in rank order", () => {
    const groups = groupSkills(BUNDLED_25, "");
    expect(groups.map((group) => group.label)).toEqual([
      "Game",
      "Resume",
      "Documents",
      "Review",
      "Plans",
      "Skills & workflows",
      "Agent",
    ]);
    expect(groups.map((group) => group.skills.length)).toEqual([5, 3, 3, 2, 4, 3, 5]);
  });

  it("keeps a repo skill named pdf in Project, not Documents", () => {
    const groups = groupSkills([
      skill({ name: "pdf", scope: "repo" }),
      skill({ name: "docx" }),
    ], "");
    expect(groups.map((group) => group.label)).toEqual(["Project", "Documents"]);
    expect(groups[0].skills[0].name).toBe("pdf");
    expect(groups[1].skills[0].name).toBe("docx");
  });

  it("places plugin skills before topic groups", () => {
    const groups = groupSkills([
      skill({ name: "commit", scope: "plugin", pluginName: "cook-core" }),
      skill({ name: "pdf" }),
    ], "");
    expect(groups.map((group) => group.label)).toEqual(["Plugin: cook-core", "Documents"]);
  });

  it("puts unknown bundled names in Other", () => {
    const groups = groupSkills([skill({ name: "brand-new-skill" })], "");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Other");
  });

  it("drops groups that have no search match", () => {
    const groups = groupSkills(BUNDLED_25, "pdf");
    expect(groups.map((group) => group.label)).toEqual(["Documents"]);
    expect(groups[0].skills.map((entry) => entry.name)).toEqual(["pdf"]);
  });

  it("sorts rows by label inside a group", () => {
    const bundled = groupSkills(
      [skill({ name: "pptx", displayName: "Zulu" }), skill({ name: "pdf", displayName: "Alpha" })],
      "",
    );
    expect(bundled[0].skills.map((entry) => entry.displayName)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("group switch helpers", () => {
  it("counts the rows that read enabled", () => {
    expect(groupEnabledCount([
      skill({ name: "a", enabled: true }),
      skill({ name: "b", enabled: false }),
      skill({ name: "c" }),
    ])).toBe(2);
  });

  it("targets only the currently-enabled game names when turning Game off", () => {
    const game = [
      skill({ name: "game-tilesets", enabled: true }),
      skill({ name: "game-asset-core", enabled: false }),
      skill({ name: "game-ui-icons", enabled: true }),
    ];
    expect(groupToggleTargets(game, false)).toEqual(["game-tilesets", "game-ui-icons"]);
  });

  it("sends every row when the group is uniform", () => {
    const rows = [skill({ name: "a" }), skill({ name: "b" })];
    expect(groupToggleTargets(rows, false)).toEqual(["a", "b"]);
  });
});
