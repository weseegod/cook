//! Per-episode plan files: the agent's `enter_plan_mode` must open the new episode's file before
//! the tool seeds it, and must leave an already-active episode alone.
//!
//! The rotation happens in `prepare_tool_call` (before dispatch) because `EnterPlanModeTool`
//! resolves the `PlanFilePath` resource and creates the file inside its own `run`. Rotating in the
//! `PlanModeEntered` notification handler would be too late: the tool would have seeded the
//! previous episode's plan and the new path would stay empty.

use super::support::*;
use super::*;

use crate::session::slash_commands::GoalPlanSource;
use xai_grok_tools::implementations::grok_build::enter_plan_mode::EnterPlanModeTool;
use xai_grok_tools::implementations::grok_build::exit_plan_mode::ExitPlanModeTool;
use xai_grok_tools::registry::types::ToolConfig;
use xai_grok_tools::types::resources::PlanFilePath;

fn enter_plan_mode_call(id: &str) -> crate::sampling::types::ToolCallResponse {
    crate::sampling::types::ToolCallResponse {
        id: id.to_string(),
        kind: "function".to_string(),
        function: crate::sampling::types::ToolCallFunction::new(
            "enter_plan_mode",
            "{}".to_string(),
        ),
    }
}

async fn prepare(
    actor: &SessionActor,
    call: crate::sampling::types::ToolCallResponse,
) -> Result<PreparedToolCall, ToolLoop> {
    let mut deferred = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        actor.prepare_tool_call(call, &mut deferred),
    )
    .await
    .expect("prepare_tool_call must not hang (a hang means a permission prompt was issued)")
    .expect("prepare_tool_call must not error")
}

/// Actor whose plan tracker lives in its own temp session directory, so episode filenames (which
/// are second-resolution timestamps) cannot collide with another test's actor.
async fn build_episode_actor() -> (SessionActor, tempfile::TempDir) {
    let (gateway_tx, mut gateway_rx) =
        tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
    let (persistence_tx, _persistence_rx) =
        tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
    let actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;
    *actor.agent.borrow_mut() = test_agent_with_tools(vec![
        ToolConfig::for_tool::<EnterPlanModeTool>(),
        ToolConfig::for_tool::<ExitPlanModeTool>(),
    ])
    .await;
    tokio::task::spawn_local(async move {
        while let Some(msg) = gateway_rx.recv().await {
            if let xai_acp_lib::AcpClientMessage::SessionNotification(args) = msg {
                let _ = args.response_tx.send(Ok(()));
            }
        }
    });

    let dir = tempfile::tempdir().unwrap();
    *actor.plan_mode.lock() =
        crate::session::plan_mode::PlanModeTracker::new(dir.path().to_path_buf());
    (actor, dir)
}

async fn plan_file_resource(actor: &SessionActor) -> Option<std::path::PathBuf> {
    let resources = actor.agent.borrow().tool_bridge().shared_resources().await;
    let locked = resources.lock().await;
    locked.get::<PlanFilePath>().map(|p| p.0.clone())
}

#[tokio::test(flavor = "current_thread")]
async fn enter_plan_mode_opens_a_new_episode_file_before_seeding() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, dir) = build_episode_actor().await;

            // Episode 1: the user plans, the model writes, the plan is approved.
            activate_plan_mode(&actor);
            let first = actor.plan_mode.lock().plan_file_path().to_path_buf();
            std::fs::write(&first, "# first plan\n").unwrap();
            assert!(actor.plan_mode.lock().deactivate_approved());

            // Episode 2 arrives through the tool rather than the slash command.
            let prepared = prepare(&actor, enter_plan_mode_call("call_enter")).await;
            assert!(
                prepared.is_ok(),
                "enter_plan_mode must prepare; got {:?}",
                prepared.err()
            );

            let second = actor.plan_mode.lock().plan_file_path().to_path_buf();
            assert_ne!(first, second, "a new episode must get its own plan file");
            assert_eq!(
                second.parent(),
                Some(dir.path().join("plans").as_path()),
                "episode files live under <session>/plans/"
            );
            assert!(
                second.parent().unwrap().is_dir(),
                "plans/ must exist so the tool's seed write can create the file"
            );
            assert_eq!(
                std::fs::read_to_string(&first).unwrap(),
                "# first plan\n",
                "the previous episode's plan must be left intact"
            );

            // The tool resource must already agree with the tracker: the tool seeds from it, and a
            // later exit_plan_mode reads it.
            assert_eq!(
                plan_file_resource(&actor).await,
                Some(second),
                "PlanFilePath must be re-pointed before enter_plan_mode runs"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn enter_plan_mode_while_active_keeps_the_current_episode_file() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _dir) = build_episode_actor().await;
            activate_plan_mode(&actor);
            let active = actor.plan_mode.lock().plan_file_path().to_path_buf();
            std::fs::write(&active, "# in progress\n").unwrap();

            // Request-changes keeps the episode Active; a stray enter_plan_mode must not rotate it.
            let prepared = prepare(&actor, enter_plan_mode_call("call_enter_active")).await;
            assert!(prepared.is_ok(), "got {:?}", prepared.err());

            assert_eq!(actor.plan_mode.lock().plan_file_path(), active);
            assert_eq!(std::fs::read_to_string(&active).unwrap(), "# in progress\n");
        })
        .await;
}

/// `/plan` after a finished episode allocates too, so the slash-command path and the tool path
/// agree on what "current plan file" means.
#[tokio::test(flavor = "current_thread")]
async fn slash_plan_after_an_approved_plan_opens_a_new_file() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _dir) = build_episode_actor().await;
            activate_plan_mode(&actor);
            let first = actor.plan_mode.lock().plan_file_path().to_path_buf();
            std::fs::write(&first, "# first plan\n").unwrap();
            actor.plan_mode.lock().deactivate_approved();

            // The user runs `/plan` again: Pending, then the first prompt activates.
            activate_plan_mode(&actor);
            let second = actor.plan_mode.lock().plan_file_path().to_path_buf();

            assert_ne!(first, second);
            assert_eq!(std::fs::read_to_string(&first).unwrap(), "# first plan\n");
        })
        .await;
}

/// `/goal --from-plan` reads the episode the session is on right now, not the first episode's file
/// and not the pre-episode `<session>/plan.md`. Both of those are still on disk and still named in
/// conversation history, so resolving the wrong one silently seeds a goal from a stale plan.
#[tokio::test(flavor = "current_thread")]
async fn from_plan_reads_the_current_episode_file() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, dir) = build_episode_actor().await;

            activate_plan_mode(&actor);
            let first = actor.plan_mode.lock().plan_file_path().to_path_buf();
            std::fs::write(&first, "# first plan\n").unwrap();
            actor.plan_mode.lock().deactivate_approved();

            activate_plan_mode(&actor);
            let second = actor.plan_mode.lock().plan_file_path().to_path_buf();
            std::fs::write(&second, "# second plan\n").unwrap();

            // A decoy at the legacy path: pre-episode sessions still read `<session>/plan.md`, and
            // it must not win once an episode is active.
            std::fs::write(dir.path().join("plan.md"), "# legacy plan\n").unwrap();

            let outcome = actor
                .setup_goal("ship it", None, Some(GoalPlanSource::SessionPlan))
                .await;
            match &outcome {
                GoalSetupOutcome::Inference { .. } => {}
                GoalSetupOutcome::Message(message) => {
                    panic!("the current episode's file exists, so the goal must start: {message}")
                }
            }

            let seeded = {
                let tracker = actor.goal_tracker.lock();
                tracker
                    .snapshot()
                    .and_then(|o| o.plan_file.clone())
                    .expect("seeding a goal from a plan must publish the goal plan")
            };
            assert_eq!(
                std::fs::read_to_string(&seeded).unwrap(),
                "# second plan\n",
                "the goal must be seeded from the current episode, not an earlier one or the legacy file"
            );
        })
        .await;
}
