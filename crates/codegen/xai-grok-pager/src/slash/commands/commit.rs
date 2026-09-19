use agent_client_protocol as acp;
use xai_grok_tools::implementations::grok_build::{
    COMMIT_AND_PUSH_COMMAND_NAME, COMMIT_COMMAND_NAME, commit_and_push_usage_message,
    commit_instruction, commit_usage_message, parse_commit_args,
};

use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

/// `/commit` and `/commit-and-push` differ only in their default `push` value.
/// Both expand to the same instruction from `xai-grok-tools`, so the pager and the shell cannot drift.
pub struct CommitCommand;

pub struct CommitAndPushCommand;

impl SlashCommand for CommitCommand {
    slash_meta! {
        name: COMMIT_COMMAND_NAME,
        description: "Commit the current changes with a generated message",
        usage: "/commit [message hint] [--push]",
        takes_args: true,
        arg_placeholder: "[message hint] [--push]",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        commit_result(args, false, COMMIT_COMMAND_NAME)
    }
}

impl SlashCommand for CommitAndPushCommand {
    slash_meta! {
        name: COMMIT_AND_PUSH_COMMAND_NAME,
        description: "Commit the current changes and push, resolving pull conflicts",
        usage: "/commit-and-push [message hint]",
        takes_args: true,
        arg_placeholder: "[message hint]",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        commit_result(args, true, COMMIT_AND_PUSH_COMMAND_NAME)
    }
}

fn commit_result(args: &str, force_push: bool, name: &str) -> CommandResult {
    let parsed = parse_commit_args(args, force_push);
    if parsed.help {
        return CommandResult::Message(
            if parsed.push {
                commit_and_push_usage_message()
            } else {
                commit_usage_message()
            }
            .to_string(),
        );
    }
    let trimmed = args.trim();
    CommandResult::InjectSkill {
        display_text: if trimmed.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {trimmed}")
        },
        prompt_blocks: vec![acp::ContentBlock::Text(acp::TextContent::new(
            commit_instruction(parsed.hint, parsed.push),
        ))],
        display_as_skill: false,
        scheduled_task_preview: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::model_state::ModelState;
    use crate::slash::command::CommandExecCtx;

    fn injected(result: CommandResult) -> (String, String) {
        match result {
            CommandResult::InjectSkill {
                display_text,
                prompt_blocks,
                display_as_skill,
                ..
            } => {
                assert!(!display_as_skill, "the commit commands are not skills");
                let text = prompt_blocks
                    .iter()
                    .find_map(|block| match block {
                        acp::ContentBlock::Text(t) => Some(t.text.clone()),
                        _ => None,
                    })
                    .expect("a text block");
                (display_text, text)
            }
            other => panic!("expected InjectSkill, got {other:?}"),
        }
    }

    #[test]
    fn commit_commits_without_pushing() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        let (display, text) = injected(CommitCommand.run(&mut ctx, ""));
        assert_eq!(display, "/commit");
        assert!(!text.contains("## Then push"));
        assert!(text.contains("git commit -F <file>"));
    }

    #[test]
    fn commit_push_flag_switches_to_pushing() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        let (display, text) = injected(CommitCommand.run(&mut ctx, "wire retries --push"));
        assert_eq!(display, "/commit wire retries --push");
        assert!(text.contains("## Then push"));
        assert!(text.contains("wire retries"));
    }

    #[test]
    fn commit_and_push_always_pushes() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        let (display, text) = injected(CommitAndPushCommand.run(&mut ctx, "ship it"));
        assert_eq!(display, "/commit-and-push ship it");
        assert!(text.contains("## Then push"));
        assert!(text.contains("ship it"));
    }

    #[test]
    fn commit_help_returns_usage() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        match CommitCommand.run(&mut ctx, "--help") {
            CommandResult::Message(message) => assert!(message.contains("Usage: /commit ")),
            other => panic!("expected Message, got {other:?}"),
        }
        match CommitAndPushCommand.run(&mut ctx, "--help") {
            CommandResult::Message(message) => {
                assert!(message.contains("Usage: /commit-and-push "))
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn commit_commands_need_no_extra_tools() {
        assert!(CommitCommand.required_tools().is_empty());
        assert!(CommitAndPushCommand.required_tools().is_empty());
    }
}
