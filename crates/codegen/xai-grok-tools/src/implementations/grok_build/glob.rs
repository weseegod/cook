//! File-name globbing for the GrokBuild toolset.

use std::path::{Component, Path, PathBuf};

use crate::types::output::ToolOutput;
use crate::types::resources::{DenyReadGlobs, DisplayCwd, display_cwd_or_cwd, resolve_model_path};
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::types::tool_io::ToolInput;

const RESULT_LIMIT: usize = 100;
const DESCRIPTION: &str = "Find files by name using a glob pattern such as `**/*.rs`. \
    `pattern` is relative to `path`, or to the workspace when `path` is omitted. \
    Results are alphabetical and include Git-ignored files. At most 100 files are returned.";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct GlobInput {
    /// File-name pattern relative to `path` or the workspace.
    pub pattern: String,
    /// Directory to search in, relative to the workspace or absolute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl From<GlobInput> for ToolInput {
    fn from(input: GlobInput) -> Self {
        Self::Dynamic(serde_json::to_value(input).expect("GlobInput serializes to JSON"))
    }
}

impl TryFrom<ToolInput> for GlobInput {
    type Error = String;

    fn try_from(input: ToolInput) -> Result<Self, Self::Error> {
        match input {
            ToolInput::Dynamic(value) => {
                serde_json::from_value(value).map_err(|error| error.to_string())
            }
            _ => Err("expected Dynamic input for glob".to_string()),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GlobOutput {
    pub content: String,
}

impl xai_tool_runtime::ToolOutput for GlobOutput {}

impl From<GlobOutput> for ToolOutput {
    fn from(output: GlobOutput) -> Self {
        Self::Text(output.content.into())
    }
}

#[derive(Debug, Default)]
pub struct GlobTool;

impl crate::types::tool_metadata::ToolMetadata for GlobTool {
    fn kind(&self) -> ToolKind {
        ToolKind::List
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        DESCRIPTION
    }
}

impl xai_tool_runtime::Tool for GlobTool {
    type Args = GlobInput;
    type Output = GlobOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("glob").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "glob",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: GlobInput,
    ) -> Result<GlobOutput, xai_tool_runtime::ToolError> {
        let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
        let cwd = crate::types::tool_metadata::resolve_cwd(&ctx, &resources).await?;
        let (display_cwd, deny_read_globs) = {
            let res = resources.lock().await;
            (
                res.get::<DisplayCwd>().map(|display| display.0.clone()),
                res.get::<DenyReadGlobs>()
                    .map(|denies| denies.0.clone())
                    .unwrap_or_default(),
            )
        };
        let root = resolve_model_path(
            &cwd,
            display_cwd.as_deref(),
            input.path.as_deref().unwrap_or(""),
        );
        let display_base = display_cwd_or_cwd(&cwd, display_cwd.as_deref());
        tokio::task::spawn_blocking(move || {
            collect_matches(&root, &input.pattern, &cwd, &display_base, &deny_read_globs)
        })
        .await
        .map_err(|error| {
            xai_tool_runtime::ToolError::custom("glob_task_failed", error.to_string())
        })?
        .map_err(|error| xai_tool_runtime::ToolError::invalid_arguments(error))
    }
}

fn collect_matches(
    root: &Path,
    pattern: &str,
    cwd: &Path,
    display_base: &Path,
    deny_read_globs: &[String],
) -> Result<GlobOutput, String> {
    if pattern.trim().is_empty()
        || Path::new(pattern)
            .components()
            .any(|part| !matches!(part, Component::CurDir | Component::Normal(_)))
    {
        return Err("pattern must be a nonempty path relative to the search directory".into());
    }
    if !root.is_dir() {
        return Err(format!("{} is not a valid directory", root.display()));
    }
    let root_text = root
        .to_str()
        .ok_or_else(|| "search directory is not valid UTF-8".to_string())?;
    let full_pattern = PathBuf::from(glob::Pattern::escape(root_text)).join(pattern);
    let full_pattern = full_pattern
        .to_str()
        .ok_or_else(|| "glob pattern is not valid UTF-8".to_string())?;
    let denied = deny_read_globs
        .iter()
        .map(|rule| glob::Pattern::new(rule).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let paths = glob::glob(full_pattern).map_err(|error| error.to_string())?;
    let mut matches = Vec::new();
    let mut truncated = false;
    for result in paths {
        let path = result.map_err(|error| error.to_string())?;
        if !path.is_file() || is_denied(&path, cwd, &denied) {
            continue;
        }
        if matches.len() == RESULT_LIMIT {
            truncated = true;
            break;
        }
        let shown = path
            .strip_prefix(cwd)
            .map(|relative| display_base.join(relative))
            .unwrap_or(path);
        matches.push(shown.display().to_string());
    }
    let mut content = if matches.is_empty() {
        format!("No files matched pattern {pattern:?}.")
    } else {
        matches.join("\n")
    };
    if truncated {
        content.push_str("\n... (more files omitted; narrow the pattern)");
    }
    Ok(GlobOutput { content })
}

fn is_denied(path: &Path, cwd: &Path, denied: &[glob::Pattern]) -> bool {
    path.ancestors().any(|ancestor| {
        denied.iter().any(|rule| {
            rule.matches_path(ancestor)
                || ancestor
                    .strip_prefix(cwd)
                    .is_ok_and(|relative| rule.matches_path(relative))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_files_including_git_ignored_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/nested")).unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "src/nested/\n").unwrap();
        std::fs::write(tmp.path().join("src/xai-a.test.ts"), "").unwrap();
        std::fs::write(tmp.path().join("src/nested/xai-b.test.ts"), "").unwrap();
        std::fs::write(tmp.path().join("src/nested/other.ts"), "").unwrap();

        let output = collect_matches(tmp.path(), "**/xai*.test.ts", tmp.path(), tmp.path(), &[])
            .unwrap()
            .content;
        assert!(output.contains("src/xai-a.test.ts"));
        assert!(output.contains("src/nested/xai-b.test.ts"));
        assert!(!output.contains("other.ts"));
    }

    #[test]
    fn excludes_denied_paths_and_reports_truncation() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret.pem"), "").unwrap();
        std::fs::create_dir_all(tmp.path().join("private")).unwrap();
        std::fs::write(tmp.path().join("private/hidden.txt"), "").unwrap();
        for index in 0..=RESULT_LIMIT {
            std::fs::write(tmp.path().join(format!("file-{index:03}.txt")), "").unwrap();
        }
        let output = collect_matches(
            tmp.path(),
            "**/*",
            tmp.path(),
            tmp.path(),
            &["**/*.pem".to_string(), "private".to_string()],
        )
        .unwrap()
        .content;
        assert!(!output.contains("secret.pem"));
        assert!(!output.contains("private/hidden.txt"));
        assert_eq!(
            output.lines().filter(|line| line.ends_with(".txt")).count(),
            RESULT_LIMIT
        );
        assert!(output.contains("more files omitted"));
    }

    #[test]
    fn rejects_invalid_or_escaping_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        for pattern in ["[", "../*.rs", "/tmp/*.rs", ""] {
            assert!(
                collect_matches(tmp.path(), pattern, tmp.path(), tmp.path(), &[]).is_err(),
                "pattern {pattern:?} should fail"
            );
        }
    }
}
