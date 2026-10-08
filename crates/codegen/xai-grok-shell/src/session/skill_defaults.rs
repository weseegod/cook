//! Compiled defaults for the skills the repository ships.
//!
//! Every entry is a `SKILL.md` under `skills/` at the repository root, compiled into the binary the
//! way `prompts/` supplies the prompt defaults. Settings → Skills → Reset writes one back over the
//! user's copy at `<cook home>/skills/<name>/SKILL.md`.
//!
//! Being in this table is what makes a skill resettable. A name that is not here belongs to the
//! user, a plugin, or a project directory, and has no shipped default to return to — so no path is
//! ever built from a caller's string that the table has not already vouched for.

use std::path::{Path, PathBuf};

/// One `SKILL.md` text for each top-level `skills/` directory that carries one.
///
/// `skills/default-skills.toml` is the install default for `skills.toml`, and `skills/shared/`
/// holds only reference material, so neither is a skill.
const DEFAULT_SKILLS: &[(&str, &str)] = &[
    ("bug-fix", include_str!("../../../../../skills/bug-fix/SKILL.md")),
    (
        "build-with-ai",
        include_str!("../../../../../skills/build-with-ai/SKILL.md"),
    ),
    (
        "code-review",
        include_str!("../../../../../skills/code-review/SKILL.md"),
    ),
    (
        "create-skill",
        include_str!("../../../../../skills/create-skill/SKILL.md"),
    ),
    (
        "create-workflow",
        include_str!("../../../../../skills/create-workflow/SKILL.md"),
    ),
    ("design", include_str!("../../../../../skills/design/SKILL.md")),
    (
        "execute-plan",
        include_str!("../../../../../skills/execute-plan/SKILL.md"),
    ),
    (
        "game-animation-frames",
        include_str!("../../../../../skills/game-animation-frames/SKILL.md"),
    ),
    (
        "game-asset-core",
        include_str!("../../../../../skills/game-asset-core/SKILL.md"),
    ),
    (
        "game-assets",
        include_str!("../../../../../skills/game-assets/SKILL.md"),
    ),
    (
        "game-character-consistency",
        include_str!("../../../../../skills/game-character-consistency/SKILL.md"),
    ),
    (
        "game-tilesets",
        include_str!("../../../../../skills/game-tilesets/SKILL.md"),
    ),
    (
        "game-ui-icons",
        include_str!("../../../../../skills/game-ui-icons/SKILL.md"),
    ),
    ("imagine", include_str!("../../../../../skills/imagine/SKILL.md")),
    (
        "implement",
        include_str!("../../../../../skills/implement/SKILL.md"),
    ),
    ("learn", include_str!("../../../../../skills/learn/SKILL.md")),
    (
        "long-running-background-tasks",
        include_str!("../../../../../skills/long-running-background-tasks/SKILL.md"),
    ),
    ("neon", include_str!("../../../../../skills/neon/SKILL.md")),
    (
        "neon-postgres",
        include_str!("../../../../../skills/neon-postgres/SKILL.md"),
    ),
    (
        "neon-postgres-branches",
        include_str!("../../../../../skills/neon-postgres-branches/SKILL.md"),
    ),
    (
        "pr-babysit",
        include_str!("../../../../../skills/pr-babysit/SKILL.md"),
    ),
    (
        "resume-claude",
        include_str!("../../../../../skills/resume-claude/SKILL.md"),
    ),
    (
        "resume-codex",
        include_str!("../../../../../skills/resume-codex/SKILL.md"),
    ),
    (
        "resume-cursor",
        include_str!("../../../../../skills/resume-cursor/SKILL.md"),
    ),
    ("review", include_str!("../../../../../skills/review/SKILL.md")),
    (
        "skill-design-principles",
        include_str!("../../../../../skills/skill-design-principles/SKILL.md"),
    ),
    (
        "statusline",
        include_str!("../../../../../skills/statusline/SKILL.md"),
    ),
    (
        "threejs-frame-conventions",
        include_str!("../../../../../skills/threejs-frame-conventions/SKILL.md"),
    ),
    (
        "working-plan",
        include_str!("../../../../../skills/working-plan/SKILL.md"),
    ),
];

/// The file every skill body lives in.
pub(crate) const SKILL_FILE_NAME: &str = "SKILL.md";

/// The compiled default body for a shipped skill, or `None` when the name is not one of them.
pub(crate) fn default_for(name: &str) -> Option<&'static str> {
    DEFAULT_SKILLS
        .iter()
        .find(|(skill, _)| *skill == name)
        .map(|(_, body)| *body)
}

/// Every shipped skill name, in table order.
pub(crate) fn catalog() -> Vec<&'static str> {
    DEFAULT_SKILLS.iter().map(|(name, _)| *name).collect()
}

/// `<cook home>/skills`, where a user's copy of a skill lives.
pub(crate) fn user_skills_root() -> PathBuf {
    xai_dirs::grok_home().join(SKILLS_DIR_NAME)
}

/// The user's copy of a shipped skill, or `None` when there is no shipped default for `name`.
///
/// Returning `None` for an unknown name is the guard: the path is only ever built for a name the
/// compiled table vouches for.
pub(crate) fn user_copy_path(name: &str) -> Option<PathBuf> {
    user_copy_path_at(&user_skills_root(), name)
}

/// [`user_copy_path`] against an explicit skills root, so tests are hermetic.
pub(crate) fn user_copy_path_at(skills_root: &Path, name: &str) -> Option<PathBuf> {
    default_for(name)?;
    Some(skills_root.join(name).join(SKILL_FILE_NAME))
}

/// The directory under the cook home that holds user skill copies.
pub(crate) const SKILLS_DIR_NAME: &str = "skills";

/// How a user's copy of a shipped skill relates to the compiled default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkillState {
    /// No user copy; whatever the loader finds next (usually the bundled cache) is in use.
    Absent,
    /// A user copy exists and matches the compiled default.
    Unmodified,
    /// A user copy exists and differs from the compiled default.
    Modified,
}

impl SkillState {
    /// Wire form; the client labels the state from this.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Unmodified => "unmodified",
            Self::Modified => "modified",
        }
    }
}

/// The state of the user's copy at `path`, compared with one trailing newline ignored on both
/// sides, so a file an editor saved with a final newline never reads as an edit.
pub(crate) fn state_of(path: &Path, default: &str) -> SkillState {
    use crate::session::prompt_overrides::trim_template_newline;
    let Ok(text) = std::fs::read_to_string(path) else {
        return SkillState::Absent;
    };
    if trim_template_newline(&text) == trim_template_newline(default) {
        SkillState::Unmodified
    } else {
        SkillState::Modified
    }
}

/// Write the compiled default over the user's copy, creating the skill directory when it is gone.
pub(crate) fn restore_at(path: &Path, default: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is the only thing that makes a skill resettable, so it must cover exactly the
    /// directories `skills/` ships: a new directory with a `SKILL.md` fails here until it is added,
    /// and a stale entry fails once its directory goes away.
    #[test]
    fn catalog_matches_the_authored_skill_directories() {
        let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../skills");
        let mut on_disk: Vec<String> = std::fs::read_dir(&skills)
            .unwrap_or_else(|error| panic!("read {}: {error}", skills.display()))
            .flatten()
            .filter(|entry| entry.path().join(SKILL_FILE_NAME).is_file())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .collect();
        on_disk.sort();

        let mut tabled: Vec<String> = catalog().into_iter().map(str::to_owned).collect();
        tabled.sort();

        assert_eq!(tabled, on_disk, "skills/ and the compiled defaults drifted");
    }

    #[test]
    fn defaults_come_from_the_authored_files_byte_for_byte() {
        let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../skills");
        for name in catalog() {
            let authored = std::fs::read_to_string(skills.join(name).join(SKILL_FILE_NAME))
                .unwrap_or_else(|error| panic!("read skills/{name}/SKILL.md: {error}"));
            assert_eq!(
                default_for(name),
                Some(authored.as_str()),
                "skills/{name}/SKILL.md drifted from its compiled default"
            );
        }
    }

    #[test]
    fn unknown_names_have_no_default_and_no_copy_path() {
        let root = Path::new("/tmp/skills");
        for name in ["", "my-own-skill", "../escape", "review/../.."] {
            assert_eq!(default_for(name), None, "{name} must not be a shipped skill");
            assert_eq!(user_copy_path_at(root, name), None, "{name} must have no copy path");
        }
    }

    #[test]
    fn a_shipped_skill_resolves_its_copy_under_the_skills_root() {
        assert_eq!(
            user_copy_path_at(Path::new("/home/u/.cook/skills"), "review"),
            Some(PathBuf::from("/home/u/.cook/skills/review/SKILL.md"))
        );
    }

    #[test]
    fn state_reads_absent_unmodified_and_modified() {
        let tmp = tempfile::tempdir().unwrap();
        let path = user_copy_path_at(tmp.path(), "review").unwrap();
        let default = default_for("review").unwrap();

        assert_eq!(state_of(&path, default), SkillState::Absent);

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, default).unwrap();
        assert_eq!(state_of(&path, default), SkillState::Unmodified);

        // A different trailing newline is not an edit: the authored default already ends with one.
        std::fs::write(&path, default.trim_end_matches('\n')).unwrap();
        assert_eq!(state_of(&path, default), SkillState::Unmodified);

        std::fs::write(&path, "rewritten body\n").unwrap();
        assert_eq!(state_of(&path, default), SkillState::Modified);
    }

    #[test]
    fn restore_creates_the_skill_directory_and_writes_the_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = user_copy_path_at(tmp.path(), "review").unwrap();
        let default = default_for("review").unwrap();

        restore_at(&path, default).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), default);
        assert_eq!(state_of(&path, default), SkillState::Unmodified);
    }
}
