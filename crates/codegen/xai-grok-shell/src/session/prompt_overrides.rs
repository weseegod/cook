//! Runtime overrides for model-facing prompt templates.
//!
//! Every default is compiled into the binary (authored under `prompts/` in the repository). A user
//! can drop a file at the same relative path under `<cook home>/prompts/` — or, per project, under
//! `<cwd>/.cook/prompts/` — and the shell serves that text instead, with no rebuild.
//!
//! Precedence: project `.cook/prompts/`, then `<cook home>/prompts/`, then the compiled default.
//! A missing or unreadable override falls back to the default rather than failing the turn.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// Directory name under a scope root; `prompts/plan/contract.md` in the repository is overridden by
/// `<cook home>/prompts/plan/contract.md`.
pub(crate) const PROMPTS_DIR_NAME: &str = "prompts";

/// Drop one trailing newline.
///
/// Files (`include_str!` and user overrides alike) keep their own trailing newline; the templates
/// are authored without one, so a default and an override with identical bodies resolve to
/// identical text.
pub(crate) fn trim_template_newline(text: &str) -> &str {
    text.strip_suffix('\n').unwrap_or(text)
}

/// Accept only a plain relative path of normal components, so an override can never escape the
/// scope root it was resolved against.
pub(crate) fn sanitize_relative(relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty() || path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// `<cook home>/prompts`.
pub(crate) fn user_overrides_root() -> PathBuf {
    xai_dirs::grok_home().join(PROMPTS_DIR_NAME)
}

/// `<project root>/.cook/prompts`.
pub(crate) fn project_overrides_root(project_root: &Path) -> PathBuf {
    project_root.join(".cook").join(PROMPTS_DIR_NAME)
}

/// Parsed override files, keyed by absolute path and invalidated when size or mtime changes.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, SystemTime, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn file_state(meta: &std::fs::Metadata) -> Option<(u64, SystemTime)> {
    Some((meta.len(), meta.modified().ok()?))
}

/// Read one override file, using the cache when size and mtime are unchanged.
fn read_file_cached(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let state = file_state(&meta);
    let key = path.to_path_buf();
    {
        let cache = CACHE.lock().unwrap();
        if let (Some((len, mtime)), Some((cached_len, cached_mtime, text))) =
            (state, cache.get(&key))
            && *cached_len == len
            && *cached_mtime == mtime
        {
            return Some(text.clone());
        }
    }
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if let Some((len, mtime)) = state {
                CACHE.lock().unwrap().insert(key, (len, mtime, text.clone()));
            }
            Some(text)
        }
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                %error,
                "failed to read prompt override; using the compiled default"
            );
            None
        }
    }
}

/// The override text for `relative`, if any. `project_root` is the session working directory when
/// the caller has one; a project override outranks the user's home override.
pub(crate) fn read_override(relative: &str, project_root: Option<&Path>) -> Option<String> {
    read_override_at(&user_overrides_root(), relative, project_root)
}

/// [`read_override`] against an explicit user root, so tests are hermetic.
pub(crate) fn read_override_at(
    user_root: &Path,
    relative: &str,
    project_root: Option<&Path>,
) -> Option<String> {
    let relative = sanitize_relative(relative)?;
    if let Some(root) = project_root
        && let Some(text) = read_file_cached(&project_overrides_root(root).join(&relative))
    {
        return Some(text);
    }
    read_file_cached(&user_root.join(&relative))
}

/// The text for a prompt template: the user's override byte for byte when present, otherwise
/// `default` byte for byte. Callers whose template has no trailing newline (the plan-mode
/// reminders) apply [`trim_template_newline`] afterwards so an editor's final newline is not
/// significant; templates that rely on a trailing newline (goal rules and continuation blocks)
/// take the text as-is.
pub(crate) fn resolve(relative: &str, default: &str, project_root: Option<&Path>) -> String {
    resolve_at(&user_overrides_root(), relative, default, project_root)
}

/// [`resolve`] against an explicit user root, so tests are hermetic.
pub(crate) fn resolve_at(
    user_root: &Path,
    relative: &str,
    default: &str,
    project_root: Option<&Path>,
) -> String {
    read_override_at(user_root, relative, project_root).unwrap_or_else(|| default.to_string())
}

/// A user-editable prompt template: its path relative to a prompts root, and the compiled default
/// that a reset restores.
pub(crate) struct PromptEntry {
    pub relative: &'static str,
    pub default: &'static str,
}

/// Every prompt template the Settings → Prompts surface can edit. Adding a prompt here is what
/// makes it listable, editable, and resettable.
pub(crate) fn catalog() -> Vec<PromptEntry> {
    use crate::session::acp_session;
    use crate::session::goal_classifier;
    use crate::session::goal_planner;
    use crate::session::goal_strategist;
    use crate::session::goal_summarizer;
    use crate::session::plan_mode;
    vec![
        PromptEntry {
            relative: "plan/contract.md",
            default: plan_mode::plan_mode_contract_template(),
        },
        PromptEntry {
            relative: "goal/goal_rules.md",
            default: acp_session::GOAL_RULES_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_rules_legacy.md",
            default: acp_session::GOAL_RULES_TEMPLATE_LEGACY,
        },
        PromptEntry {
            relative: "goal/goal_plan_block.md",
            default: acp_session::GOAL_PLAN_BLOCK_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_task_discipline.md",
            default: acp_session::GOAL_TASK_DISCIPLINE_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_continuation_directive.md",
            default: acp_session::GOAL_CONTINUATION_DIRECTIVE_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_continuation_directive_legacy.md",
            default: acp_session::GOAL_CONTINUATION_DIRECTIVE_TEMPLATE_LEGACY,
        },
        PromptEntry {
            relative: "goal/goal_planner_prompt.md",
            default: goal_planner::GOAL_PLANNER_PROMPT_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_strategist_prompt.md",
            default: goal_strategist::GOAL_STRATEGIST_PROMPT_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_summarizer_prompt.md",
            default: goal_summarizer::GOAL_SUMMARIZER_PROMPT_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_verifier_prompt.md",
            default: goal_classifier::GOAL_VERIFIER_PROMPT_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_verifier_resume_prompt.md",
            default: goal_classifier::GOAL_VERIFIER_RESUME_PROMPT_TEMPLATE,
        },
        PromptEntry {
            relative: "goal/goal_verifier_kind_lens_code_change.md",
            default: goal_classifier::KIND_LENS_CODE_CHANGE_BODY,
        },
        PromptEntry {
            relative: "goal/goal_verifier_kind_lens_research.md",
            default: goal_classifier::KIND_LENS_RESEARCH_BODY,
        },
        PromptEntry {
            relative: "goal/goal_verifier_kind_lens_analysis.md",
            default: goal_classifier::KIND_LENS_ANALYSIS_BODY,
        },
        PromptEntry {
            relative: SUBAGENT_GENERAL_PURPOSE,
            default: xai_grok_agent::prompt::subagent_prompts::GENERAL_PURPOSE_PROMPT,
        },
        PromptEntry {
            relative: SUBAGENT_EXPLORE,
            default: xai_grok_agent::prompt::subagent_prompts::EXPLORE_PROMPT,
        },
        PromptEntry {
            relative: SUBAGENT_PLAN,
            default: xai_grok_agent::prompt::subagent_prompts::PLAN_PROMPT,
        },
    ]
}

/// Override path for the built-in **general-purpose** subagent body.
pub(crate) const SUBAGENT_GENERAL_PURPOSE: &str = "subagent/general-purpose.md";
/// Override path for the built-in **explore** subagent body.
pub(crate) const SUBAGENT_EXPLORE: &str = "subagent/explore.md";
/// Override path for the built-in **plan** subagent body.
pub(crate) const SUBAGENT_PLAN: &str = "subagent/plan.md";

/// The override path for a built-in subagent name, or `None` when the name is not one of the three
/// built-in subagent bodies. Names match `BuiltinAgentName`'s kebab-case serialization.
pub(crate) fn subagent_override_relative(name: &str) -> Option<&'static str> {
    match name {
        "general-purpose" => Some(SUBAGENT_GENERAL_PURPOSE),
        "explore" => Some(SUBAGENT_EXPLORE),
        "plan" => Some(SUBAGENT_PLAN),
        _ => None,
    }
}

/// Replace a built-in subagent definition's prompt body with the user's override, when one exists.
///
/// Only `AgentScope::BuiltIn` definitions are touched: a project, user, or bundled agent that
/// shadows one of these names already carries its own body, and re-pointing it at the builtin
/// file would discard the user's file.
pub(crate) fn apply_subagent_body_override(
    definition: &mut xai_grok_agent::config::AgentDefinition,
    project_root: Option<&Path>,
) -> bool {
    apply_subagent_body_override_at(&user_overrides_root(), definition, project_root)
}

/// [`apply_subagent_body_override`] against an explicit user root, so tests are hermetic.
pub(crate) fn apply_subagent_body_override_at(
    user_root: &Path,
    definition: &mut xai_grok_agent::config::AgentDefinition,
    project_root: Option<&Path>,
) -> bool {
    if definition.scope != xai_grok_agent::config::AgentScope::BuiltIn {
        return false;
    }
    let Some(relative) = subagent_override_relative(&definition.name) else {
        return false;
    };
    let Some(text) = read_override_at(user_root, relative, project_root) else {
        return false;
    };
    definition.prompt_body = Some(text);
    true
}

/// Whether the user's copy differs from the compiled default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverrideState {
    /// No user file; the compiled default is served.
    Absent,
    /// A user file exists and still matches the compiled default.
    Unmodified,
    /// A user file exists and differs from the compiled default.
    Modified,
}

/// One prompt's user copy under a prompts root.
pub(crate) struct PromptStatus {
    pub relative: &'static str,
    pub path: PathBuf,
    pub state: OverrideState,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// The manifest records the compiled defaults' checksums, so a hand-edited file can be reported as
/// modified without re-deriving every default. Format matches `xai-grok-bundle`'s manifest.
pub(crate) fn manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

/// Write (or refresh) `<root>/manifest.json` from the current compiled defaults.
pub(crate) fn ensure_manifest_at(root: &Path) -> std::io::Result<crate::bundle::BundleManifest> {
    let checksums = catalog()
        .into_iter()
        .map(|entry| {
            (
                entry.relative.to_string(),
                sha256_hex(trim_template_newline(entry.default).as_bytes()),
            )
        })
        .collect();
    let manifest = crate::bundle::BundleManifest {
        version: format!("prompts-{}", env!("CARGO_PKG_VERSION")),
        checksums,
    };
    std::fs::create_dir_all(root)?;
    let json = serde_json::to_vec_pretty(&manifest)?;
    std::fs::write(manifest_path(root), json)?;
    Ok(manifest)
}

/// Compare against the default with one trailing newline ignored on both sides, so a file an editor
/// saved with a final newline does not read as an edit.
fn state_of(path: &Path, default: &str) -> OverrideState {
    let Ok(text) = std::fs::read_to_string(path) else {
        return OverrideState::Absent;
    };
    if sha256_hex(trim_template_newline(&text).as_bytes())
        == sha256_hex(trim_template_newline(default).as_bytes())
    {
        OverrideState::Unmodified
    } else {
        OverrideState::Modified
    }
}

/// The user copy's path for `relative` under `root`, or `None` for an unsafe relative path.
pub(crate) fn path_at(root: &Path, relative: &str) -> Option<PathBuf> {
    sanitize_relative(relative).map(|relative| root.join(relative))
}

/// Status of every catalog entry under `root`, in catalog order.
pub(crate) fn statuses_at(root: &Path) -> Vec<PromptStatus> {
    catalog()
        .into_iter()
        .filter_map(|entry| {
            let path = path_at(root, entry.relative)?;
            let state = state_of(&path, entry.default);
            Some(PromptStatus {
                relative: entry.relative,
                path,
                state,
            })
        })
        .collect()
}

/// The compiled default for a catalog entry, or `None` when `relative` is not one.
pub(crate) fn default_for(relative: &str) -> Option<&'static str> {
    catalog()
        .into_iter()
        .find(|entry| entry.relative == relative)
        .map(|entry| entry.default)
}

/// Read the user's copy of a catalog entry, refusing entries that are not in the catalog so a
/// caller cannot read arbitrary files under the root.
pub(crate) fn read_user_text_at(root: &Path, relative: &str) -> Option<String> {
    default_for(relative)?;
    let path = path_at(root, relative)?;
    std::fs::read_to_string(&path).ok()
}

/// Write the user's copy of a catalog entry and drop the loader's cache for that path.
pub(crate) fn write_user_text_at(root: &Path, relative: &str, text: &str) -> std::io::Result<()> {
    let path = path_at(root, relative).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsafe prompt path")
    })?;
    if default_for(relative).is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unknown prompt",
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, text)?;
    CACHE.lock().unwrap().remove(&path);
    Ok(())
}

/// Restore a catalog entry to the compiled default, byte for byte.
pub(crate) fn restore_at(root: &Path, relative: &str) -> std::io::Result<()> {
    let default = default_for(relative).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "unknown prompt")
    })?;
    write_user_text_at(root, relative, default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cook-prompt-overrides-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    #[test]
    fn sanitize_relative_rejects_escapes() {
        assert!(sanitize_relative("plan/full.md").is_some());
        assert!(sanitize_relative("../secret.md").is_none());
        assert!(sanitize_relative("/etc/passwd").is_none());
        assert!(sanitize_relative("").is_none());
        assert!(sanitize_relative("plan/../../x.md").is_none());
    }

    #[test]
    fn missing_file_falls_back_to_default() {
        let user = temp_root("missing-user");
        let project = temp_root("missing-project");
        let resolved = resolve_at(&user, "plan/full.md", "compiled default", Some(&project));
        assert_eq!(resolved, "compiled default");
    }

    #[test]
    fn project_override_outranks_user_and_is_served_verbatim() {
        let user = temp_root("project-user");
        let project = temp_root("project-project");
        let user_path = user.join("plan/full.md");
        std::fs::create_dir_all(user_path.parent().unwrap()).unwrap();
        std::fs::write(&user_path, "user text\n").unwrap();

        let project_path = project_overrides_root(&project).join("plan/full.md");
        std::fs::create_dir_all(project_path.parent().unwrap()).unwrap();
        std::fs::write(&project_path, "project text\n").unwrap();

        assert_eq!(
            resolve_at(&user, "plan/full.md", "compiled default", Some(&project)),
            "project text\n",
            "the project scope outranks the user root"
        );
        // Without a project root the user copy is what is served, byte for byte.
        assert_eq!(
            resolve_at(&user, "plan/full.md", "compiled default", None),
            "user text\n"
        );
    }

    #[test]
    fn cache_invalidates_when_the_file_changes() {
        let user = temp_root("cache-user");
        let project = temp_root("cache-project");
        let path = project_overrides_root(&project).join("plan/full.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "first").unwrap();
        assert_eq!(
            read_override_at(&user, "plan/full.md", Some(&project)).unwrap(),
            "first"
        );
        std::fs::write(&path, "second attempt").unwrap();
        assert_eq!(
            read_override_at(&user, "plan/full.md", Some(&project)).unwrap(),
            "second attempt"
        );
    }

    #[test]
    fn unreadable_override_falls_back_to_default() {
        let user = temp_root("unreadable-user");
        let project = temp_root("unreadable-project");
        let path = project_overrides_root(&project).join("plan/full.md");
        std::fs::create_dir_all(&path).unwrap();
        assert_eq!(
            resolve_at(&user, "plan/full.md", "compiled default", Some(&project)),
            "compiled default"
        );
    }

    /// Pins every catalog entry to its authored file under `prompts/`: a move that changes the
    /// bytes, or an include path that points elsewhere, fails here. One trailing newline is
    /// ignored on both sides because the plan-mode strings carry none while their files do.
    #[test]
    fn catalog_defaults_match_the_authored_prompt_files() {
        let prompts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../prompts");
        for entry in catalog() {
            let authored = std::fs::read_to_string(prompts.join(entry.relative))
                .unwrap_or_else(|error| panic!("read prompts/{}: {error}", entry.relative));
            assert_eq!(
                trim_template_newline(&authored),
                trim_template_newline(entry.default),
                "prompts/{} drifted from the compiled default",
                entry.relative
            );
        }
    }

    #[test]
    fn manifest_records_every_catalog_default() {
        let root = temp_root("manifest");
        let manifest = ensure_manifest_at(&root).unwrap();
        assert_eq!(manifest.checksums.len(), catalog().len());
        assert!(manifest.version.starts_with("prompts-"));
        let read_back = crate::bundle::read_cached_manifest(&root).unwrap().unwrap();
        assert_eq!(read_back, manifest);
    }

    /// The local hasher must agree with the bundle crate's, so manifest checksums and
    /// `crate::bundle::checksum_file` stay interchangeable.
    #[test]
    fn local_checksum_matches_the_bundle_crate() {
        let root = temp_root("checksum");
        let path = root.join("sample.md");
        std::fs::write(&path, b"hello\n").unwrap();
        assert_eq!(
            sha256_hex(b"hello\n"),
            crate::bundle::checksum_file(&path).unwrap()
        );
    }

    #[test]
    fn status_reports_absent_unmodified_and_modified() {
        let root = temp_root("status");
        assert_eq!(statuses_at(&root).len(), catalog().len());
        assert!(
            statuses_at(&root)
                .iter()
                .all(|status| status.state == OverrideState::Absent)
        );

        restore_at(&root, "plan/contract.md").unwrap();
        let contract = statuses_at(&root)
            .into_iter()
            .find(|status| status.relative == "plan/contract.md")
            .unwrap();
        assert_eq!(contract.state, OverrideState::Unmodified);

        std::fs::write(&contract.path, "edited\n").unwrap();
        let edited = statuses_at(&root)
            .into_iter()
            .find(|status| status.relative == "plan/contract.md")
            .unwrap();
        assert_eq!(edited.state, OverrideState::Modified);
    }

    #[test]
    fn restore_writes_the_default_byte_for_byte_and_invalidates_the_cache() {
        let root = temp_root("restore");
        let path = path_at(&root, "plan/contract.md").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "user text\n").unwrap();
        assert_eq!(
            read_file_cached(&path).as_deref(),
            Some("user text\n"),
            "overrides should serve the user's text first"
        );

        restore_at(&root, "plan/contract.md").unwrap();
        let default = default_for("plan/contract.md").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            default,
            "restore must write the compiled default byte for byte"
        );
        assert_eq!(
            read_file_cached(&path).as_deref(),
            Some(default),
            "restore must not leave a stale cached override"
        );
    }

    #[test]
    fn write_refuses_unknown_or_unsafe_entries() {
        let root = temp_root("write");
        assert!(write_user_text_at(&root, "../escape.md", "x").is_err());
        assert!(write_user_text_at(&root, "plan/unknown.md", "x").is_err());
        assert!(write_user_text_at(&root, "plan/full.md", "ok").is_err());
        assert!(write_user_text_at(&root, "plan/contract.md", "ok").is_ok());
        assert_eq!(
            read_user_text_at(&root, "plan/contract.md").as_deref(),
            Some("ok")
        );
        assert!(read_user_text_at(&root, "plan/unknown.md").is_none());
        assert!(read_user_text_at(&root, "plan/full.md").is_none());
    }

    #[test]
    fn subagent_catalog_covers_the_three_builtins() {
        for relative in [SUBAGENT_GENERAL_PURPOSE, SUBAGENT_EXPLORE, SUBAGENT_PLAN] {
            assert!(
                default_for(relative).is_some(),
                "{relative} must be in the catalog"
            );
        }
        assert_eq!(
            subagent_override_relative("general-purpose"),
            Some(SUBAGENT_GENERAL_PURPOSE)
        );
        assert_eq!(subagent_override_relative("explore"), Some(SUBAGENT_EXPLORE));
        assert_eq!(subagent_override_relative("plan"), Some(SUBAGENT_PLAN));
        assert_eq!(subagent_override_relative("reviewer"), None);
    }

    #[test]
    fn builtin_subagent_body_keeps_the_compiled_default_without_an_override() {
        let user = temp_root("subagent-default");
        let mut definition = xai_grok_agent::config::AgentDefinition::explore();
        let compiled = definition.prompt_body.clone().unwrap();
        assert!(!apply_subagent_body_override_at(&user, &mut definition, None));
        assert_eq!(definition.prompt_body.as_deref(), Some(compiled.as_str()));
    }

    #[test]
    fn builtin_subagent_body_is_replaced_by_an_override() {
        let user = temp_root("subagent-override");
        let path = user.join(SUBAGENT_EXPLORE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "custom explore body\n").unwrap();
        let mut definition = xai_grok_agent::config::AgentDefinition::explore();
        assert!(apply_subagent_body_override_at(&user, &mut definition, None));
        assert_eq!(
            definition.prompt_body.as_deref(),
            Some("custom explore body\n")
        );
    }

    /// A project, user, or bundled agent that shadows a builtin name already carries its own body;
    /// the override must not re-point it at the builtin file.
    #[test]
    fn shadowing_definition_keeps_its_own_body() {
        let user = temp_root("subagent-shadow");
        let path = user.join(SUBAGENT_EXPLORE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "custom explore body\n").unwrap();
        let mut definition = xai_grok_agent::config::AgentDefinition::explore();
        definition.scope = xai_grok_agent::config::AgentScope::Project;
        assert!(!apply_subagent_body_override_at(&user, &mut definition, None));
    }
}
