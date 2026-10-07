//! Passive working-plan save tool.
//!
//! Skill instructions are regular `SKILL.md` files. The session writes saved plans with the
//! plan-mode allocator and keeps their markdown as written.

use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::tool::{ToolKind, ToolNamespace};

pub const SAVE_WORKING_PLAN_TOOL_ID: &str = "save_working_plan";

macro_rules! run_checks_procedure {
    () => {
        "Use the smallest set of checks that covers those outcomes. One integration check may cover related outcomes. \
Add a focused check only for an outcome still uncovered. Do not require one script to drive the whole product to its end state.\n\
\n\
Run a check when the change it covers is ready, not after every edit. If other work can continue, run it in the background and do that work. \
Do not sleep-loop or ask for that run's status again. Read the result once when it arrives, before relying on it. \
If nothing else can continue, run it in the foreground. Do not start another run of a suite that is already running. \
Rerun only the checks that failed. After the last edit, verify the acceptance criteria. \
A check already run on that unchanged tree counts for the outcomes it covers. \
Widen the run only when this project's practice requires it, or the change reaches behavior those checks miss. \
Stop when a rerun shows the same failure and the same diagnosis. A reworded error is the same failure. \
If the observation changed, continue. A list still headed `## Tests` is that same section."
    };
}

/// Shared check loop for active prompts and the `run-checks` skill. English. The host does not enforce it.
pub const RUN_CHECKS_PROCEDURE: &str = run_checks_procedure!();

/// Markdown body of a passive working plan. The session allocates the path.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct SaveWorkingPlanInput {
    /// Optional checklist markdown. The host stores this text unchanged.
    #[schemars(description = "Working checklist markdown")]
    pub body: String,
}

/// Result text when a save is applied by the tool itself. The session intercepts the call first.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct SaveWorkingPlanOutput {
    pub message: String,
}

impl xai_tool_runtime::ToolOutput for SaveWorkingPlanOutput {}

impl From<SaveWorkingPlanInput> for crate::types::tool_io::ToolInput {
    fn from(input: SaveWorkingPlanInput) -> Self {
        crate::types::tool_io::ToolInput::Dynamic(
            serde_json::to_value(&input).unwrap_or(serde_json::Value::Null),
        )
    }
}

impl From<SaveWorkingPlanOutput> for crate::types::output::ToolOutput {
    fn from(output: SaveWorkingPlanOutput) -> Self {
        crate::types::output::ToolOutput::Text(output.message.into())
    }
}

/// Advertised save tool. The session writes the file before this `run` is reached.
#[derive(Debug, Default)]
pub struct SaveWorkingPlanTool;

impl crate::types::tool_metadata::ToolMetadata for SaveWorkingPlanTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Save an optional working checklist into the session plans list. Pass the markdown as \
         body, with a ## Task checklist. Then keep implementing on this turn. \
         Edit the saved plan when the step list changes; mark a finished step `- [x]`. This does not enter \
         plan mode and does not ask for approval."
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for SaveWorkingPlanTool {
    type Args = SaveWorkingPlanInput;
    type Output = SaveWorkingPlanOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new(SAVE_WORKING_PLAN_TOOL_ID).expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            SAVE_WORKING_PLAN_TOOL_ID,
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

    async fn run(
        &self,
        _ctx: xai_tool_runtime::ToolCallContext,
        _input: SaveWorkingPlanInput,
    ) -> Result<SaveWorkingPlanOutput, xai_tool_runtime::ToolError> {
        Err(xai_tool_runtime::ToolError::custom(
            "working_plan_session",
            "save_working_plan is applied by the session on an open task",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_checks_procedure_and_plan_save_description() {
        assert!(RUN_CHECKS_PROCEDURE.contains("in the background"));
        assert!(RUN_CHECKS_PROCEDURE.contains("Do not sleep-loop"));
        assert!(RUN_CHECKS_PROCEDURE.contains("unchanged tree"));
        assert!(
            RUN_CHECKS_PROCEDURE.contains("A list still headed `## Tests` is that same section.")
        );
        assert!(
            <SaveWorkingPlanTool as crate::types::tool_metadata::ToolMetadata>::description_template(
                &SaveWorkingPlanTool
            )
            .contains("## Task checklist")
        );
    }
}
