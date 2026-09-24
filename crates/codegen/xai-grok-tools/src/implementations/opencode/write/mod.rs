//! OpenCode `write` tool — writes entire file contents to disk.
//!
//! Creates parent directories as needed and emits `FileWritten` notifications.

use crate::notification::types::FileWritten;

use crate::types::output::{
    SearchReplaceEditContextInformation, SearchReplaceEditDetail, SearchReplaceEditsApplied,
    SearchReplaceOutput,
};
use crate::types::requirements::Expr;
#[allow(unused_imports)]
use crate::types::resources::{
    Cwd, DisplayCwd, FileSystem, NotificationHandle, SharedResources, resolve_model_path,
};
use crate::types::tool::{ToolKind, ToolNamespace};

// ─── Description ─────────────────────────────────────────────────────

const DESCRIPTION: &str = r#"Create a new file.

- Parent directories are created for you.
- This tool refuses to overwrite an existing non-empty file.
${%- if tools.by_kind.edit %}
- To change an existing file (replace a string or a few lines, or rewrite contents), use `${{ tools.by_kind.edit }}` with `${{ params.edit.old_string }}` / `${{ params.edit.new_string }}`.
${%- endif %}
${%- if tools.by_kind.read %}
- Read an existing file first with `${{ tools.by_kind.read }}` before editing it.
${%- endif %}"#;

// ─── Input ───────────────────────────────────────────────────────────

/// Input for the `write` tool.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct WriteInput {
    /// The absolute path to the file to write.
    pub file_path: String,

    /// The full file content to write.
    pub content: String,
}

// ─── Tool ────────────────────────────────────────────────────────────

/// OpenCode write tool — writes entire file contents to disk.
#[derive(Debug, Default)]
pub struct WriteTool;

type WriteOutput = SearchReplaceOutput;

/// Durable memory files live under a `memory/` directory and are named `MEMORY.md`.
/// Models rewrite them with `write` as part of the memory_search round-trip.
fn is_durable_memory_md_path(path: &std::path::Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some("MEMORY.md")
        && path.components().any(|c| c.as_os_str() == "memory")
}

impl crate::types::tool_metadata::ToolMetadata for WriteTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Write
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::OpenCode
    }

    fn description_template(&self) -> &str {
        DESCRIPTION
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        &["FileWritten"]
    }

    fn requires_expr(&self) -> Expr<crate::types::requirements::ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for WriteTool {
    type Args = WriteInput;
    type Output = WriteOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("write").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "write",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.write", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: WriteInput,
    ) -> Result<WriteOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let (cwd, display_cwd, fs, notification_handle) = {
            let cwd = crate::types::tool_metadata::resolve_cwd(&ctx, &resources).await?;
            let res = resources.lock().await;
            let display_cwd = res.get::<DisplayCwd>().map(|d| d.0.clone());
            let fs = res.require::<FileSystem>()?.0.clone();
            let notification_handle = res.require::<NotificationHandle>()?.0.clone();
            (cwd, display_cwd, fs, notification_handle)
        };
        let tool_call_id = ctx.call_id.as_str().to_owned();

        // Resolve the model-provided path.
        let path = resolve_model_path(&cwd, display_cwd.as_deref(), &input.file_path);

        if input.file_path.contains('\n') || input.file_path.contains('\r') {
            return Ok(SearchReplaceOutput::InvalidInput(
                "file_path must be a single path without newlines. Use search_replace to edit an existing file's contents (old_string / new_string)."
                    .into(),
            ));
        }

        // Non-empty text writes get a POSIX trailing newline (same rule apply_patch
        // uses). Models often copy a one-line secret without the terminator the
        // source file had.
        let mut content = input.content;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }

        // ── Check if file exists and read old content ────────────
        let (mut existed, mut old_content) = match fs.read_file(&path).await {
            Ok(bytes) => (true, Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(_) => (false, None),
        };
        let is_memory_write = match crate::types::memory_v2::write_memory_v2_file(
            &resources,
            &path,
            content.as_bytes(),
        )
        .await
        {
            Ok(crate::types::memory_v2::MemoryV2Write::Written { previous_content }) => {
                existed = previous_content.is_some();
                old_content =
                    previous_content.map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                true
            }
            Ok(crate::types::memory_v2::MemoryV2Write::Outside) => false,
            Err(error) => {
                return Ok(SearchReplaceOutput::InvalidInput(error));
            }
        };

        // Ordinary workspace writes create files; in-place edits go through search_replace.
        // Memory-v2 paths are exempt (durable memory is updated by rewriting MEMORY.md).
        // When memory v2 is inactive, still allow rewriting durable MEMORY.md under a memory/
        // directory — that is the documented durable-memory write path for memory_search.
        if !is_memory_write
            && !is_durable_memory_md_path(&path)
            && existed
            && old_content.as_ref().is_some_and(|c| !c.is_empty())
        {
            return Ok(SearchReplaceOutput::InvalidInput(format!(
                "Refusing to overwrite existing non-empty file `{}`. Use the search_replace tool to edit existing files (old_string / new_string). Use write only to create a new file.",
                path.display()
            )));
        }

        // ── Create parent directories if needed ──────────────────
        if !is_memory_write
            && let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                let ce = crate::computer::types::ComputerError::from(e);
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("write").expect("valid"),
                    ce.to_string(),
                )
            })?;
        }

        // ── Write the file ───────────────────────────────────────
        if !is_memory_write {
            fs.write_file(&path, content.as_bytes())
                .await
                .map_err(|e| {
                    xai_tool_runtime::ToolError::execution(
                        xai_tool_protocol::ToolId::new("write").expect("valid"),
                        e.to_string(),
                    )
                })?;
        }

        // ── Send FileWritten notification ────────────────────────
        notification_handle.send_file_written(FileWritten {
            tool_call_id,
            absolute_path: path.clone(),
            content: content.clone(),
            previous_content: old_content.clone(),
            is_new_file: !existed,
        });

        let old_string = old_content.unwrap_or_default();
        let new_string = content;

        let edits = vec![SearchReplaceEditDetail {
            old_string: old_string.clone(),
            old_line: 1,
            new_string: new_string.clone(),
            new_line: 1,
            context_before: String::new(),
            context_after: String::new(),
            line_prefix: String::new(),
        }];

        let tool_output_for_prompt = if existed {
            format!("Wrote file successfully to {}.", path.display())
        } else {
            format!("The file {} has been created.", path.display())
        };

        // Counter span: lines written (diffed against prior content so an
        // overwrite only counts the lines that actually changed).
        let (lines_added, lines_removed) =
            crate::types::output::line_diff(&old_string, &new_string);
        tracing::info_span!(
            "edit.lines",
            tool_name = "write",
            lines_added = lines_added,
            lines_removed = lines_removed
        )
        .in_scope(|| {});

        Ok(SearchReplaceOutput::EditsApplied(
            SearchReplaceEditsApplied {
                old_string,
                new_string,
                tool_output_for_prompt: tool_output_for_prompt.clone(),
                tool_output_for_prompt_concise: Some(tool_output_for_prompt),
                absolute_path: path,
                edits: SearchReplaceEditContextInformation { details: edits },
                patch: None,
                unicode_normalized: false,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::types::tool_metadata::test_ctx;
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;
    use crate::computer::local::LocalFs;
    use crate::notification::types::ToolNotificationHandle;
    use crate::types::resources::Resources;
    use tempfile::TempDir;

    /// Set up Resources with real filesystem for tests.
    fn test_resources(cwd: &std::path::Path) -> Resources {
        let mut resources = Resources::new();
        resources.insert(Cwd(cwd.to_path_buf()));
        resources.insert(FileSystem(Arc::new(LocalFs)));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));
        resources
    }

    // ── Write new file ──────────────────────────────────────────

    #[tokio::test]
    async fn write_new_file_creates_with_correct_content() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());
        let shared_resources = resources.into_shared();

        let input = WriteInput {
            file_path: tmp.path().join("new.txt").to_string_lossy().into_owned(),
            content: "hello\nworld\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(shared_resources.clone()), input)
            .await
            .unwrap();

        match &result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(applied.tool_output_for_prompt.contains("created"));
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
        let content = std::fs::read_to_string(tmp.path().join("new.txt")).unwrap();
        assert_eq!(content, "hello\nworld\n");
    }

    // ── Overwrite existing non-empty file is refused ────────────

    #[tokio::test]
    async fn refuse_newline_in_file_path() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: "first\nDONE-EDIT\nlast".to_string(),
            content: "first\nDONE-EDIT\nlast".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        match &result {
            SearchReplaceOutput::InvalidInput(msg) => {
                assert!(
                    msg.contains("without newlines") && msg.contains("search_replace"),
                    "newline path must steer to search_replace: {msg}"
                );
            }
            other => panic!("Expected InvalidInput, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn durable_memory_md_may_be_overwritten() {
        let tmp = TempDir::new().unwrap();
        let memory_dir = tmp.path().join("memory");
        std::fs::create_dir_all(&memory_dir).unwrap();
        let file_path = memory_dir.join("MEMORY.md");
        std::fs::write(&file_path, "# Global Memory\n\n").unwrap();

        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: file_path.to_string_lossy().into_owned(),
            content: "# Global Memory\n\n- MARKER-line\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(
            matches!(result, SearchReplaceOutput::EditsApplied(_)),
            "MEMORY.md under memory/ must remain writable"
        );
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert!(content.contains("MARKER-line"));
    }

    #[tokio::test]
    async fn refuse_overwrite_existing_nonempty_file() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("existing.txt");
        std::fs::write(&file_path, "old content\n").unwrap();

        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: file_path.to_string_lossy().into_owned(),
            content: "new content\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        match &result {
            SearchReplaceOutput::InvalidInput(msg) => {
                assert!(
                    msg.contains("search_replace") && msg.contains("Refusing"),
                    "overwrite must steer to search_replace: {msg}"
                );
            }
            other => panic!("Expected InvalidInput, got {:?}", other),
        }
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "old content\n");
    }

    #[tokio::test]
    async fn overwrite_existing_empty_file_is_allowed() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("empty.txt");
        std::fs::write(&file_path, "").unwrap();

        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: file_path.to_string_lossy().into_owned(),
            content: "filled\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(matches!(result, SearchReplaceOutput::EditsApplied(_)));
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "filled\n");
    }

    // ── Creates parent directories ──────────────────────────────

    #[tokio::test]
    async fn creates_parent_directories() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let nested = tmp.path().join("a/b/c/file.txt");
        let input = WriteInput {
            file_path: nested.to_string_lossy().into_owned(),
            content: "nested\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(matches!(result, SearchReplaceOutput::EditsApplied(_)));
        let content = std::fs::read_to_string(&nested).unwrap();
        assert_eq!(content, "nested\n");
    }

    // ── Tool metadata ──────────────────────────────────────────

    #[test]
    fn tool_metadata() {
        use crate::types::tool_metadata::ToolMetadata;
        let tool = WriteTool;
        assert_eq!(xai_tool_runtime::Tool::id(&tool).as_str(), "write");
        assert!(matches!(tool.kind(), ToolKind::Write));
        assert!(matches!(tool.tool_namespace(), ToolNamespace::OpenCode));
    }

    #[test]
    fn description_prefers_edit_for_small_in_place_changes() {
        use crate::types::tool_metadata::ToolMetadata;
        use crate::types::template_renderer::TemplateRenderer;
        let edit_params = std::collections::HashMap::from([
            ("old_string".to_string(), "old_string".to_string()),
            ("new_string".to_string(), "new_string".to_string()),
        ]);
        let renderer = TemplateRenderer::new(
            std::collections::HashMap::from([(ToolKind::Edit, "search_replace".to_string())]),
            std::collections::HashMap::from([(ToolKind::Edit, edit_params)]),
        );
        let rendered = renderer
            .render(ToolMetadata::description_template(&WriteTool))
            .unwrap();
        assert!(
            rendered.contains("search_replace")
                && rendered.contains("refuses to overwrite")
                && rendered.contains("old_string"),
            "write description must steer edits to search_replace:\n{rendered}"
        );
    }

    // ── Serde roundtrip ────────────────────────────────────────

    #[test]
    fn serde_roundtrip() {
        let json = r#"{"file_path":"/tmp/test.txt","content":"hello world"}"#;
        let input: WriteInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.file_path, "/tmp/test.txt");
        assert_eq!(input.content, "hello world");

        // Serializes back to snake_case
        let serialized = serde_json::to_string(&input).unwrap();
        assert!(serialized.contains("file_path"));
        assert!(!serialized.contains("filePath"));
    }

    // ── Empty content write ────────────────────────────────────

    #[tokio::test]
    async fn empty_content_write() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let file_path = tmp.path().join("empty.txt");
        let input = WriteInput {
            file_path: file_path.to_string_lossy().into_owned(),
            content: String::new(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(matches!(result, SearchReplaceOutput::EditsApplied(_)));
        assert!(file_path.exists());
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert!(content.is_empty());
    }

    // ── Trailing newline normalization ─────────────────────────

    #[tokio::test]
    async fn nonempty_write_without_trailing_newline_gains_one() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: tmp.path().join("line.txt").to_string_lossy().into_owned(),
            content: "MARKER-only-line".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(matches!(result, SearchReplaceOutput::EditsApplied(_)));
        let content = std::fs::read_to_string(tmp.path().join("line.txt")).unwrap();
        assert_eq!(content, "MARKER-only-line\n");
    }

    #[tokio::test]
    async fn nonempty_write_keeps_existing_trailing_newline() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: tmp.path().join("line.txt").to_string_lossy().into_owned(),
            content: "already-terminated\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        assert!(matches!(result, SearchReplaceOutput::EditsApplied(_)));
        let content = std::fs::read_to_string(tmp.path().join("line.txt")).unwrap();
        assert_eq!(content, "already-terminated\n");
    }

    // ── Create preserves path in output ────────────────────────

    #[tokio::test]
    async fn create_preserves_path_in_output() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("output_check.txt");

        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: file_path.to_string_lossy().into_owned(),
            content: "new\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        match &result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert!(
                    applied
                        .tool_output_for_prompt
                        .contains(&file_path.display().to_string()),
                    "tool_output_for_prompt should contain the file path: {}",
                    applied.tool_output_for_prompt
                );
                assert_eq!(applied.absolute_path, file_path);
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
    }

    // ── Relative path resolution ───────────────────────────────

    #[tokio::test]
    async fn relative_path_resolution() {
        let tmp = TempDir::new().unwrap();
        let tool = WriteTool;
        let resources = test_resources(tmp.path());

        let input = WriteInput {
            file_path: "subdir/relative.txt".to_string(),
            content: "resolved\n".to_string(),
        };
        let result = xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input)
            .await
            .unwrap();

        let expected = tmp.path().join("subdir/relative.txt");
        match &result {
            SearchReplaceOutput::EditsApplied(applied) => {
                assert_eq!(applied.absolute_path, expected);
            }
            other => panic!("Expected EditsApplied, got {:?}", other),
        }
        let content = std::fs::read_to_string(&expected).unwrap();
        assert_eq!(content, "resolved\n");
    }

    // ── Missing FileSystem resource ────────────────────────────

    #[tokio::test]
    async fn missing_filesystem_resource() {
        let mut resources = Resources::new();
        resources.insert(Cwd(PathBuf::from("/tmp")));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));
        // No FileSystem inserted

        let tool = WriteTool;
        let input = WriteInput {
            file_path: "/tmp/test.txt".to_string(),
            content: "data".to_string(),
        };
        let result =
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input).await;

        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("missing required resource"),
        );
    }

    // ── Missing Cwd resource ───────────────────────────────────

    #[tokio::test]
    async fn missing_cwd_resource() {
        let mut resources = Resources::new();
        resources.insert(FileSystem(Arc::new(LocalFs)));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));
        // No Cwd inserted

        let tool = WriteTool;
        let input = WriteInput {
            file_path: "/tmp/test.txt".to_string(),
            content: "data".to_string(),
        };
        let result =
            xai_tool_runtime::Tool::run(&tool, test_ctx(resources.into_shared()), input).await;

        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Cwd not available"),
        );
    }

    // ── Notification fields ───────────────────────────────────

    #[test]
    fn notification_fields() {
        // Notification verification requires capturing handle.
        // Covered at integration layer.
    }
}
