//! `code_nav` tool — symbol navigation on the workspace codebase index.
//!
//! Answers "where is this symbol defined" and "who references it" by name or
//! by a 1-based file position. The index already exists for code navigation;
//! this exposes it to the model. Structural search stays with `ast_grep`.
//!
//! The backend is injected by the host (shell) as a
//! [`CodeNavBackend`] resource, so this crate does not depend on the index
//! implementation.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::types::output::ToolOutput;
use crate::types::resources::SharedResources;
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::util::truncate::truncate_str_with_marker;

/// Byte cap on the rendered location list.
const MAX_OUTPUT_BYTES: usize = 40_000;

/// A single definition or reference location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeNavLocation {
    pub path: String,
    /// 1-based line number.
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

/// Host-provided symbol navigation over the codebase index.
///
/// `file` paths are absolute. `line` and `column` are 1-based, matching
/// `xai_codebase_graph`'s position convention.
#[async_trait::async_trait]
pub trait CodeNavBackend: Send + Sync + 'static {
    async fn goto_definition(
        &self,
        file: String,
        line: u32,
        column: u32,
    ) -> Result<Vec<CodeNavLocation>, String>;

    async fn goto_references(
        &self,
        file: String,
        line: u32,
        column: u32,
        include_definition: bool,
    ) -> Result<Vec<CodeNavLocation>, String>;

    async fn find_definitions(
        &self,
        symbol: String,
        context_file: Option<String>,
    ) -> Result<Vec<CodeNavLocation>, String>;

    async fn find_references(
        &self,
        symbol: String,
        context_file: Option<String>,
    ) -> Result<Vec<CodeNavLocation>, String>;
}

/// Resource wrapper so the backend round-trips through `Resources`.
#[derive(Clone)]
pub struct CodeNavBackendHandle(pub Arc<dyn CodeNavBackend>);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeNavOperation {
    /// Definition of the symbol at a position.
    GotoDefinition,
    /// References to the symbol at a position.
    GotoReferences,
    /// Definitions matching a symbol name.
    FindDefinitions,
    /// References matching a symbol name.
    FindReferences,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CodeNavInput {
    #[schemars(description = "Which navigation query to run.")]
    pub operation: CodeNavOperation,

    #[schemars(
        description = "Absolute path to the file. Required for goto_definition and goto_references."
    )]
    #[serde(default)]
    pub path: Option<String>,

    #[schemars(
        description = "1-based line number. Required for goto_definition and goto_references."
    )]
    #[serde(default)]
    pub line: Option<u32>,

    #[schemars(
        description = "1-based column number. Required for goto_definition and goto_references."
    )]
    #[serde(default)]
    pub column: Option<u32>,

    #[schemars(description = "Symbol name. Required for find_definitions and find_references.")]
    #[serde(default)]
    pub symbol: Option<String>,

    #[schemars(
        description = "Optional file path that disambiguates a symbol with the same name in several modules."
    )]
    #[serde(default)]
    pub context_file: Option<String>,

    #[schemars(
        description = "For goto_references, include the definition site in the result. Defaults to false."
    )]
    #[serde(default)]
    pub include_definition: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeNavOutput {
    pub text: String,
    pub location_count: usize,
}

impl From<CodeNavOutput> for ToolOutput {
    fn from(output: CodeNavOutput) -> Self {
        ToolOutput::Text(output.text.into())
    }
}

impl xai_tool_runtime::ToolOutput for CodeNavOutput {}

fn format_locations(locations: &[CodeNavLocation]) -> String {
    let mut body = String::new();
    for location in locations {
        match location.symbol.as_deref() {
            Some(symbol) if !symbol.is_empty() => {
                body.push_str(&format!("{}:{}: {symbol}\n", location.path, location.line));
            }
            _ => body.push_str(&format!("{}:{}\n", location.path, location.line)),
        }
    }
    truncate_str_with_marker(&body, MAX_OUTPUT_BYTES).into_owned()
}

fn render(locations: &[CodeNavLocation]) -> String {
    if locations.is_empty() {
        return "No locations found.".to_string();
    }
    format!(
        "{} location(s):\n{}",
        locations.len(),
        format_locations(locations)
    )
}

#[derive(Debug, Default)]
pub struct CodeNavTool;

impl crate::types::tool_metadata::ToolMetadata for CodeNavTool {
    fn kind(&self) -> ToolKind {
        ToolKind::CodeNav
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn lock_path_param(&self) -> Option<&'static str> {
        Some("path")
    }

    fn description_template(&self) -> &str {
        r#"Find a symbol's definition or references in the indexed codebase.

- ${{ params.code_nav.operation }} picks the query. `goto_definition` and `goto_references` take a file position: ${{ params.code_nav.path }} with 1-based ${{ params.code_nav.line }} and ${{ params.code_nav.column }}. `find_definitions` and `find_references` take a name: ${{ params.code_nav.symbol }}.
- Indexed languages: Rust, TypeScript, JavaScript, Python, Go. Other files return nothing.
- For a syntactic shape with varying names, use ${{ tools.by_kind.ast_grep }}. For a raw string or regex, use ${{ tools.by_kind.search }}.
- Output is `path:line[: symbol]`, one line per location, capped."#
    }
}

impl xai_tool_runtime::Tool for CodeNavTool {
    type Args = CodeNavInput;
    type Output = CodeNavOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("code_nav").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "code_nav",
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

    #[tracing::instrument(
        name = "tool.code_nav",
        skip_all,
        fields(operation = %input.operation_str(), location_count = tracing::field::Empty)
    )]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: CodeNavInput,
    ) -> Result<CodeNavOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;

        let resources: SharedResources = shared_resources(&ctx)?;
        let backend = {
            let resources = resources.lock().await;
            resources.get::<CodeNavBackendHandle>().cloned()
        };
        let Some(CodeNavBackendHandle(backend)) = backend else {
            return Err(xai_tool_runtime::ToolError::custom(
                "code_nav_unavailable",
                "code navigation is unavailable in this session",
            ));
        };

        let locations = match input.operation {
            CodeNavOperation::GotoDefinition | CodeNavOperation::GotoReferences => {
                let (Some(path), Some(line), Some(column)) =
                    (input.path.as_deref(), input.line, input.column)
                else {
                    return Err(xai_tool_runtime::ToolError::custom(
                        "missing_position",
                        "goto_definition and goto_references need path, line, and column; use find_definitions or find_references for a symbol name",
                    ));
                };
                let result = if matches!(input.operation, CodeNavOperation::GotoDefinition) {
                    backend
                        .goto_definition(path.to_string(), line, column)
                        .await
                } else {
                    backend
                        .goto_references(
                            path.to_string(),
                            line,
                            column,
                            input.include_definition.unwrap_or(false),
                        )
                        .await
                };
                result.map_err(backend_error)?
            }
            CodeNavOperation::FindDefinitions | CodeNavOperation::FindReferences => {
                let Some(symbol) = input.symbol.as_deref().filter(|s| !s.is_empty()) else {
                    return Err(xai_tool_runtime::ToolError::custom(
                        "missing_symbol",
                        "find_definitions and find_references need a symbol name; use goto_definition or goto_references with path, line, and column",
                    ));
                };
                let context_file = input.context_file.clone();
                let result = if matches!(input.operation, CodeNavOperation::FindDefinitions) {
                    backend
                        .find_definitions(symbol.to_string(), context_file)
                        .await
                } else {
                    backend
                        .find_references(symbol.to_string(), context_file)
                        .await
                };
                result.map_err(backend_error)?
            }
        };

        tracing::Span::current().record("location_count", locations.len() as u64);
        Ok(CodeNavOutput {
            text: render(&locations),
            location_count: locations.len(),
        })
    }
}

impl CodeNavInput {
    fn operation_str(&self) -> &'static str {
        match self.operation {
            CodeNavOperation::GotoDefinition => "goto_definition",
            CodeNavOperation::GotoReferences => "goto_references",
            CodeNavOperation::FindDefinitions => "find_definitions",
            CodeNavOperation::FindReferences => "find_references",
        }
    }
}

fn backend_error(message: String) -> xai_tool_runtime::ToolError {
    xai_tool_runtime::ToolError::custom("code_nav_failed", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_tool_runtime::Tool as _;

    /// Records the call it received and returns canned locations.
    struct FakeBackend;

    #[async_trait::async_trait]
    impl CodeNavBackend for FakeBackend {
        async fn goto_definition(
            &self,
            file: String,
            line: u32,
            column: u32,
        ) -> Result<Vec<CodeNavLocation>, String> {
            assert_eq!(file, "/repo/src/lib.rs");
            assert_eq!((line, column), (12, 5));
            Ok(vec![CodeNavLocation {
                path: "src/lib.rs".to_string(),
                line: 20,
                symbol: Some("handle".to_string()),
            }])
        }

        async fn goto_references(
            &self,
            file: String,
            line: u32,
            column: u32,
            include_definition: bool,
        ) -> Result<Vec<CodeNavLocation>, String> {
            assert_eq!(file, "/repo/src/lib.rs");
            assert_eq!((line, column), (12, 5));
            assert!(include_definition);
            Ok(vec![
                CodeNavLocation {
                    path: "src/lib.rs".to_string(),
                    line: 20,
                    symbol: Some("handle".to_string()),
                },
                CodeNavLocation {
                    path: "src/main.rs".to_string(),
                    line: 4,
                    symbol: Some("handle".to_string()),
                },
            ])
        }

        async fn find_definitions(
            &self,
            symbol: String,
            context_file: Option<String>,
        ) -> Result<Vec<CodeNavLocation>, String> {
            assert_eq!(symbol, "handle");
            assert_eq!(context_file.as_deref(), Some("src/lib.rs"));
            Ok(vec![CodeNavLocation {
                path: "src/lib.rs".to_string(),
                line: 20,
                symbol: Some("handle".to_string()),
            }])
        }

        async fn find_references(
            &self,
            symbol: String,
            context_file: Option<String>,
        ) -> Result<Vec<CodeNavLocation>, String> {
            assert_eq!(symbol, "handle");
            assert!(context_file.is_none());
            Ok(vec![CodeNavLocation {
                path: "src/main.rs".to_string(),
                line: 4,
                symbol: Some("handle".to_string()),
            }])
        }
    }

    async fn run_with(backend: Arc<dyn CodeNavBackend>, input: CodeNavInput) -> CodeNavOutput {
        let mut ctx = xai_tool_runtime::ToolCallContext::default();
        let mut resources = crate::types::resources::Resources::new();
        resources.insert(CodeNavBackendHandle(backend));
        ctx.insert(resources.into_shared());
        CodeNavTool.run(ctx, input).await.expect("run")
    }

    fn position_input(operation: CodeNavOperation) -> CodeNavInput {
        CodeNavInput {
            operation,
            path: Some("/repo/src/lib.rs".to_string()),
            line: Some(12),
            column: Some(5),
            symbol: None,
            context_file: None,
            include_definition: Some(true),
        }
    }

    #[tokio::test]
    async fn goto_definition_returns_fake_location() {
        let out = run_with(
            Arc::new(FakeBackend),
            position_input(CodeNavOperation::GotoDefinition),
        )
        .await;
        assert_eq!(out.location_count, 1);
        assert!(out.text.contains("src/lib.rs:20"), "{}", out.text);
    }

    #[tokio::test]
    async fn goto_references_forwards_include_definition() {
        let out = run_with(
            Arc::new(FakeBackend),
            position_input(CodeNavOperation::GotoReferences),
        )
        .await;
        assert_eq!(out.location_count, 2);
        assert!(out.text.contains("src/main.rs:4"), "{}", out.text);
    }

    #[tokio::test]
    async fn find_definitions_forwards_symbol_and_context() {
        let out = run_with(
            Arc::new(FakeBackend),
            CodeNavInput {
                operation: CodeNavOperation::FindDefinitions,
                path: None,
                line: None,
                column: None,
                symbol: Some("handle".to_string()),
                context_file: Some("src/lib.rs".to_string()),
                include_definition: None,
            },
        )
        .await;
        assert_eq!(out.location_count, 1);
    }

    #[tokio::test]
    async fn find_references_without_context() {
        let out = run_with(
            Arc::new(FakeBackend),
            CodeNavInput {
                operation: CodeNavOperation::FindReferences,
                path: None,
                line: None,
                column: None,
                symbol: Some("handle".to_string()),
                context_file: None,
                include_definition: None,
            },
        )
        .await;
        assert_eq!(out.location_count, 1);
        assert!(out.text.contains("src/main.rs:4"), "{}", out.text);
    }

    #[tokio::test]
    async fn missing_backend_reports_unavailable() {
        let mut ctx = xai_tool_runtime::ToolCallContext::default();
        ctx.insert(crate::types::resources::Resources::new().into_shared());
        let error = CodeNavTool
            .run(ctx, position_input(CodeNavOperation::GotoDefinition))
            .await
            .expect_err("missing backend");
        assert!(error.to_string().contains("unavailable"), "{error}");
    }

    #[tokio::test]
    async fn missing_position_is_rejected() {
        let mut ctx = xai_tool_runtime::ToolCallContext::default();
        let mut resources = crate::types::resources::Resources::new();
        resources.insert(CodeNavBackendHandle(Arc::new(FakeBackend)));
        ctx.insert(resources.into_shared());
        let error = CodeNavTool
            .run(
                ctx,
                CodeNavInput {
                    operation: CodeNavOperation::GotoDefinition,
                    path: None,
                    line: None,
                    column: None,
                    symbol: None,
                    context_file: None,
                    include_definition: None,
                },
            )
            .await
            .expect_err("missing position");
        assert!(error.to_string().contains("path"), "{error}");
    }

    #[test]
    fn description_names_the_symbol_job_and_points_shapes_away() {
        use crate::types::template_renderer::TemplateRenderer;
        use crate::types::tool::ToolKind;
        use crate::types::tool_metadata::ToolMetadata;
        use std::collections::HashMap;

        let tools = HashMap::from([
            (ToolKind::Search, "grep".to_string()),
            (ToolKind::AstGrep, "ast_grep".to_string()),
            (ToolKind::CodeNav, "code_nav".to_string()),
        ]);
        let params = HashMap::from([(
            ToolKind::CodeNav,
            HashMap::from([
                ("symbol".to_string(), "symbol".to_string()),
                ("path".to_string(), "path".to_string()),
                ("line".to_string(), "line".to_string()),
                ("column".to_string(), "column".to_string()),
                ("operation".to_string(), "operation".to_string()),
            ]),
        )]);
        let rendered = TemplateRenderer::new(tools, params)
            .render(CodeNavTool.description_template())
            .expect("description renders");

        assert!(rendered.contains("definition or references"), "{rendered}");
        assert!(
            rendered.contains("`goto_definition` and `goto_references` take a file position"),
            "{rendered}"
        );
        assert!(
            rendered.contains("`find_definitions` and `find_references` take a name"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Rust, TypeScript, JavaScript, Python, Go"),
            "{rendered}"
        );
        assert!(rendered.contains("ast_grep"), "{rendered}");
        assert!(rendered.contains("grep"), "{rendered}");
    }
}
