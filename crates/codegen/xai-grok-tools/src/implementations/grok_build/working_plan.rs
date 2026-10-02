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

macro_rules! run_checks_classification {
    () => {
        "\n\nWhen a check fails, decide whether the failure is in the product, in the test or harness, or in the environment.\n\
- Product: fix the product.\n\
- Test or harness: fix the test or the harness. Do not change the expected result to match the bug, delete the case, or skip it.\n\
- Environment: the check cannot run here. Say why and verify what can. Do not build a stand-in for a missing tool. If no check covers a required outcome, observe it or add one check that drives the shipped behavior.\n"
    };
}

/// Shared check loop for active prompts and the `run-checks` skill. English. The host does not enforce it.
pub const RUN_CHECKS_PROCEDURE: &str = run_checks_procedure!();

/// The procedure, then the failure classes. English. The host does not enforce it.
pub const RUN_CHECKS_SKILL_BODY: &str =
    concat!(run_checks_procedure!(), run_checks_classification!());

/// Instructions the model loads before it writes a working plan.
///
/// The host stores the markdown as written; the saved checklist can evolve while work proceeds.
pub const WORKING_PLAN_SKILL_BODY: &str = r#"Use this when the task has several dependent steps, touches multiple things, or has an unclear cause or scope. For a small, clear task, a one- or two-line plan in your reply is enough; skip the tool.

First, build a thorough understanding of the user's request: what they asked for, what result they want, and any constraints. If something is ambiguous, state your assumption in the plan and proceed. Then explore enough to understand the shape of the work. Only then write the plan, call save_working_plan once with the markdown as `body`, and keep working in the same turn. Do not call enter_plan_mode, ask for approval, stop after saving, or use todo_write for these steps.

# Plan: <short title>

## Goals
- <An outcome the user wants, in their terms. One bullet per distinct outcome.>

## Acceptance criteria
- <How you will know a goal is met: an observable result, an existing command, or a check you can actually perform.>

## Task checklist
- [ ] <The step, naming the file, document, or area involved if relevant>. Done when: <observable result>.
- [ ] Verify the acceptance criteria. Done when: <what you run or check, and what passing looks like>

Keep the plan proportional to the task, and use only commands and checks that exist. Keep ## Task checklist last.

The plan is a working document, not a contract. Edit the saved file whenever you learn something: add, remove, split, or reorder steps, or fix the goals and criteria. Do not save a new plan. Mark a step `- [x]` when it is done. Before stopping, make sure every step is checked and every criterion verified; name anything still open and continue unless blocked.

If a check fails, fix the real cause. Never change an expected result to fit a bug, or delete or skip a case. If a check cannot run here, say why and verify what you can."#;

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
        "Load a skill on an open task with no approved plan. Use this when the task has several dependent steps, \
         touches multiple things, or has an unclear cause or scope. For a small, a one- or two-line plan in your \
         reply is enough; skip the tool."
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
    /// Full working-plan markdown: title, Goals, Acceptance criteria, and Task checklist. The host stores this text unchanged.
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
         body, including ## Acceptance criteria and the ## Task checklist section. Then keep implementing on this turn. \
         Edit the saved plan as work changes; mark a finished step `- [x]`. This does not enter \
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
        assert!(RUN_CHECKS_SKILL_BODY.starts_with(RUN_CHECKS_PROCEDURE));
        assert!(RUN_CHECKS_PROCEDURE.contains("in the background"));
        assert!(RUN_CHECKS_PROCEDURE.contains("Do not sleep-loop"));
        assert!(RUN_CHECKS_PROCEDURE.contains("unchanged tree"));
        assert!(
            RUN_CHECKS_PROCEDURE.contains("A list still headed `## Tests` is that same section.")
        );
        assert!(WORKING_PLAN_SKILL_BODY.contains("several dependent steps"));
        assert!(WORKING_PLAN_SKILL_BODY.contains("state your assumption in the plan"));
        assert!(WORKING_PLAN_SKILL_BODY.contains("The plan is a working document, not a contract."));
        assert!(WORKING_PLAN_SKILL_BODY.contains("## Task checklist"));
        assert!(WORKING_PLAN_SKILL_BODY.contains("## Goals"));
        assert!(WORKING_PLAN_SKILL_BODY.contains("Do not save a new plan."));
        assert!(
            <SaveWorkingPlanTool as crate::types::tool_metadata::ToolMetadata>::description_template(
                &SaveWorkingPlanTool
            )
            .contains("## Task checklist")
        );
        assert!(WORKING_PLAN_SKILL_BODY
            .contains("If a check cannot run here, say why and verify what you can."));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Product:"));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Test or harness:"));
        assert!(RUN_CHECKS_SKILL_BODY.contains("Environment:"));
        assert!(RUN_CHECKS_SKILL_BODY.contains("stand-in for a missing tool"));
    }
}
