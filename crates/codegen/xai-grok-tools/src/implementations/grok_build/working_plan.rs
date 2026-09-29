//! Passive working-plan skill and save tool for an open task with no approved plan.
//!
//! The skill body is the instruction. `save_working_plan` is advertised on TaskOpen, and the
//! session writes the episode with the plan-mode allocator. This module checks the short shape
//! and refuses every other skill name.

use std::collections::HashMap;

use crate::implementations::skills::skill::SkillInput;
use crate::implementations::skills::skill::SkillOutput;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::resources::WorkingPlanAllowed;
use crate::types::tool::{ToolKind, ToolNamespace};

pub const WORKING_PLAN_SKILL_NAME: &str = "working-plan";
pub const SAVE_WORKING_PLAN_TOOL_ID: &str = "save_working_plan";

/// Instructions the model loads before it writes a short plan.
pub const WORKING_PLAN_SKILL_BODY: &str = "\
Use this when the task needs several new files, or the file split is not already in the prompt. \
Skip it for a small edit.\n\
\n\
Write the plan below, call save_working_plan with that markdown as `body`, then keep implementing \
in the same turn. Do not call enter_plan_mode. Do not ask the user to approve. Do not stop after saving.\n\
\n\
# Plan: <short title>\n\
\n\
## Goal\n\
One sentence describing the finished work.\n\
\n\
## Files\n\
- `path` — what that file is for\n\
\n\
## Steps\n\
- [ ] `path` — the change. Done when: an observable result.\n\
The last step is how to check the work.\n\
\n\
Send the body with ## Steps; the saved episode contains only Goal and Files. \
The steps appear in the live todo list.\n\
\n\
Do not add anchors, an edit brief, decisions, or a deviations log.\n\
";

/// Short shape for a passive plan: title, Goal, Files, and Steps. Not the review contract.
pub fn working_plan_shape(body: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    let first = body.lines().next().unwrap_or("").trim();
    let title = first.strip_prefix("# Plan: ").unwrap_or("").trim();
    if title.is_empty() || first.contains('/') || first.contains('\\') {
        errors.push("H1 must be `# Plan: <title>` without a path".to_string());
    }
    let sections = section_bodies(body);
    for name in ["Goal", "Files", "Steps"] {
        if !sections.contains_key(name) {
            errors.push(format!("missing ## {name}"));
        }
    }
    let goal = content(&sections, "Goal");
    if sections.contains_key("Goal") && goal.is_empty() {
        errors.push("## Goal needs one sentence".to_string());
    }
    let files = content(&sections, "Files");
    if sections.contains_key("Files") && !files.iter().any(|line| line.contains('`')) {
        errors.push("## Files needs a backticked path".to_string());
    }
    let steps = content(&sections, "Steps");
    if sections.contains_key("Steps")
        && !steps
            .iter()
            .any(|line| line.contains("- [ ]") && line.contains("Done when:"))
    {
        errors.push("## Steps needs a `- [ ]` line with a path and Done when".to_string());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn section_bodies(body: &str) -> HashMap<&str, Vec<&str>> {
    let mut sections: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current = "";
    for line in body.lines() {
        if let Some(name) = line.strip_prefix("## ") {
            current = name.trim();
            sections.entry(current).or_default();
        } else {
            sections.entry(current).or_default().push(line);
        }
    }
    sections
}

fn content<'a>(sections: &'a HashMap<&str, Vec<&'a str>>, name: &str) -> Vec<&'a str> {
    sections
        .get(name)
        .map(|lines| {
            lines
                .iter()
                .copied()
                .filter(|line| !line.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

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
    /// Full working-plan markdown: title, Goal, Files, and Steps.
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
         body. Then keep implementing on this turn. This does not enter plan mode and does not \
         ask for approval."
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
