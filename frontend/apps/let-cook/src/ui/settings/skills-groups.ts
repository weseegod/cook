import type { SkillView } from "../../acp/extensions";

/**
 * Bundled topic groups for names that do not share a hyphen prefix.
 * Prefix groups (`game-*`, `resume-*`, `create-*`) are derived first; this map only covers the rest.
 */
const CURATED_TOPICS: Array<{ label: string; names: readonly string[] }> = [
  { label: "Documents", names: ["pdf", "docx", "pptx"] },
  { label: "Review", names: ["review", "code-review"] },
  { label: "Plans", names: ["design", "execute-plan", "implement", "pr-babysit"] },
  {
    label: "Skills & workflows",
    names: ["create-skill", "create-workflow", "skill-design-principles"],
  },
  {
    label: "Agent",
    names: ["learn", "long-running-background-tasks", "statusline", "build-with-ai", "imagine"],
  },
];

/** Title-case a hyphen prefix into a group label (`game` → `Game`). */
function titleFromPrefix(prefix: string): string {
  return prefix
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Data-driven prefix groups: ≥2 names sharing `foo-` form a group titled from that prefix.
 * Curated renames may absorb a prefix group (e.g. `Create` → Skills & workflows).
 */
function prefixGroups(names: string[]): Map<string, string> {
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const dash = name.indexOf("-");
    if (dash <= 0) continue;
    const prefix = name.slice(0, dash);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(name);
    else byPrefix.set(prefix, [name]);
  }

  const assignment = new Map<string, string>();
  for (const [prefix, members] of byPrefix) {
    if (members.length < 2) continue;
    const label = titleFromPrefix(prefix);
    for (const name of members) assignment.set(name, label);
  }
  return assignment;
}

/** Curated topic label for a name, or undefined if it is not in the table. */
function curatedLabel(name: string): string | undefined {
  for (const topic of CURATED_TOPICS) {
    if (topic.names.includes(name)) return topic.label;
  }
  return undefined;
}

/**
 * Rank: Project (0), User (1), Plugin (2), then topic groups in CURATED / prefix order,
 * then Other last. Topic ranks start at 3 so source wrappers stay above them.
 */
const TOPIC_RANK: Record<string, number> = {
  Game: 3,
  Resume: 4,
  Documents: 5,
  Review: 6,
  Plans: 7,
  "Skills & workflows": 8,
  Create: 8,
  Agent: 9,
  Other: 100,
};

function sourceGroup(skill: SkillView): { label: string; rank: number } | null {
  const scope = (skill.scope ?? "").toLowerCase();
  if (scope === "local" || scope === "repo") return { label: "Project", rank: 0 };
  if (scope === "user") return { label: "User", rank: 1 };
  if (scope === "plugin" || skill.pluginName) {
    return {
      label: skill.pluginName ? `Plugin: ${skill.pluginName}` : "Plugin",
      rank: 2,
    };
  }
  return null;
}

function topicOf(name: string, prefixMap: Map<string, string>): { label: string; rank: number } {
  // Curated Skills & workflows absorbs create-* and skill-design-principles.
  const curated = curatedLabel(name);
  if (curated) return { label: curated, rank: TOPIC_RANK[curated] ?? 50 };

  const prefixLabel = prefixMap.get(name);
  if (prefixLabel) {
    // Rename Create → Skills & workflows when curated already owns that bucket.
    const label = prefixLabel === "Create" ? "Skills & workflows" : prefixLabel;
    return { label, rank: TOPIC_RANK[label] ?? 50 };
  }

  return { label: "Other", rank: TOPIC_RANK.Other };
}

function groupOf(skill: SkillView, prefixMap: Map<string, string>): { label: string; rank: number } {
  const source = sourceGroup(skill);
  if (source) return source;
  return topicOf(skill.name, prefixMap);
}

/**
 * Group then sort. Project / User / Plugin wrap those sources so a repo skill never lands in a
 * bundled topic. Remaining names form prefix + curated topic groups; unknown names go to Other.
 * Search filters items; groups with zero matches disappear.
 */
export function groupSkills(skills: SkillView[], query: string): Array<{ label: string; skills: SkillView[] }> {
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? skills.filter((skill) => [skill.name, skill.displayName, skill.description, skill.whenToUse, skill.path, skill.pluginName]
        .some((value) => value?.toLowerCase().includes(needle)))
    : skills;

  // Prefix groups are computed over the full non-source remainder so a filtered search does not
  // break a two-name prefix set into Other.
  const remainderNames = skills
    .filter((skill) => !sourceGroup(skill))
    .map((skill) => skill.name);
  const prefixMap = prefixGroups(remainderNames);

  const groups = new Map<string, { rank: number; skills: SkillView[] }>();
  for (const skill of matching) {
    const { label, rank } = groupOf(skill, prefixMap);
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

/** Rows in a group that read enabled. Drives the group switch's on / off / mixed state. */
export function groupEnabledCount(skills: SkillView[]): number {
  return skills.filter((skill) => skill.enabled !== false).length;
}

/**
 * Names whose state differs from `enabled` — the rows a group toggle has to flip.
 * Rows already in the target state are left out.
 */
export function groupToggleTargets(skills: SkillView[], enabled: boolean): string[] {
  return skills
    .filter((skill) => (skill.enabled !== false) !== enabled)
    .map((skill) => skill.name);
}
