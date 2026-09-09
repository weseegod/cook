//! `/privacy`: open the "Coding data, retention, and training" setting.

use crate::app::actions::Action;
use crate::slash::command::{AppCtx, CommandExecCtx, CommandResult, SlashCommand, slash_meta};

const CODING_DATA_SHARING_KEY: &str = "coding_data_sharing";

/// Open settings on `coding_data_sharing`. Takes no arguments.
pub struct PrivacyCommand;

impl SlashCommand for PrivacyCommand {
    slash_meta! {
        name: "privacy",
        // Reads as the row it opens: "Coding data, retention, and training".
        description: "Open coding data, retention, and training settings",
        usage: "/privacy",
    }

    /// Trailing text is ignored, not rejected: `/privacy opt-in` from muscle memory should land on the page, not error.
    fn visible(&self, _ctx: &AppCtx) -> bool {
        false
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Error("/privacy is not available in this build.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_command_is_hidden() {
        use crate::acp::model_state::ModelState;
        use crate::slash::command::AppCtx;

        let models = ModelState::default();
        let ctx = AppCtx {
            models: &models,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            saved_workflows: &[],
            workflow_runs: &[],
            screen_mode: crate::app::ScreenMode::Inline,
            current_title: None,
        };
        assert!(!PrivacyCommand.visible(&ctx));
    }

    /// Run `/privacy <args>` in `mode`.
    fn run_privacy_hidden(args: &str, mode: crate::app::ScreenMode) -> CommandResult {
        use crate::acp::model_state::ModelState;
        use crate::app::bundle::BundleState;

        let models = ModelState::default();
        let bundle = BundleState::default();
        let mut ctx = CommandExecCtx {
            models: &models,
            session_id: None,
            bundle_state: &bundle,
            screen_mode: mode,
            billing_surface_visible: true,
            usage_command_visible: true,
            pager_state: crate::settings::PagerLocalSnapshot::default(),
        };
        PrivacyCommand.run(&mut ctx, args)
    }

    fn opens_settings_row(result: &CommandResult) -> bool {
        matches!(
            result,
            CommandResult::Action(Action::OpenSettingsFocus {
                key: CODING_DATA_SHARING_KEY
            })
        )
    }

    /// Minimal suppresses the privacy banner, so `/privacy` is the only route to the page there; no mode may fall back to something else.
    #[test]
    fn privacy_refuses_in_every_screen_mode() {
        use crate::app::ScreenMode;
        for mode in [
            ScreenMode::Fullscreen,
            ScreenMode::Inline,
            ScreenMode::Minimal,
        ] {
            let result = run_privacy_hidden("", mode);
            assert!(
                matches!(result, CommandResult::Error(_)),
                "`/privacy` in {mode:?} must be refused, got {result:?}",
            );
        }
    }

    #[test]
    #[ignore = "fork hides /privacy"]
    fn privacy_opens_settings_row_in_every_screen_mode() {
        use crate::app::ScreenMode;
        for mode in [
            ScreenMode::Fullscreen,
            ScreenMode::Inline,
            ScreenMode::Minimal,
        ] {
            let result = run_privacy_hidden("", mode);
            assert!(
                opens_settings_row(&result),
                "`/privacy` in {mode:?} must open the settings row, got {result:?}",
            );
        }
    }

    /// Trailing args are still rejected now that the command is hidden.
    #[test]
    fn arguments_are_refused() {
        use crate::app::ScreenMode;
        assert!(
            !PrivacyCommand.takes_args(),
            "the dropdown must not offer an argument slot"
        );
        for args in [
            "   ", "opt-in", "opt-out", "in", "out", "share", "private", "status", "info",
            "garbage",
        ] {
            let result = run_privacy_hidden(args, ScreenMode::Inline);
            assert!(
                matches!(result, CommandResult::Error(_)),
                "`/privacy {args}` must be refused, got {result:?}",
            );
        }
    }
}
