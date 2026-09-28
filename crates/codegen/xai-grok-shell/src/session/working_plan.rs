//! Passive working plan: short shape, session-dir save, and the TaskOpen reminder sentence.
//!
//! The skill text lives next to the tool. This module writes the episode with the plan-mode
//! allocator and does not activate plan mode.

use std::path::{Path, PathBuf};

#[cfg(test)]
pub(crate) use xai_grok_tools::implementations::grok_build::working_plan::WORKING_PLAN_SKILL_BODY as working_plan_skill_body;
pub(crate) use xai_grok_tools::implementations::grok_build::working_plan::working_plan_shape;

const WRITE_FINISH_REMINDER: &str = "\
Do not end the turn on a promise to create a file. After a rejected oversized write, make a \
smaller edit or write next — a later read does not finish the work.";

const TASK_OPEN_WORKING_PLAN_REMINDER: &str = "\
If this task needs several new files, or the file split is not already in the prompt, load the \
working-plan skill and save that short plan before the first code edit, then keep implementing. \
Skip this for a small edit.";

/// Write-finish sentence, plus the working-plan sentence on TaskOpen only.
pub(crate) fn entry_reminder(surface: xai_grok_agent::ToolSurface) -> String {
    let mut text = WRITE_FINISH_REMINDER.to_string();
    if surface == xai_grok_agent::ToolSurface::TaskOpen {
        text.push_str("\n\n");
        text.push_str(TASK_OPEN_WORKING_PLAN_REMINDER);
    }
    text
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
/// Does not change plan-mode state and does not set an approved-plan flag.
pub(crate) fn save_working_plan(session_dir: &Path, body: &str) -> Result<PathBuf, String> {
    working_plan_shape(body)?;
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
