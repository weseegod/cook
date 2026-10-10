//! `background_task` tool — the single model-facing entry point for the
//! background-task lifecycle.
//!
//! One tool carries the three actions the model used to reach through three
//! separate tools: `output` (read output and status), `wait` (block until
//! tasks finish, `wait_all` or `wait_any`), and `kill` (terminate one task).
//! The dispatcher delegates to [`TaskOutputTool`], [`WaitTasksTool`], and
//! [`KillTaskTool`] so the execution paths and their tests stay in one place.

use crate::implementations::grok_build::kill_task::KillTaskTool;
use crate::implementations::grok_build::task_output::{TaskOutputTool, WaitTasksTool};
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::template_renderer::TemplateRenderer;
use crate::types::tool::{ToolKind, ToolNamespace};
use xai_tool_types::{
    BackgroundTaskAction, BackgroundTaskToolInput, BackgroundTaskToolNaming, KillTaskToolInput,
    WaitMode, WaitTasksToolInput,
};

#[derive(Debug, Default)]
pub struct BackgroundTaskTool;

impl crate::types::tool_metadata::ToolMetadata for BackgroundTaskTool {
    fn kind(&self) -> ToolKind {
        ToolKind::BackgroundTaskAction
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        // Canonical wording lives in the shared builder; `versioned_definition`
        // renders it context-aware from the finalized toolset. This static
        // fallback mirrors the default grok-build toolset.
        static DESC: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
            xai_tool_types::build_background_task_description(&BackgroundTaskToolNaming {
                action_param: "action",
                task_ids_param: "task_ids",
                timeout_ms_param: "timeout_ms",
                mode_param: "mode",
                bash_background_param: None,
                bash_block_param: Some("block_until_ms"),
                subagent_background_param: Some("run_in_background"),
                read_tool: Some("read_file"),
                monitor_tool: Some("monitor"),
                task_id_param: "task_id",
                is_windows: cfg!(windows),
            })
        });
        &DESC
    }

    fn versioned_definition(
        &self,
        _contract_version: Option<&str>,
        client_name: &str,
        description_override: Option<&str>,
        renderer: &TemplateRenderer,
        param_map: &std::collections::HashMap<String, String>,
        input_schema: &serde_json::Value,
        _effective_params: &serde_json::Value,
    ) -> crate::types::definition::ToolDefinition {
        let description = background_task_description(renderer, description_override);
        let remapped_schema = if param_map.is_empty() {
            input_schema.clone()
        } else {
            crate::util::remap::remap_schema_properties(input_schema, param_map)
        };
        crate::types::definition::ToolDefinition::function(
            client_name,
            Some(&description),
            remapped_schema,
        )
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        super::task_output_requires_expr()
    }
}

/// Resolve the `background_task` description from the finalized toolset. An explicit config override wins.
fn background_task_description(
    renderer: &TemplateRenderer,
    description_override: Option<&str>,
) -> String {
    if let Some(ovr) = description_override {
        return renderer.render(ovr).unwrap_or_else(|e| {
            tracing::warn!("background_task description override render failed, using raw: {e}");
            ovr.to_string()
        });
    }
    xai_tool_types::build_background_task_description(&background_task_naming(renderer))
}

/// The tool and param names the finalized toolset advertises for this description.
fn background_task_naming(renderer: &TemplateRenderer) -> BackgroundTaskToolNaming<'_> {
    BackgroundTaskToolNaming {
        action_param: renderer
            .param_for_kind(ToolKind::BackgroundTaskAction, "action")
            .unwrap_or("action"),
        task_ids_param: renderer
            .param_for_kind(ToolKind::BackgroundTaskAction, "task_ids")
            .unwrap_or("task_ids"),
        timeout_ms_param: renderer
            .param_for_kind(ToolKind::BackgroundTaskAction, "timeout_ms")
            .unwrap_or("timeout_ms"),
        mode_param: renderer
            .param_for_kind(ToolKind::BackgroundTaskAction, "mode")
            .unwrap_or("mode"),
        bash_background_param: renderer.param_for_kind(ToolKind::Execute, "is_background"),
        bash_block_param: renderer.param_for_kind(ToolKind::Execute, "block_until_ms"),
        subagent_background_param: renderer.param_for_kind(ToolKind::Task, "run_in_background"),
        read_tool: renderer.tool_for_kind(ToolKind::Read),
        monitor_tool: renderer.tool_for_kind(ToolKind::Monitor),
        task_id_param: renderer
            .param_for_kind(ToolKind::KillTaskAction, "task_id")
            .unwrap_or("task_id"),
        is_windows: cfg!(windows),
    }
}

impl xai_tool_runtime::Tool for BackgroundTaskTool {
    type Args = BackgroundTaskToolInput;
    type Output = crate::types::output::BackgroundTaskOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("background_task").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "background_task",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    #[tracing::instrument(
        name = "tool.background_task",
        skip_all,
        fields(action = ?input.action)
    )]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: BackgroundTaskToolInput,
    ) -> Result<crate::types::output::BackgroundTaskOutput, xai_tool_runtime::ToolError> {
        use crate::types::output::BackgroundTaskOutput;

        let ids = input.resolved_task_ids();
        match input.action {
            BackgroundTaskAction::Output => {
                let out = TaskOutputTool
                    .run(
                        ctx,
                        xai_tool_types::TaskOutputToolInput {
                            task_ids: ids,
                            timeout_ms: input.timeout_ms,
                        },
                    )
                    .await?;
                Ok(BackgroundTaskOutput::Output(out))
            }
            BackgroundTaskAction::Wait => {
                let out = WaitTasksTool
                    .run(
                        ctx,
                        WaitTasksToolInput {
                            task_ids: ids,
                            mode: input.mode.unwrap_or(WaitMode::WaitAll),
                            timeout_ms: input.timeout_ms,
                        },
                    )
                    .await?;
                Ok(BackgroundTaskOutput::Output(out))
            }
            BackgroundTaskAction::Kill => {
                let Some(task_id) = ids.into_iter().next() else {
                    return Err(xai_tool_runtime::ToolError::invalid_arguments(
                        "Provide a non-empty task_ids list.".to_string(),
                    ));
                };
                let out = KillTaskTool.run(ctx, KillTaskToolInput { task_id }).await?;
                Ok(BackgroundTaskOutput::Kill(out))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::implementations::grok_build::task_output::test_helpers::{
        make_snapshot, resources_with_terminal,
    };
    use crate::types::output::BackgroundTaskOutput;
    use crate::types::tool_metadata::test_ctx_with_call_id;
    use xai_tool_runtime::Tool as _;

    fn input(action: BackgroundTaskAction, task_ids: &[&str]) -> BackgroundTaskToolInput {
        BackgroundTaskToolInput {
            action,
            task_ids: task_ids.iter().map(|id| (*id).to_string()).collect(),
            timeout_ms: None,
            mode: None,
        }
    }

    #[tokio::test]
    async fn output_action_reaches_the_task_output_path() {
        let resources = resources_with_terminal(Some(make_snapshot("bg-1", true, Some(0))));
        let out = BackgroundTaskTool
            .run(
                test_ctx_with_call_id(resources.into_shared(), "call-output"),
                input(BackgroundTaskAction::Output, &["bg-1"]),
            )
            .await
            .expect("output action should succeed");
        assert!(
            matches!(out, BackgroundTaskOutput::Output(_)),
            "output must return the task-output shape, got {out:?}"
        );
    }

    #[tokio::test]
    async fn wait_action_accepts_wait_any() {
        let resources = resources_with_terminal(Some(make_snapshot("bg-1", true, Some(0))));
        let mut wait_any = input(BackgroundTaskAction::Wait, &["bg-1"]);
        wait_any.mode = Some(WaitMode::WaitAny);
        let out = BackgroundTaskTool
            .run(
                test_ctx_with_call_id(resources.into_shared(), "call-wait"),
                wait_any,
            )
            .await
            .expect("wait_any must reach the wait path");
        assert!(
            matches!(out, BackgroundTaskOutput::Output(_)),
            "wait must return the task-output shape, got {out:?}"
        );
    }

    #[tokio::test]
    async fn kill_action_with_an_unknown_id_matches_kill_task() {
        let via_background = BackgroundTaskTool
            .run(
                test_ctx_with_call_id(
                    resources_with_terminal(None).into_shared(),
                    "call-kill",
                ),
                input(BackgroundTaskAction::Kill, &["task-abc"]),
            )
            .await
            .expect("kill not-found is an outcome, not an error");
        let direct = KillTaskTool
            .run(
                test_ctx_with_call_id(
                    resources_with_terminal(None).into_shared(),
                    "call-direct",
                ),
                KillTaskToolInput {
                    task_id: "task-abc".into(),
                },
            )
            .await
            .expect("direct kill not-found is an outcome");
        let BackgroundTaskOutput::Kill(kill) = via_background else {
            panic!("kill action must return the kill shape");
        };
        assert_eq!(
            serde_json::to_value(&kill).unwrap(),
            serde_json::to_value(&direct).unwrap(),
            "background_task kill must match the kill_task outcome"
        );
    }

    #[tokio::test]
    async fn kill_action_without_ids_is_invalid_arguments() {
        let err = BackgroundTaskTool
            .run(
                test_ctx_with_call_id(
                    resources_with_terminal(None).into_shared(),
                    "call-empty",
                ),
                input(BackgroundTaskAction::Kill, &[]),
            )
            .await
            .expect_err("an empty id list is invalid");
        assert!(
            err.to_string().contains("non-empty task_ids"),
            "got {err}"
        );
    }
}
