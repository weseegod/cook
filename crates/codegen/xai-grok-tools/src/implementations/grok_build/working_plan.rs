//! Passive working-plan skill and save tool for an open task with no approved plan.
//!
//! The skill body is the instruction. `save_working_plan` is advertised on TaskOpen, and the
//! session writes the episode with the plan-mode allocator. The host saves the markdown as written.

use crate::implementations::skills::skill::SkillInput;
use crate::implementations::skills::skill::SkillOutput;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::resources::WorkingPlanAllowed;
use crate::types::tool::{ToolKind, ToolNamespace};

pub const WORKING_PLAN_SKILL_NAME: &str = "working-plan";
pub const SAVE_WORKING_PLAN_TOOL_ID: &str = "save_working_plan";

/// Instructions the model loads before it writes a short plan.
///
/// The checklist stays in the saved file. Shape is this prompt; the host does not reject a body.
pub const WORKING_PLAN_SKILL_BODY: &str = "\
Use this when the task needs several new files, or the file split is not already in the prompt. \
Skip it for a small edit.\n\
\n\
Write the plan below, call save_working_plan once with that markdown as `body`, then keep implementing \
in the same turn. Do not call enter_plan_mode. Do not ask the user to approve. Do not stop after saving. \
Do not call todo_write for these steps.\n\
\n\
# Plan: <short title>\n\
\n\
## Goal\n\
One sentence describing the finished work.\n\
\n\
## Steps\n\
- [ ] `path` — the change. Done when: an observable result.\n\
The last step is how you will check the work.\n\
\n\
The saved file is exactly the body you send, including ## Steps. Do not add a ## Files section: \
the prompt and the conversation already name the files. Do not add anchors, an edit brief, decisions, \
or a deviations log.\n\
\n\
When a step is done, edit the saved plan file and change that line from `- [ ]` to `- [x]`. \
Leave the rest of the line unchanged. Do not call save_working_plan again to revise the shape.\n\
";

/// `skill` on TaskOpen. Only `working-plan` resolves.
#[derive(Debug, Default)]
pub struct WorkingPlanSkillTool;

impl crate::types::tool_metadata::ToolMetadata for WorkingPlanSkillTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Skill
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Load the working-plan skill before the first code edit on a large task. Pass skill \
         \"working-plan\". Other skill names are not available on an open task."
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for WorkingPlanSkillTool {
    type Args = SkillInput;
    type Output = SkillOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("skill").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "skill",
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

    #[tracing::instrument(name = "tool.working_plan_skill", skip_all, fields(skill = %input.skill))]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: SkillInput,
    ) -> Result<SkillOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;
        let allowed = {
            let res = resources.lock().await;
            res.get::<WorkingPlanAllowed>().is_some_and(|flag| flag.0)
        };
        if !allowed {
            return Ok(rejected(
                "The working-plan skill is only available on an open task with no approved plan.",
            ));
        }
        if input.skill != WORKING_PLAN_SKILL_NAME {
            return Ok(rejected(
                "Only the working-plan skill is available on an open task.",
            ));
        }
        Ok(SkillOutput {
            success: true,
            tool_result: "Loaded the working-plan skill.".to_string(),
            skill_name: WORKING_PLAN_SKILL_NAME.to_string(),
            skill_message: Some(WORKING_PLAN_SKILL_BODY.to_string()),
            error: None,
        })
    }
}

fn rejected(message: &str) -> SkillOutput {
    SkillOutput {
        success: false,
        tool_result: message.to_string(),
        skill_name: WORKING_PLAN_SKILL_NAME.to_string(),
        skill_message: None,
        error: Some(message.to_string()),
    }
}

/// Markdown body of a passive working plan. The session allocates the path.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct SaveWorkingPlanInput {
    /// Full working-plan markdown: title, Goal, and Steps. The host stores this text unchanged.
    #[schemars(description = "Full working-plan markdown")]
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
        "Save a passive working plan into the session plans list. Pass the full markdown as \
         body, including the ## Steps checklist. Then keep implementing on this turn. Mark a \
         finished step by editing that file from `- [ ]` to `- [x]`. This does not enter plan \
         mode and does not ask for approval."
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
