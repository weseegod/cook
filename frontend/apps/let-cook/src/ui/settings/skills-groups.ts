import type { SkillView } from "../../acp/extensions";

/** Rank order copied from the TUI's `skill_group`: Project, User, Plugin, Bundled, Server, Config. */
const SKILL_GROUPS: Array<{ label: string; scopes: string[] }> = [
  { label: "Project", scopes: ["local", "repo"] },
  { label: "User", scopes: ["user"] },
  { label: "Plugin", scopes: ["plugin"] },
  { label: "Bundled", scopes: ["bundled"] },
  { label: "Server", scopes: ["server"] },
];

/** Plugin skills carry their plugin name in the label, so rank comes from the scope, not the text. */
const CONFIG_RANK = SKILL_GROUPS.length;

function groupOf(skill: SkillView): { label: string; rank: number } {
  const scope = (skill.scope ?? "").toLowerCase();
  const index = SKILL_GROUPS.findIndex((group) => group.scopes.includes(scope));
  if (skill.pluginName) {
    return { label: `Plugin: ${skill.pluginName}`, rank: index === -1 ? 2 : index };
  }
  if (index === -1) return { label: "Config", rank: CONFIG_RANK };
  return { label: SKILL_GROUPS[index].label, rank: index };
}

/**
 * Group then sort, mirroring the TUI's Skills tab. A search term matches name, label, description,
 * source path or trigger text; groups with no match disappear instead of rendering a bare header.
 */
export function groupSkills(skills: SkillView[], query: string): Array<{ label: string; skills: SkillView[] }> {
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? skills.filter((skill) => [skill.name, skill.displayName, skill.description, skill.whenToUse, skill.path, skill.pluginName]
        .some((value) => value?.toLowerCase().includes(needle)))
    : skills;

  const groups = new Map<string, { rank: number; skills: SkillView[] }>();
  for (const skill of matching) {
    const { label, rank } = groupOf(skill);
    const current = groups.get(label);
    if (current) current.skills.push(skill);
    else groups.set(label, { rank, skills: [skill] });
  }

  return [...groups.entries()]
    .map(([label, group]) => ({
      label,
      rank: group.rank,
      skills: [...group.skills].sort((a, b) =>
        (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, undefined, { sensitivity: "base" })),
    }))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ label, skills: rows }) => ({ label, skills: rows }));
}
