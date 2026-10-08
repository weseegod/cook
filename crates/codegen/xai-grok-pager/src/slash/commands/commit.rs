use xai_grok_tools::implementations::grok_build::{
    COMMIT_AND_PUSH_COMMAND_NAME, COMMIT_COMMAND_NAME, commit_and_push_usage_message,
    commit_usage_message, parse_commit_args,
};

use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

/// `/commit` and `/commit-and-push` differ only in their default `push` value.
///
/// Both send the literal command text through to the shell, which runs the isolated commit turn.
/// The pager never expands them into a prompt, so the parent conversation never carries the
/// instruction.
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
        commit_result(args, false)
    }
}

impl SlashCommand for CommitAndPushCommand {
    slash_meta! {
        name: COMMIT_AND_PUSH_COMMAND_NAME,
        description: "Commit the current changes and push them",
        usage: "/commit-and-push [message hint]",
        takes_args: true,
        arg_placeholder: "[message hint]",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        commit_result(args, true)
    }
}

fn commit_result(args: &str, force_push: bool) -> CommandResult {
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
    // Literal passthrough: the shell resolves and runs the isolated commit turn.
    CommandResult::PassThrough(args.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::model_state::ModelState;
    use crate::slash::command::CommandExecCtx;

    fn passed(result: CommandResult) -> String {
        match result {
            CommandResult::PassThrough(text) => text,
            other => panic!("expected PassThrough, got {other:?}"),
        }
    }

    #[test]
    fn commit_sends_the_literal_command() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(passed(CommitCommand.run(&mut ctx, "")), "");
    }

    #[test]
    fn commit_keeps_the_hint_and_push_flag_verbatim() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(
            passed(CommitCommand.run(&mut ctx, "wire retries --push")),
            "wire retries --push"
        );
    }

    #[test]
    fn commit_and_push_sends_the_literal_command() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(passed(CommitAndPushCommand.run(&mut ctx, "ship it")), "ship it");
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
