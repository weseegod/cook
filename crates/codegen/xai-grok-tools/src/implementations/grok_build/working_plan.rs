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
pub const RUN_CHECKS_SKILL_NAME: &str = "run-checks";
pub const SAVE_WORKING_PLAN_TOOL_ID: &str = "save_working_plan";

macro_rules! run_checks_skill_body {
    () => {
        "Check the existing runner and its test command once. Then run only the checks written in the plan's `## Tests` section.\n\
\n\
When a check fails, decide whether the failure is in the product, in the test or harness, or in the environment.\n\
- Product: fix the product.\n\
- Test or harness: fix the test. Do not weaken the criterion. Do not change the expected result to match the bug, delete the case, or skip it. Fixing a broken fixture or a harness syntax error is allowed.\n\
- Environment: the check cannot run here. Record that limit and run the `## Tests` entries that can run. Do not build a stand-in that pretends to be the missing tool, such as a fake browser, a DOM stub, or a toolchain installed only to manufacture evidence.\n\
\n\
After the fix, rerun the failing check to confirm it. Then run the full `## Tests` set once. Do not run it again.\n\
If the same failure remains after two fixes of the layer you diagnosed, stop and report the observation that is still missing.\n"
    };
}

/// How to run the checks already written in `## Tests`. English. The host does not enforce it.
pub const RUN_CHECKS_SKILL_BODY: &str = run_checks_skill_body!();

/// Instructions the model loads before it writes a short plan.
///
/// The checklist stays in the saved file. Shape is this prompt; the host does not reject a body.
/// The run-checks procedure is included so the model does not load that skill a second time.
pub const WORKING_PLAN_SKILL_BODY: &str = concat!(
    "Use this when the task needs several new files, or the file split is not already in the prompt. \
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
## Tests\n\
- Criterion: <one important outcome from the task>\n\
  Command: `<a command you already know>`\n\
- Criterion: <another important outcome>\n\
  Behavior: <what must be true when you do not yet know a command>\n\
One entry per important outcome. No `- [ ]` in this section. Do not add a performance test, a screenshot, \
or an extra scenario unless that outcome requires it. Do not invent a command.\n\
\n\
## Steps\n\
- [ ] `path` — the change. Done when: an observable result.\n\
- [ ] Run ## Tests. Done when: each criterion's command or behavior holds.\n\
\n\
The saved file is exactly the body you send, including ## Tests and ## Steps. ## Steps is the last section. \
Do not add a ## Files section: the prompt and the conversation already name the files. Do not add anchors, \
an edit brief, decisions, or a deviations log.\n\
\n\
When a step is done, edit the saved plan file and change that line from `- [ ]` to `- [x]`. \
Leave the rest of the line unchanged. Do not call save_working_plan again to revise the shape.\n\
\n\
",
    run_checks_skill_body!()
);

/// Body for an open-task skill name. Unknown names are rejected.
pub(crate) fn open_task_skill_body(name: &str) -> Result<&'static str, &'static str> {
    match name {
        WORKING_PLAN_SKILL_NAME => Ok(WORKING_PLAN_SKILL_BODY),
        RUN_CHECKS_SKILL_NAME => Ok(RUN_CHECKS_SKILL_BODY),
        _ => Err("Only the working-plan and run-checks skills are available on an open task."),
    }
}

/// `skill` on TaskOpen. `working-plan` and `run-checks` resolve.
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
        "Load a skill on an open task with no approved plan. Pass skill \"working-plan\" before the \
         first code edit on a large task, or \"run-checks\" for how to run the plan's tests. Other \
         skill names are not available on an open task."
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
        let name = input.skill.as_str();
        let body = match open_task_skill_body(name) {
            Ok(body) => body,
            Err(message) => return Ok(rejected(message)),
        };
        Ok(SkillOutput {
            success: true,
            tool_result: format!("Loaded the {name} skill."),
            skill_name: name.to_string(),
            skill_message: Some(body.to_string()),
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
    /// Full working-plan markdown: title, Goal, Tests, and Steps. The host stores this text unchanged.
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
         body, including ## Tests and the ## Steps checklist. Then keep implementing on this turn. \
         Mark a finished step by editing that file from `- [ ]` to `- [x]`. This does not enter \
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
    fn open_task_skill_resolves_working_plan_and_run_checks() {
        assert_eq!(
            open_task_skill_body(WORKING_PLAN_SKILL_NAME),
            Ok(WORKING_PLAN_SKILL_BODY)
        );
        assert_eq!(
            open_task_skill_body(RUN_CHECKS_SKILL_NAME),
            Ok(RUN_CHECKS_SKILL_BODY)
        );
        assert!(open_task_skill_body("deploy").is_err());
        assert!(WORKING_PLAN_SKILL_BODY.contains(RUN_CHECKS_SKILL_BODY));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Product:"));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Test or harness:"));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Environment:"));
    }
}
