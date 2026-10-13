//! `ast_grep` tool — structural search over the workspace with ast-grep.
//!
//! Matches a code-shaped pattern against the syntax tree instead of raw text,
//! so a comment or a string that only spells the same words does not match.
//! Search only; rewriting file contents stays with `search_replace`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::types::output::ToolOutput;
use crate::types::tool::{ToolKind, ToolNamespace};
use crate::util::truncate::truncate_str_with_marker;

pub mod sg;

use sg::sg_path;

/// Wall-clock ceiling for one `ast-grep` search.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Byte cap on the rendered match list.
const MAX_OUTPUT_BYTES: usize = 40_000;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AstGrepInput {
    #[schemars(
        description = "Code-shaped match pattern (ast-grep syntax), e.g. `def $F(self, $$$): $$$` for a Python method, or `fn $NAME($$$) { $$$ }` for a Rust function. Meta-variables start with `$`; `$$$` matches any number of nodes."
    )]
    pub pattern: String,

    #[schemars(
        description = "Language name or alias (e.g. `python`, `rust`, `ts`). Omit to infer from each file's extension."
    )]
    #[serde(default)]
    pub lang: Option<String>,

    #[schemars(description = "File or directory to search in. Defaults to the workspace path.")]
    #[serde(default)]
    pub path: Option<String>,

    #[schemars(
        description = "Glob to include or exclude paths with, using .gitignore rules. Repeat to add more; prefix a glob with `!` to exclude. Omit to respect .gitignore."
    )]
    #[serde(default)]
    pub glob: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstGrepOutput {
    pub text: String,
    pub match_count: usize,
}

impl From<AstGrepOutput> for ToolOutput {
    fn from(output: AstGrepOutput) -> Self {
        ToolOutput::Text(output.text.into())
    }
}

impl xai_tool_runtime::ToolOutput for AstGrepOutput {}

/// One ast-grep match, reduced to what the model needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AstMatch {
    file: String,
    /// 1-based line of the match start.
    line: usize,
    /// First line of the matched text, trimmed.
    text: String,
}

/// Parse the JSON array ast-grep prints with `--json`.
fn parse_matches(json: &str) -> Result<Vec<AstMatch>, String> {
    let records: Vec<serde_json::Value> =
        serde_json::from_str(json.trim()).map_err(|e| format!("invalid ast-grep JSON: {e}"))?;

    let mut matches = Vec::with_capacity(records.len());
    for record in records {
        let file = record
            .get("file")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let start_line = record
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(|l| l.as_u64())
            .unwrap_or(0);
        let matched = record
            .get("lines")
            .and_then(|v| v.as_str())
            .or_else(|| record.get("text").and_then(|v| v.as_str()))
            .unwrap_or_default();
        let first_line = matched.lines().next().unwrap_or("").trim().to_string();
        matches.push(AstMatch {
            file,
            line: start_line as usize + 1,
            text: first_line,
        });
    }
    Ok(matches)
}

/// Render matches as `path:line: text`, one per line.
fn format_matches(matches: &[AstMatch]) -> String {
    let mut out = String::new();
    for m in matches {
        out.push_str(&format!("{}:{}:{}\n", m.file, m.line, m.text));
    }
    out
}

fn render(matches: &[AstMatch]) -> String {
    if matches.is_empty() {
        return "No structural matches.".to_string();
    }
    let body = format_matches(matches);
    let body = truncate_str_with_marker(&body, MAX_OUTPUT_BYTES);
    format!("{} match(es):\n{}", matches.len(), body)
}

#[derive(Debug, Default)]
pub struct AstGrepTool;

impl crate::types::tool_metadata::ToolMetadata for AstGrepTool {
    fn kind(&self) -> ToolKind {
        ToolKind::AstGrep
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn lock_path_param(&self) -> Option<&'static str> {
        Some("path")
    }

    fn description_template(&self) -> &str {
        r#"Search for a code shape in the workspace syntax tree (ast-grep).

- The ${{ params.ast_grep.pattern }} is code, not a regex: `def $F(self, $$$): $$$` (Python), `fn $NAME($$$) { $$$ }` (Rust). `$NAME` is one node, `$$$` any number of nodes.
- Use this when names differ between call sites but the shape is the same. A comment or a literal string with the same words is not a match.
- For a symbol's definition or call sites, use ${{ tools.by_kind.code_nav }}. For a raw string or regex, use ${{ tools.by_kind.search }}.
- Output is `path:line: matched text`, one line per match, capped."#
    }
}

impl xai_tool_runtime::Tool for AstGrepTool {
    type Args = AstGrepInput;
    type Output = AstGrepOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("ast_grep").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "ast_grep",
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
        name = "tool.ast_grep",
        skip_all,
        fields(match_count = tracing::field::Empty)
    )]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: AstGrepInput,
    ) -> Result<AstGrepOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::{resolve_cwd, shared_resources};

        if input.pattern.trim().is_empty() {
            return Err(xai_tool_runtime::ToolError::custom(
                "empty_pattern",
                "ast_grep needs a non-empty pattern",
            ));
        }

        let resources = shared_resources(&ctx)?;
        let cwd = resolve_cwd(&ctx, &resources).await?;
        let root = resolve_root(&cwd, input.path.as_deref());

        let program = sg_path()?;
        let mut cmd = tokio::process::Command::new(program);
        cmd.arg("run")
            .arg("--pattern")
            .arg(&input.pattern)
            .arg("--json")
            .arg("--color=never");
        if let Some(lang) = input.lang.as_deref().filter(|l| !l.is_empty()) {
            cmd.arg("--lang").arg(lang);
        }
        for glob in input.glob.as_deref().unwrap_or_default() {
            if !glob.trim().is_empty() {
                cmd.arg("--globs").arg(glob);
            }
        }
        cmd.arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::util::detach_search_command(&mut cmd);

        let output = match tokio::time::timeout(SEARCH_TIMEOUT, cmd.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                return Err(xai_tool_runtime::ToolError::new(
                    xai_tool_runtime::ToolErrorKind::Execution,
                    format!("failed to run ast-grep: {error}"),
                ));
            }
            Err(_) => {
                return Err(xai_tool_runtime::ToolError::custom(
                    "ast_grep_timeout",
                    "ast-grep did not finish within 60s",
                ));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let matches = parse_matches(&stdout).map_err(|msg| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            xai_tool_runtime::ToolError::custom(
                "ast_grep_invalid_output",
                format!("{msg}; stderr: {}", stderr.trim()),
            )
        })?;
        tracing::Span::current().record("match_count", matches.len() as u64);

        Ok(AstGrepOutput {
            text: render(&matches),
            match_count: matches.len(),
        })
    }
}

/// Resolve the search root: the model's `path` joined onto the workspace, or
/// the workspace root when no path was given.
fn resolve_root(cwd: &Path, path: Option<&str>) -> PathBuf {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => {
            let candidate = Path::new(path);
            if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                cwd.join(candidate)
            }
        }
        None => cwd.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"[
        {
            "text": "def handle(self, request):\n    return request",
            "range": {
                "byteOffset": { "start": 0, "end": 45 },
                "start": { "line": 0, "column": 0 },
                "end": { "line": 1, "column": 18 }
            },
            "file": "demo/a.py",
            "lines": "def handle(self, request):\n    return request",
            "language": "Python",
            "metaVariables": { "single": { "F": { "text": "handle" } }, "multi": {} }
        }
    ]"#;

    #[test]
    fn parses_function_match_with_one_based_line() {
        let matches = parse_matches(FIXTURE).expect("fixture parses");
        assert_eq!(
            matches,
            vec![AstMatch {
                file: "demo/a.py".to_string(),
                line: 1,
                text: "def handle(self, request):".to_string(),
            }]
        );
    }

    #[test]
    fn comment_only_line_yields_no_match() {
        // ast-grep reports no record for a comment that repeats the pattern's
        // words, so an empty array is the observable "no match" shape.
        assert!(parse_matches("[]").expect("empty array parses").is_empty());
        let rendered = render(&[]);
        assert!(rendered.contains("No structural matches"));
    }

    #[test]
    fn renders_path_line_and_text() {
        let matches = parse_matches(FIXTURE).expect("fixture parses");
        assert_eq!(
            format_matches(&matches),
            "demo/a.py:1:def handle(self, request):\n"
        );
    }

    #[test]
    fn resolves_relative_and_absolute_roots() {
        let cwd = Path::new("/work/repo");
        assert_eq!(resolve_root(cwd, None), PathBuf::from("/work/repo"));
        assert_eq!(
            resolve_root(cwd, Some("src")),
            PathBuf::from("/work/repo/src")
        );
        assert_eq!(resolve_root(cwd, Some("/tmp/x")), PathBuf::from("/tmp/x"));
    }

    #[test]
    fn description_names_the_syntactic_job_and_points_definitions_away() {
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
            ToolKind::AstGrep,
            HashMap::from([("pattern".to_string(), "pattern".to_string())]),
        )]);
        let rendered = TemplateRenderer::new(tools, params)
            .render(AstGrepTool.description_template())
            .expect("description renders");

        assert!(rendered.contains("syntax tree"), "{rendered}");
        assert!(rendered.contains("not a regex"), "{rendered}");
        assert!(rendered.contains("code_nav"), "{rendered}");
        assert!(rendered.contains("grep"), "{rendered}");
    }

    /// Release builds (and `GROK_TOOLS_BUNDLE_SG_PATH` override builds) embed
    /// the ast-grep binary; resolving it must self-extract a runnable CLI.
    #[cfg(bundle_sg)]
    #[test]
    fn bundled_sg_self_extracts_and_runs() {
        let path = super::sg::sg_path().expect("bundled ast-grep resolves");
        let out = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .unwrap_or_else(|e| panic!("running {} failed: {e}", path.display()));
        assert!(out.status.success(), "{} --version failed", path.display());
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("ast-grep"),
            "unexpected version output: {stdout}"
        );
    }

    /// End-to-end against the real CLI: a function node matches, while a comment
    /// holding the same words is not a syntax node and must stay unmatched.
    #[cfg(bundle_sg)]
    #[tokio::test]
    async fn bundled_sg_matches_the_function_node_and_skips_the_comment() {
        use crate::types::resources::{Cwd, Resources};
        use crate::types::tool_metadata::test_ctx;

        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("demo.rs"),
            "// fn handle(self, request) { hidden }\nfn handle(self, request) { real }\n",
        )
        .unwrap();
        let mut resources = Resources::new();
        resources.insert(Cwd(tmp.path().to_path_buf()));

        let output = xai_tool_runtime::Tool::run(
            &AstGrepTool,
            test_ctx(resources.into_shared()),
            AstGrepInput {
                pattern: "fn handle($$$) { $$$ }".to_string(),
                lang: Some("rust".to_string()),
                path: None,
                glob: None,
            },
        )
        .await
        .expect("ast-grep run");

        assert_eq!(output.match_count, 1, "{}", output.text);
        assert!(output.text.contains("demo.rs:2:"), "{}", output.text);
    }
}
