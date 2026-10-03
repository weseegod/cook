//! Passive working plan: session-dir save and the TaskOpen reminder sentence.
//!
//! The skill text lives next to the tool. This module writes the episode with the plan-mode
//! allocator and does not activate plan mode. The checklist stays in the saved markdown.

use std::path::{Path, PathBuf};

const WRITE_FINISH_REMINDER: &str = "\
Do not end the turn on a promise to create a file. After a rejected oversized write, make a \
smaller edit or write next — a later read does not finish the work.";

/// Write-finish sentence. Initial-skill policy lives in the system prompt.
pub(crate) fn entry_reminder(_surface: xai_grok_agent::ToolSurface) -> String {
    WRITE_FINISH_REMINDER.to_string()
}

pub(crate) fn is_save_working_plan(name: &str) -> bool {
    matches!(name, "save_working_plan" | "GrokBuild:save_working_plan")
}

pub(crate) fn allowed_on_surface(
    projects_tool_surface: bool,
    surface: xai_grok_agent::ToolSurface,
) -> bool {
    projects_tool_surface && surface == xai_grok_agent::ToolSurface::TaskOpen
}

/// Write `body` under `<session>/plans/` and publish the H1 slug.
///
/// A later save on the same open task passes `overwrite` and replaces that file in place.
/// Does not change plan-mode state and does not set an approved-plan flag.
pub(crate) fn save_working_plan(
    session_dir: &Path,
    body: &str,
    overwrite: Option<&Path>,
) -> Result<PathBuf, String> {
    if body.trim().is_empty() {
        return Err("save_working_plan needs a markdown body.".into());
    }
    if let Some(existing) = overwrite.filter(|path| path.is_file()) {
        std::fs::write(existing, body).map_err(|error| error.to_string())?;
        return Ok(existing.to_path_buf());
    }
    let path = crate::session::plan_mode::next_episode_path(session_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(crate::session::plan_mode::publish_plan_episode(&path))
}

#[cfg(test)]
#[path = "acp_session_tests/working_plan_tests.rs"]
mod tests;
