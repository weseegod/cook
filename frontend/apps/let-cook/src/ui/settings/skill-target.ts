/**
 * Where an edited skill prompt is written.
 *
 * Everything the user edits converges on `<cook home>/skills/` — the user skills directory — so an
 * edited bundled, server or plugin skill becomes a user copy. A copy would be shadowed for a skill
 * that already lives under the user directory (nothing to do) and for a project skill (Local and
 * Repo outrank User), so those two save in place.
 */

/** The `SKILL.md` a textarea writes. What the caller sends to `x.ai/fs/write_file`. */
export interface SkillTarget {
  /** Absolute path to write. */
  path: string;
  /** True when the write lands outside the skill's own file (a user copy). */
  fork: boolean;
}

export interface SkillTargetInput {
  name: string;
  scope?: string;
  path?: string;
}

/** `<cook home>` from the config path the host reports (`<cook home>/config.toml`). */
export function cookHomeFromConfigPath(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  const trimmed = configPath.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  if (at <= 0) return undefined;
  return trimmed.slice(0, at);
}

function isInside(parent: string, path: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/**
 * The file an edit saves to, or `undefined` when the skill has no path to write.
 * `cookHome` is `undefined` until the host answered, which leaves a fork with nowhere to go.
 */
export function skillFileTarget(skill: SkillTargetInput, cookHome: string | undefined): SkillTarget | undefined {
  const own = skill.path?.trim();
  if (!own) return undefined;

  const userSkills = cookHome ? `${cookHome.replace(/\/+$/, "")}/skills` : undefined;
  if (userSkills && isInside(userSkills, own)) return { path: own, fork: false };

  // A project skill outranks a user copy, so a fork would never be the definition in play.
  const scope = (skill.scope ?? "").toLowerCase();
  if (scope === "local" || scope === "repo") return { path: own, fork: false };

  if (!userSkills) return undefined;
  return { path: `${userSkills}/${skill.name}/SKILL.md`, fork: true };
}
