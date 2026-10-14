use xai_grok_tools::implementations::grok_build::{
    COMMIT_AND_PUSH_COMMAND_NAME, COMMIT_COMMAND_NAME, commit_and_push_usage_message,
    commit_usage_message, parse_commit_args,
};

use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

/// `/commit` and `/commit-and-push` differ only in their default `push` value.
///
/// Both enqueue the literal command text (command name plus the user's arguments) so the shell
/// resolves it as an isolated commit turn. The pager never expands them into a prompt, so the
/// parent conversation never carries the instruction and the command text stays visible in the
/// transcript as the turn it starts.
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
        commit_result(COMMIT_COMMAND_NAME, args, false)
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
        commit_result(COMMIT_AND_PUSH_COMMAND_NAME, args, true)
    }
}

/// Build the command row the shell resolves. The name is preserved (`/commit` stays `/commit`,
/// even with a trailing `--push`) and the user's arguments ride after it verbatim, so the shell
/// re-parses the same invocation the user typed.
fn commit_result(command_name: &str, args: &str, force_push: bool) -> CommandResult {
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
    let args = args.trim();
    let text = if args.is_empty() {
        format!("/{command_name}")
    } else {
        format!("/{command_name} {args}")
    };
    // Enqueued as a command row: the drain sends it to the shell, which runs the isolated turn.
    CommandResult::QueueCommand(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::model_state::ModelState;
    use crate::slash::command::CommandExecCtx;

    fn queued(result: CommandResult) -> String {
        match result {
            CommandResult::QueueCommand(text) => text,
            other => panic!("expected QueueCommand, got {other:?}"),
        }
    }

    #[test]
    fn commit_sends_the_literal_command() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(queued(CommitCommand.run(&mut ctx, "")), "/commit");
    }

    #[test]
    fn commit_keeps_the_hint_and_push_flag_verbatim() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(
            queued(CommitCommand.run(&mut ctx, "wire retries --push")),
            "/commit wire retries --push"
        );
    }

    #[test]
    fn commit_and_push_sends_the_literal_command() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(
            queued(CommitAndPushCommand.run(&mut ctx, "ship it")),
            "/commit-and-push ship it"
        );
    }

    #[test]
    fn commit_and_push_without_a_hint_keeps_its_name() {
        let models = ModelState::default();
        let mut ctx = super::super::tests::make_ctx(&models);
        assert_eq!(queued(CommitAndPushCommand.run(&mut ctx, "  ")), "/commit-and-push");
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
