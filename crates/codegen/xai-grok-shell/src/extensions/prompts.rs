//! `x.ai/prompts/*` exposes the user-editable copies of the shell's prompt templates.
//!
//! Defaults are compiled into the binary from `prompts/` in the repository; a copy under
//! `<cook home>/prompts/` overrides one at runtime (`session/prompt_overrides.rs`). These methods
//! back Settings → Prompts in the desktop client: list every catalog entry with its state, read and
//! write the user's copy, and reset it to the compiled default.
//!
//! Every path is resolved through the catalog, so a caller can never read or write outside
//! `<cook home>/prompts/`.

use std::path::Path;

use agent_client_protocol as acp;
use serde::Deserialize;

use super::{ExtResult, to_ext_response};
use crate::session::prompt_overrides::{
    self, OverrideState, PromptStatus, ensure_manifest_at, read_user_text_at, restore_at,
    statuses_at, write_user_text_at,
};

/// Wire form of [`OverrideState`]; the client shows "Modified" from this.
fn state_name(state: OverrideState) -> &'static str {
    match state {
        OverrideState::Absent => "absent",
        OverrideState::Unmodified => "unmodified",
        OverrideState::Modified => "modified",
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptEntryView {
    /// Path relative to the prompts root, e.g. `plan/full.md`.
    relative: String,
    /// Absolute path of the user's copy, whether or not it exists yet.
    path: String,
    /// `absent` | `unmodified` | `modified`.
    state: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptList {
    /// The prompts root these paths live under.
    root: String,
    prompts: Vec<PromptEntryView>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptContent {
    relative: String,
    path: String,
    state: &'static str,
    /// The user's copy; `None` when absent, so the client can tell "no copy yet" from an empty file.
    content: Option<String>,
    /// The compiled default for this entry, so the editor can seed a first edit and Restore has a target.
    default: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptWriteResult {
    relative: String,
    state: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRelativeRequest {
    relative: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptWriteRequest {
    relative: String,
    content: String,
}

fn entry_view(root: &Path, status: &PromptStatus) -> PromptEntryView {
    PromptEntryView {
        relative: status.relative.to_string(),
        path: status.path.to_string_lossy().into_owned(),
        state: state_name(status.state),
    }
}

/// Catalog entries and their state, refreshing `manifest.json` first.
pub(crate) fn list_at(root: &Path) -> anyhow::Result<PromptList> {
    ensure_manifest_at(root)?;
    Ok(PromptList {
        root: root.to_string_lossy().into_owned(),
        prompts: statuses_at(root)
            .iter()
            .map(|status| entry_view(root, status))
            .collect(),
    })
}

/// One entry's user copy. An unknown `relative` is an error; a known-but-absent one returns
/// `content: None` with the compiled default alongside, so the client can seed an edit.
pub(crate) fn read_at(root: &Path, relative: &str) -> anyhow::Result<PromptContent> {
    let default = prompt_overrides::default_for(relative)
        .ok_or_else(|| anyhow::anyhow!("unknown prompt: {relative}"))?;
    let path = prompt_overrides::path_at(root, relative)
        .ok_or_else(|| anyhow::anyhow!("unsafe prompt path: {relative}"))?;
    let state = statuses_at(root)
        .into_iter()
        .find(|status| status.relative == relative)
        .map(|status| status.state)
        .unwrap_or(OverrideState::Absent);
    Ok(PromptContent {
        relative: relative.to_string(),
        path: path.to_string_lossy().into_owned(),
        state: state_name(state),
        content: read_user_text_at(root, relative),
        default: default.to_string(),
    })
}

/// Write the user's copy. The returned state is `modified`, or `unmodified` when the text matches
/// the compiled default exactly.
pub(crate) fn write_at(
    root: &Path,
    relative: &str,
    content: &str,
) -> anyhow::Result<PromptWriteResult> {
    write_user_text_at(root, relative, content)?;
    Ok(PromptWriteResult {
        relative: relative.to_string(),
        state: state_name(state_after(root, relative)),
    })
}

/// Reset the user's copy to the compiled default, byte for byte.
pub(crate) fn restore_at_default(
    root: &Path,
    relative: &str,
) -> anyhow::Result<PromptWriteResult> {
    restore_at(root, relative)?;
    Ok(PromptWriteResult {
        relative: relative.to_string(),
        state: state_name(state_after(root, relative)),
    })
}

fn state_after(root: &Path, relative: &str) -> OverrideState {
    statuses_at(root)
        .into_iter()
        .find(|status| status.relative == relative)
        .map(|status| status.state)
        .unwrap_or(OverrideState::Absent)
}

pub async fn handle(args: &acp::ExtRequest) -> ExtResult {
    match args.method.as_ref() {
        "x.ai/prompts/list" => {
            let root = prompt_overrides::user_overrides_root();
            to_ext_response(list_at(&root))
        }
        "x.ai/prompts/read" => {
            let req = super::parse_params::<PromptRelativeRequest>(args)?;
            let root = prompt_overrides::user_overrides_root();
            to_ext_response(read_at(&root, &req.relative))
        }
        "x.ai/prompts/write" => {
            let req = super::parse_params::<PromptWriteRequest>(args)?;
            let root = prompt_overrides::user_overrides_root();
            to_ext_response(write_at(&root, &req.relative, &req.content))
        }
        "x.ai/prompts/restore" => {
            let req = super::parse_params::<PromptRelativeRequest>(args)?;
            let root = prompt_overrides::user_overrides_root();
            to_ext_response(restore_at_default(&root, &req.relative))
        }
        other => Err(acp::Error::method_not_found().data(format!("unknown prompts method: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cook-prompts-ext-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_reports_every_entry_as_absent_before_any_edit() {
        let root = temp_root("list");
        let list = list_at(&root).unwrap();
        assert_eq!(list.root, root.to_string_lossy());
        assert!(!list.prompts.is_empty());
        assert!(list.prompts.iter().all(|entry| entry.state == "absent"));
        assert!(
            list.prompts
                .iter()
                .any(|entry| entry.relative == "plan/full.md"),
            "plan/full.md must be editable: {:?}",
            list.prompts.iter().map(|e| &e.relative).collect::<Vec<_>>()
        );
        assert!(root.join("manifest.json").is_file());
    }

    #[test]
    fn write_then_read_then_restore_round_trip() {
        let root = temp_root("roundtrip");
        let absent = read_at(&root, "plan/full.md").unwrap();
        assert_eq!(absent.content, None);
        assert_eq!(
            absent.default,
            prompt_overrides::default_for("plan/full.md").unwrap(),
            "read must hand back the compiled default so the editor can seed an edit"
        );

        let written = write_at(&root, "plan/full.md", "edited by the user\n").unwrap();
        assert_eq!(written.state, "modified");
        let read = read_at(&root, "plan/full.md").unwrap();
        assert_eq!(read.content.as_deref(), Some("edited by the user\n"));
        assert_eq!(read.state, "modified");

        let restored = restore_at_default(&root, "plan/full.md").unwrap();
        assert_eq!(restored.state, "unmodified");
        let after = read_at(&root, "plan/full.md").unwrap();
        assert_eq!(
            after.content.as_deref(),
            prompt_overrides::default_for("plan/full.md"),
            "restore must write the compiled default"
        );
    }

    #[test]
    fn write_rejects_unknown_and_escaping_paths() {
        let root = temp_root("reject");
        assert!(write_at(&root, "../escape.md", "x").is_err());
        assert!(write_at(&root, "plan/unknown.md", "x").is_err());
        assert!(read_at(&root, "../escape.md").is_err());
        assert!(restore_at_default(&root, "../../etc/hosts").is_err());
        assert!(!root.join("escape.md").exists());
    }

    #[test]
    fn writing_the_default_text_reports_unmodified() {
        let root = temp_root("identical");
        let default = prompt_overrides::default_for("plan/exit.md").unwrap();
        let written = write_at(&root, "plan/exit.md", &format!("{default}\n")).unwrap();
        assert_eq!(written.state, "unmodified");
        // A goal template keeps its own trailing newline; restoring it verbatim is also unmodified.
        let goal_default = prompt_overrides::default_for("goal/goal_rules.md").unwrap();
        let written = write_at(&root, "goal/goal_rules.md", goal_default).unwrap();
        assert_eq!(written.state, "unmodified");
        let written = write_at(&root, "goal/goal_rules.md", "changed").unwrap();
        assert_eq!(written.state, "modified");
        assert_eq!(restore_at_default(&root, "goal/goal_rules.md").unwrap().state, "unmodified");
    }

    #[test]
    fn catalog_covers_the_plan_goal_and_subagent_prompts() {
        let root = temp_root("catalog");
        let list = list_at(&root).unwrap();
        let relatives: Vec<&str> = list.prompts.iter().map(|entry| entry.relative.as_str()).collect();
        for expected in [
            "plan/full.md",
            "goal/goal_rules.md",
            "goal/goal_task_discipline.md",
            "goal/goal_planner_prompt.md",
            "goal/goal_verifier_prompt.md",
            "goal/goal_verifier_kind_lens_code_change.md",
            "subagent/general-purpose.md",
            "subagent/explore.md",
            "subagent/plan.md",
        ] {
            assert!(relatives.contains(&expected), "missing {expected} in {relatives:?}");
        }
    }
}
